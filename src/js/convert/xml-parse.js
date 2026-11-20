// A small, strict, non-validating XML 1.0 parser with Namespaces in XML 1.0
// checks. It reports the first well-formedness error with line and column.
// The same code runs in the browser and in Node, so the tests cover exactly
// what users run. It never loads external entities or DTDs.
//
// handler callbacks (all optional):
//   start(name, attrs)  attrs is a flat array [name1, value1, name2, value2, ...]
//   end(name)
//   text(string, isCdata)
// opts.onProgress(done, total) is called about every 1 MB of input.
import { ConvertError, lineCol } from './errors.js';

const NS_START = ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NS_CHAR = NS_START + '\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040';
const NAME_RE = new RegExp(`[${NS_START}][${NS_CHAR}]*`, 'uy');
const NAME_FULL_RE = new RegExp(`^[${NS_START}][${NS_CHAR}]*$`, 'u');
const NCNAME_RE = new RegExp(`^[${NS_START.slice(1)}][${NS_CHAR.slice(1)}]*$`, 'u');
const PUBID_RE = /^[ \n\ra-zA-Z0-9\-'()+,./:=?;!*#@$_%]*$/;
const ENTREF_RE = new RegExp(`&([${NS_START}][${NS_CHAR}]*);`, 'uy');
const CHARREF_RE = /&#(?:x([0-9a-fA-F]+)|([0-9]+));/y;
const INVALID_CHAR_RE = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const XML_DECL_RE = /^<\?xml([ \t\n]+version[ \t\n]*=[ \t\n]*(["'])1\.[0-9]+\2)([ \t\n]+encoding[ \t\n]*=[ \t\n]*(["'])[A-Za-z][A-Za-z0-9._-]*\4)?([ \t\n]+standalone[ \t\n]*=[ \t\n]*(["'])(yes|no)\6)?[ \t\n]*\?>/;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const PREDEFINED = Object.assign(Object.create(null), { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' });
const MAX_ENTITY_EXPANSION = 1_000_000; // characters
const MAX_ENTITY_REFS = 100_000; // references expanded

export function isXmlName(s) {
  return NAME_FULL_RE.test(s);
}

export function isValidXmlChar(cp) {
  return cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

function hex(cp) {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

function isWs(c) {
  return c === 32 || c === 10 || c === 9 || c === 13;
}

export function parseXml(input, handler = {}, opts = {}) {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
  const len = text.length;
  const onProgress = opts.onProgress;
  const hStart = handler.start;
  const hEnd = handler.end;
  const hText = handler.text;

  const fail = (code, pos, params = {}) => {
    const lc = lineCol(text, pos);
    throw new ConvertError(code, { ...params, line: lc.line, col: lc.col });
  };

  if (len === 0 || /^\s*$/.test(text)) throw new ConvertError('input.empty');
  const bad = INVALID_CHAR_RE.exec(text);
  if (bad) fail('xml.invalidChar', bad.index, { code: hex(bad[0].codePointAt(0)) });

  let pos = 0;
  let encoding = null;
  let standalone = null;
  if (text.startsWith('<?xml') && (isWs(text.charCodeAt(5)) || text.charCodeAt(5) === 63)) {
    const m = XML_DECL_RE.exec(text);
    if (!m) fail('xml.badXmlDecl', 0);
    if (m[3]) encoding = /["']([^"']+)["']/.exec(m[3])[1];
    if (m[7]) standalone = m[7];
    pos = m[0].length;
  }

  const entities = new Map(); // name -> {value} | {external: true}
  const stack = [];
  const openPos = [];
  const scopes = [];
  let ns = null; // {parent, map}
  let seenRoot = false;
  let rootClosed = false;
  let sawDoctype = false;
  let elements = 0;
  let maxDepth = 0;
  let rootName = null;
  let lastProgress = 0;
  let expanded = 0;
  let refs = 0;
  let externalSubset = false; // DOCTYPE with SYSTEM/PUBLIC, or %pe; in the internal subset
  const unexpanded = new Set();

  const skipWs = () => {
    while (pos < len && isWs(text.charCodeAt(pos))) pos++;
  };

  const lookupNs = (prefix, scope) => {
    for (let s = scope; s; s = s.parent) {
      const uri = s.map.get(prefix);
      if (uri !== undefined) return uri;
    }
    return undefined;
  };

  const checkQName = (name, at, scope, isElement) => {
    const i = name.indexOf(':');
    if (i === -1) return;
    if (!NCNAME_RE.test(name.slice(0, i)) || !NCNAME_RE.test(name.slice(i + 1))) fail('xml.badQName', at, { name });
    const prefix = name.slice(0, i);
    if (prefix === 'xml') return;
    if (prefix === 'xmlns') {
      if (isElement) fail('xml.reservedPrefix', at, { name });
      return;
    }
    if (lookupNs(prefix, scope) === undefined) fail('xml.undeclaredPrefix', at, { prefix, name });
  };

  const expandEntity = (name, at, active, inAttr) => {
    const ent = entities.get(name);
    if (++refs > MAX_ENTITY_REFS) fail('xml.entityExpansionLimit', at, { name });
    if (!ent || (ent.external && !ent.unparsed && !inAttr)) {
      // Declared in a DTD that is not read, or an external parsed entity: a
      // non-validating parser may leave it unexpanded (XML 1.0, 4.4.3/5.1).
      if (!ent && !(externalSubset && standalone !== 'yes')) fail('xml.undefinedEntity', at, { name });
      unexpanded.add(name);
      return '&' + name + ';';
    }
    if (ent.external) fail('xml.externalEntity', at, { name });
    if (active.has(name)) fail('xml.entityLoop', at, { name });
    let v = ent.value;
    if (v.indexOf('<') !== -1) fail(inAttr ? 'xml.ltInAttr' : 'xml.entityMarkup', at, { name });
    if (v.indexOf('&') !== -1) {
      active.add(name);
      v = expandRefs(v, at, inAttr, active, true);
      active.delete(name);
    }
    expanded += v.length;
    if (expanded > MAX_ENTITY_EXPANSION) fail('xml.entityExpansionLimit', at, { name });
    return v;
  };

  // Expand character and entity references in s. base is the offset of s in
  // text (for error positions); fixedAt is used inside entity values.
  function expandRefs(s, base, inAttr, active = new Set(), fixedAt = false) {
    let out = '';
    let last = 0;
    let i = s.indexOf('&');
    while (i !== -1) {
      out += s.slice(last, i);
      const at = fixedAt ? base : base + i;
      CHARREF_RE.lastIndex = i;
      let m = CHARREF_RE.exec(s);
      if (m) {
        const cp = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 10);
        if (!isValidXmlChar(cp)) fail('xml.badCharRef', at, { ref: m[0] });
        out += String.fromCodePoint(cp);
        last = CHARREF_RE.lastIndex;
      } else {
        ENTREF_RE.lastIndex = i;
        m = ENTREF_RE.exec(s);
        if (!m) fail('xml.bareAmpersand', at);
        const name = m[1];
        last = ENTREF_RE.lastIndex; // read before a nested expansion moves it
        const pre = PREDEFINED[name];
        out += pre !== undefined ? pre : expandEntity(name, at, active, inAttr);
      }
      i = s.indexOf('&', last);
    }
    return out + s.slice(last);
  }

  const quoted = (what) => {
    const q = text.charCodeAt(pos);
    if (q !== 34 && q !== 39) fail('xml.badDoctype', pos, { what });
    const end = text.indexOf(q === 34 ? '"' : "'", pos + 1);
    if (end === -1) fail('xml.badDoctype', pos, { what });
    const v = text.slice(pos + 1, end);
    pos = end + 1;
    return v;
  };

  const requireWs = () => {
    if (!isWs(text.charCodeAt(pos))) fail('xml.badDoctype', pos);
    skipWs();
  };

  const parseExternalId = () => {
    if (text.startsWith('SYSTEM', pos)) {
      pos += 6; requireWs(); quoted('SYSTEM'); return true;
    }
    if (text.startsWith('PUBLIC', pos)) {
      pos += 6; requireWs();
      const at = pos;
      if (!PUBID_RE.test(quoted('PUBLIC'))) fail('xml.badDoctype', at);
      requireWs(); quoted('PUBLIC'); return true;
    }
    return false;
  };

  const skipComment = () => {
    const e = text.indexOf('--', pos + 4);
    if (e === -1) fail('xml.unclosedComment', pos);
    if (text.charCodeAt(e + 2) !== 62) fail('xml.doubleHyphen', e);
    pos = e + 3;
  };

  const skipPI = () => {
    NAME_RE.lastIndex = pos + 2;
    const m = NAME_RE.exec(text);
    if (!m) fail('xml.badPI', pos);
    if (m[0].toLowerCase() === 'xml') fail('xml.misplacedXmlDecl', pos);
    if (m[0].indexOf(':') !== -1) fail('xml.badPI', pos);
    const after = text.charCodeAt(NAME_RE.lastIndex);
    if (!isWs(after) && !(after === 63 && text.charCodeAt(NAME_RE.lastIndex + 1) === 62)) fail('xml.badPI', pos);
    const e = text.indexOf('?>', NAME_RE.lastIndex);
    if (e === -1) fail('xml.unclosedPI', pos);
    pos = e + 2;
  };

  const skipDecl = (keywordLength) => {
    // <!ELEMENT ...>, <!ATTLIST ...>, <!NOTATION ...>: skip to '>' outside quotes
    pos += keywordLength;
    requireWs();
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 34 || c === 39) {
        const end = text.indexOf(c === 34 ? '"' : "'", pos + 1);
        if (end === -1) fail('xml.badDoctype', pos);
        pos = end + 1;
      } else if (c === 62) { pos++; return; }
      else pos++;
    }
    fail('xml.badDoctype', pos);
  };

  const parseEntityDecl = () => {
    const start = pos;
    pos += 8; // <!ENTITY
    requireWs();
    let param = false;
    if (text.charCodeAt(pos) === 37) { param = true; pos++; requireWs(); }
    NAME_RE.lastIndex = pos;
    const m = NAME_RE.exec(text);
    if (!m) fail('xml.badDoctype', pos);
    pos = NAME_RE.lastIndex;
    requireWs();
    let ent;
    if (parseExternalId()) {
      ent = { external: true };
      const beforeWs = pos;
      skipWs();
      if (text.startsWith('NDATA', pos)) {
        if (pos === beforeWs || param) fail('xml.badDoctype', pos);
        pos += 5; requireWs(); NAME_RE.lastIndex = pos; if (!NAME_RE.exec(text)) fail('xml.badDoctype', pos); pos = NAME_RE.lastIndex;
        ent.unparsed = true;
      }
    } else {
      const valueAt = pos;
      const raw = quoted('ENTITY');
      // Parameter-entity references are not allowed in the internal subset,
      // and every "&" must start a reference.
      if (raw.indexOf('%') !== -1) fail('xml.badDoctype', valueAt + 1 + raw.indexOf('%'));
      for (let i = raw.indexOf('&'); i !== -1; i = raw.indexOf('&', i + 1)) {
        CHARREF_RE.lastIndex = i;
        ENTREF_RE.lastIndex = i;
        if (!CHARREF_RE.test(raw) && !ENTREF_RE.test(raw)) fail('xml.bareAmpersand', valueAt + 1 + i);
      }
      // Character references are expanded when declared; entity references when used.
      let v = '';
      let last = 0;
      CHARREF_RE.lastIndex = 0;
      for (let i = raw.indexOf('&#'); i !== -1; i = raw.indexOf('&#', last)) {
        CHARREF_RE.lastIndex = i;
        const cm = CHARREF_RE.exec(raw);
        if (!cm) fail('xml.badCharRef', start, { ref: raw.slice(i, i + 10) });
        const cp = cm[1] !== undefined ? parseInt(cm[1], 16) : parseInt(cm[2], 10);
        if (!isValidXmlChar(cp)) fail('xml.badCharRef', start, { ref: cm[0] });
        v += raw.slice(last, i) + String.fromCodePoint(cp);
        last = CHARREF_RE.lastIndex;
      }
      ent = { value: v + raw.slice(last) };
    }
    skipWs();
    if (text.charCodeAt(pos) !== 62) fail('xml.badDoctype', pos);
    pos++;
    if (!param && !entities.has(m[0])) entities.set(m[0], ent);
  };

  const parseDoctype = () => {
    const start = pos;
    if (seenRoot || sawDoctype) fail('xml.misplacedDoctype', start);
    sawDoctype = true;
    pos += 9;
    if (!isWs(text.charCodeAt(pos))) fail('xml.badDoctype', pos);
    skipWs();
    NAME_RE.lastIndex = pos;
    if (!NAME_RE.exec(text)) fail('xml.badDoctype', pos);
    pos = NAME_RE.lastIndex;
    const afterName = pos;
    skipWs();
    if (pos > afterName && parseExternalId()) externalSubset = true;
    skipWs();
    if (text.charCodeAt(pos) === 91) { // [
      pos++;
      for (;;) {
        skipWs();
        if (pos >= len) fail('xml.badDoctype', start);
        if (text.charCodeAt(pos) === 93) { pos++; break; }
        if (text.startsWith('<!--', pos)) {
          skipComment();
        } else if (text.startsWith('<?', pos)) {
          skipPI();
        } else if (text.startsWith('<!ENTITY', pos)) {
          parseEntityDecl();
        } else if (text.startsWith('<!ELEMENT', pos) || text.startsWith('<!ATTLIST', pos)) {
          skipDecl(9);
        } else if (text.startsWith('<!NOTATION', pos)) {
          skipDecl(10);
        } else if (text.charCodeAt(pos) === 37) { // %name;
          NAME_RE.lastIndex = pos + 1;
          if (!NAME_RE.exec(text) || text.charCodeAt(NAME_RE.lastIndex) !== 59) fail('xml.badDoctype', pos);
          pos = NAME_RE.lastIndex + 1;
          externalSubset = true; // its declarations are not read
        } else {
          fail('xml.badDoctype', pos);
        }
      }
      skipWs();
    }
    if (text.charCodeAt(pos) !== 62) fail('xml.badDoctype', pos);
    pos++;
  };

  const parseStartTag = () => {
    const tagStart = pos;
    NAME_RE.lastIndex = pos + 1;
    const m = NAME_RE.exec(text);
    if (!m) {
      if (pos + 1 >= len) fail('xml.unexpectedEof', pos);
      fail('xml.badTagStart', pos, { char: String.fromCodePoint(text.codePointAt(pos + 1)) });
    }
    const name = m[0];
    pos = NAME_RE.lastIndex;
    if (stack.length === 0) {
      if (rootClosed) fail('xml.multipleRoots', tagStart, { name, root: rootName });
      seenRoot = true;
      rootName = name;
    }
    const attrs = [];
    const attrPos = [];
    let selfClose = false;
    for (;;) {
      const wsStart = pos;
      skipWs();
      if (pos >= len) fail('xml.unexpectedEof', pos, { name });
      const ch = text.charCodeAt(pos);
      if (ch === 62) { pos++; break; }
      if (ch === 47) {
        if (text.charCodeAt(pos + 1) === 62) { pos += 2; selfClose = true; break; }
        fail('xml.expectedTagEnd', pos, { name });
      }
      NAME_RE.lastIndex = pos;
      const am = NAME_RE.exec(text);
      if (!am) fail('xml.badAttrName', pos, { name, char: String.fromCodePoint(text.codePointAt(pos)) });
      if (pos === wsStart) fail('xml.missingSpace', pos, { name });
      const aname = am[0];
      const apos = pos;
      pos = NAME_RE.lastIndex;
      skipWs();
      if (text.charCodeAt(pos) !== 61) fail('xml.attrNoValue', apos, { name: aname });
      pos++;
      skipWs();
      const q = text.charCodeAt(pos);
      if (q !== 34 && q !== 39) fail('xml.attrNotQuoted', pos, { name: aname });
      const close = text.indexOf(q === 34 ? '"' : "'", pos + 1);
      if (close === -1) fail('xml.unclosedAttr', pos, { name: aname });
      let raw = text.slice(pos + 1, close);
      const lt = raw.indexOf('<');
      if (lt !== -1) fail('xml.ltInAttr', pos + 1 + lt, { name: aname });
      if (raw.indexOf('\n') !== -1 || raw.indexOf('\t') !== -1) raw = raw.replace(/[\n\t]/g, ' ');
      if (raw.indexOf('&') !== -1) raw = expandRefs(raw, pos + 1, true);
      for (let k = 0; k < attrs.length; k += 2) {
        if (attrs[k] === aname) fail('xml.duplicateAttr', apos, { name: aname });
      }
      attrs.push(aname, raw);
      attrPos.push(apos);
      pos = close + 1;
    }
    // Namespace declarations and prefixes
    let scope = ns;
    let declared = null;
    for (let k = 0; k < attrs.length; k += 2) {
      const an = attrs[k];
      if (an === 'xmlns' || an.startsWith('xmlns:')) {
        const uri = attrs[k + 1];
        const prefix = an === 'xmlns' ? '' : an.slice(6);
        if (an !== 'xmlns' && !NCNAME_RE.test(prefix)) fail('xml.badQName', attrPos[k / 2], { name: an });
        if (prefix === 'xmlns') fail('xml.reservedPrefix', attrPos[k / 2], { name: an });
        if (prefix === 'xml' && uri !== XML_NS) fail('xml.reservedPrefix', attrPos[k / 2], { name: an });
        if (prefix !== 'xml' && (uri === XML_NS || uri === XMLNS_NS)) fail('xml.reservedPrefix', attrPos[k / 2], { name: an });
        if (prefix !== '' && uri === '') fail('xml.emptyNsUri', attrPos[k / 2], { name: an });
        if (!declared) declared = new Map();
        declared.set(prefix, uri);
      }
    }
    if (declared) scope = { parent: ns, map: declared };
    checkQName(name, tagStart + 1, scope, true);
    const seen = attrs.length > 2 ? new Set() : null;
    for (let k = 0; k < attrs.length; k += 2) {
      const an = attrs[k];
      const i = an.indexOf(':');
      if (i === -1 || an.startsWith('xmlns:')) continue;
      checkQName(an, attrPos[k / 2], scope, false);
      if (seen) {
        // Two attributes with the same local name and namespace are not allowed.
        const uri = an.slice(0, i) === 'xml' ? XML_NS : lookupNs(an.slice(0, i), scope);
        const key = uri + '\u0000' + an.slice(i + 1);
        if (seen.has(key)) fail('xml.duplicateAttr', attrPos[k / 2], { name: an });
        seen.add(key);
      }
    }
    elements++;
    if (hStart) hStart(name, attrs);
    if (selfClose) {
      if (hEnd) hEnd(name);
      if (stack.length === 0) rootClosed = true;
      if (stack.length + 1 > maxDepth) maxDepth = stack.length + 1;
    } else {
      stack.push(name);
      openPos.push(tagStart);
      scopes.push(ns);
      ns = scope;
      if (stack.length > maxDepth) maxDepth = stack.length;
    }
  };

  const parseEndTag = () => {
    const tagStart = pos;
    NAME_RE.lastIndex = pos + 2;
    const m = NAME_RE.exec(text);
    if (!m) fail('xml.badEndTag', pos);
    pos = NAME_RE.lastIndex;
    skipWs();
    if (text.charCodeAt(pos) !== 62) fail('xml.expectedTagEnd', pos, { name: m[0] });
    pos++;
    if (stack.length === 0) fail('xml.unexpectedEndTag', tagStart, { name: m[0] });
    const open = stack[stack.length - 1];
    if (open !== m[0]) {
      const o = lineCol(text, openPos[openPos.length - 1]);
      fail('xml.mismatchedTag', tagStart, { expected: open, found: m[0], openLine: o.line, openCol: o.col });
    }
    stack.pop();
    openPos.pop();
    ns = scopes.pop();
    if (hEnd) hEnd(open);
    if (stack.length === 0) rootClosed = true;
  };

  const handleText = (start, end) => {
    if (stack.length === 0) {
      for (let i = start; i < end; i++) {
        if (!isWs(text.charCodeAt(i))) fail(seenRoot ? 'xml.textAfterRoot' : 'xml.textBeforeRoot', i);
      }
      return;
    }
    let s = text.slice(start, end);
    const cd = s.indexOf(']]>');
    if (cd !== -1) fail('xml.cdataEndInText', start + cd);
    if (s.indexOf('&') !== -1) s = expandRefs(s, start, false);
    if (hText) hText(s, false);
  };

  while (pos < len) {
    if (onProgress && pos - lastProgress > 1048576) {
      lastProgress = pos;
      onProgress(pos, len);
    }
    const lt = text.indexOf('<', pos);
    const end = lt === -1 ? len : lt;
    if (end > pos) handleText(pos, end);
    if (lt === -1) { pos = len; break; }
    pos = lt;
    const c = text.charCodeAt(pos + 1);
    if (c === 47) {
      parseEndTag();
    } else if (c === 33) {
      if (text.startsWith('<!--', pos)) {
        skipComment();
      } else if (text.startsWith('<![CDATA[', pos)) {
        if (stack.length === 0) fail('xml.cdataOutsideRoot', pos);
        const e = text.indexOf(']]>', pos + 9);
        if (e === -1) fail('xml.unclosedCdata', pos);
        if (hText) hText(text.slice(pos + 9, e), true);
        pos = e + 3;
      } else if (text.startsWith('<!DOCTYPE', pos)) {
        parseDoctype();
      } else {
        fail('xml.badMarkup', pos);
      }
    } else if (c === 63) {
      skipPI();
    } else {
      parseStartTag();
    }
  }
  if (stack.length) {
    const o = lineCol(text, openPos[openPos.length - 1]);
    fail('xml.unclosedTag', len, { name: stack[stack.length - 1], openLine: o.line, openCol: o.col });
  }
  if (!seenRoot) fail('xml.noRoot', len);
  if (onProgress) onProgress(len, len);
  return { root: rootName, elements, maxDepth, encoding, doctype: sawDoctype, unexpanded: [...unexpanded] };
}
