<p align="center">
  <img src="images/logo-icon.png" alt="Webring Studio logo" width="128" height="128" />
</p>

# Webring Studio

A desktop app for running your own corner of the web: a personal profile site that you publish as plain static files, linked to friends' sites and to webrings, with no server, platform or account in the middle.

> [!WARNING]
> **Webring Studio is in active development.** Features, data formats and published file layouts may change between versions without migration paths, and some parts are untested outside the developer's machine. Don't rely on it as your only copy of anything you care about, and expect rough edges.

## Overview

Webring Studio is split into two halves:

- **The engine: this desktop app (Electron).** You write posts, manage photo albums, follow friends and run webrings here. It keeps everything in a local SQLite database, signs what you publish, and fetches your friends' sites when you sync.
- **The artifact: your public site.** Publishing produces a folder of static files (HTML, JSON and media) that you can host anywhere: GitHub Pages, any SFTP/FTP host, or a folder on your own server. Nothing on the public site needs a server-side runtime.

Sites talk to each other only through those static files. Each site publishes signed JSON (`/api/manifest.json`, `profile.json`, `items.json`, `albums.json`, `connections.json`), and its identity is a [`did:web`](https://w3c-ccg.github.io/did-method-web/) with an Ed25519 key. When you sync, Studio pulls your friends' JSON, checks the signatures, and builds your feed locally. Likes, replies and comments you make become signed entries on *your* site, which the other person's Studio picks up the next time it syncs.

Highlights:

- Profile, wall posts, threaded replies, likes, shares and photo albums
- Friends, with a private-by-default social graph and mute/block
- Curated webrings with Prev / Next / Random navigation
- Multiple **personas**, fully separated from one another
- Scheduled syncing and publishing, running from the menu bar
- An MCP server so AI agents can work with Studio for you
- Optional add-ons: Google Analytics, AdSense and GitHub-based comments (all off by default)

## Installation

There are no packaged releases yet; run Webring Studio from source.

**Requirements**

- **Node.js 22.13 or newer** (Node 24 recommended) and npm. `npm install` refuses older versions. Ubuntu and Debian's `apt` package is too old (Node 18), so install Node with [nvm](https://github.com/nvm-sh/nvm) instead:
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  # open a new terminal, then:
  nvm install 24
  ```
  The repo includes an `.nvmrc`, so `nvm use` inside the project folder switches to the right version.
- **Git**
- **Linux only:** a Secret Service keyring (GNOME Keyring, or KWallet on KDE) so Studio can encrypt your keys and passwords. Ubuntu's desktop includes one.

**Steps**

```bash
git clone https://github.com/lnsCorey/webring.git
cd webring
npm install
npm run dev          # builds the UI and app, then opens Webring Studio (the first run downloads Electron)
```

Studio opens with a short splash (under 3 seconds) while it starts up. It's skipped when Studio starts at login in the background, when a `webring://` link opens it, or with `--no-splash`.

The first launch creates an empty primary persona. Start by setting your site's address and name in **Profile & Identity**. Your data lives in the app's data folder:

- macOS: `~/Library/Application Support/webring-studio`
- Windows: `%APPDATA%\webring-studio`
- Linux: `~/.config/webring-studio`

**Troubleshooting**

- **`EBADENGINE` / "Unsupported engine":** your Node is too old. Check with `node -v`, run `nvm install 24 && nvm use 24`, delete `node_modules`, and run `npm install` again.
- **"N vulnerabilities" after `npm install`:** npm's audit report about the project's dependencies; it doesn't mean the install failed. **Don't run `npm audit fix --force`**: it upgrades packages across major versions and will break the app.

## Getting started

1. **Set up your profile.** In **Profile & Identity**, set your site's public URL (for example `https://yourname.github.io` or your own domain), name, bio and links. Your `did:web` identity comes from that URL.

   For the **profile photo** and **banner**, upload a JPEG or PNG from your computer (or drop it on the preview), pick a photo from one of your albums, or enter an image address. Uploads are resized, have camera and GPS data removed, and are published with your site. There's only ever one of each: a new one replaces the old, and a replaced upload is deleted, from Studio and from your host at the next publish.
2. **Add content.** Write wall posts, create albums and add photos. Wall posts are written in **Markdown** (links, **bold** and *italic*, headings, lists, quotes and tables), with a Write / Preview switch; they're rendered safely on your page, and HTML is never passed through. To change a post, like, share or comment later, use its **Edit** (pencil) button in **Posts, Likes & Shares**. It keeps the same address, so friends' likes and comments stay attached; your page marks it as *edited*, and friends get the new version at their next sync.
3. **Preview.** **Test Export & Preview** builds the site into a scratch folder and serves it on `127.0.0.1`, so you can check it in a browser before publishing.
4. **Publish.** In **Publish & SFTP**, export to a folder, upload over SFTP/FTP, or push to GitHub Pages. The Publish tab shows when you last published and whether anything has changed since.
5. **Add friends.** In **Friends & Webrings**, add a friend's site URL, then **Sync All Friends**. Their posts appear in your **Neighborhood Feed**. The feed shows **Friends only** by default; switch to **Everyone** to see your own posts and photos in the same timeline (with friends' replies threaded under them), or **Just me**.
6. **Join or start a webring** (see below), and **set a schedule** so syncing and publishing happen on their own.

