import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../src/js/convert/xml-parse.js';
import { xmlToJson, jsonToXml } from '../src/js/convert/xml-json.js';

const err = (fn) => {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected an error');
};
const x2j = (s, o) => xmlToJson(s, o).json;
const j2x = (v, o) => jsonToXml(v, o).parts.join('');

test('well-formed documents parse', () => {
  const docs = [
    '<a/>',
    '<?xml version="1.0"?><a/>',
    "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n<a/>\n",
    '<!-- c --><?pi data?><a><!-- in --><?pi x?></a><!-- after -->',
    '<!DOCTYPE a><a/>',
    '<!DOCTYPE a SYSTEM "a.dtd"><a/>',
    '<!DOCTYPE a PUBLIC "-//X//DTD X//EN" "x.dtd" [<!ELEMENT a (#PCDATA)><!ATTLIST a b CDATA "x">]><a/>',
    '<a xmlns="urn:x" xmlns:p="urn:p"><p:b p:c="1" c="2"/></a>',
    '<a xml:lang="uk">Привіт</a>',
    '<a>&lt;&gt;&amp;&apos;&quot;&#65;&#x1F600;</a>',
    '<a><![CDATA[ <not> & markup ]]></a>',
    '<a b="1" c=\'2\'  d = "3"/>',
    '<a>></a>',
    '<ä名_x.y-z:w xmlns:ä名_x.y-z="urn:u"/>',
  ];
  for (const d of docs) assert.doesNotThrow(() => parseXml(d), d);
});

test('stats: root, element count, depth, encoding', () => {
  const s = parseXml('<?xml version="1.0" encoding="ISO-8859-1"?><r><a><b/></a><a/></r>');
  assert.equal(s.root, 'r');
  assert.equal(s.elements, 4);
  assert.equal(s.maxDepth, 3);
  assert.equal(s.encoding, 'ISO-8859-1');
});

test('malformed documents give the right code, line and column', () => {
  const cases = [
    ['<a><b></a>', 'xml.mismatchedTag', 1, 7],
    ['<a>\n  <b>\n</a>', 'xml.mismatchedTag', 3, 1],
    ['<a x=1/>', 'xml.attrNotQuoted', 1, 6],
    ['<a x/>', 'xml.attrNoValue', 1, 4],
    ['<a x="1"y="2"/>', 'xml.missingSpace', 1, 9],
    ['<a x="1" x="2"/>', 'xml.duplicateAttr', 1, 10],
    ['<a x="<"/>', 'xml.ltInAttr', 1, 7],
    ['<a x="1/>', 'xml.unclosedAttr', 1, 6],
    ['<a>Tom & Jerry</a>', 'xml.bareAmpersand', 1, 8],
    ['<a>&nbsp;</a>', 'xml.undefinedEntity', 1, 4],
    ['<a>&#1;</a>', 'xml.badCharRef', 1, 4],
    ['<a>\u0001</a>', 'xml.invalidChar', 1, 4],
    ['<a>]]></a>', 'xml.cdataEndInText', 1, 4],
    [' <?xml version="1.0"?><a/>', 'xml.misplacedXmlDecl', 1, 2],
    ['<?xml version="2"?><a/>', 'xml.badXmlDecl', 1, 1],
    ['<a/><b/>', 'xml.multipleRoots', 1, 5],
    ['<a/>text', 'xml.textAfterRoot', 1, 5],
    ['text<a/>', 'xml.textBeforeRoot', 1, 1],
    ['<a>', 'xml.unclosedTag', 1, 4],
    ['<a', 'xml.unexpectedEof', 1, 3],
    ['</a>', 'xml.unexpectedEndTag', 1, 1],
    ['<1a/>', 'xml.badTagStart', 1, 1],
    ['< a/>', 'xml.badTagStart', 1, 1],
    ['<a><!-- x -- y --></a>', 'xml.doubleHyphen', 1, 11],
    ['<a><!-- x </a>', 'xml.unclosedComment', 1, 4],
    ['<a><![CDATA[x</a>', 'xml.unclosedCdata', 1, 4],
    ['<![CDATA[x]]><a/>', 'xml.cdataOutsideRoot', 1, 1],
    ['<a/><!DOCTYPE a>', 'xml.misplacedDoctype', 1, 5],
    ['<p:a/>', 'xml.undeclaredPrefix', 1, 2],
    ['<a p:b="1"/>', 'xml.undeclaredPrefix', 1, 4],
    ['<a xmlns:p=""/>', 'xml.emptyNsUri', 1, 4],
    ['<xmlns:a/>', 'xml.reservedPrefix', 1, 2],
    ['<a:b:c xmlns:a="u"/>', 'xml.badQName', 1, 2],
    ['<a xmlns:p="u" xmlns:q="u" p:x="1" q:x="2"/>', 'xml.duplicateAttr', 1, 36],
    ['<a/ >', 'xml.expectedTagEnd', 1, 3],
    ['<a></a x>', 'xml.expectedTagEnd', 1, 8],
    ['', 'input.empty'],
    ['   \n ', 'input.empty'],
    ['<!-- only a comment -->', 'xml.noRoot', 1, 24],
    ['<a><?xml version="1.0"?></a>', 'xml.misplacedXmlDecl', 1, 4],
    ['<a><!ELEMENT></a>', 'xml.badMarkup', 1, 4],
  ];
  for (const [doc, code, line, col] of cases) {
    const e = err(() => parseXml(doc));
    assert.equal(e.code, code, JSON.stringify(doc) + ' -> ' + e.message);
    if (line !== undefined) assert.deepEqual([e.params.line, e.params.col], [line, col], JSON.stringify(doc));
  }
});

