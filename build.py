#!/usr/bin/env python3
"""Build the static site from src/ into docs/ (served by GitHub Pages).

    python3 build.py                 build into docs/
    python3 build.py --check         build into a temp folder, check the text
                                     files and the generated HTML, and fail if
                                     docs/ is not up to date
    python3 build.py --base-url URL  use another public base URL

Only the Python standard library is used.
"""
import argparse
import hashlib
import html
import json
import os
import re
import shutil
import sys
import tempfile
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src')
DOCS = os.path.join(ROOT, 'docs')
PLACEHOLDER_RE = re.compile(r'\{(\w+)\}')
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
       "worker-src 'self' blob:; connect-src 'none'; font-src 'self'; form-action 'none'; base-uri 'none'")
SHEETJS_VERSION = '0.20.3'
GITHUB_PRIVACY = 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement'
# GitHub Pages may not serve .mjs with a JavaScript MIME type; module scripts
# need one, so the vendored ES modules are published with a .js extension.
VENDOR_RENAME = {'xlsx.mjs': 'xlsx.js', 'cpexcel.full.mjs': 'cpexcel.full.js'}


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def esc(s):
    return html.escape(str(s), quote=True)


def inline(s):
    """Escape text; `code` spans become <code>."""
    parts = str(s).split('`')
    out = []
    for i, p in enumerate(parts):
        out.append('<code>' + esc(p) + '</code>' if i % 2 else esc(p))
    return ''.join(out)


def fill(template, **params):
    return PLACEHOLDER_RE.sub(lambda m: str(params.get(m.group(1), m.group(0))), template)


# ------------------------------------------------------------------ checks

def compare_structure(ref, other, path, problems, lang):
    if isinstance(ref, dict):
        if not isinstance(other, dict):
            problems.append(f'{lang}: {path} should be an object')
            return
        for k in ref:
            if k not in other:
                problems.append(f'{lang}: missing key {path}.{k}')
            else:
                compare_structure(ref[k], other[k], f'{path}.{k}', problems, lang)
        for k in other:
            if k not in ref:
                problems.append(f'{lang}: extra key {path}.{k}')
    elif isinstance(ref, list):
        if not isinstance(other, list):
            problems.append(f'{lang}: {path} should be a list')
            return
        if path.endswith('.sections') or path.endswith('.why') or '.rules.' in path:
            if len(ref) != len(other):
                problems.append(f'{lang}: {path} has {len(other)} items, en has {len(ref)}')
        for i, item in enumerate(other):
            if i < len(ref):
                compare_structure(ref[i] if len(ref) == len(other) else ref[0], item, f'{path}[{i}]', problems, lang)
    elif isinstance(ref, str):
        if not isinstance(other, str):
            problems.append(f'{lang}: {path} should be text')
            return
        if other.strip() == '':
            problems.append(f'{lang}: {path} is empty')
        if set(PLACEHOLDER_RE.findall(ref)) != set(PLACEHOLDER_RE.findall(other)):
            problems.append(f'{lang}: {path} placeholders {sorted(set(PLACEHOLDER_RE.findall(other)))} differ from en {sorted(set(PLACEHOLDER_RE.findall(ref)))}')
        if ref.count('`') != other.count('`') and not path.endswith(('.q', '.a')):
            problems.append(f'{lang}: {path} has a different number of `code` marks than en')


