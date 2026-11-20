// Runs the conversions off the main thread, so the page never freezes.
// Nothing here makes network requests: SheetJS is loaded from this site.
import { TOOLS, buildSampleWorkbook } from './convert/tools.js';
import { ConvertError, lineExcerpt } from './convert/errors.js';
import { sniffWorkbook } from './convert/excel.js';
import { decodeBytes } from './convert/decode.js';
import { SHEET_SAMPLE } from './samples.js';

// Published with a .js extension by build.py (see VENDOR_RENAME there).
const VENDOR = '../vendor/sheetjs-0.20.3/';
let XLSX = null;
let codepages = false;
let cache = null; // { inputId, tool, key, parsed }

async function loadXlsx() {
  if (!XLSX) XLSX = await import(VENDOR + 'xlsx.js');
  return XLSX;
}

async function loadCodepages() {
  if (codepages) return;
  const cp = await import(VENDOR + 'cpexcel.full.js');
  XLSX.set_cptable(cp);
  codepages = true;
}

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function progressFor(id) {
  let last = 0;
  let lastPhase = '';
  return (phase, fraction) => {
    const now = Date.now();
    if (phase === lastPhase && now - last < 120 && fraction >= 0 && fraction < 1) return;
    last = now;
    lastPhase = phase;
    post({ type: 'progress', id, phase, fraction });
  };
}

function errorPayload(e, text) {
  if (e instanceof ConvertError) {
    const params = { ...e.params };
    if (text && params.line && params.col) {
      const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      params.excerpt = lineExcerpt(t.indexOf('\r') === -1 ? t : t.replace(/\r\n?/g, '\n'), params.line, params.col);
    }
    return { code: e.code, params };
  }
  if (e instanceof RangeError) {
    return { code: /string length|Array buffer allocation|allocation failed|Invalid array length/i.test(e.message) ? 'general.tooLarge' : 'general.tooDeep', params: {} };
  }
  return { code: 'general.unexpected', params: { detail: String((e && e.message) || e).slice(0, 300) } };
}

async function run(m) {
  const tool = TOOLS[m.tool];
  const progress = progressFor(m.id);
  const ctx = { XLSX: null, progress };
  let textForErrors = null;
  try {
    if (tool.needsXlsx) ctx.XLSX = await loadXlsx();
    let input = m.input;
    if (input.sample === 'sheet') {
      input = { bytes: buildSampleWorkbook(ctx.XLSX, SHEET_SAMPLE) };
    } else if (input.bytes && tool.input === 'bytes' && sniffWorkbook(new Uint8Array(input.bytes, 0, Math.min(8, input.bytes.byteLength))) === 'ole') {
      await loadCodepages();
    }
    const key = tool.parseKey(m.options);
    let parsed;
    if (cache && cache.inputId === m.inputId && cache.tool === m.tool && cache.key === key) {
      parsed = cache.parsed;
    } else {
      cache = null;
      progress('parsing', 0);
      parsed = tool.parse(input, m.options, ctx);
      cache = { inputId: m.inputId, tool: m.tool, key, parsed };
    }
    textForErrors = parsed.decoded ? parsed.decoded.text : input.text || null;
    progress('converting', 0);
    const r = tool.convert(parsed, m.options, ctx);
    if (r.kind === 'text') {
      const blob = new Blob(r.parts, { type: r.mime + ';charset=utf-8' });
      let preview = '';
      let total = 0;
      for (const p of r.parts) {
        total += p.length;
        if (preview.length <= m.previewChars) preview += p;
      }
      const cut = total > m.previewChars;
      post({ type: 'result', id: m.id, result: { kind: 'text', blob, size: blob.size, preview: preview.slice(0, m.previewChars), previewCut: cut, ext: r.ext, mime: r.mime, info: r.info, warnings: r.warnings, choices: r.choices || null } });
    } else if (r.kind === 'xlsx') {
      const blob = new Blob([r.bytes], { type: r.mime });
      post({ type: 'result', id: m.id, result: { kind: 'xlsx', blob, size: blob.size, preview: r.preview, ext: r.ext, mime: r.mime, info: r.info, warnings: r.warnings, choices: r.choices || null } });
    } else {
      const res = { kind: 'report', valid: r.valid, unsupported: !!r.unsupported, stats: r.stats || null, error: r.error || null, warnings: r.warnings || [] };
      if (!r.valid && r.error) res.error = errorPayload(new ConvertError(r.error.code, r.error.params), r.text);
      post({ type: 'result', id: m.id, result: res });
    }
  } catch (e) {
    let t = textForErrors || (m.input && m.input.text) || null;
    if (!t && e instanceof ConvertError && e.params && e.params.line && m.input && m.input.bytes && tool.input === 'text') {
      try { t = decodeBytes(m.input.bytes, m.tool.split('-')[0]).text; } catch { t = null; }
    }
    post({ type: 'error', id: m.id, error: errorPayload(e, t) });
  }
}

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'preload') {
    if (m.xlsx) loadXlsx().then(() => post({ type: 'ready' }), () => post({ type: 'ready', failed: true }));
    else post({ type: 'ready' });
  } else if (m.type === 'run') {
    run(m);
  } else if (m.type === 'forget') {
    cache = null;
  }
};
