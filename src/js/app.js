// Page logic: read the file or pasted text, send it to the worker, show
// progress, the result and errors in the page's language. No network use.
import { sampleText } from './samples.js';

const data = JSON.parse(document.getElementById('page-data').textContent);
const M = data.messages;
const $ = (id) => document.getElementById(id);
const PREVIEW_CHARS = 100000;
const LARGE_BYTES = 20 * 1024 * 1024;

const els = {
  file: $('file'),
  drop: $('drop'),
  paste: $('paste'),
  convert: $('convert'),
  sample: $('sample'),
  clear: $('clear'),
  status: $('status'),
  statusText: $('status-text'),
  progress: $('progress'),
  cancel: $('cancel'),
  output: $('output'),
  outText: $('out-text'),
  outTable: $('out-table'),
  outReport: $('out-report'),
  download: $('download'),
  copy: $('copy'),
  notes: $('notes'),
  fileName: $('file-name'),
  sheetWrap: $('wrap-sheet'),
  sheet: $('opt-sheet'),
  rowsWrap: $('wrap-rows'),
  rows: $('opt-rows'),
};

const nf = new Intl.NumberFormat(data.locale);

function fmt(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => {
    const v = params[k];
    if (v === undefined || v === null) return '';
    return typeof v === 'number' ? nf.format(v) : String(v);
  });
}

function message(group, code, params) {
  if (code === 'info.delimiter' && params && M.ui.delim[params.name]) params = { ...params, name: M.ui.delim[params.name] };
  const t = M[group] && M[group][code];
  if (t) return fmt(t, params);
  if (group === 'errors') return fmt(M.errors['general.unexpected'], { detail: code });
  return code;
}

function sizeText(bytes) {
  if (bytes < 1024) return fmt(M.ui.bytes, { n: bytes });
  if (bytes < 1024 * 1024) return fmt(M.ui.kb, { n: Math.round(bytes / 102.4) / 10 });
  return fmt(M.ui.mb, { n: Math.round(bytes / 104857.6) / 10 });
}

// ------------------------------------------------------------- worker

let worker = null;
let runId = 0;
let inputId = 0;
let current = null; // {id, name, bytes?, text?, size}
let running = null; // {id, started, timer}
let downloadUrl = null;

function startWorker() {
  // The worker starts from a blob: URL so that it inherits this page's
  // Content Security Policy (connect-src 'none'): like the page, it cannot
  // send data anywhere. A worker loaded from its own URL would get no policy,
  // because the site's server sends no CSP header.
  const real = new URL('./worker.js', import.meta.url).href;
  const blobUrl = URL.createObjectURL(new Blob(['import ' + JSON.stringify(real) + ';\n'], { type: 'text/javascript' }));
  worker = new Worker(blobUrl, { type: 'module' });
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  worker.onmessage = onWorkerMessage;
  worker.onerror = (ev) => {
    ev.preventDefault();
    fail({ code: 'general.crashed', params: {} });
    restartWorker();
  };
  worker.onmessageerror = () => fail({ code: 'general.crashed', params: {} });
  worker.postMessage({ type: 'preload', xlsx: data.needsXlsx });
}

function restartWorker() {
  if (worker) worker.terminate();
  worker = null;
  startWorker();
}