def check_texts(site, texts):
    problems = []
    en = texts['en']
    tool_ids = [t['id'] for t in site['tools']]
    for lang, t in texts.items():
        if lang != 'en':
            compare_structure(en, t, lang, problems, lang)
        for tid in tool_ids:
            tt = t['tools'].get(tid)
            if not tt:
                problems.append(f'{lang}: tool {tid} missing')
                continue
            if not 3 <= len(tt['steps']) <= 5:
                problems.append(f'{lang}: {tid} has {len(tt["steps"])} steps (3-5 required)')
            if not 3 <= len(tt['faq']) <= 5:
                problems.append(f'{lang}: {tid} has {len(tt["faq"])} FAQ entries (3-5 required)')
            if len(tt['title']) > 70:
                problems.append(f'{lang}: {tid} title is {len(tt["title"])} characters (max 70)')
            if not 70 <= len(tt['description']) <= 170:
                problems.append(f'{lang}: {tid} description is {len(tt["description"])} characters (70-170)')
            if not re.fullmatch(r'[a-z0-9-]+', tt['slug']):
                problems.append(f'{lang}: {tid} slug {tt["slug"]!r} is not lowercase ASCII')
        for name in ('privacy', 'licenses'):
            if not re.fullmatch(r'[a-z0-9-]+', t['pages'][name]['slug']):
                problems.append(f'{lang}: {name} slug is not lowercase ASCII')
        slugs = [t['tools'][i]['slug'] for i in tool_ids] + [t['pages']['privacy']['slug'], t['pages']['licenses']['slug']]
        if len(slugs) != len(set(slugs)):
            problems.append(f'{lang}: duplicate slugs')
        for opt in {o['name'] for tool in site['tools'] for o in tool['options']}:
            if opt not in t['ui']['opt']:
                problems.append(f'{lang}: label ui.opt.{opt} missing')
    # every error/warning/info code used in the JS has a message
    codes = set()
    for root, _, files in os.walk(os.path.join(SRC, 'js')):
        for fn in files:
            if fn.endswith('.js'):
                with open(os.path.join(root, fn), encoding='utf-8') as f:
                    src = f.read()
                codes |= set(re.findall(r"ConvertError\(\s*'([a-z0-9]+\.[A-Za-z0-9]+)'", src))
                codes |= set(re.findall(r"fail\(\s*'([a-z0-9]+\.[A-Za-z0-9]+)'", src))
                codes |= set(re.findall(r"code: '([a-z0-9]+\.[A-Za-z0-9]+)'", src))
                codes |= {'w:' + c for c in re.findall(r"warnings\.add\(\s*'([a-z0-9]+\.[A-Za-z0-9]+)'", src)}
                codes |= set(re.findall(r"'(general\.[A-Za-z]+)'", src))
                codes |= {'n:' + c for c in re.findall(r"notice: '([a-z0-9]+\.[A-Za-z0-9]+)'", src)}
    for lang, t in texts.items():
        for c in sorted(codes):
            if c.startswith('w:'):
                if c[2:] not in t['warnings']:
                    problems.append(f'{lang}: warning message {c[2:]} missing')
            elif c.startswith('n:'):
                if c[2:] not in t['info']:
                    problems.append(f'{lang}: info message {c[2:]} missing')
            elif c.startswith('info.'):
                if c not in t['info']:
                    problems.append(f'{lang}: info message {c} missing')
            elif c not in t['errors']:
                problems.append(f'{lang}: error message {c} missing')
    return problems


# ------------------------------------------------------------------ site model

class Site:
    def __init__(self, base_url):
        self.cfg = load_json(os.path.join(SRC, 'site.json'))
        self.base_url = (base_url or self.cfg['base_url']).rstrip('/') + '/'
        self.base_path = urlparse(self.base_url).path
        self.langs = self.cfg['languages']
        self.default = self.cfg['default_language']
        self.texts = {lang: load_json(os.path.join(SRC, 'i18n', lang + '.json')) for lang in self.langs}
        self.tools = self.cfg['tools']
        self.asset_hash = self.hash_assets()
        self.asset_dir = 'assets/' + self.asset_hash + '/'

    def hash_assets(self):
        h = hashlib.sha256()
        for sub in ('js', 'css', 'img', 'vendor'):
            base = os.path.join(SRC, sub)
            for root, _, files in sorted(os.walk(base)):
                for fn in sorted(files):
                    p = os.path.join(root, fn)
                    h.update(os.path.relpath(p, SRC).encode())
                    with open(p, 'rb') as f:
                        h.update(f.read())
        return h.hexdigest()[:10]

    def prefix(self, lang):
        return '' if lang == self.default else lang + '/'

    def path(self, lang, kind, tool=None):
        """Site-relative directory of a page, '' for the root."""
        t = self.texts[lang]
        if kind == 'home':
            return self.prefix(lang)
        if kind == 'tool':
            return self.prefix(lang) + t['tools'][tool]['slug'] + '/'
        return self.prefix(lang) + t['pages'][kind]['slug'] + '/'

    def pages(self):
        for lang in self.langs:
            yield lang, 'home', None
            for tool in self.tools:
                yield lang, 'tool', tool['id']
            yield lang, 'privacy', None
            yield lang, 'licenses', None


