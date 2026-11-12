"""Screenshots for the README and the Chrome Web Store, taken against the mock YouTube with sample notes.

    python3 tests/screenshots.py

Writes docs/screenshots/*.png (README) and docs/store/*.png (1280x800 screenshots and the 440x280
promo tile). Same requirements as tests/e2e.py.
"""
import base64, json, os, time
from playwright.sync_api import sync_playwright
from harness import EXT, OUT, build_test_ext, ensure_mock_server, launch

README_DIR = os.path.join(EXT, "docs", "screenshots")
STORE_DIR = os.path.join(EXT, "docs", "store")
RAW = os.path.join(OUT, "raw")
for d in (README_DIR, STORE_DIR, RAW):
    os.makedirs(d, exist_ok=True)

ensure_mock_server()

now = int(time.time() * 1000)
DAY = 86400000


def note(i, t, text):
    return {"id": f"n{i}", "t": t, "text": text, "createdAt": now - DAY, "updatedAt": now - DAY}


def video(vid, title, channel, folder, order, **kw):
    rec = {
        "videoId": vid, "title": title, "channel": channel, "duration": 180, "folderId": folder, "order": order,
        "done": False, "notes": [], "transcriptInfo": None, "addedAt": now - 3 * DAY, "updatedAt": now - DAY,
    }
    rec.update(kw)
    return rec


LINES = [
    "welcome back, today we're looking at how a network actually learns",
    "to learn, it needs a way to measure how wrong it is",
    "that measure is the cost, averaged over every training example",
    "a bad network has a high cost, a good one a low cost",
    "so learning means finding the weights that make the cost small",
    "picture the cost as a landscape of hills and valleys",
    "we want to walk downhill to the lowest point we can find",
    "the gradient tells us which direction is uphill",
    "so each step goes the opposite way, along the negative gradient",
    "that's the whole idea of gradient descent",
    "how big each step is depends on the learning rate",
    "if the step is too big, you overshoot the valley",
    "and land on the far side, sometimes higher than where you started",
    "if it's too small, training takes forever",
    "computing the gradient over all the data is expensive",
    "so in practice we use mini-batches, a small random sample",
    "each mini-batch gives a noisy estimate of the gradient",
    "the noise turns out to be surprisingly useful",
    "it can shake the network out of shallow dips",
    "people used to worry a lot about local minima",
    "in high dimensions, most of them are nearly as good as the best",
    "next time, we'll see how backpropagation computes the gradient",
]
TRANSCRIPT = {
    "lang": "en", "label": "English", "source": "player-request",
    "segments": [{"t": i * 8, "d": 8, "text": t} for i, t in enumerate(LINES)],
    "capturedAt": now - DAY,
}

