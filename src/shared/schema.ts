import { z } from 'zod';

// Lazy loader for Node crypto so browser bundles don't warn on static import
function getNodeCrypto(): typeof import('crypto') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('crypto');
}

// ============================================================================
// 1. Standardized Webring & Federated Profile JSON Schemas (v1.0)
// ============================================================================

export const WEBRING_SCHEMA_VERSION = '1.0.0';

/**
 * Cryptographic authorship proof attached to published JSON documents.
 * Uses Ed25519 keys exposed in /.well-known/did.json
 */
export const SignatureProofSchema = z.object({
  type: z.literal('Ed25519Signature2020'),
  created: z.string(),
  verificationMethod: z.string(), // e.g., did:web:example.com#key-1
  signatureValue: z.string(),     // base64url encoded signature of canonical payload
});
export type SignatureProof = z.infer<typeof SignatureProofSchema>;

/**
 * W3C / ATProto compatible did:web Document (/.well-known/did.json)
 */
export const DidDocumentSchema = z.object({
  '@context': z.array(z.string()),
  id: z.string(), // did:web:domain.com
  alsoKnownAs: z.array(z.string()).optional(),
  verificationMethod: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      controller: z.string(),
      publicKeyMultibase: z.string().optional(),
      publicKeyPem: z.string().optional(),
    })
  ),
  service: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      serviceEndpoint: z.string(),
    })
  ),
});
export type DidDocument = z.infer<typeof DidDocumentSchema>;

/**
 * Site Manifest (/api/manifest.json)
 * Entrypoint for crawlers and other Electron Studio clients.
 */
export const WebringManifestSchema = z.object({
  schemaVersion: z.string().default(WEBRING_SCHEMA_VERSION),
  siteUrl: z.string(),
  did: z.string(),
  updatedAt: z.string(),
  endpoints: z.object({
    did: z.string().default('/.well-known/did.json'),
    profile: z.string().default('/api/profile.json'),
    albums: z.string().default('/api/albums.json'),
    items: z.string().default('/api/items.json'),
    connections: z.string().default('/api/connections.json'),
  }),
  stats: z.object({
    albumCount: z.number(),
    photoCount: z.number(),
    itemCount: z.number(),
    friendCount: z.number(),
    webringCount: z.number(),
  }),
  proof: SignatureProofSchema.optional(),
});
export type WebringManifest = z.infer<typeof WebringManifestSchema>;

/**
 * Theme options for the standalone Profile Website
 */
export const ProfileThemeSchema = z.enum([
  'neo-webring',     // Classic indie web meets crisp modern cards
  'minimal-zine',    // Editorial serif typography & clean whitespace
  'cyber-terminal',  // High-contrast dark neon retro terminal
  'cozy-scrapbook',  // Warm paper tones & polaroid photo frames
  // Social-style templates: each also rearranges the page (see electron/services/siteTemplates.ts)
  'facepace',        // Cover photo, intro sidebar and a feed of post cards
  'tweetdeck',       // Old-school sky blue, every block in its own column
  'xtraspecial',     // Black timeline between a navigation rail and a widgets rail
  'instapick',       // Stats header, album highlights and a square photo grid
  'tiktalk',         // Dark vertical reel of tall media cards
]);
export type ProfileTheme = z.infer<typeof ProfileThemeSchema>;

/** Display names for every theme, used by Studio and the MCP tools. */
export const THEME_LABELS: Record<ProfileTheme, string> = {
  'neo-webring': 'Neo-Webring',
  'minimal-zine': 'Minimal Zine',
  'cyber-terminal': 'Cyber Terminal',
  'cozy-scrapbook': 'Cozy Scrapbook',
  facepace: 'Facepace',
  tweetdeck: 'Tweetdeck',
  xtraspecial: 'XtraSpecial',
  instapick: 'Instapick',
  tiktalk: 'Tik Talk',
};

/**
 * Profile Document (/api/profile.json)
 */
export const CommentConfigSchema = z.object({
  provider: z.enum(['none', 'giscus', 'utterances']).default('none'),
  giscusRepo: z.string().optional(),
  giscusRepoId: z.string().optional(),
  giscusCategory: z.string().optional(),
  giscusCategoryId: z.string().optional(),
});
export type CommentConfig = z.infer<typeof CommentConfigSchema>;