def rel(from_dir, to_path):
    """Relative URL from a page directory to a site path."""
    if to_path == '' or to_path.endswith('/'):
        r = os.path.relpath('/' + to_path, '/' + from_dir) if to_path else os.path.relpath('/', '/' + from_dir)
        r = r.replace(os.sep, '/')
        return './' if r == '.' else r + '/'
    return os.path.relpath('/' + to_path, '/' + from_dir).replace(os.sep, '/')


# ------------------------------------------------------------------ rendering

TEMPLATE_RE = re.compile(r'\{\{(\w+)\}\}')
_templates = {}


def render(name, **values):
    """Fill src/templates/<name>; every {{placeholder}} must get a value.
    Values are inserted as they are, so callers pass escaped HTML."""
    if name not in _templates:
        with open(os.path.join(SRC, 'templates', name), encoding='utf-8') as f:
            _templates[name] = f.read()

    def sub(m):
        if m.group(1) not in values:
            raise KeyError(f'{name}: no value for {{{{{m.group(1)}}}}}')
        return str(values[m.group(1)])
    return TEMPLATE_RE.sub(sub, _templates[name])


def page(site, lang, kind, tool, title, description, main, scripts=''):
    """A complete page: base.html with header, footer and hreflang links."""
    t = site.texts[lang]
    s = t['site']
    page_dir = site.path(lang, kind, tool)
    alts = [f'<link rel="alternate" hreflang="{other}" href="{esc(site.base_url + site.path(other, kind, tool))}">' for other in site.langs]
    alts.append(f'<link rel="alternate" hreflang="x-default" href="{esc(site.base_url + site.path(site.default, kind, tool))}">')
    verification = ''
    if kind == 'home' and lang == site.default and site.cfg.get('google_site_verification'):
        verification = f'\n<meta name="google-site-verification" content="{esc(site.cfg["google_site_verification"])}">'
    languages = ''
    for other in site.langs:
        cur = ' aria-current="page"' if other == lang else ''
        languages += f'<li><a href="{rel(page_dir, site.path(other, kind, tool))}" hreflang="{other}" lang="{other}"{cur}>{esc(site.texts[other]["langName"])}</a></li>'
    return render(
        'base.html', lang=lang, csp=CSP, title=esc(title), description=esc(description),
        canonical=esc(site.base_url + page_dir), alternates='\n'.join(alts),
        assets=rel(page_dir, site.asset_dir), verification=verification,
        skip=esc(s['skip']), home=rel(page_dir, site.path(lang, 'home')), site_name=esc(s['name']),
        all_tools=esc(s['allTools']), language_label=esc(s['languageLabel']), languages=languages,
        main=main.rstrip('\n'), footer_project=esc(fill(s['footerProject'], owner=site.cfg['owner'])),
        privacy_href=rel(page_dir, site.path(lang, 'privacy')), privacy=esc(s['privacy']),
        licenses_href=rel(page_dir, site.path(lang, 'licenses')), licenses=esc(s['licenses']),
        repo_url=esc(site.cfg['repo_url']), source=esc(s['source']), scripts=scripts)


