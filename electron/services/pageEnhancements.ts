/**
 * Interactive extras for the published page: a photo lightbox, opening a post in a larger view
 * (linkable as #post-<id>, photos as #photo-<id>), sortable tables in text blocks, and a short
 * explanation before a webring:// link hands over to Webring Studio.
 *
 * Plain DOM code with no library. The site generator embeds it with
 * `installPageEnhancements.toString()`, so it must stay self-contained: no imports and no outside
 * references; everything arrives in `ctx` from the page script. Text goes through `ctx.esc` and
 * URLs through `ctx.safeUrl`, like the rest of the page. Without <dialog> support the page keeps
 * its plain links (a photo opens the image file).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installPageEnhancements(ctx: any): { addItems: (items: any[]) => void } | null {
  const doc = document;
  const root = ctx.root;
  const esc = ctx.esc;
  const safeUrl = ctx.safeUrl;
  const link = ctx.buildDeepLink;

  // Sortable tables: header buttons sort the rows, numbers in number order
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  root.querySelectorAll('.prose-block table').forEach((table: any) => {
    const head = table.tHead;
    const body = table.tBodies && table.tBodies[0];
    if (!head || !body || !head.rows[0] || body.rows.length < 2) return;
    const headers = Array.prototype.slice.call(head.rows[0].cells);
    headers.forEach((th: any, col: number) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'wr-sort';
      while (th.firstChild) button.appendChild(th.firstChild);
      const icon = doc.createElement('span');
      icon.className = 'wr-sort-icon';
      icon.setAttribute('aria-hidden', 'true');
      button.appendChild(icon);
      th.appendChild(button);
      button.addEventListener('click', () => {
        const ascending = th.getAttribute('aria-sort') !== 'ascending';
        headers.forEach((h: any) => h.removeAttribute('aria-sort'));
        th.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
        const cellText = (row: any) => (row.cells[col] ? row.cells[col].textContent || '' : '').trim();
        Array.prototype.slice
          .call(body.rows)
          .sort((a: any, b: any) => (ascending ? 1 : -1) * collator.compare(cellText(a), cellText(b)))
          .forEach((row: any) => body.appendChild(row));
      });
    });
  });

  if (typeof HTMLDialogElement === 'undefined') return null;

  const photoIndex: Record<string, { album: any; index: number }> = {};
  (ctx.albums || []).forEach((album: any) => {
    (album.photos || []).forEach((photo: any, index: number) => {
      photoIndex[photo.id] = { album: album, index: index };
    });
  });
  const itemIndex: Record<string, any> = {};
  (ctx.items || []).forEach((item: any) => {
    itemIndex[item.id] = item;
  });

  const dialog = doc.createElement('dialog');
  dialog.className = 'wr-dialog';
  doc.body.appendChild(dialog);
  let current: { album: any; index: number } | null = null;
  let opener: any = null;
  let touchX: number | null = null;

  const setHash = (hash: string) => {
    try {
      history.replaceState(null, '', hash ? '#' + hash : location.pathname + location.search);
    } catch (e) {
      // sandboxed previews may refuse; the dialog still works
    }
  };
  const show = () => {
    if (!dialog.open) dialog.showModal();
    const close = dialog.querySelector('[data-wr="close"]') as HTMLElement | null;
    if (close) close.focus();
  };
  const bar = (label: string) =>
    '<div class="wr-bar"><span>' + label + '</span><button type="button" class="wr-close" data-wr="close" aria-label="Close">✕</button></div>';

  const showPhoto = (photoId: string) => {
    const entry = photoIndex[photoId];
    if (!entry) return false;
    current = entry;
    const album = entry.album;
    const photos = album.photos;
    const photo = photos[entry.index];
    const many = photos.length > 1;
    const title = photo.caption || album.title;
    dialog.setAttribute('aria-label', 'Photo: ' + title);
    dialog.innerHTML =
      '<div class="wr-lightbox">' + bar(esc(album.title) + (many ? ' · ' + (entry.index + 1) + ' / ' + photos.length : '')) +
      '<div class="wr-stage">' +
      (many ? '<button type="button" class="wr-nav wr-prev" data-wr="prev" aria-label="Previous photo">‹</button>' : '') +
      '<img src="' + safeUrl(photo.url) + '" alt="' + esc(photo.altText || photo.caption) + '" />' +
      (many ? '<button type="button" class="wr-nav wr-next" data-wr="next" aria-label="Next photo">›</button>' : '') +
      '</div><div class="wr-caption">' +
      (photo.caption ? '<p class="wr-title">' + esc(photo.caption) + '</p>' : '') +
      (photo.altText && photo.altText !== photo.caption ? '<p class="wr-muted">' + esc(photo.altText) + '</p>' : '') +
      ((photo.tags || []).length ? '<p class="wr-muted">' + photo.tags.map((t: string) => '#' + esc(t)).join(' ') + '</p>' : '') +
      '<div class="wr-actions">' +
      '<a href="' + link('like', photo.canonicalUrl, title, photo.url, 'photo') + '">♥ Like</a>' +
      '<a href="' + link('share', photo.canonicalUrl, title, photo.url, 'photo') + '">↻ Share</a>' +
      '<a href="' + safeUrl(photo.url) + '" target="_blank" rel="noopener noreferrer">Open original</a>' +
      '</div></div></div>';
    setHash('photo-' + encodeURIComponent(photo.id));
    show();
    return true;
  };

  const showPost = (itemId: string) => {
    const item = itemIndex[itemId];
    if (!item) return false;
    current = null;
    dialog.setAttribute('aria-label', 'Post: ' + (item.title || ''));
    dialog.innerHTML = '<div class="wr-post">' + bar(esc(ctx.profile.displayName)) + ctx.renderItem(item) + '</div>';
    setHash('post-' + encodeURIComponent(item.id));
    show();
    return true;
  };

  // Hand-off to Webring Studio: explain the step and offer web fallbacks before the browser's own
  // "open this application?" prompt, which pages can't change. "Don't ask again" skips this sheet.
  const HANDOFF_KEY = 'webring-studio-handoff';
  const askFirst = () => {
    try {
      return localStorage.getItem(HANDOFF_KEY) !== 'direct';
    } catch (e) {
      return true;
    }
  };
  let handoffUrl = '';
  const showHandoff = (href: string) => {
    let params: URLSearchParams;
    try {
      params = new URL(href).searchParams;
    } catch (e) {
      return false;
    }
    const action = params.get('action') || '';
    const title = params.get('title') || '';
    const target = params.get('targetUrl') || '';
    const quoted = title ? ' “' + esc(title) + '”' : '';
    const heading =
      action === 'like' ? 'Like' + quoted
      : action === 'share' ? 'Share' + quoted
      : action === 'comment' ? 'Comment on' + quoted
      : action === 'friend' ? 'Add ' + esc(title || 'this site') + ' as a friend'
      : action === 'join-ring' ? 'Join the' + quoted + ' webring'
      : 'Open in Webring Studio';
    const isWeb = /^https?:\/\//i.test(target);
    // A post or photo on this page: copy its page link (#post-…, #photo-…), not the JSON address
    const pageBase = /^https?:$/.test(location.protocol)
      ? location.href.split('#')[0]
      : String(ctx.profile.siteUrl || '').replace(/\/?$/, '/');
    let webLink = target;
    const item = (ctx.items || []).find((i: any) => i.canonicalUrl === target);
    const photoId = Object.keys(photoIndex).find((id) => {
      const entry = photoIndex[id];
      return entry.album.photos[entry.index].canonicalUrl === target;
    });
    if (item) webLink = pageBase + '#post-' + encodeURIComponent(item.id);
    else if (photoId) webLink = pageBase + '#photo-' + encodeURIComponent(photoId);
    handoffUrl = isWeb ? webLink : '';
    current = null;
    dialog.setAttribute('aria-label', heading.replace(/&[^;]+;/g, ''));
    dialog.innerHTML =
      '<div class="wr-sheet card-surface"><div class="wr-sheet-head"><h2>' + heading + '</h2>' +
      '<button type="button" class="wr-close" data-wr="close" aria-label="Close">✕</button></div>' +
      '<p class="wr-sheet-note">This happens in <strong>Webring Studio</strong>, the free desktop app behind this site. Your browser will ask before opening it; choose <em>Always allow</em>, where offered, to skip that next time.</p>' +
      '<a class="wr-go" data-wr-go href="' + esc(href) + '">Open in Webring Studio</a>' +
      '<label class="wr-sheet-check"><input type="checkbox" data-wr-remember /> Don’t ask again on this site</label>' +
      (isWeb
        ? '<div class="wr-sheet-alt"><p>No app? ' + (action === 'join-ring' ? 'Copy the ring’s address:' : action === 'friend' ? 'Copy the site’s address:' : 'Copy the link:') + '</p>' +
          '<div class="wr-sheet-copy"><input type="text" readonly value="' + esc(handoffUrl) + '" aria-label="Link" />' +
          '<button type="button" data-wr="copy">Copy</button>' +
          (typeof navigator.share === 'function' && action !== 'join-ring' ? '<button type="button" data-wr="share">Share…</button>' : '') +
          '</div></div>'
        : '') +
      '<a class="wr-sheet-about" href="' + safeUrl(ctx.projectUrl) + '" target="_blank" rel="noopener noreferrer">What’s Webring Studio?</a></div>';
    show();
    return true;
  };
  const isHandoffLink = (el: any) => el && /^webring:/i.test(el.getAttribute('href') || '') && !el.hasAttribute('data-wr-go');
  const maybeHandoff = (ev: any) => {
    if (ev.defaultPrevented || ev.button > 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return false;
    const anchor = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!isHandoffLink(anchor) || !askFirst()) return false;
    if (!showHandoff(anchor.getAttribute('href'))) return false;
    ev.preventDefault();
    if (!opener) opener = anchor;
    return true;
  };
  root.addEventListener('click', maybeHandoff);

  const step = (delta: number) => {
    if (!current) return;
    const photos = current.album.photos;
    showPhoto(photos[(current.index + delta + photos.length) % photos.length].id);
  };

  root.addEventListener('click', (ev: any) => {
    if (ev.defaultPrevented || ev.button > 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const target = ev.target && ev.target.closest ? ev.target.closest('[data-lightbox], [data-open-post]') : null;
    if (!target) return;
    const opened = target.hasAttribute('data-open-post')
      ? showPost(target.getAttribute('data-open-post'))
      : showPhoto(target.getAttribute('data-photo-id'));
    if (opened) {
      ev.preventDefault();
      opener = target;
    }
  });

  dialog.addEventListener('click', (ev: any) => {
    if (ev.target === dialog) return dialog.close(); // backdrop
    if (maybeHandoff(ev)) return; // Like / Share in the lightbox or post view
    const go = ev.target && ev.target.closest ? ev.target.closest('[data-wr-go]') : null;
    if (go) {
      const remember = dialog.querySelector('[data-wr-remember]') as HTMLInputElement | null;
      if (remember && remember.checked) {
        try {
          localStorage.setItem(HANDOFF_KEY, 'direct');
        } catch (e) {
          // private mode: the sheet will simply show again
        }
      }
      setTimeout(() => dialog.close(), 300); // let the browser start the hand-off first
      return;
    }
    const button = ev.target && ev.target.closest ? ev.target.closest('[data-wr]') : null;
    if (!button) return;
    const action = button.getAttribute('data-wr');
    if (action === 'close') dialog.close();
    else if (action === 'copy') {
      const field = dialog.querySelector('.wr-sheet-copy input') as HTMLInputElement | null;
      const done = () => {
        button.textContent = 'Copied ✓';
      };
      const fallback = () => {
        if (!field) return;
        field.select();
        let copied = false;
        try {
          copied = doc.execCommand('copy');
        } catch (e) {
          copied = false;
        }
        if (copied) done();
        else button.textContent = 'Press Ctrl/⌘+C';
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(handoffUrl).then(done, fallback);
      else fallback();
    } else if (action === 'share') {
      navigator.share({ url: handoffUrl }).catch(() => undefined);
    } else step(action === 'prev' ? -1 : 1);
  });
  dialog.addEventListener('keydown', (ev: any) => {
    if (!current) return;
    if (ev.key === 'ArrowLeft') step(-1);
    else if (ev.key === 'ArrowRight') step(1);
  });
  dialog.addEventListener('touchstart', (ev: any) => {
    touchX = ev.touches && ev.touches[0] ? ev.touches[0].clientX : null;
  }, { passive: true });
  dialog.addEventListener('touchend', (ev: any) => {
    const endX = ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0].clientX : null;
    if (current && touchX !== null && endX !== null && Math.abs(endX - touchX) > 50) step(endX < touchX ? 1 : -1);
    touchX = null;
  });
  dialog.addEventListener('close', () => {
    current = null;
    dialog.innerHTML = '';
    setHash('');
    if (opener && opener.focus) opener.focus();
    opener = null;
  });

  // #post-<id> and #photo-<id> open on load and when the address changes
  const openFromHash = () => {
    const match = /^#(post|photo)-(.+)$/.exec(location.hash || '');
    if (!match) return;
    let id = match[2];
    try {
      id = decodeURIComponent(id);
    } catch (e) {
      return;
    }
    if (match[1] === 'post') showPost(id);
    else showPhoto(id);
  };
  window.addEventListener('hashchange', openFromHash);
  openFromHash();

  // Older posts loaded later (archives) can be opened in the post view too
  return {
    addItems: (items: any[]) => {
      (items || []).forEach((item: any) => {
        itemIndex[item.id] = item;
      });
    },
  };
}

export const ENHANCEMENTS_CSS = `
    /* Interactive extras (pageEnhancements.ts) */
    .wr-dialog { padding: 0; border: 0; background: transparent; color: inherit; width: 100%; max-width: min(96vw, 72rem); max-height: 94vh; overflow: visible; }
    .wr-dialog::backdrop { background: rgba(0, 0, 0, 0.82); }
    @media (prefers-reduced-motion: no-preference) { .wr-dialog[open] { animation: wr-in 0.16s ease-out; } }
    @keyframes wr-in { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: none; } }
    .wr-bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.35rem 0.25rem 0.6rem; color: #f5f5f5; font-size: 0.85rem; font-weight: 600; }
    .wr-close { width: 2.4rem; height: 2.4rem; border-radius: 9999px; background: rgba(255, 255, 255, 0.16); color: #fff; font-size: 1rem; }
    .wr-close:hover, .wr-nav:hover { background: rgba(255, 255, 255, 0.3); }
    .wr-lightbox { display: flex; flex-direction: column; width: fit-content; max-width: 100%; max-height: 94vh; margin: 0 auto; color: #f5f5f5; }
    .wr-stage { position: relative; display: flex; align-items: center; justify-content: center; min-height: 0; }
    .wr-stage img { max-width: 100%; max-height: 74vh; object-fit: contain; border-radius: 0.5rem; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); }
    .wr-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 2.8rem; height: 2.8rem; border-radius: 9999px; background: rgba(0, 0, 0, 0.55); color: #fff; font-size: 1.9rem; line-height: 1; }
    .wr-prev { left: 0.5rem; }
    .wr-next { right: 0.5rem; }
    .wr-caption { padding: 0.8rem 0.25rem 0; text-align: center; font-size: 0.9rem; }
    .wr-title { font-weight: 700; font-size: 1rem; }
    .wr-muted { opacity: 0.75; margin-top: 0.2rem; }
    .wr-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem; margin-top: 0.7rem; }
    .wr-actions a { padding: 0.35rem 0.85rem; border-radius: 9999px; background: rgba(255, 255, 255, 0.14); color: #fff; font-weight: 600; font-size: 0.8rem; }
    .wr-actions a:hover { background: rgba(255, 255, 255, 0.28); }
    .wr-post { width: min(92vw, 46rem); max-height: 92vh; margin: 0 auto; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.35) transparent; }
    .wr-post .card-surface { box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45); }
    .wr-post img { max-height: 70vh !important; object-fit: contain !important; }
    .wr-dialog [data-open-post], .wr-dialog [data-container] { display: none !important; }
    [data-lightbox] { cursor: zoom-in; }
    .wr-sheet { width: min(92vw, 27rem); margin: 0 auto; padding: 1.1rem 1.2rem 1rem; border-radius: 1rem; backdrop-filter: blur(14px); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45); font-size: 0.9rem; }
    .wr-sheet-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
    .wr-sheet-head h2 { font-size: 1.1rem; font-weight: 800; line-height: 1.3; padding-top: 0.35rem; }
    .wr-sheet .wr-close { flex-shrink: 0; background: color-mix(in srgb, currentColor 12%, transparent); color: inherit; }
    .wr-sheet-note { margin: 0.6rem 0 0.9rem; opacity: 0.8; line-height: 1.5; }
    .wr-go { display: block; text-align: center; padding: 0.65rem 1rem; border-radius: 0.75rem; font-weight: 700; background: var(--accent, var(--tpl-accent, #4f46e5)); color: var(--accent-ink, #fff); }
    .wr-go:hover { filter: brightness(1.08); }
    .wr-sheet-check { display: flex; align-items: center; gap: 0.45rem; margin-top: 0.6rem; font-size: 0.8rem; opacity: 0.85; }
    .wr-sheet-alt { margin-top: 0.9rem; padding-top: 0.8rem; border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
    .wr-sheet-alt p { font-size: 0.8rem; opacity: 0.8; margin-bottom: 0.4rem; }
    .wr-sheet-copy { display: flex; gap: 0.4rem; }
    .wr-sheet-copy input { flex: 1; min-width: 0; padding: 0.4rem 0.6rem; border-radius: 0.5rem; font-size: 0.8rem; color: inherit; background: color-mix(in srgb, currentColor 7%, transparent); border: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
    .wr-sheet-copy button { padding: 0.4rem 0.75rem; border-radius: 0.5rem; font-size: 0.8rem; font-weight: 600; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); white-space: nowrap; }
    .wr-sheet-about { display: inline-block; margin-top: 0.8rem; font-size: 0.8rem; text-decoration: underline; opacity: 0.8; }
    .wr-sort { display: inline-flex; align-items: center; gap: 0.35rem; font: inherit; font-weight: 700; color: inherit; background: none; padding: 0; cursor: pointer; }
    .wr-sort-icon::after { content: "↕"; opacity: 0.4; font-size: 0.8em; }
    th[aria-sort="ascending"] .wr-sort-icon::after { content: "▲"; opacity: 0.8; }
    th[aria-sort="descending"] .wr-sort-icon::after { content: "▼"; opacity: 0.8; }
`;
