import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { StudioDatabase } from '../db/database';
import { MediaLibrary } from './mediaLibrary';
import { markdownToPlainText, renderMarkdown } from '../../src/shared/markdown';
import { renderTemplatePage, TEMPLATE_CONFIG, TEMPLATE_CSS, templateBodyClasses } from './siteTemplates';
import { ENHANCEMENTS_CSS, installPageEnhancements } from './pageEnhancements';
import {
  Appearance,
  CompleteSiteBundle,
  DEFAULT_LAYOUT,
  isValidAdSlotId,
  isValidGa4MeasurementId,
  normalizeAdSensePublisherId,
  ProfileThemeSchema,
  WebringHubDocument,
  WEBRING_SCHEMA_VERSION,
} from '../../src/shared/schema';

export interface GeneratedSiteResult {
  outputDir: string;
  filesWritten: string[];
  bundle: CompleteSiteBundle;
  /** Media Library files a photo refers to but that are missing from the library folder. */
  missingMedia: string[];
}

/**
 * Generates the complete static website directory containing:
 * - /.well-known/did.json (W3C / ATProto identity & public key)
 * - /api/manifest.json
 * - /api/profile.json
 * - /api/albums.json
 * - /api/items.json
 * - /api/connections.json
 * - /api/rings/<slug>.json + /rings/<slug>/index.html (signed hub and directory page per hosted ring)
 * - /index.html (Standalone interactive profile site powered by the JSON files)
 */
export class StaticSiteGenerator {
  constructor(private db: StudioDatabase, private mediaStoreDir?: string) {}

  /** The persona database this generator publishes from (used by the publisher's ledger). */
  public get database(): StudioDatabase {
    return this.db;
  }

  /**
   * Remembers that this bundle actually went live (local export or upload), so the studio can
   * show when the public snapshot was taken. Test previews don't call this.
   */
  public recordPublished(bundle: CompleteSiteBundle): void {
    this.db.recordPublished(
      bundle.manifest.updatedAt,
      {
        ...bundle.manifest.stats,
        endorsementCount: bundle.connections.endorsements.length,
      },
      this.contentFingerprint(bundle)
    );
  }

