// Errors and warnings carry a stable code plus parameters. The page translates
// them with the messages in src/i18n/<lang>.json ("errors" and "warnings").

export class ConvertError extends Error {
  constructor(code, params = {}) {
    super(code + (Object.keys(params).length ? ' ' + JSON.stringify(params) : ''));
    this.name = 'ConvertError';
    this.code = code;
    this.params = params;
  }
}

// Line and column (1-based) of a character offset. Columns count Unicode code
// points, so a character outside the BMP counts as one column.
export function lineCol(text, pos) {
  let line = 1;
  let lineStart = 0;
  let i = text.indexOf('\n');
  while (i !== -1 && i < pos) {
    line++;
    lineStart = i + 1;
    i = text.indexOf('\n', lineStart);
  }
  let col = 1;
  for (let k = lineStart; k < pos && k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (c >= 0xd800 && c <= 0xdbff && k + 1 < pos) k++;
    col++;
  }
  return { line, col };
}

// The text of one line (1-based), cut to maxLen characters around the column.
export function lineExcerpt(text, line, col, maxLen = 120) {
  let start = 0;
  for (let n = 1; n < line; n++) {
    const i = text.indexOf('\n', start);
    if (i === -1) return { text: '', caret: 0 };
    start = i + 1;
  }
  let end = text.indexOf('\n', start);
  if (end === -1) end = text.length;
  const chars = Array.from(text.slice(start, end));
  let from = 0;
  if (chars.length > maxLen) from = Math.max(0, Math.min(col - 1 - Math.floor(maxLen / 2), chars.length - maxLen));
  const shown = chars.slice(from, from + maxLen).join('').replace(/\t/g, ' ');
  return { text: shown, caret: col - 1 - from, cutStart: from > 0, cutEnd: from + maxLen < chars.length };
}

// Collects warnings; each code is stored once with a count and its first params.
export class Warnings {
  constructor() { this.map = new Map(); }
  add(code, params = {}) {
    const w = this.map.get(code);
    if (w) w.count++;
    else this.map.set(code, { code, params, count: 1 });
  }
  list() { return [...this.map.values()]; }
}

// Assign a key without ever touching the prototype ("__proto__" stays data).
export function setKey(obj, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}
