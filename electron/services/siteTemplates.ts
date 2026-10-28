import type { ProfileTheme } from '../../src/shared/schema';

/**
 * Site templates for the published page. A template is a theme plus an arrangement of the page:
 * the user's Site Design blocks still decide what appears and in what order, and the template
 * decides where (main column, sidebar, deck columns, rails, grid or reel).
 *
 * The social-style templates echo familiar sites without copying them: original palettes, no
 * logos or trademarks.
 */

export type TemplateShell = 'stack' | 'sidebar' | 'deck' | 'rails' | 'grid' | 'reel';

export interface TemplateConfig {
  shell: TemplateShell;
  /** Light page: recolours the shared dark-on-light details and picks light comment threads. */
  light: boolean;
}

export const TEMPLATE_CONFIG: Record<ProfileTheme, TemplateConfig> = {
  'neo-webring': { shell: 'stack', light: false },
  'minimal-zine': { shell: 'stack', light: true },
  'cyber-terminal': { shell: 'stack', light: false },
  'cozy-scrapbook': { shell: 'stack', light: true },
  facepace: { shell: 'sidebar', light: true },
  tweetdeck: { shell: 'deck', light: true },
  xtraspecial: { shell: 'rails', light: false },
  instapick: { shell: 'grid', light: true },
  tiktalk: { shell: 'reel', light: false },
};

/** `class` for <body>, so the page is styled before its script runs. Unknown themes fall back. */
export function templateBodyClasses(theme: string): string {
  const known = Object.prototype.hasOwnProperty.call(TEMPLATE_CONFIG, theme);
  const id = known ? (theme as ProfileTheme) : 'neo-webring';
  const config = TEMPLATE_CONFIG[id];
  return `theme-${id} shell-${config.shell}${config.light ? ' tpl-light' : ''}`;
}

/**
 * Template skins and shells. Written with String.raw so CSS escapes such as `.bg-white\/10`
 * reach the page as written. Template colours use `var(--accent, var(--tpl-accent))`, so the
 * user's accent (Site Design) wins when set.
 */
