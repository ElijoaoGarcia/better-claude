#!/usr/bin/env python3
"""Cuts the page's fonts down to what index.html shows, and points the page at the result.

- Geist Mono: printable ASCII plus every other character the page shows, weights 400-600 only,
  written as fonts/geist-mono-<hash>.woff2 so it can be cached forever.
- Geist Pixel: only the letters of the title, inlined in the page as a data URI (no request).
- Caveat: only the letters of the hand-written note by the Narrator demo, inlined the same way.

Needs fonttools and brotli (pip install fonttools brotli). Run after changing the page's text:
python3 web/fonts/subset.py
"""
import base64
import hashlib
import io
import re
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

WEB = Path(__file__).resolve().parent.parent
FONTS = WEB / 'fonts'
PAGE = WEB / 'index.html'
TITLE = 'betterclaude'
NOTE = 'try this!'


def build(src, unicodes, limit=None):
    font = TTFont(src, lazy=False)
    options = subset.Options()
    options.layout_features = ['kern', 'liga', 'calt', 'ccmp', 'locl', 'mark', 'mkmk']
    options.name_IDs = ['*']
    options.notdef_outline = True
    options.hinting = False
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=sorted(unicodes))
    subsetter.subset(font)
    if limit:
        font = instancer.instantiateVariableFont(font, limit)
    font.flavor = 'woff2'
    font.recalcTimestamp = False  # same input, same bytes, same hashed name
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


html = PAGE.read_text()
shown = re.sub(r'<(script|style)>.*?</\1>', '', html, flags=re.S)
mono_codes = set(range(0x20, 0x7F)) | {ord(c) for c in shown if ord(c) > 0x7E}

mono = build(FONTS / 'src' / 'geist-mono-latin.woff2', mono_codes, {'wght': (400, 600)})
mono_name = f'geist-mono-{hashlib.sha256(mono).hexdigest()[:8]}.woff2'
for old in FONTS.glob('geist-mono-*.woff2'):
    old.unlink()
(FONTS / mono_name).write_bytes(mono)

pixel = build(FONTS / 'src' / 'geist-pixel-latin.woff2', {ord(c) for c in TITLE})
hand = build(FONTS / 'src' / 'caveat-latin.woff2', {ord(c) for c in NOTE}, {'wght': 500})


def inline(family, font, page):
    """Points the @font-face of `family` at `font`, as a data URI."""
    uri = 'data:font/woff2;base64,' + base64.b64encode(font).decode()
    pattern = r'(font-family: "' + family + r'"; src: url\()data:font/woff2;base64,[A-Za-z0-9+/=]+'
    return re.sub(pattern, lambda match: match.group(1) + uri, page)


html = re.sub(r'fonts/geist-mono-[0-9a-f]{8}\.woff2', f'fonts/{mono_name}', html)
html = inline('Geist Pixel', pixel, html)
html = inline('Caveat', hand, html)
PAGE.write_text(html)

print(f'fonts/{mono_name}: {len(mono)} bytes')
print(f'Geist Pixel inlined: {len(pixel)} bytes')
print(f'Caveat inlined: {len(hand)} bytes')