test('mismatched tag reports where the open element started', () => {
  const e = err(() => parseXml('<root>\n  <item>\n    <name>x</item>\n</root>'));
  assert.equal(e.code, 'xml.mismatchedTag');
  assert.deepEqual([e.params.expected, e.params.found, e.params.openLine, e.params.line], ['name', 'item', 3, 3]);
  const u = err(() => parseXml('<root>\n  <item>\n'));
  assert.equal(u.code, 'xml.unclosedTag');
  assert.equal(u.params.name, 'item');
  assert.equal(u.params.openLine, 2);
});

test('CRLF and CR line ends count as one line each', () => {
  const e = err(() => parseXml('<a>\r\n<b>\r\n</a>'));
  assert.equal(e.params.line, 3);
  const e2 = err(() => parseXml('<a>\r<b>\r</a>'));
  assert.equal(e2.params.line, 3);
});

test('columns count characters outside the BMP once', () => {
  const e = err(() => parseXml('<a>😀😀 & </a>'));
  assert.equal(e.params.col, 7);
});

test('DOCTYPE internal entities expand; loops and bombs are stopped', () => {
  assert.deepEqual(x2j('<!DOCTYPE a [<!ENTITY co "Klarto &amp; Co"><!ENTITY x "&co; (&#169;)">]><a>&x;</a>'), { a: 'Klarto & Co (©)' });
  assert.equal(err(() => parseXml('<!DOCTYPE a [<!ENTITY e "&e;">]><a>&e;</a>')).code, 'xml.entityLoop');
  // An external entity is never loaded: in content it stays unexpanded, in an attribute it is an error.
  const ext = parseXml('<!DOCTYPE a [<!ENTITY e SYSTEM "file:///etc/passwd">]><a>&e;</a>');
  assert.deepEqual(ext.unexpanded, ['e']);
  assert.deepEqual(x2j('<!DOCTYPE a [<!ENTITY e SYSTEM "file:///etc/passwd">]><a>&e;</a>'), { a: '&e;' });
  assert.equal(err(() => parseXml('<!DOCTYPE a [<!ENTITY e SYSTEM "x">]><a b="&e;"/>')).code, 'xml.externalEntity');
  assert.equal(err(() => parseXml('<!DOCTYPE a [<!ENTITY e "<b/>">]><a>&e;</a>')).code, 'xml.entityMarkup');
  let bomb = '<!DOCTYPE lolz [<!ENTITY lol "lollollollollollollollollollol">';
  for (let i = 1; i < 10; i++) bomb += `<!ENTITY lol${i} "${`&lol${i === 1 ? '' : i - 1};`.repeat(10)}">`;
  bomb += ']><lolz>&lol9;</lolz>';
  assert.equal(err(() => parseXml(bomb)).code, 'xml.entityExpansionLimit');
});