The in-app **Help & Deploy Guide** tab has step-by-step guides for GitHub Pages, SFTP/FTP hosting, add-ons, webrings and MCP.

## How it works

### Personas

A persona is a separate online identity: its own SQLite database, Ed25519 key, `did:web`, media folder, friends, rings, publish settings and schedule. Nothing is shared between personas, and Studio warns you if two personas point at the same domain, since that would link them. Switch or create personas from the persona button in the top bar.

### Security and privacy

- Your signing key, SFTP/FTP password and GitHub token are encrypted with your operating system's keychain (Keychain on macOS, DPAPI on Windows, libsecret on Linux). Studio never shows them again after you save them, and only unlocks them to sign or to connect when publishing.
- Every document you publish is signed. Friends' keys are pinned the first time Studio sees them, and a changed key is flagged rather than trusted.
- Friends are private by default: they aren't listed on your public site unless you mark them public.
- **Mute** hides a site from your feed. **Block** also stops crawling it and keeps its endorsements off your published site.
- When crawling, Studio refuses addresses on your own computer or local network, so a peer can't use it to probe devices behind your firewall.

If the keychain entry is lost, your signing key can't be recovered: you'd need a new key, and friends would see a key-changed warning.

### Site Design

The **Site Design** tab sets how your published page looks, with a live preview beside the controls:

- **Themes and templates:** four classic themes (Neo-Webring, Minimal Zine, Cyber Terminal, Cozy Scrapbook) change colours and fonts. Five social-style templates also rearrange the page, each echoing a familiar site without copying it:
  - **Facepace:** cover photo, an intro sidebar and a feed of post cards.
  - **Tweetdeck:** old-school sky blue, with every block in its own column.
  - **XtraSpecial:** a black timeline between a navigation rail and a widgets rail.
  - **Instapick:** a stats header, album highlights and a square photo grid.
  - **Tik Talk:** a dark vertical reel of tall media cards.

  Your blocks keep their order in every template. Friends, contact, links and the guestbook go in the sidebar or rail where a template has one. Each template offers a suggested block order you can apply with one click.
