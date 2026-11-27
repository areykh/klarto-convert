#!/usr/bin/env python3
"""Tests for make_redirects.py against a built kadben.com site.

    SITE_DOCS=../tool-site-converters/docs python3 test_make_redirects.py

- every one of the 363 old addresses (old-paths.txt) gets a page;
- its refresh, canonical link and script all name one kadben.com address,
  which is a page of the site and not a source in its _redirects (no chain);
- the pages that stayed (start pages, privacy, licences: 15) keep their path,
  the old tool pages go to /tools/ of their language, the 101 old addresses
  in the page language to the same final page as the site's own redirect;
- the committed docs/ is what make_redirects.py builds now.
Standard library only.
"""
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_redirects as mr  # noqa: E402

SITE_DOCS = os.path.abspath(os.environ.get('SITE_DOCS', os.path.join(HERE, '..', 'tool-site-converters', 'docs')))
LANGS = ('uk/', 'de/', 'fr/', 'es/')


def stub_targets(text):
    refresh = re.search(r'<meta http-equiv="refresh" content="0; url=([^"]+)">', text)
    canonical = re.search(r'<link rel="canonical" href="([^"]+)">', text)
    script = re.search(r"location\.replace\('([^']+)' \+ location\.search \+ location\.hash\)", text)
    return [m.group(1) if m else None for m in (refresh, canonical, script)]


class StubTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='kadben-stubs-')
        cls.out = os.path.join(cls.tmp.name, 'docs')
        mr.main(SITE_DOCS, cls.out)
        cls.table = mr.read_table(SITE_DOCS)
        cls.old = mr.old_paths()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_363_old_addresses(self):
        self.assertEqual(len(self.old), 363)
        self.assertEqual(len(set(self.old)), 363)
        n = sum(1 for _, _, files in os.walk(self.out) if 'index.html' in files)
        self.assertEqual(n, 363)

    def test_every_stub_points_to_a_final_page(self):
        def split(p):  # '/uk/xml-to-json/' -> ('/uk/', 'xml-to-json/')
            for lang in LANGS:
                if p.startswith('/' + lang):
                    return '/' + lang, p[len(lang) + 1:]
            return '/', p[1:]
        kinds = {'stayed': 0, 'tool': 0, 'old slug': 0}
        for old in self.old:
            with self.subTest(old=old):
                path = os.path.join(self.out, old.strip('/'), 'index.html')
                self.assertTrue(os.path.isfile(path), 'no stub')
                urls = stub_targets(open(path, encoding='utf-8').read())
                self.assertEqual(len(set(urls)), 1, urls)
                url = urls[0]
                self.assertTrue(url.startswith(mr.NEW), url)
                new = '/' + url[len(mr.NEW):]
                self.assertTrue(mr.is_page(SITE_DOCS, new), f'{new} is not a page of the site')
                self.assertNotIn(new, self.table, f'{new} is redirected again (a chain)')
                self.assertEqual(new, self.table.get(old, old), "not the site's own target")
                prefix, rest = split(old)
                self.assertTrue(new.startswith(prefix), 'another language')
                kind = 'stayed' if new == old else 'tool' if new == prefix + 'tools/' + rest else 'old slug'
                kinds[kind] += 1
        # start pages, privacy and licences in 5 languages; the tool pages of
        # 2026-11-27 (49 tools in 5 languages, Rozetka in 2); old slugs
        self.assertEqual(kinds, {'stayed': 15, 'tool': 247, 'old slug': 101})

    def test_committed_docs_are_current(self):
        committed = os.path.join(HERE, 'docs')
        for root, _, files in os.walk(self.out):
            for fn in files:
                p = os.path.join(root, fn)
                rel = os.path.relpath(p, self.out)
                with self.subTest(file=rel):
                    q = os.path.join(committed, rel)
                    self.assertTrue(os.path.isfile(q), 'missing in docs/: run make_redirects.py')
                    self.assertEqual(open(p, 'rb').read(), open(q, 'rb').read(), 'docs/ is out of date: run make_redirects.py')
        built = {os.path.relpath(os.path.join(r, f), self.out) for r, _, fs in os.walk(self.out) for f in fs}
        have = {os.path.relpath(os.path.join(r, f), committed) for r, _, fs in os.walk(committed) for f in fs}
        self.assertEqual(sorted(have - built), [], 'extra files in docs/')


if __name__ == '__main__':
    unittest.main(verbosity=1)