def option_html(site, lang, opt):
    t = site.texts[lang]['ui']
    name = opt['name']
    label = esc(t['opt'][name])
    oid = 'opt-' + name
    if opt['type'] == 'checkbox':
        checked = ' checked' if opt['default'] else ''
        return f'<div class="opt opt-check"><input type="checkbox" id="{oid}" data-opt="{name}"{checked}><label for="{oid}">{label}</label></div>'
    if opt['type'] == 'text':
        ph = f' placeholder="{esc(opt["placeholder"])}"' if opt.get('placeholder') else ''
        return f'<div class="opt"><label for="{oid}">{label}</label><input type="text" id="{oid}" data-opt="{name}" value="{esc(opt["default"])}"{ph} spellcheck="false" autocomplete="off"></div>'
    if opt['type'] == 'select':
        default = opt['default']
        if isinstance(default, dict):
            default = default.get(lang, default['*'])
        vals = t['optValues'][name]
        options = ''.join(f'<option value="{esc(v)}"{" selected" if v == default else ""}>{esc(vals[v])}</option>' for v in opt['values'])
        return f'<div class="opt"><label for="{oid}">{label}</label><select id="{oid}" data-opt="{name}">{options}</select></div>'
    if opt['type'] == 'dynamic':
        first = f'<option value="auto">{esc(t["auto"])}</option>' if name == 'rows' else ''
        return f'<div class="opt opt-wide" id="wrap-{name}" hidden><label for="{oid}">{label}</label><select id="{oid}" data-opt="{name}">{first}</select></div>'
    raise ValueError(opt)


def faq_html(items):
    return ''.join(f'<h3>{inline(f["q"])}</h3>\n<p>{inline(f["a"])}</p>\n' for f in items)


def tool_page(site, lang, tool_id):
    t = site.texts[lang]
    tool = next(x for x in site.tools if x['id'] == tool_id)
    tt = t['tools'][tool_id]
    page_dir = site.path(lang, 'tool', tool_id)
    ui = t['ui']
    data = {
        'tool': tool_id, 'lang': lang, 'locale': t['locale'],
        'needsXlsx': tool['out'] == 'xlsx' or tool['in'] == 'excel',
        'sample': tool['sample'], 'outKind': tool['out'],
        'messages': {'ui': ui, 'errors': t['errors'], 'warnings': t['warnings'], 'info': t['info']},
    }
    data_json = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    buttons = f'<button type="button" id="sample" class="btn">{esc(ui["sample"])}</button><button type="button" id="clear" class="btn ghost">{esc(ui["clear"])}</button>'
    if tool['input'] == 'text':
        btn = ui['check'] if tool['out'] == 'report' else ui['convert']
        controls = (f'<label class="paste-label" for="paste">{esc(ui["pasteLabel"])}</label>\n'
                    '<textarea id="paste" rows="8" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>\n'
                    f'<div class="actions"><button type="button" id="convert" class="btn primary">{esc(btn)}</button>{buttons}</div>')
    else:
        controls = f'<div class="actions">{buttons}</div>'
    opts = ''
    if tool['options']:
        dyn = [o for o in tool['options'] if o['type'] == 'dynamic']
        rest = [o for o in tool['options'] if o['type'] != 'dynamic']
        opts = f'<fieldset class="options"><legend>{esc(ui["options"])}</legend>' + ''.join(option_html(site, lang, o) for o in dyn + rest) + '</fieldset>'
    rules = ''
    for key in tool['rules']:
        r = t['rules'][key]
        rules += f'<h3>{inline(r["title"])}</h3>\n<ul>' + ''.join(f'<li>{inline(i)}</li>' for i in r['items']) + '</ul>\n'
    main = render(
        'tool.html', h1=esc(tt['h1']), intro=inline(tt['intro']), local_note=esc(t['site']['localNote']),
        tool_heading=esc(ui['toolHeading']), accept=esc(site.cfg['accept'][tool['in']]),
        choose_file=esc(ui['chooseFile']), drop_hint=esc(ui['dropHint']), input_controls=controls,
        options=opts, cancel=esc(ui['cancel']), result=esc(ui['result']), copy=esc(ui['copy']),
        result_text=esc(ui['resultText']), how_to_heading=esc(t['sections']['howTo']),
        steps=''.join(f'<li>{inline(x)}</li>' for x in tt['steps']), rules_heading=esc(t['sections']['rules']),
        rules=rules, faq_heading=esc(t['sections']['faq']), faq=faq_html(tt['faq']),
        related_heading=esc(t['sections']['related']),
        related=''.join(f'<li><a href="{rel(page_dir, site.path(lang, "tool", rid))}">{esc(t["tools"][rid]["name"])}</a></li>' for rid in tool['related']))
    a = rel(page_dir, site.asset_dir)
    scripts = (f'<script type="application/json" id="page-data">{data_json}</script>\n'
               f'<script type="module" src="{a}js/app.js"></script>\n')
    return page(site, lang, 'tool', tool_id, tt['title'], tt['description'], main, scripts)


