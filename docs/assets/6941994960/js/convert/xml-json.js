// XML <-> JSON mapping (documented on the pages and in README.md):
//   element            -> key with the element name, prefix kept ("soap:Body")
//   attribute          -> "@name" key ("@id", "@xmlns:soap")
//   text               -> the value itself when the element has no attributes
//                         and no child elements, otherwise a "#text" key
//   CDATA              -> text (merged with neighbouring text)
//   repeated siblings  -> array, in document order
//   empty element      -> "" (JSON -> XML writes null and "" as <name/>)
//   comments, processing instructions, the DOCTYPE -> dropped
//   whitespace-only text between elements is dropped; other text is trimmed
//   unless xml:space="preserve" applies. All values stay strings.
import { parseXml, isXmlName } from './xml-parse.js';
import { ConvertError, Warnings, setKey } from './errors.js';

function xmlTrim(s) {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c === 32 || c === 10 || c === 9 || c === 13) a++; else break;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c === 32 || c === 10 || c === 9 || c === 13) b--; else break;
  }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

export function parseForceArrays(s) {
  return new Set(String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean));
}

export function xmlToJson(text, opts = {}) {
  const force = opts.forceArrays instanceof Set ? opts.forceArrays : parseForceArrays(opts.forceArrays);
  const top = { obj: Object.create(null), preserve: false };
  const stack = [top];
  const handler = {
    start(name, attrs) {
      const parent = stack[stack.length - 1];
      let preserve = parent.preserve;
      let obj = null;
      if (attrs.length) {
        obj = {};
        for (let i = 0; i < attrs.length; i += 2) {
          setKey(obj, '@' + attrs[i], attrs[i + 1]);
          if (attrs[i] === 'xml:space') preserve = attrs[i + 1] === 'preserve';
        }
      }
      stack.push({ name, obj, texts: null, preserve });
    },
    text(s) {
      const f = stack[stack.length - 1];
      if (f.texts) f.texts.push(s); else f.texts = [s];
    },
    end() {
      const f = stack.pop();
      let t = f.texts ? (f.texts.length === 1 ? f.texts[0] : f.texts.join('')) : '';
      if (!f.preserve) t = xmlTrim(t);
      let value;
      if (f.obj === null) {
        value = t;
      } else {
        if (t !== '') setKey(f.obj, '#text', t);
        value = f.obj;
      }
      const parent = stack[stack.length - 1];
      if (parent.obj === null) parent.obj = {};
      const p = parent.obj;
      if (Object.prototype.hasOwnProperty.call(p, f.name)) {
        const cur = p[f.name];
        if (Array.isArray(cur)) cur.push(value);
        else p[f.name] = [cur, value];
      } else {
        setKey(p, f.name, force.has(f.name) && parent !== top ? [value] : value);
      }
    },
  };
  const stats = parseXml(text, handler, { onProgress: opts.onProgress });
  const json = {};
  setKey(json, stats.root, top.obj[stats.root]);
  if (opts.consistent) makeArraysConsistent(json);
  return { json, stats };
}

// An element that repeats under some parent becomes an array under every
// parent with the same path, so all records have the same shape.
export function makeArraysConsistent(json) {
  const repeated = new Set();
  const walk = (v, path, fix) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return;
    for (const k of Object.keys(v)) {
      if (k[0] === '@' || k === '#text') continue;
      const p = path + '/' + k;
      let c = v[k];
      if (fix && !Array.isArray(c) && repeated.has(p)) c = v[k] = [c];
      if (Array.isArray(c)) {
        if (!fix) repeated.add(p);
        for (const item of c) walk(item, p, fix);
      } else {
        walk(c, p, fix);
      }
    }
  };
  walk(json, '', false);
  if (repeated.size) walk(json, '', true);
  return json;
}

// ---------------------------------------------------------------- JSON -> XML

