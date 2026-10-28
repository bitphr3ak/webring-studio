import * as path from 'path';
import * as fs from 'fs';
import { PersonaManager, ActivePersonaContext } from '../services/personaManager';
import { LocalPreviewServer } from '../services/localPreviewServer';
import { cleanUpLibrary, deleteAlbumWithFiles, deletePhotoWithFiles, setProfileImageFromFile } from '../services/mediaLibrary';
import { savePost, unsavePost } from '../services/savedPosts';
import { jobNextRunAt, Scheduler, SchedulePreset } from '../services/scheduler';
import {
  FriendVisibility,
  isValidAdSlotId,
  isValidGa4MeasurementId,
  normalizeAdSensePublisherId,
  Appearance,
  LayoutBlock,
  ProfileTheme,
  SharedItemType,
  ProfileThemeSchema,
} from '../../src/shared/schema';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpPromptDefinition {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
  }>;
}

export interface McpActivityLogEntry {
  id: string;
  timestamp: string;
  method: string;
  toolName?: string;
  personaId: string;
  summary: string;
  success: boolean;
}

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export class WebringMcpServer {
  private activityLog: McpActivityLogEntry[] = [];
  private previewServer: LocalPreviewServer;

  constructor(
    private personaManager: PersonaManager,
    private userDataDir: string,
    previewServer?: LocalPreviewServer,
    private onActivity?: (entry: McpActivityLogEntry) => void
  ) {
    this.previewServer = previewServer || new LocalPreviewServer();
  }

  private attachedScheduler: Scheduler | null = null;

  /** The running app attaches its scheduler; the stdio CLI only edits the schedule file. */
  public attachScheduler(scheduler: Scheduler): void {
    this.attachedScheduler = scheduler;
  }

  private getScheduler(): Scheduler {
    return (
      this.attachedScheduler ||
      new Scheduler({
        configPath: path.join(this.userDataDir, 'scheduler.json'),
        listPersonaIds: () => this.personaManager.listPersonaRecords().map((p) => p.id),
        runner: {
          sync: () => Promise.reject(new Error('Open Webring Studio to run scheduled jobs.')),
          publish: () => Promise.reject(new Error('Open Webring Studio to run scheduled jobs.')),
        },
      })
    );
  }

  public getActivityLog(): McpActivityLogEntry[] {
    return [...this.activityLog];
  }

  private recordActivity(
    method: string,
    summary: string,
    success: boolean,
    toolName?: string
  ): void {
    const entry: McpActivityLogEntry = {
      id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      method,
      toolName,
      personaId: this.personaManager.getActivePersonaId(),
      summary,
      success,
    };
    this.activityLog.unshift(entry);
    if (this.activityLog.length > 100) {
      this.activityLog.length = 100;
    }
    if (this.onActivity) {
      this.onActivity(entry);
    }
  }

  /**
   * Resolves the target persona context. If `personaId` is provided and differs from
   * the currently active persona, switches to it so operations run in the requested compartment.
   */
  private resolveContext(args?: Record<string, unknown>): ActivePersonaContext {
    const requestedPersonaId =
      typeof args?.personaId === 'string' ? args.personaId.trim() : '';
    if (
      requestedPersonaId &&
      requestedPersonaId !== this.personaManager.getActivePersonaId()
    ) {
      this.personaManager.switchPersona(requestedPersonaId);
    }
    return this.personaManager.getActiveContext();
  }

  public getTools(): McpToolDefinition[] {
    const personaIdProp = {
      type: 'string',
      description:
        'Optional persona ID (e.g. "default" or "persona-..."). Defaults to the currently active persona.',
    };

    return [
      // 1. Personas & Identity
      {
        name: 'webring_list_personas',
        description:
          'List all compartmentalized online personas in Webring Studio, including their active status, did:web identity, siteUrl, and item/friend/photo counts.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'webring_create_persona',
        description:
          'Create a new compartmentalized online persona with an isolated SQLite database, a fresh Ed25519 signing keypair, and a distinct did:web identity.',
        inputSchema: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: 'Internal Studio nickname for this persona (never exported publicly).',
            },
            displayName: {
              type: 'string',
              description: 'Public display name on the generated profile website.',
            },
            siteUrl: {
              type: 'string',
              description: 'Hosted website root URL (e.g. https://alias.example.com).',
            },
            tagline: { type: 'string', description: 'Short headline or tagline.' },
            bio: { type: 'string', description: 'About / biography text.' },
            theme: {
              type: 'string',
              enum: [...ProfileThemeSchema.options],
              description: 'Visual theme for the exported profile site. facepace, tweetdeck, xtraspecial, instapick and tiktalk also rearrange the page.',
            },
          },
          required: ['label', 'displayName'],
        },
      },
      {
        name: 'webring_switch_persona',
        description: 'Switch the active persona in Webring Studio by personaId.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: {
              type: 'string',
              description: 'ID of the persona to activate (e.g. "default" or "persona-...").',
            },
          },
          required: ['personaId'],
        },
      },
      {
        name: 'webring_get_profile',
        description:
          'Get the profile metadata, W3C/ATProto did:web identifier, Ed25519 public key, and privacy/publishing settings for a persona.',
        inputSchema: {
          type: 'object',
          properties: { personaId: personaIdProp },
        },
      },
      {
        name: 'webring_update_profile',
        description:
          'Update profile metadata (displayName, siteUrl, tagline, bio, theme, interests, customLinks, atprotoHandle), Site Design (appearance, layout) and/or Social Graph Privacy Shield & Comment settings.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            siteUrl: { type: 'string' },
            displayName: { type: 'string' },
            tagline: { type: 'string' },
            bio: { type: 'string' },
            location: { type: 'string' },
            avatarUrl: { type: 'string' },
            bannerUrl: { type: 'string' },
            interests: { type: 'array', items: { type: 'string' } },
            theme: {
              type: 'string',
              enum: [...ProfileThemeSchema.options],
              description: 'Visual theme. facepace, tweetdeck, xtraspecial, instapick and tiktalk also rearrange the page.',
            },
            appearance: {
              type: 'object',
              description:
                'Look & feel: { accent: "#rrggbb", font: theme|sans|serif|rounded|mono, corners: sharp|rounded|soft, surface: card|flat, bannerHeight: short|medium|tall, avatarShape: rounded|circle, background: theme|gradient|banner-blur, interactions: on|off (photo lightbox, post view, sortable tables; default on) }. Invalid fields are ignored.',
            },
            layout: {
              type: 'array',
              description:
                'Page blocks below the profile header, in order: [{ id, type, title?, visible, options }]. Types: albums {albumIds?, style: grid|carousel}, items {kinds: [post|like|share|recommendation|comment], limit?}, friends, text {markdown}, image {url, alt, caption, link?}, links {links: [{label,url}]}, featured {canonicalUrl}, contact {entries: [{label,url}]}, guestbook. Invalid blocks are dropped. Use [] for an empty page.',
              items: { type: 'object' },
            },
            atprotoHandle: { type: 'string' },
            publishFriendsList: {
              type: 'boolean',
              description: 'Whether public friends are exported to /api/connections.json.',
            },
            stripRelationshipTags: {
              type: 'boolean',
              description: 'Strip XFN relationship tags from exported connections.json.',
            },
            publishEndorsements: {
              type: 'boolean',
              description: 'Include discovered peer likes/comments in exported connections.json.',
            },
            redactItemSourceAuthors: {
              type: 'boolean',
              description: 'Redact targetAuthorUrl/Name in exported items.json.',
            },
            commentProvider: {
              type: 'string',
              enum: ['none', 'giscus', 'utterances'],
            },
            giscusRepo: { type: 'string' },
          },
        },
      },

      // 2. Wall Posts, Likes, Shares, Recommendations & Comments
      {
        name: 'webring_list_items',
        description:
          'List authored timeline items (wall posts, likes, shares, recommendations, and comments) for the persona.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            type: {
              type: 'string',
              enum: ['post', 'like', 'share', 'recommendation', 'comment'],
              description: 'Optional filter by item type.',
            },
            tag: {
              type: 'string',
              description: 'Optional filter by hashtag.',
            },
          },
        },
      },
      {
        name: 'webring_create_post',
        description:
          'Publish a new self-hosted Wall Post (status update, essay, or note) on the persona’s timeline (/api/items.json).',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            commentary: {
              type: 'string',
              description: 'Main body text of the wall post, in Markdown (links, emphasis, headings, lists, quotes, tables; no HTML).',
            },
            title: {
              type: 'string',
              description: 'Optional headline (auto-derived from first line if omitted).',
            },
            mediaUrl: {
              type: 'string',
              description: 'Optional image/media URL attached to the post.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of topic tags.',
            },
          },
          required: ['commentary'],
        },
      },
      {
        name: 'webring_interact_with_url',
        description:
          'Publish a Like, Share, Recommendation, or threaded Comment targeting a friend’s canonicalUrl (from the Neighborhood Feed) or any external web URL.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            type: {
              type: 'string',
              enum: ['like', 'share', 'recommendation', 'comment'],
              description: 'Type of social interaction.',
            },
            targetUrl: {
              type: 'string',
              description:
                'Canonical URL of the friend’s post/photo (e.g. https://friend.example/api/items.json#item-123) or external webpage.',
            },
            commentary: {
              type: 'string',
              description: 'Your comment reply or notes on why you liked/shared this item.',
            },
            title: {
              type: 'string',
              description: 'Title of the referenced post or item.',
            },
            targetAuthorName: {
              type: 'string',
              description: 'Display name of the original author.',
            },
            targetAuthorUrl: {
              type: 'string',
              description: 'Site URL of the original author.',
            },
            category: {
              type: 'string',
              description: 'Category (e.g. article, photo, music, status, comment).',
            },
            rating: {
              type: 'number',
              description: 'Optional 1-5 star rating (for recommendations/likes).',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['type', 'targetUrl', 'commentary'],
        },
      },
      {
        name: 'webring_update_item',
        description:
          'Edit one of your wall posts, comments, likes, shares or recommendations. It keeps its ID and canonical URL (friends\' likes and comments still point at it) and is marked as edited. Only the fields you pass change; an empty title is derived from the text.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            itemId: { type: 'string', description: 'ID of the item to edit (e.g. item-...).' },
            title: { type: 'string' },
            commentary: { type: 'string', description: 'The post text (Markdown for wall posts) or your notes.' },
            targetUrl: { type: 'string', description: 'The link the item is about (not for wall posts).' },
            targetAuthorName: { type: 'string' },
            targetAuthorUrl: { type: 'string' },
            category: { type: 'string' },
            mediaUrl: { type: 'string', description: 'Image URL, or "" to remove the image.' },
            rating: { type: 'number', description: '1-5, for likes and recommendations.' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['itemId'],
        },
      },
      {
        name: 'webring_delete_item',
        description: 'Delete a wall post, comment, or shared item by its item ID.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            itemId: { type: 'string', description: 'ID of the item to delete (e.g. item-...).' },
          },
          required: ['itemId'],
        },
      },

      // 3. Photo Albums
      {
        name: 'webring_list_albums',
        description: 'List all photo albums and their photos for the persona.',
        inputSchema: {
          type: 'object',
          properties: { personaId: personaIdProp },
        },
      },
      {
        name: 'webring_create_album',
        description: 'Create a new photo album in /api/albums.json.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            title: { type: 'string', description: 'Album title.' },
            description: { type: 'string', description: 'Album description, in Markdown (headings, links, lists, tables; no HTML).' },
            coverUrl: { type: 'string', description: 'Optional cover image URL.' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['title'],
        },
      },
      {
        name: 'webring_add_photo',
        description:
          'Add a photo to an album from a local JPEG/PNG file (imported into the Media Library: resized for the web, thumbnail made, camera and GPS metadata removed, published with the site) or a remote image URL.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            albumId: { type: 'string', description: 'Target album ID.' },
            urlOrLocalPath: {
              type: 'string',
              description: 'HTTP(S) image URL or absolute local file path to import.',
            },
            caption: { type: 'string', description: 'Photo caption.' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['albumId', 'urlOrLocalPath'],
        },
      },
      {
        name: 'webring_set_profile_image',
        description:
          'Set the profile photo (avatar) or banner from a local JPEG/PNG (uploaded: resized, metadata removed, published with the site), an existing album photo, or a web address. There is only one of each: a new one replaces the old, and a previously uploaded file is deleted. url "" removes the image.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            kind: { type: 'string', enum: ['avatar', 'banner'] },
            localPath: { type: 'string', description: 'Absolute path of a local JPEG or PNG to upload.' },
            photoId: { type: 'string', description: 'ID of an album photo to use.' },
            url: { type: 'string', description: 'An http(s) image address, or "" to remove.' },
          },
          required: ['kind'],
        },
      },
      {
        name: 'webring_delete_album',
        description: 'Delete a photo album by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            albumId: { type: 'string' },
          },
          required: ['albumId'],
        },
      },
      {
        name: 'webring_delete_photo',
        description: 'Delete a photo by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            photoId: { type: 'string' },
          },
          required: ['photoId'],
        },
      },

      // 4. Friend Ring, TOFU Keys & Pull-Federation Crawler
      {
        name: 'webring_list_friends',
        description:
          'List all friends in the persona’s local ring, including their private/public visibility and Trust-On-First-Use (TOFU) Ed25519 key pinning status.',
        inputSchema: {
          type: 'object',
          properties: { personaId: personaIdProp },
        },
      },
      {
        name: 'webring_add_friend',
        description:
          'Add or update a friend in the local ring. Defaults to visibility="private" (local crawler only, hidden from public connections.json).',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            siteUrl: { type: 'string', description: 'Friend’s profile website root URL.' },
            displayName: { type: 'string', description: 'Friend’s display name.' },
            visibility: {
              type: 'string',
              enum: ['private', 'public'],
              description: 'Whether to keep private (default) or export on public blogroll.',
            },
            relationship: {
              type: 'array',
              items: { type: 'string' },
              description: 'Local XFN relationship tags (e.g. ["friend", "colleague"]).',
            },
            bio: { type: 'string' },
            avatarUrl: { type: 'string' },
          },
          required: ['siteUrl', 'displayName'],
        },
      },
      {
        name: 'webring_set_friend_visibility',
        description:
          'Toggle a friend’s connection visibility between "private" (local crawler only) and "public" (allowed on blogroll).',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            friendId: { type: 'string' },
            visibility: { type: 'string', enum: ['private', 'public'] },
          },
          required: ['friendId', 'visibility'],
        },
      },
      {
        name: 'webring_set_moderation',
        description:
          'Mute or block a site (or clear it with action "none"). Mute hides it from the local feed; block also drops its endorsements from the published site and stops crawling it.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            siteUrl: { type: 'string' },
            action: { type: 'string', enum: ['mute', 'block', 'none'] },
          },
          required: ['siteUrl', 'action'],
        },
      },
      {
        name: 'webring_delete_friend',
        description: 'Remove a friend from the persona’s local ring, along with their crawled posts and endorsements.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            friendId: { type: 'string' },
          },
          required: ['friendId'],
        },
      },
      {
        name: 'webring_crawl_friend',
        description:
          'Crawl a single friend’s static JSON profile endpoints, verify Ed25519 signatures on all documents, enforce TOFU public key pinning, and index their posts/photos/endorsements.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            siteUrl: { type: 'string', description: 'Friend’s website URL to crawl.' },
            localDirOverride: {
              type: 'string',
              description: 'Optional local directory path when testing offline peer sites.',
            },
          },
          required: ['siteUrl'],
        },
      },
      {
        name: 'webring_crawl_all_friends',
        description:
          'Crawl all friends in the persona’s ring and return a summary of newly indexed posts, photos, and back-endorsements.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
          },
        },
      },
      {
        name: 'webring_save_post',
        description:
          'Save a friend\'s post or photo from the Neighborhood Feed as a private copy (with a local copy of its image) that stays after it leaves the feed window or the friend removes it. Never published.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            canonicalUrl: { type: 'string', description: 'canonicalUrl of the feed entry.' },
            note: { type: 'string', description: 'Optional private note.' },
          },
          required: ['canonicalUrl'],
        },
      },
      {
        name: 'webring_list_saved',
        description: 'List saved posts and photos (private copies), newest saved first.',
        inputSchema: { type: 'object', properties: { personaId: personaIdProp } },
      },
      {
        name: 'webring_unsave_post',
        description: 'Remove a saved post and its local image copy.',
        inputSchema: {
          type: 'object',
          properties: { personaId: personaIdProp, savedId: { type: 'string' } },
          required: ['savedId'],
        },
      },
      {
        name: 'webring_set_feed_retention',
        description:
          'How many days friends\' posts stay in the Neighborhood Feed (0 = forever; default 90). Older entries are removed now and skipped by future syncs. Saved posts and friends\' likes/comments on your posts are kept.',
        inputSchema: {
          type: 'object',
          properties: { personaId: personaIdProp, days: { type: 'number' } },
          required: ['days'],
        },
      },
      {
        name: 'webring_get_neighborhood_feed',
        description:
          'Query chronological posts, photos, likes, shares, and comments pulled from friends in the Neighborhood Feed.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            entryType: {
              type: 'string',
              enum: ['photo', 'post', 'like', 'share', 'recommendation', 'comment'],
              description: 'Optional filter by entry type.',
            },
            friendSiteUrl: {
              type: 'string',
              description: 'Optional filter by friend site URL.',
            },
            verifiedOnly: {
              type: 'boolean',
              description: 'If true, only return entries with verified Ed25519 DID signatures.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of feed entries to return (default 50).',
            },
          },
        },
      },
      {
        name: 'webring_get_endorsements',
        description:
          'List discovered likes, shares, recommendations, and comments made by friends targeting our own posts and photos.',
        inputSchema: {
          type: 'object',
          properties: { personaId: personaIdProp },
        },
      },
      {
        name: 'webring_list_rings',
        description:
          'List the rings this persona has joined (with status: requested, member, removed, closed, legacy) and the rings it hosts as maintainer (with members and bans).',
        inputSchema: { type: 'object', properties: { personaId: personaIdProp } },
      },
      {
        name: 'webring_join_ring',
        description:
          'Verify a ring hub (https URL of its signed hub JSON) and create a private signed join request. Returns a webring://ring-request link the user must send to the ring maintainer. The persona’s site must already be published.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            hubUrl: { type: 'string', description: 'https URL of the ring’s hub JSON.' },
          },
          required: ['hubUrl'],
        },
      },
      {
        name: 'webring_leave_ring',
        description:
          'Leave a joined ring (or cancel a request). The ring stops appearing on the site at the next publish; the maintainer’s Studio notices on its next sync.',
        inputSchema: {
          type: 'object',
          properties: { personaId: personaIdProp, ringId: { type: 'string' } },
          required: ['ringId'],
        },
      },
      {
        name: 'webring_sync_rings',
        description:
          'Refresh joined rings from their hubs (membership, neighbours, removals) and check hosted rings’ members (leavers are removed after a grace period).',
        inputSchema: { type: 'object', properties: { personaId: personaIdProp } },
      },
      {
        name: 'webring_create_hosted_ring',
        description: 'Create a new ring this persona maintains. It is published as a signed hub at the next publish.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            name: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['name'],
        },
      },
      {
        name: 'webring_review_ring_request',
        description:
          'Check a webring://ring-request link sent by an applicant, and optionally approve, decline or ban. Without a decision nothing changes. Approvals go live at the next publish.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            requestLink: { type: 'string' },
            decision: { type: 'string', enum: ['approve', 'decline', 'ban'] },
            reason: { type: 'string', description: 'Private note kept with a ban.' },
          },
          required: ['requestLink'],
        },
      },
      {
        name: 'webring_get_schedule',
        description:
          'Show the persona’s sync and publish schedules (preset, next run, last result) and the app-level background settings.',
        inputSchema: { type: 'object', properties: { personaId: personaIdProp } },
      },
      {
        name: 'webring_set_schedule',
        description:
          'Set the persona’s schedules. Presets: {"kind":"interval","minutes":15|60|360|720}, {"kind":"daily","time":"HH:MM"}, {"kind":"weekly","weekday":0-6,"time":"HH:MM"}. Publish destinations: local, remote (SFTP/FTP), github. Scheduled publishes skip when nothing changed. Jobs run while Webring Studio is open or in the menu bar.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            syncEnabled: { type: 'boolean' },
            syncPreset: { type: 'object' },
            publishEnabled: { type: 'boolean' },
            publishPreset: { type: 'object' },
            publishDestination: { type: 'string', enum: ['local', 'remote', 'github'] },
            syncBeforePublish: { type: 'boolean' },
          },
        },
      },
      {
        name: 'webring_run_scheduled_job',
        description:
          'Run the persona’s scheduled sync or publish right now (publish skips if nothing changed). Needs the Webring Studio app; the stdio server can only edit schedules.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            job: { type: 'string', enum: ['sync', 'publish'] },
          },
          required: ['job'],
        },
      },
      {
        name: 'webring_set_ring_member',
        description:
          'Manage a member of a hosted ring: remove, ban, unban, hide or show in rotation, or move up/down.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            ringId: { type: 'string' },
            siteUrl: { type: 'string' },
            action: { type: 'string', enum: ['remove', 'ban', 'unban', 'hide', 'show', 'up', 'down'] },
            reason: { type: 'string' },
          },
          required: ['ringId', 'siteUrl', 'action'],
        },
      },

      // 5. Static Site Generation & Local Preview
      {
        name: 'webring_export_static_site',
        description:
          'Sign all JSON documents with the persona’s Ed25519 private key and export the complete self-contained static website (index.html, .nojekyll, did.json, api/*.json) to disk.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            targetDir: {
              type: 'string',
              description:
                'Optional target directory path. Uses the persona’s configured export directory if omitted.',
            },
          },
        },
      },
      {
        name: 'webring_start_preview_server',
        description:
          'Build a local test export of the persona’s static website and serve it over a loopback HTTP preview server (http://127.0.0.1:<port>/).',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
          },
        },
      },

      // 6. Optional Profile Add-Ons (Google Analytics GA4 & Google AdSense Monetization)
      {
        name: 'webring_get_addons',
        description:
          'Get the status and configuration of all optional profile add-ons (Google Analytics GA4, Google AdSense monetization, and live Giscus/Utterances comments) for a persona, plus cross-persona OPSEC correlation warnings.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
          },
        },
      },
      {
        name: 'webring_configure_analytics_addon',
        description:
          'Enable, disable, configure, or clear the optional Google Analytics (GA4) add-on for a persona.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            enabled: {
              type: 'boolean',
              description: 'Enable or disable Google Analytics (GA4) script injection.',
            },
            measurementId: {
              type: 'string',
              description: 'GA4 Measurement ID (format: G-XXXXXXXXXX).',
            },
            respectDoNotTrack: {
              type: 'boolean',
              description: 'Skip analytics when browser Do-Not-Track (DNT) is enabled (default true).',
            },
            anonymizeIp: {
              type: 'boolean',
              description: 'Anonymize visitor IP addresses in GA4 (default true).',
            },
            trackRingInteractions: {
              type: 'boolean',
              description: 'Fire custom webring_interact GA4 events when visitors click Like/Share/Comment links.',
            },
            clear: {
              type: 'boolean',
              description: 'If true, wipes stored GA4 Measurement ID and disables the add-on.',
            },
          },
        },
      },
      {
        name: 'webring_configure_ads_addon',
        description:
          'Enable, disable, configure, or clear the optional Google AdSense monetization add-on (including automatic /ads.txt generation and ad placement slots) for a persona.',
        inputSchema: {
          type: 'object',
          properties: {
            personaId: personaIdProp,
            enabled: {
              type: 'boolean',
              description: 'Enable or disable Google AdSense on the exported profile site.',
            },
            publisherId: {
              type: 'string',
              description: 'Google AdSense Publisher ID (format: ca-pub-1234567890123456).',
            },
            enableAutoAds: {
              type: 'boolean',
              description: 'Allow Google Auto Ads via the head tag (default true).',
            },
            generateAdsTxt: {
              type: 'boolean',
              description: 'Automatically generate /ads.txt in the exported site root (default true).',
            },
            headerSlotId: {
              type: 'string',
              description: 'Optional numeric AdSense slot ID for the Profile Banner ad slot.',
            },
            inFeedSlotId: {
              type: 'string',
              description: 'Optional numeric AdSense slot ID for the In-Feed ad slot.',
            },
            footerSlotId: {
              type: 'string',
              description: 'Optional numeric AdSense slot ID for the Footer ad slot.',
            },
            clear: {
              type: 'boolean',
              description: 'If true, wipes stored AdSense Publisher ID, slot IDs, and disables the add-on.',
            },
          },
        },
      },
    ];
  }

  public getResources(): McpResourceDefinition[] {
    return [
      {
        uri: 'webring://personas',
        name: 'Compartmentalized Personas Registry',
        description:
          'List of all isolated personas, their DIDs, site URLs, and content statistics.',
        mimeType: 'application/json',
      },
      {
        uri: 'webring://active/bundle',
        name: 'Active Persona Signed Site Bundle',
        description:
          'Complete signed JSON bundle (manifest, profile, albums, items, connections, didDocument) for the active persona.',
        mimeType: 'application/json',
      },
      {
        uri: 'webring://active/feed',
        name: 'Active Persona Neighborhood Feed',
        description:
          'Chronological feed of posts, photos, likes, and comments crawled from friends.',
        mimeType: 'application/json',
      },
      {
        uri: 'webring://active/endorsements',
        name: 'Active Persona Endorsements & Comments',
        description:
          'Verified likes, shares, and comments from friends targeting the active persona’s posts and photos.',
        mimeType: 'application/json',
      },
      {
        uri: 'webring://active/addons',
        name: 'Active Persona Optional Add-Ons (Analytics, AdSense & Comments)',
        description:
          'Configuration and status of optional Google Analytics (GA4), Google AdSense monetization, and live comment add-ons.',
        mimeType: 'application/json',
      },
    ];
  }

  public getPrompts(): McpPromptDefinition[] {
    return [
      {
        name: 'daily-ring-digest',
        description:
          'Crawl all friends in the webring, summarize new wall posts and photos in the Neighborhood Feed, highlight new comments/likes on your posts, and suggest thoughtful replies.',
        arguments: [
          {
            name: 'personaId',
            description: 'Optional persona ID to run the digest for.',
            required: false,
          },
        ],
      },
      {
        name: 'publish-wall-update',
        description:
          'Draft and publish a new Wall Post for the active persona, sign all static JSON endpoints, and export the updated static profile site.',
        arguments: [
          {
            name: 'topic',
            description: 'What you want to post about on your wall.',
            required: true,
          },
          {
            name: 'tags',
            description: 'Optional comma-separated tags.',
            required: false,
          },
        ],
      },
      {
        name: 'opsec-privacy-audit',
        description:
          'Audit all personas in Webring Studio for cross-persona domain correlation, Social Graph Privacy Shield settings, and Friend TOFU Ed25519 key status.',
        arguments: [],
      },
    ];
  }

  public async executeToolCall(
    name: string,
    rawArgs?: Record<string, unknown>
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean; data?: unknown }> {
    const args = rawArgs || {};
    try {
      let resultData: unknown;
      let summary = `Called ${name}`;

      switch (name) {
        case 'webring_list_personas': {
          resultData = this.personaManager.listPersonas();
          summary = `Listed ${
            (resultData as { personas: unknown[] }).personas.length
          } persona(s)`;
          break;
        }

        case 'webring_create_persona': {
          resultData = this.personaManager.createPersona({
            label: String(args.label || 'New Persona'),
            displayName: String(args.displayName || 'New Persona'),
            siteUrl: args.siteUrl ? String(args.siteUrl) : undefined,
            tagline: args.tagline ? String(args.tagline) : undefined,
            bio: args.bio ? String(args.bio) : undefined,
            theme: (args.theme as ProfileTheme) || 'neo-webring',
          });
          summary = `Created & switched to persona "${args.label}"`;
          break;
        }

        case 'webring_switch_persona': {
          const targetId = String(args.personaId || '');
          resultData = this.personaManager.switchPersona(targetId);
          summary = `Switched active persona to "${targetId}"`;
          break;
        }

        case 'webring_get_profile': {
          const ctx = this.resolveContext(args);
          resultData = ctx.db.getProfile();
          summary = `Read profile for ${ctx.persona.displayName}`;
          break;
        }

        case 'webring_update_profile': {
          const ctx = this.resolveContext(args);
          const current = ctx.db.getProfile();
          const publishUpdates: Record<string, unknown> = {};
          for (const key of [
            'publishFriendsList',
            'stripRelationshipTags',
            'publishEndorsements',
            'redactItemSourceAuthors',
            'commentProvider',
            'giscusRepo',
            'giscusCategory',
            'analyticsEnabled',
            'analyticsMeasurementId',
            'analyticsRespectDnt',
            'analyticsAnonymizeIp',
            'analyticsTrackRingInteractions',
            'adsEnabled',
            'adsPublisherId',
            'adsEnableAutoAds',
            'adsGenerateAdsTxt',
            'adsHeaderSlotId',
            'adsInFeedSlotId',
            'adsFooterSlotId',
          ]) {
            if (args[key] !== undefined) {
              publishUpdates[key] = args[key];
            }
          }

          resultData = ctx.db.updateProfile({
            siteUrl: args.siteUrl ? String(args.siteUrl) : undefined,
            displayName: args.displayName ? String(args.displayName) : undefined,
            tagline: args.tagline !== undefined ? String(args.tagline) : undefined,
            bio: args.bio !== undefined ? String(args.bio) : undefined,
            location: args.location !== undefined ? String(args.location) : undefined,
            avatarUrl: args.avatarUrl !== undefined ? String(args.avatarUrl) : undefined,
            bannerUrl: args.bannerUrl !== undefined ? String(args.bannerUrl) : undefined,
            interests: Array.isArray(args.interests)
              ? args.interests.map(String)
              : undefined,
            theme: args.theme ? (String(args.theme) as ProfileTheme) : undefined,
            ...(args.appearance !== undefined ? { appearance: args.appearance as Appearance } : {}),
            ...(Array.isArray(args.layout) ? { layout: args.layout as LayoutBlock[] } : {}),
            atprotoHandle:
              args.atprotoHandle !== undefined ? String(args.atprotoHandle) : undefined,
            publishSettings:
              Object.keys(publishUpdates).length > 0
                ? { ...current.publishSettings, ...publishUpdates }
                : undefined,
          });
          if (args.avatarUrl !== undefined || args.bannerUrl !== undefined) cleanUpLibrary(ctx.db, ctx.mediaLibrary);
          summary = `Updated profile for ${ctx.persona.displayName}`;
          break;
        }

        case 'webring_set_profile_image': {
          const ctx = this.resolveContext(args);
          const kind = args.kind === 'banner' ? 'banner' : args.kind === 'avatar' ? 'avatar' : null;
          if (!kind) throw new Error('kind must be "avatar" or "banner".');
          const field = kind === 'avatar' ? 'avatarUrl' : 'bannerUrl';
          let url: string;
          if (args.localPath) {
            url = setProfileImageFromFile(ctx.db, ctx.mediaLibrary, kind, String(args.localPath));
          } else if (args.photoId) {
            const photo = ctx.db.getAlbums().flatMap((a) => a.photos).find((p) => p.id === String(args.photoId));
            if (!photo) throw new Error(`Photo "${String(args.photoId)}" not found.`);
            url = kind === 'avatar' ? photo.thumbUrl || photo.url : photo.url;
            ctx.db.updateProfile({ [field]: url });
            cleanUpLibrary(ctx.db, ctx.mediaLibrary);
          } else if (args.url !== undefined) {
            url = String(args.url);
            if (url && !/^https?:\/\//i.test(url)) throw new Error('url must be an http(s) address, or "" to remove the image.');
            ctx.db.updateProfile({ [field]: url });
            cleanUpLibrary(ctx.db, ctx.mediaLibrary);
          } else {
            throw new Error('Give one of localPath, photoId or url.');
          }
          resultData = { kind, url };
          summary = url ? `Set the ${kind === 'avatar' ? 'profile photo' : 'banner'} to ${url}` : `Removed the ${kind === 'avatar' ? 'profile photo' : 'banner'}`;
          break;
        }

        case 'webring_list_items': {
          const ctx = this.resolveContext(args);
          let items = ctx.db.getItems();
          if (typeof args.type === 'string' && args.type) {
            items = items.filter((i) => i.type === args.type);
          }
          if (typeof args.tag === 'string' && args.tag) {
            const needle = args.tag.toLowerCase().replace(/^#/, '');
            items = items.filter((i) => i.tags.some((t) => t.toLowerCase() === needle));
          }
          resultData = { count: items.length, items };
          summary = `Listed ${items.length} item(s)`;
          break;
        }

        case 'webring_create_post': {
          const ctx = this.resolveContext(args);
          const created = ctx.db.createItem({
            type: 'post',
            title: args.title ? String(args.title) : undefined,
            commentary: String(args.commentary || ''),
            mediaUrl: args.mediaUrl ? String(args.mediaUrl) : undefined,
            category: 'status',
            tags: Array.isArray(args.tags) ? args.tags.map(String) : ['wall', 'webring'],
          });
          resultData = created;
          summary = `Published Wall Post "${created.title}"`;
          break;
        }

        case 'webring_interact_with_url': {
          const ctx = this.resolveContext(args);
          const type = (args.type as SharedItemType) || 'like';
          const created = ctx.db.createItem({
            type,
            targetUrl: String(args.targetUrl || ''),
            commentary: String(args.commentary || ''),
            title: args.title ? String(args.title) : undefined,
            targetAuthorName: args.targetAuthorName
              ? String(args.targetAuthorName)
              : undefined,
            targetAuthorUrl: args.targetAuthorUrl
              ? String(args.targetAuthorUrl)
              : undefined,
            category: args.category ? String(args.category) : type === 'comment' ? 'comment' : 'general',
            rating: typeof args.rating === 'number' ? args.rating : undefined,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
          });
          resultData = created;
          summary = `Published ${type} on ${created.targetUrl}`;
          break;
        }

        case 'webring_update_item': {
          const ctx = this.resolveContext(args);
          const itemId = String(args.itemId || '');
          const str = (key: string) => (args[key] !== undefined ? String(args[key]) : undefined);
          const updated = ctx.db.updateItem(itemId, {
            title: str('title'),
            commentary: str('commentary'),
            targetUrl: str('targetUrl'),
            targetAuthorName: str('targetAuthorName'),
            targetAuthorUrl: str('targetAuthorUrl'),
            category: str('category'),
            mediaUrl: str('mediaUrl'),
            rating: typeof args.rating === 'number' ? args.rating : undefined,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
          });
          cleanUpLibrary(ctx.db, ctx.mediaLibrary);
          resultData = updated;
          summary = `Edited "${updated.title}"`;
          break;
        }

        case 'webring_delete_item': {
          const ctx = this.resolveContext(args);
          const itemId = String(args.itemId || '');
          ctx.db.deleteItem(itemId);
          cleanUpLibrary(ctx.db, ctx.mediaLibrary);
          resultData = { deleted: true, itemId };
          summary = `Deleted item ${itemId}`;
          break;
        }

        case 'webring_list_albums': {
          const ctx = this.resolveContext(args);
          const albums = ctx.db.getAlbums();
          resultData = { count: albums.length, albums };
          summary = `Listed ${albums.length} photo album(s)`;
          break;
        }

        case 'webring_create_album': {
          const ctx = this.resolveContext(args);
          const album = ctx.db.createAlbum({
            title: String(args.title || 'Untitled Album'),
            description: args.description ? String(args.description) : undefined,
            coverUrl: args.coverUrl ? String(args.coverUrl) : undefined,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
          });
          resultData = album;
          summary = `Created photo album "${album.title}"`;
          break;
        }

        case 'webring_add_photo': {
          const ctx = this.resolveContext(args);
          const albumId = String(args.albumId || '');
          const urlOrPath = String(args.urlOrLocalPath || '');
          const isLocalFile = !/^https?:\/\//i.test(urlOrPath) && fs.existsSync(urlOrPath);
          const media = isLocalFile ? ctx.mediaLibrary.importPhoto(urlOrPath, albumId) : undefined;
          const photo = ctx.db.addPhotoToAlbum({
            albumId,
            url: urlOrPath,
            media,
            caption: args.caption ? String(args.caption) : undefined,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
          });
          resultData = photo;
          summary = `Added photo "${photo.caption || photo.id}" to album ${albumId}`;
          break;
        }

        case 'webring_delete_album': {
          const ctx = this.resolveContext(args);
          const albumId = String(args.albumId || '');
          deleteAlbumWithFiles(ctx.db, ctx.mediaLibrary, albumId);
          resultData = { deleted: true, albumId };
          summary = `Deleted album ${albumId}`;
          break;
        }

        case 'webring_delete_photo': {
          const ctx = this.resolveContext(args);
          const photoId = String(args.photoId || '');
          deletePhotoWithFiles(ctx.db, ctx.mediaLibrary, photoId);
          resultData = { deleted: true, photoId };
          summary = `Deleted photo ${photoId}`;
          break;
        }

        case 'webring_list_friends': {
          const ctx = this.resolveContext(args);
          const friends = ctx.db.getFriends();
          resultData = { count: friends.length, friends };
          summary = `Listed ${friends.length} friend(s) in local ring`;
          break;
        }

        case 'webring_add_friend': {
          const ctx = this.resolveContext(args);
          const friend = ctx.db.addOrUpdateFriend({
            siteUrl: String(args.siteUrl || ''),
            displayName: String(args.displayName || ''),
            visibility:
              args.visibility === 'public' ? 'public' : ('private' as FriendVisibility),
            relationship: Array.isArray(args.relationship)
              ? args.relationship.map(String)
              : ['friend'],
            bio: args.bio ? String(args.bio) : undefined,
            avatarUrl: args.avatarUrl ? String(args.avatarUrl) : undefined,
          });
          resultData = friend;
          summary = `Added/updated friend ${friend.displayName} (${friend.visibility})`;
          break;
        }

        case 'webring_set_friend_visibility': {
          const ctx = this.resolveContext(args);
          const friendId = String(args.friendId || '');
          const visibility: FriendVisibility =
            args.visibility === 'public' ? 'public' : 'private';
          const updated = ctx.db.setFriendVisibility(friendId, visibility);
          resultData = updated;
          summary = `Set friend ${friendId} visibility to ${visibility}`;
          break;
        }

        case 'webring_set_moderation': {
          const ctx = this.resolveContext(args);
          const siteUrl = String(args.siteUrl || '');
          const action =
            args.action === 'mute' || args.action === 'block' ? args.action : null;
          resultData = { moderation: ctx.db.setModeration(siteUrl, action) };
          summary = `Set moderation for ${siteUrl} to ${action || 'none'}`;
          break;
        }

        case 'webring_delete_friend': {
          const ctx = this.resolveContext(args);
          const friendId = String(args.friendId || '');
          ctx.db.deleteFriend(friendId);
          resultData = { deleted: true, friendId };
          summary = `Removed friend ${friendId}`;
          break;
        }

        case 'webring_crawl_friend': {
          const ctx = this.resolveContext(args);
          const siteUrl = String(args.siteUrl || '');
          const localDirOverride = args.localDirOverride
            ? String(args.localDirOverride)
            : undefined;
          const res = await ctx.ringCrawler.crawlFriendSite(siteUrl, localDirOverride);
          resultData = res;
          summary = `Crawled ${siteUrl} (verified=${res.verifiedSignature}, items=${res.itemsIndexed})`;
          break;
        }

        case 'webring_crawl_all_friends': {
          const ctx = this.resolveContext(args);
          const results = await ctx.ringCrawler.crawlAllFriends();
          resultData = {
            crawledCount: results.length,
            results,
            totalEndorsements: ctx.db.getCuratedEndorsements().entries.length,
            totalFeedEntries: ctx.db.getCuratedNetworkFeed().entries.length,
          };
          summary = `Crawled all ${results.length} friend(s) in ring`;
          break;
        }

        case 'webring_save_post': {
          const ctx = this.resolveContext(args);
          const saved = await savePost(ctx.db, ctx.mediaLibrary, String(args.canonicalUrl || ''), {
            note: args.note !== undefined ? String(args.note) : undefined,
          });
          resultData = saved;
          summary = `Saved "${saved.title}" from ${saved.friendName}`;
          break;
        }

        case 'webring_list_saved': {
          const ctx = this.resolveContext(args);
          resultData = ctx.db.getSavedPosts();
          summary = `${(resultData as unknown[]).length} saved post(s)`;
          break;
        }

        case 'webring_unsave_post': {
          const ctx = this.resolveContext(args);
          unsavePost(ctx.db, ctx.mediaLibrary, String(args.savedId || ''));
          resultData = { removed: true, savedId: args.savedId };
          summary = 'Removed saved post';
          break;
        }

        case 'webring_set_feed_retention': {
          const ctx = this.resolveContext(args);
          resultData = ctx.db.setFeedRetentionDays(Number(args.days));
          const { days, pruned } = resultData as { days: number; pruned: number };
          summary = days ? `Feed keeps ${days} day(s); removed ${pruned} older entr${pruned === 1 ? 'y' : 'ies'}` : 'Feed keeps everything';
          break;
        }

        case 'webring_get_neighborhood_feed': {
          const ctx = this.resolveContext(args);
          const curated = ctx.db.getCuratedNetworkFeed();
          let feed = curated.entries;
          if (typeof args.entryType === 'string' && args.entryType) {
            feed = feed.filter((e) => e.entryType === args.entryType);
          }
          if (typeof args.friendSiteUrl === 'string' && args.friendSiteUrl) {
            feed = feed.filter((e) =>
              e.friendSiteUrl.toLowerCase().includes(String(args.friendSiteUrl).toLowerCase())
            );
          }
          if (args.verifiedOnly === true) {
            feed = feed.filter((e) => e.verifiedSignature);
          }
          const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50;
          feed = feed.slice(0, limit);
          resultData = { count: feed.length, entries: feed, excluded: curated.excluded };
          summary = `Retrieved ${feed.length} Neighborhood Feed entries`;
          break;
        }

        case 'webring_get_endorsements': {
          const ctx = this.resolveContext(args);
          const curated = ctx.db.getCuratedEndorsements();
          const endorsements = curated.entries;
          resultData = { count: endorsements.length, endorsements, excluded: curated.excluded };
          summary = `Retrieved ${endorsements.length} peer endorsement(s)/comment(s)`;
          break;
        }

        case 'webring_list_rings': {
          const ctx = this.resolveContext(args);
          resultData = {
            joined: ctx.db.getJoinedRings().map(({ requestToken: _t, ...ring }) => ring),
            hosted: ctx.db.getHostedRings(),
          };
          summary = 'Listed joined and hosted rings';
          break;
        }

        case 'webring_join_ring': {
          const ctx = this.resolveContext(args);
          const res = await ctx.ringService.requestToJoin(String(args.hubUrl || ''));
          resultData = res;
          summary = `Created a join request for "${res.ring.name}"`;
          break;
        }

        case 'webring_leave_ring': {
          const ctx = this.resolveContext(args);
          const ringId = String(args.ringId || '');
          ctx.db.deleteWebring(ringId);
          resultData = { left: true, ringId };
          summary = `Left ring ${ringId}`;
          break;
        }

        case 'webring_sync_rings': {
          const ctx = this.resolveContext(args);
          resultData = {
            joined: await ctx.ringService.syncJoinedRings(),
            hosted: await ctx.ringService.syncHostedRings(),
          };
          summary = 'Synced joined and hosted rings';
          break;
        }

        case 'webring_create_hosted_ring': {
          const ctx = this.resolveContext(args);
          const ring = ctx.db.createHostedRing({
            name: String(args.name || ''),
            description: args.description ? String(args.description) : undefined,
          });
          resultData = ring;
          summary = `Created hosted ring "${ring.name}"`;
          break;
        }

        case 'webring_review_ring_request': {
          const ctx = this.resolveContext(args);
          const link = String(args.requestLink || '');
          const decision =
            args.decision === 'approve' || args.decision === 'decline' || args.decision === 'ban'
              ? args.decision
              : undefined;
          const review = decision
            ? await ctx.ringService.decideRequest(link, decision, args.reason ? String(args.reason) : undefined)
            : await ctx.ringService.reviewRequest(link);
          const { token: _token, ...publicReview } = review;
          resultData = { ...publicReview, decision: decision || 'none' };
          summary = decision
            ? `${decision} ${review.applicant.siteUrl} for "${review.ring.name}"`
            : `Reviewed request from ${review.applicant.siteUrl}`;
          break;
        }

        case 'webring_get_schedule': {
          const ctx = this.resolveContext(args);
          const scheduler = this.getScheduler();
          const config = scheduler.loadConfig();
          const schedule = scheduler.getPersonaSchedule(ctx.persona.id);
          resultData = {
            personaId: ctx.persona.id,
            schedule,
            nextSyncAt: schedule.sync.enabled ? jobNextRunAt(schedule.sync).toISOString() : null,
            nextPublishAt: schedule.publish.enabled ? jobNextRunAt(schedule.publish).toISOString() : null,
            app: {
              runInBackground: config.runInBackground,
              startAtLogin: config.startAtLogin,
              paused: config.paused,
            },
            appRunning: Boolean(this.attachedScheduler),
          };
          summary = `Read schedules for ${ctx.persona.label}`;
          break;
        }

        case 'webring_set_schedule': {
          const ctx = this.resolveContext(args);
          const isPreset = (value: unknown): value is SchedulePreset => {
            const v = value as Record<string, unknown> | null;
            if (!v || typeof v !== 'object') return false;
            if (v.kind === 'interval') return [15, 60, 360, 720].includes(Number(v.minutes));
            const timeOk = typeof v.time === 'string' && /^\d{1,2}:\d{2}$/.test(v.time);
            if (v.kind === 'daily') return timeOk;
            return v.kind === 'weekly' && timeOk && Number.isInteger(v.weekday) && Number(v.weekday) >= 0 && Number(v.weekday) <= 6;
          };
          for (const key of ['syncPreset', 'publishPreset']) {
            if (args[key] !== undefined && !isPreset(args[key])) {
              throw new Error(`${key} isn't a valid preset`);
            }
          }
          const destination = args.publishDestination;
          if (destination !== undefined && !['local', 'remote', 'github'].includes(String(destination))) {
            throw new Error('publishDestination must be local, remote or github');
          }
          const updated = this.getScheduler().setPersonaSchedule(ctx.persona.id, {
            sync: {
              ...(typeof args.syncEnabled === 'boolean' ? { enabled: args.syncEnabled } : {}),
              ...(args.syncPreset ? { preset: args.syncPreset as SchedulePreset } : {}),
            },
            publish: {
              ...(typeof args.publishEnabled === 'boolean' ? { enabled: args.publishEnabled } : {}),
              ...(args.publishPreset ? { preset: args.publishPreset as SchedulePreset } : {}),
              ...(destination ? { destination: destination as 'local' | 'remote' | 'github' } : {}),
              ...(typeof args.syncBeforePublish === 'boolean' ? { syncFirst: args.syncBeforePublish } : {}),
            },
          });
          resultData = { personaId: ctx.persona.id, schedule: updated };
          summary = `Updated schedules for ${ctx.persona.label}`;
          break;
        }

        case 'webring_run_scheduled_job': {
          const ctx = this.resolveContext(args);
          if (!this.attachedScheduler) {
            throw new Error('Open Webring Studio to run scheduled jobs (the stdio server can only edit schedules).');
          }
          const job = args.job === 'publish' ? 'publish' : 'sync';
          const result = await this.attachedScheduler.runNow(ctx.persona.id, job);
          resultData = result;
          summary = `Ran ${job} for ${ctx.persona.label}: ${result.status}`;
          break;
        }

        case 'webring_set_ring_member': {
          const ctx = this.resolveContext(args);
          const ringId = String(args.ringId || '');
          const siteUrl = String(args.siteUrl || '');
          const reason = args.reason ? String(args.reason) : undefined;
          switch (args.action) {
            case 'remove':
              resultData = ctx.db.removeRingMember(ringId, siteUrl);
              break;
            case 'ban':
              resultData = ctx.db.banRingMember(ringId, { siteUrl, reason });
              break;
            case 'unban':
              resultData = ctx.db.unbanRingMember(ringId, siteUrl);
              break;
            case 'hide':
            case 'show':
              resultData = ctx.db.setRingMemberHidden(ringId, siteUrl, args.action === 'hide');
              break;
            case 'up':
            case 'down':
              resultData = ctx.db.moveRingMember(ringId, siteUrl, args.action);
              break;
            default:
              throw new Error(`Unknown action ${String(args.action)}`);
          }
          summary = `${String(args.action)} ${siteUrl} in ring ${ringId}`;
          break;
        }

        case 'webring_export_static_site': {
          const ctx = this.resolveContext(args);
          const profile = ctx.db.getProfile();
          const defaultFolder =
            ctx.persona.id === 'default'
              ? 'exported-profile-site'
              : `exported-profile-site-${ctx.persona.id}`;
          const outDir =
            (typeof args.targetDir === 'string' && args.targetDir.trim()) ||
            profile.publishSettings?.exportPath ||
            path.join(this.userDataDir, defaultFolder);

          const pubRes = ctx.sitePublisher.publishToLocalDirectory(outDir);
          if (pubRes.success) {
            ctx.db.updateProfile({
              publishSettings: { ...profile.publishSettings, exportPath: outDir },
            });
          }
          resultData = pubRes;
          summary = `Exported signed static site to ${outDir}`;
          break;
        }

        case 'webring_start_preview_server': {
          const ctx = this.resolveContext(args);
          const previewDir = path.join(
            this.userDataDir,
            `test-preview-site-${ctx.persona.id}`
          );
          const res = await this.previewServer.runTestExportAndServe(
            ctx.siteGenerator,
            previewDir
          );
          resultData = res;
          summary = `Started local preview server at ${res.previewUrl}`;
          break;
        }

        case 'webring_get_addons': {
          const ctx = this.resolveContext(args);
          const p = ctx.db.getProfile();
          const ps = p.publishSettings;
          resultData = {
            personaId: ctx.persona.id,
            displayName: p.displayName,
            analyticsAddon: p.analyticsAddon || {
              enabled: Boolean(ps.analyticsEnabled),
              measurementId: ps.analyticsMeasurementId || '',
              validMeasurementId: isValidGa4MeasurementId(ps.analyticsMeasurementId),
              respectDoNotTrack: ps.analyticsRespectDnt !== false,
              anonymizeIp: ps.analyticsAnonymizeIp !== false,
              trackRingInteractions: ps.analyticsTrackRingInteractions !== false,
            },
            adsAddon: p.adsAddon || {
              enabled: Boolean(ps.adsEnabled),
              publisherId: ps.adsPublisherId || '',
              normalizedPublisherId: normalizeAdSensePublisherId(ps.adsPublisherId),
              enableAutoAds: ps.adsEnableAutoAds !== false,
              generateAdsTxt: ps.adsGenerateAdsTxt !== false,
              headerSlotId: ps.adsHeaderSlotId || '',
              inFeedSlotId: ps.adsInFeedSlotId || '',
              footerSlotId: ps.adsFooterSlotId || '',
            },
            commentAddon: p.commentConfig || {
              provider: ps.commentProvider || 'none',
              giscusRepo: ps.giscusRepo || '',
            },
          };
          summary = `Inspected profile add-ons for ${p.displayName}`;
          break;
        }

        case 'webring_configure_analytics_addon': {
          const ctx = this.resolveContext(args);
          const current = ctx.db.getProfile();
          const ps = current.publishSettings;

          if (args.clear === true) {
            const cleared = ctx.db.updateProfile({
              publishSettings: {
                ...ps,
                analyticsEnabled: false,
                analyticsMeasurementId: '',
                analyticsRespectDnt: true,
                analyticsAnonymizeIp: true,
                analyticsTrackRingInteractions: true,
              },
            });
            resultData = { cleared: true, analyticsAddon: cleared.analyticsAddon || null };
            summary = `Cleared Google Analytics (GA4) add-on for ${ctx.persona.displayName}`;
            break;
          }

          const nextMeasurementId =
            args.measurementId !== undefined
              ? String(args.measurementId).trim().toUpperCase()
              : ps.analyticsMeasurementId || '';

          if (nextMeasurementId && !isValidGa4MeasurementId(nextMeasurementId)) {
            throw new Error(
              `Invalid GA4 Measurement ID "${nextMeasurementId}". Expected format: G-XXXXXXXXXX.`
            );
          }

          const nextEnabled =
            args.enabled !== undefined ? Boolean(args.enabled) : Boolean(ps.analyticsEnabled);

          const updated = ctx.db.updateProfile({
            publishSettings: {
              ...ps,
              analyticsEnabled: nextEnabled,
              analyticsMeasurementId: nextMeasurementId,
              analyticsRespectDnt:
                args.respectDoNotTrack !== undefined
                  ? Boolean(args.respectDoNotTrack)
                  : ps.analyticsRespectDnt !== false,
              analyticsAnonymizeIp:
                args.anonymizeIp !== undefined
                  ? Boolean(args.anonymizeIp)
                  : ps.analyticsAnonymizeIp !== false,
              analyticsTrackRingInteractions:
                args.trackRingInteractions !== undefined
                  ? Boolean(args.trackRingInteractions)
                  : ps.analyticsTrackRingInteractions !== false,
            },
          });

          resultData = {
            enabled: Boolean(updated.analyticsAddon?.enabled),
            analyticsAddon: updated.analyticsAddon || null,
          };
          summary = `Configured Google Analytics (GA4) add-on (${
            nextEnabled ? nextMeasurementId : 'disabled'
          }) for ${ctx.persona.displayName}`;
          break;
        }

        case 'webring_configure_ads_addon': {
          const ctx = this.resolveContext(args);
          const current = ctx.db.getProfile();
          const ps = current.publishSettings;

          if (args.clear === true) {
            const cleared = ctx.db.updateProfile({
              publishSettings: {
                ...ps,
                adsEnabled: false,
                adsPublisherId: '',
                adsEnableAutoAds: true,
                adsGenerateAdsTxt: true,
                adsHeaderSlotId: '',
                adsInFeedSlotId: '',
                adsFooterSlotId: '',
              },
            });
            resultData = { cleared: true, adsAddon: cleared.adsAddon || null };
            summary = `Cleared Google AdSense add-on for ${ctx.persona.displayName}`;
            break;
          }

          const rawPubId =
            args.publisherId !== undefined
              ? String(args.publisherId).trim()
              : ps.adsPublisherId || '';
          const normalizedPubId = rawPubId ? normalizeAdSensePublisherId(rawPubId) : '';
          if (rawPubId && !normalizedPubId) {
            throw new Error(
              `Invalid AdSense Publisher ID "${rawPubId}". Expected format: ca-pub-1234567890123456.`
            );
          }

          const checkSlot = (val: unknown, fallback: string, label: string): string => {
            if (val === undefined) return fallback;
            const s = String(val).trim();
            if (s && !isValidAdSlotId(s)) {
              throw new Error(`Invalid ${label} "${s}". Expected numeric AdSense slot ID.`);
            }
            return s;
          };

          const nextEnabled =
            args.enabled !== undefined ? Boolean(args.enabled) : Boolean(ps.adsEnabled);

          const updated = ctx.db.updateProfile({
            publishSettings: {
              ...ps,
              adsEnabled: nextEnabled,
              adsPublisherId: normalizedPubId,
              adsEnableAutoAds:
                args.enableAutoAds !== undefined
                  ? Boolean(args.enableAutoAds)
                  : ps.adsEnableAutoAds !== false,
              adsGenerateAdsTxt:
                args.generateAdsTxt !== undefined
                  ? Boolean(args.generateAdsTxt)
                  : ps.adsGenerateAdsTxt !== false,
              adsHeaderSlotId: checkSlot(
                args.headerSlotId,
                ps.adsHeaderSlotId || '',
                'headerSlotId'
              ),
              adsInFeedSlotId: checkSlot(
                args.inFeedSlotId,
                ps.adsInFeedSlotId || '',
                'inFeedSlotId'
              ),
              adsFooterSlotId: checkSlot(
                args.footerSlotId,
                ps.adsFooterSlotId || '',
                'footerSlotId'
              ),
            },
          });

          resultData = {
            enabled: Boolean(updated.adsAddon?.enabled),
            adsAddon: updated.adsAddon || null,
          };
          summary = `Configured Google AdSense add-on (${
            nextEnabled ? normalizedPubId : 'disabled'
          }) for ${ctx.persona.displayName}`;
          break;
        }

        default:
          throw new Error(`Unknown MCP tool: ${name}`);
      }

      this.recordActivity('tools/call', summary, true, name);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(resultData, null, 2),
          },
        ],
        data: resultData,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordActivity('tools/call', `Error in ${name}: ${msg}`, false, name);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: msg }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  public readResource(uri: string): {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  } {
    const ctx = this.personaManager.getActiveContext();
    let payload: unknown;

    switch (uri) {
      case 'webring://personas':
        payload = this.personaManager.listPersonas();
        break;
      case 'webring://active/bundle':
        payload = ctx.db.buildSignedSiteBundle();
        break;
      case 'webring://active/feed':
        payload = ctx.db.getCuratedNetworkFeed();
        break;
      case 'webring://active/endorsements':
        payload = ctx.db.getCuratedEndorsements();
        break;
      case 'webring://active/addons': {
        const p = ctx.db.getProfile();
        payload = {
          personaId: ctx.persona.id,
          analyticsAddon: p.analyticsAddon || null,
          adsAddon: p.adsAddon || null,
          commentConfig: p.commentConfig || null,
        };
        break;
      }
      default:
        throw new Error(`Unknown MCP resource URI: ${uri}`);
    }

    this.recordActivity('resources/read', `Read resource ${uri}`, true);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  public getPromptTemplate(
    name: string,
    args?: Record<string, unknown>
  ): {
    description: string;
    messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
  } {
    switch (name) {
      case 'daily-ring-digest': {
        const personaClause = args?.personaId
          ? `First switch to persona "${args.personaId}" using webring_switch_persona.`
          : 'Use the currently active persona.';
        return {
          description: 'Crawl all friends in the ring and prepare a daily social digest.',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `${personaClause}\n1. Call webring_crawl_all_friends to pull the latest static JSON feeds from my friend ring.\n2. Call webring_get_neighborhood_feed and webring_get_endorsements.\n3. Summarize any new Wall Posts, photos, or recommendations from my friends, highlight any new comments or likes on my own posts, and ask if I'd like to post a reply or like using webring_interact_with_url.`,
              },
            },
          ],
        };
      }
      case 'publish-wall-update': {
        const topic = String(args?.topic || 'a status update');
        const tags = String(args?.tags || 'indieweb, webring');
        return {
          description: 'Draft, sign, and export a new Wall Post.',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Please read my profile voice via webring_get_profile, then publish a new Wall Post about "${topic}" (tags: ${tags}) using webring_create_post, and finally export my signed static website using webring_export_static_site.`,
              },
            },
          ],
        };
      }
      case 'opsec-privacy-audit': {
        return {
          description: 'Audit cross-persona OPSEC, privacy shield flags, and friend TOFU keys.',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Please audit my Webring Studio security and privacy posture:\n1. Call webring_list_personas and check if any personas share the same domain hostname.\n2. Call webring_get_profile and webring_get_addons to inspect my Social Graph Privacy Shield settings and optional Analytics/AdSense add-ons.\n3. Call webring_list_friends and check if any friend has keyStatus === "changed" (TOFU key mismatch warning).`,
              },
            },
          ],
        };
      }
      default:
        throw new Error(`Unknown MCP prompt: ${name}`);
    }
  }

  /**
   * Handles any incoming JSON-RPC 2.0 request or notification according to the MCP specification.
   * Returns `null` for notifications (which have no `id`).
   */
  public async handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const { id, method, params } = request;

    // Notifications (no id) do not receive a response
    if (id === undefined) {
      return null;
    }

    try {
      switch (method) {
        case 'initialize':
          this.recordActivity('initialize', 'MCP Client initialized session', true);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                prompts: { listChanged: false },
              },
              serverInfo: {
                name: 'webring-studio-mcp',
                version: '1.0.0',
              },
            },
          };

        case 'ping':
          return {
            jsonrpc: '2.0',
            id,
            result: {},
          };

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: this.getTools(),
            },
          };

        case 'tools/call': {
          const toolName = String(params?.name || '');
          const toolArgs = (params?.arguments as Record<string, unknown>) || {};
          const callResult = await this.executeToolCall(toolName, toolArgs);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: callResult.content,
              isError: callResult.isError,
            },
          };
        }

        case 'resources/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              resources: this.getResources(),
            },
          };

        case 'resources/read': {
          const uri = String(params?.uri || '');
          return {
            jsonrpc: '2.0',
            id,
            result: this.readResource(uri),
          };
        }

        case 'prompts/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              prompts: this.getPrompts(),
            },
          };

        case 'prompts/get': {
          const promptName = String(params?.name || '');
          const promptArgs = (params?.arguments as Record<string, unknown>) || {};
          return {
            jsonrpc: '2.0',
            id,
            result: this.getPromptTemplate(promptName, promptArgs),
          };
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
      }
    } catch (err: unknown) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
