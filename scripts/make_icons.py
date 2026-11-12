"""Draw the Lectern icon (an open book resting on a lectern; the yellow ledge is the mark)
and write icons/*.png plus icons/icon.svg.

    python3 scripts/make_icons.py

16 and 32 px are hand-snapped to the pixel grid so the toolbar icon stays crisp. The 128 px icon
has 16 px of transparent padding around a 96 px tile, as the Chrome Web Store asks.
"""
import os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INK, PAPER, MARK = "#2B2B2B", "#FFFFFF", "#FFE45C"

# Master artwork, drawn for a 120 px tile placed at (4, 4) on a 128 grid
ART = (
    f'<path d="M61 28C51 22 38 20 24 22v44c14-2 27 0 37 6z" fill="{PAPER}"/>'
    f'<path d="M67 28c10-6 23-8 37-6v44c-14-2-27 0-37 6z" fill="{PAPER}"/>'
    f'<rect x="18" y="74" width="92" height="10" rx="5" fill="{MARK}"/>'
    f'<rect x="58" y="84" width="12" height="18" fill="{PAPER}"/>'
    f'<rect x="40" y="100" width="48" height="9" rx="4.5" fill="{PAPER}"/>'
)


def tile(pad):
    s = 128 - 2 * pad
    k = s / 120
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
        f'<rect x="{pad}" y="{pad}" width="{s}" height="{s}" rx="{28 * k:.2f}" fill="{INK}"/>'
        f'<g transform="translate({pad} {pad}) scale({k:.4f}) translate(-4 -4)">{ART}</g></svg>'
    )


SMALL = {
    16: (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">'
        f'<rect width="16" height="16" rx="3.5" fill="{INK}" shape-rendering="geometricPrecision"/>'
        f'<path d="M3 3h3v1h1v4H3z" fill="{PAPER}"/>'
        f'<path d="M13 3h-3v1H9v4h4z" fill="{PAPER}"/>'
        f'<rect x="2" y="9" width="12" height="1" fill="{MARK}"/>'
        f'<rect x="7" y="10" width="2" height="2" fill="{PAPER}"/>'
        f'<rect x="5" y="12" width="6" height="1" fill="{PAPER}"/></svg>'
    ),
    32: (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
        f'<rect width="32" height="32" rx="7" fill="{INK}"/>'
        f'<path d="M15 7.5C12.5 6 9.5 5.5 6 6v11c3.5-.5 6.5 0 9 1.5z" fill="{PAPER}"/>'
        f'<path d="M17 7.5C19.5 6 22.5 5.5 26 6v11c-3.5-.5-6.5 0-9 1.5z" fill="{PAPER}"/>'
        f'<rect x="4" y="19" width="24" height="2" rx="1" fill="{MARK}"/>'
        f'<rect x="15" y="21" width="2" height="4" fill="{PAPER}"/>'
        f'<rect x="10" y="25" width="12" height="2" rx="1" fill="{PAPER}"/></svg>'
    ),
}

OUTPUTS = {16: SMALL[16], 32: SMALL[32], 48: tile(2), 128: tile(16)}


def render(page, svg, size, path):
    page.set_viewport_size({"width": size, "height": size})
    sized = svg.replace("<svg ", f'<svg width="{size}" height="{size}" ', 1)
    page.set_content(f'<html><body style="margin:0;background:transparent">{sized}</body></html>')
    page.screenshot(path=path, omit_background=True)


if __name__ == "__main__":
    out = os.path.join(ROOT, "icons")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "icon.svg"), "w") as f:
        f.write(tile(4) + "\n")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(device_scale_factor=1)
        for size, svg in OUTPUTS.items():
            render(page, svg, size, os.path.join(out, f"icon{size}.png"))
        browser.close()
    print("wrote icons/icon.svg and icon16/32/48/128.png")