/**
 * Optional Profile Add-On 1: Google Analytics (GA4)
 */
export const AnalyticsAddonSchema = z.object({
  enabled: z.boolean().default(false),
  measurementId: z.string().default(''), // e.g., G-XXXXXXXXXX
  respectDoNotTrack: z.boolean().default(true),
  anonymizeIp: z.boolean().default(true),
  trackRingInteractions: z.boolean().default(true),
});
export type AnalyticsAddon = z.infer<typeof AnalyticsAddonSchema>;

/**
 * Optional Profile Add-On 2: Google AdSense / Ads Monetization
 */
export const AdsAddonSchema = z.object({
  enabled: z.boolean().default(false),
  publisherId: z.string().default(''), // e.g., ca-pub-1234567890123456
  enableAutoAds: z.boolean().default(true),
  generateAdsTxt: z.boolean().default(true),
  headerSlotId: z.string().default(''),
  inFeedSlotId: z.string().default(''),
  footerSlotId: z.string().default(''),
});
export type AdsAddon = z.infer<typeof AdsAddonSchema>;

export function isValidGa4MeasurementId(rawId?: string): boolean {
  if (!rawId) return false;
  return /^G-[A-Z0-9]{4,20}$/i.test(rawId.trim());
}

export function normalizeAdSensePublisherId(rawId?: string): string {
  if (!rawId) return '';
  const trimmed = rawId.trim();
  if (/^ca-pub-\d{10,20}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^pub-\d{10,20}$/i.test(trimmed)) return `ca-${trimmed.toLowerCase()}`;
  return '';
}

export function isValidAdSlotId(rawSlotId?: string): boolean {
  if (!rawSlotId) return false;
  return /^\d{5,20}$/.test(rawSlotId.trim());
}

/**
 * Look & feel options layered over the theme palette. Every field is optional and invalid values
 * are simply dropped (a friend's odd profile never fails to parse); missing means "as the theme".
 */
export const AppearanceSchema = z
  .object({
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().catch(undefined),
    font: z.enum(['theme', 'sans', 'serif', 'rounded', 'mono']).optional().catch(undefined),
    corners: z.enum(['sharp', 'rounded', 'soft']).optional().catch(undefined),
    surface: z.enum(['card', 'flat']).optional().catch(undefined),
    bannerHeight: z.enum(['short', 'medium', 'tall']).optional().catch(undefined),
    avatarShape: z.enum(['rounded', 'circle']).optional().catch(undefined),
    background: z.enum(['theme', 'gradient', 'banner-blur']).optional().catch(undefined),
    /** Lightbox, post view and sortable tables on the published page; missing means on. */
    interactions: z.enum(['on', 'off']).optional().catch(undefined),
  })
  .catch({});
export type Appearance = z.infer<typeof AppearanceSchema>;

const LinkEntrySchema = z.object({ label: z.string().max(80), url: z.string().max(2048) });
const blockBase = {
  id: z.string().min(1).max(64),
  title: z.string().max(120).optional(),
  visible: z.boolean().default(true),
};
export const ITEM_BLOCK_KINDS = ['post', 'like', 'share', 'recommendation', 'comment'] as const;

