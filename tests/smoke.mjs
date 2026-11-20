// Browser smoke test: serves docs/ under /klarto-convert/, drives headless
// Google Chrome over the DevTools protocol (no npm packages needed) and, on
// every page of every language:
//   - loads the page with no console errors, CSP violations or exceptions,
//     and no request to another host;
//   - tool pages: runs the sample, checks the output (and downloads files),
//     on English pages also converts a fixture file through the file input,
//     and checks a localized error message with line and column;
//   - checks a 375 px wide viewport for horizontal scrolling.
// Usage: node tests/smoke.mjs [--large] [--screenshots DIR] [--only TOOL]
// Exit code 0 = all passed, 1 = failures, 2 = Chrome not found (skipped).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as XLSX from '../src/vendor/sheetjs-0.20.3/xlsx.mjs';
import { buildSampleWorkbook } from '../src/js/convert/tools.js';
import { SHEET_SAMPLE } from '../src/js/samples.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const args = process.argv.slice(2);
const LARGE = args.includes('--large');
const SHOTS = args.includes('--screenshots') ? args[args.indexOf('--screenshots') + 1] : null;
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const site = JSON.parse(readFileSync(join(ROOT, 'src/site.json'), 'utf8'));
const texts = Object.fromEntries(site.languages.map((l) => [l, JSON.parse(readFileSync(join(ROOT, 'src/i18n', l + '.json'), 'utf8'))]));
const BASE = '/klarto-convert/';

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
if (!CHROME) {
  console.log('SKIP smoke test: no Chrome or Chromium found');
  process.exit(2);
}

// ---------------------------------------------------------------- server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '': 'text/plain' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(BASE)) { res.writeHead(404); res.end(); return; }
  p = join(DOCS, p.slice(BASE.length));
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) { res.writeHead(404, { 'content-type': 'text/html' }); res.end(readFileSync(join(DOCS, '404.html'))); return; }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- chrome
const work = mkdtempSync(join(tmpdir(), 'klarto-smoke-'));
const downloads = join(work, 'downloads');
mkdirSync(downloads);
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
chrome.stderr.on('data', () => {});
const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];
let nextId = 1;
const pending = new Map();
const listeners = new Set();
let buf = '';
fromChrome.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\0')) !== -1) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else {
      for (const l of listeners) l(msg);
    }
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  toChrome.write(JSON.stringify(msg) + '\0');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function waitEvent(pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { listeners.delete(l); reject(new Error('timeout waiting for event')); }, ms);
    const l = (m) => { if (pred(m)) { clearTimeout(t); listeners.delete(l); resolve(m); } };
    listeners.add(l);
  });
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
const cdp = (m, p) => send(m, p, S);
await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Log.enable');
await cdp('Network.enable');
await cdp('DOM.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });

let pageErrors = [];
let requests = [];
// Dedicated workers are separate targets: attach to them, so their requests
// and errors are seen too.
const sessions = new Set([S]);
let workerSession = null;
listeners.add((m) => {
  if (m.method === 'Target.attachedToTarget' && sessions.has(m.sessionId)) {
    const child = m.params.sessionId;
    sessions.add(child);
    if (m.params.targetInfo.type === 'worker') workerSession = child;
    for (const method of ['Network.enable', 'Runtime.enable']) send(method, {}, child).catch(() => {});
    send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {});
  }
  if (m.method === 'Target.detachedFromTarget' && m.params.sessionId) sessions.delete(m.params.sessionId);
});
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
listeners.add((m) => {
  if (!sessions.has(m.sessionId)) return;
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) pageErrors.push('console.' + m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && (m.params.entry.level === 'error' || m.params.entry.level === 'warning')) pageErrors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
});

