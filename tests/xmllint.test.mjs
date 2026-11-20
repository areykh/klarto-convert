// Differential test: our parser and libxml2 (xmllint) must agree on whether
// each of 1,500 mutated documents is well-formed. Skipped (not passed) when
// xmllint is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseXml } from '../src/js/convert/xml-parse.js';

const has = spawnSync('xmllint', ['--version']).status === 0;

const SEEDS = [
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE r [<!ENTITY e "x&#38;y"><!ELEMENT r ANY>]>\n<r xmlns:p="urn:p" a="1"><p:b p:c="2">t &e; &lt;</p:b><![CDATA[c]]><!-- k --><?pi d?></r>',
  '<a><b x="1" y=\'2\'>text</b><c/></a>',
  '<s:E xmlns:s="u"><s:B><m xmlns="v">1</m></s:B></s:E>',
];
const CHARS = ['<', '>', '&', ';', '"', "'", '/', '!', '?', '-', ':', ' ', 'a', '1', '[', ']', '=', '#', 'x', '%'];

test('agrees with libxml2 on 1,500 mutated documents', { skip: has ? false : 'xmllint not installed' }, () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const differences = [];
  for (let k = 0; k < 1500; k++) {
    let s = SEEDS[k % SEEDS.length];
    for (let o = 1 + rnd(2); o > 0; o--) {
      const i = rnd(s.length);
      const op = rnd(3);
      if (op === 0) s = s.slice(0, i) + s.slice(i + 1);
      else if (op === 1) s = s.slice(0, i) + CHARS[rnd(CHARS.length)] + s.slice(i);
      else s = s.slice(0, i) + CHARS[rnd(CHARS.length)] + s.slice(i + 1);
    }
    let ours = true;
    try { parseXml(s); } catch { ours = false; }
    const r = spawnSync('xmllint', ['--noout', '--nonet', '-'], { input: s });
    const theirs = r.status === 0 && !/error/i.test(String(r.stderr));
    if (ours !== theirs) differences.push({ doc: s, ours, libxml2: theirs, msg: String(r.stderr).slice(0, 200) });
  }
  assert.deepEqual(differences, []);
});
