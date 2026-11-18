"""Chrome Web Store images from real screenshots: five 1280x800 screenshots and the 440x280 promo tile.

    python3 scripts/store_images.py

Sources are full-window captures of Chrome with Lectern open, in docs/store/source/. Each store image
crops one source to what matters and adds a caption. Output goes to docs/store/.
Needs Playwright (pip install playwright; python -m playwright install chromium).
"""
import base64, os, sys
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "store", "source")
OUT = os.path.join(ROOT, "docs", "store")

W, H = 1280, 800
THEME = {
    "light": {"bg": "#e7e7e5", "ink": "#1f1f1f", "sub": "#555555", "edge": "rgba(0,0,0,.14)", "shadow": "0 18px 50px rgba(0,0,0,.22)"},
    "dark": {"bg": "#2b2b2b", "ink": "#ffffff", "sub": "#c9c9c9", "edge": "#474747", "shadow": "0 24px 60px rgba(0,0,0,.45)"},
}

# (output, layout, source, crop box in source pixels (x, y, w, h), headline, line)
SHOTS = [
    ("1-notes.png", "wide", "1-notes.png", None,
     "Notes that remember the moment", "Press Enter and the note is stamped with the video time. Click the time to jump back to it."),
    ("2-folders.png", "wide", "2-library.png", (0, 0, 1985, None),
     "Folders that work like courses", "Line up videos in the order you’ll study them, and see how far you got in each."),
    ("3-ask.png", "beside", "3-ask.png", (1616, 0, None, None),
     "Ask about any moment", "Connect your own Claude or OpenAI key. Answers cite times you can click."),
    ("4-transcript.png", "beside", "4-transcript.png", (1616, 0, None, None),
     "The transcript stays with your notes", "Search it, follow along as the video plays, or turn any line into a note."),
    ("5-notion.png", "wide", "6-notion-page.png", (0, 0, 1700, None),
     "Your notes, where you keep notes", "Lectern keeps Notion or an Obsidian folder up to date, and exports Markdown, Word and PDF."),
]

WIDE_BOX = (48, 216, 1184, 584)  # left, top, width, height of the screenshot window
# "beside" images run the full height on the right, as wide as their crop allows


def data_uri(path, mime):
    with open(path, "rb") as f:
        return f"data:{mime};base64," + base64.b64encode(f.read()).decode()


def font_css():
    faces = []
    for w in (400, 700):
        for sub in ("latin", "latin-ext"):
            p = os.path.join(ROOT, "fonts", f"atkinson-hyperlegible-next-{sub}-{w}-normal.woff2")
            faces.append(f"@font-face{{font-family:Atkinson;font-weight:{w};src:url({data_uri(p, 'font/woff2')}) format('woff2')}}")
    return "".join(faces)


def crop_style(src_size, crop, box_w, box_h, anchor="top-left"):
    """CSS that shows `crop` (in source pixels) filling a box_w x box_h window."""
    sw, sh = src_size
    x, y, cw, ch = crop
    aspect = box_w / box_h
    aw, ah = (cw or sw - x), (ch or sh - y)  # the region we may show
    # the largest crop with the window's shape that fits in that region
    if aw / ah > aspect:
        cw, ch = ah * aspect, ah
    else:
        cw, ch = aw, aw / aspect
    if anchor == "top-right":
        x = sw - cw
    scale = box_w / cw
    return f"width:{sw * scale:.1f}px;height:{sh * scale:.1f}px;left:{-x * scale:.1f}px;top:{-y * scale:.1f}px"


def page(t, inner):
    return f"""<html><head><style>{font_css()}
*{{box-sizing:border-box;margin:0}}
body{{width:{W}px;height:{H}px;overflow:hidden;background:{t['bg']};color:{t['ink']};font-family:Atkinson,system-ui,sans-serif;position:relative}}
.ledge{{width:52px;height:6px;border-radius:3px;background:#ffe45c;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12)}}
h1{{font-size:40px;line-height:1.12;font-weight:700;letter-spacing:-.01em;margin-top:18px}}
p{{font-size:19px;line-height:1.45;color:{t['sub']};margin-top:10px}}
.win{{position:absolute;overflow:hidden;box-shadow:0 0 0 1px {t['edge']},{t['shadow']}}}
.win img{{position:absolute;display:block}}
</style></head><body>{inner}</body></html>"""


def wide(t, src, crop, headline, line, size):
    l, top, w, h = WIDE_BOX
    style = crop_style(size, crop or (0, 0, None, None), w, h)
    return page(t, f"""
<div style="position:absolute;left:{l}px;top:48px;right:{l}px"><div class="ledge"></div><h1>{headline}</h1><p>{line}</p></div>
<div class="win" style="left:{l}px;top:{top}px;width:{w}px;height:{h}px;border-radius:12px 12px 0 0"><img src="{src}" style="{style}"></div>""")


def beside(t, src, crop, headline, line, size):
    x, y, cw, ch = crop or (0, 0, None, None)
    h = H
    w = round(h * (cw or size[0] - x) / (ch or size[1] - y))
    style = crop_style(size, (x, y, cw, ch), w, h)
    return page(t, f"""
<div style="position:absolute;left:72px;top:0;bottom:0;width:{min(520, W - w - 144)}px;display:flex;flex-direction:column;justify-content:center"><div class="ledge"></div><h1 style="font-size:46px">{headline}</h1><p style="font-size:21px">{line}</p></div>
<div class="win" style="right:0;top:0;width:{w}px;height:{h}px"><img src="{src}" style="{style}"></div>""")


def promo():
    icon = data_uri(os.path.join(ROOT, "icons", "icon.svg"), "image/svg+xml")
    return f"""<html><head><style>{font_css()}
*{{box-sizing:border-box;margin:0}}
body{{width:440px;height:280px;overflow:hidden;background:#2b2b2b;color:#fff;font-family:Atkinson,system-ui,sans-serif}}
.wrap{{position:absolute;inset:0;display:flex;align-items:center;gap:26px;padding:0 40px}}
img{{width:112px;height:112px;flex:none}}
.name{{font-size:46px;font-weight:700;letter-spacing:-.01em;line-height:1}}
.line{{font-size:18px;line-height:1.35;color:#c9c9c9;margin-top:10px}}
</style></head><body><div class="wrap"><img src="{icon}"><div><div class="name">Lectern</div>
<div class="line">Study notes for the videos you learn from</div></div></div></body></html>"""


def main(theme="light", only=None, out=OUT):
    from PIL import Image

    t = THEME[theme]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        for name, layout, source, crop, headline, line in SHOTS:
            if only and name not in only:
                continue
            path = os.path.join(SRC, source)
            size = Image.open(path).size
            html = (wide if layout == "wide" else beside)(t, data_uri(path, "image/png"), crop, headline, line, size)
            pg.set_content(html)
            pg.evaluate("document.fonts.ready")
            pg.screenshot(path=os.path.join(out, name))
        if not only:
            pg.set_viewport_size({"width": 440, "height": 280})
            pg.set_content(promo())
            pg.evaluate("document.fonts.ready")
            pg.screenshot(path=os.path.join(out, "promo-440x280.png"))
        browser.close()


if __name__ == "__main__":
    main(*(sys.argv[1:2] or ["light"]))
    print("wrote", ", ".join(sorted(f for f in os.listdir(OUT) if f.endswith(".png"))))