async function evaluate(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('evaluate failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function navigate(url) {
  const loaded = waitEvent((m) => m.sessionId === S && m.method === 'Page.loadEventFired', 20000);
  await cdp('Page.navigate', { url });
  await loaded;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await evaluate(expr);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + expr);
    await sleep(50);
  }
}
const RESULT_READY = `(() => { const o = document.getElementById('output'); const s = document.getElementById('status'); const c = document.getElementById('cancel'); return o && !o.hidden && s && c.hidden; })()`;
async function setFile(path) {
  const { root } = await cdp('DOM.getDocument', { depth: 1 });
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
  await cdp('DOM.setFileInputFiles', { nodeId, files: [path] });
}
async function download() {
  for (const f of readdirSync(downloads)) rmSync(join(downloads, f));
  const done = waitEvent((m) => m.method === 'Browser.downloadProgress' && (m.params.state === 'completed' || m.params.state === 'canceled'), 60000);
  const name = await evaluate(`(() => { const a = document.getElementById('download'); a.click(); return a.download; })()`);
  const ev = await done;
  if (ev.params.state !== 'completed') throw new Error('download ' + ev.params.state);
  for (let i = 0; i < 50 && !existsSync(join(downloads, name)); i++) await sleep(50);
  return readFileSync(join(downloads, name));
}

