# Lectern privacy policy

Last updated: November 12, 2026

Lectern is a browser extension for taking notes on YouTube videos. It has no account, no server and no analytics. The developer never receives your notes, your transcripts, your API key or anything about how you use it.

## What Lectern stores, and where

Everything below is saved in Chrome's extension storage on your own computer:

- your time notes, notepad pages, folders and folder goals
- the transcripts of videos you save
- the titles, channels and lengths of saved videos, and how far you've watched each
- your settings
- your Claude (Anthropic) or OpenAI API key, if you add one to use Ask

## What leaves your computer

- **YouTube.** Lectern runs on youtube.com to read the video's time, jump to timestamps and read captions. It also asks YouTube's public oEmbed address for a video's title when you add a link. These requests go from your browser to YouTube, the same as watching.
- **Ask (optional).** Only if you add an API key and ask a question: your question, that video's transcript and your time notes for it are sent from your browser straight to the company whose key you added (Anthropic or OpenAI), under that company's terms. Your key is sent only to that company.
- **Reporting a problem (optional).** "Report this video" and "Report a problem" open a page on GitHub with details filled in: Lectern and Chrome versions, the video link and, for transcript problems, which capture methods were tried. Nothing is sent unless you submit that page yourself, and GitHub issues are public.

Nothing else is sent anywhere. Lectern doesn't sell, share or use your data for anything other than taking and organizing your notes.

## Backups

Export backup (in Settings) saves your notes, folders and transcripts to a file you choose. Your API key is never included.

## Deleting your data

- Remove a video from your library and its notes, notepad pages, transcript and watch position are deleted with it. Notes can be deleted one at a time.
- Remove your API key in Settings, under Ask about videos.
- Uninstalling Lectern deletes everything it stored. Export a backup first if you want to keep your notes.

## Changes

Changes to this policy are made in this file and noted in the release notes. If Lectern ever starts handling data differently, it will tell you in the extension before it does.

## Contact

Open an issue at https://github.com/abboudberoual/lectern/issues.