SEED = {
    "folders": {
        "f_ml": {"id": "f_ml", "name": "Machine learning", "parentId": None, "order": 0, "createdAt": now - 9 * DAY,
                 "description": "Understand how networks learn, well enough to build one from scratch."},
        "f_music": {"id": "f_music", "name": "Music theory", "parentId": None, "order": 1, "createdAt": now - 9 * DAY, "description": ""},
    },
    "v:BBBBBBBBBBB": video("BBBBBBBBBBB", "Backpropagation, step by step", "Lattice Lectures", "f_ml", 0, done=True,
                           notes=[note(10, 22, "Chain rule, applied layer by layer from the output back"),
                                  note(11, 95, "Each weight's nudge is proportional to how much it changes the cost")]),
    "v:AAAAAAAAAAA": video("AAAAAAAAAAA", "Neural networks: how gradient descent learns", "Lattice Lectures", "f_ml", 1,
                           notes=[note(1, 12, "Cost = how wrong the network is, averaged over every training example"),
                                  note(2, 41, "The gradient points uphill, so each step goes the opposite way"),
                                  note(3, 65, "Learning rate too big overshoots the valley; too small takes forever"),
                                  note(4, 98, "Mini-batches: estimate the gradient from a sample, much cheaper per step"),
                                  note(5, 140, "Local minima matter less than you'd think in high dimensions")],
                           pages=[{"id": "p1", "title": "Summary",
                                   "text": "Learning = finding the weights that make the cost as small as possible.\n\n"
                                           "Open questions\n- Why does mini-batch noise seem to help?\n- How do people pick a learning rate in practice?"},
                                  {"id": "p2", "title": "Try it", "text": "Run gradient descent on y = x² by hand, then on a two-layer net."}],
                           transcriptInfo={"lang": "en", "label": "English", "source": "player-request", "count": len(LINES), "capturedAt": now - DAY}),
    "t:AAAAAAAAAAA": TRANSCRIPT,
    "v:EEEEEEEEEEE": video("EEEEEEEEEEE", "Fourier series & the heat equation", "Lattice Lectures", "f_ml", 2),
    "v:CCCCCCCCCCC": video("CCCCCCCCCCC", "Chord progressions for beginners", "Practice Room", "f_music", 0,
                           notes=[note(20, 15, "I–IV–V is the backbone of most pop songs")]),
    "v:DDDDDDDDDDD": video("DDDDDDDDDDD", "Intervals and scales explained", "Practice Room", "f_music", 1),
    "p:AAAAAAAAAAA": {"t": 70, "d": 180, "at": now - DAY},
    "p:BBBBBBBBBBB": {"t": 180, "d": 180, "at": now - 2 * DAY},
    "p:CCCCCCCCCCC": {"t": 40, "d": 180, "at": now - 4 * DAY},
    "ai": {"provider": "anthropic", "keys": {"anthropic": "sk-ant-screenshot-0000"}, "models": {"anthropic": "claude-sonnet-5-5"}},
}

CHAT = [
    {"role": "user", "q": "Summarize this video", "scope": {"kind": "video"}},
    {"role": "assistant", "text": (
        "**In short:** the network learns by nudging every weight a little in whichever direction lowers the cost, over and over (0:41).\n\n"
        "1. The cost measures how wrong the network is across all the training examples (0:12).\n"
        "2. The gradient points uphill, so each step goes the opposite way (0:41).\n"
        "3. The learning rate sets the step size: too large overshoots, too small crawls (1:05).\n"
        "4. Mini-batches make each step cheap enough to take millions of them (1:38).")},
    {"role": "user", "q": "Why does a big learning rate overshoot?", "scope": {"kind": "moment", "t": 88, "quote": "if the step is too big"}},
    {"role": "assistant", "text": (
        "Each step assumes the slope stays the same for the whole distance moved. Near the bottom of the valley it doesn't, "
        "so a long step lands on the far side, often higher than where it started (1:28). Smaller steps follow the curve.")},
]