/** Content blocks that make up the page below the fixed profile header. */
export const LayoutBlockSchema = z.discriminatedUnion('type', [
  z.object({
    ...blockBase,
    type: z.literal('albums'),
    options: z
      .object({
        albumIds: z.array(z.string()).max(200).optional(),
        style: z.enum(['grid', 'carousel']).default('grid'),
      })
      .default({ style: 'grid' }),
  }),
  z.object({
    ...blockBase,
    type: z.literal('items'),
    options: z
      .object({
        kinds: z.array(z.enum(ITEM_BLOCK_KINDS)).min(1).default([...ITEM_BLOCK_KINDS]),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .default({ kinds: [...ITEM_BLOCK_KINDS] }),
  }),
  z.object({ ...blockBase, type: z.literal('friends'), options: z.object({}).default({}) }),
  z.object({
    ...blockBase,
    type: z.literal('text'),
    options: z.object({ markdown: z.string().max(10000).default('') }).default({ markdown: '' }),
  }),
  z.object({
    ...blockBase,
    type: z.literal('image'),
    options: z.object({
      url: z.string().max(2048),
      alt: z.string().max(300).default(''),
      caption: z.string().max(300).default(''),
      link: z.string().max(2048).optional(),
    }),
  }),
  z.object({
    ...blockBase,
    type: z.literal('links'),
    options: z.object({ links: z.array(LinkEntrySchema).max(30).default([]) }).default({ links: [] }),
  }),
  z.object({
    ...blockBase,
    type: z.literal('featured'),
    options: z.object({ canonicalUrl: z.string().max(2048) }),
  }),
  z.object({
    ...blockBase,
    type: z.literal('contact'),
    options: z.object({ entries: z.array(LinkEntrySchema).max(20).default([]) }).default({ entries: [] }),
  }),
  z.object({ ...blockBase, type: z.literal('guestbook'), options: z.object({}).default({}) }),
]);
export type LayoutBlock = z.infer<typeof LayoutBlockSchema>;
export type LayoutBlockType = LayoutBlock['type'];
export const MAX_LAYOUT_BLOCKS = 40;

/** The page as it looked before layouts existed: albums, everything shared, friends, guestbook. */
export const DEFAULT_LAYOUT: LayoutBlock[] = [
  { id: 'default-albums', type: 'albums', visible: true, options: { style: 'grid' } },
  { id: 'default-items', type: 'items', visible: true, options: { kinds: [...ITEM_BLOCK_KINDS] } },
  { id: 'default-friends', type: 'friends', visible: true, options: {} },
  { id: 'default-guestbook', type: 'guestbook', visible: true, options: {} },
];

/**
 * Keeps the valid blocks of a layout and drops anything unknown or malformed (e.g. a block type
 * from a newer version), so one bad block never breaks the page or the profile.
 */
export function parseLayout(raw: unknown): LayoutBlock[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const blocks: LayoutBlock[] = [];
  for (const candidate of raw) {
    const parsed = LayoutBlockSchema.safeParse(candidate);
    if (parsed.success && !seen.has(parsed.data.id)) {
      seen.add(parsed.data.id);
      blocks.push(parsed.data);
    }
    if (blocks.length >= MAX_LAYOUT_BLOCKS) break;
  }
  return blocks;
}

export const ProfileDocumentSchema = z.object({
  schemaVersion: z.string().default(WEBRING_SCHEMA_VERSION),
  did: z.string(),
  siteUrl: z.string(),
  handle: z.string(),
  displayName: z.string(),
  tagline: z.string().default(''),
  bio: z.string().default(''),
  location: z.string().default(''),
  avatarUrl: z.string().default(''),
  bannerUrl: z.string().default(''),
  interests: z.array(z.string()).default([]),
  customLinks: z
    .array(
      z.object({
        label: z.string(),
        url: z.string(),
      })
    )
    .default([]),
  // An unknown theme (e.g. from a newer version) falls back instead of rejecting the profile
  theme: ProfileThemeSchema.default('neo-webring').catch('neo-webring'),
  appearance: AppearanceSchema.optional(),
  layout: z.array(z.unknown()).transform(parseLayout).optional().catch(undefined),
  atprotoHandle: z.string().optional(),
  commentConfig: CommentConfigSchema.optional(),
  analyticsAddon: AnalyticsAddonSchema.optional(),
  adsAddon: AdsAddonSchema.optional(),
  updatedAt: z.string(),
  proof: SignatureProofSchema.optional(),
});
export type ProfileDocument = z.infer<typeof ProfileDocumentSchema>;

/**
 * Photo & Album Schemas (/api/albums.json)
 */
export const PhotoItemSchema = z.object({
  id: z.string(),
  canonicalUrl: z.string(), // e.g., https://alice.example/api/albums.json#photo-123
  url: z.string(),          // Relative or absolute image URL
  thumbUrl: z.string(),
  caption: z.string().default(''),
  altText: z.string().default(''),
  tags: z.array(z.string()).default([]),
  width: z.number().optional(),
  height: z.number().optional(),
  takenAt: z.string().optional(),
  createdAt: z.string(),
  // Media Library photos: exact published files (content-addressed), so changes are detectable
  sha256: z.string().optional(),
  bytes: z.number().optional(),
  mimeType: z.string().optional(),
  thumbSha256: z.string().optional(),
  thumbBytes: z.number().optional(),
  thumbWidth: z.number().optional(),
  thumbHeight: z.number().optional(),
});
export type PhotoItem = z.infer<typeof PhotoItemSchema>;

export const AlbumItemSchema = z.object({
  id: z.string(),
  canonicalUrl: z.string(), // e.g., https://alice.example/api/albums.json#album-123
  title: z.string(),
  description: z.string().default(''),
  coverUrl: z.string().default(''),
  tags: z.array(z.string()).default([]),
  photos: z.array(PhotoItemSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Relative URL of the album's signed manifest (media/albums/<id>/manifest.json). */
  manifestUrl: z.string().optional(),
});
export type AlbumItem = z.infer<typeof AlbumItemSchema>;

const AlbumManifestFileSchema = z.object({
  url: z.string(),
  sha256: z.string().optional(),
  bytes: z.number().optional(),
  mimeType: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

/**
 * A signed description of one album and every file in it, published next to the photos at
 * media/albums/<albumId>/manifest.json. Hashes let anyone check the files they download, and a
 * new updatedAt plus changed or missing entries tell readers what was replaced or removed.
 */
export const AlbumManifestSchema = z.object({
  schemaVersion: z.string().default(WEBRING_SCHEMA_VERSION),
  type: z.literal('webring-album-manifest'),
  siteUrl: z.string(),
  did: z.string(),
  updatedAt: z.string(),
  album: z.object({
    id: z.string(),
    canonicalUrl: z.string(),
    title: z.string(),
    description: z.string().default(''),
    coverUrl: z.string().default(''),
    tags: z.array(z.string()).default([]),
    createdAt: z.string(),
  }),
  photos: z.array(
    z.object({
      id: z.string(),
      canonicalUrl: z.string(),
      caption: z.string().default(''),
      altText: z.string().default(''),
      tags: z.array(z.string()).default([]),
      takenAt: z.string().optional(),
      createdAt: z.string(),
      image: AlbumManifestFileSchema,
      thumbnail: AlbumManifestFileSchema,
    })
  ),
  proof: SignatureProofSchema.optional(),
});
export type AlbumManifest = z.infer<typeof AlbumManifestSchema>;

export const AlbumsDocumentSchema = z.object({
  schemaVersion: z.string().default(WEBRING_SCHEMA_VERSION),
  siteUrl: z.string(),
  did: z.string(),
  updatedAt: z.string(),
  albums: z.array(AlbumItemSchema),
  proof: SignatureProofSchema.optional(),
});
export type AlbumsDocument = z.infer<typeof AlbumsDocumentSchema>;

/**
 * Shared Items & "Things I Like" Schema (/api/items.json)
 * Every item has a canonicalUrl on the author's site AND indexes a targetUrl
 * so peers can discover shares/likes of their content or external web pages.
 */
export const SharedItemTypeSchema = z.enum([
  'post',
  'like',
  'share',
  'recommendation',
  'comment',
]);
export type SharedItemType = z.infer<typeof SharedItemTypeSchema>;

export const SharedItemSchema = z.object({
  id: z.string(),
  canonicalUrl: z.string(), // e.g., https://alice.example/api/items.json#item-456
  type: SharedItemTypeSchema,
  title: z.string(),
  targetUrl: z.string(),    // Indexed target URL (a friend's photo/item URL, or any website)
  targetAuthorUrl: z.string().optional(),
  targetAuthorName: z.string().optional(),
  viaUrl: z.string().optional(), // If re-shared via another friend in the ring
  category: z.string().default('general'), // e.g., 'article', 'photo', 'music', 'book', 'tool', 'place'
  commentary: z.string().default(''),
  mediaUrl: z.string().default(''),
  rating: z.number().min(1).max(5).optional(),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  /** Set when the item has been edited since it was first published. */
  updatedAt: z.string().optional().catch(undefined),
});
export type SharedItem = z.infer<typeof SharedItemSchema>;

/**
 * When a site publishes only its recent items, `items.json` says so: `since` is the oldest
 * `createdAt` it contains, and `months` lists the signed monthly archives of everything older.
 * Readers must not treat items older than `since` as deleted just because they're missing.
 */
export const ItemsArchiveIndexSchema = z.object({
  since: z.string(),
  months: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), url: z.string(), count: z.number() })),
});
export type ItemsArchiveIndex = z.infer<typeof ItemsArchiveIndexSchema>;

export const ItemsDocumentSchema = z.object({
  schemaVersion: z.string().default(WEBRING_SCHEMA_VERSION),
  siteUrl: z.string(),
  did: z.string(),
  updatedAt: z.string(),
  items: z.array(SharedItemSchema),
  archive: ItemsArchiveIndexSchema.optional().catch(undefined),
  proof: SignatureProofSchema.optional(),
});
export type ItemsDocument = z.infer<typeof ItemsDocumentSchema>;

/**
 * Connections, Webrings & Verified Endorsements (/api/connections.json)
 */
export const FriendVisibilitySchema = z.enum(['private', 'public']);
export type FriendVisibility = z.infer<typeof FriendVisibilitySchema>;

/**
 * Client-side moderation, keyed by site URL. `mute` hides a site from the local feed only;
 * `block` also drops its endorsements from the published site and stops crawling it.
 */
export const ModerationActionSchema = z.enum(['mute', 'block']);
export type ModerationAction = z.infer<typeof ModerationActionSchema>;

export const FriendKeyStatusSchema = z.enum(['unverified', 'pinned', 'changed']);
export type FriendKeyStatus = z.infer<typeof FriendKeyStatusSchema>;

export const FriendConnectionSchema = z.object({
  id: z.string(),
  siteUrl: z.string(),
  did: z.string().optional(),
  displayName: z.string(),
  handle: z.string().default(''),
  avatarUrl: z.string().default(''),
  bio: z.string().default(''),
  relationship: z.array(z.string()).default(['friend']), // XFN-inspired: 'friend', 'met', 'kin', 'muse', 'colleague'
  visibility: FriendVisibilitySchema.default('private').optional(),
  pinnedPublicKeyPem: z.string().optional(),
  keyStatus: FriendKeyStatusSchema.default('unverified').optional(),
  lastCrawledAt: z.string().optional(),
  addedAt: z.string(),
});
export type FriendConnection = z.infer<typeof FriendConnectionSchema>;

export const WebringMembershipSchema = z.object({
  id: z.string(),
  name: z.string(),
  hubUrl: z.string(),
  description: z.string().default(''),
  prevSiteUrl: z.string().optional(),
  nextSiteUrl: z.string().optional(),
  joinedAt: z.string(),
  // v2: lets the site render small rings sensibly and link Random to the ring directory
  memberCount: z.number().optional(),
  directoryUrl: z.string().optional(),
});
export type WebringMembership = z.infer<typeof WebringMembershipSchema>;

/**
 * Verified back-interactions discovered by crawling friends' items.json
 */
export const EndorsementItemSchema = z.object({
  id: z.string(),
  targetCanonicalUrl: z.string(), // Which of OUR items/photos was liked or shared
  authorSiteUrl: z.string(),
  authorName: z.string(),
  authorAvatarUrl: z.string().default(''),
  type: SharedItemTypeSchema,
  commentary: z.string().default(''),
  sourceItemUrl: z.string(),
  createdAt: z.string(),
  verifiedSignature: z.boolean().default(false),
});
export type EndorsementItem = z.infer<typeof EndorsementItemSchema>;

export const ConnectionsDocumentSchema = z.object({
  schemaVersion: z.string().default(WEBRING_SCHEMA_VERSION),
  siteUrl: z.string(),
  did: z.string(),
  updatedAt: z.string(),
  friends: z.array(FriendConnectionSchema),
  webrings: z.array(WebringMembershipSchema),
  endorsements: z.array(EndorsementItemSchema).default([]),
  proof: SignatureProofSchema.optional(),
});
export type ConnectionsDocument = z.infer<typeof ConnectionsDocumentSchema>;

/**
 * Webring hub: a ring's signed member list, published by its maintainer (api/rings/<slug>.json)
 * Allows any user or community to host a static JSON file that acts as a Webring directory.
 */
export const WebringHubDocumentSchema = z.object({
  schemaVersion: z.string().default(WEBRING_SCHEMA_VERSION),
  name: z.string(),
  description: z.string(),
  hubUrl: z.string(),
  maintainerUrl: z.string(),
  updatedAt: z.string(),
  members: z.array(
    z.object({
      siteUrl: z.string(),
      displayName: z.string(),
      did: z.string().optional(),
      joinedAt: z.string(),
      // v2: false = still a member, but skipped by Prev / Next / Random
      inRotation: z.boolean().optional(),
    })
  ),
  // v2 fields (v1 hubs omit them; v1 readers ignore them)
  maintainerDid: z.string().optional(),
  status: z.enum(['active', 'closed']).optional(),
  directoryUrl: z.string().optional(),
  proof: SignatureProofSchema.optional(),
});
export type WebringHubDocument = z.infer<typeof WebringHubDocumentSchema>;
export type WebringHubMember = WebringHubDocument['members'][number];

/**
 * A private, signed request to join a ring. The applicant signs it with their site key and sends
 * it to the maintainer as a `webring://ring-request?token=…` link; nothing is published.
 */
export const RingJoinRequestSchema = z.object({
  type: z.literal('webring-join-request'),
  version: z.literal(1),
  hubUrl: z.string(),
  siteUrl: z.string(),
  did: z.string(),
  displayName: z.string().max(120),
  createdAt: z.string(),
  proof: SignatureProofSchema.optional(),
});
export type RingJoinRequest = z.infer<typeof RingJoinRequestSchema>;

export function encodeRingRequestToken(request: RingJoinRequest): string {
  return Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
}

export function decodeRingRequestToken(token: string): RingJoinRequest {
  const raw = JSON.parse(Buffer.from(token.trim(), 'base64url').toString('utf8'));
  return RingJoinRequestSchema.parse(raw);
}

export function buildRingRequestUri(token: string): string {
  return `webring://ring-request?token=${encodeURIComponent(token)}`;
}

/**
 * Reads a `webring://ring-request?token=…` link (or a bare token). Kept separate from
 * `parseWebringUri`, which falls back to `share` for unknown actions.
 */
export function parseRingRequestUri(uriOrToken: string): string | null {
  const trimmed = uriOrToken.trim();
  if (!trimmed.startsWith('webring:')) return trimmed || null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== 'ring-request' && parsed.pathname.replace(/^\/+/, '') !== 'ring-request') {
      return null;
    }
    return parsed.searchParams.get('token');
  } catch {
    return null;
  }
}

