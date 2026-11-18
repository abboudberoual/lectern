# Working on Lectern

Lectern is plain JavaScript with no build step: the files in `src/` are what Chrome runs.

## Run it

Load the repo folder at `chrome://extensions` with **Load unpacked**. After changing code, click the reload arrow on Lectern's card and reload any open YouTube tabs.

## Check it

```sh
npm install          # eslint, once
npm run lint

pip install playwright && python -m playwright install chromium
npm test             # same as: python3 tests/e2e.py
```

The end-to-end suite loads the extension in Chromium and points `www.youtube.com`, `api.anthropic.com` and `api.openai.com` at a mock server (`tests/mock/server.py`) that imitates the parts Lectern depends on: the player, caption requests that need the player's token, the transcript panel, videos without captions, Trusted Types, streaming AI answers, and Notion's sign-in and MCP server (`mcp.notion.com`). Folder sync is tested with the browser's private file system standing in for a folder the person picks. It starts the mock server itself.

The mock listens on `127.0.0.1:443`, so on Linux either run as root or allow low ports once:

```sh
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=0
```

Screenshots from each run land in `tests/.out/shots`. `python3 tests/screenshots.py` regenerates the README images in `docs/screenshots`. The store images in `docs/store` come from real screenshots of Lectern in Chrome, kept in `docs/store/source`: replace those and run `python3 scripts/store_images.py` to rebuild the five 1280×800 images and the promo tile. `python3 scripts/make_icons.py` redraws the icons.

Ask's hosts are optional permissions, and headless Chromium can't answer Chrome's permission prompt, so the suite runs on a copy of the extension with those hosts pre-granted (`tests/harness.py`), then checks the real manifest separately.

## When transcript capture breaks

That's usually YouTube changing its page. The code is in `src/transcript.js`, which tries four methods in order and records what each one did; the in-app report includes that record. Once you know what changed:

1. Fix the method in `src/transcript.js`.
2. Teach `tests/mock/server.py` the new behaviour, so the suite covers it from now on.
3. Run `npm test`.

## Layout

- `manifest.json`: extension definition
- `src/content.js`: runs on YouTube (video time, seeking, player button, watch position)
- `src/transcript.js`: transcript capture, injected into the YouTube page
- `src/background.js`: keyboard shortcuts, opening the panel, capture jobs
- `src/sidepanel/`: the notes panel and Ask
- `src/library/`: the library page
- `src/shared/`: storage, helpers, AI providers, export (`doc.js`, `docx.js`, `exporter.js`), sync (`foldersync.js`, `notion.js`) and the shared design tokens
- `src/print/`: the print-ready page behind PDF export
- `fonts/`: Atkinson Hyperlegible Next and Barlow Condensed (SIL Open Font License)

## Release

1. Bump `version` in `manifest.json` (and `package.json`).
2. Commit, then publish a release for the new version: on GitHub, **Releases → Draft a new release**, type a new tag like `v1.0.1`, and publish. (Or from a clone: `git tag v1.0.1 && git push origin v1.0.1`.)
3. The Release workflow builds `lectern-<version>.zip` and attaches it to a GitHub release. That zip is what you upload to the Chrome Web Store.

`python3 scripts/package.py` builds the same zip locally, in `dist/`.
