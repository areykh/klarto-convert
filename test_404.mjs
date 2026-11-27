// Tests the script of docs/404.html with a fake `location`, for every old page.
//   node --test test_404.mjs        (DOCS=path/to/docs to test another build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DOCS = process.env.DOCS || path.join(path.dirname(new URL(import.meta.url).pathname), 'docs');
const html = fs.readFileSync(path.join(DOCS, '404.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const HOME = 'https://kadben.com/';

// The real targets, read from the redirect pages themselves.
const targets = {};
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name), rel + e.name + '/');
    else if (e.name === 'index.html') {
      const t = fs.readFileSync(path.join(dir, e.name), 'utf8').match(/http-equiv="refresh" content="0; url=([^"]+)"/)[1];
      targets[rel] = t.replace(/&amp;/g, '&');
    }
  }
})(DOCS, '/');

function go(pathname, search = '', hash = '') {
  let to = null;
  const location = { pathname, search, hash, replace(u) { if (to === null) to = u; } };
  new Function('location', script)(location);
  return to;
}
const enc = (p) => '/klarto-convert' + p.split('/').map(encodeURIComponent).join('/');

test('there are 363 old pages and the start page is one of them', () => {
  assert.equal(Object.keys(targets).length, 363);
  assert.ok(targets['/']);
});

test('every old page, as written and in capitals, goes to its own target with ?query and #hash', () => {
  for (const [old, t] of Object.entries(targets)) {
    assert.equal(go(enc(old), '?a=1', '#h'), t + '?a=1#h', old);
    assert.equal(go(enc(old.toUpperCase())), t, old + ' in capitals');
    assert.equal(go(enc(old) + 'index.html'), t, old + 'index.html');
    if (old !== '/') assert.equal(go(enc(old.slice(0, -1))), t, old + ' without the final slash');
  }
});

test('double slashes and /index.htm', () => {
  assert.equal(go('/klarto-convert//xml-to-json//'), targets['/xml-to-json/']);
  assert.equal(go('/klarto-convert/xml-to-json/index.htm'), targets['/xml-to-json/']);
});

test('unknown addresses go to the nearest old page above them, without ?query and #hash', () => {
  assert.equal(go('/klarto-convert/xml-to-json/old.html', '?x=1', '#y'), targets['/xml-to-json/']);
  assert.equal(go('/klarto-convert/uk/no-such-page/'), targets['/uk/']);
  assert.equal(go('/klarto-convert/de/a/b/c/'), targets['/de/']);
  assert.equal(go('/klarto-convert/UK/No-Such-Page'), targets['/uk/']);
});

test('anything else goes to the kadben.com start page', () => {
  for (const p of ['/klarto-convert/no-such-page/', '/klarto-convert/assets/js/site.js',
    '/klarto-convert/sitemap.xml', '/klarto-convert/%E0%A4%A/', '/klarto-convert/', '/klarto-convert']) {
    const to = go(p);
    assert.ok(to === HOME || to === targets['/'], p + ' -> ' + to);
  }
});

test('every target is an https://kadben.com/ address', () => {
  for (const t of Object.values(targets)) assert.ok(t.startsWith(HOME), t);
});

test('without JavaScript the page still leads to the start page, and is not indexed', () => {
  assert.match(html, /<noscript><meta http-equiv="refresh" content="0; url=https:\/\/kadben\.com\/"><\/noscript>/);
  assert.match(html, /<meta name="robots" content="noindex">/);
});