/**
 * Prev / next neighbours for `siteUrl` among members in rotation. Returns nothing for a site
 * that isn't a member (no more "prev = last, next = first" for outsiders).
 */
export function computeRingNeighbors(
  members: Array<{ siteUrl: string; inRotation?: boolean }>,
  siteUrl: string
): { isMember: boolean; prevSiteUrl?: string; nextSiteUrl?: string; memberCount: number } {
  const me = normalizeSiteUrl(siteUrl);
  const all = members.map((m) => ({ ...m, siteUrl: normalizeSiteUrl(m.siteUrl) }));
  const isMember = all.some((m) => m.siteUrl === me);
  const rotation = all.filter((m) => m.inRotation !== false || m.siteUrl === me);
  if (!isMember || rotation.length < 2) {
    return { isMember, memberCount: all.length };
  }
  const idx = rotation.findIndex((m) => m.siteUrl === me);
  return {
    isMember,
    prevSiteUrl: rotation[(idx - 1 + rotation.length) % rotation.length].siteUrl,
    nextSiteUrl: rotation[(idx + 1) % rotation.length].siteUrl,
    memberCount: all.length,
  };
}

/**
 * Short, stable fingerprint of a public key, used to recognise a banned key on a new domain.
 */
export function publicKeyFingerprint(publicKeyPem: string): string {
  return getNodeCrypto().createHash('sha256').update(publicKeyPem.trim()).digest('hex').slice(0, 32);
}