def capture():
    ext = build_test_ext()
    with sync_playwright() as p:
        ctx = launch(p, ext, os.path.join(OUT, "shots-profile"), device_scale_factor=2, viewport={"width": 1280, "height": 800})
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        base = f"chrome-extension://{sw.url.split('/')[2]}"
        time.sleep(1)
        sw.evaluate(f"chrome.storage.local.set({json.dumps(SEED)})")
        sw.evaluate(f"chrome.storage.session.set({{'chat:AAAAAAAAAAA': {json.dumps(CHAT)}}})")
        for pg in ctx.pages:
            if "welcome" in pg.url:
                pg.close()

        lib = ctx.new_page()
        lib.goto(f"{base}/src/library/library.html?folder=f_ml")
        lib.wait_for_selector(".lesson", timeout=8000)
        time.sleep(1.2)
        lib.screenshot(path=f"{README_DIR}/library.png")
        lib.set_viewport_size({"width": 1152, "height": 584})
        time.sleep(0.4)
        lib.screenshot(path=f"{RAW}/library-wide.png")
        lib.goto(f"{base}/src/library/library.html?q=gradient")
        lib.wait_for_selector("mark", timeout=8000)
        time.sleep(0.8)
        lib.screenshot(path=f"{RAW}/search-wide.png")

        yt = ctx.new_page()
        yt.goto("https://www.youtube.com/watch?v=AAAAAAAAAAA")
        yt.wait_for_function("document.querySelector('video') && document.querySelector('video').readyState >= 2", timeout=10000)
        yt.evaluate("document.querySelector('video').currentTime = 70")
        tab = sw.evaluate("chrome.tabs.query({url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA'}).then(t => t[0].id)")
        panel = ctx.new_page()
        panel.set_viewport_size({"width": 400, "height": 800})
        panel.goto(f"{base}/src/sidepanel/sidepanel.html?tab={tab}")
        panel.wait_for_selector(".video-view:not([hidden])")
        panel.wait_for_selector(".timed .note")
        time.sleep(1.5)
        panel.mouse.move(399, 799)
        panel.screenshot(path=f"{README_DIR}/panel.png")

        panel.click("#tabTranscript")
        panel.wait_for_selector(".segs .seg")
        panel.fill(".tr-bar input[type=search], .tr-bar .field", "gradient")
        time.sleep(0.8)
        panel.mouse.move(399, 799)
        panel.screenshot(path=f"{RAW}/transcript.png")
        panel.fill(".tr-bar input[type=search], .tr-bar .field", "")
        panel.click("#tabNotes")

        panel.click(".ask-btn")
        panel.wait_for_selector(".msg.bot")
        time.sleep(0.6)
        panel.mouse.move(399, 799)
        panel.screenshot(path=f"{README_DIR}/ask.png")
        ctx.close()


# ---------- store images

def data_uri(path, mime):
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()


FONT_CSS = "".join(
    f"@font-face{{font-family:'Atkinson';font-weight:{w};src:url({data_uri(os.path.join(EXT, 'fonts', f'atkinson-hyperlegible-next-latin-{w}-normal.woff2'), 'font/woff2')}) format('woff2')}}"
    for w in (400, 700)
)

BASE_CSS = FONT_CSS + """
*{box-sizing:border-box;margin:0}
body{width:var(--w);height:var(--h);overflow:hidden;background:#2b2b2b;color:#fff;font-family:Atkinson,system-ui,sans-serif;position:relative}
.ledge{width:56px;height:6px;border-radius:3px;background:#ffe45c}
h1{font-size:44px;line-height:1.12;font-weight:700;letter-spacing:-.01em;margin-top:22px}
p.sub{font-size:21px;line-height:1.45;color:#c9c9c9;margin-top:14px;max-width:34em}
"""

# The sample video's frame: the lesson's own diagram, drawn as SVG so it stays sharp
FRAME_SVG = """<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg">
<rect width="960" height="540" fill="#34404f"/>
<path d="M90 186 Q480 690 870 186" fill="none" stroke="#ececE8" stroke-width="7" stroke-linecap="round"/>
<g fill="#ffe45c"><circle cx="170" cy="250" r="16"/><circle cx="290" cy="339" r="16"/><circle cx="380" cy="390" r="16"/><circle cx="440" cy="410" r="16"/><circle cx="472" cy="416" r="20"/></g>
</svg>"""


def beside(headline, sub, panel_png):
    return f"""<style>{BASE_CSS}
.copy{{position:absolute;left:64px;top:64px;width:752px}}
.video{{position:absolute;left:64px;bottom:56px;width:704px}}
.frame{{width:704px;height:396px;border-radius:12px;overflow:hidden;display:block}}
.frame svg{{display:block;width:100%;height:100%}}
.bar{{height:4px;border-radius:2px;background:#4a4a4a;margin-top:12px;overflow:hidden}}
.bar i{{display:block;width:39%;height:100%;background:#d9d9d9}}
.vt{{font-size:20px;font-weight:700;margin-top:14px}}
.vc{{font-size:16px;color:#a8a8a8;margin-top:4px}}
.panel{{position:absolute;right:0;top:0;width:400px;height:800px;box-shadow:-1px 0 0 #3d3d3d,-24px 0 48px rgba(0,0,0,.28)}}
.panel img{{display:block;width:400px;height:800px}}
</style>
<div class="copy"><div class="ledge"></div><h1>{headline}</h1><p class="sub">{sub}</p></div>
<div class="video"><div class="frame">{FRAME_SVG}</div><div class="bar"><i></i></div>
<div class="vt">Neural networks: how gradient descent learns</div><div class="vc">Lattice Lectures</div></div>
<div class="panel"><img src="{data_uri(panel_png, 'image/png')}"></div>"""