export const TEMPLATE_CSS = String.raw`
    /* Shared template pieces */
    body.tpl-light .text-indigo-300, body.tpl-light .text-emerald-300, body.tpl-light .text-pink-300,
    body.tpl-light .text-purple-300, body.tpl-light .text-sky-300, body.tpl-light .text-amber-300 { color: var(--accent, var(--tpl-accent, #4338ca)); }
    body.tpl-light .border-white\/10, body.tpl-light .border-white\/20 { border-color: rgba(0, 0, 0, 0.08); }
    body.tpl-light .bg-white\/10, body.tpl-light .bg-white\/5 { background: rgba(0, 0, 0, 0.05); }
    body.tpl-light .bg-black\/20, body.tpl-light .bg-black\/30 { background: rgba(0, 0, 0, 0.04); }
    body:not(.shell-stack) #profile-root { max-width: 72rem; }
    body.shell-deck #profile-root { max-width: none; }
    .tpl-muted { opacity: 0.65; }
    .tpl-accent { color: var(--accent, var(--tpl-accent)); }
    .tpl-btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.45rem 1rem; border-radius: 9999px; font-weight: 700; font-size: 0.85rem; }
    .tpl-btn-solid { background: var(--accent, var(--tpl-accent)); color: var(--accent-ink, #fff); }
    .tpl-btn-ghost { border: 1px solid var(--tpl-line); }
    .tpl-avatar { border-radius: 9999px; object-fit: cover; flex-shrink: 0; }
    .tpl-avatar-blank { display: flex; align-items: center; justify-content: center; font-weight: 800; background: var(--accent, var(--tpl-accent)); color: var(--accent-ink, #fff); }
    .tpl-chip { font-size: 0.7rem; padding: 0.1rem 0.5rem; border-radius: 9999px; background: color-mix(in srgb, var(--accent, var(--tpl-accent)) 15%, transparent); color: var(--accent, var(--tpl-accent)); font-weight: 600; }
    .tpl-tabs { display: flex; gap: 0.25rem; overflow-x: auto; border-top: 1px solid var(--tpl-line); padding: 0.25rem 1rem; }
    .tpl-tabs a { padding: 0.6rem 0.9rem; font-weight: 600; font-size: 0.9rem; white-space: nowrap; border-bottom: 3px solid transparent; opacity: 0.75; }
    .tpl-tabs a:hover { opacity: 1; border-bottom-color: var(--accent, var(--tpl-accent)); }
    .tpl-block { scroll-margin-top: 1rem; }
    .tpl-media { width: 100%; max-height: 32rem; object-fit: cover; margin-top: 0.6rem; border-radius: 0.5rem; }
    body:not(.shell-stack) .accent-solid { background: var(--accent, var(--tpl-accent)); color: var(--accent-ink, #fff); }
    body:not(.shell-stack) .accent-soft { background: color-mix(in srgb, var(--accent, var(--tpl-accent)) 15%, transparent); color: var(--accent, var(--tpl-accent)); }
    body:not(.shell-stack) .accent-text { color: var(--accent, var(--tpl-accent)); }
    .tpl-actions { display: flex; flex-wrap: wrap; gap: 0.25rem; font-size: 0.8rem; font-weight: 600; }
    .tpl-actions a, .tpl-actions button { padding: 0.35rem 0.7rem; border-radius: 0.5rem; opacity: 0.8; }
    .tpl-actions a:hover, .tpl-actions button:hover { opacity: 1; background: color-mix(in srgb, var(--accent, var(--tpl-accent)) 12%, transparent); color: var(--accent, var(--tpl-accent)); }
    .tpl-comments { margin-top: 0.5rem; display: grid; gap: 0.4rem; font-size: 0.8rem; }
    .tpl-comments div { padding: 0.45rem 0.7rem; border-radius: 0.9rem; background: color-mix(in srgb, currentColor 6%, transparent); }
    .tpl-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.35rem; }
    .tpl-carousel { display: flex; gap: 0.5rem; overflow-x: auto; scroll-snap-type: x mandatory; }
    .tpl-carousel > * { flex: 0 0 11rem; scroll-snap-align: start; }
    .tpl-tile { position: relative; aspect-ratio: 1 / 1; overflow: hidden; background: color-mix(in srgb, currentColor 8%, transparent); }
    .tpl-tile > a { display: block; height: 100%; }
    .tpl-tile > img, .tpl-tile > a > img { width: 100%; height: 100%; object-fit: cover; }
    .tpl-tile-text { display: flex; flex-direction: column; justify-content: center; height: 100%; padding: 0.9rem; font-size: 0.85rem; overflow: hidden; background: linear-gradient(140deg, color-mix(in srgb, var(--accent, var(--tpl-accent)) 30%, transparent), transparent); }
    .tpl-tile-text strong { display: block; margin-bottom: 0.3rem; }
    .tpl-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.4rem; padding: 0.5rem; text-align: center; background: rgba(0, 0, 0, 0.55); color: #fff; font-weight: 700; font-size: 0.8rem; opacity: 0; transition: opacity 0.15s; pointer-events: none; }
    .tpl-overlay .tpl-actions { pointer-events: auto; }
    .tpl-tile:hover .tpl-overlay, .tpl-tile:focus-within .tpl-overlay { opacity: 1; }
    .tpl-overlay .tpl-actions a { opacity: 1; color: #fff; }
    .tpl-album { margin-bottom: 1.25rem; }
    .tpl-album-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.6rem; }
    .tpl-album-head > div { min-width: 0; flex: 1; }
    .tpl-album-head > a { flex-shrink: 0; }
    .tpl-stats { display: flex; flex-wrap: wrap; gap: 1.25rem; font-size: 0.9rem; }
    .tpl-stats b { font-weight: 800; }

    /* Facepace: cover, intro sidebar and post cards */
    body.theme-facepace { --tpl-accent: #3460d4; --tpl-line: #dfe3ea; background: #eef1f6; color: #1c2433; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    body.theme-facepace .card-surface { background: #ffffff; border: 1px solid #dfe3ea; color: #1c2433; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06); }
    .fp-topbar { display: flex; align-items: center; gap: 0.6rem; padding: 0.55rem 1rem; margin-bottom: 1rem; border-radius: 0.75rem; background: linear-gradient(90deg, var(--accent, var(--tpl-accent)), color-mix(in srgb, var(--accent, var(--tpl-accent)) 70%, #0b1020)); color: var(--accent-ink, #fff); font-weight: 800; }
    .fp-topbar span { width: 2rem; height: 2rem; border-radius: 9999px; display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.2); }
    .fp-cover { height: 15rem; background: linear-gradient(120deg, color-mix(in srgb, var(--accent, var(--tpl-accent)) 55%, #fff), #c9d3e6); }
    .fp-cover img { width: 100%; height: 100%; object-fit: cover; }
    .fp-id { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 1rem; padding: 0 1.5rem 1rem; margin-top: -3.5rem; }
    .fp-id .tpl-avatar { width: 9rem; height: 9rem; border: 5px solid #fff; font-size: 3rem; }
    .fp-id h1 { font-size: 1.9rem; font-weight: 800; line-height: 1.1; }
    @media (max-width: 640px) { .fp-id { flex-direction: column; align-items: flex-start; gap: 0.5rem; } .fp-id .tpl-avatar { width: 7rem; height: 7rem; } }
    .fp-layout { display: grid; gap: 1rem; margin-top: 1rem; }
    @media (min-width: 900px) { .fp-layout { grid-template-columns: 22rem minmax(0, 1fr); align-items: start; } }
    .fp-layout section { margin-bottom: 1rem !important; }
    .fp-layout aside section > h2, .fp-layout main section > h2 { font-size: 1.15rem !important; margin-bottom: 0.6rem !important; }
    .fp-intro { padding: 1rem 1.1rem; border-radius: 0.75rem; }
    .fp-post { border-radius: 0.75rem; margin-bottom: 1rem; overflow: hidden; }
    .fp-post-head { display: flex; align-items: center; gap: 0.6rem; padding: 0.85rem 1rem 0.5rem; }
    .fp-post-body { padding: 0 1rem 0.6rem; }
    .fp-post .tpl-actions { justify-content: space-around; border-top: 1px solid var(--tpl-line); margin: 0 0.75rem; padding: 0.25rem 0; }
    .fp-post .tpl-actions a, .fp-post .tpl-actions button { flex: 1; text-align: center; }

    /* Tweetdeck: sky blue page, one column per block */
    body.theme-tweetdeck { --tpl-accent: #2b8fd6; --tpl-line: #d5e6f1; background: #c6e2f4 radial-gradient(circle at 20% 10%, rgba(255, 255, 255, 0.55) 0 2px, transparent 3px) 0 0 / 46px 46px; color: #22303c; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
    body.theme-tweetdeck .card-surface { background: #ffffff; border: 1px solid #d5e6f1; color: #22303c; }
    .td-deck { display: flex; flex-direction: column; gap: 0.75rem; }
    @media (min-width: 760px) {
      .td-deck { flex-direction: row; align-items: flex-start; overflow-x: auto; padding-bottom: 0.75rem; scroll-snap-type: x proximity; }
      .td-col { flex: 0 0 22rem; max-height: calc(100vh - 3rem); overflow-y: auto; scroll-snap-align: start; }
    }
    .td-col { background: #ffffff; border: 1px solid #d5e6f1; border-radius: 0.5rem; box-shadow: 0 1px 3px rgba(34, 48, 60, 0.12); }
    .td-col section { margin: 0 !important; }
    .td-col section > h2 { position: sticky; top: 0; z-index: 1; font-size: 1rem !important; margin: 0 !important; padding: 0.7rem 0.9rem; background: #f3f9fd; border-bottom: 1px solid #d5e6f1; }
    .td-col section > :not(h2) { margin: 0.6rem; }
    .td-col .grid { grid-template-columns: minmax(0, 1fr) !important; }
    .td-profile { padding-bottom: 0.75rem; }
    .td-profile .td-banner { height: 6rem; background: linear-gradient(120deg, var(--accent, var(--tpl-accent)), #9fd0f0); }
    .td-profile .td-banner img { width: 100%; height: 100%; object-fit: cover; }
    .td-profile .tpl-avatar { width: 4.5rem; height: 4.5rem; border-radius: 0.6rem; border: 3px solid #fff; margin: -2.25rem 0 0 0.9rem; font-size: 1.8rem; }
    .td-profile .td-body { padding: 0.4rem 0.9rem 0; }
    .tw-row { display: flex; gap: 0.7rem; padding: 0.75rem 0.9rem; border-bottom: 1px solid var(--tpl-line); }
    .tw-row .tpl-avatar { width: 2.6rem; height: 2.6rem; font-size: 1rem; }
    .tw-row .tw-main { min-width: 0; flex: 1; }
    .tw-row .tw-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem; font-size: 0.85rem; }
    .tw-row .tpl-media { border-radius: 0.75rem; margin-top: 0.5rem; border: 1px solid var(--tpl-line); }
    .tw-row .tpl-actions { margin-top: 0.4rem; margin-left: -0.6rem; }
    body.theme-tweetdeck .tw-row .tpl-avatar { border-radius: 0.4rem; }

    /* XtraSpecial: black timeline between two rails */
    body.theme-xtraspecial { --tpl-accent: #3d9df2; --tpl-line: #2b2f33; background: #000000; color: #e9ecef; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    body.theme-xtraspecial .card-surface { background: #0d0f11; border: 1px solid #2b2f33; color: #e9ecef; }
    .xs-rails { display: grid; gap: 1rem; }
    @media (min-width: 1000px) { .xs-rails { grid-template-columns: 13rem minmax(0, 38rem) minmax(0, 20rem); justify-content: center; align-items: start; } }
    .xs-left { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
    @media (min-width: 1000px) { .xs-left { position: sticky; top: 1rem; flex-direction: column; align-items: stretch; } }
    .xs-left a.xs-nav { padding: 0.6rem 1rem; border-radius: 9999px; font-size: 1.05rem; font-weight: 600; }
    .xs-left a.xs-nav:hover { background: #16181c; }
    .xs-mark { font-size: 1.8rem; font-weight: 900; padding: 0 1rem; }
    .xs-center { border-left: 1px solid var(--tpl-line); border-right: 1px solid var(--tpl-line); min-width: 0; }
    .xs-center section { margin: 0 !important; border-bottom: 1px solid var(--tpl-line); }
    .xs-center section > h2 { font-size: 1.15rem !important; margin: 0 !important; padding: 0.8rem 1rem; }
    .xs-center section > :not(h2) { margin: 0 0.75rem 0.75rem; }
    .xs-center section > .xs-feed { margin: 0; }
    .xs-head .xs-banner { height: 12rem; background: linear-gradient(120deg, #1b2733, color-mix(in srgb, var(--accent, var(--tpl-accent)) 40%, #000)); }
    .xs-head .xs-banner img { width: 100%; height: 100%; object-fit: cover; }
    .xs-head .xs-id { display: flex; justify-content: space-between; align-items: flex-end; padding: 0 1rem; margin-top: -4.25rem; }
    .xs-head .tpl-avatar { width: 8.5rem; height: 8.5rem; border: 4px solid #000; font-size: 3rem; }
    .xs-head .tpl-btn-ghost { border-color: #536471; }
    .xs-right { display: grid; gap: 1rem; min-width: 0; }
    @media (min-width: 1000px) { .xs-right { position: sticky; top: 1rem; } }
    .xs-right section { margin: 0 !important; padding: 0.8rem; border-radius: 1rem; background: #16181c; }
    .xs-right section > h2 { font-size: 1.15rem !important; margin-bottom: 0.6rem !important; }
    .xs-right .grid { grid-template-columns: minmax(0, 1fr) !important; }
    .xs-center .tw-row { padding: 0.8rem 1rem; }
    .xs-center .tpl-tabs { border-bottom: 1px solid var(--tpl-line); }

    /* Instapick: stats header, highlights, square grid */
    body.theme-instapick { --tpl-accent: #d6337a; --tpl-line: #e3e3e3; background: #ffffff; color: #1f1f1f; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    body.theme-instapick .card-surface { background: #ffffff; border: 1px solid #e3e3e3; color: #1f1f1f; }
    .ip-page { max-width: 58rem; margin: 0 auto; }
    .ip-head { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1.25rem 2.5rem; align-items: center; padding: 1rem 0 1.5rem; }
    .ip-ring { padding: 4px; border-radius: 9999px; background: conic-gradient(from 200deg, #ffb347, #ff4f81, #7b5cff, #ffb347); }
    .ip-ring .tpl-avatar { width: 8.5rem; height: 8.5rem; border: 4px solid #fff; font-size: 3rem; }
    @media (max-width: 640px) { .ip-ring .tpl-avatar { width: 5.5rem; height: 5.5rem; } .ip-head { gap: 1rem; } }
    .ip-highlights { display: flex; gap: 1.25rem; overflow-x: auto; padding: 0.5rem 0 1.25rem; }
    .ip-highlights a { display: flex; flex-direction: column; align-items: center; gap: 0.35rem; width: 5rem; flex-shrink: 0; font-size: 0.75rem; font-weight: 600; text-align: center; }
    .ip-highlights span.ip-bubble { width: 4.5rem; height: 4.5rem; border-radius: 9999px; padding: 3px; border: 1px solid #d8d8d8; overflow: hidden; }
    .ip-highlights img { width: 100%; height: 100%; border-radius: 9999px; object-fit: cover; }
    .ip-page .tpl-tabs { justify-content: center; border-top: 1px solid var(--tpl-line); text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.75rem; }
    .ip-page section > h2 { font-size: 1rem !important; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.8; }
    .ip-page .tpl-grid { gap: 0.25rem; }

    /* Tik Talk: dark reel of tall cards */
    body.theme-tiktalk { --tpl-accent: #ff3b6b; --tpl-accent-2: #2ee6e6; --tpl-line: #26262c; background: #0b0b0f; color: #f2f2f2; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    body.theme-tiktalk .card-surface { background: #15151b; border: 1px solid #26262c; color: #f2f2f2; }
    .tt-page { max-width: 34rem; margin: 0 auto; }
    .tt-head { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 0.6rem; padding: 1rem 0 1.5rem; }
    .tt-head .tpl-avatar { width: 6.5rem; height: 6.5rem; font-size: 2.5rem; box-shadow: -3px 0 0 var(--tpl-accent-2), 3px 0 0 var(--accent, var(--tpl-accent)); }
    .tt-head h1 { font-size: 1.35rem; font-weight: 800; }
    .tt-head .tpl-stats { justify-content: center; }
    .tt-reel { height: min(80vh, 46rem); overflow-y: auto; scroll-snap-type: y mandatory; border-radius: 1rem; background: #000; scrollbar-width: none; }
    .tt-reel::-webkit-scrollbar { display: none; }
    .tt-card { position: relative; height: min(80vh, 46rem); scroll-snap-align: start; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    .tt-card > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .tt-card .tt-text { padding: 2rem 4.5rem 7rem 1.5rem; font-size: 1.4rem; font-weight: 700; line-height: 1.35; background: linear-gradient(160deg, color-mix(in srgb, var(--accent, var(--tpl-accent)) 45%, #000), color-mix(in srgb, var(--tpl-accent-2) 30%, #000)); position: absolute; inset: 0; display: flex; align-items: center; }
    .tt-caption { position: absolute; left: 0; right: 4.5rem; bottom: 0; padding: 4rem 1rem 1rem; background: linear-gradient(transparent, rgba(0, 0, 0, 0.75)); color: #fff; font-size: 0.9rem; }
    .tt-rail { position: absolute; right: 0.6rem; bottom: 1.25rem; display: flex; flex-direction: column; gap: 0.9rem; align-items: center; color: #fff; font-size: 0.7rem; font-weight: 700; }
    .tt-rail a, .tt-rail button { display: flex; flex-direction: column; align-items: center; gap: 0.15rem; }
    .tt-rail span.tt-icon { width: 2.8rem; height: 2.8rem; border-radius: 9999px; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; background: rgba(255, 255, 255, 0.16); }
    .tt-page section > h2 { font-size: 1.1rem !important; }
`;