/**
 * Complete Hydrated Bundle for the Standalone Profile Site
 */
export interface CompleteSiteBundle {
  didDocument: DidDocument;
  manifest: WebringManifest;
  profile: ProfileDocument;
  albums: AlbumsDocument;
  items: ItemsDocument;
  connections: ConnectionsDocument;
  /** Published bundles only: signed monthly archives of items older than the recent window. */
  archives?: Array<{ path: string; doc: ItemsDocument }>;
}

/**
 * Local Studio Persona Summary (Strict Compartmentalization)
 */
export interface PersonaSummary {
  id: string;
  label: string;          // Internal Studio nickname (never exported in public JSON)
  displayName: string;
  handle: string;
  siteUrl: string;
  did: string;
  avatarUrl: string;
  theme: ProfileTheme;
  dbFileName: string;
  mediaDirName: string;
  createdAt: string;
  stats?: {
    photoCount: number;
    itemCount: number;
    friendCount: number;
  };
}

export interface CreatePersonaInput {
  label: string;
  displayName: string;
  siteUrl?: string;
  handle?: string;
  tagline?: string;
  bio?: string;
  avatarUrl?: string;
  theme?: ProfileTheme;
}

// ============================================================================
// 2. Identity (did:web), Canonical URL, and Ed25519 Crypto Helpers
// ============================================================================

