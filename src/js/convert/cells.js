// Cell values for Excel: text -> number/date detection, Excel serial dates.
// Excel stores a date as days since 1899-12-30 (1900 date system), and
// pretends 1900-02-29 existed, so serials before 1900-03-01 are shifted by one.

const DAY_MS = 86400000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;
export const MAX_CELL_TEXT = 32767;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

// ISO 8601 date or local date-time (no time zone) -> Excel serial, or null.
export function isoToSerial(s) {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1) return null;
  const t = Date.UTC(y, mo - 1, d);
  if (new Date(t).getUTCDate() !== d) return null; // 2026-02-30
  let serial = (t - EPOCH_1900) / DAY_MS;
  if (serial < 61) serial -= 1;
  if (m[4] !== undefined) {
    const h = +m[4], mi = +m[5], sec = m[6] !== undefined ? +m[6] : 0, ms = m[7] !== undefined ? +m[7].padEnd(3, '0') : 0;
    if (h > 23 || mi > 59 || sec > 59) return null;
    serial += (h * 3600000 + mi * 60000 + sec * 1000 + ms) / DAY_MS;
    return { serial, time: true };
  }
  return { serial, time: false };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// Excel serial -> "YYYY-MM-DD", "YYYY-MM-DDTHH:MM:SS" or "HH:MM:SS".
export function serialToIso(serial, date1904 = false) {
  if (!Number.isFinite(serial) || serial < 0) return String(serial);
  let totalSec = Math.round(serial * 86400);
  let days = Math.floor(totalSec / 86400);
  const secs = totalSec - days * 86400;
  const time = pad(Math.floor(secs / 3600)) + ':' + pad(Math.floor((secs % 3600) / 60)) + ':' + pad(secs % 60);
  if (!date1904 && days === 0) return serial < 1 && secs ? time : '1900-01-00';
  let ms;
  if (date1904) {
    ms = EPOCH_1904 + days * DAY_MS;
  } else {
    if (days === 60) return '1900-02-29' + (secs ? 'T' + time : '');
    if (days < 60) days += 1;
    ms = EPOCH_1900 + days * DAY_MS;
  }
  const dt = new Date(ms);
  const date = pad(dt.getUTCFullYear(), 4) + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
  return secs ? date + 'T' + time : date;
}

// No thousands separators: "1.234" or "1,234" could mean either 1234 or 1.234,
// so they are not guessed and stay text unless they match the decimal mark.
// What a number format shows: a date, a time of day, or elapsed time ([h]).
export function dateFormatKind(fmt) {
  const f = String(fmt || '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '')
    .replace(/AM\/PM|A\/P/gi, '')
    .toLowerCase();
  const time = /[hs]/.test(f);
  const date = /[yd]/.test(f) || (/m/.test(f) && !time);
  return { date, time, elapsed: /\[[hms]+\]/.test(f) };
}

// Excel serial with a date/time number format -> ISO 8601 text:
// "2026-11-20", "2026-11-20T14:30:00", "14:30:00", or "36:00:00" for [h].
export function formatDateCell(serial, fmt, date1904 = false) {
  if (!Number.isFinite(serial)) return String(serial);
  const k = dateFormatKind(fmt);
  const total = Math.round(serial * 86400);
  if (!k.date) {
    const secs = k.elapsed ? Math.abs(total) : ((total % 86400) + 86400) % 86400;
    const h = Math.floor(secs / 3600);
    return (total < 0 && k.elapsed ? '-' : '') + pad(h) + ':' + pad(Math.floor((secs % 3600) / 60)) + ':' + pad(secs % 60);
  }
  const day = Math.floor(total / 86400);
  const iso = serialToIso(day, date1904);
  if (!k.time) return iso;
  const secs = total - day * 86400;
  return iso + 'T' + pad(Math.floor(secs / 3600)) + ':' + pad(Math.floor((secs % 3600) / 60)) + ':' + pad(secs % 60);
}

const NUM_DOT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const NUM_COMMA = /^-?(?:0|[1-9]\d*)(?:,\d+)?$/;

// Text that looks like a number -> number, else null. Leading zeros ("007"),
// a leading "+" (phone numbers) and more than 15 digits (IDs, card and account
// numbers) stay text, because Excel would change them.
export function parseNumber(s, decimal = '.') {
  if (s.length === 0 || s.length > 40) return null;
  let t;
  if (decimal === ',') {
    if (!NUM_COMMA.test(s)) return null;
    t = s.replace(',', '.');
  } else {
    if (!NUM_DOT.test(s)) return null;
    t = s;
  }
  const digits = t.replace(/[^0-9]/g, '').replace(/^0+/, '').length;
  if (digits > 15) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

// A text value (from CSV or XML) -> SheetJS cell.
export function textCell(s, opts) {
  if (s === '' || s === null || s === undefined) return undefined;
  if (opts.detect) {
    const n = parseNumber(s, opts.decimal);
    if (n !== null) return { t: 'n', v: n };
    const d = isoToSerial(s);
    if (d) return { t: 'n', v: d.serial, z: d.time ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd' };
  }
  return { t: 's', v: s };
}

// A JSON value -> SheetJS cell (JSON types are kept; ISO date strings
// optionally become dates).
export function jsonCell(v, opts) {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return { t: 'n', v };
  if (typeof v === 'boolean') return { t: 'b', v };
  const s = String(v);
  if (opts.dates) {
    const d = isoToSerial(s);
    if (d) return { t: 'n', v: d.serial, z: d.time ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd' };
  }
  return { t: 's', v: s };
}

// "A1"-style reference of a zero-based cell.
export function cellRef(r, c) {
  let col = '';
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    col = String.fromCharCode(65 + m) + col;
    n = Math.floor((n - 1) / 26);
  }
  return col + (r + 1);
}