function escText(s) {
  return s.replace(/[&<>\r]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#13;'));
}

function escAttr(s) {
  return s.replace(/[&<"\t\n\r]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '"': '&quot;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' })[c]);
}

const BAD_CHAR_RE = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

// Make a valid XML name from a JSON key: invalid characters become "_",
// and a name that cannot start a name gets a "_" prefix.
export function toXmlName(key) {
  const k = String(key);
  if (isXmlName(k)) {
    const i = k.indexOf(':');
    if (i === -1 || (i > 0 && i < k.length - 1 && k.indexOf(':', i + 1) === -1)) return k;
  }
  let out = '';
  for (const ch of k) out += ch !== ':' && isXmlName('a' + ch) ? ch : '_';
  if (!isXmlName(out)) out = '_' + out;
  return out;
}

function primitiveText(v, path, warnings) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) warnings.add('json.unsafeInteger', { path });
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  const bad = BAD_CHAR_RE.exec(s);
  if (bad) throw new ConvertError('json.invalidXmlChar', { path, code: 'U+' + bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0') });
  return s;
}

export function jsonToXml(value, opts = {}) {
  const indentUnit = opts.indent === 0 ? '' : ' '.repeat(opts.indent || 2);
  const nl = indentUnit ? '\n' : '';
  const rootName = toXmlName(opts.rootName || 'root');
  const itemName = toXmlName(opts.itemName || 'item');
  const warnings = new Warnings();
  const parts = [];
  if (opts.declaration !== false) parts.push('<?xml version="1.0" encoding="UTF-8"?>' + nl);
  const renamed = new Map();
  const nameOf = (key) => {
    let n = renamed.get(key);
    if (n === undefined) {
      n = toXmlName(key);
      renamed.set(key, n);
      if (n !== key) warnings.add('json.renamedKey', { from: key, to: n });
    }
    return n;
  };
  const scopeHas = (scope, prefix) => {
    for (let s = scope; s; s = s.parent) if (s.set.has(prefix)) return true;
    return prefix === 'xml';
  };
  const checkPrefix = (name, scope) => {
    const i = name.indexOf(':');
    if (i > 0 && !scopeHas(scope, name.slice(0, i))) warnings.add('json.undeclaredPrefix', { prefix: name.slice(0, i), name });
  };

  // compact: inside xml:space="preserve" no indentation is added, because
  // every whitespace character there is data.
  function writeElement(key, v, depth, path, scope, compact) {
    const pad = compact ? '' : indentUnit.repeat(depth);
    const eol = compact ? '' : nl;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (Array.isArray(item)) {
          const name = nameOf(key);
          if (item.length === 0) { parts.push(pad + '<' + name + '/>' + eol); continue; }
          parts.push(pad + '<' + name + '>' + eol);
          writeElement(itemName, item, depth + 1, path + '[' + i + ']', scope, compact);
          parts.push(pad + '</' + name + '>' + eol);
        } else {
          writeElement(key, item, depth, path + '[' + i + ']', scope, compact);
        }
      }
      return;
    }
    const name = nameOf(key);
    if (v === null || typeof v !== 'object') {
      checkPrefix(name, scope);
      const t = primitiveText(v, path, warnings);
      parts.push(pad + (t === '' ? '<' + name + '/>' : '<' + name + '>' + escText(t) + '</' + name + '>') + eol);
      return;
    }
    let attrs = '';
    let text = null;
    const children = [];
    const attrNames = [];
    const used = new Set();
    let declared = null;
    let preserve = compact;
    for (const k of Object.keys(v)) {
      const cv = v[k];
      if (k.length > 1 && k[0] === '@') {
        let an = nameOf(k.slice(1));
        if (used.has(an)) {
          let n = 2;
          while (used.has(an + '_' + n)) n++;
          an = an + '_' + n;
          warnings.add('json.renamedKey', { from: k.slice(1), to: an });
        }
        let av;
        if (cv !== null && typeof cv === 'object') {
          warnings.add('json.attrNotPrimitive', { path: path + '.' + k });
          av = JSON.stringify(cv);
        } else {
          av = primitiveText(cv, path + '.' + k, warnings);
        }
        if (an.startsWith('xmlns:') && av === '') {
          warnings.add('json.emptyNsUri', { prefix: an.slice(6) });
          continue;
        }
        used.add(an);
        if (an === 'xmlns' || an.startsWith('xmlns:')) {
          if (!declared) declared = new Set();
          declared.add(an === 'xmlns' ? '' : an.slice(6));
        } else {
          attrNames.push(an);
        }
        if (an === 'xml:space') preserve = av === 'preserve' || (compact && av !== 'default');
        attrs += ' ' + an + '="' + escAttr(av) + '"';
      } else if (k === '#text') {
        text = cv !== null && typeof cv === 'object' ? JSON.stringify(cv) : primitiveText(cv, path + '.#text', warnings);
      } else {
        children.push(k);
      }
    }
    const inner = declared ? { parent: scope, set: declared } : scope;
    checkPrefix(name, inner);
    for (const an of attrNames) checkPrefix(an, inner);
    if (children.length === 0) {
      if (text === null || text === '') parts.push(pad + '<' + name + attrs + '/>' + eol);
      else parts.push(pad + '<' + name + attrs + '>' + escText(text) + '</' + name + '>' + eol);
      return;
    }
    if (preserve) {
      parts.push(pad + '<' + name + attrs + '>');
      if (text !== null && text !== '') parts.push(escText(text));
      for (const k of children) writeElement(k, v[k], depth + 1, path + '.' + k, inner, true);
      parts.push('</' + name + '>' + eol);
      return;
    }
    parts.push(pad + '<' + name + attrs + '>' + nl);
    if (text !== null && text !== '') parts.push(pad + indentUnit + escText(text) + nl);
    for (const k of children) writeElement(k, v[k], depth + 1, path + '.' + k, inner, false);
    parts.push(pad + '</' + name + '>' + nl);
  }

  let wrapped = true;
  try {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      const k = keys[0];
      if (keys.length === 1 && k[0] !== '@' && k !== '#text' && !Array.isArray(value[k])) {
        wrapped = false;
        writeElement(k, value[k], 0, k, null, false);
      } else {
        writeElement(rootName, value, 0, '', null, false);
      }
    } else if (Array.isArray(value)) {
      parts.push('<' + rootName + '>' + nl);
      writeElement(itemName, value, 1, '', null, false);
      parts.push('</' + rootName + '>' + nl);
    } else {
      writeElement(rootName, value, 0, '', null, false);
    }
  } catch (e) {
    if (e instanceof RangeError) throw new ConvertError('general.tooDeep');
    throw e;
  }
  if (wrapped) warnings.add('json.wrappedInRoot', { root: rootName });
  return { parts, warnings: warnings.list() };
}