/**
 * Renders the page for every non-stack template. Embedded into the published page with
 * `renderTemplatePage.toString()`, so it must stay self-contained: no imports and no outside
 * references; everything it needs arrives in `ctx` from the page script. All text goes through
 * `ctx.esc` and all URLs through `ctx.safeUrl`, like the rest of the page.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderTemplatePage(ctx: any): string {
  const esc = ctx.esc;
  const safeUrl = ctx.safeUrl;
  const link = ctx.buildDeepLink;
  const profile = ctx.profile;
  const shell: string = ctx.shell;
  const ASIDE_TYPES = ['friends', 'contact', 'links', 'guestbook'];
  const TYPE_LABELS: Record<string, string> = { post: 'Post', like: 'Liked', share: 'Shared', recommendation: 'Recommends', comment: 'Comment' };
  const BLOCK_TABS: Record<string, string> = { albums: 'Photos', items: 'Posts', friends: 'Friends', text: 'About', image: 'Image', links: 'Links', featured: 'Featured', contact: 'Contact', guestbook: 'Guestbook' };

  let host = '';
  try {
    host = new URL(String(profile.siteUrl || '')).host;
  } catch (e) {
    host = '';
  }
  const handle = host ? '@' + host : '';
  const name = esc(profile.displayName);
  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const avatar = (cls: string) =>
    profile.avatarUrl
      ? '<img src="' + safeUrl(profile.avatarUrl) + '" alt="" class="profile-avatar tpl-avatar ' + cls + '" />'
      : '<div class="profile-avatar tpl-avatar tpl-avatar-blank ' + cls + '">' + esc(String(profile.displayName || '?').charAt(0)) + '</div>';
  const banner = (cls: string) =>
    '<div class="profile-banner ' + cls + '">' + (profile.bannerUrl ? '<img src="' + safeUrl(profile.bannerUrl) + '" alt="" />' : '') + '</div>';
  const photoCount = ctx.albums.reduce((n: number, a: any) => n + (a.photos || []).length, 0);
  const postCount = ctx.items.length;
  const friendCount = ctx.friends.length;
  const stats = (pairs: Array<[number, string]>) =>
    '<div class="tpl-stats">' + pairs.map((p) => '<span><b>' + p[0] + '</b> ' + esc(p[1]) + '</span>').join('') + '</div>';
  const addFriend = (cls: string) =>
    '<a href="' + link('friend', profile.siteUrl, profile.displayName, profile.avatarUrl) + '" class="tpl-btn ' + cls + '">+ Add friend</a>';
  const jsonLink = '<a href="./api/manifest.json" target="_blank" rel="noopener noreferrer" class="tpl-btn tpl-btn-ghost">JSON API</a>';
  const interests = (profile.interests || []).length
    ? '<div class="flex flex-wrap gap-1.5 mt-2">' + profile.interests.map((t: string) => '<span class="tpl-chip">#' + esc(t) + '</span>').join('') + '</div>'
    : '';
  const meta = () => {
    const parts: string[] = [];
    if (profile.location) parts.push('<span>📍 ' + esc(profile.location) + '</span>');
    if (profile.atprotoHandle) parts.push('<span>🦋 @' + esc(profile.atprotoHandle) + '</span>');
    (profile.customLinks || []).forEach((l: any) => {
      parts.push('<a href="' + safeUrl(l.url) + '" target="_blank" rel="noopener noreferrer" class="tpl-accent hover:underline">🔗 ' + esc(l.label) + '</a>');
    });
    return parts.length ? '<div class="flex flex-wrap gap-x-4 gap-y-1 text-sm tpl-muted mt-2">' + parts.join('') + '</div>' : '';
  };
  const didChip = '<span class="tpl-chip font-mono" title="Verified Ed25519 DID Identity">' + esc(profile.did) + '</span>';

  // Items and photos, in the template's style
  const reactions = (canonicalUrl: string) => {
    const endorsements = ctx.getEndorsementsFor(canonicalUrl).filter((e: any) => e.type !== 'comment');
    return { endorsements: endorsements, comments: ctx.getCommentsFor(canonicalUrl) };
  };
  const itemActions = (item: any, labels: boolean) => {
    const live = ctx.hasLiveProvider
      ? '<button data-container="live-comments-' + esc(item.id) + '" data-canonical="' + esc(item.canonicalUrl) + '" onclick="window.toggleLiveCommentThread(this.getAttribute(\'data-container\'), this.getAttribute(\'data-canonical\'))">💬 ' + (labels ? 'Live thread' : '') + '</button>'
      : '';
    return '<div class="tpl-actions">' +
      '<a href="' + link('like', item.canonicalUrl, item.title, item.mediaUrl, item.category) + '">♥ ' + (labels ? 'Like' : '') + '</a>' +
      '<a href="' + link('comment', item.canonicalUrl, item.title, item.mediaUrl, 'comment') + '">💬 ' + (labels ? 'Comment' : '') + '</a>' +
      '<a href="' + link('share', item.targetUrl, item.title, item.mediaUrl, item.category) + '">↻ ' + (labels ? 'Share' : '') + '</a>' +
      live + '<button type="button" data-open-post="' + esc(item.id) + '" aria-label="Open post">⤢ ' + (labels ? 'Open' : '') + '</button></div>';
  };
  const itemBody = (item: any) => {
    const isSelfPost = item.type === 'post' && (!item.targetUrl || item.targetUrl === item.canonicalUrl);
    const r = reactions(item.canonicalUrl);
    const first = String(item.commentary || '').trim().split('\n')[0];
    const titleIsHeading = item.type === 'post' && /^#{1,6}\s/.test(first) && ctx.markdownToPlainText(first) === item.title;
    const title = item.title && !titleIsHeading
      ? isSelfPost
        ? '<p class="font-bold">' + esc(item.title) + '</p>'
        : '<a href="' + safeUrl(item.targetUrl) + '" target="_blank" rel="noopener noreferrer" class="font-bold hover:underline">' + esc(item.title) + ' ↗</a>'
      : '';
    const source = item.targetAuthorName
      ? '<p class="text-xs tpl-muted">' + (item.type === 'comment' ? 'Replying to' : 'Source') + ': <a href="' + safeUrl(item.targetAuthorUrl || item.targetUrl) + '" target="_blank" rel="noopener noreferrer" class="underline">' + esc(item.targetAuthorName) + '</a></p>'
      : '';
    const stars = item.rating && item.type !== 'post' && item.type !== 'comment' ? ' ' + '★'.repeat(Math.min(5, Math.max(1, Number(item.rating) || 5))) : '';
    return title + source +
      (item.type === 'post' && item.commentary
        ? '<div class="prose-block post-body text-sm mt-1">' + ctx.renderMarkdown(item.commentary) + '</div>'
        : item.commentary ? '<p class="text-sm mt-1 whitespace-pre-line">' + esc(item.commentary) + stars + '</p>' : stars ? '<p class="text-sm">' + stars + '</p>' : '') +
      (item.mediaUrl ? '<img src="' + safeUrl(item.mediaUrl) + '" alt="" class="tpl-media" />' : '') +
      ((item.tags || []).length ? '<p class="text-xs tpl-accent mt-1">' + item.tags.map((t: string) => '#' + esc(t)).join(' ') + '</p>' : '') +
      (r.endorsements.length ? '<p class="text-xs tpl-muted mt-1">↻ ' + r.endorsements.map((e: any) => esc(e.authorName)).join(', ') + '</p>' : '') +
      (r.comments.length
        ? '<div class="tpl-comments">' + r.comments.map((c: any) => '<div><a href="' + safeUrl(c.authorSiteUrl) + '" target="_blank" rel="noopener noreferrer" class="font-bold tpl-accent">' + esc(c.authorName) + '</a> ' + esc(c.commentary || '') + '</div>').join('') + '</div>'
        : '') +
      '<div id="live-comments-' + esc(item.id) + '" class="hidden mt-2"></div>';
  };
  const typeLabel = (item: any) => esc(TYPE_LABELS[item.type] || item.type);
  // Short text for tiles and reel cards: posts are Markdown, so drop the markers
  const snippet = (item: any) => (item.type === 'post' ? ctx.markdownToPlainText(item.commentary || '') : String(item.commentary || ''));
  const edited = (item: any) => {
    const d = item.updatedAt ? new Date(item.updatedAt) : null;
    return d && !isNaN(d.getTime()) ? ' · <span class="item-edited" title="Edited ' + esc(d.toLocaleString()) + '">edited</span>' : '';
  };
  const postCard = (item: any) =>
    '<article class="card-surface fp-post"><div class="fp-post-head">' + avatar('w-10 h-10 text-base') +
    '<div><p class="font-bold text-sm">' + name + '</p><p class="text-xs tpl-muted">' + esc(formatDate(item.createdAt)) + ' · ' + typeLabel(item) + (item.category && item.category !== 'general' ? ' · ' + esc(item.category) : '') + edited(item) + '</p></div></div>' +
    '<div class="fp-post-body">' + itemBody(item) + '</div>' + itemActions(item, true) + '</article>';
  const tweetRow = (item: any) =>
    '<article class="tw-row">' + avatar('') + '<div class="tw-main"><div class="tw-head"><span class="font-bold">' + name + '</span><span class="tpl-muted">' + esc(handle) + ' · ' + esc(formatDate(item.createdAt)) + edited(item) + '</span>' +
    (item.type !== 'post' ? '<span class="tpl-chip">' + typeLabel(item) + '</span>' : '') + '</div>' + itemBody(item) + itemActions(item, false) + '</div></article>';
  const itemTile = (item: any) => {
    const r = reactions(item.canonicalUrl);
    return '<div class="tpl-tile">' +
      (item.mediaUrl
        ? '<img src="' + safeUrl(item.mediaUrl) + '" alt="' + esc(item.title) + '" />'
        : '<div class="tpl-tile-text"><strong>' + esc(item.title) + '</strong><span>' + esc(snippet(item).slice(0, 160)) + '</span></div>') +
      '<div class="tpl-overlay"><span>♥ ' + r.endorsements.length + ' · 💬 ' + r.comments.length + '</span><span>' + esc(item.title) + '</span>' + itemActions(item, false) + '</div></div>';
  };
  const reelCard = (media: string, title: string, text: string, tags: string[], counts: { likes: number; comments: number }, actions: { like: string; comment?: string; share: string; open?: string }) =>
    '<div class="tt-card">' +
    (media ? '<img src="' + safeUrl(media) + '" alt="' + esc(title) + '" />' : '<div class="tt-text">' + esc(text || title) + '</div>') +
    '<div class="tt-caption"><p class="font-bold">' + esc(handle || profile.displayName) + '</p>' +
    (title ? '<p>' + esc(title) + '</p>' : '') + (media && text ? '<p class="opacity-90 text-sm">' + esc(text) + '</p>' : '') +
    ((tags || []).length ? '<p class="text-sm font-semibold">' + tags.map((t) => '#' + esc(t)).join(' ') + '</p>' : '') + '</div>' +
    '<div class="tt-rail">' +
    '<a href="' + actions.like + '"><span class="tt-icon">♥</span>' + counts.likes + '</a>' +
    (actions.comment ? '<a href="' + actions.comment + '"><span class="tt-icon">💬</span>' + counts.comments + '</a>' : '') +
    '<a href="' + actions.share + '"><span class="tt-icon">↻</span>Share</a>' +
    (actions.open ? '<button type="button" ' + actions.open + ' aria-label="Open"><span class="tt-icon">⤢</span>Open</button>' : '') + '</div></div>';
  const itemReel = (item: any) => {
    const r = reactions(item.canonicalUrl);
    return reelCard(item.mediaUrl, item.title, snippet(item), item.tags, { likes: r.endorsements.length, comments: r.comments.length }, {
      like: link('like', item.canonicalUrl, item.title, item.mediaUrl, item.category),
      comment: link('comment', item.canonicalUrl, item.title, item.mediaUrl, 'comment'),
      share: link('share', item.targetUrl, item.title, item.mediaUrl, item.category),
      open: 'data-open-post="' + esc(item.id) + '"',
    });
  };
  const photoTile = (photo: any, album: any) =>
    '<div class="tpl-tile"><a href="' + safeUrl(photo.url) + '" target="_blank" rel="noopener noreferrer" data-lightbox data-photo-id="' + esc(photo.id) + '"><img src="' + safeUrl(photo.thumbUrl || photo.url) + '" alt="' + esc(photo.altText || photo.caption) + '" /></a>' +
    '<div class="tpl-overlay"><span>♥ ' + ctx.getEndorsementsFor(photo.canonicalUrl).length + '</span>' + (photo.caption ? '<span>' + esc(photo.caption) + '</span>' : '') +
    '<div class="tpl-actions"><a href="' + link('like', photo.canonicalUrl, photo.caption || album.title, photo.url, 'photo') + '">♥ Like</a><a href="' + link('share', photo.canonicalUrl, photo.caption || album.title, photo.url, 'photo') + '">↻ Share</a></div></div></div>';
  const photoReel = (photo: any, album: any) =>
    reelCard(photo.url, photo.caption || album.title, album.title, photo.tags, { likes: ctx.getEndorsementsFor(photo.canonicalUrl).length, comments: 0 }, {
      like: link('like', photo.canonicalUrl, photo.caption || album.title, photo.url, 'photo'),
      share: link('share', photo.canonicalUrl, photo.caption || album.title, photo.url, 'photo'),
      open: 'data-lightbox data-photo-id="' + esc(photo.id) + '"',
    });

  // Blocks: albums and items take the template's style, the rest reuse the page's renderers
  const albumsBlock = (b: any) => {
    const ids = b.options && Array.isArray(b.options.albumIds) && b.options.albumIds.length ? b.options.albumIds : null;
    const list = ids ? ctx.albums.filter((a: any) => ids.includes(a.id)) : ctx.albums;
    if (!list.length) return ctx.section(b, '📸 Photo Albums', ctx.emptyNote('No photo albums published yet.'));
    if (shell === 'reel') {
      return ctx.section(b, '📸 Photos', '<div class="tt-reel">' + list.map((a: any) => (a.photos || []).map((p: any) => photoReel(p, a)).join('')).join('') + '</div>');
    }
    const carousel = b.options && b.options.style === 'carousel';
    return ctx.section(b, '📸 Photos', list.map((a: any) =>
      '<div class="tpl-album" id="tpl-album-' + esc(a.id) + '"><div class="tpl-album-head"><div><h3 class="font-bold">' + esc(a.title) + '</h3>' +
      (a.description ? '<div class="prose-block album-description text-sm">' + ctx.renderMarkdown(a.description) + '</div>' : '') + '</div>' +
      '<a href="' + link('share', a.canonicalUrl, a.title, a.coverUrl, 'photo') + '" class="text-xs font-semibold tpl-accent">↻ Share album</a></div>' +
      '<div class="' + (carousel ? 'tpl-carousel' : 'tpl-grid') + '">' + (a.photos || []).map((p: any) => photoTile(p, a)).join('') + '</div></div>'
    ).join(''));
  };
  const itemsBlock = (b: any) => {
    const kinds = b.options && Array.isArray(b.options.kinds) ? b.options.kinds : null;
    let list = kinds ? ctx.items.filter((i: any) => kinds.includes(i.type)) : ctx.items;
    if (b.options && b.options.limit) list = list.slice(0, b.options.limit);
    if (!list.length) return ctx.section(b, '✨ Posts', ctx.emptyNote('Nothing shared here yet.'));
    if (shell === 'sidebar') return ctx.section(b, 'Posts', list.map(postCard).join(''));
    if (shell === 'grid') return ctx.section(b, 'Posts', '<div class="tpl-grid">' + list.map(itemTile).join('') + '</div>');
    if (shell === 'reel') return ctx.section(b, 'For you', '<div class="tt-reel">' + list.map(itemReel).join('') + '</div>');
    return ctx.section(b, 'Posts', '<div class="xs-feed">' + list.map(tweetRow).join('') + '</div>');
  };
  const rendered = ctx.layout
    .map((b: any, i: number) => {
      const html = b.type === 'albums' ? albumsBlock(b) : b.type === 'items' ? itemsBlock(b) : ctx.blockRenderers[b.type](b);
      return html ? { block: b, aside: ASIDE_TYPES.includes(b.type), id: 'tpl-b-' + i, html: '<div class="tpl-block" id="tpl-b-' + i + '">' + html + '</div>' } : null;
    })
    .filter(Boolean);
  const main = rendered.filter((r: any) => !r.aside);
  const aside = rendered.filter((r: any) => r.aside);
  const mainHtml =
    (main.length ? main[0].html + ctx.inFeedAdHtml + main.slice(1).map((r: any) => r.html).join('') : ctx.inFeedAdHtml) +
    (ctx.olderPostsHtml || '');
  // Older posts loaded from archives use this layout's item style
  if (ctx.archiveView) {
    ctx.archiveView.renderItem = shell === 'sidebar' ? postCard : shell === 'grid' ? itemTile : shell === 'reel' ? itemReel : tweetRow;
    ctx.archiveView.wrapClass = shell === 'grid' ? 'tpl-grid' : shell === 'reel' ? 'tt-reel' : 'xs-feed';
  }
  const asideHtml = aside.map((r: any) => r.html).join('');
  const tabs = (cls: string, list: any[]) =>
    list.length
      ? '<nav class="tpl-tabs ' + cls + '">' + list.map((r: any) => '<a href="#' + r.id + '">' + esc(typeof r.block.title === 'string' && r.block.title ? r.block.title : BLOCK_TABS[r.block.type] || r.block.type) + '</a>').join('') + '</nav>'
      : '';
  const wrap = (body: string) => '<div data-shell="' + esc(shell) + '">' + body + '</div>';

  if (shell === 'sidebar') {
    const header =
      '<div class="card-surface rounded-xl overflow-hidden">' + banner('fp-cover') +
      '<div class="fp-id">' + avatar('') + '<div class="flex-1 min-w-0 pb-2"><h1>' + name + '</h1><p class="text-sm tpl-muted font-semibold">' + friendCount + ' friends' + (profile.tagline ? ' · ' + esc(profile.tagline) : '') + '</p></div>' +
      '<div class="flex flex-wrap gap-2 pb-2">' + addFriend('tpl-btn-solid') + jsonLink + '</div></div>' + tabs('', rendered) + '</div>';
    const intro =
      '<section class="card-surface fp-intro mb-4"><h2 class="text-lg font-bold mb-2">Intro</h2>' +
      (profile.bio ? '<p class="text-sm text-center mb-2">' + esc(profile.bio) + '</p>' : '') + meta() + interests + '<p class="mt-3">' + didChip + '</p></section>';
    return wrap(
      '<div class="fp-topbar"><span>' + esc(String(profile.displayName || '?').charAt(0)) + '</span>' + name + '</div>' +
      ctx.webringBars + header + ctx.headerAdHtml +
      '<div class="fp-layout"><aside data-region="aside">' + intro + asideHtml + '</aside><main data-region="main">' + mainHtml + ctx.footerAdHtml + '</main></div>' + ctx.footerHtml
    );
  }

  if (shell === 'deck') {
    const profileColumn =
      '<div class="td-col td-profile" data-region="profile">' + banner('td-banner') + avatar('') +
      '<div class="td-body"><h1 class="text-xl font-extrabold">' + name + '</h1><p class="text-sm tpl-muted">' + esc(handle) + '</p>' +
      (profile.tagline ? '<p class="text-sm font-semibold mt-1">' + esc(profile.tagline) + '</p>' : '') +
      (profile.bio ? '<p class="text-sm mt-2">' + esc(profile.bio) + '</p>' : '') + meta() + interests +
      '<div class="mt-3">' + stats([[postCount, 'Posts'], [photoCount, 'Photos'], [friendCount, 'Friends']]) + '</div>' +
      '<div class="flex flex-wrap gap-2 mt-3">' + addFriend('tpl-btn-solid') + jsonLink + '</div><p class="mt-3 text-xs">' + didChip + '</p>' +
      ctx.headerAdHtml + ctx.inFeedAdHtml + ctx.footerAdHtml + '</div></div>';
    return wrap(
      ctx.webringBars + '<div class="td-deck">' + profileColumn +
      rendered.map((r: any) => '<div class="td-col" data-region="column">' + r.html + '</div>').join('') +
      (ctx.olderPostsHtml ? '<div class="td-col" data-region="column">' + ctx.olderPostsHtml + '</div>' : '') + '</div>' + ctx.footerHtml
    );
  }

  if (shell === 'rails') {
    const left =
      '<nav class="xs-left" data-region="nav"><span class="xs-mark tpl-accent">✦</span>' +
      rendered.map((r: any) => '<a class="xs-nav" href="#' + r.id + '">' + esc(typeof r.block.title === 'string' && r.block.title ? r.block.title : BLOCK_TABS[r.block.type] || r.block.type) + '</a>').join('') +
      addFriend('tpl-btn-solid justify-center') + '</nav>';
    const header =
      '<div class="xs-head">' + banner('xs-banner') + '<div class="xs-id">' + avatar('') + '<div class="flex gap-2 pb-2">' + jsonLink + addFriend('tpl-btn-solid') + '</div></div>' +
      '<div class="px-4 pt-3 pb-3"><h1 class="text-xl font-extrabold">' + name + '</h1><p class="tpl-muted text-sm">' + esc(handle) + '</p>' +
      (profile.bio ? '<p class="mt-3 text-[15px]">' + esc(profile.bio) + '</p>' : '') + meta() + interests +
      '<div class="mt-3 text-sm">' + stats([[friendCount, 'Friends'], [postCount, 'Posts'], [photoCount, 'Photos']]) + '</div></div>' + tabs('', main) + '</div>';
    return wrap(
      '<div class="xs-rails">' + left +
      '<main class="xs-center" data-region="main">' + header + ctx.headerAdHtml + mainHtml + ctx.footerAdHtml + '</main>' +
      '<aside class="xs-right" data-region="aside">' + ctx.webringBars + asideHtml + '</aside></div>' + ctx.footerHtml
    );
  }

  if (shell === 'grid') {
    const header =
      '<div class="ip-head"><div class="ip-ring">' + avatar('') + '</div><div class="min-w-0">' +
      '<div class="flex flex-wrap items-center gap-3"><h1 class="text-xl">' + esc(handle || profile.displayName) + '</h1>' + addFriend('tpl-btn-solid') + jsonLink + '</div>' +
      '<div class="mt-3">' + stats([[postCount, 'posts'], [photoCount, 'photos'], [friendCount, 'friends']]) + '</div>' +
      '<p class="font-bold mt-3">' + name + '</p>' + (profile.tagline ? '<p class="text-sm tpl-muted">' + esc(profile.tagline) + '</p>' : '') +
      (profile.bio ? '<p class="text-sm mt-1 whitespace-pre-line">' + esc(profile.bio) + '</p>' : '') + meta() + '</div></div>';
    const highlights = ctx.albums.length
      ? '<div class="ip-highlights" data-region="highlights">' + ctx.albums.map((a: any) => {
          const cover = a.coverUrl || (a.photos && a.photos[0] ? a.photos[0].thumbUrl || a.photos[0].url : '');
          return '<a href="#tpl-album-' + esc(a.id) + '"><span class="ip-bubble">' + (cover ? '<img src="' + safeUrl(cover) + '" alt="" />' : '') + '</span>' + esc(a.title) + '</a>';
        }).join('') + '</div>'
      : '';
    return wrap(
      '<div class="ip-page">' + ctx.webringBars + header + highlights + tabs('', rendered) + ctx.headerAdHtml +
      '<div data-region="main">' + mainHtml + '</div><div data-region="aside">' + asideHtml + '</div>' + ctx.footerAdHtml + ctx.footerHtml + '</div>'
    );
  }

  // reel
  const likeCount = ctx.endorsementCount;
  const header =
    '<div class="tt-head">' + avatar('') + '<h1>' + esc(handle || profile.displayName) + '</h1><p class="text-sm tpl-muted">' + name + '</p>' +
    stats([[friendCount, 'Friends'], [likeCount, 'Likes'], [postCount, 'Posts']]) +
    '<div class="flex flex-wrap justify-center gap-2">' + addFriend('tpl-btn-solid') + jsonLink + '</div>' +
    (profile.bio ? '<p class="text-sm max-w-md">' + esc(profile.bio) + '</p>' : '') + meta() + '</div>';
  return wrap(
    '<div class="tt-page">' + ctx.webringBars + header + ctx.headerAdHtml +
    '<div data-region="main">' + mainHtml + '</div><div data-region="aside">' + asideHtml + '</div>' + ctx.footerAdHtml + ctx.footerHtml + '</div>'
  );
}
