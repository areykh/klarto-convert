// CSV reading and writing (RFC 4180, with the leniency Excel shows):
// - delimiter auto-detection among comma, semicolon, tab and pipe;
// - quoted fields may contain delimiters, quotes ("") and line breaks;
// - CRLF, LF and CR line endings; completely empty lines are skipped (a line
//   with "" is a row with one empty field);
// - a quote inside an unquoted field is kept as a character.
import { ConvertError, Warnings } from './errors.js';

export const DELIMITERS = [',', ';', '\t', '|'];

// Calls onRow(fields, lineNumber) for each record. Returns the row count.
export function parseCsv(text, opts = {}) {
  let s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delim = opts.delimiter || detectDelimiter(s);
  const d = delim.charCodeAt(0);
  const onRow = opts.onRow;
  const onProgress = opts.onProgress;
  const warnings = opts.warnings;
  const limit = opts.maxRows || Infinity;
  const n = s.length;
  let i = 0;
  let line = 1;
  let rows = 0;
  let lastProgress = 0;
  while (i < n && rows < limit) {
    const c0 = s.charCodeAt(i);
    if (c0 === 10 || c0 === 13) { // empty line
      i += c0 === 13 && s.charCodeAt(i + 1) === 10 ? 2 : 1;
      line++;
      continue;
    }
    const rowLine = line;
    const fields = [];
    for (;;) {
      if (s.charCodeAt(i) === 34) {
        // quoted field
        const qLine = line;
        let val = '';
        let j = i + 1;
        for (;;) {
          const q = s.indexOf('"', j);
          if (q === -1) throw new ConvertError('csv.unclosedQuote', { line: qLine });
          const chunk = s.slice(j, q);
          val += chunk;
          for (let k = chunk.indexOf('\n'); k !== -1; k = chunk.indexOf('\n', k + 1)) line++;
          if (s.charCodeAt(q + 1) === 34) { val += '"'; j = q + 2; continue; }
          i = q + 1;
          break;
        }
        if (val.indexOf('\r') !== -1) {
          let crs = 0;
          for (let k = 0; k < val.length; k++) if (val.charCodeAt(k) === 13 && val.charCodeAt(k + 1) !== 10) crs++;
          line += crs;
        }
        // characters between the closing quote and the next delimiter
        const c = s.charCodeAt(i);
        if (i < n && c !== d && c !== 10 && c !== 13) {
          let e = i;
          while (e < n) { const x = s.charCodeAt(e); if (x === d || x === 10 || x === 13) break; e++; }
          val += s.slice(i, e);
          if (warnings) warnings.add('csv.textAfterQuote', { line: qLine });
          i = e;
        }
        fields.push(val);
      } else {
        let e = i;
        while (e < n) { const x = s.charCodeAt(e); if (x === d || x === 10 || x === 13) break; e++; }
        fields.push(s.slice(i, e));
        i = e;
      }
      const c = s.charCodeAt(i);
      if (c === d) { i++; if (i >= n) { fields.push(''); break; } continue; }
      if (c === 13) { i += s.charCodeAt(i + 1) === 10 ? 2 : 1; line++; break; }
      if (c === 10) { i++; line++; break; }
      break; // end of input
    }
    rows++;
    if (onRow) onRow(fields, rowLine);
    if (onProgress && i - lastProgress > 1048576) { lastProgress = i; onProgress(i, n); }
  }
  if (onProgress) onProgress(n, n);
  return { rows, delimiter: delim };
}

export function parseCsvRows(text, opts = {}) {
  const rows = [];
  const r = parseCsv(text, { ...opts, onRow: (f) => rows.push(f) });
  return { rows, delimiter: r.delimiter };
}

// Pick the delimiter that gives the same field count (> 1) on most of the
// first rows. Ties go to more fields; no winner means comma (one column).
export function detectDelimiter(text) {
  const sample = text.slice(0, 65536);
  let best = ',';
  let bestScore = -1;
  let bestFields = 0;
  for (const cand of DELIMITERS) {
    let counts = [];
    try {
      parseCsv(sample + '\n', { delimiter: cand, maxRows: 30, onRow: (f) => counts.push(f.length) });
    } catch {
      // an unclosed quote inside the sample: count what was read before it
    }
    if (counts.length > 1 && sample.length === 65536) counts = counts.slice(0, -1); // last row may be cut
    if (!counts.length) continue;
    const freq = new Map();
    for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
    let mode = 0;
    let modeN = 0;
    for (const [c, k] of freq) if (k > modeN || (k === modeN && c > mode)) { mode = c; modeN = k; }
    if (mode < 2) continue;
    const score = modeN / counts.length;
    if (score > bestScore || (score === bestScore && mode > bestFields)) {
      best = cand;
      bestScore = score;
      bestFields = mode;
    }
  }
  return best;
}

// Unique, non-empty header names: "" -> column_3, duplicates -> name_2.
export function uniqueHeaders(fields) {
  const seen = new Set();
  return fields.map((f, idx) => {
    let base = String(f ?? '').trim() === '' ? 'column_' + (idx + 1) : String(f);
    let name = base;
    let k = 2;
    while (seen.has(name)) name = base + '_' + k++;
    seen.add(name);
    return name;
  });
}

export function csvField(v, delim) {
  const s = v === null || v === undefined ? '' : String(v);
  if (s.indexOf(delim) !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// A JSON value as CSV cell text.
export function cellText(v, decimalComma, warnings) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (Number.isInteger(v) && !Number.isSafeInteger(v) && warnings) warnings.add('json.unsafeInteger', {});
    const t = String(v);
    return decimalComma ? t.replace('.', ',') : t;
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export { Warnings };