// ---------------------------------------------------------------- fixtures
const fixtures = {
  xml: join(work, 'orders.xml'),
  json: join(work, 'orders.json'),
  csv: join(work, 'orders.csv'),
  excel: join(work, 'orders.xlsx'),
  xls: join(work, 'legacy.xls'),
};
writeFileSync(fixtures.xml, '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<list><entry n="1">Ä &amp; Ö</entry><entry n="2">中文</entry></list>\n');
writeFileSync(fixtures.json, JSON.stringify([{ id: 1, name: 'Ä & Ö', tags: ['x', 'y'] }, { id: 2, name: '中文', tags: ['z'] }]));
writeFileSync(fixtures.csv, '\uFEFFid;name;amount\r\n1;"Ä; Ö";1,5\r\n2;中文;2\r\n');
writeFileSync(fixtures.excel, buildSampleWorkbook(XLSX, SHEET_SAMPLE));
{
  // An Excel 97-2003 file: makes the worker load the code page tables too.
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name', 'n'], ['Ünïcødé – 漢字', 7]]), 'Legacy');
  writeFileSync(fixtures.xls, Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xls' })));
}

const readXlsx = (bytes) => {
  const wb = XLSX.read(bytes, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
};
const outText = () => evaluate(`document.getElementById('out-text').value`);
const tableText = () => evaluate(`document.getElementById('out-table').innerText`);
const reportText = () => evaluate(`document.getElementById('out-report').innerText`);

// What each tool's sample must produce, and what the fixture file must give.
const CHECKS = {
  'xml-to-json': {
    sample: async () => { const t = await outText(); assert(t.includes('"@id": "1001"') && t.includes('"city": "Київ"'), 'sample JSON'); },
    file: async () => { const t = await outText(); assert(t.includes('"#text": "Ä & Ö"') && t.includes('"@n": "2"'), 'file JSON'); const d = JSON.parse((await download()).toString('utf8')); assert(d.list.entry.length === 2, 'download JSON'); },
  },
  'json-to-xml': {
    sample: async () => { const t = await outText(); assert(t.includes('<orders>') && t.includes('<city>Київ</city>'), 'sample XML'); },
    file: async () => { const t = await outText(); assert(t.includes('<name>Ä &amp; Ö</name>') && t.includes('<tags>z</tags>'), 'file XML'); const b = (await download()).toString('utf8'); assert(b.startsWith('<?xml'), 'download XML'); },
  },
  'xml-to-excel': {
    sample: async () => { const t = await tableText(); assert(t.includes('customer.name') && t.includes('2026-11-02'), 'sample table'); const rows = readXlsx(await download()); assert(rows[1][0] === 1001, 'xlsx cell A2 = 1001'); },
    file: async () => { const rows = readXlsx(await download()); assert(rows[0].join('|') === '@n|#text' && rows[2][1] === '中文', 'file xlsx'); },
  },
  'excel-to-xml': {
    sample: async () => {
      const t = await outText();
      assert(t.includes('<name>Anna Schmidt</name>') && t.includes('<zip>01001</zip>'), 'sample XML');
      const n = await evaluate(`document.getElementById('wrap-sheet').hidden ? 0 : document.getElementById('opt-sheet').options.length`);
      assert(n === 2, 'sheet list has 2 sheets, got ' + n);
      await evaluate(`(() => { const s = document.getElementById('opt-sheet'); s.value = 'Notes'; s.dispatchEvent(new Event('change')); })()`);
      await sleep(100);
      await waitFor(RESULT_READY);
      assert((await outText()).includes('A second sheet'), 'switching the sheet');
    },
    file: async () => { const t = await outText(); assert(t.includes('<name>Ünïcødé – 漢字</name>') && t.includes('<n>7</n>'), 'file XML from .xls'); assert(requests.some((u) => u.endsWith('/cpexcel.full.js')), 'code page tables loaded for .xls'); },
    fixture: 'xls',
  },
  'json-to-csv': {
    sample: async (lang) => { const t = await outText(); const d = lang === 'en' ? ',' : ';'; assert(t.includes(`customer.name${d}customer.city`), 'sample CSV delimiter ' + d); },
    file: async () => { const b = await download(); assert(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf, 'BOM'); assert(b.toString('utf8').includes('id,name,tags.0,tags.1'), 'file CSV'); },
  },
  'csv-to-json': {
    sample: async () => { const t = await outText(); assert(t.includes('"amount": 24.9') && t.includes('"Two lines:\\nsecond line"'), 'sample JSON'); },
    file: async () => { const d = JSON.parse((await download()).toString('utf8')); assert(d[0].name === 'Ä; Ö' && d[0].amount === 1.5 && d[1].name === '中文', 'file JSON'); },
  },
  'json-to-excel': {
    sample: async () => { const t = await tableText(); assert(t.includes('items.0.sku'), 'sample table'); const rows = readXlsx(await download()); assert(rows[1][0] === 1001, 'xlsx A2'); },
    file: async () => { const rows = readXlsx(await download()); assert(rows[0].join('|') === 'id|name|tags.0|tags.1' && rows[2][1] === '中文', 'file xlsx'); },
  },
  'excel-to-json': {
    sample: async () => { const t = await outText(); assert(t.includes('"zip": "50667"') && t.includes('"date": "2026-11-02"') && t.includes('"paid": true'), 'sample JSON'); },
    file: async () => { const d = JSON.parse((await download()).toString('utf8')); assert(d.length === 3 && d[1].zip === '01001', 'file JSON'); },
  },
  'csv-to-excel': {
    sample: async () => { const rows = readXlsx(await download()); assert(rows[1][3] === 24.9 && rows[3][5].startsWith('Two lines'), 'sample xlsx'); },
    file: async () => { const rows = readXlsx(await download()); assert(rows[1][1] === 'Ä; Ö' && rows[1][2] === 1.5, 'file xlsx'); },
  },
  'xml-validator': {
    sample: async (lang) => {
      const t = await reportText();
      const expected = texts[lang].ui.lineCol.replace('{line}', '4').replace('{col}', '21');
      assert(t.includes(texts[lang].ui.invalid) && t.includes(expected), 'validator error at 4:21, got: ' + t.slice(0, 200));
      assert(await evaluate(`!!document.querySelector('#out-report .excerpt')`), 'excerpt shown');
    },
    file: async (lang) => { const t = await reportText(); assert(t.includes(texts[lang].ui.valid), 'valid file'); },
  },
};
const FIXTURE_OF = { xml: fixtures.xml, json: fixtures.json, csv: fixtures.csv, excel: fixtures.excel };

function assert(cond, what) {
  if (!cond) throw new Error('check failed: ' + what);
}

// ---------------------------------------------------------------- run
const results = [];
function pathOf(lang, kind, id) {
  const prefix = lang === site.default_language ? '' : lang + '/';
  const t = texts[lang];
  if (kind === 'home') return prefix;
  if (kind === 'tool') return prefix + t.tools[id].slug + '/';
  return prefix + t.pages[kind].slug + '/';
}

async function checkPage(name, fn) {
  pageErrors = [];
  requests = [];
  const t0 = Date.now();
  try {
    await fn();
    const foreign = requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith('blob:') && !u.startsWith('data:'));
    assert(foreign.length === 0, 'requests to other hosts: ' + foreign.join(', '));
    // The CSP probe fetches robots.txt on purpose; its blocked-request messages are expected.
    const errors = pageErrors.filter((e) => !e.includes('/klarto-convert/robots.txt'));
    assert(errors.length === 0, 'console: ' + errors.join(' | '));
    results.push({ name, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

async function noHorizontalScroll() {
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
  await sleep(150);
  const w = await evaluate(`[document.documentElement.scrollWidth, document.documentElement.clientWidth]`);
  await cdp('Emulation.clearDeviceMetricsOverride');
  assert(w[0] <= w[1], `horizontal scroll at 375 px: scrollWidth ${w[0]} > ${w[1]}`);
}

async function screenshot(file) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(join(SHOTS, file), Buffer.from(data, 'base64'));
}

for (const lang of site.languages) {
  for (const kind of ['home', 'privacy', 'licenses']) {
    if (ONLY) break;
    await checkPage(`${lang} ${kind}`, async () => {
      await navigate(ORIGIN + BASE + pathOf(lang, kind));
      const h1 = await evaluate(`document.querySelectorAll('h1').length`);
      assert(h1 === 1, 'one h1');
      await noHorizontalScroll();
      await screenshot(`${lang}-${kind}.png`);
    });
  }
  for (const tool of site.tools) {
    if (ONLY && tool.id !== ONLY) continue;
    const url = ORIGIN + BASE + pathOf(lang, 'tool', tool.id);
    await checkPage(`${lang} ${tool.id} sample`, async () => {
      workerSession = null;
      await navigate(url);
      assert(await evaluate(`document.getElementById('file').focus(), document.activeElement.id === 'file'`), 'file input is keyboard-focusable');
      await evaluate(`document.getElementById('sample').click()`);
      await waitFor(RESULT_READY);
      await CHECKS[tool.id].sample(lang);
      if (lang === 'en') {
        // The worker inherits the page's CSP: a request from it must fail.
        assert(workerSession, 'worker target attached');
        const probe = `fetch(${JSON.stringify(ORIGIN + BASE + 'robots.txt')}).then(() => 'fetched', (e) => 'blocked')`;
        for (const sid of [S, workerSession]) {
          const r = await send('Runtime.evaluate', { expression: probe, awaitPromise: true, returnByValue: true }, sid);
          assert(r.result.value === 'blocked', `fetch from ${sid === S ? 'page' : 'worker'} was ${r.result.value}`);
        }
      }
      await noHorizontalScroll();
      await screenshot(`${lang}-${tool.id}.png`);
    });
    if (lang === 'en') {
      await checkPage(`${lang} ${tool.id} file`, async () => {
        await navigate(url);
        await setFile(CHECKS[tool.id].fixture ? fixtures[CHECKS[tool.id].fixture] : FIXTURE_OF[tool.in]);
        await waitFor(RESULT_READY);
        await CHECKS[tool.id].file(lang);
      });
    }
    if (tool.input === 'text' && tool.in !== 'csv') {
      await checkPage(`${lang} ${tool.id} error message`, async () => {
        await navigate(url);
        const bad = tool.in === 'xml' ? '<a>\n  <b>\n</a>' : '{\n  "a": 1,\n}';
        await evaluate(`(() => { document.getElementById('paste').value = ${JSON.stringify(bad)}; document.getElementById('convert').click(); })()`);
        await waitFor(`!document.getElementById('out-report').hidden`);
        const t = await reportText();
        const m = texts[lang].errors;
        const expected = tool.in === 'xml'
          ? texts[lang].ui.lineCol.replace('{line}', '3').replace('{col}', '1') + ': ' + m['xml.mismatchedTag'].replace('{found}', 'a').replace('{expected}', 'b').replace('{openLine}', '2').replace('{openCol}', '3')
          : texts[lang].ui.lineCol.replace('{line}', '3').replace('{col}', '1') + ': ' + m['json.trailingComma'];
        assert(t.includes(expected), `localized error, expected "${expected}", got "${t.slice(0, 300)}"`);
      });
    }
  }
}

if (LARGE) {
  // 50 MB CSV through the real page, file input and worker.
  const big = join(work, 'big.csv');
  const parts = ['id,name,city,amount,date,note\n'];
  let size = 0;
  for (let i = 0; size < 50 * 1024 * 1024; i++) {
    const line = `${i},"Customer ${i}, Ltd",Köln,${(i % 1000) + 0.25},2026-11-${String((i % 28) + 1).padStart(2, '0')},"note ""${i}"""\n`;
    parts.push(line);
    size += Buffer.byteLength(line);
  }
  writeFileSync(big, parts.join(''));
  const bigRows = parts.length - 1;
  await checkPage('en csv-to-json 50 MB file', async () => {
    await navigate(ORIGIN + BASE + 'csv-to-json/');
    const t0 = Date.now();
    await setFile(big);
    let sawProgress = false;
    for (;;) {
      const st = await evaluate(`[document.getElementById('status-text').textContent, !document.getElementById('cancel').hidden, !document.getElementById('output').hidden]`);
      if (st[1] && /\d+ %/.test(st[0])) sawProgress = true;
      if (st[2] && !st[1]) break;
      if (Date.now() - t0 > 300000) throw new Error('timeout');
      await sleep(100);
    }
    const s = (Date.now() - t0) / 1000;
    const status = await evaluate(`document.getElementById('status-text').textContent`);
    const size = await evaluate(`+document.getElementById('download').dataset.size`);
    console.log(`large: 50 MB CSV (${bigRows} rows) -> JSON in the page: ${s.toFixed(1)} s, output ${(size / 1048576).toFixed(1)} MB, progress shown: ${sawProgress}, status "${status}"`);
    assert(sawProgress, 'progress percentage was shown');
    assert(size > 50 * 1024 * 1024, 'output size');
  });
  rmSync(big);
  // 20 MB XML through the page to an .xlsx download.
  const bigXml = join(work, 'big.xml');
  const xp = ['<?xml version="1.0" encoding="UTF-8"?>\n<orders>\n'];
  let xs = 0;
  let records = 0;
  for (; xs < 20 * 1024 * 1024; records++) {
    const rec = `  <order id="${records}"><customer>Анна ${records}</customer><item sku="A${records % 97}" qty="2">Pen &amp; ink</item><item sku="B">Pad</item><total currency="EUR">${records}.50</total></order>\n`;
    xp.push(rec);
    xs += Buffer.byteLength(rec);
  }
  xp.push('</orders>\n');
  writeFileSync(bigXml, xp.join(''));
  await checkPage('en xml-to-excel 20 MB file', async () => {
    await navigate(ORIGIN + BASE + 'xml-to-excel/');
    const t0 = Date.now();
    await setFile(bigXml);
    await waitFor(RESULT_READY, 300000);
    const s = (Date.now() - t0) / 1000;
    const rows = readXlsx(await download());
    console.log(`large: 20 MB XML (${records} records) -> xlsx in the page: ${s.toFixed(1)} s, ${rows.length - 1} data rows`);
    assert(rows.length - 1 === records, 'all records in the xlsx');
  });
}

// ---------------------------------------------------------------- report
const exited = new Promise((r) => chrome.once('exit', r));
chrome.kill();
await Promise.race([exited, sleep(5000)]);
server.close();
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
// Chrome's helper processes can write to the profile for a moment after exit.
await sleep(1500);
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? ` (${r.ms} ms)` : ': ' + r.error}`);
console.log(`smoke: ${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
