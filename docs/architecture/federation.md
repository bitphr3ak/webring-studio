# Federation architecture

How Webring Studio exchanges data with other sites today, where the boundaries are, and what has to change before peer-to-peer sync, CRDTs or ActivityPub can be added.

## Current model

- **Pull-only.** There's no push or gossip. The studio fetches a friend's published static files over HTTP when the user clicks Sync, an MCP agent calls `webring_crawl_friend` / `webring_crawl_all_friends`, or a per-persona schedule runs (`electron/services/scheduler.ts`: sync on an interval, publish only when the content fingerprint changed). See `RingCrawler.crawlFriendSite` in `electron/services/ringCrawler.ts`.
- **Signed documents.** Every published JSON document carries an Ed25519 proof. The crawler checks each one against the friend's `did.json` key. The first key it sees is pinned (trust on first use). If the key later changes, the crawl is flagged `changed` and nothing from that site verifies until the user deals with it.
- **Last write wins.** Feed rows are keyed by the entry's canonical URL and endorsements by the source item URL. A new crawl replaces the old row. There is no merge logic.
- **Entries are scoped to their site.** An entry is only accepted if its canonical URL is on the friend's own site (`isUrlWithinSite`). A friend can't overwrite another friend's rows.
- **Deletions follow the source.** After a *verified* fetch, anything that friend no longer publishes is pruned. A failed, missing or unverified fetch never deletes rows. Removing a friend deletes their rows too.

## Boundaries

```
friend's /api/*.json ──crawl+verify──▶ SQLite (internal state) ──curated view──▶ studio feed / MCP
                                              │
                                              └──buildSignedSiteBundle()──▶ /api/*.json (exchange format) ──▶ static site
```

- **Internal state** is the per-persona SQLite database. Only the local client writes to it.
- **Curated view** is `getCuratedNetworkFeed()` and `getCuratedEndorsements()` in `electron/db/database.ts`. They apply mute/block (from the `moderation` table) and, for export, drop endorsements without a verified signature. The studio feed, MCP tools and the static export all read through it, never from the raw tables.
  - **Mute** hides a site from the local feed only.
  - **Block** also drops its endorsements from the published site and stops crawling it.
- **Exchange format** is the set of signed documents that `buildSignedSiteBundle()` produces (`did.json`, `manifest`, `profile`, `albums`, `items`, `connections`). Everything that gets published goes through this one function. The network feed itself is never published; only endorsements of the user's own content and (optionally) the public friends list are.
- **The published site is a snapshot.** Each successful publish records `lastPublishedAt` and what it contained, and the Publish tab shows it with a count of changes made since. Anything that arrives after a publish shows up publicly only after the next one.

## Site Design data

`profile.json` can carry `appearance` (look & feel options) and `layout` (the ordered content blocks below the profile header). Both are parsed leniently: invalid appearance fields and unknown or malformed blocks are dropped rather than failing the whole profile, so newer block types never break older readers. A missing `layout` means the default page; an empty array means no blocks. Text blocks hold Markdown source, rendered on the page by the self-contained renderer in `src/shared/markdown.ts`, which escapes everything and allows only safe links.

## Media Library and album manifests

- **Published files.** Each album's photos are content-addressed web copies and thumbnails under `media/albums/<albumId>/` (metadata stripped), described by a signed `media/albums/<albumId>/manifest.json` (type `webring-album-manifest`: album details, and per photo the image and thumbnail URL, SHA-256, size, MIME type and dimensions). `api/albums.json` links each album's `manifestUrl`, and photo entries carry the same hashes.
- **Changes propagate by URL.** A replaced photo keeps its id and canonical URL but gets a new file name, so friends' Studios update the feed entry on the next sync. A removed photo disappears from `albums.json` and is pruned from friends' feeds after a verified fetch (the same rule as other entries).
- **Incremental publishing.** A per-destination ledger records what Studio last published. Publishing uploads only changed files and deletes only Studio's own files that are no longer part of the site, so stale photos don't stay reachable on hosts or in the repo.

