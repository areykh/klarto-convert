// JSON input: JSON.parse for speed; on failure a small scanner finds the exact
// position and kind of the first error, so messages are the same in every
// browser. JSON Lines (one value per line) is accepted where opts.jsonLines.
import { ConvertError, lineCol } from './errors.js';

function isWs(c) {
  return c === 32 || c === 10 || c === 13 || c === 9;
}

// Returns {code, pos, params} for the first error in s, or null if s is valid.
export function findJsonError(s) {
  let i = 0;
  const n = s.length;
  const err = (code, pos, params = {}) => ({ code, pos, params });
  const ws = () => {
    for (;;) {
      while (i < n && isWs(s.charCodeAt(i))) i++;
      if (s.charCodeAt(i) === 47 && (s.charCodeAt(i + 1) === 47 || s.charCodeAt(i + 1) === 42)) {
        throw err('json.comment', i);
      }
      return;
    }
  };
  const charAt = (p) => (p < n ? String.fromCodePoint(s.codePointAt(p)) : '');
  const string = () => {
    const start = i;
    i++;
    for (;;) {
      if (i >= n) throw err('json.unterminatedString', start);
      const c = s.charCodeAt(i);
      if (c === 34) { i++; return; }
      if (c === 92) {
        const e = s.charCodeAt(i + 1);
        if (e === 117) {
          if (!/^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) throw err('json.badEscape', i, { esc: s.slice(i, i + 6) });
          i += 6;
        } else if (e === 34 || e === 92 || e === 47 || e === 98 || e === 102 || e === 110 || e === 114 || e === 116) {
          i += 2;
        } else {
          throw err('json.badEscape', i, { esc: s.slice(i, i + 2) });
        }
        continue;
      }
      if (c < 0x20) throw err(c === 10 ? 'json.newlineInString' : 'json.controlChar', i, { code: 'U+' + c.toString(16).toUpperCase().padStart(4, '0') });
      i++;
    }
  };
  const number = () => {
    const m = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    m.lastIndex = i;
    const r = m.exec(s);
    const loose = /[-+]?[0-9A-Za-z.]+/y;
    loose.lastIndex = i;
    const l = loose.exec(s);
    if (!r || (l && l[0].length > r[0].length)) throw err('json.badNumber', i, { token: (l ? l[0] : charAt(i)).slice(0, 30) });
    i += r[0].length;
  };
  const value = (depth) => {
    ws();
    if (i >= n) throw err('json.unexpectedEnd', i);
    const c = s.charCodeAt(i);
    if (c === 123) return object(depth);
    if (c === 91) return array(depth);
    if (c === 34) return string();
    if (c === 45 || (c >= 48 && c <= 57)) return number();
    if (s.startsWith('true', i)) { i += 4; return; }
    if (s.startsWith('false', i)) { i += 5; return; }
    if (s.startsWith('null', i)) { i += 4; return; }
    if (c === 39) throw err('json.singleQuote', i);
    const word = /[A-Za-z_$][A-Za-z0-9_$]*/y;
    word.lastIndex = i;
    const w = word.exec(s);
    if (w) throw err('json.badLiteral', i, { token: w[0].slice(0, 30) });
    if (c === 43 || c === 46) throw err('json.badNumber', i, { token: s.slice(i, i + 10) });
    throw err('json.unexpectedChar', i, { char: charAt(i) });
  };
  const object = (depth) => {
    if (depth > 5000) throw err('general.tooDeep', i);
    i++;
    ws();
    if (s.charCodeAt(i) === 125) { i++; return; }
    for (;;) {
      ws();
      if (i >= n) throw err('json.unexpectedEnd', i);
      const c = s.charCodeAt(i);
      if (c === 125) throw err('json.trailingComma', i);
      if (c === 39) throw err('json.singleQuote', i);
      if (c !== 34) throw err('json.keyNotString', i, { char: charAt(i) });
      string();
      ws();
      if (s.charCodeAt(i) !== 58) throw i >= n ? err('json.unexpectedEnd', i) : err('json.missingColon', i, { char: charAt(i) });
      i++;
      value(depth + 1);
      ws();
      const d = s.charCodeAt(i);
      if (d === 44) { i++; continue; }
      if (d === 125) { i++; return; }
      if (i >= n) throw err('json.unexpectedEnd', i);
      throw err('json.missingComma', i, { char: charAt(i), close: '}' });
    }
  };
  const array = (depth) => {
    if (depth > 5000) throw err('general.tooDeep', i);
    i++;
    ws();
    if (s.charCodeAt(i) === 93) { i++; return; }
    for (;;) {
      ws();
      if (s.charCodeAt(i) === 93) throw err('json.trailingComma', i);
      value(depth + 1);
      ws();
      const d = s.charCodeAt(i);
      if (d === 44) { i++; continue; }
      if (d === 93) { i++; return; }
      if (i >= n) throw err('json.unexpectedEnd', i);
      throw err('json.missingComma', i, { char: charAt(i), close: ']' });
    }
  };
  try {
    value(0);
    ws();
    if (i < n) return err('json.extraData', i, { char: charAt(i) });
    return null;
  } catch (e) {
    if (e && e.code) return e;
    if (e instanceof RangeError) return err('general.tooDeep', i);
    throw e;
  }
}

function raise(text, e, lineOffset = 0) {
  const lc = lineCol(text, e.pos);
  throw new ConvertError(e.code, { ...e.params, line: lc.line + lineOffset, col: lc.col });
}

// Returns {value, jsonLines, records}. opts.jsonLines allows JSON Lines input.
export function parseJson(input, opts = {}) {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (/^\s*$/.test(text)) throw new ConvertError('input.empty');
  try {
    return { value: JSON.parse(text), jsonLines: false };
  } catch (parseErr) {
    if (parseErr instanceof RangeError) throw new ConvertError('general.tooDeep');
    const e = findJsonError(text);
    if (opts.jsonLines && e && e.code === 'json.extraData') {
      return parseJsonLines(text);
    }
    if (e) raise(text, e);
    throw new ConvertError('json.invalid', { detail: String(parseErr.message).slice(0, 200) });
  }
}

function parseJsonLines(text) {
  const values = [];
  let start = 0;
  let lineNo = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    lineNo++;
    const line = text.slice(start, end);
    if (!/^\s*$/.test(line)) {
      try {
        values.push(JSON.parse(line));
      } catch {
        const e = findJsonError(line) || { code: 'json.invalid', pos: 0, params: {} };
        const lc = lineCol(line, e.pos);
        throw new ConvertError(e.code, { ...e.params, line: lineNo, col: lc.col, jsonLines: true });
      }
    }
    start = end + 1;
  }
  return { value: values, jsonLines: true };
}
