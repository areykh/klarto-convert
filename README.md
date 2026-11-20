# Klarto Convert

Free converters for XML, JSON, CSV and Excel files that run entirely in the
browser, plus an XML validator. A static website for GitHub Pages, planned at
<https://areykh.github.io/klarto-convert/>, in English, German, French and
Spanish (52 pages).

| Tool | What it does |
|---|---|
| XML to JSON | attributes as `@name`, text as `#text`, repeated elements as arrays, CDATA as text |
| JSON to XML | the reverse mapping; invalid names are adjusted and reported |
| XML to Excel | one row per record, nested elements and attributes as dotted columns |
| Excel to XML | one element per row, headers as element names (`@header` = attribute) |
| JSON to CSV | dotted columns for nested data, numbered columns for arrays, JSON Lines |
| CSV to JSON | delimiter detection, quoted fields with line breaks, decimal comma |
| JSON to Excel | JSON types kept, ISO dates as date cells |
| Excel to JSON | header row as keys, dates as ISO 8601, numbers stored as text stay text |
| CSV to Excel | leading zeros, phone numbers and long IDs stay text |
| XML validator | XML 1.0 + Namespaces well-formedness, first error with line and column |

Excel input: `.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.ods`. Excel output: `.xlsx`.

## Privacy

Files are processed only in the visitor's browser. They are never uploaded,
stored or sent anywhere. The pages set no cookies, use no local storage and
contain no analytics, advertising or third-party code; every file, including
SheetJS, is served from the site itself. Each page has a Content Security
Policy with `connect-src 'none'`, so its scripts cannot send data. The
conversions run in a Web Worker that is started from a `blob:` URL; such a
worker inherits the page's policy, so it cannot send data either (the smoke
test checks that a `fetch` from the page and from the worker is blocked).
GitHub Pages logs visitor IP addresses for security, according to GitHub's
documentation; the site operator has no access to those logs.

## Layout

```
src/site.json        tools, options, base URL, owner, accepted file types
src/templates/*.html page skeletons with {{placeholders}}
src/i18n/*.json      all page text and messages, one file per language
src/js/convert/*.js  the converters: plain ES modules, no DOM, used by the
                     page's worker and by the Node tests
src/js/worker.js     runs a conversion off the main thread, reports progress
src/js/app.js        page logic (file input, drop, paste, options, output)
src/js/samples.js    the "Try a sample" inputs
src/css/style.css    one stylesheet, light and dark
src/vendor/          SheetJS Community Edition, unchanged
build.py             renders the pages into docs/ (Python standard library only)
docs/                generated site; GitHub Pages serves this folder
tests/               Node unit, round-trip and large-file tests; smoke.mjs
tools/check_site.py  link, asset, hreflang and sitemap checker for docs/
check.sh             runs everything
```

`build.py` fills the templates in `src/templates/` (every placeholder must get
a value, or the build stops). Links between pages and to assets are relative, so the site works under any base path; only canonical
URLs, `hreflang` links and the sitemap use the absolute base URL from
`src/site.json` (override with `python3 build.py --base-url URL`). Assets go to
`docs/assets/<content hash>/`, so a new build never mixes old and new scripts
in a browser cache.

## Build and test

Requirements: Python 3 (standard library), Node.js 22 or newer (tested with
24.22.1), Google Chrome or Chromium for the smoke test, and optionally Python
`openpyxl` for an extra XLSX cross-check. No npm packages are installed.

```sh
python3 build.py              # build docs/
python3 build.py --check      # check texts and HTML; fail if docs/ is stale
node --test tests/            # unit, round-trip and large-file tests
LARGE=0 node --test tests/    # the same without the 50 MB / 20 MB tests
python3 tools/check_site.py   # links, assets, hreflang, sitemap, titles
node tests/smoke.mjs          # headless Chrome on every page
node tests/smoke.mjs --large  # plus 50 MB CSV and 20 MB XML in the page
./check.sh                    # all of the above (pass --large to add it)
```

The smoke test drives Chrome through the DevTools protocol over a pipe, so it
needs no Playwright or Puppeteer. Results and tested limits: `TESTS.md`.

## Why an own XML parser

The spec prefers the browser's `DOMParser`. The site uses its own small,
strict XML 1.0 + Namespaces parser (`src/js/convert/xml-parse.js`) instead,
because `DOMParser` does not exist in Node, so the unit tests would not test
the code users run, and because browsers report errors in different formats,
while the validator promises the same line and column everywhere. The parser
was compared with libxml2 (`xmllint`) on 1,500 mutated documents: no
disagreement. It never loads external files, bounds entity expansion, and
leaves entities from an unread external DTD (such as `&nbsp;` in XHTML)
unexpanded with a note, as XML 1.0 allows for non-validating parsers.

## Conversion rules

Every tool page states its rules under "How the conversion works"; the source of
truth is the code in `src/js/convert/`.

XML and JSON: element → key with the element name (prefix kept, `soap:Body`);
attribute → `"@name"` (namespace declarations as `"@xmlns:p"`); text → the value,
or `"#text"` when the element also has attributes or children; CDATA → text;
repeated siblings → array in document order (by default an element that repeats
anywhere is an array at that path everywhere); empty element → `""`; comments,
processing instructions and the DOCTYPE are dropped; values stay strings. JSON to
XML uses the same mapping in reverse.

Array rule for CSV and Excel: nested objects → dotted headers (`customer.city`);
arrays → numbered headers (`tags.0`, `items.1.sku`); empty object or array → an
empty cell; columns in first-seen order. Rows come from a top-level array, or
else from the largest array of objects (selectable), or else the whole document
is one row. "Nest dotted headers" reverses the rule.

## Deployment notes

- GitHub Pages: branch `main`, folder `/docs`. `docs/.nojekyll` turns off Jekyll.
- `robots.txt` only takes effect at the root of a host. For the project site
  `areykh.github.io/klarto-convert/`, submit `sitemap.xml` in Google Search
  Console (URL-prefix property) instead. For the HTML-tag verification method,
  put the token into `google_site_verification` in `src/site.json` and rebuild;
  it is added to the English start page only.
- The vendored ES modules are published as `xlsx.js` and `cpexcel.full.js`
  instead of `.mjs`, so that any static host serves them with a JavaScript MIME
  type (module scripts require one).

## SheetJS

SheetJS Community Edition 0.20.3 (Apache License 2.0), downloaded from
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` on 2026-11-20. It was the
latest version listed on cdn.sheetjs.com; git tag v0.20.3 is dated 2024-07-18.
The npm registry package `xlsx` is outdated (0.18.5) and is not used.

| File | SHA-256 |
|---|---|
| xlsx-0.20.3.tgz | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` |
| package/xlsx.mjs | `1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db` |
| package/dist/cpexcel.full.mjs | `7a7bba23b6b6f23b5c69fbb631f78d1d455f74b57e4aa54e9a2f81a8ab844964` |
| package/LICENSE | `4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64` |

`cpexcel.full.mjs` (code pages for old `.xls` files) is loaded only when an
`.xls` file is opened.

## Licences

- Klarto Convert: MIT License, see `LICENSE`.
- SheetJS Community Edition: Apache License 2.0, © SheetJS LLC, see
  `src/vendor/sheetjs-0.20.3/LICENSE` (also published with the site and linked
  from the licences page).

Klarto is a project by Arsenii Khmelnytskyi.