def wide(headline, sub, shot_png):
    return f"""<style>{BASE_CSS}
.copy{{position:absolute;left:64px;top:56px;right:64px}}
.copy h1{{margin-top:20px}}
.copy p.sub{{max-width:none}}
.window{{position:absolute;left:64px;top:216px;width:1152px;height:584px;border-radius:12px 12px 0 0;overflow:hidden;box-shadow:0 0 0 1px #3d3d3d,0 24px 60px rgba(0,0,0,.35)}}
.window img{{display:block;width:1152px;height:584px}}
</style>
<div class="copy"><div class="ledge"></div><h1>{headline}</h1><p class="sub">{sub}</p></div>
<div class="window"><img src="{data_uri(shot_png, 'image/png')}"></div>"""


def promo():
    icon = data_uri(os.path.join(EXT, "icons", "icon.svg"), "image/svg+xml")
    return f"""<style>{BASE_CSS}
.wrap{{position:absolute;inset:0;display:flex;align-items:center;gap:26px;padding:0 40px}}
.wrap img{{width:112px;height:112px;flex:none}}
.name{{font-size:46px;font-weight:700;letter-spacing:-.01em;line-height:1}}
.line{{font-size:18px;line-height:1.35;color:#c9c9c9;margin-top:10px}}
</style>
<div class="wrap"><img src="{icon}"><div><div class="name">Lectern</div><div class="line">Study notes for the videos you learn from</div></div></div>"""


STORE = [
    ("1-notes.png", beside, "Notes that remember the moment",
     "Press Enter and the note is stamped with the video time. Click the time to jump back to it.", "README:panel.png"),
    ("2-folders.png", wide, "Folders that work like courses",
     "Line up videos in the order you’ll study them, and see how far you got in each.", "RAW:library-wide.png"),
    ("3-ask.png", beside, "Ask about any moment",
     "Connect your own Claude or OpenAI key. Answers cite times you can click.", "README:ask.png"),
    ("4-transcript.png", beside, "The transcript stays with your notes",
     "Search it, follow along as the video plays, or turn any line into a note.", "RAW:transcript.png"),
    ("5-search.png", wide, "Find anything you’ve noted",
     "One search across every note, notepad page and transcript, all kept on your computer.", "RAW:search-wide.png"),
]


def compose():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(device_scale_factor=1)
        for name, layout, headline, sub, src in STORE:
            where, file = src.split(":")
            path = os.path.join(README_DIR if where == "README" else RAW, file)
            page.set_viewport_size({"width": 1280, "height": 800})
            page.set_content(f"<html style='--w:1280px;--h:800px'><body>{layout(headline, sub, path)}</body></html>")
            page.evaluate("document.fonts.ready")
            page.screenshot(path=os.path.join(STORE_DIR, name))
        page.set_viewport_size({"width": 440, "height": 280})
        page.set_content(f"<html style='--w:440px;--h:280px'><body>{promo()}</body></html>")
        page.evaluate("document.fonts.ready")
        page.screenshot(path=os.path.join(STORE_DIR, "promo-440x280.png"))
        browser.close()


if __name__ == "__main__":
    capture()
    compose()
    for d in (README_DIR, STORE_DIR):
        print(os.path.relpath(d, EXT) + ": " + ", ".join(sorted(os.listdir(d))))
