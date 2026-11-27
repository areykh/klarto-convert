# klarto-convert (moved)

Klarto Convert is now **Kadben Convert** at <https://kadben.com/>.

This repository only keeps the old GitHub Pages address
`https://areykh.github.io/klarto-convert/` working: every old page redirects
to the same page on kadben.com (instant meta refresh, `rel=canonical`, and a
script that keeps the query and hash). `404.html` sends any other old address
to the same path on kadben.com.

Rebuild after the site gets new pages:

    python3 make_redirects.py ../tool-site-converters/docs docs
