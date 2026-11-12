"""Screenshots for the README and store listing, taken against the mock YouTube with sample notes.

    python3 tests/screenshots.py

Writes docs/screenshots/*.png. Same requirements as tests/e2e.py.
"""
import json, os, shutil, socket, subprocess, sys, time, atexit
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.dirname(HERE)
OUT = os.path.join(EXT, "docs", "screenshots")
PROFILE = os.path.join(HERE, ".out", "shots-profile")
shutil.rmtree(PROFILE, ignore_errors=True)
os.makedirs(OUT, exist_ok=True)
os.makedirs(os.path.join(HERE, ".out"), exist_ok=True)


def port_open():
    try:
        with socket.create_connection(("127.0.0.1", 443), timeout=0.5):
            return True
    except OSError:
        return False


if not port_open():
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, "mock", "server.py")], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    atexit.register(proc.terminate)
    for _ in range(50):
        if port_open():
            break
        time.sleep(0.2)
    else:
        sys.exit("Mock server didn't start (it needs port 443).")

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
                                  {"id": "p2", "title": "Try it", "text": "Run gradient descent on y = x² by hand, then on a two-layer net."}]),
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
    {"role": "user", "q": "Why does a big learning rate overshoot?", "scope": {"kind": "moment", "t": 65, "quote": "if the step is too big"}},
    {"role": "assistant", "text": (
        "Each step assumes the slope stays the same for the whole distance moved. Near the bottom of the valley it doesn't, "
        "so a long step lands on the far side, often higher than where it started (1:05). Smaller steps follow the curve.")},
]

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        PROFILE,
        channel="chromium",
        headless=True,
        device_scale_factor=2,
        viewport={"width": 1280, "height": 800},
        args=[
            f"--disable-extensions-except={EXT}",
            f"--load-extension={EXT}",
            "--host-resolver-rules=MAP www.youtube.com 127.0.0.1, MAP i.ytimg.com 127.0.0.1",
            "--ignore-certificate-errors",
            "--no-proxy-server",
            "--autoplay-policy=no-user-gesture-required",
        ],
    )
    sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
    base = f"chrome-extension://{sw.url.split('/')[2]}"
    time.sleep(1)
    sw.evaluate(f"chrome.storage.local.set({json.dumps(SEED)})")
    sw.evaluate(f"chrome.storage.session.set({{'chat:AAAAAAAAAAA': {json.dumps(CHAT)}}})")
    for pg in ctx.pages:
        if "welcome" in pg.url:
            pg.close()

    # library, folder view (1280x800 is also the store's screenshot size)
    lib = ctx.new_page()
    lib.goto(f"{base}/src/library/library.html?folder=f_ml")
    lib.wait_for_selector(".lesson", timeout=8000)
    time.sleep(1.2)
    lib.screenshot(path=f"{OUT}/library.png")

    # the notes panel beside a video
    yt = ctx.new_page()
    yt.goto("https://www.youtube.com/watch?v=AAAAAAAAAAA")
    yt.wait_for_function("document.querySelector('video') && document.querySelector('video').readyState >= 2", timeout=10000)
    yt.evaluate("document.querySelector('video').currentTime = 70")
    tab = sw.evaluate("chrome.tabs.query({url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA'}).then(t => t[0].id)")
    panel = ctx.new_page()
    panel.set_viewport_size({"width": 400, "height": 820})
    panel.goto(f"{base}/src/sidepanel/sidepanel.html?tab={tab}")
    panel.wait_for_selector(".video-view:not([hidden])")
    panel.wait_for_selector(".timed .note")
    time.sleep(1.5)
    panel.mouse.move(399, 819)
    panel.screenshot(path=f"{OUT}/panel.png")

    # Ask, with a conversation already in it
    panel.click(".ask-btn")
    panel.wait_for_selector(".msg.bot")
    time.sleep(0.6)
    panel.mouse.move(399, 819)
    panel.screenshot(path=f"{OUT}/ask.png")

    ctx.close()

print("\n".join(sorted(os.listdir(OUT))))
