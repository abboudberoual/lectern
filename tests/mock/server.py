"""Mock www.youtube.com + i.ytimg.com for testing the extension offline.

Mirrors the behaviours that matter:
  * caption URLs (/api/timedtext) return 200 + empty body unless the request carries
    the player's `pot` token (video A), or always (video B)
  * get_transcript returns 400 (needs attestation)
  * video B has the new transcript panel (transcript-segment-view-model rows)
  * video C has no captions
"""
import http.server, json, os, re, ssl, socketserver, sys, threading, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
STATS = {"timedtext": [], "get_transcript": 0}

VIDEOS = {
    "AAAAAAAAAAA": {"title": "Neural networks: how gradient descent learns", "channel": "Lattice Lectures", "captions": "pot", "len": 180},
    "BBBBBBBBBBB": {"title": "Backpropagation, step by step", "channel": "Lattice Lectures", "captions": "panel", "len": 180},
    "CCCCCCCCCCC": {"title": "Chord progressions for beginners", "channel": "Practice Room", "captions": None, "len": 180},
    "DDDDDDDDDDD": {"title": "Intervals and scales explained", "channel": "Practice Room", "captions": None, "len": 180},
    "EEEEEEEEEEE": {"title": "Fourier series & the heat equation", "channel": "Lattice Lectures", "captions": "plain-xml", "len": 180},
}

LINES_A = [
    "welcome back today we're looking at how a network actually learns",
    "the cost function measures how wrong the network is on the training data",
    "gradient descent nudges every weight a little bit downhill",
    "think of the cost as a landscape with hills and valleys",
    "the gradient points in the direction of steepest ascent",
    "so we step in the opposite direction, the negative gradient",
    "the learning rate controls how big each step is",
    "too large and you overshoot the minimum, too small and it takes forever",
    "a local minimum isn't necessarily the global minimum",
    "stochastic gradient descent uses small random batches of data",
    "each batch gives a noisy but cheap estimate of the gradient",
    "that noise can actually help escape shallow local minima",
    "backpropagation is the algorithm that computes these gradients efficiently",
    "we'll cover backpropagation in detail in the next video",
    "for now remember that learning is just minimizing a cost function",
    "the weights and biases are the knobs the network can turn",
    "a network with thirteen thousand weights lives in a huge space",
    "visualizing that space directly is impossible, so we use intuition",
    "momentum keeps the descent moving through flat regions",
    "and that's the core idea behind how neural networks learn",
]
LINES_B = [
    "backpropagation computes how sensitive the cost is to each weight",
    "start at the output layer and work backwards",
    "the chain rule ties each layer's sensitivity to the next",
    "neurons that fire together wire together, loosely speaking",
    "each training example wants to nudge the weights its own way",
    "we average those nudges across a mini-batch",
    "the derivative of the activation function matters a lot here",
    "vanishing gradients happen when those derivatives are tiny",
    "relu helps because its derivative is one for positive inputs",
    "putting it all together gives the full gradient vector",
]


def json3(lines, step=6.0):
    events = [{"tStartMs": 0, "dDurationMs": int(len(lines) * step * 1000), "id": 1, "wpWinPosId": 1, "wsWinStyleId": 1}]
    for i, text in enumerate(lines):
        t = int(i * step * 1000)
        words = text.split(" ")
        events.append({
            "tStartMs": t, "dDurationMs": int(step * 1000), "wWinId": 1,
            "segs": [{"utf8": words[0]}] + [{"utf8": " " + w, "tOffsetMs": 200 * (k + 1)} for k, w in enumerate(words[1:])],
        })
        events.append({"tStartMs": t + 5900, "dDurationMs": 100, "wWinId": 1, "aAppend": 1, "segs": [{"utf8": "\n"}]})
    return json.dumps({"wireMagic": "pb3", "pens": [{}], "events": events})