test('mapping: attributes, text, #text, arrays, empty, CDATA, namespaces', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<catalog xmlns:dc="http://purl.org/dc/elements/1.1/">
  <book id="1" lang="uk">
    <dc:title>Кобзар</dc:title>
    <price currency="EUR">12.50</price>
    <note><![CDATA[<b>bold</b> & co]]></note>
    <empty/>
    <empty2></empty2>
    <attrOnly a="1"/>
  </book>
  <book id="2"><dc:title>日本語の本</dc:title></book>
</catalog>`;
  assert.deepEqual(x2j(xml), {
    catalog: {
      '@xmlns:dc': 'http://purl.org/dc/elements/1.1/',
      book: [
        { '@id': '1', '@lang': 'uk', 'dc:title': 'Кобзар', price: { '@currency': 'EUR', '#text': '12.50' }, note: '<b>bold</b> & co', empty: '', empty2: '', attrOnly: { '@a': '1' } },
        { '@id': '2', 'dc:title': '日本語の本' },
      ],
    },
  });
});

test('mapping: mixed content, whitespace, xml:space, CDATA joins text', () => {
  assert.deepEqual(x2j('<p>Hello <b>world</b>!</p>'), { p: { b: 'world', '#text': 'Hello !' } });
  assert.deepEqual(x2j('<a>\n   x  y \n</a>'), { a: 'x  y' });
  assert.deepEqual(x2j('<a xml:space="preserve">  x </a>'), { a: { '@xml:space': 'preserve', '#text': '  x ' } });
  assert.deepEqual(x2j('<a>one <![CDATA[two]]> three</a>'), { a: 'one two three' });
  assert.deepEqual(x2j('<a>\u00A0x\u00A0</a>'), { a: '\u00A0x\u00A0' }, 'no-break spaces are data, not XML whitespace');
});

test('mapping: repeated elements in document order; interleaved names group', () => {
  assert.deepEqual(x2j('<r><a>1</a><b>x</b><a>2</a><a>3</a></r>'), { r: { a: ['1', '2', '3'], b: 'x' } });
});

test('force arrays option', () => {
  assert.deepEqual(x2j('<r><item>1</item></r>', { forceArrays: 'item' }), { r: { item: ['1'] } });
  assert.deepEqual(x2j('<r><item>1</item><item>2</item></r>', { forceArrays: 'item, other' }), { r: { item: ['1', '2'] } });
});

test('attribute values: normalisation and references', () => {
  assert.deepEqual(x2j('<a b="x\ny\tz" c="&lt;&#10;&quot;"/>'), { a: { '@b': 'x y z', '@c': '<\n"' } });
});

test('element names that look like prototype keys stay data', () => {
  const j = x2j('<r><__proto__>x</__proto__><constructor>y</constructor></r>');
  assert.equal(Object.getPrototypeOf(j.r), Object.prototype);
  assert.equal(j.r.__proto__, 'x');
  assert.equal(JSON.stringify(j), '{"r":{"__proto__":"x","constructor":"y"}}');
  assert.equal(err(() => parseXml('<a>&constructor;</a>')).code, 'xml.undefinedEntity');
});

test('BOM and non-Latin text', () => {
  assert.deepEqual(x2j('\uFEFF<a>Ελληνικά עברית العربية 中文 😀</a>'), { a: 'Ελληνικά עברית العربية 中文 😀' });
});

// ------------------------------------------------------------- JSON -> XML

test('JSON -> XML: root rules', () => {
  assert.equal(j2x({ a: { b: '1' } }, { indent: 0 }), '<?xml version="1.0" encoding="UTF-8"?><a><b>1</b></a>');
  assert.equal(j2x({ a: 1, b: 2 }, { indent: 0, declaration: false }), '<root><a>1</a><b>2</b></root>');
  assert.equal(j2x([1, 2], { indent: 0, declaration: false }), '<root><item>1</item><item>2</item></root>');
  assert.equal(j2x({ list: [1, 2] }, { indent: 0, declaration: false }), '<root><list>1</list><list>2</list></root>');
  assert.equal(j2x('x', { indent: 0, declaration: false, rootName: 'data' }), '<data>x</data>');
  const w = jsonToXml({ a: 1, b: 2 }).warnings;
  assert.equal(w[0].code, 'json.wrappedInRoot');
});

test('JSON -> XML: attributes, #text, null, booleans, numbers, nested arrays', () => {
  const v = { r: { '@id': 7, '@ok': true, '#text': 'hi', n: null, e: '', f: 1.5, list: [[1, 2], []], o: {} } };
  assert.equal(j2x(v, { indent: 0, declaration: false }), '<r id="7" ok="true">hi<n/><e/><f>1.5</f><list><item>1</item><item>2</item></list><list/><o/></r>');
});

test('JSON -> XML: escaping', () => {
  const s = j2x({ a: { '@q': 'say "hi" & <go>\n\tnow', '#text': 'a < b && c > d\r!' } }, { indent: 0, declaration: false });
  assert.equal(s, '<a q="say &quot;hi&quot; &amp; &lt;go>&#10;&#9;now">a &lt; b &amp;&amp; c &gt; d&#13;!</a>');
  assert.deepEqual(x2j(s), { a: { '@q': 'say "hi" & <go>\n\tnow', '#text': 'a < b && c > d\r!' } });
});

test('JSON -> XML: invalid names are renamed with a warning', () => {
  const r = jsonToXml({ root: { 'first name': 1, '1st': 2, '': 3, 'a:b:c': 4, 'ok-name.x': 5 } }, { indent: 0, declaration: false });
  assert.equal(r.parts.join(''), '<root><first_name>1</first_name><_1st>2</_1st><_>3</_><a_b_c>4</a_b_c><ok-name.x>5</ok-name.x></root>');
  assert.ok(r.warnings.some((w) => w.code === 'json.renamedKey' && w.count === 4));
});

test('JSON -> XML: characters XML cannot hold are an error', () => {
  const e = err(() => jsonToXml({ a: { b: 'x\u0001' } }));
  assert.equal(e.code, 'json.invalidXmlChar');
  assert.equal(e.params.code, 'U+0001');
  assert.equal(e.params.path, 'a.b');
});

test('JSON -> XML: undeclared namespace prefix gives a warning, declared does not', () => {
  assert.ok(jsonToXml({ 'p:a': 1 }).warnings.some((w) => w.code === 'json.undeclaredPrefix'));
  assert.deepEqual(jsonToXml({ 'p:a': { '@xmlns:p': 'urn:p', 'p:b': 1 } }).warnings, []);
});

test('JSON -> XML: unsafe integers are flagged', () => {
  const r = jsonToXml(JSON.parse('{"a": 12345678901234567890}'));
  assert.ok(r.warnings.some((w) => w.code === 'json.unsafeInteger'));
});

test('JSON -> XML: "__proto__" keys from JSON.parse become elements', () => {
  assert.equal(j2x(JSON.parse('{"r":{"__proto__":{"x":1}}}'), { indent: 0, declaration: false }), '<r><__proto__><x>1</x></__proto__></r>');
});

test('round trip XML -> JSON -> XML keeps the structure', () => {
  const docs = [
    '<a/>',
    '<a x="1"/>',
    '<a>text</a>',
    '<r><item id="1">one</item><item id="2">two</item><other/></r>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><m:Get xmlns:m="urn:m"><m:id>5</m:id></m:Get></s:Body></s:Envelope>',
    '<a xmlns="urn:default"><b>x</b></a>',
    '<a><![CDATA[1 < 2 & 3]]></a>',
    '<a>Ünïcødé · 漢字 · 😀</a>',
    '<a q="&quot;&lt;&amp;&#10;"><b xml:space="preserve">  x  </b></a>',
    '<r><x><y><z>deep</z></y></x><x/></r>',
    '<price currency="EUR">12.50</price>',
  ];
  for (const d of docs) {
    const j1 = x2j(d);
    for (const indent of [0, 2]) {
      const xml = j2x(j1, { indent });
      assert.doesNotThrow(() => parseXml(xml), xml);
      assert.deepEqual(x2j(xml), j1, d + ' indent ' + indent);
    }
  }
});

test('round trip JSON -> XML -> JSON for XML-shaped JSON', () => {
  const v = { order: { '@id': '42', customer: { name: 'Anna', city: 'Köln' }, line: [{ '@sku': 'A1', '#text': '2' }, { '@sku': 'B2', '#text': '1' }] } };
  assert.deepEqual(x2j(j2x(v)), v);
});

test('entities from a DTD that is not read stay unexpanded (XHTML)', () => {
  const xhtml = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html><p>a&nbsp;b</p></html>';
  assert.deepEqual(parseXml(xhtml).unexpanded, ['nbsp']);
  assert.deepEqual(x2j(xhtml), { html: { p: 'a&nbsp;b' } });
  assert.equal(err(() => parseXml('<?xml version="1.0" standalone="yes"?><!DOCTYPE r SYSTEM "r.dtd"><r>&x;</r>')).code, 'xml.undefinedEntity');
  assert.deepEqual(parseXml('<!DOCTYPE r [<!ENTITY % p SYSTEM "p.ent"> %p;]><r>&x;</r>').unexpanded, ['x']);
});

test('entity expansion is bounded in references, not only in characters', () => {
  let d = '<!DOCTYPE r [<!ENTITY a0 "">';
  for (let i = 1; i <= 8; i++) d += `<!ENTITY a${i} "${`&a${i - 1};`.repeat(10)}">`;
  d += ']><r>&a8;</r>';
  const t0 = Date.now();
  assert.equal(err(() => parseXml(d)).code, 'xml.entityExpansionLimit');
  assert.ok(Date.now() - t0 < 2000, 'stops quickly');
});

test('DTD syntax and namespace names are checked like libxml2 and expat', () => {
  const bad = [
    '<!DOCTYPE r [<!-- a -- b -->]><r/>',
    '<!DOCTYPE r [<? ?>]><r/>',
    '<!DOCTYPE r SYSTEM"x.dtd"><r/>',
    '<!DOCTYPE r PUBLIC "a{b" "x"><r/>',
    '<!DOCTYPE r [<!ENTITY e "50%">]><r/>',
    '<!DOCTYPE r [<!ENTITY e "a & b">]><r/>',
    '<!DOCTYPE r [<!ELEMENTr ANY>]><r/>',
    '<!DOCTYPE r [<!ENTITY% e "x">]><r/>',
    '<p:1 xmlns:p="u"/>',
    '<a xmlns:="u"/>',
    '<a xmlns:a:b="u"/>',
    '<a xmlns:1a="u"/>',
    '<?a:b x?><r/>',
    '<?xml version="1.0"\u00A0?><r/>',
  ];
  for (const d of bad) assert.throws(() => parseXml(d), (e) => e.code && e.code.startsWith('xml.'), JSON.stringify(d));
  for (const d of ['<!DOCTYPE r [<!ELEMENT r ANY><!ATTLIST r a CDATA "x"><!NOTATION n SYSTEM "n"><!ENTITY e "&#37; &amp; &lt;">]><r>&e;</r>', '<!DOCTYPE r PUBLIC "-//A//B C//EN" "x.dtd"><r/>']) {
    assert.doesNotThrow(() => parseXml(d), d);
  }
});

test('JSON -> XML: renamed attributes never collide; empty prefix declarations are left out', () => {
  const r = jsonToXml({ r: { '@a b': '1', '@a_b': '2' } }, { indent: 0, declaration: false });
  const xml = r.parts.join('');
  assert.equal(xml, '<r a_b="1" a_b_2="2"/>');
  assert.doesNotThrow(() => parseXml(xml));
  const e = jsonToXml({ r: { '@xmlns:p': '', 'p:x': '1' } }, { indent: 0, declaration: false });
  assert.equal(e.parts.join(''), '<r><p:x>1</p:x></r>');
  assert.ok(e.warnings.some((w) => w.code === 'json.emptyNsUri'));
  assert.ok(e.warnings.some((w) => w.code === 'json.undeclaredPrefix'));
});

test('JSON -> XML: no indentation is added inside xml:space="preserve"', () => {
  const doc = '<r><code xml:space="preserve"><a>x</a> <b> y </b></code><n><m>1</m></n></r>';
  const j1 = x2j(doc);
  const xml = j2x(j1, { indent: 2 });
  assert.ok(xml.includes('<code xml:space="preserve"> <a>x</a><b> y </b></code>'), xml); // text first: positions in mixed content are not kept
  assert.deepEqual(x2j(xml), j1);
});