function options() {
  const o = {};
  for (const el of document.querySelectorAll('[data-opt]')) {
    if (el.closest('[hidden]') && el !== els.sheet && el !== els.rows) continue;
    o[el.dataset.opt] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return o;
}

function run() {
  if (!current) return;
  const id = ++runId;
  const msg = { type: 'run', id, tool: data.tool, inputId: current.id, options: options(), previewChars: PREVIEW_CHARS };
  const transfer = [];
  if (current.sample) msg.input = { sample: current.sample };
  else if (current.text !== undefined) msg.input = { text: current.text };
  else {
    // keep our copy so options can be changed later without reading again
    const copy = current.bytes.slice(0);
    msg.input = { bytes: copy };
    transfer.push(copy);
  }
  setRunning(id);
  worker.postMessage(msg, transfer);
}

function setRunning(id) {
  if (running) clearInterval(running.timer);
  const started = performance.now();
  running = { id, started, phase: 'reading', fraction: -1 };
  els.status.hidden = false;
  els.status.classList.remove('is-error');
  els.cancel.hidden = false;
  els.progress.hidden = false;
  els.progress.removeAttribute('value');
  const big = current && current.size > LARGE_BYTES;
  const tick = () => {
    const s = (performance.now() - started) / 1000;
    let t = M.ui.phase[running.phase] || M.ui.working;
    if (running.fraction >= 0 && running.fraction <= 1) t += ' ' + Math.round(running.fraction * 100) + ' %';
    t += ' · ' + fmt(M.ui.elapsed, { seconds: Math.round(s) });
    if (big) t += ' · ' + (data.outKind === 'xlsx' ? M.ui.largeExcel : M.ui.largeFile);
    els.statusText.textContent = t;
  };
  running.timer = setInterval(tick, 250);
  running.tick = tick;
  tick();
}

function stopRunning() {
  if (!running) return 0;
  clearInterval(running.timer);
  const s = (performance.now() - running.started) / 1000;
  running = null;
  els.cancel.hidden = true;
  els.progress.hidden = true;
  return s;
}

function onWorkerMessage(ev) {
  const m = ev.data;
  if (m.type === 'ready') return;
  if (!running || m.id !== running.id) return;
  if (m.type === 'progress') {
    running.phase = m.phase;
    running.fraction = m.fraction;
    if (m.fraction >= 0 && m.fraction <= 1) els.progress.value = m.fraction;
    else els.progress.removeAttribute('value');
    running.tick();
  } else if (m.type === 'result') {
    const s = stopRunning();
    showResult(m.result, s);
  } else if (m.type === 'error') {
    stopRunning();
    fail(m.error);
  }
}

// ------------------------------------------------------------- output

function clearOutput() {
  els.output.hidden = true;
  els.outText.hidden = true;
  els.outTable.hidden = true;
  els.outReport.hidden = true;
  els.outReport.replaceChildren();
  els.outTable.replaceChildren();
  els.outText.value = '';
  els.notes.replaceChildren();
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  els.download.hidden = true;
  els.copy.hidden = true;
}

function note(text, cls) {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  els.notes.append(li);
}

function outName(ext) {
  const base = current && current.name ? current.name.replace(/\.[^.]+$/, '') : 'converted';
  return (base || 'converted') + '.' + ext;
}

function excerptNode(ex) {
  const pre = document.createElement('pre');
  pre.className = 'excerpt';
  const code = document.createElement('code');
  const caret = ' '.repeat(Math.max(0, ex.caret)) + '^';
  code.textContent = (ex.cutStart ? '…' : '') + ex.text + (ex.cutEnd ? '…' : '') + '\n' + (ex.cutStart ? ' ' : '') + caret;
  pre.append(code);
  return pre;
}

function fail(error) {
  stopRunning();
  clearOutput();
  els.status.hidden = false;
  els.status.classList.add('is-error');
  els.statusText.textContent = M.ui.failed;
  els.output.hidden = false;
  const box = els.outReport;
  box.hidden = false;
  box.className = 'report is-error';
  const p = document.createElement('p');
  const loc = error.params && error.params.line ? fmt(error.params.col ? M.ui.lineCol : M.ui.lineOnly, error.params) + ': ' : '';
  p.textContent = loc + message('errors', error.code, error.params);
  box.append(p);
  if (error.params && error.params.excerpt) box.append(excerptNode(error.params.excerpt));
}

function showChoices(choices) {
  if (els.sheet) {
    if (choices && choices.sheets && choices.sheets.length > 1) {
      fillSelect(els.sheet, choices.sheets.map((s) => ({ value: s.name, label: fmt(s.hidden ? M.ui.sheetHidden : M.ui.sheetOption, { name: s.name, rows: s.rows }) })), choices.selected);
      els.sheetWrap.hidden = false;
    } else {
      els.sheetWrap.hidden = true;
    }
  }
  if (els.rows) {
    if (choices && choices.records && choices.records.length) {
      const opts = choices.records.map((c) => ({ value: c.key, label: fmt(M.ui.rowsOption, { path: c.path.length ? c.path.join('.') : M.ui.topLevel, count: c.count }) }));
      opts.push({ value: 'whole', label: M.ui.wholeDocument });
      fillSelect(els.rows, opts, choices.selected);
      els.rowsWrap.hidden = false;
    } else {
      els.rowsWrap.hidden = true;
    }
  }
}

function fillSelect(sel, items, selected) {
  const same = sel.options.length === items.length && items.every((it, i) => sel.options[i].value === it.value);
  if (!same) {
    sel.replaceChildren(...items.map((it) => {
      const o = document.createElement('option');
      o.value = it.value;
      o.textContent = it.label;
      return o;
    }));
  }
  if (selected !== undefined) sel.value = selected;
}

function showResult(r, seconds) {
  clearOutput();
  els.status.hidden = false;
  els.status.classList.remove('is-error');
  els.output.hidden = false;
  if (r.kind === 'report') {
    els.statusText.textContent = fmt(M.ui.done, { seconds: Math.max(0.1, Math.round(seconds * 10) / 10) });
    const box = els.outReport;
    box.hidden = false;
    if (r.valid) {
      box.className = 'report is-ok';
      const h = document.createElement('p');
      h.className = 'verdict';
      h.textContent = M.ui.valid;
      const p = document.createElement('p');
      p.textContent = fmt(M.ui.validStats, { root: r.stats.root, elements: r.stats.elements, depth: r.stats.maxDepth });
      box.append(h, p);
      if (r.stats.doctype) {
        const d = document.createElement('p');
        d.textContent = M.ui.validNoDtd;
        box.append(d);
      }
      for (const w of r.warnings || []) {
        let t = message('warnings', w.code, w.params);
        if (w.count > 1) t += ' ' + fmt(M.ui.timesMore, { n: w.count - 1 });
        note(t, 'warn');
      }
    } else {
      box.className = 'report is-error';
      const h = document.createElement('p');
      h.className = 'verdict';
      h.textContent = r.unsupported ? M.ui.unsupported : M.ui.invalid;
      const p = document.createElement('p');
      p.textContent = fmt(M.ui.lineCol, r.error.params) + ': ' + message('errors', r.error.code, r.error.params);
      box.append(h, p);
      if (r.error.params.excerpt) box.append(excerptNode(r.error.params.excerpt));
    }
    return;
  }
  els.statusText.textContent = fmt(M.ui.doneSize, { seconds: Math.max(0.1, Math.round(seconds * 10) / 10), size: sizeText(r.size) });
  downloadUrl = URL.createObjectURL(r.blob);
  els.download.href = downloadUrl;
  els.download.download = outName(r.ext);
  els.download.dataset.size = String(r.size);
  els.download.textContent = fmt(M.ui.download, { name: outName(r.ext), size: sizeText(r.size) });
  els.download.hidden = false;
  if (r.kind === 'text') {
    els.outText.hidden = false;
    els.outText.value = r.preview;
    if (r.previewCut) note(fmt(M.ui.previewCut, { n: PREVIEW_CHARS }));
    if (r.size <= 10 * 1024 * 1024 && navigator.clipboard) {
      els.copy.hidden = false;
      els.copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(await r.blob.text());
          els.copy.textContent = M.ui.copied;
          setTimeout(() => { els.copy.textContent = M.ui.copy; }, 1500);
        } catch {
          els.copy.textContent = M.ui.copyFailed;
        }
      };
    }
  } else {
    els.outTable.hidden = false;
    const table = document.createElement('table');
    const cap = document.createElement('caption');
    cap.textContent = fmt(M.ui.previewRows, { rows: Math.max(0, r.preview.length - 1) });
    table.append(cap);
    r.preview.forEach((row, i) => {
      const tr = document.createElement('tr');
      for (const v of row) {
        const cell = document.createElement(i === 0 ? 'th' : 'td');
        cell.textContent = v.length > 80 ? v.slice(0, 80) + '…' : v;
        tr.append(cell);
      }
      table.append(tr);
    });
    els.outTable.append(table);
  }
  for (const i of r.info || []) note(message('info', i.code, i.params) || '', 'info');
  for (const w of r.warnings || []) {
    let t = message('warnings', w.code, w.params);
    if (w.count > 1) t += ' ' + fmt(M.ui.timesMore, { n: w.count - 1 });
    note(t, 'warn');
  }
  showChoices(r.choices);
}

