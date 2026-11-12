"""Shared setup for tests/e2e.py and tests/screenshots.py: the mock server and the test browser."""
import atexit, json, os, shutil, socket, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.dirname(HERE)
OUT = os.path.join(HERE, ".out")
os.makedirs(OUT, exist_ok=True)

HOST_RULES = "MAP www.youtube.com 127.0.0.1, MAP i.ytimg.com 127.0.0.1, MAP api.anthropic.com 127.0.0.1, MAP api.openai.com 127.0.0.1"


def port_open():
    try:
        with socket.create_connection(("127.0.0.1", 443), timeout=0.5):
            return True
    except OSError:
        return False


def ensure_mock_server():
    """Start tests/mock/server.py unless something is already listening on 443."""
    if port_open():
        return
    log = open(os.path.join(OUT, "server.log"), "w")
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, "mock", "server.py")], stdout=log, stderr=subprocess.STDOUT)
    atexit.register(proc.terminate)
    for _ in range(50):
        if port_open():
            return
        if proc.poll() is not None:
            break
        time.sleep(0.2)
    log.close()
    sys.exit("Mock server didn't start. See tests/.out/server.log (it needs to listen on port 443).")


def build_test_ext():
    """A copy of the extension with Ask's optional hosts pre-granted.

    Headless Chromium can't answer the permission prompt Ask shows when you connect a key, so most
    runs use this copy. tests/e2e.py also checks the real manifest's behaviour separately.
    """
    dst = os.path.join(OUT, "ext")
    shutil.rmtree(dst, ignore_errors=True)
    os.makedirs(dst)
    for item in ("manifest.json", "src", "icons", "fonts"):
        src = os.path.join(EXT, item)
        (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, os.path.join(dst, item))
    path = os.path.join(dst, "manifest.json")
    m = json.load(open(path))
    m["host_permissions"] = m["host_permissions"] + m.get("optional_host_permissions", [])
    json.dump(m, open(path, "w"), indent=2)
    return dst


def launch(p, ext, profile, **kw):
    shutil.rmtree(profile, ignore_errors=True)
    opts = dict(channel="chromium", headless=True, viewport={"width": 1280, "height": 860})
    opts.update(kw)
    return p.chromium.launch_persistent_context(
        profile,
        args=[
            f"--disable-extensions-except={ext}",
            f"--load-extension={ext}",
            f"--host-resolver-rules={HOST_RULES}",
            "--ignore-certificate-errors",
            "--no-proxy-server",
            "--autoplay-policy=no-user-gesture-required",
        ],
        **opts,
    )
