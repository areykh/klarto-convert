#!/usr/bin/env python3
"""Build redirect pages for the old GitHub Pages address
https://areykh.github.io/klarto-convert/<path> -> https://kadben.com/<path>.

Usage: python3 make_redirects.py SITE_DOCS_DIR OUT_DIR
Every <path>/index.html of the built site gets a small page with an instant
meta refresh, rel=canonical and a script that keeps ?query and #hash.
404.html sends any other old address to the same path on kadben.com.
"""
import html, os, sys

NEW = 'https://kadben.com/'
OLD_PREFIX = '/klarto-convert/'

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
</head><body><p>Klarto Convert is now <a href="%s">Kadben Convert at kadben.com</a>.</p></body></html>
""" % (OLD_PREFIX, len(OLD_PREFIX), NEW, NEW)

def main(src, out):
    n = 0
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d != 'assets']
        if 'index.html' not in files:
            continue
        rel = os.path.relpath(root, src)
        rel = '' if rel == '.' else rel.replace(os.sep, '/') + '/'
        url = NEW + rel
        os.makedirs(os.path.join(out, rel), exist_ok=True)
        with open(os.path.join(out, rel, 'index.html'), 'w', encoding='utf-8') as f:
            f.write(PAGE.format(url=html.escape(url, quote=True), js=repr(url)))
        n += 1
    with open(os.path.join(out, '404.html'), 'w', encoding='utf-8') as f:
        f.write(NOT_FOUND)
    open(os.path.join(out, '.nojekyll'), 'w').close()
    print(f'{n} redirect pages + 404.html in {out}')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