def home_page(site, lang):
    t = site.texts[lang]
    p = t['pages']['home']
    page_dir = site.path(lang, 'home')
    cards = ''.join(
        f'<li><a href="{rel(page_dir, site.path(lang, "tool", tool["id"]))}"><strong>{esc(t["tools"][tool["id"]]["name"])}</strong><span>{esc(t["tools"][tool["id"]]["short"])}</span></a></li>'
        for tool in site.tools)
    main = render('home.html', h1=esc(p['h1']), intro=inline(p['intro']), tools_heading=esc(p['toolsHeading']),
                  cards=cards, why_heading=esc(p['whyHeading']), why=''.join(f'<li>{inline(w)}</li>' for w in p['why']),
                  faq_heading=esc(t['sections']['faq']), faq=faq_html(p['faq']))
    return page(site, lang, 'home', None, p['title'], p['description'], main)


def privacy_page(site, lang):
    p = site.texts[lang]['pages']['privacy']
    body = ''
    for s in p['sections']:
        body += f'<h2>{esc(s["h"])}</h2>\n' + ''.join(f'<p>{inline(fill(x, owner=site.cfg["owner"]))}</p>\n' for x in s['p'])
    body += f'<p><a href="{GITHUB_PRIVACY}" rel="noopener">{esc(p["githubLink"])}</a></p>\n'
    return page(site, lang, 'privacy', None, p['title'], p['description'], render('text-page.html', h1=esc(p['h1']), body=body))


def licenses_page(site, lang):
    p = site.texts[lang]['pages']['licenses']
    page_dir = site.path(lang, 'licenses')
    with open(os.path.join(SRC, 'vendor', 'sheetjs-' + SHEETJS_VERSION, 'xlsx.mjs'), 'rb') as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    body = (f'<p>{inline(p["intro"])}</p>\n<p>{inline(p["own"])}</p>\n<h2>{esc(p["libHeading"])}</h2>\n'
            f'<p>{inline(fill(p["lib"], version=SHEETJS_VERSION, sha=sha))}</p>\n'
            f'<p><a href="{rel(page_dir, site.asset_dir)}vendor/sheetjs-{SHEETJS_VERSION}/LICENSE">{esc(p["licenseLink"])}</a></p>\n')
    return page(site, lang, 'licenses', None, p['title'], p['description'], render('text-page.html', h1=esc(p['h1']), body=body))


def not_found_page(site):
    t = site.texts[site.default]
    p = t['pages']['notFound']
    links = ''.join(f'<li><a href="{esc(site.base_path + site.path(l, "home"))}" lang="{l}">{esc(site.texts[l]["pages"]["home"]["h1"])}</a></li>' for l in site.langs)
    return render('404.html', lang=site.default, csp=CSP, title=esc(p['title']), assets=site.base_path + site.asset_dir,
                  h1=esc(p['h1']), text=esc(p['p']), links=links)


