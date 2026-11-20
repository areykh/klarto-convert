// The ten tools as two stages: parse(input) and convert(parsed, options).
// The worker caches the parsed input, so changing an option such as the
// sheet or the rows array does not parse the file again.
// Results:
//   {kind:'text', parts:[...], mime, ext, info:[], warnings:[], choices}
//   {kind:'xlsx', bytes, preview:[[...]], info, warnings, choices}
//   {kind:'report', valid, stats | error}
import { ConvertError, Warnings, setKey } from './errors.js';
import { decodeBytes } from './decode.js';
import { parseXml } from './xml-parse.js';
import { xmlToJson, jsonToXml, parseForceArrays } from './xml-json.js';
import { parseJson } from './json-parse.js';
import { parseCsv, detectDelimiter, uniqueHeaders, csvField, cellText } from './csv.js';
import { pickRecords, collectHeaders, recordRow, unflatten } from './flatten.js';
import { textCell, jsonCell, parseNumber, serialToIso, isoToSerial, MAX_ROWS } from './cells.js';
import { readWorkbook, sheetList, sheetRows, rowsToRecords, buildXlsx } from './excel.js';

const PREVIEW_ROWS = 20;
const PREVIEW_COLS = 30;
const CHUNK_ROWS = 5000;

const DELIM_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

function textOf(input, kind) {
  if (input.text !== undefined) {
    const t = input.text.charCodeAt(0) === 0xfeff ? input.text.slice(1) : input.text;
    if (t.trim() === '') throw new ConvertError('input.empty');
    return { text: t, encoding: null };
  }
  const d = decodeBytes(input.bytes, kind);
  return d;
}

function delimiterOpt(v) {
  return v === 'tab' ? '\t' : v === 'comma' ? ',' : v === 'semicolon' ? ';' : v === 'pipe' ? '|' : null;
}

function indentOpt(v) {
  return v === '0' || v === 0 ? 0 : v === '4' || v === 4 ? 4 : v === 'tab' ? '\t' : 2;
}

function stringifyParts(value, indent) {
  return [JSON.stringify(value, null, indent === 0 ? undefined : indent)];
}

function recordChoices(choices) {
  return choices.map((c) => ({ key: JSON.stringify(c.path), path: c.path, count: c.count }));
}

function displayCell(cell) {
  if (!cell) return '';
  if (cell.t === 'n' && cell.z) return serialToIso(cell.v);
  return String(cell.v);
}

function previewOf(cellRows) {
  return cellRows.slice(0, PREVIEW_ROWS).map((r) => Array.from({ length: Math.min(r.length, PREVIEW_COLS) }, (_, c) => displayCell(r[c])));
}

// Records (JSON values) -> header row + cell rows for Excel.
function recordsToCellRows(records, toCell, progress, warnings) {
  const { headers, index } = collectHeaders(records, (d, t) => progress('converting', d / t / 2));
  if (records.length + 1 > MAX_ROWS) throw new ConvertError('excel.tooManyRows', { rows: records.length + 1, max: MAX_ROWS });
  const rows = [headers.map((h) => ({ t: 's', v: h }))];
  for (let r = 0; r < records.length; r++) {
    const vals = recordRow(records[r], index, headers.length, warnings);
    const row = new Array(headers.length);
    for (let c = 0; c < vals.length; c++) {
      const cell = toCell(vals[c]);
      if (cell) row[c] = cell;
    }
    rows.push(row);
    if ((r & 4095) === 0) progress('converting', 0.5 + r / records.length / 2);
  }
  return { rows, headers };
}

function recordsInfo(chosen, count) {
  return chosen ? { code: 'info.rowsFrom', params: { path: chosen.path.join('.') || '[ ]', count } } : { code: 'info.wholeDocument', params: {} };
}