/** Where a new profile points until the user sets their real site address. */
export const PLACEHOLDER_SITE_URL = 'https://my-profile.local';
export const PLACEHOLDER_DISPLAY_NAME = 'Your Name';

export function isPlaceholderSiteUrl(siteUrl: string): boolean {
  return normalizeSiteUrl(siteUrl) === PLACEHOLDER_SITE_URL;
}

/**
 * Normalizes a site URL (removes trailing slash, ensures protocol)
 */
export function normalizeSiteUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return PLACEHOLDER_SITE_URL;
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withProto.replace(/\/+$/, '');
}

/**
 * True when `url` lives under `siteUrl` (same origin and path prefix), e.g. a friend's
 * canonical item URL must sit on that friend's own site so it can't overwrite another peer's rows.
 */
export function isUrlWithinSite(url: string, siteUrl: string): boolean {
  try {
    const target = new URL(url);
    const base = new URL(normalizeSiteUrl(siteUrl));
    if (target.origin.toLowerCase() !== base.origin.toLowerCase()) return false;
    const basePath = base.pathname.replace(/\/+$/, '');
    return !basePath || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

/**
 * Converts an HTTP(S) site URL into a W3C / ATProto compatible did:web identifier.
 * Example: https://alice.example.com/profile -> did:web:alice.example.com:profile
 */
export function siteUrlToDidWeb(siteUrl: string): string {
  try {
    const parsed = new URL(normalizeSiteUrl(siteUrl));
    const host = parsed.port ? `${parsed.hostname}%3A${parsed.port}` : parsed.hostname;
    const pathSegments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg));
    if (pathSegments.length > 0) {
      return `did:web:${host}:${pathSegments.join(':')}`;
    }
    return `did:web:${host}`;
  } catch {
    return 'did:web:localhost';
  }
}