- **Look & feel:** accent colour (with a warning if it's hard to read on your theme), font, corner style, card or flat sections, background (theme, accent glow or blurred banner), banner height, profile photo shape and interactive extras.
- **Interactive extras** (on by default, in every theme and template): clicking a photo opens it full size, with previous/next (arrow keys or swipe) and its caption. **⤢ Open** shows a post in a larger view, and the address (`#post-…`, `#photo-…`) links straight to it. Tables in text blocks sort when you click a column heading. Like, Share, Comment, Add friend and Join ring first show a short note that the action happens in Webring Studio, with an **Open in Webring Studio** button and, for visitors without the app, the link to copy or share. Visitors can tick **Don't ask again on this site** to skip it. It's a few KB of built-in script with no library and nothing loaded from elsewhere. Turn it off in Site Design for a page with no extras.
- **Page layout:** your banner, photo, name, bio and links always stay at the top. Below them, arrange **blocks** by dragging (or with the arrow buttons): photo albums (grid or carousel, all or chosen albums), posts and shares (filter by kind, limit the count), friends, **text** (Markdown, including tables), an image, link buttons, a featured post or album, contact links and a guestbook. Hide a block without deleting it, rename its heading, or reset to the default layout.

Your design is saved in your signed `profile.json`, so it travels with your site. The published page and the preview come from the same code, so what you see is what gets published. Text blocks are rendered safely: HTML and unsafe links are never passed through.

**About the browser's "Open …?" prompt:** when a visitor confirms an action, the browser asks before opening Webring Studio. That prompt is part of the browser, so no page can change or skip it. Chrome and Edge offer **Always allow** for that site (on https pages). While you run Studio from source, the prompt names it "Electron", because browsers show the name of the program that registered `webring://`. An installed (packaged) build shows "Webring Studio".

### Media Library

The **Media Library** tab holds your photo albums. Add JPEG or PNG photos with **Add Photos** or by dropping them on an album, then caption them, add alt text, reorder them, pick a cover, or replace and delete photos.

Album descriptions are written in **Markdown** (headings, links, lists, quotes and tables), with a Write / Preview switch. They're rendered safely on your page: HTML and unsafe links are never passed through. Site Design text blocks use the same editor.

- **What gets published:** a web copy of each photo (longest side up to 2048 px) and a 480 px thumbnail, rotated upright, with all camera metadata, including GPS location, removed. Your originals stay on your computer.
- **Signed album manifests:** each album is published with `media/albums/<album>/manifest.json`, signed with your key, listing every photo and the exact file behind it (URL, SHA-256 hash, size, dimensions). File names are based on the content, so a replaced photo gets a new URL and nobody sees a stale copy.
- **Publishing only sends changes:** to a local folder, SFTP/FTP or GitHub Pages, Studio uploads only new or changed files and removes photos you deleted. It only ever removes files it published itself; anything else on your server or in your repo is left alone. If files there were changed by hand, use **Re-upload everything at next publish**.
- **Friends see changes on their next sync:** replaced photos update, and removed ones disappear from their feed.

### Feed window, saved posts and older posts

History grows forever, so Studio keeps syncing small on both sides:

- **Your feed keeps a window.** On the Neighborhood Feed, **Keep** sets how long friends' posts stay: 1 week, 1 month, 3 months (the default), 1 year or forever. Older posts aren't synced and are cleared from your feed. Friends' likes and comments on *your* posts are always kept.
- **Save what matters.** **☆ Save** on a friend's post or photo keeps a private copy under **Saved**, with a local copy of its image (re-encoded without metadata) and your own note. Saved posts stay after they leave your feed window or your friend removes them, and they're never published.
- **Unchanged files aren't downloaded.** Syncing asks each host whether a friend's `items.json` and `albums.json` changed since last time (ETag / Last-Modified); if not, nothing is downloaded or reprocessed.
- **You publish recent posts, with archives.** Your `items.json` holds the last 90 days of posts (at least your 50 newest). Older ones move to signed monthly archives (`api/archive/items-YYYY-MM.json`), so friends download less. Your page lists them under **Older posts**, and each month loads when a visitor opens it. Studio itself still shows all your posts.

### Webrings

A webring is a circle of sites linked by **← Prev**, **Next →** and **Random**. Each ring has a **maintainer** who decides who's in it. Everything still runs on static files:

- The maintainer publishes a **signed member list** (the ring's *hub*, `api/rings/<name>.json`) and a plain directory page (`rings/<name>/`).
- **To join:** paste the ring's hub URL into **Join a Webring**. Studio verifies the ring and gives you a private, signed **request link** to send the maintainer however you like. Once they approve it and publish, your next sync makes you a member, and your next publish shows the ring's bar. Requests are never published.
- **To host:** create a ring under **Rings You Host**, share its hub URL, and paste the request links people send you into **Review a Join Request** to approve, decline or ban. One persona can host several rings, separate from its friend list.
- **Leaving and removal:** if you remove a ring and publish, the maintainer's next sync drops you. If a maintainer removes, bans or closes a ring, members' Studios pick that up on their next sync. Maintainers can also hide a member from Prev/Next/Random without removing them.
- **Navigation:** Prev/Next are written into your page when you publish. When a visitor clicks them, the page re-reads the ring's hub so removed sites are skipped, falling back to the saved link if that fails.

Studio only trusts a hub signed by its maintainer's key, served from the maintainer's own site, and never older than the last copy it saw. A key change or an unsigned hub can raise a warning but never removes anyone.

### Scheduling

In the **Publish** tab, the **Schedule** card sets two jobs per persona:

- **Sync friends & rings**, from every 15 minutes up to weekly
- **Publish if anything changed**, to your export folder, SFTP/FTP host or GitHub Pages, optionally syncing first

Every persona with a schedule runs, even when it isn't the one you have open. Scheduled publishes are skipped when nothing has changed. Jobs run one at a time and never overlap a sync or publish you start by hand.

Schedules run while Studio is running. With **background mode** on (the default), closing the window leaves Studio in the menu bar / system tray so schedules keep going. Quit from the tray icon or with Cmd+Q. You can also have Studio **start at login**. If your computer was asleep or Studio was closed, each missed job runs once when it's back. Failures are recorded on the Schedule card and can raise a notification.

## Connecting an MCP agent

Studio includes a [Model Context Protocol](https://modelcontextprotocol.io) server, so an AI agent (Claude Code, Claude Desktop, Cursor, or your own scripts) can read and manage your personas, posts, friends, rings, schedules and publishing. The **AI Agent (MCP)** tab lists every tool and has a console for trying them.

There are two ways to connect.

**1. Live connection to the running app (recommended)**

While Studio is open, it serves MCP on `127.0.0.1` with a fixed port. This is the only route that can **publish**, since signing needs the keychain, and agent actions show up in the app immediately.

- In the **AI Agent (MCP)** tab, click **Copy SSE URL** (or **Copy HTTP URL**). The URL includes an access token.
- In your MCP client, add a server with transport **SSE** (or Streamable HTTP) and paste the URL.

Command-line agents can connect without the token. Clients that run inside a browser or an Electron window send an `Origin` header and must use the URL with the token; web pages are always refused. Treat the token like a password. To issue a new one, quit Studio, delete `mcp-http.json` from the data folder, and reopen it.

**2. Standalone stdio server**

This works even when Studio is closed. It can read, post, sync and edit schedules, but it **can't publish**.

```bash
npm run build:electron
```

Then configure your MCP client to run:

| Field | Value |
|---|---|
| Command | the full path to `node` (for example `/usr/local/bin/node`) |
| Arguments | `<repo>/dist-electron/electron/mcp/cli.js`, `--data-dir`, `<your data folder>` |

`npm run mcp` starts the same server from the terminal.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Build the UI and the Electron code, then launch the app |
| `npm run build` | Build both without launching |
| `npm run build:vite` / `npm run build:electron` | Build just the UI / just the Electron code |
| `npm test` | Run the test suite (Vitest, `tests/federation.test.ts`) |
| `npx tsc -p tsconfig.json --noEmit` | Type-check the UI |
| `npx tsc -p tsconfig.electron.json --noEmit` | Type-check the Electron code |
| `npm run mcp` | Build and start the stdio MCP server |
| `node scripts/brand-dev-electron.mjs` | macOS: show "Webring Studio" and its icon in the Dock and app menu when running from source (runs automatically after `npm install` and before `npm run dev`) |
| `python3 scripts/generate-icons.py` | Regenerate every app icon and branded image from `images/logo-icon.png` (macOS) |

**No native modules.** Storage uses Node's built-in `node:sqlite`, available in Node 22.13+ (tests, stdio MCP server) and in Electron 45's bundled Node 24 (the app), so nothing is compiled during install. If `ELECTRON_RUN_AS_NODE=1` is set in your shell (some editors set it), `npm run dev` will fail to open a window; unset it first.

**Project layout**

| Path | Contents |
|---|---|
| `electron/main.ts`, `electron/preload.ts` | App lifecycle, tray, IPC |
| `electron/db/database.ts` | SQLite schema and queries, and the signed site bundle |
| `electron/services/` | Friend crawler, webrings, site generator, publisher, personas, scheduler |
| `electron/mcp/` | MCP server (stdio CLI, and loopback HTTP/SSE) |
| `electron/security/` | Keychain encryption, private-network guard |
| `src/shared/schema.ts` | Data schemas (zod), signing and verification, `did:web` |
| `src/studio/App.tsx` | The Studio UI |
| `src/studio/SiteDesignPanel.tsx` | Site Design: look & feel options and page layout blocks |
| `src/shared/markdown.ts` | Safe Markdown renderer for text blocks (also embedded in published pages) |
| `docs/architecture/federation.md` | How federation, signing and webrings fit together |

`AGENTS.md` and `SPEC.md` describe the project's goals and conventions for contributors, human or AI.

## Legal

**Use at your own risk.** Webring Studio is experimental software provided **"as is", without warranty of any kind**, express or implied, including fitness for a particular purpose and non-infringement. To the maximum extent permitted by law, the authors and contributors are not liable for any loss or damage arising from its use. That includes lost or corrupted data, lost or leaked keys and credentials, content published by mistake, and charges or penalties from hosting providers or third-party services.

You are responsible for:

- **Backups:** keep your own copies of your data folder and anything you publish.
- **What you publish:** everything in your export is public. Check it before publishing, and make sure you have the rights to the text, photos and links you share.
- **Third-party terms:** your hosting provider (GitHub, your SFTP/FTP host) and any add-on you enable (Google Analytics, Google AdSense, Giscus/Utterances) has its own terms and privacy obligations. For example, analytics and ads may require a cookie notice or consent in your region.
- **Other people's data:** friends' content you sync stays on your computer, but treat it with the same care you'd want for yours.

### License

Webring Studio is free software, licensed under the [GNU General Public License v3.0 or later](LICENSE) (GPL-3.0-or-later). You may use, study, share and modify it. If you distribute it or a modified version, you must do so under the same license and make the source code available. See [LICENSE](LICENSE) for the full terms.

Your own content (profile, posts, photos and links) stays yours; the license covers the program, not what you write or upload with it.
