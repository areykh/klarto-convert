#!/usr/bin/env python3
"""Build redirect pages for the old GitHub Pages address
https://areykh.github.io/klarto-convert/<path> -> https://kadben.com/<path>.

Usage: python3 make_redirects.py SITE_DOCS_DIR OUT_DIR
Every <path>/index.html of the built site gets a small page with an instant
meta refresh, rel=canonical and a script that keeps ?query and #hash.
404.html (make_404.py) sends any other old address to the most relevant page.
"""
import html, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_404  # noqa: E402

NEW = 'https://kadben.com/'

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Moved to kadben.com</title>
<link rel="canonical" href="{url}">
<meta http-equiv="refresh" content="0; url={url}">
<script>location.replace({js} + location.search + location.hash);</script>
</head><body><p>This page has moved to <a href="{url}">{url}</a>.</p></body></html>
"""

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
    make_404.build(out)
    open(os.path.join(out, '.nojekyll'), 'w').close()
    print(f'{n} redirect pages + 404.html in {out}')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