// ------------------------------------------------------------- input

let reader = null;
let selection = 0; // the latest file choice wins, even if an older file finishes reading later

function setFile(file) {
  if (!file) return;
  if (running) cancel();
  if (reader) reader.abort();
  const mine = ++selection;
  clearOutput();
  els.fileName.textContent = fmt(M.ui.fileChosen, { name: file.name, size: sizeText(file.size) });
  els.status.hidden = false;
  els.status.classList.remove('is-error');
  els.statusText.textContent = M.ui.phase.reading;
  const r = new FileReader();
  reader = r;
  r.onerror = () => { if (mine === selection) fail({ code: 'input.readFailed', params: { name: file.name } }); };
  r.onload = () => {
    if (mine !== selection) return;
    reader = null;
    current = { id: ++inputId, name: file.name, bytes: r.result, size: file.size };
    resetChoices();
    if (els.paste) els.paste.value = '';
    run();
  };
  r.readAsArrayBuffer(file);
}

function resetChoices() {
  if (els.sheet) { els.sheet.replaceChildren(); els.sheetWrap.hidden = true; }
  if (els.rows) {
    const o = document.createElement('option');
    o.value = 'auto';
    o.textContent = M.ui.auto;
    els.rows.replaceChildren(o);
    els.rowsWrap.hidden = true;
  }
}

