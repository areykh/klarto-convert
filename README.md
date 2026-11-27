# klarto-convert (moved)

Klarto Convert is now **Kadben Convert** at <https://kadben.com/>.

This repository only keeps the old GitHub Pages address
`https://areykh.github.io/klarto-convert/` working: every old page redirects
to the same page on kadben.com (instant meta refresh, `rel=canonical`, and a
script that keeps the query and hash). `404.html` (`make_404.py`) catches every
other old address: the same page written another way (capitals, `/index.html`,
double slashes) goes to its target with the query and hash; anything else goes
to the nearest old page above it (`/uk/no-such-page/` -> the Ukrainian start
page), or to the kadben.com start page.

Rebuild after the site gets new pages:

    python3 make_redirects.py ../tool-site-converters/docs docs
    node --test test_404.mjs
