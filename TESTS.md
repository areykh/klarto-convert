# Tests and tested limits

Measured on 2026-11-20/21 on the development laptop: 4 CPU cores, 7 GB RAM
(about 2–3 GB free during the runs), Ubuntu 26.04, Node.js 24.22.1,
Google Chrome 157.0.8103.78 (headless), Python 3.14.4, openpyxl 3.1.5,
libxml2 xmllint 2.15.2. Run everything with `./check.sh` (add `--large` for
the browser runs below).

## What was tested and the results

| Check | Command | Result |
|---|---|---|
| Build in check mode: all four languages have the same keys, placeholders and `code` spans as English; every error/warning code used in the JS has a message; 3–5 steps and 3–5 FAQ entries per tool; title/description lengths; one `<h1>`, unique title and description per page; every template placeholder filled; `docs/` identical to a fresh build | `python3 build.py --check` | 52 pages, 0 problems |
| Unit, round-trip, differential and large-file tests (Node test runner) | `node --test tests/` | 81 tests, 81 passed, 0 failed |
| Links and assets: every local `href`/`src`, every JS module import, no resource from another host, canonical, complete and reciprocal `hreflang` (4 languages + x-default), sitemap = existing pages, `robots.txt`, `.nojekyll` | `python3 tools/check_site.py` | 52 pages + 404, 942 links/assets, 0 problems |
| Headless Chrome on every page (see below) | `node tests/smoke.mjs --large` | 88 checks, 88 passed, 0 failed |

An independent review of the first version (two fresh-context reviewers, one
comparing with libxml2 and expat) found 16 code defects and several inexact
texts. All were fixed, except that entities whose replacement text contains
markup remain unsupported (now reported as "not checked"). Every fix has a
regression test except two page-interaction fixes (a second file chosen while
the first is still being read; stale output after Cancel), which were checked
only by reading the code.

### Node tests (81)

- **XML parser** (`tests/xml.test.mjs`): 14 well-formed documents (prolog,
  comments, PIs, DOCTYPE with internal subset, default and prefixed
  namespaces, character references, CDATA, non-Latin names) and 41 malformed
  ones, each with the expected error code, line and column; 14 more malformed
  DTD and namespace cases that libxml2 and expat reject; CRLF/CR line counting;
  columns with characters outside the BMP; internal entities, self-reference,
  external entities (never loaded; left unexpanded in content, an error in
  attributes), entities from an unread external DTD (XHTML `&nbsp;`), and two
  "billion laughs" variants, stopped at 1,000,000 characters or 100,000
  references.
- **Differential** (`tests/xmllint.test.mjs`): 1,500 mutated documents,
  well-formed or not: the parser agrees with libxml2 on every one (skipped,
  not passed, when xmllint is missing).
- **XML ↔ JSON mapping**: attributes, `#text`, repeated elements to arrays,
  consistent arrays, forced arrays, empty elements, CDATA, namespaces, mixed
  content, `xml:space="preserve"` (also no indentation added on the way back),
  no-break spaces kept, `__proto__` names kept as data, BOM, non-Latin text;
  JSON → XML root rules, attributes, `null`, nested arrays, escaping, renamed
  keys, renamed attributes that would collide, empty namespace declarations,
  undeclared prefixes, unsafe integers.
- **Round trips**: XML → JSON → XML for 11 documents at indent 0 and 2 (output
  re-parsed, structure equal); JSON → XML → JSON; CSV → JSON → CSV (byte-equal),
  including empty values; JSON → CSV → JSON with nesting; JSON → Excel → JSON;
  XML → Excel → XML; CSV → Excel → JSON.
- **JSON errors**: 21 malformed inputs with code, line and column; JSON Lines;
  BOM; empty input.
- **CSV**: delimiter detection (7 cases), quotes, delimiters and line breaks in
  fields, CRLF/LF/CR, empty lines vs. a line with `""`, unclosed quote (line
  number), text after a closing quote, header de-duplication, writing and
  re-reading with `,` `;` tab, no thousands-separator guessing, a key with a
  dot that clashes with a nested key (warning).
- **Encodings**: UTF-8 BOM, UTF-16 LE/BE with BOM, UTF-16 LE without BOM
  (CSV), declared ISO-8859-1, invalid UTF-8 in XML (line of the first bad
  byte), Windows-1252 fallback for CSV, unknown declared encoding.