def build(out, site):
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)
    for sub in ('js', 'css', 'img', 'vendor'):
        shutil.copytree(os.path.join(SRC, sub), os.path.join(out, site.asset_dir, sub))
    vdir = os.path.join(out, site.asset_dir, 'vendor', 'sheetjs-' + SHEETJS_VERSION)
    for a, b in VENDOR_RENAME.items():
        os.replace(os.path.join(vdir, a), os.path.join(vdir, b))
    urls = []
    for lang, kind, tool in site.pages():
        page_dir = site.path(lang, kind, tool)
        if kind == 'home':
            doc = home_page(site, lang)
        elif kind == 'tool':
            doc = tool_page(site, lang, tool)
        elif kind == 'privacy':
            doc = privacy_page(site, lang)
        else:
            doc = licenses_page(site, lang)
        target = os.path.join(out, page_dir, 'index.html')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'w', encoding='utf-8', newline='\n') as f:
            f.write(doc)
        urls.append(site.base_url + page_dir)
    with open(os.path.join(out, '404.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(not_found_page(site))
    with open(os.path.join(out, 'sitemap.xml'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        for u in urls:
            f.write(f'  <url><loc>{esc(u)}</loc></url>\n')
        f.write('</urlset>\n')
    with open(os.path.join(out, 'robots.txt'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(f'User-agent: *\nAllow: /\n\nSitemap: {site.base_url}sitemap.xml\n')
    open(os.path.join(out, '.nojekyll'), 'w').close()
    return urls


def check_html(out, site):
    problems = []
    titles = {}
    descs = {}
    for lang, kind, tool in site.pages():
        page_dir = site.path(lang, kind, tool)
        with open(os.path.join(out, page_dir, 'index.html'), encoding='utf-8') as f:
            doc = f.read()
        n_h1 = len(re.findall(r'<h1[\s>]', doc))
        if n_h1 != 1:
            problems.append(f'{page_dir or "/"}: {n_h1} <h1> elements')
        m = re.search(r'<title>(.*?)</title>', doc)
        title = m.group(1) if m else ''
        if title in titles:
            problems.append(f'{page_dir}: title also used by {titles[title]}')
        titles[title] = page_dir
        m = re.search(r'<meta name="description" content="(.*?)">', doc)
        d = m.group(1) if m else ''
        if not d or d in descs:
            problems.append(f'{page_dir}: description missing or duplicated')
        descs[d] = page_dir
        if '{' in re.sub(r'<script type="application/json".*?</script>', '', doc, flags=re.S) and re.search(r'\{[a-z]\w*\}', re.sub(r'<script type="application/json".*?</script>', '', doc, flags=re.S)):
            problems.append(f'{page_dir}: unfilled placeholder')
    return problems


def tree(path):
    out = {}
    for root, _, files in os.walk(path):
        for fn in files:
            p = os.path.join(root, fn)
            with open(p, 'rb') as f:
                out[os.path.relpath(p, path)] = hashlib.sha256(f.read()).hexdigest()
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--check', action='store_true', help='check texts and HTML, and that docs/ is up to date')
    ap.add_argument('--base-url', help='public base URL (default from src/site.json)')
    ap.add_argument('--texts-only', metavar='LANG', help='only check src/i18n/LANG.json against en.json')
    args = ap.parse_args()
    if args.texts_only:
        cfg = load_json(os.path.join(SRC, 'site.json'))
        texts = {'en': load_json(os.path.join(SRC, 'i18n', 'en.json'))}
        texts[args.texts_only] = load_json(os.path.join(SRC, 'i18n', args.texts_only + '.json'))
        problems = check_texts(cfg, texts)
        for p in problems:
            print('FAIL', p)
        print(f'texts {args.texts_only}: {len(problems)} problems')
        sys.exit(1 if problems else 0)
    site = Site(args.base_url)
    problems = check_texts(site.cfg, site.texts)
    if args.check:
        tmp = tempfile.mkdtemp(prefix='klarto-build-')
        try:
            out = os.path.join(tmp, 'docs')
            urls = build(out, site)
            problems += check_html(out, site)
            if not os.path.isdir(DOCS):
                problems.append('docs/ does not exist: run python3 build.py')
            else:
                a, b = tree(out), tree(DOCS)
                for k in sorted(set(a) | set(b)):
                    if a.get(k) != b.get(k):
                        problems.append(f'docs/ is out of date: {k} ({"missing" if k not in b else "extra" if k not in a else "differs"})')
                        if len([p for p in problems if p.startswith('docs/')]) > 10:
                            problems.append('… more differences; run python3 build.py')
                            break
        finally:
            shutil.rmtree(tmp)
        for p in problems:
            print('FAIL', p)
        print(f'build --check: {len(urls)} pages, {len(problems)} problems')
        sys.exit(1 if problems else 0)
    if problems:
        for p in problems:
            print('FAIL', p)
        sys.exit(1)
    urls = build(DOCS, site)
    problems = check_html(DOCS, site)
    for p in problems:
        print('FAIL', p)
    print(f'built {len(urls)} pages into docs/ (assets {site.asset_dir})')
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