def player_response(vid):
    v = VIDEOS[vid]
    pr = {"videoDetails": {"videoId": vid, "title": v["title"], "author": v["channel"], "lengthSeconds": str(v["len"])}}
    if v["captions"]:
        base = f"https://www.youtube.com/api/timedtext?v={vid}&ei=xyz&caps=asr&opi=1&exp=xpe&xoaf=5&hl=en&ip=0.0.0.0&ipbits=0&expire=9999999999&sparams=ip,ipbits,expire,v,ei,caps,opi,exp,xoaf&signature=ABC&key=yt8&kind=asr&lang=en"
        pr["captions"] = {"playerCaptionsTracklistRenderer": {"captionTracks": [
            {"baseUrl": base, "name": {"runs": [{"text": "English (auto-generated)"}]}, "vssId": "a.en", "languageCode": "en", "kind": "asr", "isTranslatable": True},
            {"baseUrl": base.replace("&kind=asr&lang=en", "&lang=fr"), "name": {"runs": [{"text": "French"}]}, "vssId": ".fr", "languageCode": "fr", "isTranslatable": True},
        ]}}
    return pr


PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>{title} - YouTube</title>
<style>
body{{margin:0;font-family:Roboto,Arial,sans-serif;background:#0f0f0f;color:#f1f1f1}}
ytd-app{{display:block}} ytd-watch-flexy{{display:flex;gap:24px;padding:24px}}
#primary{{width:760px}} #movie_player{{position:relative;width:760px;height:428px;background:#000;border-radius:12px;overflow:hidden}}
#movie_player video{{width:100%;height:100%;object-fit:cover}}
.ytp-chrome-bottom{{position:absolute;left:0;right:0;bottom:0;height:48px;display:flex;justify-content:flex-end;align-items:center;background:linear-gradient(transparent,rgba(0,0,0,.7));padding:0 12px}}
.ytp-right-controls{{display:flex;gap:4px}} .ytp-button{{width:48px;height:48px;border:0;background:none;color:#fff;cursor:pointer;padding:6px}}
.caption-window{{position:absolute;bottom:60px;left:50%;transform:translateX(-50%);background:rgba(8,8,8,.75);padding:4px 8px;font-size:18px}}
#movie_player.ad-showing::after{{content:'Ad';position:absolute;top:8px;left:8px;background:#fc0;color:#000;padding:2px 6px}}
h1{{font-size:20px;margin:12px 0 6px}} a{{color:#aaa}}
ytd-engagement-panel-section-list-renderer{{display:block;width:400px;background:#212121;border-radius:12px;padding:12px}}
ytd-engagement-panel-section-list-renderer[visibility=ENGAGEMENT_PANEL_VISIBILITY_HIDDEN]{{display:none}}
transcript-segment-view-model{{display:flex;gap:12px;padding:4px 0}} timeline-chapter-view-model{{display:block;font-weight:bold;margin:8px 0}}
.ytwTranscriptSegmentViewModelTimestampA11yLabel{{position:absolute;left:-9999px}}
</style></head><body>
<ytd-app><ytd-watch-flexy video-id="{vid}">
 <div id="primary">
  <div id="movie_player" class="html5-video-player">
   <video class="html5-main-video" src="/media/test.webm" muted playsinline autoplay loop></video>
   <div class="caption-window" hidden>captions on</div>
   <div class="ytp-chrome-bottom"><div class="ytp-right-controls"><button class="ytp-button ytp-settings-button" aria-label="Settings">⚙</button></div></div>
  </div>
  <ytd-watch-metadata><div id="title"><h1><yt-formatted-string>{title}</yt-formatted-string></h1></div>
   <div id="owner"><ytd-video-owner-renderer><ytd-channel-name id="channel-name"><a href="/@x">{channel}</a></ytd-channel-name></ytd-video-owner-renderer></div>
   <div id="description">{transcript_button}</div>
  </ytd-watch-metadata>
 </div>
 <div id="secondary"><ytd-engagement-panel-section-list-renderer target-id="PAmodern_transcript_view" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"><div id="content"></div></ytd-engagement-panel-section-list-renderer></div>
</ytd-watch-flexy></ytd-app>
<script>
var ytInitialPlayerResponse = {pr};
var ytInitialData = {{"engagementPanels":[{{"engagementPanelSectionListRenderer":{{"content":{{"continuationItemRenderer":{{"continuationEndpoint":{{"getTranscriptEndpoint":{{"params":"CgtBQUFBQUFBQUFBQQ"}}}}}}}}}}}}]}};
window.ytcfg = {{ d: {{INNERTUBE_CONTEXT:{{client:{{clientName:"WEB",clientVersion:"2.20261101.00.00"}}}}, INNERTUBE_API_KEY:"testkey", INNERTUBE_CLIENT_VERSION:"2.20261101.00.00", INNERTUBE_CONTEXT_CLIENT_NAME:1}}, get(k){{ return this.d[k]; }} }};
(function(){{
  const CFG = {cfg};
  const tt = trustedTypes.createPolicy('default', {{ createHTML: (s) => s }});
  const mp = document.getElementById('movie_player');
  let track = {{}};
  mp.getPlayerResponse = () => window.ytInitialPlayerResponse;
  mp.getOption = (m, k) => (m === 'captions' && k === 'track' ? track : undefined);
  mp.setOption = (m, k, v) => {{
    if (m !== 'captions' || k !== 'track') return;
    track = v || {{}};
    document.querySelector('.caption-window').hidden = !track.languageCode;
    window.__captionToggles = (window.__captionToggles || 0) + 1;
    if (CFG.forceFetch && track.languageCode) {{
      const id = window.ytInitialPlayerResponse.videoDetails.videoId;
      fetch('/api/timedtext?v=' + id + '&ei=xyz&caps=asr&opi=1&exp=xpe&xoaf=5&hl=en&ip=0.0.0.0&ipbits=0&expire=9999999999&signature=ABC&key=yt8&kind=asr&lang=' + track.languageCode + '&fmt=json3&xorb=2&xobt=3&xovt=3&cbr=Chrome&c=WEB&cver=2.20261101&pot=MnTestPotTokenBoundTo' + id).then(r => r.text());
    }}
  }};
  mp.loadModule = () => {{}};
  mp.unloadModule = () => {{ track = {{}}; document.querySelector('.caption-window').hidden = true; }};
  const btn = document.querySelector('ytd-video-description-transcript-section-renderer button');
  if (btn) btn.addEventListener('click', () => {{
    const panel = document.querySelector('[target-id="PAmodern_transcript_view"]');
    panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
    setTimeout(() => {{
      const host = panel.querySelector('#content');
      host.innerHTML = '<timeline-chapter-view-model>Intro</timeline-chapter-view-model>' + CFG.panelLines.map((t, i) => {{
        const s = i * 7; const ts = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        return '<transcript-segment-view-model><div class="ytwTranscriptSegmentViewModelTimestamp">' + ts + '</div><span class="ytwTranscriptSegmentViewModelTimestampA11yLabel">' + s + ' seconds</span><span class="ytAttributedStringHost">' + t + '</span></transcript-segment-view-model>';
      }}).join('');
    }}, 500);
  }});
  // SPA navigation like YouTube's
  window.__mockNavigate = (id, meta) => {{
    history.pushState(null, '', '/watch?v=' + id);
    document.querySelector('ytd-watch-flexy').setAttribute('video-id', id);
    document.querySelector('ytd-watch-metadata h1 yt-formatted-string').textContent = meta.title;
    document.querySelector('ytd-channel-name a').textContent = meta.channel;
    document.title = meta.title + ' - YouTube';
    window.ytInitialPlayerResponse = meta.pr;
    const v = document.querySelector('video'); v.currentTime = 0;
    window.dispatchEvent(new CustomEvent('yt-navigate-finish'));
  }};
}})();
</script></body></html>"""



# ---------- mock Notion (OAuth + hosted MCP server at mcp.notion.com)

import base64, hashlib, uuid

NOTION = {"clients": {}, "codes": {}, "tokens": set(), "refresh": set(), "sessions": set(), "pages": {}, "calls": [], "token_requests": []}
NOTION_TOOLS = ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page", "notion-move-pages"]


def notion_url(pid):
    return "https://www.notion.so/" + pid.replace("-", "")


def notion_tool(name, args):
    """Returns (is_error, text)."""
    NOTION["calls"].append({"name": name, "args": args})
    pages = NOTION["pages"]
    if name == "notion-create-pages":
        parent = (args.get("parent") or {}).get("page_id")
        if parent and parent.replace("-", "") not in pages:
            return True, f"Could not find parent page with ID {parent}"
        out = []
        for spec in args.get("pages", []):
            pid = str(uuid.uuid4())
            key = pid.replace("-", "")
            pages[key] = {"id": key, "title": (spec.get("properties") or {}).get("title", ""), "content": spec.get("content", ""), "parent": parent.replace("-", "") if parent else None}
            out.append({"id": pid, "url": notion_url(pid), "properties": {"title": pages[key]["title"]}})
        return False, json.dumps({"pages": out})
    if name == "notion-update-page":
        key = (args.get("page_id") or "").replace("-", "")
        if key not in pages:
            return True, f"Could not find page with ID {args.get('page_id')}"
        cmd = args.get("command")
        if cmd == "update_properties":
            pages[key]["title"] = (args.get("properties") or {}).get("title", pages[key]["title"])
        elif cmd == "replace_content":
            pages[key]["content"] = args.get("new_str", "")
        else:
            return True, f"Unsupported command {cmd}"
        return False, json.dumps({"page_id": key})
    if name == "notion-move-pages":
        target = ((args.get("new_parent") or {}).get("page_id") or "").replace("-", "")
        if target not in pages:
            return True, "Could not find the new parent page"
        for pid in args.get("page_or_database_ids", []):
            if pid.replace("-", "") in pages:
                pages[pid.replace("-", "")]["parent"] = target
        return False, json.dumps({"result": "moved"})
    return True, f"Unknown tool {name}"


def s256(verifier):
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


def notion_get(h, u, q):
    meta = {
        "issuer": "https://mcp.notion.com",
        "authorization_endpoint": "https://mcp.notion.com/authorize",
        "token_endpoint": "https://mcp.notion.com/token",
        "registration_endpoint": "https://mcp.notion.com/register",
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
    }
    if u.path == "/mcp/.well-known/oauth-protected-resource":  # where Notion documents it
        return h.send(200, json.dumps({"resource": "https://mcp.notion.com/mcp", "authorization_servers": ["https://mcp.notion.com"]}), "application/json")
    if u.path == "/.well-known/oauth-authorization-server":
        return h.send(200, json.dumps(meta), "application/json")
    if u.path == "/authorize":
        g = lambda k: (q.get(k) or [""])[0]
        client = NOTION["clients"].get(g("client_id"))
        if not client or g("redirect_uri") not in client["redirect_uris"] or g("code_challenge_method") != "S256" or not g("code_challenge"):
            return h.send(400, "bad authorize request")
        code = "code-" + uuid.uuid4().hex[:8]
        NOTION["codes"][code] = {"challenge": g("code_challenge"), "redirect_uri": g("redirect_uri"), "client_id": g("client_id"), "resource": g("resource")}
        loc = g("redirect_uri") + "?" + urllib.parse.urlencode({"code": code, "state": g("state")})
        return h.send(302, "", "text/plain", {"Location": loc})
    if u.path == "/__notion":
        return h.send(200, json.dumps({k: (sorted(v) if isinstance(v, set) else v) for k, v in NOTION.items()}), "application/json")
    if u.path == "/__notion_reset":
        for k in ("pages", "calls", "token_requests"):
            NOTION[k] = {} if k == "pages" else []
        return h.send(200, "ok")
    return h.send(404, "not found")


def notion_post(h, u, raw):
    if u.path == "/register":
        body = json.loads(raw or b"{}")
        cid = "client-" + uuid.uuid4().hex[:8]
        NOTION["clients"][cid] = {"redirect_uris": body.get("redirect_uris", []), "name": body.get("client_name")}
        return h.send(201, json.dumps({"client_id": cid, "redirect_uris": body.get("redirect_uris", []), "token_endpoint_auth_method": "none"}), "application/json")
    if u.path == "/token":
        f = {k: v[0] for k, v in urllib.parse.parse_qs(raw.decode()).items()}
        NOTION["token_requests"].append(f)
        if f.get("grant_type") == "authorization_code":
            c = NOTION["codes"].pop(f.get("code", ""), None)
            if not c or c["client_id"] != f.get("client_id") or c["redirect_uri"] != f.get("redirect_uri") or s256(f.get("code_verifier", "")) != c["challenge"]:
                return h.send(400, json.dumps({"error": "invalid_grant"}), "application/json")
        elif f.get("grant_type") == "refresh_token":
            if f.get("refresh_token") not in NOTION["refresh"]:
                return h.send(400, json.dumps({"error": "invalid_grant"}), "application/json")
            NOTION["refresh"].discard(f.get("refresh_token"))
        else:
            return h.send(400, json.dumps({"error": "unsupported_grant_type"}), "application/json")
        access, refresh = "acc-" + uuid.uuid4().hex, "ref-" + uuid.uuid4().hex
        NOTION["tokens"].add(access)
        NOTION["refresh"].add(refresh)
        return h.send(200, json.dumps({"access_token": access, "refresh_token": refresh, "token_type": "bearer", "expires_in": 28800}), "application/json")
    if u.path == "/mcp":
        # Like MCP servers that guard against DNS rebinding: requests carrying a browser Origin are refused
        if h.headers.get("Origin"):
            NOTION.setdefault("refused_origins", []).append(h.headers.get("Origin"))
            return h.send(403, json.dumps({"jsonrpc": "2.0", "error": {"code": -32000, "message": "Forbidden: Invalid Origin header"}, "id": None}), "application/json")
        token = (h.headers.get("Authorization") or "").replace("Bearer ", "")
        if token not in NOTION["tokens"]:
            return h.send(401, json.dumps({"error": "invalid_token"}), "application/json", {"WWW-Authenticate": 'Bearer resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp"'})
        msg = json.loads(raw or b"{}")
        method = msg.get("method")
        if method == "initialize":
            sid = uuid.uuid4().hex
            NOTION["sessions"].add(sid)
            res = {"protocolVersion": msg["params"].get("protocolVersion"), "capabilities": {"tools": {}}, "serverInfo": {"name": "mock-notion", "version": "1"}}
            return h.send(200, json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": res}), "application/json", {"Mcp-Session-Id": sid})
        if (h.headers.get("Mcp-Session-Id") or "") not in NOTION["sessions"]:
            return h.send(404, "unknown session")
        if "id" not in msg:
            return h.send(202, "")
        if method == "tools/list":
            result = {"tools": [{"name": n, "inputSchema": {"type": "object"}} for n in NOTION_TOOLS]}
            return h.send(200, json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), "application/json")
        if method == "tools/call":
            err, text = notion_tool(msg["params"]["name"], msg["params"].get("arguments") or {})
            result = {"content": [{"type": "text", "text": text}], "isError": err}
            # tool replies come back as a stream, like the real server can send them
            return h.sse([(None, json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}))])
        return h.send(200, json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "Method not found"}}), "application/json")
    return h.send(404, "not found")


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype="text/plain", extra=None):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def sse(self, events):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for name, data in events:
            chunk = (f"event: {name}\n" if name else "") + f"data: {data}\n\n"
            self.wfile.write(chunk.encode())
            self.wfile.flush()
            time.sleep(0.03)
        self.close_connection = True

    def ai_answer(self, body):
        """A canned answer that proves the context arrived: it echoes the moment asked about."""
        msgs = body.get("messages", [])
        last = msgs[-1]["content"] if msgs else ""
        system = body.get("system")
        sys_text = system[0]["text"] if isinstance(system, list) else next((m["content"] for m in msgs if m.get("role") == "system"), "")
        has_tr = "learning rate controls" in sys_text
        m = re.search(r"moment (?:at|around) \((\d+:\d\d)\)", last)
        if m:
            return f"At ({m.group(1)}) the video says **the step size matters**:\n\n- too large overshoots\n- too small is slow\n\nSee also (0:42)."
        if "Summarize" in last:
            return ("**Summary.** Gradient descent lowers the cost by stepping against the gradient (0:24).\n\n"
                    "1. The cost measures error (0:06)\n2. The learning rate sets the step (0:36)\n" + ("" if has_tr else "\n(no transcript)"))
        return f"You asked: {last[-60:]}. Transcript received: {'yes' if has_tr else 'no'}."

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        host = (self.headers.get("Host") or "").split(":")[0]
        if host == "mcp.notion.com":
            return notion_post(self, u, raw)
        if host in ("api.anthropic.com", "api.openai.com"):
            body = json.loads(raw or b"{}")
            STATS.setdefault("ai", []).append({"host": host, "path": u.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
            key = self.headers.get("x-api-key") or (self.headers.get("authorization") or "").replace("Bearer ", "")
            if "bad" in key:
                return self.send(401, json.dumps({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}), "application/json")
            text = self.ai_answer(body)
            words = re.findall(r"\S+\s*|\n", text)
            if host == "api.anthropic.com" and u.path == "/v1/messages":
                ev = [("message_start", json.dumps({"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant", "content": [], "model": body.get("model"), "usage": {"input_tokens": 10, "output_tokens": 1}}})),
                      ("content_block_start", json.dumps({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})),
                      ("ping", json.dumps({"type": "ping"}))]
                ev += [("content_block_delta", json.dumps({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": w}})) for w in words]
                ev += [("content_block_stop", json.dumps({"type": "content_block_stop", "index": 0})),
                       ("message_delta", json.dumps({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 30}})),
                       ("message_stop", json.dumps({"type": "message_stop"}))]
                return self.sse(ev)
            if host == "api.openai.com" and u.path == "/v1/chat/completions":
                ev = [(None, json.dumps({"id": "c1", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}}]}))]
                ev += [(None, json.dumps({"id": "c1", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": w}}]})) for w in words]
                ev += [(None, json.dumps({"id": "c1", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})), (None, "[DONE]")]
                return self.sse(ev)
            return self.send(404, "{}", "application/json")
        if u.path.startswith("/youtubei/v1/get_transcript"):
            STATS["get_transcript"] += 1
            return self.send(400, json.dumps({"error": {"code": 400, "message": "Precondition check failed.", "status": "FAILED_PRECONDITION"}}), "application/json")
        self.send(404)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        host = (self.headers.get("Host") or "").split(":")[0]

        if host == "mcp.notion.com":
            return notion_get(self, u, q)

        if host in ("api.anthropic.com", "api.openai.com") and u.path == "/v1/models":
            key = self.headers.get("x-api-key") or (self.headers.get("authorization") or "").replace("Bearer ", "")
            STATS.setdefault("ai_models", []).append({"host": host, "key": key})
            if "bad" in key:
                return self.send(401, json.dumps({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}), "application/json")
            return self.send(200, json.dumps({"data": [{"id": "x"}]}), "application/json")

        if host == "i.ytimg.com":
            parts = u.path.split("/")
            vid = parts[2] if len(parts) > 2 else ""
            p = os.path.join(HERE, f"thumb_{vid}.jpg")
            if os.path.exists(p):
                return self.send(200, open(p, "rb").read(), "image/jpeg")
            return self.send(404)

        if u.path == "/__stats":
            return self.send(200, json.dumps(STATS), "application/json")
        if u.path == "/__ai":
            return self.send(200, json.dumps({"calls": STATS.get("ai", []), "models": STATS.get("ai_models", [])}), "application/json")
        if u.path == "/__reset":
            STATS["timedtext"].clear()
            STATS["get_transcript"] = 0
            return self.send(200, "ok")

        if u.path == "/watch":
            vid = (q.get("v") or [""])[0]
            if vid not in VIDEOS:
                return self.send(404, "no such video")
            v = VIDEOS[vid]
            cfg = {"forceFetch": v["captions"] == "pot", "panelLines": LINES_B if v["captions"] == "panel" else []}
            tbtn = '<ytd-video-description-transcript-section-renderer><button aria-label="Show transcript">Show transcript</button></ytd-video-description-transcript-section-renderer>' if v["captions"] else ""
            html = PAGE.format(title=v["title"], channel=v["channel"], vid=vid, pr=json.dumps(player_response(vid)), cfg=json.dumps(cfg), transcript_button=tbtn)
            return self.send(200, html, "text/html; charset=utf-8", {"Content-Security-Policy": "require-trusted-types-for 'script'; trusted-types default dompurify goog#html"})

        if u.path == "/api/timedtext":
            vid = (q.get("v") or [""])[0]
            has_pot = "pot" in q
            STATS["timedtext"].append({"v": vid, "pot": has_pot, "fmt": (q.get("fmt") or [""])[0], "lang": (q.get("lang") or [""])[0]})
            v = VIDEOS.get(vid)
            if v and v["captions"] == "plain-xml":
                xml = '<?xml version="1.0" encoding="utf-8" ?><transcript><text start="0.5" dur="3.1">heat flows from hot to cold</text><text start="3.6" dur="2.9">fourier&amp;#39;s idea: write it as a sum of sines</text><text start="6.5" dur="3">each term &amp;amp; its frequency decays at its own rate</text></transcript>'
                return self.send(200, xml, "text/xml; charset=utf-8")
            if v and v["captions"] == "pot" and has_pot:
                lines = LINES_A if (q.get("lang") or ["en"])[0] == "en" else ["bienvenue", "aujourd'hui la descente de gradient", "le taux d'apprentissage"]
                return self.send(200, json3(lines), "application/json; charset=utf-8")
            return self.send(200, b"", "text/html; charset=utf-8")

        if u.path == "/oembed":
            target = (q.get("url") or [""])[0]
            vid = (urllib.parse.parse_qs(urllib.parse.urlparse(target).query).get("v") or [""])[0]
            if vid in VIDEOS:
                return self.send(200, json.dumps({"title": VIDEOS[vid]["title"], "author_name": VIDEOS[vid]["channel"], "type": "video"}), "application/json")
            return self.send(404, "Not Found")

        if u.path == "/media/test.webm":
            data = open(os.path.join(HERE, "test.webm"), "rb").read()
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):
                a, _, b = rng[6:].partition("-")
                a = int(a or 0)
                b = int(b) if b else len(data) - 1
                chunk = data[a : b + 1]
                return self.send(206, chunk, "video/webm", {"Content-Range": f"bytes {a}-{b}/{len(data)}", "Accept-Ranges": "bytes"})
            return self.send(200, data, "video/webm", {"Accept-Ranges": "bytes"})

        if u.path in ("/", "/feed/subscriptions"):
            return self.send(200, "<!doctype html><title>YouTube</title><h1>Home</h1>", "text/html")
        self.send(404)

    do_HEAD = do_GET


class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def ensure_cert():
    """A throwaway self-signed cert; the test browser runs with --ignore-certificate-errors."""
    d = os.path.join(HERE, ".cert")
    cert, key = os.path.join(d, "cert.pem"), os.path.join(d, "key.pem")
    if not (os.path.exists(cert) and os.path.exists(key)):
        import subprocess
        os.makedirs(d, exist_ok=True)
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
             "-subj", "/CN=www.youtube.com", "-keyout", key, "-out", cert],
            check=True, capture_output=True,
        )
    return cert, key


if __name__ == "__main__":
    # Port 443 because the browser reaches it as https://www.youtube.com (see tests/README).
    srv = S(("127.0.0.1", 443), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(*ensure_cert())
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    print("serving", flush=True)
    srv.serve_forever()