/**
 * Builds a canonical item URL indexed to the user's hosted website structure.
 */
export function buildCanonicalUrl(
  siteUrl: string,
  collection: 'albums' | 'photos' | 'items',
  id: string
): string {
  const base = normalizeSiteUrl(siteUrl);
  if (collection === 'albums') {
    return `${base}/api/albums.json#album-${id}`;
  }
  if (collection === 'photos') {
    return `${base}/api/albums.json#photo-${id}`;
  }
  return `${base}/api/items.json#item-${id}`;
}

/**
 * Generates an Ed25519 keypair in PEM format for signing static JSON files.
 */
export function generateIdentityKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const nodeCrypto = getNodeCrypto();
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/**
 * Deterministically serializes a JSON object (excluding 'proof') for cryptographic signing.
 */
export function canonicalizeJson(obj: Record<string, unknown>): string {
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (key === 'proof') continue;
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      clone[key] = JSON.parse(canonicalizeJson(val as Record<string, unknown>));
    } else {
      clone[key] = val;
    }
  }
  return JSON.stringify(clone);
}

/**
 * Signs a JSON payload using the owner's Ed25519 private key and attaches a `proof` object.
 */
export function signDocument<T extends Record<string, unknown>>(
  doc: T,
  did: string,
  privateKeyPem: string,
  /** A fixed signing time gives identical bytes for identical content (Ed25519 is deterministic). */
  created?: string
): T & { proof: SignatureProof } {
  const nodeCrypto = getNodeCrypto();
  const canonicalPayload = canonicalizeJson(doc);
  const signature = nodeCrypto.sign(null, Buffer.from(canonicalPayload, 'utf8'), privateKeyPem);
  const proof: SignatureProof = {
    type: 'Ed25519Signature2020',
    created: created || new Date().toISOString(),
    verificationMethod: `${did}#key-1`,
    signatureValue: signature.toString('base64url'),
  };
  return { ...doc, proof };
}

