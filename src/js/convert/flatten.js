// Nested JSON <-> flat table (the "array rule", shown on the pages):
//   nested objects  -> dotted headers: customer.name, customer.address.city
//   arrays          -> numbered headers: tags.0, tags.1, items.0.sku, items.1.sku
//   empty object or array -> empty cell under its own header
//   columns appear in the order they are first seen; missing values are empty
// Which array becomes the rows: the largest array in the document that is not
// inside another array (the user can pick another one); a top-level array is
// used as is; with no array the whole document is one row.
import { setKey } from './errors.js';

export function findArrays(value, maxDepth = 12) {
  const out = [];
  const walk = (v, path, depth) => {
    if (v === null || typeof v !== 'object' || depth > maxDepth) return;
    if (Array.isArray(v)) {
      let objs = 0;
      const m = Math.min(v.length, 100);
      for (let i = 0; i < m; i++) if (v[i] !== null && typeof v[i] === 'object' && !Array.isArray(v[i])) objs++;
      out.push({ path: path.slice(), count: v.length, objects: m > 0 && objs * 2 >= m });
      return;
    }
    for (const k of Object.keys(v)) {
      path.push(k);
      walk(v[k], path, depth + 1);
      path.pop();
    }
  };
  walk(value, [], 0);
  out.sort((a, b) => (b.objects - a.objects) || b.count - a.count || a.path.length - b.path.length);
  return out.slice(0, 50);
}

export function getAt(value, path) {
  let v = value;
  for (const k of path) {
    if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

// The records to turn into rows, and the choices for the UI.
// pathKey: 'auto' | 'whole' | JSON.stringify(path) of one of the choices.
export function pickRecords(value, pathKey = 'auto') {
  const choices = findArrays(value);
  let chosen = null;
  if (pathKey === 'auto') {
    chosen = choices.find((c) => c.path.length === 0) || choices.find((c) => c.objects) || null;
  } else if (pathKey !== 'whole') {
    chosen = choices.find((c) => JSON.stringify(c.path) === pathKey) || null;
  }
  const records = chosen ? getAt(value, chosen.path) : [value];
  return { records, chosen, choices };
}

// Calls emit(header, value) for every leaf of one record.
export function flattenRecord(rec, emit) {
  if (rec === null || typeof rec !== 'object') {
    emit('value', rec);
    return;
  }
  const walk = (v, prefix) => {
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) {
        if (v.length === 0) { emit(prefix, ''); return; }
        for (let i = 0; i < v.length; i++) walk(v[i], prefix + '.' + i);
      } else {
        const keys = Object.keys(v);
        if (keys.length === 0) { emit(prefix, ''); return; }
        for (const k of keys) walk(v[k], prefix + '.' + k);
      }
    } else {
      emit(prefix, v);
    }
  };
  if (Array.isArray(rec)) {
    if (rec.length === 0) emit('value', '');
    for (let i = 0; i < rec.length; i++) walk(rec[i], String(i));
  } else {
    const keys = Object.keys(rec);
    for (const k of keys) walk(rec[k], k);
  }
}

// Header list in first-seen order (first pass over all records).
export function collectHeaders(records, onProgress) {
  const index = new Map();
  const headers = [];
  for (let r = 0; r < records.length; r++) {
    flattenRecord(records[r], (h) => {
      if (!index.has(h)) { index.set(h, headers.length); headers.push(h); }
    });
    if (onProgress && (r & 4095) === 0) onProgress(r, records.length);
  }
  return { headers, index };
}

// One record as an array of cells aligned to headers. Two paths that give
// the same header (a key "a.b" and a nested a -> b) keep the first value.
export function recordRow(rec, index, width, warnings) {
  const row = new Array(width);
  flattenRecord(rec, (h, v) => {
    const i = index.get(h);
    if (row[i] !== undefined) {
      if (warnings) warnings.add('flatten.headerClash', { header: h });
      return;
    }
    row[i] = v;
  });
  return row;
}

const INT_RE = /^(0|[1-9][0-9]*)$/;

// Rebuild nesting from dotted headers. Segments that are 0..n-1 (all of them,
// without gaps) become arrays. A dotted header whose first part(s) are also a
// header of their own ("a" and "a.b") keeps its flat name, in any order.
export function unflatten(flat) {
  const keys = Object.keys(flat);
  const all = new Set(keys);
  const root = {};
  for (const key of keys) {
    const parts = key.split('.');
    let flatKey = parts.length === 1 || parts.some((p) => p === '');
    for (let i = 1; !flatKey && i < parts.length; i++) {
      if (all.has(parts.slice(0, i).join('.'))) flatKey = true;
    }
    if (flatKey) { setKey(root, key, flat[key]); continue; }
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!Object.prototype.hasOwnProperty.call(node, p)) setKey(node, p, {});
      node = node[p];
    }
    setKey(node, parts[parts.length - 1], flat[key]);
  }
  return toArrays(root);
}

function toArrays(v) {
  if (v === null || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  for (const k of keys) v[k] = toArrays(v[k]);
  if (keys.length && keys.every((k) => INT_RE.test(k))) {
    const nums = keys.map(Number).sort((a, b) => a - b);
    if (nums.every((x, i) => x === i)) return nums.map((x) => v[String(x)]);
  }
  return v;
}
