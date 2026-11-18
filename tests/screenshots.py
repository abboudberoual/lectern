"""Screenshots for the README, taken against the mock YouTube with sample notes.

    python3 tests/screenshots.py

Writes docs/screenshots/*.png. Same requirements as tests/e2e.py. The Chrome Web Store images are made
from real screenshots instead: see scripts/store_images.py.
"""
import json, os, time
from playwright.sync_api import sync_playwright
from harness import EXT, OUT, build_test_ext, ensure_mock_server, launch

README_DIR = os.path.join(EXT, "docs", "screenshots")
for d in (README_DIR,):
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

        panel.click(".ask-btn")
        panel.wait_for_selector(".msg.bot")
        time.sleep(0.6)
        panel.mouse.move(399, 799)
        panel.screenshot(path=f"{README_DIR}/ask.png")
        ctx.close()


if __name__ == "__main__":
    capture()
    print(os.path.relpath(README_DIR, EXT) + ": " + ", ".join(sorted(os.listdir(README_DIR))))
