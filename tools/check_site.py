#!/usr/bin/env python3
"""Check the generated site in docs/ without a browser.

- every local href/src (pages, CSS, scripts, images) points to an existing file;
- every JS module import (static and dynamic) resolves to an existing file;
- no page loads anything from another host; external links only to allowed hosts;
- each page: one <h1>, a unique <title> and meta description, a canonical URL
  pointing to itself, and a complete, reciprocal set of hreflang links
  (all languages + x-default);
- sitemap.xml lists exactly the pages that exist; robots.txt names the sitemap.

Usage: python3 tools/check_site.py [docs-dir]
"""
import json
import os
import re
import sys
from html.parser import HTMLParser
from urllib.parse import urlparse, urljoin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOWED_LINK_HOSTS = {'github.com', 'docs.github.com'}


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.refs = []        # (tag, attr, value)
        self.alternates = {}  # hreflang -> href
        self.canonical = None
        self.h1 = 0
        self.title = ''
        self._in_title = False
        self.description = None
        self.ids = set()
        self.lang = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if 'id' in a:
            self.ids.add(a['id'])
        if tag == 'html':
            self.lang = a.get('lang')
        if tag == 'h1':
            self.h1 += 1
        if tag == 'title':
            self._in_title = True
        if tag == 'meta' and a.get('name') == 'description':
            self.description = a.get('content')
        if tag == 'link':
            if a.get('rel') == 'canonical':
                self.canonical = a.get('href')
            elif a.get('rel') == 'alternate' and a.get('hreflang'):
                self.alternates[a['hreflang']] = a.get('href')
            elif a.get('href'):
                self.refs.append((tag, 'href', a['href']))
        elif tag == 'a' and a.get('href'):
            self.refs.append((tag, 'href', a['href']))
        elif tag in ('script', 'img', 'source', 'iframe') and a.get('src'):
            self.refs.append((tag, 'src', a['src']))

    def handle_endtag(self, tag):
        if tag == 'title':
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def main():
    docs = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs'))
    cfg = json.load(open(os.path.join(ROOT, 'src', 'site.json'), encoding='utf-8'))
    base = cfg['base_url']
    base_path = urlparse(base).path
    problems = []
    pages = {}
    for root, _, files in os.walk(docs):
        for fn in files:
            # Google Search Console verification files are plain text, not site pages (2026-11-21)
            if re.fullmatch(r'google[0-9a-f]{16}\.html', fn):
                continue
            if fn.endswith('.html'):
                p = os.path.join(root, fn)
                parser = Page()
                with open(p, encoding='utf-8') as f:
                    parser.feed(f.read())
                pages[os.path.relpath(p, docs)] = parser

    def resolve(page_rel, url):
        """Local file for a URL used on a page, or None if external."""
        u = urlparse(url)
        if u.scheme in ('http', 'https'):
            if url.startswith(base):
                return os.path.join(docs, url[len(base):])
            return None
        if u.scheme:
            return None
        if url.startswith('/'):
            if not url.startswith(base_path):
                return '__outside__'
            return os.path.join(docs, url[len(base_path):].split('#')[0].split('?')[0])
        path = url.split('#')[0].split('?')[0]
        return os.path.normpath(os.path.join(docs, os.path.dirname(page_rel), path))

    def exists(target):
        if target.endswith(os.sep) or os.path.isdir(target):
            return os.path.isfile(os.path.join(target, 'index.html'))
        return os.path.isfile(target)

    titles, descs = {}, {}
    real_pages = {k: v for k, v in pages.items() if k != '404.html'}
    for rel_path, pg in sorted(pages.items()):
        for tag, attr, url in pg.refs:
            if url.startswith('#'):
                if url[1:] and url[1:] not in pg.ids:
                    problems.append(f'{rel_path}: anchor {url} not found')
                continue
            target = resolve(rel_path, url)
            if target is None:
                host = urlparse(url).hostname or ''
                if tag != 'a':
                    problems.append(f'{rel_path}: <{tag} {attr}> loads from another host: {url}')
                elif host not in ALLOWED_LINK_HOSTS:
                    problems.append(f'{rel_path}: link to a host that is not allowed: {url}')
                continue
            if target == '__outside__':
                problems.append(f'{rel_path}: absolute path outside the site: {url}')
                continue
            if not exists(target):
                problems.append(f'{rel_path}: broken {attr} {url}')
            if '#' in url:
                frag = url.split('#', 1)[1]
                tp = target if target.endswith('.html') else os.path.join(target, 'index.html')
                tr = os.path.relpath(tp, docs)
                if frag and tr in pages and frag not in pages[tr].ids:
                    problems.append(f'{rel_path}: anchor {url} not found in {tr}')
        if rel_path == '404.html':
            continue
        if pg.h1 != 1:
            problems.append(f'{rel_path}: {pg.h1} <h1>')
        if not pg.title.strip():
            problems.append(f'{rel_path}: empty <title>')
        if pg.title in titles:
            problems.append(f'{rel_path}: same <title> as {titles[pg.title]}')
        titles[pg.title] = rel_path
        if not pg.description:
            problems.append(f'{rel_path}: no meta description')
        elif pg.description in descs:
            problems.append(f'{rel_path}: same description as {descs[pg.description]}')
        descs[pg.description] = rel_path
        own_url = base + (rel_path[:-len('index.html')] if rel_path.endswith('index.html') else rel_path)
        if pg.canonical != own_url:
            problems.append(f'{rel_path}: canonical {pg.canonical} is not {own_url}')
        langs = set(cfg['languages']) | {'x-default'}
        if set(pg.alternates) != langs:
            problems.append(f'{rel_path}: hreflang set {sorted(pg.alternates)} is not {sorted(langs)}')
        if pg.alternates.get(pg.lang) != own_url:
            problems.append(f'{rel_path}: hreflang for its own language {pg.lang} does not point to itself')
        if pg.alternates.get('x-default') != pg.alternates.get(cfg['default_language']):
            problems.append(f'{rel_path}: x-default differs from the {cfg["default_language"]} page')
        for lang, href in pg.alternates.items():
            target = resolve(rel_path, href)
            if not target or not exists(target):
                problems.append(f'{rel_path}: hreflang {lang} points to a missing page {href}')
                continue
            other = os.path.relpath(target if target.endswith('.html') else os.path.join(target, 'index.html'), docs)
            if other in pages and pages[other].alternates.get(pg.lang) != own_url:
                problems.append(f'{rel_path}: {other} does not link back with hreflang {pg.lang}')

    # JS module imports
    for root, _, files in os.walk(docs):
        for fn in files:
            if not fn.endswith('.js'):
                continue
            p = os.path.join(root, fn)
            with open(p, encoding='utf-8') as f:
                src = f.read()
            if 'vendor' + os.sep in p:
                continue
            specs = re.findall(r"""^\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]""", src, re.M)
            specs += re.findall(r"""import\(\s*['"]([^'"]+)['"]\s*\)""", src)
            specs += re.findall(r"""new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url""", src)
            m = re.search(r"const VENDOR = '([^']+)'", src)
            if m:
                specs += [m.group(1) + x for x in re.findall(r"import\(VENDOR \+ '([^']+)'\)", src)]
            for s in specs:
                if not s.startswith('.'):
                    problems.append(f'{os.path.relpath(p, docs)}: import of a non-local module {s}')
                    continue
                t = os.path.normpath(os.path.join(os.path.dirname(p), s))
                if not os.path.isfile(t):
                    problems.append(f'{os.path.relpath(p, docs)}: import {s} does not resolve')

    # sitemap and robots
    try:
        sm = open(os.path.join(docs, 'sitemap.xml'), encoding='utf-8').read()
        locs = set(re.findall(r'<loc>([^<]+)</loc>', sm))
        expected = {base + (k[:-len('index.html')] if k.endswith('index.html') else k) for k in real_pages}
        for u in sorted(expected - locs):
            problems.append(f'sitemap.xml: missing {u}')
        for u in sorted(locs - expected):
            problems.append(f'sitemap.xml: lists a page that does not exist: {u}')
    except FileNotFoundError:
        problems.append('sitemap.xml missing')
    try:
        rb = open(os.path.join(docs, 'robots.txt'), encoding='utf-8').read()
        if f'Sitemap: {base}sitemap.xml' not in rb:
            problems.append('robots.txt does not name the sitemap')
    except FileNotFoundError:
        problems.append('robots.txt missing')
    if not os.path.isfile(os.path.join(docs, '.nojekyll')):
        problems.append('.nojekyll missing')

    for p in problems:
        print('FAIL', p)
    n_refs = sum(len(p.refs) for p in pages.values())
    print(f'check_site: {len(real_pages)} pages + 404, {n_refs} links/assets checked, {len(problems)} problems')
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
