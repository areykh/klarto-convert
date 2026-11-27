# klarto-convert (moved)

Klarto Convert is now **Kadben Tools** at <https://kadben.com/tools/>.

This repository only keeps the old GitHub Pages address
`https://areykh.github.io/klarto-convert/` working. Each of the 363 pages it
served (`old-paths.txt`: 262 site pages and 101 old addresses in the page
language, as of 2026-11-27) is a small page that sends the visitor to its
**final** address on kadben.com (instant meta refresh, `rel=canonical`, and a
script that keeps the query and hash). The targets come from the site's one
redirect table, `_redirects` in the built site (the tools moved to
`/tools/<slug>/` and `/<lang>/tools/<slug>/` on 2026-11-27); the start pages,
privacy and licences keep their path. `404.html` sends any other old address
to the same path on kadben.com.

Rebuild and test after the site's redirect table changes:

    python3 make_redirects.py ../tool-site-converters/docs docs
    SITE_DOCS=../tool-site-converters/docs python3 test_make_redirects.py
