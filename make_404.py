#!/usr/bin/env python3
"""Write OUT_DIR/404.html for the old GitHub Pages address.

Usage: python3 make_404.py OUT_DIR

GitHub Pages serves 404.html for every address under /klarto-convert/ that
has no file. The page sends the visitor to the most relevant kadben.com page:
1. the same old page written another way (capital letters, /index.html,
   double slashes, a missing final slash): its own target, with ?query and #hash;
2. otherwise the nearest old page above it (/uk/no-such-page/ -> the Ukrainian
   start page, /xml-to-json/old.html -> the XML to JSON tool);
3. otherwise the kadben.com start page.

The old page -> target map is read from the redirect pages already in OUT_DIR
(their meta refresh), so 404.html always agrees with them. Without JavaScript
the page falls back to the start page (meta refresh inside <noscript>, so it
can never race the script's own redirect).
"""
import json
import os
import re
import sys

HOME = 'https://kadben.com/'
REFRESH = re.compile(r'<meta http-equiv="refresh" content="0; url=([^"]+)">')

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex">
<title>Moved to kadben.com</title>
<script>
(function () {
  var MAP = %(map)s;
  var p = location.pathname;
  try { p = decodeURIComponent(p); } catch (e) {}
  p = p.toLowerCase().replace(/\\/{2,}/g, '/');
  if (p.indexOf('/klarto-convert/') === 0) p = p.slice(15);
  p = p.replace(/\\/index\\.html?$/, '/');
  if (p.charAt(p.length - 1) !== '/') p += '/';
  if (MAP[p]) { location.replace(MAP[p] + location.search + location.hash); return; }
  var parts = p.split('/').filter(Boolean);
  while (parts.length) {
    parts.pop();
    var up = '/' + parts.join('/') + (parts.length ? '/' : '');
    if (MAP[up]) { location.replace(MAP[up]); return; }
  }
  location.replace(%(home)s);
})();
</script>
<noscript><meta http-equiv="refresh" content="0; url=%(home_attr)s"></noscript>
</head><body><p>Klarto Convert has moved to <a href="%(home_attr)s">kadben.com</a>.</p></body></html>
"""


def read_map(out):
    """'/old/path/' (lower case) -> absolute kadben.com URL, from OUT_DIR/**/index.html."""
    found = {}
    for root, _dirs, files in os.walk(out):
        if 'index.html' not in files:
            continue
        rel = os.path.relpath(root, out).replace(os.sep, '/')
        old = '/' if rel == '.' else '/' + rel + '/'
        with open(os.path.join(root, 'index.html'), encoding='utf-8') as f:
            m = REFRESH.search(f.read())
        if not m:
            raise SystemExit(f'{old}: no meta refresh in its redirect page')
        url = m.group(1).replace('&amp;', '&')
        if not url.startswith(HOME):
            raise SystemExit(f'{old}: target {url} is not on kadben.com')
        key = old.lower()
        if key in found and found[key] != url:
            raise SystemExit(f'{old}: two old pages differ only in case and go to different places')
        found[key] = url
    if '/' not in found:
        raise SystemExit('no redirect page for the old start page')
    return found


def build(out):
    pages = read_map(out)
    text = PAGE % {
        'map': json.dumps(dict(sorted(pages.items())), ensure_ascii=False, separators=(',', ':')),
        'home': json.dumps(HOME),
        'home_attr': HOME,
    }
    with open(os.path.join(out, '404.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    return len(pages)


if __name__ == '__main__':
    n = build(sys.argv[1])
    print(f'404.html: {n} old pages mapped in {sys.argv[1]}')