## Webrings

Rings are curated by a maintainer and run entirely on static files (`electron/services/ringService.ts`).

- **Hub.** Each hosted ring is published as a signed hub document at `api/rings/<slug>.json`, plus a script-free directory page at `rings/<slug>/index.html`. The hub lists the members in order (`inRotation: false` marks hidden members). Bans and pending requests are never published. Closing a ring republishes the hub with `status: "closed"` and no members, because some hosts (SFTP/FTP) never delete old files.
- **Membership is two-sided:** the hub lists the site *and* the site's own signed `connections.json` lists the ring.
- **Joining.** The applicant creates a private signed request (`webring://ring-request?token=…`) and sends it to the maintainer out-of-band. The maintainer's Studio verifies it against the applicant's `did.json` and checks it's under 30 days old and not banned. Approval adds the member, and it goes live at the maintainer's next publish.
- **Sync (part of Sync All).**
  - **Members** re-read each joined ring's hub. Listed → `member` with fresh prev/next. Not listed in a newer verified hub → `removed`. A `closed` hub → `closed`.
  - **Maintainers** check each member's verified `connections.json`. A member who confirmed and then stopped listing the ring has left and is removed. New members get a 14-day grace period.
- **Trust rules:**
  - Ring fetches are https-only, never `file://` or local paths.
  - A hub must say it lives at the URL it was fetched from, sit on its maintainer's site, carry the maintainer's did:web, and be signed by the maintainer's pinned key.
  - Older hub copies are ignored.
  - Unsigned (v1) hubs, changed keys and failed fetches never remove anyone; they only raise warnings or flags.
  - Keys are pinned once per site in `site_keys`, shared with friend crawling.
- **Navigation.** Prev/Next are baked into the page at publish. On click, the page re-reads the hub (2 s timeout, no credentials or referrer, https-only member URLs) to skip removed or hidden sites, falling back to the baked link. Random needs JavaScript; without it, it goes to the directory page.
- **Migration.** The pre-redesign single hub (`publishWebringHub`, members = public friends) was converted once into a hosted ring at the same path, `api/webring-hub.json`. Older joined rings are kept as `legacy`: still shown, never auto-removed.
- **Not yet supported:** following a ring when its maintainer moves domains (`movedTo`), and keeping a member's place when they change site URL. Both currently mean re-joining.

## Rules for future sync layers

Any CRDT, P2P or ActivityPub work must keep these boundaries:

1. New sync code writes into internal state. It never feeds the static site generator directly.
2. Moderation and verification are applied once, in the curated view, and every reader uses it.
3. The exchange format stays the signed bundle. A new wire format (for example JSON-LD) is a second serialization of the same bundle, not a separate data path.

## Known gaps before P2P or ActivityPub

- **Non-standard canonicalization.** `canonicalizeJson` in `src/shared/schema.ts` sorts object keys recursively. It isn't JCS (RFC 8785) or URDNA2015, so only another copy of this app can verify the signatures.
- **Proof type label.** Proofs say `Ed25519Signature2020`, but they aren't produced with the JSON-LD canonicalization that suite requires. Either switch to a real Data Integrity suite or rename the proof type.
- **No causality or versions.** Entries have no version counter, vector clock or tombstone. Last write wins is only safe because each site is the sole author of its own entries. Multi-writer or relayed data would need one of these.
- **No `@context` on content documents.** Only the DID document is JSON-LD.

## Open questions

- Which CRDT (if any), and for which data? Most data has a single author, so per-author logs may be enough.
- A JSON-LD `@context` for `items` and `albums`, and how it maps onto ActivityStreams types (`Note`, `Like`, `Announce`, `Image`).
- How a did:web site maps onto an ActivityPub actor (inbox/outbox) without needing a running server.
