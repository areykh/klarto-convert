#!/usr/bin/env python3
"""Build redirect pages for the old GitHub Pages address
https://areykh.github.io/klarto-convert/<path> -> the final address on https://kadben.com/.

Usage: python3 make_redirects.py SITE_DOCS_DIR OUT_DIR

old-paths.txt lists every page GitHub Pages served here on 2026-11-27: 262
site pages and 101 old addresses in the page language, 363 in all. Each gets
a small page (instant meta refresh, rel=canonical and a script that keeps
?query and #hash) that points to its FINAL address on kadben.com, taken from
the site's one redirect table, SITE_DOCS_DIR/_redirects (written by the
site's build.py; the pages are not found by walking the site, whose tools
moved to /tools/ on 2026-11-27):
- an address in the table goes to the table's target;
- an address that is still a page there (the start pages, privacy, licences)
  goes to the same path.
The script stops if an old address has neither, or if a target is not a
page of the site or is itself redirected (a chain). OUT_DIR is replaced.
404.html sends any other old address to the same path on kadben.com.
"""
import html
import os
import shutil
import sys

NEW = 'https://kadben.com/'
OLD_PREFIX = '/klarto-convert/'
HERE = os.path.dirname(os.path.abspath(__file__))

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Moved to kadben.com</title>
<link rel="canonical" href="{url}">
<meta http-equiv="refresh" content="0; url={url}">
<script>location.replace({js} + location.search + location.hash);</script>
</head><body><p>This page has moved to <a href="{url}">{url}</a>.</p></body></html>
"""

NOT_FOUND = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Moved to kadben.com</title>
<script>
var p = location.pathname;
if (p.indexOf('%s') === 0) p = p.slice(%d);
else p = p.replace(/^\\//, '');
location.replace('%s' + p + location.search + location.hash);
</script>
</head><body><p>Klarto Convert is now <a href="%s">Kadben Tools at kadben.com</a>.</p></body></html>
""" % (OLD_PREFIX, len(OLD_PREFIX), NEW, NEW)


def old_paths():
    with open(os.path.join(HERE, 'old-paths.txt'), encoding='utf-8') as f:
        return [line.strip() for line in f if line.strip()]


def read_table(site_docs):
    """_redirects: '/old/ /new/ 301' lines; comments and blank lines skipped."""
    table = {}
    with open(os.path.join(site_docs, '_redirects'), encoding='utf-8') as f:
        for line in f:
            if not line.strip() or line.startswith('#'):
                continue
            old, new, code = line.split()
            if code != '301':
                raise SystemExit(f'_redirects: not a 301: {line.strip()}')
            table[old] = new
    return table


def is_page(site_docs, path):
    return os.path.isfile(os.path.join(site_docs, path.lstrip('/'), 'index.html'))


def targets(site_docs):
    """Old path -> final path on kadben.com, for every line of old-paths.txt."""
    table = read_table(site_docs)
    out = {}
    for old in old_paths():
        new = table.get(old)
        if new is None:
            if not is_page(site_docs, old):
                raise SystemExit(f'{old}: neither in _redirects nor a page of the site')
            new = old
        if not is_page(site_docs, new):
            raise SystemExit(f'{old} -> {new}: not a page of the site')
        if new in table:
            raise SystemExit(f'{old} -> {new} -> {table[new]}: a chain')
        out[old] = new
    return out


def main(site_docs, out):
    pages = targets(site_docs)
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    for old, new in sorted(pages.items()):
        url = NEW + new.lstrip('/')
        folder = os.path.join(out, old.strip('/'))
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, 'index.html'), 'w', encoding='utf-8', newline='\n') as f:
            f.write(PAGE.format(url=html.escape(url, quote=True), js=repr(url)))
    with open(os.path.join(out, '404.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(NOT_FOUND)
    open(os.path.join(out, '.nojekyll'), 'w').close()
    moved = sum(1 for o, n in pages.items() if o != n)
    print(f'{len(pages)} redirect pages ({moved} to a new address, {len(pages) - moved} to the same path) + 404.html in {out}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