- **Excel**: ISO date ↔ serial including the 1900 leap-year quirk (checked
  against SheetJS's own formatter), the 1904 date system, times and `[h]`
  durations by number format in both systems, number detection (leading
  zeros, `+`, more than 15 digits stay text; decimal comma), multiple and
  hidden sheets, dates, text numbers, error cells, duplicate and empty
  headers, `.xls`, `.ods`, `.xlsb` input, non-workbook input, password-protected
  (an MS-OFFCRYPTO container built with SheetJS CFB), damaged ZIP, cell text
  over 32,767 characters (cut without splitting a character), more than
  1,048,576 rows.
- **Independent reader**: the `.xlsx` files of all three Excel tools are read
  with openpyxl (no shared code with SheetJS): values, real date cells,
  AutoFilter, column widths (skipped, not passed, when openpyxl is missing).

### Browser smoke test (88 checks)

Local server for `docs/` under `/klarto-convert/`, Chrome driven through the
DevTools protocol; the page and its Web Worker are both monitored. On each of
the 52 pages: loads without console errors, CSP violations or exceptions, makes
no request to another host, and has no horizontal scrolling at 375 px width.

- Every tool page in every language (40): "Try a sample" gives the expected
  output; downloads are opened and checked (`.xlsx` with SheetJS in Node).
- Every English tool page (10): a fixture file through the file input
  (UTF-8 with BOM, non-Latin text, `;` CSV with decimal comma, `.xlsx`, and an
  `.xls` file that makes the worker load the code page tables); the download
  is checked. A `fetch` run inside the page and inside the worker is blocked
  by the Content Security Policy.
- Error messages (24): broken XML or JSON pasted on every XML/JSON tool page in
  all four languages shows the localized message with the right line and column.
- Excel to XML: switching to the second sheet re-converts.
- The file input can receive keyboard focus.

## Tested limits

Node.js (`tests/large.test.mjs`; input generated in memory). Times are the
range over six runs; peak memory is the maximum resident size of the Node
process, measured once per case with `/usr/bin/time`.

| Conversion | Input | Output | Time | Peak memory |
|---|---|---|---|---|
| CSV → JSON | 50 MB, 611,452 rows | 102.5 MB JSON | 3.8–4.7 s | 1.2 GB |
| CSV → Excel | 50 MB, 611,452 rows | 53.1 MB .xlsx | 23.7–27.6 s | 2.7 GB |
| XML validator | 20 MB, 102,973 records | – | 0.7–1.3 s | (with XML → JSON) |
| XML → JSON | 20 MB, 102,973 records | 40.2 MB JSON | 1.4–2.0 s | 0.5 GB |
| XML → Excel | 20 MB, 102,973 records | 12.0 MB .xlsx | 5.5–7.3 s | 1.0 GB |

In the page (headless Chrome, `node tests/smoke.mjs --large`, file chosen
through the file input, conversion in the Web Worker), five runs:

| Conversion | Input | Result | Time |
|---|---|---|---|
| CSV → JSON | 50 MB, 733,929 rows | 113 MB JSON, progress percentage shown | 5.7–6.7 s |
| XML → Excel | 20 MB, 123,223 records | .xlsx with all 123,223 rows | 5.6–7.6 s |

Fixed limits enforced with a clear message: an Excel sheet holds at most
1,048,576 rows and 16,384 columns (refused with the counts); a cell holds at
most 32,767 characters (cut, with a warning naming the cell); entity expansion
stops at 1,000,000 characters or 100,000 references. SheetJS's own ZIP
compression makes `.xlsx` files larger than Excel would (53 MB for the 50 MB
CSV).

## Not tested

- Memory limits of real browsers, especially on phones and tablets. Only the
  Node peak memory above was measured; a mobile browser tab has far less memory.
- CSV → Excel with 50 MB in a browser (2.7 GB in Node); JSON → Excel, Excel →
  JSON and Excel → XML with large files.
- Firefox, Safari and Edge, and real (non-headless) desktop or mobile browsers.
  Only headless Google Chrome 157 was used. That a `blob:` module worker
  inherits the page's Content Security Policy was checked in Chrome only.
- Opening the generated `.xlsx` files in Microsoft Excel, LibreOffice Calc,
  Google Sheets or Numbers. They were only re-read with SheetJS and openpyxl
  (LibreOffice Calc is not installed on the test machine).
- Workbooks created by Excel itself, LibreOffice or Google Sheets as input
  (the test workbooks were written with SheetJS), including real
  password-protected files and `.xls` files with legacy code pages.
- Drag and drop (the file input and paste were tested), screen readers, and
  keyboard use beyond focusing the file input.
- Serving by GitHub Pages itself (MIME types, caching, the 404 page); only a
  local Node server was used.
- Validation against a DTD or an XML Schema: not supported by design. Entities
  whose replacement text contains markup are not supported; the validator
  reports such documents as "not checked".