function usePasted() {
  if (reader) { reader.abort(); reader = null; }
  selection++;
  const t = els.paste.value;
  if (t.trim() === '') { fail({ code: 'input.empty', params: {} }); return; }
  current = { id: ++inputId, name: 'converted', text: t, size: t.length };
  els.fileName.textContent = '';
  resetChoices();
  run();
}

function cancel() {
  if (!running) return;
  stopRunning();
  restartWorker();
  clearOutput(); // the shown result no longer matches the options
  els.statusText.textContent = M.ui.cancelled;
}

els.file.addEventListener('change', () => setFile(els.file.files[0]));
els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('is-over'); });
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('is-over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('is-over');
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});
if (els.convert) els.convert.addEventListener('click', usePasted);
if (els.paste) els.paste.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) usePasted(); });
els.cancel.addEventListener('click', cancel);
els.clear.addEventListener('click', () => {
  if (running) cancel();
  if (reader) { reader.abort(); reader = null; }
  selection++;
  current = null;
  els.file.value = '';
  if (els.paste) els.paste.value = '';
  els.fileName.textContent = '';
  els.status.hidden = true;
  resetChoices();
  clearOutput();
  worker.postMessage({ type: 'forget' });
});
els.sample.addEventListener('click', () => {
  if (reader) { reader.abort(); reader = null; }
  selection++;
  if (data.sample === 'sheet') {
    current = { id: ++inputId, name: 'sample', sample: 'sheet', size: 0 };
    els.fileName.textContent = fmt(M.ui.fileChosen, { name: 'sample.xlsx', size: '' }).replace(/\s*\(\s*\)\s*$/, '');
    resetChoices();
    run();
  } else {
    els.paste.value = sampleText(data.sample, data.lang);
    usePasted();
    if (current) current.name = 'sample';
  }
});
for (const el of document.querySelectorAll('[data-opt]')) {
  el.addEventListener('change', () => { if (current) run(); });
}

startWorker();