/**
 * Verifies the `proof` signature on a fetched JSON document against the author's public key PEM.
 */
export function verifyDocumentSignature(
  doc: Record<string, unknown> & { proof?: SignatureProof },
  publicKeyPem: string
): boolean {
  try {
    if (!doc.proof || !doc.proof.signatureValue) return false;
    const nodeCrypto = getNodeCrypto();
    const canonicalPayload = canonicalizeJson(doc);
    const sigBuffer = Buffer.from(doc.proof.signatureValue, 'base64url');
    return nodeCrypto.verify(null, Buffer.from(canonicalPayload, 'utf8'), publicKeyPem, sigBuffer);
  } catch {
    return false;
  }
}

/**
 * Builds a W3C / ATProto compatible /.well-known/did.json document
 */
export function buildDidDocument(
  siteUrl: string,
  publicKeyPem: string,
  handle?: string,
  atprotoPdsUrl?: string
): DidDocument {
  const normalizedUrl = normalizeSiteUrl(siteUrl);
  const did = siteUrlToDidWeb(normalizedUrl);

  const services = [
    {
      id: '#webring',
      type: 'WebringProfileService',
      serviceEndpoint: `${normalizedUrl}/api/manifest.json`,
    },
  ];

  if (atprotoPdsUrl) {
    services.push({
      id: '#atproto_pds',
      type: 'AtprotoPersonalDataServer',
      serviceEndpoint: atprotoPdsUrl,
    });
  }

  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: did,
    alsoKnownAs: handle ? [`at://${handle}`, normalizedUrl] : [normalizedUrl],
    verificationMethod: [
      {
        id: `${did}#key-1`,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyPem,
      },
    ],
    service: services,
  };
}

/**
 * Parses a custom `webring://interact?...` deep link URI into structured action parameters
 */
export interface WebringDeepLinkAction {
  action: 'like' | 'share' | 'comment' | 'friend' | 'join-ring';
  targetUrl: string;
  title?: string;
  authorUrl?: string;
  authorName?: string;
  mediaUrl?: string;
  category?: string;
}

export function parseWebringUri(uri: string): WebringDeepLinkAction | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'webring:') return null;
    const actionParam = parsed.searchParams.get('action') || 'share';
    const targetUrl = parsed.searchParams.get('targetUrl') || '';
    if (!targetUrl) return null;

    const action = (['like', 'share', 'comment', 'friend', 'join-ring'].includes(actionParam)
      ? actionParam
      : 'share') as WebringDeepLinkAction['action'];

    return {
      action,
      targetUrl,
      title: parsed.searchParams.get('title') || undefined,
      authorUrl: parsed.searchParams.get('authorUrl') || undefined,
      authorName: parsed.searchParams.get('authorName') || undefined,
      mediaUrl: parsed.searchParams.get('mediaUrl') || undefined,
      category: parsed.searchParams.get('category') || undefined,
    };
  } catch {
    return null;
  }
}

export function buildWebringUri(params: WebringDeepLinkAction): string {
  const search = new URLSearchParams();
  search.set('action', params.action);
  search.set('targetUrl', params.targetUrl);
  if (params.title) search.set('title', params.title);
  if (params.authorUrl) search.set('authorUrl', params.authorUrl);
  if (params.authorName) search.set('authorName', params.authorName);
  if (params.mediaUrl) search.set('mediaUrl', params.mediaUrl);
  if (params.category) search.set('category', params.category);
  return `webring://interact?${search.toString()}`;
}