function xlsxResult(XLSX, cellRows, opts, warnings, info, choices, sheetName) {
  const bytes = buildXlsx(XLSX, cellRows, { warnings, sheetName, header: opts.header !== false });
  return { kind: 'xlsx', bytes, preview: previewOf(cellRows), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', info, warnings: warnings.list(), choices };
}

function entityWarnings(stats) {
  const w = new Warnings();
  for (const name of stats.unexpanded || []) w.add('xml.unexpandedEntity', { name });
  return w.list();
}

function encodingInfo(info, d) {
  if (d.notice) info.push({ code: d.notice, params: {} });
  else if (d.encoding && d.encoding !== 'UTF-8') info.push({ code: 'info.encoding', params: { encoding: d.encoding } });
}

// --------------------------------------------------------------- the tools

export const TOOLS = {
  'xml-to-json': {
    input: 'text',
    parseKey: (o) => String(o.forceArrays || '') + '|' + o.consistent,
    parse(input, o, ctx) {
      const d = textOf(input, 'xml');
      const consistent = o.consistent !== false && o.consistent !== 'false';
      const r = xmlToJson(d.text, { forceArrays: parseForceArrays(o.forceArrays), consistent, onProgress: (a, b) => ctx.progress('parsing', a / b) });
      return { json: r.json, stats: r.stats, decoded: d };
    },
    convert(p, o) {
      const info = [{ code: 'info.elements', params: { count: p.stats.elements, root: p.stats.root } }];
      encodingInfo(info, p.decoded);
      return { kind: 'text', parts: stringifyParts(p.json, indentOpt(o.indent)), mime: 'application/json', ext: 'json', info, warnings: entityWarnings(p.stats) };
    },
  },

  'json-to-xml': {
    input: 'text',
    parseKey: () => '',
    parse(input) {
      const d = textOf(input, 'json');
      return { value: parseJson(d.text).value };
    },
    convert(p, o) {
      const r = jsonToXml(p.value, { rootName: o.rootName || 'root', itemName: o.itemName || 'item', indent: indentOpt(o.indent), declaration: o.declaration !== false && o.declaration !== 'false' });
      return { kind: 'text', parts: r.parts, mime: 'application/xml', ext: 'xml', info: [], warnings: r.warnings };
    },
  },

  'xml-to-excel': {
    input: 'text',
    needsXlsx: true,
    parseKey: () => '',
    parse(input, o, ctx) {
      const d = textOf(input, 'xml');
      const r = xmlToJson(d.text, { consistent: true, onProgress: (a, b) => ctx.progress('parsing', a / b) });
      return { json: r.json, decoded: d, stats: r.stats };
    },
    convert(p, o, ctx) {
      const warnings = new Warnings();
      for (const name of p.stats.unexpanded) warnings.add('xml.unexpandedEntity', { name });
      const { records, chosen, choices } = pickRecords(p.json, o.rows || 'auto');
      const detect = o.detect !== false && o.detect !== 'false';
      const { rows } = recordsToCellRows(records, (v) => (v === undefined || v === '' ? undefined : textCell(String(v), { detect, decimal: '.' })), ctx.progress, warnings);
      const info = [recordsInfo(chosen, records.length)];
      encodingInfo(info, p.decoded);
      ctx.progress('writing', -1);
      return xlsxResult(ctx.XLSX, rows, o, warnings, info, { records: recordChoices(choices), selected: chosen ? JSON.stringify(chosen.path) : 'whole' }, chosen ? chosen.path[chosen.path.length - 1] : 'Sheet1');
    },
  },

  'excel-to-xml': {
    input: 'bytes',
    needsXlsx: true,
    parseKey: () => '',
    parse(input, o, ctx) {
      return { wb: readWorkbook(ctx.XLSX, input.bytes) };
    },
    convert(p, o, ctx) {
      const sheets = sheetList(ctx.XLSX, p.wb);
      const name = sheets.some((s) => s.name === o.sheet) ? o.sheet : sheets[0].name;
      const rows = sheetRows(ctx.XLSX, p.wb, name);
      const header = o.header !== false && o.header !== 'false';
      let { records } = rowsToRecords(rows, header);
      const nested = o.nested === true || o.nested === 'true';
      if (nested) records = records.map(unflatten);
      const rootName = o.rootName || 'rows';
      const rowName = o.rowName || 'row';
      const doc = {};
      setKey(doc, rootName, records.length ? { [rowName]: records } : '');
      const r = jsonToXml(doc, { indent: indentOpt(o.indent), rootName, itemName: 'item' });
      const info = [{ code: 'info.sheet', params: { name, rows: rows.length } }];
      return { kind: 'text', parts: r.parts, mime: 'application/xml', ext: 'xml', info, warnings: r.warnings, choices: { sheets, selected: name } };
    },
  },

  'json-to-csv': {
    input: 'text',
    parseKey: () => '',
    parse(input) {
      const d = textOf(input, 'json');
      const r = parseJson(d.text, { jsonLines: true });
      return { value: r.value, jsonLines: r.jsonLines };
    },
    convert(p, o, ctx) {
      const warnings = new Warnings();
      const { records, chosen, choices } = pickRecords(p.value, o.rows || 'auto');
      const delim = delimiterOpt(o.delimiter) || ',';
      const decimalComma = o.decimal === ',';
      const { headers, index } = collectHeaders(records, (d, t) => ctx.progress('converting', d / t / 2));
      const parts = [];
      if (o.bom !== false && o.bom !== 'false') parts.push('\uFEFF');
      // A line with nothing on it would be read back as an empty line and
      // skipped, so a single empty field is written as "".
      const headerLine = headers.map((h) => csvField(h, delim)).join(delim);
      let buf = (headerLine === '' ? '""' : headerLine) + '\r\n';
      for (let r = 0; r < records.length; r++) {
        const vals = recordRow(records[r], index, headers.length, warnings);
        let line = '';
        for (let c = 0; c < headers.length; c++) {
          if (c) line += delim;
          line += csvField(cellText(vals[c], decimalComma, warnings), delim);
        }
        buf += (line === '' ? '""' : line) + '\r\n';
        if (r % CHUNK_ROWS === CHUNK_ROWS - 1) { parts.push(buf); buf = ''; ctx.progress('converting', 0.5 + r / records.length / 2); }
      }
      parts.push(buf);
      const info = [recordsInfo(chosen, records.length), { code: 'info.columns', params: { count: headers.length } }];
      if (p.jsonLines) info.unshift({ code: 'info.jsonLines', params: { count: p.value.length } });
      return { kind: 'text', parts, mime: 'text/csv', ext: 'csv', info, warnings: warnings.list(), choices: { records: recordChoices(choices), selected: chosen ? JSON.stringify(chosen.path) : 'whole' } };
    },
  },

  'csv-to-json': {
    input: 'text',
    parseKey: () => '',
    parse(input) {
      return { decoded: textOf(input, 'csv') };
    },
    convert(p, o, ctx) {
      const warnings = new Warnings();
      const text = p.decoded.text;
      const delim = delimiterOpt(o.delimiter) || detectDelimiter(text);
      const header = o.header !== false && o.header !== 'false';
      const types = o.types !== false && o.types !== 'false';
      const nested = o.nested === true || o.nested === 'true';
      const decimal = o.decimal === ',' || o.decimal === '.' ? o.decimal : delim === ';' ? ',' : '.';
      const indent = indentOpt(o.indent);
      const parts = [];
      let buf = '[';
      let headers = null;
      let n = 0;
      let mismatched = 0;
      const conv = (s) => {
        if (!types) return s;
        if (s === 'true') return true;
        if (s === 'false') return false;
        const num = parseNumber(s, decimal);
        return num === null ? s : num;
      };
      const nl = indent === 0 ? '' : '\n';
      const pad = indent === 0 ? '' : typeof indent === 'string' ? indent : ' '.repeat(indent);
      parseCsv(text, {
        delimiter: delim,
        warnings,
        onProgress: (a, b) => ctx.progress('converting', a / b),
        onRow: (fields, line) => {
          if (header && headers === null) { headers = uniqueHeaders(fields); return; }
          let value;
          if (header) {
            if (fields.length !== headers.length) {
              mismatched++;
              if (mismatched === 1) warnings.add('csv.fieldCount', { line, found: fields.length, expected: headers.length });
              while (headers.length < fields.length) headers.push('column_' + (headers.length + 1));
            }
            const obj = {};
            for (let c = 0; c < headers.length; c++) {
              const k = headers[c];
              const v = c < fields.length ? conv(fields[c]) : '';
              if (k === '__proto__') Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
              else obj[k] = v;
            }
            value = nested ? unflatten(obj) : obj;
          } else {
            value = fields.map(conv);
          }
          let js = JSON.stringify(value, null, indent === 0 ? undefined : indent);
          if (pad) js = js.replace(/\n/g, '\n' + pad);
          buf += (n ? ',' : '') + nl + pad + js;
          n++;
          if (n % CHUNK_ROWS === 0) { parts.push(buf); buf = ''; }
        },
      });
      buf += (n ? nl : '') + ']' + nl;
      parts.push(buf);
      if (mismatched > 1) warnings.add('csv.fieldCountRows', { rows: mismatched });
      const info = [{ code: 'info.delimiter', params: { name: DELIM_NAMES[delim] } }, { code: 'info.records', params: { count: n } }];
      if (types) info.push({ code: 'info.decimal', params: { sep: decimal } });
      encodingInfo(info, p.decoded);
      return { kind: 'text', parts, mime: 'application/json', ext: 'json', info, warnings: warnings.list() };
    },
  },

  'json-to-excel': {
    input: 'text',
    needsXlsx: true,
    parseKey: () => '',
    parse(input) {
      const d = textOf(input, 'json');
      const r = parseJson(d.text, { jsonLines: true });
      return { value: r.value, jsonLines: r.jsonLines };
    },
    convert(p, o, ctx) {
      const warnings = new Warnings();
      const { records, chosen, choices } = pickRecords(p.value, o.rows || 'auto');
      const dates = o.dates !== false && o.dates !== 'false';
      const { rows } = recordsToCellRows(records, (v) => {
        if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) warnings.add('json.unsafeInteger', {});
        return jsonCell(v, { dates });
      }, ctx.progress, warnings);
      const info = [recordsInfo(chosen, records.length)];
      if (p.jsonLines) info.unshift({ code: 'info.jsonLines', params: { count: p.value.length } });
      ctx.progress('writing', -1);
      return xlsxResult(ctx.XLSX, rows, o, warnings, info, { records: recordChoices(choices), selected: chosen ? JSON.stringify(chosen.path) : 'whole' }, chosen && chosen.path.length ? chosen.path[chosen.path.length - 1] : 'Sheet1');
    },
  },

  'excel-to-json': {
    input: 'bytes',
    needsXlsx: true,
    parseKey: () => '',
    parse(input, o, ctx) {
      return { wb: readWorkbook(ctx.XLSX, input.bytes) };
    },
    convert(p, o, ctx) {
      const sheets = sheetList(ctx.XLSX, p.wb);
      const name = sheets.some((s) => s.name === o.sheet) ? o.sheet : sheets[0].name;
      const rows = sheetRows(ctx.XLSX, p.wb, name);
      const header = o.header !== false && o.header !== 'false';
      let value;
      if (header) {
        let { records } = rowsToRecords(rows, true);
        if (o.nested === true || o.nested === 'true') records = records.map(unflatten);
        value = records;
      } else {
        value = rows;
      }
      const info = [{ code: 'info.sheet', params: { name, rows: rows.length } }];
      return { kind: 'text', parts: stringifyParts(value, indentOpt(o.indent)), mime: 'application/json', ext: 'json', info, warnings: [], choices: { sheets, selected: name } };
    },
  },

  'csv-to-excel': {
    input: 'text',
    needsXlsx: true,
    parseKey: () => '',
    parse(input) {
      return { decoded: textOf(input, 'csv') };
    },
    convert(p, o, ctx) {
      const warnings = new Warnings();
      const text = p.decoded.text;
      const delim = delimiterOpt(o.delimiter) || detectDelimiter(text);
      const decimal = o.decimal === ',' || o.decimal === '.' ? o.decimal : delim === ';' ? ',' : '.';
      const detect = o.detect !== false && o.detect !== 'false';
      const header = o.header !== false && o.header !== 'false';
      const rows = [];
      parseCsv(text, {
        delimiter: delim,
        warnings,
        onProgress: (a, b) => ctx.progress('converting', a / b),
        onRow: (fields) => {
          if (rows.length >= MAX_ROWS) throw new ConvertError('excel.tooManyRows', { rows: rows.length + 1, max: MAX_ROWS });
          const row = new Array(fields.length);
          const isHeader = header && rows.length === 0;
          for (let c = 0; c < fields.length; c++) {
            const f = fields[c];
            if (f !== '') row[c] = isHeader ? { t: 's', v: f } : textCell(f, { detect, decimal });
          }
          rows.push(row);
        },
      });
      const info = [{ code: 'info.delimiter', params: { name: DELIM_NAMES[delim] } }, { code: 'info.records', params: { count: header ? Math.max(0, rows.length - 1) : rows.length } }];
      if (detect) info.push({ code: 'info.decimal', params: { sep: decimal } });
      encodingInfo(info, p.decoded);
      ctx.progress('writing', -1);
      return xlsxResult(ctx.XLSX, rows, { header }, warnings, info, null, 'Sheet1');
    },
  },

  'xml-validator': {
    input: 'text',
    parseKey: () => '',
    parse(input) {
      return { decoded: textOf(input, 'xml') };
    },
    convert(p, o, ctx) {
      try {
        const stats = parseXml(p.decoded.text, {}, { onProgress: (a, b) => ctx.progress('parsing', a / b) });
        return { kind: 'report', valid: true, stats, info: [], warnings: entityWarnings(stats) };
      } catch (e) {
        // Entities that contain markup are well-formed XML that this parser
        // does not support: that is reported as "not checked", not as an error.
        if (e instanceof ConvertError && e.code.startsWith('xml.')) return { kind: 'report', valid: false, unsupported: e.code === 'xml.entityMarkup', error: { code: e.code, params: e.params }, text: p.decoded.text };
        throw e;
      }
    },
  },
};

// The sample workbook (see samples.js) as .xlsx bytes.
export function buildSampleWorkbook(XLSX, sample) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sample)) {
    const cells = rows.map((r) => r.map((v) => {
      if (v && typeof v === 'object' && v.date) return { t: 'n', v: isoToSerial(v.date).serial, z: 'yyyy-mm-dd' };
      if (typeof v === 'number') return { t: 'n', v };
      if (typeof v === 'boolean') return { t: 'b', v };
      return { t: 's', v: String(v) };
    }));
    const ws = { '!data': cells, '!ref': XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: cells.length - 1, c: Math.max(...cells.map((r) => r.length)) - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }));
}
