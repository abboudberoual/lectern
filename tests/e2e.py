"""End-to-end tests: loads the extension in Chromium against a mock YouTube (tests/mock/server.py).

    python3 tests/e2e.py

Needs Playwright (`pip install playwright && playwright install chromium`) and permission to
listen on 127.0.0.1:443. The mock server is started automatically if it isn't already running.
Screenshots land in tests/.out/shots.
"""
import json, os, re, shutil, sys, time, traceback, zipfile
from xml.dom import minidom
from playwright.sync_api import sync_playwright
from harness import EXT, OUT, build_test_ext, ensure_mock_server, launch

SHOTS = os.path.join(OUT, "shots")
PROFILE = os.path.join(OUT, "profile")
os.makedirs(SHOTS, exist_ok=True)

ensure_mock_server()

errors = []
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""), flush=True)


def watch_console(page, label):
    page.on("console", lambda m: errors.append(f"{label}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"{label} pageerror: {e}"))


def wait_until(fn, timeout=10, step=0.2):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:
            last = e
        time.sleep(step)
    return last if last and not isinstance(last, Exception) else None


def real_manifest_checks(p):
    ctx = launch(p, EXT, os.path.join(OUT, "profile-real"))
    try:
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        base = f"chrome-extension://{sw.url.split('/')[2]}"
        m = sw.evaluate("chrome.runtime.getManifest()")
        check("installs with access to youtube.com only", m["host_permissions"] == ["https://www.youtube.com/*"], json.dumps(m["host_permissions"]))
        check("Ask's and Notion's hosts are optional", sorted(m.get("optional_host_permissions", [])) == ["https://api.anthropic.com/*", "https://api.openai.com/*", "https://mcp.notion.com/*"])
        check("no access to Notion until it's connected", sw.evaluate("chrome.permissions.contains({origins: ['https://mcp.notion.com/*']})") is False)
        granted = sw.evaluate("chrome.permissions.contains({origins: ['https://api.anthropic.com/*']})")
        check("no access to Anthropic until a key is connected", granted is False)
        # a key saved without access (e.g. access removed in chrome://extensions): Ask asks for it
        sw.evaluate("chrome.storage.local.set({ai: {provider: 'anthropic', keys: {anthropic: 'sk-ant-good-key-1234'}, models: {}}})")
        yt = ctx.new_page()
        yt.goto("https://www.youtube.com/watch?v=AAAAAAAAAAA")
        tab = sw.evaluate("chrome.tabs.query({url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA'}).then(t => t[0].id)")
        panel = ctx.new_page()
        panel.set_viewport_size({"width": 400, "height": 900})
        watch_console(panel, "panel-real")
        panel.goto(f"{base}/src/sidepanel/sidepanel.html?tab={tab}")
        panel.wait_for_selector(".video-view:not([hidden])")
        panel.click(".ask-btn")
        ok = wait_until(lambda: "needs your permission to reach Anthropic" in panel.inner_text(".ask-pane"), 5)
        check("Ask asks for permission when a key is saved without access", ok, panel.inner_text(".ask-pane")[:200])
        check("questions stay hidden until access is allowed", not panel.locator(".ask-foot").is_visible())
    except Exception:
        traceback.print_exc()
        results.append(("real manifest checks crashed", False, traceback.format_exc()[-400:]))
    finally:
        ctx.close()


TEST_EXT = build_test_ext()

with sync_playwright() as p:
    ctx = launch(p, TEST_EXT, PROFILE)
    try:
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=15000)
        ext_id = sw.url.split("/")[2]
        print("extension id", ext_id)
        base = f"chrome-extension://{ext_id}"

        # ---- install opens the library welcome page
        opened = wait_until(lambda: sw.evaluate("chrome.runtime.getContexts({contextTypes:['TAB']}).then(c => c.some(x => x.documentUrl.includes('library.html?welcome=1')))"), 8)
        check("install opens library welcome tab", opened)
        lib = ctx.new_page()
        lib.goto(f"{base}/src/library/library.html?welcome=1")
        watch_console(lib, "library")
        lib.wait_for_selector(".welcome", timeout=5000)
        check("welcome steps shown", lib.locator(".welcome li").count() == 3)
        lib.screenshot(path=f"{SHOTS}/01-library-welcome.png")

        # ---- open video A on "YouTube"
        yt = ctx.new_page()
        watch_console(yt, "youtube")
        yt.goto("https://www.youtube.com/watch?v=AAAAAAAAAAA")
        yt.wait_for_selector("video")
        wait_until(lambda: yt.evaluate("document.querySelector('video') && document.querySelector('video').readyState") >= 2, 10)
        btn = wait_until(lambda: yt.locator(".lectern-note-btn").count() > 0, 6)
        check("note button injected into player controls", btn)

        tab_id = lib.evaluate("chrome.tabs.query({url: 'https://www.youtube.com/*'}).then(t => t[0].id)")
        panel = ctx.new_page()
        panel.set_viewport_size({"width": 400, "height": 900})
        watch_console(panel, "panel")
        panel.goto(f"{base}/src/sidepanel/sidepanel.html?tab={tab_id}")
        panel.wait_for_selector(".video-view:not([hidden])", timeout=8000)
        check("panel shows video title", "gradient descent" in panel.inner_text(".v-title").lower(), panel.inner_text(".v-title"))
        check("no live timer, Mark or Add buttons in the panel", panel.locator("#notesPane .time").count() == 0 and panel.locator(".c-bar").count() == 0 and panel.locator(".top").count() == 0)
        check("unsaved video offers a folder instead of a save button", "Add to a folder" in panel.inner_text(".folder-pick") and panel.locator(".v-save").count() == 0)
        # grey palette, no placeholder text, a blinking caret in the note box
        bg = panel.evaluate("getComputedStyle(document.body).backgroundColor")
        tab = panel.evaluate("getComputedStyle(document.querySelector('.tab[aria-selected=true]')).boxShadow")
        check("grey palette: white page, ink-grey tab underline (no blue)", bg == "rgb(255, 255, 255)" and "rgb(31, 31, 31)" in tab, f"{bg} / {tab}")
        check("no placeholder text in the panel", panel.evaluate("[...document.querySelectorAll('textarea')].every(t => !t.placeholder)"))
        shade = panel.evaluate("getComputedStyle(document.querySelector('.c-text')).backgroundColor")
        check("note box is a shade off the page", shade not in ("rgb(255, 255, 255)", "rgba(0, 0, 0, 0)"), shade)
        panel.evaluate("document.activeElement && document.activeElement.blur()")
        caret = panel.evaluate("[getComputedStyle(document.querySelector('.c-write'), '::after').display, getComputedStyle(document.querySelector('.c-write'), '::after').animationName, getComputedStyle(document.querySelector('.np-write'), '::after').display]")
        check("blinking caret shows in the empty note box only", caret[0] == "block" and caret[1] == "caret-blink" and caret[2] == "none", json.dumps(caret))
        panel.click(".np-text")
        caret = panel.evaluate("[getComputedStyle(document.querySelector('.c-write'), '::after').display, getComputedStyle(document.querySelector('.np-write'), '::after').display]")
        check("caret moves with focus (real caret in the notepad, none drawn)", caret == ["none", "none"], json.dumps(caret))
        panel.click(".c-text")
        layout = panel.evaluate("""(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); return [r('.notepad').top, r('.splitter').top, r('.timed').top, r('.composer').top, r('.notepad').height, r('.timed').height]; })()""")
        check("notepad on top, splitter, time notes and note box below, split evenly", layout[0] < layout[1] < layout[2] < layout[3] and abs(layout[4] - layout[5]) < 30, json.dumps(layout))
        check("one notepad page: no tab bar, a + to add pages", panel.locator(".page-bar").is_hidden() and panel.locator(".np-add").is_visible())
        yt.evaluate("document.querySelector('video').pause(); document.querySelector('video').currentTime = 12.4")
        time.sleep(0.6)
        panel.screenshot(path=f"{SHOTS}/02-panel-new-video.png")

        # ---- write a note: stamped when it's saved, not when typing starts
        panel.click(".c-text")
        panel.keyboard.type("Cost function = how wrong")
        yt.evaluate("document.querySelector('video').currentTime = 20")
        time.sleep(0.8)
        panel.keyboard.press("Shift+Enter")
        panel.keyboard.type("the network is on training data")
        panel.keyboard.press("Enter")
        panel.wait_for_selector(".notes .note", timeout=4000)
        rec = panel.evaluate("chrome.storage.local.get('v:AAAAAAAAAAA').then(r => r['v:AAAAAAAAAAA'])")
        check("note stamped with the time it was saved (0:20, not 0:12)", rec and len(rec["notes"]) == 1 and int(rec["notes"][0]["t"]) == 20 and "\n" in rec["notes"][0]["text"], json.dumps(rec)[:300] if rec else "no record")
        check("video saved with title/channel", rec and rec["title"].startswith("Neural networks") and rec["channel"] == "Lattice Lectures")
        check("note box cleared and still focused", panel.input_value(".c-text") == "" and panel.evaluate("document.activeElement.classList.contains('c-text')"))
        check("folder picker now reads Unfiled", "Unfiled" in panel.inner_text(".folder-pick"))

        # ---- automatic transcript capture (pot path)
        tr = wait_until(lambda: panel.evaluate("chrome.storage.local.get('t:AAAAAAAAAAA').then(r => r['t:AAAAAAAAAAA'] || null)"), 15)
        check("transcript auto-captured after first note", tr and len(tr["segments"]) == 20, f"{len(tr['segments']) if tr else 'none'}")
        if tr:
            check("transcript came from player caption request", tr["source"] == "captions", tr["source"])
            check("transcript lines clean (no newlines / dup appends)", all("\n" not in s["text"] and s["text"] for s in tr["segments"]))
            check("first line text", tr["segments"][0]["text"].startswith("welcome back today"), tr["segments"][0]["text"])
        stats = json.loads(yt.evaluate("fetch('/__stats').then(r => r.text())"))
        check("caption state restored after forced request", yt.evaluate("document.querySelector('.caption-window').hidden"))
        check("only pot requests produced data", any(t["pot"] for t in stats["timedtext"]), json.dumps(stats))

        # ---- more notes
        for t_, txt in [(37, "Step against the gradient"), (61, "Learning rate tradeoff")]:
            yt.evaluate(f"document.querySelector('video').currentTime = {t_}")
            time.sleep(0.7)
            panel.click(".c-text")
            panel.keyboard.type(txt)
            panel.keyboard.press("Enter")
            time.sleep(0.5)
        rec = panel.evaluate("chrome.storage.local.get('v:AAAAAAAAAAA').then(r => r['v:AAAAAAAAAAA'])")
        check("notes sorted by time", [int(n["t"]) for n in rec["notes"]] == [20, 37, 61], json.dumps([n["t"] for n in rec["notes"]]))
        # edit a note in place
        check("time shown small at the end of each note", panel.locator(".timed .note .ts").first.inner_text() == "(0:20)")
        fs = panel.evaluate("[getComputedStyle(document.querySelector('.timed .ts')).fontSize, getComputedStyle(document.querySelector('.timed .note-txt')).fontSize]")
        check("note time is smaller than the note text", float(fs[0][:-2]) < float(fs[1][:-2]), json.dumps(fs))
        panel.locator(".timed .note-txt").nth(2).click()
        panel.wait_for_selector(".note-edit")
        panel.keyboard.press("End")
        panel.keyboard.type(": too big overshoots")
        panel.keyboard.press("Enter")
        time.sleep(0.6)
        check("Enter finishes editing", panel.locator(".note-edit").count() == 0 and "too big overshoots" in panel.locator(".timed .note-txt").nth(2).inner_text())
        rec = panel.evaluate("chrome.storage.local.get('v:AAAAAAAAAAA').then(r => r['v:AAAAAAAAAAA'])")
        check("editing a note in place saves it", rec["notes"][2]["text"] == "Learning rate tradeoff: too big overshoots", rec["notes"][2]["text"])

        # ---- clicking a note's time seeks the video
        panel.locator(".timed .ts").nth(0).click()
        ct = wait_until(lambda: (lambda v: v if 19.5 < v < 22 else None)(yt.evaluate("document.querySelector('video').currentTime")), 3)
        check("clicking a note time seeks the video", ct, str(yt.evaluate("document.querySelector('video').currentTime")))
        time.sleep(0.8)
        check("current note's time highlighted", panel.locator(".timed .note.is-current").count() == 1 and panel.locator(".timed .ts.is-now").count() == 1)
        yt.evaluate("document.querySelector('video').pause()")

        # Alt+K toggles playback from the panel
        panel.click(".c-text")
        panel.keyboard.press("Alt+KeyK")
        played = wait_until(lambda: not yt.evaluate("document.querySelector('video').paused"), 3)
        check("Alt+K plays the video from the panel", played)
        yt.evaluate("document.querySelector('video').pause()")

        # ---- notepad on the bottom half
        panel.click(".np-text")
        panel.keyboard.type("Learning = minimizing a cost function over weights.")
        panel.keyboard.press("Enter")
        panel.keyboard.type("Open question: why does SGD noise help?")
        time.sleep(1.0)
        rec = panel.evaluate("chrome.storage.local.get('v:AAAAAAAAAAA').then(r => r['v:AAAAAAAAAAA'])")
        check("notepad text saved as page 1", rec.get("pages") and rec["pages"][0]["text"].startswith("Learning = minimizing") and "Open question" in rec["pages"][0]["text"], json.dumps(rec.get("pages")))
        # add pages
        panel.click(".np-add")
        time.sleep(0.6)
        check("adding a page shows page tabs", panel.locator(".page-bar").is_visible() and panel.locator(".page-tab").count() == 2 and panel.locator(".np-add").is_hidden())
        check("page tabs sit in the notepad header, replacing its title", panel.evaluate("!!document.querySelector('.notepad .np-head .page-bar')") and panel.locator(".np-head h2").is_hidden())
        check("new page is empty and focused", panel.input_value(".np-text") == "" and panel.evaluate("document.activeElement.classList.contains('np-text')"))
        panel.keyboard.type("Build a tiny network that learns XOR.")
        time.sleep(0.9)
        panel.locator(".page-tab").nth(0).click()
        time.sleep(0.3)
        check("switching pages shows each page's text", panel.input_value(".np-text").startswith("Learning = minimizing"))
        panel.locator(".page-tab").nth(1).click()
        time.sleep(0.3)
        panel.locator(".page-tab.active").click()
        panel.locator(".menu button", has_text="Rename page").click()
        panel.fill("dialog.dlg input", "Ideas")
        panel.click("dialog.dlg .btn.primary")
        time.sleep(0.6)
        check("page renamed from its tab", panel.locator(".page-tab.active").inner_text().strip() == "Ideas")
        panel.click(".page-add")
        time.sleep(0.5)
        check("third page added", panel.locator(".page-tab").count() == 3 and "Page 3" in panel.locator(".page-tab.active").inner_text())
        panel.locator(".page-tab.active").click()
        panel.locator(".menu button.danger").click()
        time.sleep(0.5)
        check("empty page deleted without asking", panel.locator(".page-tab").count() == 2)
        rec = panel.evaluate("chrome.storage.local.get('v:AAAAAAAAAAA').then(r => r['v:AAAAAAAAAAA'])")
        check("pages saved", [p["title"] for p in rec["pages"]] == ["Page 1", "Ideas"] and rec["pages"][1]["text"].startswith("Build a tiny"), json.dumps(rec["pages"]))
        # collapse time notes
        panel.click(".timed-toggle")
        time.sleep(0.3)
        hgt = panel.evaluate("[document.querySelector('.notepad').getBoundingClientRect().height, document.querySelector('.timed-scroll').hidden]")
        check("time notes fold away, the notepad grows, the splitter hides", hgt[1] and hgt[0] > 450 and panel.locator(".splitter").is_hidden(), json.dumps(hgt))
        check("note box stays when folded", panel.locator(".c-text").is_visible())
        panel.mouse.move(0, 0)
        panel.screenshot(path=f"{SHOTS}/03b-panel-folded-pages.png")
        panel.click(".timed-toggle")
        panel.locator(".page-tab").nth(0).click()

        # ---- drag the divider between notepad and time notes
        def heights():
            return panel.evaluate("[document.querySelector('.notepad').getBoundingClientRect().height, document.querySelector('.timed').getBoundingClientRect().height]")
        sp = panel.locator(".splitter").bounding_box()
        cx, cy = sp["x"] + sp["width"] / 2, sp["y"] + sp["height"] / 2
        panel.mouse.move(cx, cy)
        panel.mouse.down()
        panel.mouse.move(cx, cy - 150, steps=8)
        panel.mouse.up()
        h1 = heights()
        check("dragging the divider up shrinks the notepad", h1[0] < h1[1] - 200, json.dumps(h1))
        panel.mouse.move(cx, cy - 150)
        panel.mouse.down()
        panel.mouse.move(cx, 0, steps=8)
        panel.mouse.up()
        h2 = heights()
        check("notepad can't be dragged smaller than its minimum", 90 <= h2[0] <= 110, json.dumps(h2))
        sp = panel.locator(".splitter").bounding_box()
        panel.mouse.move(cx, sp["y"] + sp["height"] / 2)
        panel.mouse.down()
        panel.mouse.move(cx, 2000, steps=10)
        panel.mouse.up()
        visible_box = panel.evaluate("(() => { const c = document.querySelector('.composer').getBoundingClientRect(); return c.bottom <= innerHeight + 1 && c.height > 40; })()")
        check("time notes keep their header and note box when dragged small", visible_box and panel.locator(".timed-toggle").is_visible())
        # keyboard
        panel.dblclick(".splitter")
        h3 = heights()
        check("double-click splits evenly again", abs(h3[0] - h3[1]) < 30, json.dumps(h3))
        panel.focus(".splitter")
        panel.keyboard.press("ArrowDown")
        panel.keyboard.press("ArrowDown")
        h4 = heights()
        check("arrow keys move the divider", h4[0] > h3[0] + 40, json.dumps([h3, h4]))
        check("divider reports its position to screen readers", panel.get_attribute(".splitter", "aria-valuenow") == "60", panel.get_attribute(".splitter", "aria-valuenow"))
        # remembered after reopening the panel
        panel.reload()
        panel.wait_for_selector(".video-view:not([hidden])")
        time.sleep(0.6)
        h5 = heights()
        check("split is remembered when the panel reopens", abs(h5[0] - h4[0]) < 6, json.dumps([h4, h5]))
        panel.mouse.move(0, 0)
        panel.screenshot(path=f"{SHOTS}/03c-panel-split.png")
        panel.dblclick(".splitter")

        # ---- folder: create from the panel
        panel.select_option(".folder-sel", "__new")
        panel.wait_for_selector("dialog.dlg input")
        panel.fill("dialog.dlg input", "Machine learning")
        panel.click("dialog.dlg .btn.primary")
        ok = wait_until(lambda: panel.evaluate("chrome.storage.local.get(['folders','v:AAAAAAAAAAA']).then(r => { const f = Object.values(r.folders||{}); return f.length === 1 && r['v:AAAAAAAAAAA'].folderId === f[0].id; })"), 4)
        check("new folder created and video filed in it", ok)
        time.sleep(0.5)
        check("folder picker shows the folder", "Machine learning" in panel.inner_text(".folder-pick"))
        panel.mouse.move(0, 0)
        time.sleep(3.5)
        panel.screenshot(path=f"{SHOTS}/03-panel-notes.png")

        # ---- transcript tab
        yt.evaluate("document.querySelector('video').currentTime = 45")
        panel.click("#tabTranscript")
        panel.wait_for_selector(".segs .seg")
        time.sleep(1.2)
        cur = panel.locator(".seg.is-current .seg-text").inner_text() if panel.locator(".seg.is-current").count() else ""
        check("current transcript line highlighted (0:45 -> line at 0:42)", "too large and you overshoot" in cur, cur)
        check("transcript toolbar is just search + options", panel.locator(".tr-bar > *").count() == 2)
        panel.mouse.move(0, 0)
        panel.screenshot(path=f"{SHOTS}/04-panel-transcript.png")
        panel.fill(".tr-bar input", "gradient")
        time.sleep(0.5)
        n = panel.locator(".segs .seg").count()
        check("transcript search filters lines", n == 6, str(n))
        check("search matches marked", panel.locator(".segs mark").count() >= 6)
        panel.locator(".segs .seg").nth(1).hover()
        panel.locator(".segs .seg .seg-add").nth(1).click()
        time.sleep(0.6)
        rec = panel.evaluate("chrome.storage.local.get('v:AAAAAAAAAAA').then(r => r['v:AAAAAAAAAAA'])")
        check("transcript line added as note at its time", any(n["text"].startswith("the gradient points") and int(n["t"]) == 24 for n in rec["notes"]), json.dumps([(n['t'], n['text'][:20]) for n in rec['notes']]))
        panel.fill(".tr-bar input", "")
        time.sleep(0.4)
        panel.locator(".segs .seg .seg-text").nth(5).click()
        ct = wait_until(lambda: (lambda v: v if 29.5 < v < 33 else None)(yt.evaluate("document.querySelector('video').currentTime")), 3)
        check("clicking a transcript line seeks", ct, str(yt.evaluate("document.querySelector('video').currentTime")))
        yt.evaluate("document.querySelector('video').pause()")

        # options menu: follow toggle + languages
        panel.click(".tr-bar .icon-btn")
        panel.wait_for_selector(".menu")
        items = panel.locator(".menu [role=menuitemcheckbox]").all_inner_texts()
        check("options menu has follow toggle and both caption languages", len(items) == 3 and "French" in " ".join(items), json.dumps(items))
        panel.screenshot(path=f"{SHOTS}/05-panel-transcript-menu.png")
        panel.locator(".menu button", has_text="French").click()
        ok = wait_until(lambda: panel.evaluate("chrome.storage.local.get('t:AAAAAAAAAAA').then(r => r['t:AAAAAAAAAAA'].lang === 'fr')"), 12)
        check("switching caption language recaptures", ok)
        panel.click(".tr-bar .icon-btn")
        panel.locator(".menu button", has_text="English").click()
        wait_until(lambda: panel.evaluate("chrome.storage.local.get('t:AAAAAAAAAAA').then(r => r['t:AAAAAAAAAAA'].lang === 'en')"), 12)
        panel.click(".tr-bar .icon-btn")
        panel.locator(".menu button", has_text="Follow the video").click()
        time.sleep(0.3)
        check("follow toggle saved", panel.evaluate("chrome.storage.local.get('settings').then(r => r.settings.followTranscript === false)"))
        panel.click(".tr-bar .icon-btn")
        panel.locator(".menu button", has_text="Follow the video").click()

        # ---- dark mode panel
        panel.emulate_media(color_scheme="dark")
        panel.click("#tabNotes")
        panel.locator(".page-tab").nth(1).click()
        panel.mouse.move(0, 0)
        time.sleep(0.4)
        panel.screenshot(path=f"{SHOTS}/06-panel-dark.png")
        panel.locator(".page-tab").nth(0).click()
        panel.emulate_media(color_scheme="light")

        # ---- position tracking writes p: for saved videos
        yt.evaluate("document.querySelector('video').currentTime = 90; document.querySelector('video').play()")
        time.sleep(4)
        yt.evaluate("document.querySelector('video').pause()")
        pos = wait_until(lambda: panel.evaluate("chrome.storage.local.get('p:AAAAAAAAAAA').then(r => r['p:AAAAAAAAAAA'] || null)"), 4)
        check("watch position remembered", pos and pos["t"] >= 89, json.dumps(pos))

        # ---- ads: notes wait
        yt.evaluate("document.getElementById('movie_player').classList.add('ad-showing')")
        time.sleep(0.9)
        check("ad note shown only during ads", panel.locator(".ad-note").is_visible())
        panel.click(".c-text")
        panel.keyboard.type("during ad")
        panel.keyboard.press("Enter")
        time.sleep(0.4)
        check("note not saved during an ad (text kept)", panel.input_value(".c-text") == "during ad")
        panel.fill(".c-text", "")
        yt.evaluate("document.getElementById('movie_player').classList.remove('ad-showing')")
        time.sleep(0.8)
        check("ad note hidden after the ad", not panel.locator(".ad-note").is_visible())

        # ---- in-player note button: focuses the note box
        yt.evaluate("document.querySelector('video').currentTime = 100")
        time.sleep(0.3)
        yt.click(".lectern-note-btn")
        time.sleep(1.0)
        check("in-player button focuses the note box", panel.evaluate("document.activeElement.classList.contains('c-text')"))
        panel.keyboard.type("Momentum through flat regions")
        panel.keyboard.press("Enter")
        time.sleep(0.6)
        rec = panel.evaluate("chrome.storage.local.get('v:AAAAAAAAAAA').then(r => r['v:AAAAAAAAAAA'])")
        check("note from player button stamped at save time", any(int(n["t"]) == 100 for n in rec["notes"]), json.dumps([n["t"] for n in rec["notes"]]))

        # ---- Ask (Claude / OpenAI) from the top-bar sparkle
        def ai_calls():
            return json.loads(yt.evaluate("fetch('/__ai').then(r => r.text())"))
        check("sparkle icon in the top bar", panel.locator(".v-title-row .ask-btn").is_visible())
        panel.click(".ask-btn")
        panel.wait_for_selector(".ai-setup", timeout=4000)
        check("first open shows setup, notes hidden", panel.locator(".ask-pane").is_visible() and panel.locator("#notesPane").is_hidden() and panel.locator(".tabs").is_hidden())
        panel.screenshot(path=f"{SHOTS}/13-ask-setup.png")
        panel.fill(".ai-setup input[type=password]", "sk-ant-bad-key")
        panel.click(".ai-setup .btn.primary")
        ok = wait_until(lambda: "didn’t accept the API key" in panel.inner_text(".ai-status"), 5)
        check("a rejected key is explained", ok, panel.inner_text(".ai-status") if panel.locator(".ai-status").count() else "")
        panel.fill(".ai-setup input[type=password]", "sk-ant-good-key-1234")
        panel.click(".ai-setup .btn.primary")
        ok = wait_until(lambda: panel.locator(".ask-suggest .suggestion").count() == 3, 5)
        check("connecting shows suggested questions", ok)
        check("pane title names the provider and model", "Ask Claude" in panel.inner_text(".ask-title") and "Sonnet 5.5" in panel.inner_text(".ask-model"), panel.inner_text(".ask-head"))
        check("ask input has no placeholder", panel.evaluate("!document.querySelector('.ask-text').placeholder"))
        stored = panel.evaluate("chrome.storage.local.get('ai').then(r => r.ai)")
        check("key and model saved locally", stored["provider"] == "anthropic" and stored["keys"]["anthropic"] == "sk-ant-good-key-1234", json.dumps(stored))
        panel.screenshot(path=f"{SHOTS}/14-ask-ready.png")
        panel.locator(".suggestion", has_text="Summarize").click()
        ok = wait_until(lambda: panel.locator(".msg.bot .msg-actions").count() == 1, 8)
        check("answer streams in", ok and "Gradient descent lowers the cost" in panel.inner_text(".msg.bot"))
        call = [c for c in ai_calls()["calls"] if c["host"] == "api.anthropic.com"][-1]
        hd = call["headers"]
        check("Claude request headers", hd.get("x-api-key") == "sk-ant-good-key-1234" and hd.get("anthropic-version") == "2023-06-01" and hd.get("anthropic-dangerous-direct-browser-access") == "true", json.dumps({k: hd.get(k) for k in ["x-api-key", "anthropic-version", "anthropic-dangerous-direct-browser-access"]}))
        sysb = call["body"]["system"][0]
        check("transcript and notes sent as cached system context", "learning rate controls" in sysb["text"] and "<my_time_notes>" in sysb["text"] and sysb.get("cache_control") == {"type": "ephemeral"} and call["body"]["model"] == "claude-sonnet-5-5" and call["body"]["stream"] is True)
        tsb = panel.locator(".msg.bot .ts")
        check("cited times in the answer are clickable", tsb.count() >= 3 and tsb.first.inner_text() == "(0:24)", str(tsb.count()))
        tsb.first.click()
        ct = wait_until(lambda: (lambda v: v if 23.5 < v < 26 else None)(yt.evaluate("document.querySelector('video').currentTime")), 3)
        check("clicking a cited time seeks the video", ct, str(yt.evaluate("document.querySelector('video').currentTime")))
        yt.evaluate("document.querySelector('video').pause()")
        check("answer markdown rendered (bold + list)", panel.locator(".msg.bot strong").count() >= 1 and panel.locator(".msg.bot ol li").count() == 2)
        panel.locator(".msg.bot").hover()
        panel.locator(".msg-actions button[aria-label='Save answer to notepad']").click()
        time.sleep(0.6)
        rec = panel.evaluate("chrome.storage.local.get('v:AAAAAAAAAAA').then(r => r['v:AAAAAAAAAAA'])")
        check("save to notepad appends Q and A to the current page", "Q: Summarize this video" in rec["pages"][0]["text"] and "Gradient descent lowers" in rec["pages"][0]["text"], rec["pages"][0]["text"][-200:])
        # follow-up keeps the conversation
        panel.click(".ask-text")
        panel.keyboard.type("What about momentum?")
        panel.keyboard.press("Enter")
        wait_until(lambda: panel.locator(".msg.bot .msg-actions").count() == 2, 8)
        call = [c for c in ai_calls()["calls"] if c["host"] == "api.anthropic.com"][-1]
        check("follow-up sends the earlier turns", len(call["body"]["messages"]) == 3 and call["body"]["messages"][1]["role"] == "assistant", str(len(call["body"]["messages"])))
        panel.mouse.move(0, 0)
        panel.screenshot(path=f"{SHOTS}/15-ask-answer.png")
        # ask about a transcript line
        panel.keyboard.press("Escape")
        time.sleep(0.2)
        check("Esc closes Ask and brings the notes back", panel.locator(".ask-pane").is_hidden() and panel.locator("#notesPane").is_visible())
        panel.click("#tabTranscript")
        panel.wait_for_selector(".segs .seg")
        panel.fill(".tr-bar input", "")
        time.sleep(0.3)
        line = panel.locator(".segs .seg").nth(4)
        line.hover()
        line.locator(".seg-ask").click()
        time.sleep(0.4)
        chip = panel.inner_text(".scope-chip")
        check("asking about a line opens Ask scoped to it", panel.locator(".ask-pane").is_visible() and "the gradient points" in chip and "(0:24)" in chip, chip)
        check("moment chip has no stray 'null' text", "null" not in chip, chip)
        panel.keyboard.type("Why does it point uphill?")
        panel.keyboard.press("Enter")
        wait_until(lambda: panel.locator(".msg.bot .msg-actions").count() == 3, 8)
        call = [c for c in ai_calls()["calls"] if c["host"] == "api.anthropic.com"][-1]
        last = call["body"]["messages"][-1]["content"]
        check("the line and nearby transcript are sent with the question", "moment at (0:24)" in last and "the gradient points in the direction" in last and "Nearby transcript" in last, last[:200])
        check("answer about the moment shows it", "At (0:24)" in panel.locator(".msg.bot").last.inner_text())
        check("scope returns to whole video after a quoted question", "Whole video" in panel.inner_text(".scope-chip"))
        # "around now" scope
        yt.evaluate("document.querySelector('video').currentTime = 61; document.querySelector('video').pause()")
        time.sleep(0.8)
        panel.click(".scope-chip")
        panel.locator(".menu button", has_text="Around now").click()
        check("around-now scope follows the video", "(1:01)" in panel.inner_text(".scope-chip"), panel.inner_text(".scope-chip"))
        # note menu entry
        panel.click(".ask-btn")
        panel.click("#tabNotes")
        step_note = panel.locator(".timed .note", has_text="Step against")
        step_note.hover()
        step_note.locator(".note-more").click()
        panel.locator(".menu button", has_text="Ask about this moment").click()
        time.sleep(0.3)
        check("time note menu opens Ask about that moment", panel.locator(".ask-pane").is_visible() and "(0:37)" in panel.inner_text(".scope-chip"), panel.inner_text(".scope-chip"))
        panel.click(".scope-clear")
        # switch to OpenAI
        panel.click(".ask-head .icon-btn[aria-label='Ask options']")
        panel.locator(".menu button", has_text="Model and API key").click()
        panel.wait_for_selector(".ai-setup")
        panel.locator(".segmented button", has_text="OpenAI").click()
        panel.fill(".ai-setup input[type=password]", "sk-proj-openai-5678")
        panel.click(".ai-setup .btn.primary")
        ok = wait_until(lambda: "Ask OpenAI" in panel.inner_text(".ask-title"), 5)
        check("switched to OpenAI", ok and "GPT-6.1 Sol" in panel.inner_text(".ask-model"), panel.inner_text(".ask-head"))
        panel.click(".ask-text")
        panel.keyboard.type("Summarize this video")
        panel.keyboard.press("Enter")
        ok = wait_until(lambda: panel.locator(".msg.bot .msg-actions").count() == 4, 8)
        call = [c for c in ai_calls()["calls"] if c["host"] == "api.openai.com"][-1]
        check("OpenAI request: bearer key, system message, streamed answer", ok and call["headers"].get("authorization") == "Bearer sk-proj-openai-5678" and call["body"]["messages"][0]["role"] == "system" and "learning rate controls" in call["body"]["messages"][0]["content"] and call["body"]["model"] == "gpt-6.1-sol" and "Gradient descent lowers" in panel.locator(".msg.bot").last.inner_text())
        check("top-bar icon label follows the provider", "Ask OpenAI" in panel.get_attribute(".ask-btn", "aria-label"))
        # dark Ask pane
        panel.emulate_media(color_scheme="dark")
        panel.mouse.move(0, 0)
        time.sleep(0.3)
        panel.screenshot(path=f"{SHOTS}/16-ask-dark.png")
        dbg = panel.evaluate("getComputedStyle(document.body).backgroundColor")
        check("dark mode is neutral grey", dbg == "rgb(30, 30, 30)", dbg)
        panel.emulate_media(color_scheme="light")
        panel.click(".ask-btn")
        time.sleep(0.2)

        # ---- SPA navigation to video C (no captions)
        yt.evaluate(
            "window.__mockNavigate('CCCCCCCCCCC', {title: 'Chord progressions for beginners', channel: 'Practice Room', pr: {videoDetails: {videoId: 'CCCCCCCCCCC', title: 'Chord progressions for beginners', author: 'Practice Room', lengthSeconds: '180'}}})"
        )
        ok = wait_until(lambda: "chord progressions" in panel.inner_text(".v-title").lower(), 5)
        check("panel follows in-page navigation", ok, panel.inner_text(".v-title"))
        check("new video starts with empty notes", panel.locator(".notes .note").count() == 0)
        panel.click("#tabTranscript")
        panel.click(".tr-status .btn.primary")
        ok = wait_until(lambda: "no transcript available" in panel.inner_text(".tr-status").lower(), 15)
        check("no-captions video explains there is no transcript", ok, panel.inner_text(".tr-status"))
        panel.screenshot(path=f"{SHOTS}/04b-panel-no-transcript.png")
        check("no stray 'null' text in the transcript status", "null" not in panel.inner_text(".tr-status"))
        href = panel.get_attribute(".tr-report a", "href") or ""
        check(
            "failed capture offers a prefilled issue report",
            "/lectern/issues/new?" in href and "template=transcript.yml" in href and "CCCCCCCCCCC" in href and "version=1." in href,
            href[:200],
        )
        rec_c = panel.evaluate("chrome.storage.local.get('v:CCCCCCCCCCC').then(r => r['v:CCCCCCCCCCC'] || null)")
        check("failed capture doesn't save the video", rec_c is None)
        # paste a transcript instead
        panel.click(".tr-status .btn.quiet")
        panel.fill("textarea.paste", "0:00\nIntro to chords\n0:15\nThe I–IV–V progression\n1:02\nAdding the vi chord")
        panel.click("text=Save transcript")
        ok = wait_until(lambda: panel.locator(".segs .seg").count() == 3, 4)
        check("pasted transcript (YouTube panel format) parsed into 3 timed lines", ok)
        rec_c = panel.evaluate("chrome.storage.local.get('v:CCCCCCCCCCC').then(r => r['v:CCCCCCCCCCC'] || null)")
        check("pasting saves the video with its title", rec_c and rec_c["title"] == "Chord progressions for beginners")
        panel.click("#tabNotes")

        # ---- video B: transcript only available through the panel
        yt2 = ctx.new_page()
        watch_console(yt2, "youtube-B")
        yt2.goto("https://www.youtube.com/watch?v=BBBBBBBBBBB")
        wait_until(lambda: yt2.evaluate("document.querySelector('video') && document.querySelector('video').readyState") >= 2, 10)
        tab2 = lib.evaluate("chrome.tabs.query({url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB'}).then(t => t[0].id)")
        panel2 = ctx.new_page()
        panel2.set_viewport_size({"width": 400, "height": 900})
        watch_console(panel2, "panel-B")
        panel2.goto(f"{base}/src/sidepanel/sidepanel.html?tab={tab2}")
        panel2.wait_for_selector(".video-view:not([hidden])")
        panel2.click("#tabTranscript")
        panel2.wait_for_selector(".tr-status .btn.primary")
        t0 = time.time()
        panel2.click(".tr-status .btn.primary")
        ok = wait_until(lambda: panel2.locator(".segs .seg").count() == 10, 25)
        check("transcript read from YouTube's transcript panel when captions are blocked", ok, f"{panel2.locator('.segs .seg').count()} lines")
        trb = panel2.evaluate("chrome.storage.local.get('t:BBBBBBBBBBB').then(r => r['t:BBBBBBBBBBB'] || null)")
        if trb:
            check("panel source + timestamps parsed (chapter header skipped)", trb["source"] == "transcript-panel" and trb["segments"][1]["t"] == 7 and trb["segments"][0]["text"].startswith("backpropagation computes"), json.dumps(trb["segments"][:2]))
            check("a11y duration labels not in text", all("seconds" not in s["text"] for s in trb["segments"]))
        check("YouTube transcript panel closed again", yt2.evaluate("document.querySelector('[target-id=PAmodern_transcript_view]').getAttribute('visibility')") == "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN")
        print(f"  (panel fallback took {time.time() - t0:.1f}s)")
        panel2.close()

        # ---- video E: plain caption URL returning XML (srv1), on a Trusted Types page
        yt3 = ctx.new_page()
        tt_errors = []
        yt3.on("console", lambda m: tt_errors.append(m.text) if "Trusted" in m.text or "TrustedHTML" in m.text else None)
        yt3.goto("https://www.youtube.com/watch?v=EEEEEEEEEEE")
        wait_until(lambda: yt3.evaluate("document.querySelector('video') && document.querySelector('video').readyState") >= 2, 10)
        check("player note button works under Trusted Types", wait_until(lambda: yt3.locator(".lectern-note-btn svg path").count() == 3, 6))
        tab3 = lib.evaluate("chrome.tabs.query({url: 'https://www.youtube.com/watch?v=EEEEEEEEEEE'}).then(t => t[0].id)")
        res = lib.evaluate(f"chrome.runtime.sendMessage({{type: 'captureTranscript', tabId: {tab3}, videoId: 'EEEEEEEEEEE'}})")
        tre = lib.evaluate("chrome.storage.local.get('t:EEEEEEEEEEE').then(r => r['t:EEEEEEEEEEE'] || null)")
        check("XML captions parsed with entities decoded", tre and len(tre["segments"]) == 3 and tre["segments"][1]["text"] == "fourier's idea: write it as a sum of sines" and "&" in tre["segments"][2]["text"] and "amp" not in tre["segments"][2]["text"], json.dumps(res)[:300])
        check("no Trusted Types violations from the extension", not tt_errors, json.dumps(tt_errors))
        yt3.close()

        # ---- library
        lib.goto(f"{base}/src/library/library.html")
        lib.wait_for_selector(".tree-row")
        check("library sidebar lists the folder", "Machine learning" in lib.inner_text("#tree"))
        lib.click(".tree-open")
        lib.wait_for_selector(".vrow")
        check("folder shows the saved video", lib.locator(".vrow").count() == 1)
        check("row shows resume progress", lib.locator(".vrow .bar").count() == 1)
        check("rows are decluttered (no grip, no stats line)", lib.locator(".grip").count() == 0 and lib.locator(".fv-stats").count() == 0)
        # add videos by URL (with a duplicate and a junk token)
        lib.fill(".add-input", "https://youtu.be/BBBBBBBBBBB https://www.youtube.com/watch?v=DDDDDDDDDDD&t=30s not-a-link https://www.youtube.com/watch?v=AAAAAAAAAAA")
        lib.press(".add-input", "Enter")
        ok = wait_until(lambda: lib.locator(".vrow").count() == 2 if False else None, 0.1)
        # B already exists (saved via transcript capture), D is new
        time.sleep(1.5)
        toast = lib.inner_text(".toast")
        rows = lib.locator(".vrow .vtitle").all_inner_texts()
        check("add-by-link adds new videos with looked-up titles", "Intervals and scales explained" in rows, json.dumps(rows))
        check("add-by-link reports duplicates", "already in your library" in toast, toast)
        # goal text
        check("empty folder goal stays hidden", lib.locator(".fv-goal").is_hidden())
        lib.click(".fv-title-row .icon-btn")
        lib.locator(".menu button", has_text="Add a goal").click()
        time.sleep(0.3)
        check("Add a goal reveals and focuses the goal line", lib.evaluate("document.activeElement.classList.contains('fv-goal')"))
        lib.keyboard.type("Understand how networks learn, well enough to implement one.")
        time.sleep(0.8)
        # reorder: drag D above A
        before = lib.locator(".vrow .vtitle").all_inner_texts()
        src = lib.locator(".vrow").nth(len(before) - 1)
        dst = lib.locator(".vrow").nth(0)
        src.drag_to(dst, target_position={"x": 300, "y": 5})
        time.sleep(0.8)
        after = lib.locator(".vrow .vtitle").all_inner_texts()
        check("drag to reorder videos in a folder", after[0] == before[-1], json.dumps(after))
        check("goal text survives background updates", lib.input_value(".fv-goal").startswith("Understand how networks"))
        # mark finished via lesson button
        lib.locator(".vrow .lesson").nth(0).click()
        time.sleep(0.5)
        check("lesson button marks finished", lib.locator(".vrow .lesson.done").count() == 1)
        lib.locator(".vrow .lesson").nth(0).click()
        time.sleep(0.4)
        lib.screenshot(path=f"{SHOTS}/07-library-folder.png")
        # subfolder via menu
        lib.click(".fv-title-row .icon-btn")
        lib.click("text=New folder inside")
        lib.fill("dialog.dlg input", "Optimizers")
        lib.click("dialog.dlg .btn.primary")
        lib.wait_for_selector("h1:has-text('Optimizers')")
        check("subfolder created and opened", "Machine learning" in lib.inner_text(".crumbs"))
        # drag a video from All videos onto the subfolder in the sidebar
        lib.click(".nav-item:has-text('All videos')")
        lib.wait_for_selector(".vrow")
        row_d = lib.locator(".vrow", has_text="Intervals and scales")
        row_d.drag_to(lib.locator(".tree-row", has_text="Optimizers"))
        time.sleep(0.8)
        dd = lib.evaluate("chrome.storage.local.get(['v:DDDDDDDDDDD','folders']).then(r => r.folders[r['v:DDDDDDDDDDD'].folderId]?.name)")
        check("drag a video onto a sidebar folder moves it", dd == "Optimizers", str(dd))
        lib.screenshot(path=f"{SHOTS}/08-library-all.png")

        # detail view
        lib.click(".nav-item:has-text('All videos')")
        lib.locator(".vrow .vtitle", has_text="Neural networks").click()
        lib.wait_for_selector(".d-col .notes .note")
        n_notes = lib.locator(".d-col .notes .note").count()
        check("detail view lists the notes", n_notes == 5, str(n_notes))
        layout = lib.evaluate("""(() => { const y = (s) => document.querySelector(s).getBoundingClientRect().top; return [y('.d-summary'), y('.d-col .notes')]; })()""")
        check("video page: notepad above the time notes", layout[0] < layout[1], json.dumps(layout))
        check("video page shows notepad pages", lib.locator(".d-page").count() == 2 and lib.input_value(".d-summary").startswith("Learning = minimizing"))
        lib.locator(".d-page").nth(1).click()
        time.sleep(0.3)
        check("video page switches notepad pages", lib.input_value(".d-summary").startswith("Build a tiny"))
        lib.locator(".d-page").nth(0).click()
        check("detail view shows transcript", lib.locator(".d-segs .d-seg").count() == 20)
        check("detail resume button shows saved position", re.search(r"Resume at \d+:\d\d", lib.inner_text(".d-actions .btn.primary")) is not None, lib.inner_text(".d-actions .btn.primary"))
        lib.screenshot(path=f"{SHOTS}/09-library-detail.png", full_page=True)
        # clicking a time opens/focuses the YouTube tab and seeks
        lib.locator(".d-col .notes .ts").nth(1).click()
        # yt navigated to C in-page, so a new tab for A should open at the note's time
        note_t = lib.locator(".d-col .notes .ts").nth(1).inner_text()
        urls = wait_until(lambda: (lambda u: u if any("v=AAAAAAAAAAA" in x for x in u) else None)(lib.evaluate("chrome.tabs.query({url: 'https://www.youtube.com/*'}).then(t => t.map(x => x.url || x.pendingUrl))")), 5)
        check("opening a note time opens the video at that moment", urls and any("v=AAAAAAAAAAA&t=24s" in x for x in urls), f"{note_t} {urls}")
        # opening again focuses that tab instead of opening another
        lib.bring_to_front()
        lib.locator(".d-col .notes .ts").nth(0).click()
        time.sleep(1.5)
        n_a = lib.evaluate("chrome.tabs.query({url: 'https://www.youtube.com/watch*'}).then(t => t.filter(x => (x.url||'').includes('AAAAAAAAAAA')).length)")
        check("opening a video that is already open reuses its tab", n_a == 1, str(n_a))

        # search
        lib.bring_to_front()
        lib.fill("#search", "learning rate")
        lib.wait_for_selector(".results .result", timeout=4000)
        hits = lib.locator(".results .hit").count()
        check("search finds notes and transcript lines", hits >= 2, str(hits))
        check("search hit kinds", "Note" in lib.inner_text(".results") and "Transcript" in lib.inner_text(".results"))
        lib.screenshot(path=f"{SHOTS}/10-library-search.png")
        lib.fill("#search", "XOR")
        ok = wait_until(lambda: lib.locator(".results .hit").count() >= 1 and "Ideas" in lib.inner_text(".results"), 4)
        check("search finds notepad pages", ok)

        # dark library
        lib.emulate_media(color_scheme="dark")
        lib.fill("#search", "")
        time.sleep(0.5)
        lib.goto(f"{base}/src/library/library.html")
        lib.wait_for_selector(".tree-row")
        lib.click(".tree-open")
        lib.wait_for_selector(".vrow")
        lib.screenshot(path=f"{SHOTS}/11-library-dark.png")
        lib.emulate_media(color_scheme="light")

        # backup round-trip
        lib.click("#settingsBtn")
        lib.wait_for_selector("dialog .set-ask .ai-setup")
        check("library settings has the Ask section showing the saved key", "OpenAI" in lib.inner_text("dialog .set-ask") and "…5678" in lib.inner_text("dialog .set-ask"), lib.inner_text("dialog .set-ask")[:200])
        about = lib.locator("dialog .hint.about a")
        check(
            "settings link to issues and source code",
            about.count() == 2 and "template=bug.yml" in (about.nth(0).get_attribute("href") or "") and about.nth(1).get_attribute("href").endswith("/lectern"),
        )
        lib.screenshot(path=f"{SHOTS}/17-library-settings.png")
        lib.click("dialog .btn.primary:has-text('Done')")
        with lib.expect_download() as dl:
            lib.click("#settingsBtn")
            lib.click("dialog .btn:has-text('Export backup')")
        lib.click("dialog .btn.primary:has-text('Done')")
        path = dl.value.path()
        backup = json.load(open(path))
        check("backup contains videos, folders, transcripts", any(k.startswith("v:") for k in backup["data"]) and "folders" in backup["data"] and any(k.startswith("t:") for k in backup["data"]))
        check("backup never includes the API key", "ai" not in backup["data"] and "sk-" not in json.dumps(backup))
        lib.evaluate("chrome.storage.local.clear()")
        time.sleep(0.4)
        lib.set_input_files("#importFile", path)
        ok = wait_until(lambda: lib.evaluate("chrome.storage.local.get(null).then(r => Object.keys(r).filter(k => k.startsWith('v:')).length)") == 5, 4)
        check("import restores everything", ok)

        # markdown export from the panel
        md = panel.evaluate(
            "import('../shared/util.js').then(async u => { const r = await chrome.storage.local.get(['v:AAAAAAAAAAA']); return u.videoToMarkdown(r['v:AAAAAAAAAAA'], null); })"
        )
        check("markdown export has linked timestamps", "[0:20](https://www.youtube.com/watch?v=AAAAAAAAAAA&t=20s)" in md, md[:300])
        check("markdown export includes notepad pages", "## Notepad" in md and "### Ideas" in md and "XOR" in md, md[-300:])

        # ---------- export: Word, Markdown, PDF
        lib.goto(f"{base}/src/library/library.html?video=AAAAAAAAAAA")
        lib.wait_for_selector("button[aria-label='More actions']")

        def export(fmt, transcript=False, menu_btn="button[aria-label='More actions']"):
            lib.click(menu_btn)
            lib.click(".menu button:has-text('Export…')")
            lib.click(f".export-formats button[data-id={fmt}]")
            if transcript:
                lib.check(".export-tr input")
            if fmt == "pdf":
                with ctx.expect_page() as pg:
                    lib.click(".export-dlg .btn.primary")
                return pg.value
            with lib.expect_download() as dl:
                lib.click(".export-dlg .btn.primary")
            return dl.value

        d = export("docx", transcript=True)
        z = zipfile.ZipFile(d.path())
        names = z.namelist()
        try:
            for n in names:
                if n.endswith((".xml", ".rels")):
                    minidom.parseString(z.read(n))
            parsed = True
        except Exception as e:
            parsed = str(e)
        doc = z.read("word/document.xml").decode()
        rels = z.read("word/_rels/document.xml.rels").decode()
        check("Word export is a valid .docx", d.suggested_filename.endswith(".docx") and parsed is True and "word/numbering.xml" in names, f"{d.suggested_filename} {parsed}")
        check("Word export has time notes, notepad pages and the transcript", 'w:val="Title"' in doc and "XOR" in doc and "gradient descent nudges every weight" in doc, doc[:300])
        check("Word export links each time to that moment", "watch?v=AAAAAAAAAAA&amp;t=20s" in rels and 'w:rStyle w:val="TimeLink"' in doc)
        check("Word export turns **bold** from saved answers into bold text", "<w:b/>" in doc and "**Summary" not in doc)
        d = export("md")
        md_txt = open(d.path()).read()
        check("Markdown export from the dialog", d.suggested_filename.endswith(".md") and "## Time notes" in md_txt and "## Transcript" not in md_txt)
        pdf = export("pdf", transcript=True)
        pdf.wait_for_selector("main h1", timeout=8000)
        check("PDF export opens a print-ready page", "print.html?video=AAAAAAAAAAA&transcript=1" in pdf.url and pdf.locator("main a.ts").count() >= 5 and pdf.title().startswith("Neural networks"), pdf.url)
        pdf.screenshot(path=f"{SHOTS}/20-print-page.png", full_page=True)
        pdf.close()
        fid = lib.evaluate("chrome.storage.local.get('v:AAAAAAAAAAA').then(r => r['v:AAAAAAAAAAA'].folderId)")
        if fid:
            lib.goto(f"{base}/src/library/library.html?folder={fid}")
            lib.wait_for_selector("button[aria-label='Folder actions']")
            d = export("docx", menu_btn="button[aria-label='Folder actions']")
            fdoc = zipfile.ZipFile(d.path()).read("word/document.xml").decode()
            check("folder export puts every video in one document", "Neural networks" in fdoc and fdoc.count('w:val="Heading1"') >= 1, d.suggested_filename)
        else:
            check("folder export puts every video in one document", False, "video A has no folder")

        # ---------- folder sync (the origin-private file system stands in for a picked folder)
        def vault_files():
            return lib.evaluate("""async () => {
              const out = [];
              const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('vault', { create: true });
              async function walk(d, pre) { for await (const [n, h] of d.entries()) h.kind === 'directory' ? await walk(h, pre + n + '/') : out.push(pre + n); }
              await walk(root, '');
              return out.sort();
            }""")

        def vault_read(path):
            return lib.evaluate("""async (path) => {
              let d = await (await navigator.storage.getDirectory()).getDirectoryHandle('vault');
              const parts = path.split('/');
              for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
              return (await (await d.getFileHandle(parts[parts.length - 1])).getFile()).text();
            }""", path)

        def edit_video(js):
            sw.evaluate("""chrome.storage.local.get('v:AAAAAAAAAAA').then(r => { const v = r['v:AAAAAAAAAAA']; (%s)(v); v.updatedAt = Date.now(); return chrome.storage.local.set({'v:AAAAAAAAAAA': v}); })""" % js)

        lib.goto(f"{base}/src/library/library.html")
        lib.wait_for_selector(".tree-row")
        lib.evaluate("window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('vault', { create: true })")
        lib.click("#settingsBtn")
        lib.click("[data-target=folder] button:has-text('Choose folder')")
        ok = wait_until(lambda: "Writing to “vault/Lectern”" in lib.inner_text("[data-target=folder] .sync-status"), 8)
        check("folder sync starts once a folder is chosen", ok, lib.inner_text("[data-target=folder]"))
        files = vault_files()
        check("one Markdown file per video, in folders like the library", len(files) == 5 and all(f.startswith("Lectern/") and f.endswith(".md") for f in files), files)
        a_path = next((f for f in files if "Neural networks" in f), "")
        a_text = vault_read(a_path) if a_path else ""
        check("synced files have frontmatter, linked times and the one-way note", a_text.startswith('---\ntitle: "Neural networks') and "[0:20](" in a_text and "Synced from Lectern" in a_text, a_text[:200])
        edit_video("v => v.notes.push({ id: 'syncmark', t: 33, text: 'Folder sync marker', createdAt: Date.now(), updatedAt: Date.now() })")
        ok = wait_until(lambda: "Folder sync marker" in vault_read(a_path), 8)
        check("editing notes rewrites the synced file", ok)
        edit_video("v => { v._folder = v.folderId; v.folderId = null; }")
        ok = wait_until(lambda: any(f.startswith("Lectern/Unfiled/Neural") for f in vault_files()) and a_path not in vault_files(), 8)
        check("moving a video moves its file", ok, vault_files())
        edit_video("v => { v.folderId = v._folder; delete v._folder; }")
        wait_until(lambda: a_path in vault_files(), 8)

        # ---------- Notion sync through the mock Notion MCP server
        def notion_state():
            return json.loads(lib.evaluate("fetch('https://mcp.notion.com/__notion').then(r => r.text())"))

        lib.click("[data-target=notion] button:has-text('Connect Notion')")
        ok = wait_until(lambda: "Syncing to the “Lectern” page" in lib.inner_text("[data-target=notion] .sync-status"), 25)
        check("Notion connects and finishes the first sync", ok, lib.inner_text("[data-target=notion]"))
        ns = notion_state()
        tr = ns["token_requests"][0] if ns["token_requests"] else {}
        check("Notion sign-in uses PKCE and the MCP resource", tr.get("grant_type") == "authorization_code" and len(tr.get("code_verifier", "")) >= 43 and tr.get("resource") == "https://mcp.notion.com/mcp", tr)
        pages = ns["pages"]
        root = [p for p in pages.values() if p["title"] == "Lectern" and p["parent"] is None]
        vids = [p for p in pages.values() if p["title"] and p["parent"] and "Synced from Lectern" in p["content"]]
        root_id = root[0]["id"] if root else None
        folder_pages = {k for k, p in pages.items() if k != root_id and "Synced from Lectern" not in p["content"]}

        def reaches_root(k, hops=0):
            parent = pages[k]["parent"]
            return parent == root_id or (parent in folder_pages and hops < 10 and reaches_root(parent, hops + 1))
        check("Notion gets a Lectern page, a page per folder and one per video", len(root) == 1 and folder_pages and len(vids) == 5 and all(p["parent"] in folder_pages or p["parent"] == root_id for p in vids) and all(reaches_root(k) for k in folder_pages), [(p["title"], p["parent"]) for p in pages.values()])
        a_page = next((p for p in vids if p["title"].startswith("Neural networks")), None)
        check("a video's Notion page has its notes, without repeating the title", a_page and "[0:20](" in a_page["content"] and "Folder sync marker" in a_page["content"] and not a_page["content"].startswith("# "), (a_page or {}).get("content", "")[:200])
        edit_video("v => v.notes.push({ id: 'notionmark', t: 44, text: 'Notion sync marker', createdAt: Date.now(), updatedAt: Date.now() })")
        lib.click("[data-target=notion] button:has-text('Sync now')")
        ok = wait_until(lambda: any(c["name"] == "notion-update-page" and c["args"].get("command") == "replace_content" and "Notion sync marker" in c["args"].get("new_str", "") for c in notion_state()["calls"]), 10)
        check("changed notes replace the Notion page's content", ok)
        edit_video("v => { v.title = 'Gradient descent, renamed' }")
        ok = wait_until(lambda: any(p["title"] == "Gradient descent, renamed" for p in notion_state()["pages"].values()), 20)
        check("Notion follows changes on its own, a few seconds later", ok)
        backup_keys = lib.evaluate("import('../shared/db.js').then(d => d.exportAll()).then(b => Object.keys(b.data))")
        check("backups leave out the Notion sign-in and folder sync state", "nsync" not in backup_keys and "fsync" not in backup_keys)
        lib.screenshot(path=f"{SHOTS}/21-settings-sync.png", full_page=True)
        lib.click("[data-target=notion] button:has-text('Disconnect')")
        lib.click("dialog.dlg:not(.settings) .btn.danger")
        ok = wait_until(lambda: "Connect Notion" in lib.inner_text("[data-target=notion]"), 5)
        check("disconnecting Notion forgets the sign-in", ok and not lib.evaluate("chrome.storage.local.get('nsync').then(r => !!(r.nsync && r.nsync.auth))"))
        lib.click("dialog.settings .btn.primary:has-text('Done')")
        edit_video("v => { v.title = 'Neural networks: how gradient descent learns' }")

        # the panel's menu leads straight to the Sync settings
        panel.bring_to_front()
        panel.click("button[aria-label='More actions for this video']")
        panel.click(".menu button:has-text('Sync to Notion or Obsidian')")
        # Lectern reuses whichever library tab it finds, and this test has opened more than one
        def library_with_sync():
            for pg in ctx.pages:
                if "library.html" in pg.url and "settings=" not in pg.url and pg.locator("dialog.settings .set-sync [data-target=notion]").count() == 1:
                    return pg
            return None

        target = wait_until(library_with_sync, 8)
        check("the panel's Sync item opens Settings at Sync", bool(target), [pg.url for pg in ctx.pages if "library.html" in pg.url])
        if target:
            # close it directly: a click in a background tab never counts as settled, since nothing paints there
            target.evaluate("document.querySelector('dialog.settings').close()")

        # ---------- "open the panel when I watch a video"
        def last_auto_open():
            return sw.evaluate("chrome.storage.session.get('lastAutoOpen').then(r => r.lastAutoOpen || null)")

        def set_auto_open(on):
            sw.evaluate("chrome.storage.local.get('settings').then(r => chrome.storage.local.set({settings: {...(r.settings || {}), autoOpenPanel: %s}}))" % ("true" if on else "false"))
            time.sleep(0.5)

        sw.evaluate("chrome.storage.session.remove('lastAutoOpen')")
        set_auto_open(False)
        yt.bring_to_front()
        yt.mouse.click(8, 400)
        time.sleep(0.8)
        check("with the setting off, clicking a video's page leaves the panel alone", last_auto_open() is None)
        set_auto_open(True)
        yt.mouse.click(8, 400)
        first = wait_until(last_auto_open, 4)
        vid_now = (re.search(r"v=([\w-]{11})", yt.url) or [None, None])[1]
        check("with it on, the first click on a video's page opens the panel", bool(first) and first.get("videoId") == vid_now, (first, vid_now))
        yt.mouse.click(10, 402)
        yt.keyboard.press("ArrowRight")
        time.sleep(0.8)
        check("…once per video, not on every click", bool(first) and (last_auto_open() or {}).get("at") == first.get("at"))
        set_auto_open(False)

        # empty panel state (non-YouTube tab)
        other = ctx.new_page()
        other.goto("https://www.youtube.com/feed/subscriptions")
        empty = ctx.new_page()
        empty.set_viewport_size({"width": 400, "height": 900})
        watch_console(empty, "panel-empty")
        other_id = lib.evaluate("chrome.tabs.query({url: 'https://www.youtube.com/feed/*'}).then(t => t[0].id)")
        empty.goto(f"{base}/src/sidepanel/sidepanel.html?tab={other_id}")
        empty.wait_for_selector(".empty-view:not([hidden]) .recent-item", timeout=6000)
        check("panel on other pages shows recently studied videos", empty.locator(".recent-item").count() >= 3)
        empty.screenshot(path=f"{SHOTS}/12-panel-empty.png")
        # non-YouTube tab: panel must still render (regression: blank panel)
        blank_id = sw.evaluate("chrome.tabs.create({url: 'about:blank', active: false}).then(t => t.id)")
        e2 = ctx.new_page()
        e2.goto(f"{base}/src/sidepanel/sidepanel.html?tab={blank_id}")
        ok = wait_until(lambda: e2.locator(".empty-view h1").count() and "Open a YouTube video" in e2.inner_text(".empty-view h1"), 5)
        check("panel renders on non-YouTube tabs", ok)
        # Library button reuses the open library tab
        before_n = sw.evaluate("chrome.runtime.getContexts({contextTypes:['TAB']}).then(c => c.filter(x => x.documentUrl.includes('library.html')).length)")
        e2.click(".open-lib")
        time.sleep(1.0)
        after_n = sw.evaluate("chrome.runtime.getContexts({contextTypes:['TAB']}).then(c => c.filter(x => x.documentUrl.includes('library.html')).length)")
        check("Library button reuses the library tab", after_n == before_n, f"{before_n} -> {after_n}")

    except Exception:
        traceback.print_exc()
        results.append(("script crashed", False, traceback.format_exc()[-400:]))
    finally:
        print("\nConsole errors:")
        for e in errors:
            print("  ", e)
        ctx.close()

    real_manifest_checks(p)

passed = sum(1 for r in results if r[1])
print(f"\n{passed}/{len(results)} checks passed")
for name, ok, detail in results:
    if not ok:
        print("FAILED:", name, detail)
sys.exit(0 if results and passed == len(results) else 1)
