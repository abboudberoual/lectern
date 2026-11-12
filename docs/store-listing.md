# Chrome Web Store listing

Copy for the store dashboard. Keep "YouTube" out of the name: YouTube's branding rules allow describing an app as being *for* YouTube, but not using the name as part of the app's own name.

## Before submitting

- [ ] A week or two of everyday use on real YouTube, with a real Claude key and a real OpenAI key. Try Shorts, live streams, 2-hour-plus videos, non-English and auto-generated captions, videos with ads, and being signed out.
- [ ] Developer account: one-time $5 fee, and the EU trader/non-trader declaration.
- [ ] Bump the version if anything changed during testing, then push a tag (`git tag v1.0.0 && git push --tags`). The Release workflow attaches `lectern-<version>.zip`: that's the file to upload.
- [x] Icon without a play triangle (`scripts/make_icons.py`).
- [x] Install asks for youtube.com only; the Anthropic and OpenAI hosts are optional and requested when someone connects a key.
- [x] Screenshots and promo tile in `docs/store/` (regenerate with `python3 tests/screenshots.py`).

## Images

- Store icon: `icons/icon128.png` (96 px artwork with 16 px transparent padding, as the store asks)
- Screenshots, 1280×800, in this order: `docs/store/1-notes.png`, `2-folders.png`, `3-ask.png`, `4-transcript.png`, `5-search.png`
- Small promo tile, 440×280: `docs/store/promo-440x280.png`

## Name

Lectern

## Summary (132 characters max)

Timestamped notes, transcripts and topic folders for the YouTube videos you learn from. Private, no account, bring your own AI.

## Category

Education

## Description

Lectern is a study notebook for YouTube. Take notes that remember the moment you wrote them, keep each video's transcript with your notes, and line videos up in topic folders you can work through like a course.

WHAT MAKES IT DIFFERENT

• Private, no account. Your notes, transcripts and folders stay in Chrome on your computer. No sign-up, no server, no analytics.
• Folders that work like courses. Queue up videos for a topic in the order you'll study them, see how far you got in each, and mark them finished.
• Two kinds of notes. Time notes are stamped with the video time when you save them. A notepad with pages holds the ideas that aren't tied to one moment.
• The transcript stays with the video. Saved automatically, searchable alongside your notes, and every line jumps to its moment.
• Bring your own AI, or none. Ask Claude or OpenAI about the whole video or one moment with your own API key. Answers cite times you can click. Everything else works without it.

HOW IT WORKS

Open the notes panel beside any video (Alt+Shift+Y). Type a note and press Enter: it's stamped with the video time. Click any time to jump back. The library holds your folders, your progress in each video, and a search across every note and transcript.

AN HONEST NOTE ABOUT TRANSCRIPTS

YouTube has no public way for extensions to read transcripts, so Lectern reads them from the page the way your browser does. When YouTube changes its page, transcript capture can stop working until Lectern is updated. Your notes are never affected, you can always paste a transcript in yourself, and the Transcript tab has a one-click report link so it gets fixed quickly.

OPEN SOURCE

The code is on GitHub: https://github.com/abboudberoual/lectern

Lectern is not affiliated with YouTube, Google, Anthropic or OpenAI.

## Privacy tab

**Single purpose:** Take, organize and revisit study notes on YouTube videos.

**Permission justifications**

- `storage`, `unlimitedStorage`: saves the user's notes, folders and video transcripts locally. Transcripts for many long videos can exceed the default quota.
- `sidePanel`: the notes panel shown beside the video.
- `scripting`: injects the transcript reader into the YouTube tab when the user saves a video or clicks Get transcript, and into YouTube tabs already open when the extension is installed.
- `contextMenus`: the "Open library" item on the toolbar icon's menu.
- Host `https://www.youtube.com/*`: reads the current video time, jumps to timestamps, adds a note button to the player, and reads captions.
- Optional hosts `https://api.anthropic.com/*`, `https://api.openai.com/*`: not granted at install. Requested only when the user connects their own API key for the optional Ask feature, to send their question with the video's transcript and their notes. Released when they remove the key.

**Remote code:** No. All code is in the package.

**Data usage** (my reading of the form; check its current wording):

- Authentication information: yes. The user's own API key, stored locally and sent only to the provider it belongs to.
- Website content: yes. Video transcripts, stored locally and sent to the user's chosen AI provider only when they use Ask.
- Everything else: no.
- Certify all three: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:** https://github.com/abboudberoual/lectern/blob/main/PRIVACY.md
