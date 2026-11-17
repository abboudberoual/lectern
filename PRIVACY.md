# Lectern privacy policy

Last updated: November 17, 2026

Lectern is a browser extension for taking notes on YouTube videos. It has no account, no server and no analytics. The developer never receives your notes, your transcripts, your API key, your Notion sign-in or anything about how you use it.

## What Lectern stores, and where

Everything below is saved in Chrome's extension storage on your own computer:

- your time notes, notepad pages, folders and folder goals
- the transcripts of videos you save
- the titles, channels and lengths of saved videos, and how far you've watched each
- your settings
- your Claude (Anthropic) or OpenAI API key, if you add one to use Ask
- your Notion sign-in, if you connect Notion: a token that only works with Notion's MCP server, and a list of the Notion pages Lectern made
- the folder you chose for folder sync, if you turn it on, and a list of the files Lectern wrote there

## What leaves your computer

- **YouTube.** Lectern runs on youtube.com to read the video's time, jump to timestamps and read captions. It also asks YouTube's public oEmbed address for a video's title when you add a link. These requests go from your browser to YouTube, the same as watching.
- **Ask (optional).** Only if you add an API key and ask a question: your question, that video's transcript and your time notes for it are sent from your browser straight to the company whose key you added (Anthropic or OpenAI), under that company's terms. Your key is sent only to that company.
- **Notion sync (optional).** Only if you connect Notion: your notes, notepad pages, folder names and video titles and links (and transcripts, if you turn that on) are sent from your browser to Notion's MCP server, which writes them to pages in your Notion workspace, under Notion's terms. You sign in on Notion's own page; Lectern never sees your Notion password.
- **Folder sync (optional).** Only if you turn it on: Lectern writes your notes as Markdown files into the folder you chose on your computer. Nothing is sent over the network, but any app or sync service that reads that folder (Obsidian Sync, iCloud, Dropbox) will see the files.
- **Exports.** Markdown, Word and PDF exports are made in your browser and saved where you choose.
- **Reporting a problem (optional).** "Report this video" and "Report a problem" open a page on GitHub with details filled in: Lectern and Chrome versions, the video link and, for transcript problems, which capture methods were tried. Nothing is sent unless you submit that page yourself, and GitHub issues are public.

Nothing else is sent anywhere. Lectern doesn't sell, share or use your data for anything other than taking and organizing your notes.

## Backups

Export backup (in Settings) saves your notes, folders and transcripts to a file you choose. Your API key and Notion sign-in are never included.

## Deleting your data

- Remove a video from your library and its notes, notepad pages, transcript and watch position are deleted with it. Notes can be deleted one at a time.
- Remove your API key in Settings, under Ask about videos.
- Disconnect Notion or stop folder sync in Settings, under Sync. The pages and files Lectern already made stay where they are, in Notion and in your folder, for you to keep or delete.
- Uninstalling Lectern deletes everything it stored. Export a backup first if you want to keep your notes.

## Changes

Changes to this policy are made in this file and noted in the release notes. If Lectern ever starts handling data differently, it will tell you in the extension before it does.

## Contact

Open an issue at https://github.com/abboudberoual/lectern/issues.
