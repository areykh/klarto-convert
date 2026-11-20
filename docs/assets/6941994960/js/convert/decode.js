// Turn file bytes into text: byte order mark, XML encoding declaration,
// strict UTF-8, and (for CSV only) a Windows-1252 fallback with a notice.
import { ConvertError } from './errors.js';

// Offset of the first byte that is not part of a valid UTF-8 sequence, or -1.
export function firstInvalidUtf8(b) {
  const n = b.length;
  let i = 0;
  while (i < n) {
    const c = b[i];
    if (c < 0x80) { i++; continue; }
    let need, min;
    if (c >= 0xc2 && c <= 0xdf) { need = 1; min = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { need = 2; min = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { need = 3; min = 0x10000; }
    else return i;
    let cp = c & (0xff >> (need + 2));
    for (let k = 1; k <= need; k++) {
      const d = b[i + k];
      if (d === undefined || (d & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (d & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += need + 1;
  }
  return -1;
}

function lineOfByte(b, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (b[i] === 0x0a) line++;
  return line;
}

function declaredXmlEncoding(b) {
  const head = String.fromCharCode(...b.subarray(0, Math.min(b.length, 300)));
  const m = /^<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z][A-Za-z0-9._-]*)["']/.exec(head);
  return m ? m[1] : null;
}

function decoderFor(label) {
  try {
    return new TextDecoder(label);
  } catch {
    throw new ConvertError('decode.unknownEncoding', { encoding: label });
  }
}

// kind: 'xml' | 'json' | 'csv'
export function decodeBytes(input, kind) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length === 0) throw new ConvertError('input.empty');
  // Byte order marks
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return finishUtf8(b.subarray(3), kind, 'UTF-8', true);
  }
  if (b[0] === 0xff && b[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'UTF-16LE', bom: true };
  }
  if (b[0] === 0xfe && b[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'UTF-16BE', bom: true };
  }
  if (kind === 'xml') {
    if (b[0] === 0x3c && b[1] === 0x00 && b[2] === 0x3f && b[3] === 0x00) {
      return { text: new TextDecoder('utf-16le').decode(b), encoding: 'UTF-16LE', bom: false };
    }
    if (b[0] === 0x00 && b[1] === 0x3c && b[2] === 0x00 && b[3] === 0x3f) {
      return { text: new TextDecoder('utf-16be').decode(b), encoding: 'UTF-16BE', bom: false };
    }
    const enc = declaredXmlEncoding(b);
    if (enc && !/^utf-?8$/i.test(enc)) {
      if (/^utf-?16/i.test(enc)) throw new ConvertError('decode.utf16NoBom', { encoding: enc });
      const dec = decoderFor(enc);
      return { text: dec.decode(b), encoding: dec.encoding.toUpperCase(), bom: false };
    }
  }
  if (kind !== 'xml') {
    // UTF-16 without a byte order mark: every second byte of Latin text is 0.
    const m = Math.min(b.length, 4096) & ~1;
    let even = 0;
    let odd = 0;
    for (let i = 0; i < m; i += 2) { if (b[i] === 0) even++; if (b[i + 1] === 0) odd++; }
    const half = m / 2;
    if (half >= 2 && odd > half * 0.3 && even < half * 0.05) return { text: new TextDecoder('utf-16le').decode(b), encoding: 'UTF-16LE', bom: false };
    if (half >= 2 && even > half * 0.3 && odd < half * 0.05) return { text: new TextDecoder('utf-16be').decode(b), encoding: 'UTF-16BE', bom: false };
  }
  return finishUtf8(b, kind, 'UTF-8', false);
}

function finishUtf8(b, kind, encoding, bom) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding, bom };
  } catch {
    if (kind === 'csv' && !bom) {
      return { text: new TextDecoder('windows-1252').decode(b), encoding: 'WINDOWS-1252', bom: false, notice: 'decode.readAs1252' };
    }
    const off = firstInvalidUtf8(b);
    throw new ConvertError(kind === 'xml' ? 'decode.invalidUtf8Xml' : 'decode.invalidUtf8', { line: lineOfByte(b, Math.max(0, off)) });
  }
}