  /**
   * A hash of what the published site would contain, ignoring things that change on every build
   * (timestamps and signatures). Equal fingerprints mean publishing again would change nothing,
   * which lets scheduled publishes skip. Covers the bundle, hosted ring hubs and media files.
   */
  public contentFingerprint(bundle: CompleteSiteBundle = this.db.buildSignedSiteBundle({ publish: true })): string {
    const stripVolatile = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripVolatile);
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
          if (key === 'updatedAt' || key === 'proof') continue;
          out[key] = stripVolatile((value as Record<string, unknown>)[key]);
        }
        return out;
      }
      return value;
    };
    const media = this.localMediaFiles().map(({ url, file }) => {
      const stat = file && fs.existsSync(file) ? fs.statSync(file) : null;
      return stat ? `${url}:${stat.size}:${Math.floor(stat.mtimeMs)}` : `${url}:missing`;
    });
    const hubs = this.db.buildSignedHubDocuments().map(({ ring, doc }) => ({ path: ring.hubPath, doc }));
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(stripVolatile({ bundle, hubs, media })))
      .digest('hex');
  }

  public generateToDirectory(outputDir: string, compiledProfileHtml?: string): GeneratedSiteResult {
    const bundle = this.db.buildSignedSiteBundle({ publish: true });
    const filesWritten: string[] = [];

    const wellKnownDir = path.join(outputDir, '.well-known');
    const apiDir = path.join(outputDir, 'api');
    const mediaOutDir = path.join(outputDir, 'media');

    fs.mkdirSync(wellKnownDir, { recursive: true });
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(mediaOutDir, { recursive: true });

    const writeJson = (relPath: string, data: unknown) => {
      const fullPath = path.join(outputDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf8');
      filesWritten.push(relPath);
    };

    // 1. Write standardized JSON endpoints (both /.well-known/did.json for root domains and /did.json for subpath did:web resolution)
    writeJson('.well-known/did.json', bundle.didDocument);
    writeJson('did.json', bundle.didDocument);
    writeJson('api/manifest.json', bundle.manifest);
    writeJson('api/profile.json', bundle.profile);
    writeJson('api/albums.json', bundle.albums);
    writeJson('api/items.json', bundle.items);
    // Older items, by month (items.json lists them in `archive`); stale months are dropped locally
    const archiveDir = path.join(outputDir, 'api', 'archive');
    if (fs.existsSync(archiveDir)) fs.rmSync(archiveDir, { recursive: true, force: true });
    for (const { path: archivePath, doc } of bundle.archives || []) writeJson(archivePath, doc);
    writeJson('api/connections.json', bundle.connections);

    // 2. Hosted rings: a signed hub JSON (what members' Studios and visitors' Prev/Next read) and a
    // script-free directory page. Closed rings are still written so members learn they closed.
    const hubDocs = this.db.buildSignedHubDocuments();
    for (const { ring, doc } of hubDocs) {
      writeJson(ring.hubPath, doc);
      const directoryFile = path.join(outputDir, ring.directoryPath);
      fs.mkdirSync(path.dirname(directoryFile), { recursive: true });
      fs.writeFileSync(directoryFile, buildRingDirectoryHtml(doc), 'utf8');
      filesWritten.push(ring.directoryPath);
    }
    // The pre-redesign hub lived here; drop a stale local copy unless a hosted ring now owns the path
    const legacyHubPath = path.join(outputDir, 'api/webring-hub.json');
    if (!hubDocs.some(({ ring }) => ring.hubPath === 'api/webring-hub.json') && fs.existsSync(legacyHubPath)) {
      fs.rmSync(legacyHubPath, { force: true });
    }

    // 3. Media Library: only the files current photos use (so removed or replaced photos stop
    // being published), plus each album's signed manifest
    const missingMedia: string[] = [];
    for (const { url, file } of this.localMediaFiles()) {
      if (!file || !fs.existsSync(file)) {
        missingMedia.push(url);
        continue;
      }
      const dest = path.join(outputDir, url);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest);
      filesWritten.push(url);
    }
    for (const { path: manifestPath, doc } of this.db.buildSignedAlbumManifests()) {
      writeJson(manifestPath, doc);
    }

    // 4. Write standalone index.html for the hosted Profile Website
    const indexHtml = compiledProfileHtml
      ? this.injectHydrationData(compiledProfileHtml, bundle)
      : this.buildStandaloneProfileHtml(bundle);

    fs.writeFileSync(path.join(outputDir, 'index.html'), indexHtml, 'utf8');
    filesWritten.push('index.html');

    // 5. Write .nojekyll so GitHub Pages serves /.well-known/did.json without ignoring dot-folders
    fs.writeFileSync(path.join(outputDir, '.nojekyll'), '', 'utf8');
    filesWritten.push('.nojekyll');

    // 5b. Write .htaccess so Apache / LiteSpeed hosts resolve DirectoryIndex index.html on subdirectories (preventing 403 Forbidden on /social/) and allow CORS on JSON endpoints
    const htaccessContent = [
      'DirectoryIndex index.html',
      '<IfModule mod_headers.c>',
      '  <FilesMatch "\\.(json)$">',
      '    Header set Access-Control-Allow-Origin "*"',
      '  </FilesMatch>',
      '</IfModule>',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(outputDir, '.htaccess'), htaccessContent, 'utf8');
    filesWritten.push('.htaccess');

    // 6. Optional Add-On: Write /ads.txt when Google AdSense Add-On is enabled (or remove if disabled)
    const adsTxtPath = path.join(outputDir, 'ads.txt');
    const adsAddon = bundle.profile.adsAddon;
    const normalizedPubId = normalizeAdSensePublisherId(adsAddon?.publisherId);
    if (adsAddon?.enabled && adsAddon.generateAdsTxt !== false && normalizedPubId) {
      const pubWithoutCa = normalizedPubId.replace(/^ca-/i, '');
      const adsTxtContent = `google.com, ${pubWithoutCa}, DIRECT, f08c47fec0942fa0\n`;
      fs.writeFileSync(adsTxtPath, adsTxtContent, 'utf8');
      filesWritten.push('ads.txt');
    } else if (fs.existsSync(adsTxtPath)) {
      fs.rmSync(adsTxtPath, { force: true });
    }

    return {
      outputDir,
      filesWritten,
      bundle,
      missingMedia,
    };
  }

  /** Media Library files referenced by photos, with their location in the library folder. */
  private localMediaFiles(): Array<{ url: string; file: string | null }> {
    if (!this.mediaStoreDir) return [];
    const library = new MediaLibrary(this.mediaStoreDir);
    return [...this.db.getLocalMediaReferences().urls].sort().map((url) => ({ url, file: library.resolveLocalUrl(url) }));
  }

  private injectHydrationData(htmlTemplate: string, bundle: CompleteSiteBundle): string {
    const scriptTag = `<script>window.__WEBRING_BUNDLE__ = ${JSON.stringify(bundle)};</script>`;
    if (htmlTemplate.includes('</head>')) {
      return htmlTemplate.replace('</head>', `${scriptTag}\n</head>`);
    }
    return `${scriptTag}\n${htmlTemplate}`;
  }

  /**
   * Produces a zero-dependency, self-contained HTML profile website that dynamically loads
   * `/api/*.json` when hosted on an HTTP server, and falls back to `window.__WEBRING_BUNDLE__`
   * when opened locally via `file://`.
   */
  /**
   * The published profile page. With `preview: true` it's the Studio's live preview instead: the
   * same page plus a base URL for local Media Library images and a bridge that sends link clicks
   * to Studio. Preview extras are never part of a published file.
   */
  public buildStandaloneProfileHtml(bundle: CompleteSiteBundle, options: { preview?: boolean } = {}): string {
    const preview = options.preview === true;
    const markdownSource = renderMarkdown.toString();
    const templateSource = renderTemplatePage.toString();
    const plainTextSource = markdownToPlainText.toString();
    const appearance = bundle.profile.appearance || {};
    // Archives aren't embedded in the published page (it fetches them); the preview, which can't
    // fetch, gets them embedded so "Older posts" works there too
    const { archives = [], ...pageBundle } = bundle;
    const archivesJson = preview ? embedJson(Object.fromEntries(archives.map((a) => ['/' + a.path, a.doc]))) : '';
    // Interactive extras are on unless turned off in Site Design; when off they aren't embedded
    const enhancementsSource = appearance.interactions === 'off' ? 'null' : installPageEnhancements.toString();
    if (/<\/script/i.test(markdownSource + plainTextSource + templateSource + enhancementsSource)) {
      throw new Error('Page renderer source cannot be embedded safely.');
    }
    const safeJson = embedJson(pageBundle);

    const analytics = bundle.profile.analyticsAddon;
    const hasValidAnalytics = Boolean(
      analytics?.enabled && isValidGa4MeasurementId(analytics.measurementId)
    );
    const gaId = hasValidAnalytics ? analytics!.measurementId.trim().toUpperCase() : '';

    const ads = bundle.profile.adsAddon;
    const adsPubId = ads?.enabled ? normalizeAdSensePublisherId(ads.publisherId) : '';
    const hasValidAds = Boolean(ads?.enabled && adsPubId);

    const scriptSrcExtras = [
      hasValidAnalytics
        ? 'https://www.googletagmanager.com https://www.google-analytics.com'
        : '',
      hasValidAds
        ? 'https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://ep1.adtrafficquality.google https://ep2.adtrafficquality.google'
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    const frameSrcExtras = hasValidAds
      ? ' https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://pagead2.googlesyndication.com https://ep1.adtrafficquality.google https://ep2.adtrafficquality.google'
      : '';

    const analyticsHeadSnippet = hasValidAnalytics
      ? `
  <!-- Optional Profile Add-On: Google Analytics (GA4) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${gaId}"></script>
  <script>
    (function() {
      var respectDnt = ${analytics!.respectDoNotTrack !== false ? 'true' : 'false'};
      if (respectDnt && (navigator.doNotTrack === '1' || window.doNotTrack === '1')) {
        return;
      }
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      window.gtag = gtag;
      gtag('js', new Date());
      gtag('config', '${gaId}', { anonymize_ip: ${analytics!.anonymizeIp !== false ? 'true' : 'false'} });
    })();
  </script>`
      : '';

    const adsHeadSnippet = hasValidAds
      ? `
  <!-- Optional Profile Add-On: Google AdSense (${adsPubId}) -->
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adsPubId}" crossorigin="anonymous"></script>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://giscus.app https://utteranc.es${scriptSrcExtras ? ' ' + scriptSrcExtras : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:${preview ? ' studio-media:' : ''}; frame-src https://giscus.app https://utteranc.es${frameSrcExtras}; connect-src 'self' https: http:;" />
  <title>${this.escapeHtml(bundle.profile.displayName)} — Federated Profile & Webring</title>${preview ? '\n  <base href="studio-media://local/" />' : ''}
  <link rel="alternate" type="application/json" title="Webring Manifest" href="./api/manifest.json" />
  <link rel="me" href="${this.escapeHtml(bundle.profile.siteUrl)}" />
  <script src="https://cdn.tailwindcss.com"></script>${analyticsHeadSnippet}${adsHeadSnippet}
  <script>window.__WEBRING_BUNDLE__ = ${safeJson};${archivesJson ? `\n  window.__WEBRING_ARCHIVES__ = ${archivesJson};` : ''}</script>
  <style>
    body.theme-neo-webring { background: #0f172a; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif; }
    body.theme-minimal-zine { background: #fafaf9; color: #1c1917; font-family: Georgia, Cambria, serif; }
    body.theme-cyber-terminal { background: #050505; color: #4ade80; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    body.theme-cozy-scrapbook { background: #fef3c7; color: #451a03; font-family: system-ui, -apple-system, sans-serif; }
    .card-surface { background: rgba(30, 41, 59, 0.75); border: 1px solid rgba(148, 163, 184, 0.2); }
    body.theme-minimal-zine .card-surface { background: #ffffff; border: 1px solid #e7e5e4; color: #1c1917; }
    body.theme-cyber-terminal .card-surface { background: #0a0f0d; border: 1px solid #22c55e; color: #4ade80; }
    body.theme-cozy-scrapbook .card-surface { background: #fffbeb; border: 2px solid #d97706; color: #451a03; }
    /* Look & feel options (Site Design); each applies only when set */
    body[data-font="sans"] { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important; }
    body[data-font="serif"] { font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif !important; }
    body[data-font="rounded"] { font-family: ui-rounded, "SF Pro Rounded", Nunito, "Varela Round", system-ui, sans-serif !important; }
    body[data-font="mono"] { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important; }
    body[data-corners="sharp"] .card-surface, body[data-corners="sharp"] .rounded, body[data-corners="sharp"] .rounded-lg,
    body[data-corners="sharp"] .rounded-xl, body[data-corners="sharp"] .rounded-2xl { border-radius: 0 !important; }
    body[data-corners="soft"] .card-surface, body[data-corners="soft"] .rounded-xl,
    body[data-corners="soft"] .rounded-2xl { border-radius: 1.5rem !important; }
    body[data-surface="flat"] .card-surface { background: transparent !important; border-color: transparent !important; box-shadow: none !important; }
    body[data-banner="short"] .profile-banner { height: 8rem !important; }
    body[data-banner="tall"] .profile-banner { height: 22rem !important; }
    body[data-avatar="circle"] .profile-avatar { border-radius: 9999px !important; }
    body[data-accent] .accent-solid { background: var(--accent) !important; color: var(--accent-ink) !important; }
    body[data-accent] .accent-soft { background: color-mix(in srgb, var(--accent) 20%, transparent) !important; color: var(--accent) !important; }
    body[data-accent] .accent-text { color: var(--accent) !important; }
    body[data-background="gradient"] { background-image: linear-gradient(160deg, color-mix(in srgb, var(--accent, #6366f1) 24%, transparent), transparent 60%) !important; background-attachment: fixed; }
    body[data-background="banner-blur"]::before { content: ""; position: fixed; inset: -60px; z-index: -1; background-image: var(--banner-image); background-size: cover; background-position: center; filter: blur(48px) saturate(1.2); opacity: 0.35; }
    /* Text blocks */
    .prose-block h2 { font-size: 1.4rem; font-weight: 700; margin: 1.1rem 0 0.5rem; }
    .prose-block h3 { font-size: 1.2rem; font-weight: 700; margin: 1rem 0 0.4rem; }
    .prose-block h4, .prose-block h5 { font-weight: 700; margin: 0.9rem 0 0.3rem; }
    .prose-block p { margin: 0.5rem 0; line-height: 1.65; }
    .prose-block ul { list-style: disc; padding-left: 1.5rem; margin: 0.5rem 0; }
    .prose-block ol { list-style: decimal; padding-left: 1.5rem; margin: 0.5rem 0; }
    .prose-block a { text-decoration: underline; }
    .prose-block blockquote { border-left: 3px solid var(--accent, #6366f1); padding-left: 1rem; margin: 0.75rem 0; opacity: 0.9; }
    .prose-block code { background: rgba(0, 0, 0, 0.25); padding: 0.1rem 0.35rem; border-radius: 0.25rem; font-size: 0.9em; }
    .prose-block pre { background: rgba(0, 0, 0, 0.3); padding: 0.75rem 1rem; border-radius: 0.5rem; overflow-x: auto; margin: 0.75rem 0; }
    .prose-block pre code { background: none; padding: 0; }
    .prose-block table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.95em; }
    .prose-block th, .prose-block td { border: 1px solid rgba(148, 163, 184, 0.35); padding: 0.4rem 0.65rem; text-align: left; }
    .prose-block th { font-weight: 700; background: rgba(148, 163, 184, 0.12); }
    .prose-block hr { border: 0; border-top: 1px solid rgba(148, 163, 184, 0.3); margin: 1rem 0; }
    .album-description { max-width: 48rem; }
    .post-body > :first-child { margin-top: 0; }
    .post-body > :last-child { margin-bottom: 0; }
    .album-description p:first-child, .album-description h2:first-child, .album-description h3:first-child { margin-top: 0.25rem; }
${TEMPLATE_CSS}${appearance.interactions === 'off' ? '' : ENHANCEMENTS_CSS}
  </style>
</head>
<body class="${templateBodyClasses(bundle.profile.theme)} min-h-screen antialiased pb-20"${this.appearanceAttributes(appearance)}>
  <div id="profile-root" class="max-w-5xl mx-auto px-4 sm:px-6 pt-6"></div>

  <script>
    (async function() {
      let data = window.__WEBRING_BUNDLE__;
      // Try fetching live JSON files if hosted over HTTP(S)
      if (window.location.protocol.startsWith('http')) {
        try {
          const [manifest, profile, albums, items, connections, didDocument] = await Promise.all([
            fetch('./api/manifest.json').then(r => r.ok ? r.json() : data.manifest),
            fetch('./api/profile.json').then(r => r.ok ? r.json() : data.profile),
            fetch('./api/albums.json').then(r => r.ok ? r.json() : data.albums),
            fetch('./api/items.json').then(r => r.ok ? r.json() : data.items),
            fetch('./api/connections.json').then(r => r.ok ? r.json() : data.connections),
            fetch('./.well-known/did.json').then(r => r.ok ? r.json() : data.didDocument)
          ]);
          data = { manifest, profile, albums, items, connections, didDocument };
        } catch (err) {
          console.warn('Using embedded bundle fallback:', err);
        }
      }

      const root = document.getElementById('profile-root');
      const { profile, albums, items, connections } = data;

      function esc(str) {
        return String(str || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function safeUrl(url) {
        const raw = String(url || '').trim();
        if (!raw) return '#';
        const lower = raw.toLowerCase();
        if (
          lower.startsWith('https://') ||
          lower.startsWith('http://') ||
          lower.startsWith('webring://') ||
          lower.startsWith('./') ||
          lower.startsWith('/') ||
          lower.startsWith('media/')
        ) {
          return esc(raw);
        }
        return '#blocked-unsafe-url';
      }

      const renderMarkdown = ${markdownSource};
      const markdownToPlainText = ${plainTextSource};
      const DEFAULT_LAYOUT = ${JSON.stringify(DEFAULT_LAYOUT)};

      // Look & feel (also set on <body> at publish; re-applied in case live profile.json differs)
      function applyAppearance(a) {
        a = a || {};
        const body = document.body;
        const set = (key, value) => value ? body.setAttribute('data-' + key, value) : body.removeAttribute('data-' + key);
        set('font', a.font && a.font !== 'theme' ? a.font : '');
        set('corners', a.corners && a.corners !== 'rounded' ? a.corners : '');
        set('surface', a.surface === 'flat' ? 'flat' : '');
        set('banner', a.bannerHeight && a.bannerHeight !== 'medium' ? a.bannerHeight : '');
        set('avatar', a.avatarShape === 'circle' ? 'circle' : '');
        set('background', a.background && a.background !== 'theme' ? a.background : '');
        if (/^#[0-9a-fA-F]{6}$/.test(a.accent || '')) {
          const n = parseInt(a.accent.slice(1), 16);
          const luminance = (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
          body.setAttribute('data-accent', '');
          body.style.setProperty('--accent', a.accent);
          body.style.setProperty('--accent-ink', luminance > 0.6 ? '#0b1020' : '#ffffff');
        } else {
          body.removeAttribute('data-accent');
        }
        const banner = String(profile.bannerUrl || '');
        if (a.background === 'banner-blur' && /^(https?:\\/\\/|media\\/|\\.\\/)/i.test(banner) && !/["'()\\\\\\s]/.test(banner)) {
          body.style.setProperty('--banner-image', 'url("' + banner + '")');
        }
      }

      // Templates (siteTemplates.ts): the theme picks the page arrangement as well as the skin
      const TEMPLATES = ${JSON.stringify(TEMPLATE_CONFIG)};
      const renderTemplatePage = ${templateSource};
      const allowedThemes = ${JSON.stringify(ProfileThemeSchema.options)};
      const activeTheme = allowedThemes.includes(profile.theme) && TEMPLATES[profile.theme] ? profile.theme : 'neo-webring';
      const template = TEMPLATES[activeTheme];
      document.body.className = 'theme-' + activeTheme + ' shell-' + template.shell + (template.light ? ' tpl-light' : '') + ' min-h-screen antialiased pb-20';
      applyAppearance(profile.appearance);

      function buildDeepLink(action, targetUrl, title, mediaUrl, category) {
        const params = new URLSearchParams();
        params.set('action', action);
        params.set('targetUrl', String(targetUrl || ''));
        if (title) params.set('title', String(title));
        params.set('authorUrl', String(profile.siteUrl || ''));
        params.set('authorName', String(profile.displayName || ''));
        if (mediaUrl) params.set('mediaUrl', String(mediaUrl));
        if (category) params.set('category', String(category));
        return esc('webring://interact?' + params.toString());
      }

      function getEndorsementsFor(canonicalUrl) {
        return (connections.endorsements || []).filter(e => e.targetCanonicalUrl === canonicalUrl);
      }

      function getCommentsFor(canonicalUrl) {
        const fromEndorsements = getEndorsementsFor(canonicalUrl).filter(e => e.type === 'comment');
        const fromOwn = (items.items || [])
          .filter(i => i.type === 'comment' && i.targetUrl === canonicalUrl)
          .map(i => ({
            authorSiteUrl: profile.siteUrl,
            authorName: profile.displayName,
            commentary: i.commentary,
            sourceItemUrl: i.canonicalUrl,
            createdAt: i.createdAt
          }));
        const seen = new Set();
        return [...fromEndorsements, ...fromOwn].filter(c => {
          if (seen.has(c.sourceItemUrl)) return false;
          seen.add(c.sourceItemUrl);
          return true;
        });
      }

      window.toggleLiveCommentThread = function(containerId, canonicalUrl) {
        const el = document.getElementById(containerId);
        if (!el) return;
        if (!el.classList.contains('hidden')) {
          el.classList.add('hidden');
          el.innerHTML = '';
          return;
        }
        el.classList.remove('hidden');
        const cfg = profile.commentConfig || {};
        if (cfg.provider === 'giscus' && cfg.giscusRepo) {
          const script = document.createElement('script');
          script.src = 'https://giscus.app/client.js';
          script.setAttribute('data-repo', cfg.giscusRepo);
          if (cfg.giscusRepoId) script.setAttribute('data-repo-id', cfg.giscusRepoId);
          script.setAttribute('data-category', cfg.giscusCategory || 'General');
          if (cfg.giscusCategoryId) script.setAttribute('data-category-id', cfg.giscusCategoryId);
          script.setAttribute('data-mapping', 'specific');
          script.setAttribute('data-term', canonicalUrl);
          script.setAttribute('data-reactions-enabled', '1');
          script.setAttribute('data-emit-metadata', '0');
          script.setAttribute('data-theme', template.light ? 'light' : 'dark');
          script.crossOrigin = 'anonymous';
          script.async = true;
          el.innerHTML = '';
          el.appendChild(script);
        } else if (cfg.provider === 'utterances' && cfg.giscusRepo) {
          const script = document.createElement('script');
          script.src = 'https://utteranc.es/client.js';
          script.setAttribute('repo', cfg.giscusRepo);
          script.setAttribute('issue-term', canonicalUrl);
          script.setAttribute('theme', template.light ? 'github-light' : 'github-dark');
          script.crossOrigin = 'anonymous';
          script.async = true;
          el.innerHTML = '';
          el.appendChild(script);
        } else {
          el.innerHTML = '<p class="text-xs opacity-75">Configure your GitHub repository in Webring Studio Publish Settings to enable live Giscus / Utterances threads.</p>';
        }
      };

      // Ring bars. Prev / Next / Random are baked in at publish; on click they re-read the ring's
      // hub so removed or hidden sites are skipped, falling back to the baked link on any failure.
      const webringBars = (connections.webrings || []).map((ring, ringIndex) => {
        const count = typeof ring.memberCount === 'number' ? ring.memberCount : 3;
        const homeHref = safeUrl(ring.directoryUrl || ring.hubUrl);
        const single = ring.prevSiteUrl && ring.prevSiteUrl === ring.nextSiteUrl;
        const navLink = (nav, href, label) =>
          '<a href="' + safeUrl(href) + '" data-ring-nav="' + nav + '" data-ring-index="' + ringIndex + '" rel="noopener noreferrer" class="hover:underline">' + label + '</a>';
        const links = count <= 1
          ? ''
          : single
            ? navLink('next', ring.nextSiteUrl, 'Neighbour →')
            : (ring.prevSiteUrl ? navLink('prev', ring.prevSiteUrl, '← Prev Site') : '') +
              (count > 2 ? navLink('random', ring.directoryUrl || ring.hubUrl, 'Random') : '') +
              (ring.nextSiteUrl ? navLink('next', ring.nextSiteUrl, 'Next Site →') : '');
        return \`
        <div class="card-surface rounded-xl px-4 py-2.5 mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div class="flex items-center gap-2">
            <span class="accent-soft px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-semibold">WEBRING</span>
            <a href="\${homeHref}" target="_blank" rel="noopener noreferrer" class="font-bold hover:underline">\${esc(ring.name)}</a>
            <span class="opacity-70 hidden sm:inline">— \${esc(ring.description || '')}</span>
          </div>
          <div class="flex items-center gap-3 font-medium">
            \${links}
            <a href="\${buildDeepLink('join-ring', ring.hubUrl, ring.name)}" class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30">Join Ring</a>
          </div>
        </div>
      \`;
      }).join('');

      // Hub-supplied addresses are untrusted: absolute https only, no credentials
      function ringSiteUrl(value) {
        try {
          const u = new URL(String(value || ''));
          if (u.protocol !== 'https:' || u.username || u.password) return null;
          return u.origin + u.pathname.replace(/\\/+$/, '');
        } catch (e) {
          return null;
        }
      }

      async function fetchRingHub(hubUrl) {
        const controller = new AbortController();
        const timer = setTimeout(function() { controller.abort(); }, 2000);
        try {
          const res = await fetch(hubUrl, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal });
          if (!res.ok) return null;
          const text = await res.text();
          if (text.length > 1000000) return null;
          const doc = JSON.parse(text);
          if (!doc || !Array.isArray(doc.members) || doc.status === 'closed') return null;
          return doc;
        } catch (e) {
          return null;
        } finally {
          clearTimeout(timer);
        }
      }

      root.addEventListener('click', async function(ev) {
        const anchor = ev.target && ev.target.closest ? ev.target.closest('a[data-ring-nav]') : null;
        if (!anchor) return;
        const ring = (connections.webrings || [])[Number(anchor.getAttribute('data-ring-index'))];
        const hubUrl = ring ? ringSiteUrl(ring.hubUrl) : null;
        if (!hubUrl) return;
        ev.preventDefault();
        const nav = anchor.getAttribute('data-ring-nav');
        const fallback = anchor.getAttribute('href');
        let target = null;
        const doc = await fetchRingHub(ring.hubUrl);
        if (doc) {
          const me = ringSiteUrl(profile.siteUrl);
          const rotation = [];
          doc.members.forEach(function(m) {
            const url = m ? ringSiteUrl(m.siteUrl) : null;
            if (url && (m.inRotation !== false || url === me) && rotation.indexOf(url) === -1) rotation.push(url);
          });
          const others = rotation.filter(function(u) { return u !== me; });
          const idx = rotation.indexOf(me);
          if (nav === 'random') {
            target = others.length ? others[Math.floor(Math.random() * others.length)] : null;
          } else if (idx !== -1 && rotation.length > 1) {
            const step = nav === 'prev' ? -1 : 1;
            target = rotation[(idx + step + rotation.length) % rotation.length];
          }
        }
        const destination = target || fallback;
        if (destination && destination.charAt(0) !== '#') window.location.assign(destination);
      });

      function renderPhotoCard(photo, album, extraClass) {
        const likes = getEndorsementsFor(photo.canonicalUrl);
        return \`
          <div class="card-surface rounded-xl overflow-hidden flex flex-col justify-between \${extraClass || ''}">
            <div>
              <a href="\${safeUrl(photo.url)}" target="_blank" rel="noopener noreferrer" data-lightbox data-photo-id="\${esc(photo.id)}" class="block aspect-[4/3] overflow-hidden bg-black/20">
                <img src="\${safeUrl(photo.thumbUrl || photo.url)}" alt="\${esc(photo.altText || photo.caption)}" class="w-full h-full object-cover hover:scale-105 transition-transform duration-300" />
              </a>
              <div class="p-3.5">
                \${photo.caption ? \`<p class="text-sm font-medium mb-1">\${esc(photo.caption)}</p>\` : ''}
                <div class="flex flex-wrap gap-1 mb-2">
                  \${(photo.tags || []).map(t => \`<span class="text-[11px] opacity-70">#\${esc(t)}</span>\`).join(' ')}
                </div>
                \${likes.length > 0 ? \`
                  <div class="text-[11px] opacity-80 bg-pink-500/10 border border-pink-500/20 rounded px-2 py-1 mb-2">
                    ♥ Liked/Shared by \${likes.map(l => esc(l.authorName)).join(', ')}
                  </div>
                \` : ''}
              </div>
            </div>
            <div class="px-3.5 pb-3 pt-1 flex items-center justify-between border-t border-white/10 text-xs">
              <a href="\${safeUrl(photo.canonicalUrl)}" class="opacity-60 hover:opacity-100" title="Canonical Schema Index">Index ID</a>
              <div class="flex gap-2">
                <a href="\${buildDeepLink('like', photo.canonicalUrl, photo.caption || album.title, photo.url, 'photo')}" class="px-2.5 py-1 rounded bg-pink-500/20 text-pink-300 hover:bg-pink-500/30 font-medium">♥ Like</a>
                <a href="\${buildDeepLink('share', photo.canonicalUrl, photo.caption || album.title, photo.url, 'photo')}" class="accent-soft px-2.5 py-1 rounded bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 font-medium">↻ Share</a>
              </div>
            </div>
          </div>
        \`;
      }

      function renderAlbum(album, style) {
        const carousel = style === 'carousel';
        const photosHtml = (album.photos || [])
          .map(photo => renderPhotoCard(photo, album, carousel ? 'shrink-0 w-64 snap-start' : ''))
          .join('');
        return \`
          <div class="mb-8">
            <div class="flex items-start justify-between gap-4 mb-3">
              <div class="min-w-0 flex-1">
                <h3 class="text-xl font-bold">\${esc(album.title)}</h3>
                \${album.description ? \`<div class="prose-block album-description text-sm opacity-90">\${renderMarkdown(album.description)}</div>\` : ''}
              </div>
              <a href="\${buildDeepLink('share', album.canonicalUrl, album.title, album.coverUrl, 'photo')}" class="accent-soft shrink-0 text-xs px-3 py-1 rounded-lg bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30">Share Album</a>
            </div>
            <div class="\${carousel ? 'flex gap-4 overflow-x-auto snap-x pb-2' : 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4'}">
              \${photosHtml}
            </div>
          </div>
        \`;
      }

      // A post whose title is just its opening Markdown heading shows the heading only
      function titleIsOpeningHeading(item) {
        if (item.type !== 'post') return false;
        const first = String(item.commentary || '').trim().split('\\n')[0];
        return /^#{1,6}\\s/.test(first) && markdownToPlainText(first) === item.title;
      }

      // "edited" next to an item that changed after it was first published
      function editedNote(item) {
        const d = item.updatedAt ? new Date(item.updatedAt) : null;
        if (!d || isNaN(d.getTime())) return '';
        return ' • <span class="item-edited" title="Edited ' + esc(d.toLocaleString()) + '">edited</span>';
      }

      function renderItem(item) {
        const badgeColor = item.type === 'post'
          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
          : item.type === 'like'
          ? 'bg-pink-500/20 text-pink-300'
          : item.type === 'recommendation'
          ? 'bg-amber-500/20 text-amber-300'
          : item.type === 'comment'
          ? 'bg-purple-500/20 text-purple-300'
          : 'bg-sky-500/20 text-sky-300';
        const endorsements = getEndorsementsFor(item.canonicalUrl).filter(e => e.type !== 'comment');
        const comments = getCommentsFor(item.canonicalUrl);
        const isSelfPost = item.type === 'post' && (!item.targetUrl || item.targetUrl === item.canonicalUrl);
        const liveContainerId = 'live-comments-' + esc(item.id);
        const hasLiveProvider = profile.commentConfig && profile.commentConfig.provider && profile.commentConfig.provider !== 'none';

        return \`
          <div class="card-surface rounded-xl p-4 flex flex-col justify-between \${item.type === 'post' ? 'md:col-span-2' : ''}">
            <div>
              <div class="flex items-center justify-between gap-2 mb-2">
                <span class="text-xs uppercase tracking-wider font-bold px-2.5 py-0.5 rounded-full \${badgeColor}">\${item.type === 'post' ? '📝 Wall Post' : esc(item.type)}</span>
                <span class="text-xs opacity-60">\${esc(item.category)} \${item.rating && item.type !== 'post' && item.type !== 'comment' ? '• ' + '★'.repeat(Math.min(5, Math.max(1, Number(item.rating) || 5))) : ''}\${editedNote(item)}</span>
              </div>
              \${item.mediaUrl ? \`<img src="\${safeUrl(item.mediaUrl)}" class="w-full \${item.type === 'post' ? 'max-h-80' : 'h-40'} object-cover rounded-lg mb-3" />\` : ''}
              \${titleIsOpeningHeading(item) ? '' : \`<h4 class="font-bold text-base mb-1">
                \${isSelfPost ? \`<span>\${esc(item.title)}</span>\` : \`<a href="\${safeUrl(item.targetUrl)}" target="_blank" rel="noopener noreferrer" class="hover:underline">\${esc(item.title)} ↗</a>\`}
              </h4>\`}
              \${item.targetAuthorName ? \`<p class="text-xs opacity-70 mb-2">\${item.type === 'comment' ? 'Replying to' : 'Source'}: <a href="\${safeUrl(item.targetAuthorUrl || item.targetUrl)}" target="_blank" rel="noopener noreferrer" class="underline">\${esc(item.targetAuthorName)}</a></p>\` : ''}
              \${item.type === 'post'
                ? (item.commentary ? \`<div class="prose-block post-body text-sm opacity-90 mb-3">\${renderMarkdown(item.commentary)}</div>\` : '')
                : \`<p class="text-sm opacity-90 mb-3 whitespace-pre-line">\${esc(item.commentary || '')}</p>\`}
              <div class="flex flex-wrap gap-1.5 mb-3">
                \${(item.tags || []).map(t => \`<span class="text-xs px-2 py-0.5 rounded bg-white/5 opacity-75">#\${esc(t)}</span>\`).join('')}
              </div>
              \${endorsements.length > 0 ? \`
                <div class="text-xs opacity-85 bg-emerald-500/10 border border-emerald-500/20 rounded px-2.5 py-1.5 mb-3">
                  ↻ Endorsed by \${endorsements.map(e => esc(e.authorName)).join(', ')}
                </div>
              \` : ''}
              \${comments.length > 0 ? \`
                <div class="mt-3 mb-3 pt-2.5 border-t border-white/10 space-y-2">
                  <p class="text-xs font-bold opacity-80">💬 Comments (\${comments.length})</p>
                  \${comments.map(c => \`
                    <div class="p-2.5 rounded-lg bg-black/20 border border-white/10 text-xs space-y-1">
                      <div class="flex items-center justify-between">
                        <a href="\${safeUrl(c.authorSiteUrl)}" target="_blank" rel="noopener noreferrer" class="accent-text font-bold text-indigo-300 hover:underline">\${esc(c.authorName)}</a>
                      </div>
                      <p class="opacity-90 whitespace-pre-line">\${esc(c.commentary || '')}</p>
                    </div>
                  \`).join('')}
                </div>
              \` : ''}
              <div id="\${liveContainerId}" class="hidden mt-3 mb-3 p-3 rounded-xl bg-black/30 border border-indigo-500/30"></div>
            </div>
            <div class="pt-2 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span class="flex items-center gap-3">
                <a href="\${safeUrl(item.canonicalUrl)}" class="opacity-60 hover:opacity-100">Schema URI</a>
                <button type="button" data-open-post="\${esc(item.id)}" class="opacity-70 hover:opacity-100 font-medium" aria-label="Open post">⤢ Open</button>
              </span>
              <div class="flex flex-wrap gap-2">
                <a href="\${buildDeepLink('like', item.canonicalUrl, item.title, item.mediaUrl, item.category)}" class="px-2.5 py-1 rounded bg-pink-500/20 text-pink-300 hover:bg-pink-500/30 font-medium">♥ Like</a>
                <a href="\${buildDeepLink('comment', item.canonicalUrl, item.title, item.mediaUrl, 'comment')}" class="px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 font-medium">💬 Comment</a>
                <a href="\${buildDeepLink('share', item.targetUrl, item.title, item.mediaUrl, item.category)}" class="accent-soft px-2.5 py-1 rounded bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 font-medium">↻ Re-Share</a>
                \${hasLiveProvider ? \`<button data-container="\${liveContainerId}" data-canonical="\${esc(item.canonicalUrl)}" onclick="window.toggleLiveCommentThread(this.getAttribute('data-container'), this.getAttribute('data-canonical'))" class="px-2.5 py-1 rounded bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 font-medium">💬 Live Thread</button>\` : ''}
              </div>
            </div>
          </div>
        \`;
      }

      function renderFriend(friend) {
        return \`
          <a href="\${safeUrl(friend.siteUrl)}" target="_blank" rel="noopener noreferrer" class="card-surface rounded-xl p-3.5 flex items-center gap-3 hover:border-indigo-400/50 transition">
            <img src="\${safeUrl(friend.avatarUrl || 'https://api.dicebear.com/7.x/shapes/svg?seed=' + encodeURIComponent(friend.displayName))}" class="w-12 h-12 rounded-full object-cover border border-white/20" />
            <div class="min-w-0 flex-1">
              <h4 class="font-bold text-sm truncate">\${esc(friend.displayName)}</h4>
              <p class="text-xs opacity-70 truncate">\${esc(friend.siteUrl)}</p>
              <div class="flex flex-wrap gap-1 mt-1">
                \${(friend.relationship || []).map(rel => \`<span class="accent-soft text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">\${esc(rel)}</span>\`).join('')}
              </div>
            </div>
          </a>
        \`;
      }

      function renderAdSlot(slotId, label) {
        const adsCfg = profile.adsAddon;
        if (!adsCfg || !adsCfg.enabled || !adsCfg.publisherId || !/^[0-9]{5,20}$/.test(String(slotId || '').trim())) {
          return '';
        }
        const cleanClient = esc(adsCfg.publisherId);
        const cleanSlot = esc(String(slotId).trim());
        return \`
          <div class="card-surface rounded-xl p-3 mb-8 text-center overflow-hidden" data-ad-position="\${esc(label)}">
            <p class="text-[10px] uppercase tracking-wider opacity-50 mb-1.5">Sponsored • \${esc(label)}</p>
            <ins class="adsbygoogle"
                 style="display:block"
                 data-ad-client="\${cleanClient}"
                 data-ad-slot="\${cleanSlot}"
                 data-ad-format="auto"
                 data-full-width-responsive="true"></ins>
          </div>
        \`;
      }

      const headerAdHtml = renderAdSlot(profile.adsAddon && profile.adsAddon.headerSlotId, 'Profile Banner Slot');
      const inFeedAdHtml = renderAdSlot(profile.adsAddon && profile.adsAddon.inFeedSlotId, 'In-Feed Slot');
      const footerAdHtml = renderAdSlot(profile.adsAddon && profile.adsAddon.footerSlotId, 'Footer Slot');

      // Page blocks (Site Design). A block's title replaces the default heading; an empty title hides it.
      function section(block, defaultTitle, inner) {
        const title = typeof block.title === 'string' ? block.title : defaultTitle;
        return '<section class="mb-12" data-block="' + esc(block.type) + '">' +
          (title ? '<h2 class="text-2xl font-bold mb-4 flex items-center gap-2">' + esc(title) + '</h2>' : '') +
          inner + '</section>';
      }
      const emptyNote = (text) => '<p class="opacity-60 text-sm">' + esc(text) + '</p>';
      const allItems = items.items || [];
      const allAlbums = albums.albums || [];
      const allFriends = connections.friends || [];
      const linkButtons = (links, rel) => '<div class="flex flex-wrap gap-3">' + (links || [])
        .filter(l => l && l.url)
        .map(l => '<a href="' + safeUrl(l.url) + '" target="_blank" rel="noopener noreferrer' + (rel ? ' ' + rel : '') + '" class="accent-solid px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm shadow">' + esc(l.label || l.url) + '</a>')
        .join('') + '</div>';
      const commentCfg = profile.commentConfig || {};
      const hasGuestbook = (commentCfg.provider === 'giscus' || commentCfg.provider === 'utterances') && commentCfg.giscusRepo;

      // The guestbook is a page-wide comment thread, loaded only when a visitor asks for it
      window.openGuestbook = function() {
        window.toggleLiveCommentThread('guestbook-thread', profile.siteUrl + '#guestbook');
      };

      const blockRenderers = {
        albums: (b) => {
          const ids = b.options && Array.isArray(b.options.albumIds) && b.options.albumIds.length ? b.options.albumIds : null;
          const list = ids ? allAlbums.filter(a => ids.includes(a.id)) : allAlbums;
          const html = list.map(a => renderAlbum(a, b.options && b.options.style)).join('');
          return section(b, '📸 Photo Albums', html || emptyNote('No photo albums published yet.'));
        },
        items: (b) => {
          const kinds = b.options && Array.isArray(b.options.kinds) ? b.options.kinds : null;
          let list = kinds ? allItems.filter(i => kinds.includes(i.type)) : allItems;
          if (b.options && b.options.limit) list = list.slice(0, b.options.limit);
          return section(b, '✨ Shared Items & Things I Like',
            '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">' + (list.map(renderItem).join('') || emptyNote('Nothing shared here yet.')) + '</div>');
        },
        friends: (b) => allFriends.length
          ? section(b, '🤝 Friend Ring & Connections (' + allFriends.length + ')',
              '<div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">' + allFriends.map(renderFriend).join('') + '</div>')
          : '',
        text: (b) => {
          const markdown = b.options && b.options.markdown;
          return markdown ? section(b, '', '<div class="card-surface rounded-xl p-5 prose-block">' + renderMarkdown(markdown) + '</div>') : '';
        },
        image: (b) => {
          const o = b.options || {};
          if (!o.url) return '';
          const img = '<img src="' + safeUrl(o.url) + '" alt="' + esc(o.alt || '') + '" class="w-full rounded-xl object-cover" />';
          const linked = o.link ? '<a href="' + safeUrl(o.link) + '" target="_blank" rel="noopener noreferrer">' + img + '</a>' : img;
          return section(b, '', '<figure class="card-surface rounded-xl overflow-hidden p-2">' + linked +
            (o.caption ? '<figcaption class="text-sm opacity-80 px-2 pt-2 pb-1">' + esc(o.caption) + '</figcaption>' : '') + '</figure>');
        },
        links: (b) => (b.options && (b.options.links || []).length) ? section(b, '', linkButtons(b.options.links, '')) : '',
        featured: (b) => {
          const target = b.options && b.options.canonicalUrl;
          if (!target) return '';
          const item = allItems.find(i => i.canonicalUrl === target);
          if (item) return section(b, '⭐ Featured', '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">' + renderItem(item) + '</div>');
          const album = allAlbums.find(a => a.canonicalUrl === target);
          if (album) return section(b, '⭐ Featured', renderAlbum(album, 'grid'));
          for (const a of allAlbums) {
            const photo = (a.photos || []).find(p => p.canonicalUrl === target);
            if (photo) return section(b, '⭐ Featured', '<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">' + renderPhotoCard(photo, a, '') + '</div>');
          }
          return '';
        },
        contact: (b) => (b.options && (b.options.entries || []).length) ? section(b, '✉️ Contact & Elsewhere', linkButtons(b.options.entries, 'me')) : '',
        guestbook: (b) => hasGuestbook
          ? section(b, '📖 Guestbook', '<div class="card-surface rounded-xl p-4"><button onclick="window.openGuestbook()" class="accent-solid px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold">Open Guestbook</button><div id="guestbook-thread" class="hidden mt-3"></div></div>')
          : '',
      };

      const layout = Array.isArray(profile.layout) ? profile.layout : DEFAULT_LAYOUT;
      const visibleBlocks = layout
        .filter(b => b && b.visible !== false && Object.prototype.hasOwnProperty.call(blockRenderers, b.type));
      const renderedBlocks = visibleBlocks
        .map(b => blockRenderers[b.type](b))
        .filter(Boolean);
      // The in-feed ad slot goes after the first block, as it did between albums and items
      const blocksHtml = renderedBlocks.length
        ? renderedBlocks[0] + inFeedAdHtml + renderedBlocks.slice(1).join('')
        : inFeedAdHtml;

      // Older posts: items.json holds the recent window; signed monthly archives hold the rest and
      // load on request (in the preview they're embedded, since it can't fetch)
      const archiveMonths = items.archive && Array.isArray(items.archive.months)
        ? items.archive.months.filter(m => m && /^\\/?api\\/archive\\/items-\\d{4}-\\d{2}\\.json$/.test(String(m.url)) && /^\\d{4}-\\d{2}$/.test(String(m.month)))
        : [];
      const monthLabel = (month) => {
        const d = new Date(month + '-01T00:00:00Z');
        return isNaN(d.getTime()) ? month : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
      };
      const showsItems = visibleBlocks.some(b => b.type === 'items');
      const olderPostsHtml = archiveMonths.length && showsItems
        ? '<section class="mb-12 older-posts" data-archive><h2 class="text-2xl font-bold mb-4">Older posts</h2>' +
          '<div class="flex flex-wrap gap-2">' + archiveMonths.map(m =>
            '<button type="button" class="older-month px-3 py-1.5 rounded-lg card-surface text-sm" data-archive-url="' + esc(m.url) + '" data-archive-label="' + esc(monthLabel(m.month)) + '">' +
            esc(monthLabel(m.month)) + ' <span class="opacity-60">(' + (Number(m.count) || 0) + ')</span></button>').join('') +
          '</div><div class="older-list mt-4" data-archive-list></div></section>'
        : '';
      const archiveView = { renderItem: renderItem, wrapClass: 'grid grid-cols-1 md:grid-cols-2 gap-4' };

      const footerHtml = \`
        <footer class="text-center text-xs opacity-60 pt-8 border-t border-white/10">
          <p>Self-contained static profile powered by <strong>Webring Studio JSON Protocol v\${esc(data.manifest.schemaVersion)}</strong> • Cryptographically signed via <code>\${esc(profile.did)}</code></p>
        </footer>\`;

      if (template.shell !== 'stack') {
        root.innerHTML = renderTemplatePage({
          shell: template.shell, profile, albums: allAlbums, items: allItems, friends: allFriends,
          endorsementCount: (connections.endorsements || []).length, layout: visibleBlocks,
          blockRenderers, section, emptyNote, esc, safeUrl, buildDeepLink, getEndorsementsFor, getCommentsFor, renderMarkdown, markdownToPlainText,
          hasLiveProvider: Boolean(commentCfg.provider && commentCfg.provider !== 'none'),
          webringBars, headerAdHtml, inFeedAdHtml, footerAdHtml, footerHtml, olderPostsHtml, archiveView
        });
      } else root.innerHTML = \`
        \${webringBars}
        <div class="card-surface rounded-2xl overflow-hidden mb-8 shadow-xl">
          \${profile.bannerUrl ? \`<div class="profile-banner h-48 sm:h-60 w-full overflow-hidden bg-slate-800"><img src="\${safeUrl(profile.bannerUrl)}" class="w-full h-full object-cover" /></div>\` : ''}
          <div class="p-6 sm:p-8 flex flex-col sm:flex-row sm:items-end justify-between gap-6 \${profile.bannerUrl ? '-mt-16' : ''}">
            <div class="flex flex-col sm:flex-row sm:items-end gap-5">
              \${profile.avatarUrl ? \`<img src="\${safeUrl(profile.avatarUrl)}" class="profile-avatar w-28 h-28 rounded-2xl object-cover border-4 border-slate-900 shadow-lg bg-slate-800" />\` : ''}
              <div>
                <div class="flex flex-wrap items-center gap-2">
                  <h1 class="text-2xl sm:text-3xl font-extrabold">\${esc(profile.displayName)}</h1>
                  <span class="text-xs px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono" title="Verified Ed25519 DID Identity">\${esc(profile.did)}</span>
                </div>
                <p class="text-sm opacity-80 mt-1">\${esc(profile.tagline || '')}</p>
              </div>
            </div>
            <div class="flex flex-wrap gap-2">
              <a href="\${buildDeepLink('friend', profile.siteUrl, profile.displayName, profile.avatarUrl)}" class="accent-solid px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm shadow">
                + Add to Friend Ring
              </a>
              <a href="./api/manifest.json" target="_blank" rel="noopener noreferrer" class="px-3 py-2 rounded-xl card-surface text-xs font-mono hover:opacity-80">
                JSON API
              </a>
            </div>
          </div>
          <div class="px-6 sm:px-8 pb-6">
            <p class="text-base leading-relaxed max-w-3xl mb-4">\${esc(profile.bio || '')}</p>
            <div class="flex flex-wrap gap-2 mb-4">
              \${(profile.interests || []).map(tag => \`<span class="text-xs px-3 py-1 rounded-full bg-white/10 font-medium">#\${esc(tag)}</span>\`).join('')}
            </div>
            <div class="flex flex-wrap gap-4 text-xs opacity-80 pt-3 border-t border-white/10">
              \${profile.location ? \`<span>📍 \${esc(profile.location)}</span>\` : ''}
              \${profile.atprotoHandle ? \`<span>🦋 ATProto: @\${esc(profile.atprotoHandle)}</span>\` : ''}
              \${(profile.customLinks || []).map(l => \`<a href="\${safeUrl(l.url)}" target="_blank" rel="noopener noreferrer" class="underline hover:opacity-100">🔗 \${esc(l.label)}</a>\`).join('')}
            </div>
          </div>
        </div>

        \${headerAdHtml}

        \${blocksHtml}
        \${olderPostsHtml}

        \${footerAdHtml}
        \${footerHtml}
      \`;

      // Interactive extras: lightbox, post view, sortable tables (pageEnhancements.ts)
      const installPageEnhancements = ${enhancementsSource};
      let enhancements = null;
      if (installPageEnhancements && !(profile.appearance && profile.appearance.interactions === 'off')) {
        try {
          enhancements = installPageEnhancements({ root, profile, albums: allAlbums, items: allItems, esc, safeUrl, buildDeepLink, renderItem, projectUrl: ${JSON.stringify(WEBRING_STUDIO_URL)} });
        } catch (err) {
          console.warn('Interactive extras unavailable:', err);
        }
      }

      // Loading an archive month appends its posts in the page's layout
      async function loadArchiveItems(url) {
        const embedded = window.__WEBRING_ARCHIVES__;
        let doc = embedded && Object.prototype.hasOwnProperty.call(embedded, url) ? embedded[url] : null;
        if (!doc && window.location.protocol.startsWith('http')) {
          const res = await fetch('./' + String(url).replace(/^\\/+/, ''), { credentials: 'omit' });
          if (res.ok) doc = await res.json();
        }
        if (!doc || !Array.isArray(doc.items)) throw new Error('Archive unavailable');
        return doc.items.filter(i => i && typeof i.id === 'string' && typeof i.canonicalUrl === 'string');
      }
      root.addEventListener('click', async function(ev) {
        const button = ev.target && ev.target.closest ? ev.target.closest('[data-archive-url]') : null;
        if (!button || button.disabled) return;
        const list = root.querySelector('[data-archive-list]');
        if (!list) return;
        button.disabled = true;
        try {
          const loaded = await loadArchiveItems(button.getAttribute('data-archive-url'));
          loaded.forEach(i => allItems.push(i));
          if (enhancements && enhancements.addItems) enhancements.addItems(loaded);
          const group = document.createElement('div');
          group.className = 'older-month-items mb-8';
          group.innerHTML = '<h3 class="text-lg font-bold mb-3">' + esc(button.getAttribute('data-archive-label')) + '</h3>' +
            '<div class="' + archiveView.wrapClass + '">' + loaded.map(archiveView.renderItem).join('') + '</div>';
          list.appendChild(group);
          button.classList.add('opacity-50');
        } catch (err) {
          button.disabled = false;
          button.setAttribute('title', 'Couldn\\'t load this month. Try again.');
        }
      });

      // Initialize any rendered AdSense slots
      if (profile.adsAddon && profile.adsAddon.enabled && typeof window !== 'undefined') {
        const adNodes = root.querySelectorAll('ins.adsbygoogle');
        adNodes.forEach(() => {
          try {
            (window.adsbygoogle = window.adsbygoogle || []).push({});
          } catch (e) {}
        });
      }

      // Optional GA4 Webring interaction click tracking
      if (profile.analyticsAddon && profile.analyticsAddon.enabled && profile.analyticsAddon.trackRingInteractions !== false && typeof window.gtag === 'function') {
        root.addEventListener('click', function(ev) {
          const anchor = ev.target && ev.target.closest ? ev.target.closest('a[href^="webring://"]') : null;
          if (anchor) {
            window.gtag('event', 'webring_interact', {
              href: anchor.getAttribute('href') || ''
            });
          }
        });
      }
    })();
  </script>${preview ? PREVIEW_BRIDGE : ''}
</body>
</html>`;
  }

  /** Look & feel as <body> attributes, so the published page is styled before its script runs. */
  private appearanceAttributes(appearance: Appearance): string {
    const attrs: string[] = [];
    if (appearance.font && appearance.font !== 'theme') attrs.push(`data-font="${appearance.font}"`);
    if (appearance.corners && appearance.corners !== 'rounded') attrs.push(`data-corners="${appearance.corners}"`);
    if (appearance.surface === 'flat') attrs.push('data-surface="flat"');
    if (appearance.bannerHeight && appearance.bannerHeight !== 'medium') attrs.push(`data-banner="${appearance.bannerHeight}"`);
    if (appearance.avatarShape === 'circle') attrs.push('data-avatar="circle"');
    if (appearance.background && appearance.background !== 'theme') attrs.push(`data-background="${appearance.background}"`);
    if (appearance.accent && /^#[0-9a-fA-F]{6}$/.test(appearance.accent)) {
      const n = parseInt(appearance.accent.slice(1), 16);
      const luminance = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
      attrs.push('data-accent', `style="--accent: ${appearance.accent}; --accent-ink: ${luminance > 0.6 ? '#0b1020' : '#ffffff'}"`);
    }
    return attrs.length ? ` ${attrs.join(' ')}` : '';
  }

  private escapeHtml(str: string): string {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}


/** JSON that's safe inside a <script> element. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/** Where "What's Webring Studio?" on a published page points. */
const WEBRING_STUDIO_URL = 'https://github.com/lnsCorey/webring';

/**
 * Studio preview only (sandboxed iframe): links never navigate the preview. webring:// actions
 * open the matching form in Studio and web links open in the browser, via postMessage.
 */
const PREVIEW_BRIDGE = `
  <script>
    document.addEventListener('click', function(ev) {
      var anchor = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!anchor) return;
      var href = anchor.getAttribute('href') || '';
      if (href.charAt(0) === '#') return;
      if (anchor.closest('[data-lightbox], [data-open-post]')) return; // opens in the page's own viewer
      ev.preventDefault();
      ev.stopPropagation();
      if (/^webring:/i.test(href)) parent.postMessage({ type: 'webring-preview-deeplink', href: href }, '*');
      else if (/^https?:/i.test(anchor.href)) parent.postMessage({ type: 'webring-preview-open', href: anchor.href }, '*');
    }, true);
  </script>`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only absolute http(s) URLs make it into links; anything else is dropped. */
function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A plain, script-free page listing a hosted ring's members, so the ring is browsable without
 * JavaScript and "Random" has somewhere to land when scripts are off.
 */
export function buildRingDirectoryHtml(doc: WebringHubDocument): string {
  const closed = doc.status === 'closed';
  const members = doc.members
    .map((m) => {
      const href = safeExternalUrl(m.siteUrl);
      const name = escapeHtml(m.displayName.slice(0, 120));
      return href
        ? `<li><a href="${escapeHtml(href)}" rel="noopener">${name}</a> <span>${escapeHtml(new URL(href).host)}</span></li>`
        : '';
    })
    .join('\n      ');
  const joinLink = `webring://interact?action=join-ring&targetUrl=${encodeURIComponent(doc.hubUrl)}&title=${encodeURIComponent(doc.name)}`;
  const maintainer = safeExternalUrl(doc.maintainerUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:;" />
  <title>${escapeHtml(doc.name)} · Webring</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1e293b; background: #f8fafc; }
    @media (prefers-color-scheme: dark) { body { color: #e2e8f0; background: #0f172a; } a { color: #a5b4fc; } }
    li { margin: 0.35rem 0; } li span { opacity: 0.6; font-size: 0.85em; }
    .note { opacity: 0.75; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>${escapeHtml(doc.name)}</h1>
  <p>${escapeHtml(doc.description)}</p>
  ${
    closed
      ? '<p><strong>This ring has closed.</strong></p>'
      : `<h2>Members (${doc.members.length})</h2>
  <ol>
      ${members}
  </ol>
  <h2>Join this ring</h2>
  <p>Membership is curated${maintainer ? ` by <a href="${escapeHtml(maintainer)}" rel="noopener">the maintainer</a>` : ''}. In Webring Studio, <a href="${escapeHtml(joinLink)}">open this ring</a> (or paste the hub address below into Friends &amp; Webrings → Join a ring), then send the maintainer the request link Studio gives you.</p>
  <p class="note">Hub: <code>${escapeHtml(doc.hubUrl)}</code></p>`
  }
</body>
</html>
`;
}
