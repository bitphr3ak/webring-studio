import React, { useEffect, useRef, useState } from 'react';
import {
  CompleteSiteBundle,
  CreatePersonaInput,
  EndorsementItem,
  FriendConnection,
  FriendVisibility,
  isPlaceholderSiteUrl,
  parseWebringUri,
  PersonaSummary,
  ProfileDocument,
  ProfileTheme,
  SharedItem,
  SharedItemType,
  siteUrlToDidWeb,
  WEBRING_SCHEMA_VERSION,
  WebringDeepLinkAction,
  WebringMembership,
  THEME_LABELS,
} from '../shared/schema';
import { SiteDesignPanel } from './SiteDesignPanel';
import { ItemEdit, ItemEditor } from './ItemEditor';
import { SavedPostView, SavedPostsView } from './SavedPostsView';
import { MarkdownField } from './MarkdownField';
import { renderMarkdown } from '../shared/markdown';
import { ProfileImagePicker } from './ProfileImagePicker';
import {
  BookOpen,
  Camera,
  CheckCircle2,
  Code2,
  Compass,
  Copy,
  ExternalLink,
  FolderOutput,
  Globe,
  Heart,
  ImagePlus,
  Layers,
  Link2,
  Lock,
  MessageSquare,
  Plus,
  Radio,
  RefreshCw,
  Repeat2,
  Server,
  ShieldCheck,
  Sparkles,
  Pencil,
  Trash2,
  UploadCloud,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';

interface PublishSettingsState {
  exportPath: string;
  protocol: 'sftp' | 'ftp';
  host: string;
  port: number;
  username: string;
  password?: string;
  remotePath: string;
  atprotoPdsUrl?: string;
  publishFriendsList?: boolean;
  stripRelationshipTags?: boolean;
  publishEndorsements?: boolean;
  redactItemSourceAuthors?: boolean;
  commentProvider?: 'none' | 'giscus' | 'utterances';
  giscusRepo?: string;
  giscusRepoId?: string;
  giscusCategory?: string;
  giscusCategoryId?: string;
  analyticsEnabled?: boolean;
  analyticsMeasurementId?: string;
  analyticsRespectDnt?: boolean;
  analyticsAnonymizeIp?: boolean;
  analyticsTrackRingInteractions?: boolean;
  adsEnabled?: boolean;
  adsPublisherId?: string;
  adsEnableAutoAds?: boolean;
  adsGenerateAdsTxt?: boolean;
  adsHeaderSlotId?: string;
  adsInFeedSlotId?: string;
  adsFooterSlotId?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  githubToken?: string;
  githubCustomDomain?: string;
  lastPublishedAt?: string;
  lastPublishedCounts?: {
    albumCount: number;
    photoCount: number;
    itemCount: number;
    friendCount: number;
    webringCount: number;
    endorsementCount: number;
  };
}

type ModerationAction = 'mute' | 'block';

interface ModerationEntry {
  siteUrl: string;
  action: ModerationAction;
  createdAt: string;
}

interface FeedExclusions {
  muted: number;
  blocked: number;
  unverified: number;
}

type JoinedRingStatus = 'requested' | 'member' | 'removed' | 'closed' | 'legacy';

interface JoinedRing {
  id: string;
  name: string;
  hubUrl: string;
  description: string;
  status: JoinedRingStatus;
  maintainerUrl: string;
  prevSiteUrl?: string;
  nextSiteUrl?: string;
  memberCount: number;
  directoryUrl?: string;
  hubVerified: boolean;
  lastSyncedAt?: string;
  requestToken?: string;
  syncWarning?: string;
  joinedAt: string;
}

interface HostedRingMember {
  siteUrl: string;
  displayName: string;
  position: number;
  joinedAt: string;
  confirmedAt?: string;
  lastVerifiedAt?: string;
  failCount: number;
  hidden: boolean;
  flagged: boolean;
}

interface HostedRing {
  id: string;
  slug: string;
  name: string;
  description: string;
  hubUrl: string;
  directoryUrl: string;
  maintainerIsMember: boolean;
  status: 'active' | 'closed';
  updatedAt: string;
  members: HostedRingMember[];
  bans: Array<{ siteUrl: string; reason: string; createdAt: string }>;
}

interface RingRequestReview {
  ring: { id: string; name: string; hubUrl: string };
  applicant: { siteUrl: string; displayName: string; did: string };
  state: 'new' | 'already-member' | 'banned';
  banReason?: string;
}

type RingMemberAction = 'remove' | 'ban' | 'unban' | 'hide' | 'show' | 'up' | 'down';

type SchedulePreset =
  | { kind: 'interval'; minutes: 15 | 60 | 360 | 720 }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekday: number; time: string };

interface ScheduleJobResult {
  at: string;
  status: 'ok' | 'skipped' | 'failed';
  message: string;
}

interface ScheduleJob {
  enabled: boolean;
  preset: SchedulePreset;
  lastRunAt?: string;
  lastResult?: ScheduleJobResult;
}

interface PersonaScheduleView {
  personaId: string;
  label: string;
  schedule: {
    sync: ScheduleJob;
    publish: ScheduleJob & { destination: 'local' | 'remote' | 'github'; syncFirst: boolean };
  };
  nextSyncAt: string | null;
  nextPublishAt: string | null;
  describe: { sync: string; publish: string };
}

interface ScheduleOverview {
  app: { runInBackground: boolean; startAtLogin: boolean; paused: boolean; notifyOnFailure: boolean };
  personas: PersonaScheduleView[];
  history: Array<ScheduleJobResult & { personaId: string; job: 'sync' | 'publish'; label: string }>;
  running: { personaId: string; job: 'sync' | 'publish' } | null;
}

function formatUpcoming(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 60000) return 'due now';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} hr`;
  return new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

interface CrawlSiteResult {
  siteUrl: string;
  success: boolean;
  displayName?: string;
  itemsIndexed: number;
  photosIndexed: number;
  endorsementsFound: number;
  entriesRejected: number;
  entriesPruned: number;
  verifiedSignature: boolean;
  keyChangedWarning?: boolean;
  blocked?: boolean;
  error?: string;
}

/** Media Library files (media/...) are served to the Studio window by the studio-media protocol. */
function mediaSrc(url: string): string {
  return url.startsWith('media/') ? `studio-media://local/${url.slice('media/'.length)}` : url;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRelativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

type FeedScope = 'friends' | 'everyone' | 'me' | 'saved';
const FEED_SCOPE_KEY = 'webring-studio.feedScope';

function loadFeedScope(): FeedScope {
  try {
    const stored = window.localStorage.getItem(FEED_SCOPE_KEY);
    return stored === 'everyone' || stored === 'me' || stored === 'saved' ? stored : 'friends';
  } catch {
    return 'friends';
  }
}

interface NetworkFeedEntry {
  id: string;
  friendSiteUrl: string;
  friendName: string;
  friendAvatarUrl: string;
  friendDid: string;
  entryType: 'photo' | 'post' | 'like' | 'share' | 'recommendation' | 'comment';
  title: string;
  canonicalUrl: string;
  targetUrl: string;
  commentary: string;
  mediaUrl: string;
  tags: string[];
  createdAt: string;
  verifiedSignature: boolean;
  /** Your own post or photo, shown in the feed (never stored with friends' entries). */
  isMine?: boolean;
}

interface TestExportPreviewState {
  success: boolean;
  outputDir: string;
  previewUrl: string;
  port: number;
  filesWritten: Array<{
    relativePath: string;
    sizeBytes: number;
  }>;
  checks: {
    hasIndexHtml: boolean;
    hasNoJekyll: boolean;
    hasDidJson: boolean;
    hasManifestJson: boolean;
    publicFriendsExported: number;
    albumsExported: number;
    itemsExported: number;
  };
}

declare global {
  interface Window {
    studioApi?: {
      getBundle: () => Promise<{
        activePersonaId: string;
        personas: PersonaSummary[];
        bundle: CompleteSiteBundle;
        allFriends: FriendConnection[];
        allEndorsements: EndorsementItem[];
        profileWithSettings: ProfileDocument & {
          publicKeyPem: string;
          publishSettings: PublishSettingsState;
        };
        networkFeed: NetworkFeedEntry[];
        feedExclusions: FeedExclusions;
        moderation: ModerationEntry[];
        changesSinceLastPublish: number;
        joinedRings: JoinedRing[];
        hostedRings: HostedRing[];
        publishedUpToDate: boolean;
        previewHtml: string;
        savedPosts?: SavedPostView[];
        feedRetentionDays?: number;
      }>;
      listPersonas: () => Promise<{
        activePersonaId: string;
        personas: PersonaSummary[];
      }>;
      createPersona: (input: CreatePersonaInput) => Promise<{
        created: PersonaSummary;
        activePersonaId: string;
        personas: PersonaSummary[];
      }>;
      switchPersona: (personaId: string) => Promise<{
        activePersonaId: string;
        personas: PersonaSummary[];
      }>;
      updatePersonaLabel: (
        personaId: string,
        label: string
      ) => Promise<{
        updated: PersonaSummary;
        activePersonaId: string;
        personas: PersonaSummary[];
      }>;
      deletePersona: (
        personaId: string,
        deleteFiles?: boolean
      ) => Promise<{
        deletedId: string;
        activePersonaId: string;
        personas: PersonaSummary[];
      }>;
      updateProfile: (updates: unknown) => Promise<unknown>;
      createAlbum: (input: unknown) => Promise<unknown>;
      deleteAlbum: (albumId: string) => Promise<unknown>;
      addPhoto: (input: unknown) => Promise<unknown>;
      importPhotos: (
        albumId: string,
        filePaths?: string[]
      ) => Promise<{ added: string[]; failed: Array<{ file: string; error: string }> }>;
      importImage: () => Promise<{ url: string; fileName: string } | null>;
      setProfileImage: (kind: 'avatar' | 'banner', filePath?: string) => Promise<{ url: string } | null>;
      replacePhoto: (photoId: string) => Promise<{ replaced: boolean }>;
      updatePhoto: (photoId: string, updates: { caption?: string; altText?: string; tags?: string[] }) => Promise<unknown>;
      movePhoto: (photoId: string, direction: 'up' | 'down') => Promise<unknown>;
      updateAlbum: (
        albumId: string,
        updates: { title?: string; description?: string; tags?: string[]; coverUrl?: string }
      ) => Promise<unknown>;
      getMediaUsage: () => Promise<{ files: number; bytes: number }>;
      forgetPublishHistory: () => Promise<unknown>;
      getPathForFile: (file: File) => string;
      deletePhoto: (photoId: string) => Promise<unknown>;
      createItem: (input: unknown) => Promise<unknown>;
      deleteItem: (itemId: string) => Promise<unknown>;
      updateItem: (itemId: string, updates: ItemEdit) => Promise<SharedItem>;
      savePost: (canonicalUrl: string) => Promise<SavedPostView>;
      unsavePost: (savedId: string) => Promise<unknown>;
      updateSavedNote: (savedId: string, note: string) => Promise<unknown>;
      setFeedRetention: (days: number) => Promise<{ days: number; pruned: number }>;
      addFriend: (input: unknown) => Promise<unknown>;
      setFriendVisibility: (
        friendId: string,
        visibility: FriendVisibility
      ) => Promise<FriendConnection | undefined>;
      deleteFriend: (friendId: string) => Promise<unknown>;
      setModeration: (siteUrl: string, action: ModerationAction | null) => Promise<ModerationEntry[]>;
      updateWebring: (ringId: string, updates: unknown) => Promise<unknown>;
      deleteWebring: (ringId: string) => Promise<unknown>;
      crawlFriend: (siteUrl: string, localDirOverride?: string) => Promise<CrawlSiteResult>;
      crawlAllFriends: () => Promise<CrawlSiteResult[]>;
      requestToJoinRing: (
        hubUrl: string
      ) => Promise<{ ring: JoinedRing; requestLink: string; warning?: string }>;
      reviewRingRequest: (link: string) => Promise<RingRequestReview>;
      decideRingRequest: (
        link: string,
        decision: 'approve' | 'decline' | 'ban',
        reason?: string
      ) => Promise<RingRequestReview>;
      syncRings: () => Promise<{
        joined: Array<{ name: string; outcome: string; warning?: string }>;
        hosted: Array<{ name: string; autoRemoved: string[]; failing: string[]; confirmed: string[] }>;
      }>;
      createHostedRing: (input: { name: string; description?: string }) => Promise<HostedRing>;
      updateHostedRing: (
        ringId: string,
        updates: { name?: string; description?: string; maintainerIsMember?: boolean; status?: 'active' | 'closed' }
      ) => Promise<HostedRing>;
      updateRingMember: (
        ringId: string,
        siteUrl: string,
        change: { action: RingMemberAction; reason?: string }
      ) => Promise<HostedRing>;
      onRingRequestLink?: (cb: (link: string) => void) => () => void;
      getSchedule: () => Promise<ScheduleOverview>;
      setSchedule: (
        change:
          | { personaId: string; sync?: Partial<ScheduleJob>; publish?: Partial<PersonaScheduleView['schedule']['publish']> }
          | { app: Partial<ScheduleOverview['app']> }
      ) => Promise<ScheduleOverview>;
      runJobNow: (
        personaId: string,
        job: 'sync' | 'publish'
      ) => Promise<{ result: ScheduleJobResult; overview: ScheduleOverview }>;
      onScheduleUpdated?: (cb: () => void) => () => void;
      chooseExportFolder: () => Promise<string | null>;
      exportLocal: (targetDir?: string) => Promise<{
        success: boolean;
        destination: string;
        filesPublished: number;
        message: string;
      }>;
      testExportPreview: (openInBrowser?: boolean) => Promise<TestExportPreviewState>;
      openExternal: (url: string) => Promise<unknown>;
      publishRemote: (settings: unknown) => Promise<{
        success: boolean;
        destination: string;
        filesPublished: number;
        message: string;
      }>;
      publishGithub: (settings: unknown) => Promise<{
        success: boolean;
        destination: string;
        filesPublished: number;
        message: string;
      }>;
      checkGithubRepo: (settings: unknown) => Promise<{
        success: boolean;
        defaultBranch?: string;
        branchExists?: boolean;
        canPush?: boolean;
        pagesEnabled?: boolean;
        pagesUrl?: string;
        message: string;
      }>;
      openPath: (targetPath: string) => Promise<unknown>;
      getMcpInfo?: () => Promise<{
        status: {
          running: boolean;
          port: number;
          endpointUrl: string;
          sseUrl: string;
          authorizedEndpointUrl?: string;
          authorizedSseUrl?: string;
          toolCount: number;
          resourceCount: number;
          promptCount: number;
        };
        cliScriptPath: string;
        userDataDir: string;
        tools: Array<{
          name: string;
          description: string;
          inputSchema: Record<string, unknown>;
        }>;
        resources: Array<{
          uri: string;
          name: string;
          description: string;
          mimeType: string;
        }>;
        prompts: Array<{
          name: string;
          description: string;
        }>;
        activityLog: Array<{
          id: string;
          timestamp: string;
          method: string;
          toolName?: string;
          personaId: string;
          summary: string;
          success: boolean;
        }>;
      }>;
      callMcpTool?: (
        toolName: string,
        args?: Record<string, unknown>
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
        data?: unknown;
      }>;
      onMcpActivity?: (cb: (entry: unknown) => void) => () => void;
      onDeepLink: (cb: (action: WebringDeepLinkAction) => void) => () => void;
    };
  }
}

type StudioTab =
  | 'profile'
  | 'albums'
  | 'items'
  | 'friends'
  | 'feed'
  | 'preview'
  | 'schemas'
  | 'publish'
  | 'mcp'
  | 'help';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<StudioTab>('profile');
  const [helpSection, setHelpSection] = useState<
    | 'quickstart'
    | 'github-pages'
    | 'ftp-sftp'
    | 'addons'
    | 'mcp-agents'
    | 'privacy-faq'
    | 'webrings'
  >('quickstart');
  const [bundle, setBundle] = useState<CompleteSiteBundle | null>(null);
  const [allFriends, setAllFriends] = useState<FriendConnection[]>([]);
  const [allEndorsements, setAllEndorsements] = useState<EndorsementItem[]>([]);
  const [networkFeed, setNetworkFeed] = useState<NetworkFeedEntry[]>([]);
  const [savedPosts, setSavedPosts] = useState<SavedPostView[]>([]);
  const [feedRetentionDays, setFeedRetentionDays] = useState(90);
  const [feedScope, setFeedScopeState] = useState<FeedScope>(loadFeedScope);
  const setFeedScope = (scope: FeedScope) => {
    setFeedScopeState(scope);
    try {
      window.localStorage.setItem(FEED_SCOPE_KEY, scope);
    } catch {
      // Not remembered this time; the default still works
    }
  };
  const [feedExclusions, setFeedExclusions] = useState<FeedExclusions>({
    muted: 0,
    blocked: 0,
    unverified: 0,
  });
  const [moderation, setModeration] = useState<ModerationEntry[]>([]);
  const [changesSinceLastPublish, setChangesSinceLastPublish] = useState(0);
  const [isSyncingFriends, setIsSyncingFriends] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Multi-Persona compartmentalization state
  const [activePersonaId, setActivePersonaId] = useState<string>('default');
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [showPersonaModal, setShowPersonaModal] = useState(false);
  const [newPersonaLabel, setNewPersonaLabel] = useState('');
  const [newPersonaDisplayName, setNewPersonaDisplayName] = useState('');
  const [newPersonaSiteUrl, setNewPersonaSiteUrl] = useState('');
  const [newPersonaTagline, setNewPersonaTagline] = useState('');
  const [newPersonaTheme, setNewPersonaTheme] = useState<ProfileTheme>('cyber-terminal');
  const [editingPersonaId, setEditingPersonaId] = useState<string | null>(null);
  const [editingPersonaLabel, setEditingPersonaLabel] = useState('');

  // Profile form state
  const [siteUrl, setSiteUrl] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tagline, setTagline] = useState('');
  const [bio, setBio] = useState('');
  const [location, setLocation] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [interestsInput, setInterestsInput] = useState('');
  const [theme, setTheme] = useState<ProfileTheme>('neo-webring');
  const [previewHtml, setPreviewHtml] = useState('');
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const [atprotoHandle, setAtprotoHandle] = useState('');
  const [customLinks, setCustomLinks] = useState<Array<{ label: string; url: string }>>([]);

  // Publish settings state
  const [publishSettings, setPublishSettings] = useState<PublishSettingsState>({
    exportPath: '',
    protocol: 'sftp',
    host: '',
    port: 22,
    username: '',
    password: '',
    remotePath: '/var/www/html',
    atprotoPdsUrl: 'https://bsky.social',
    publishFriendsList: false,
    stripRelationshipTags: true,
    publishEndorsements: false,
    redactItemSourceAuthors: false,
    commentProvider: 'none',
    giscusRepo: '',
    giscusRepoId: '',
    giscusCategory: 'General',
    giscusCategoryId: '',
    analyticsEnabled: false,
    analyticsMeasurementId: '',
    analyticsRespectDnt: true,
    analyticsAnonymizeIp: true,
    analyticsTrackRingInteractions: true,
    adsEnabled: false,
    adsPublisherId: '',
    adsEnableAutoAds: true,
    adsGenerateAdsTxt: true,
    adsHeaderSlotId: '',
    adsInFeedSlotId: '',
    adsFooterSlotId: '',
    githubOwner: '',
    githubRepo: '',
    githubBranch: 'gh-pages',
    githubToken: '',
    githubCustomDomain: '',
  });

  // New Album / Photo state
  const [newAlbumTitle, setNewAlbumTitle] = useState('');
  const [newAlbumDesc, setNewAlbumDesc] = useState('');
  const [newAlbumTags, setNewAlbumTags] = useState('');
  const [selectedAlbumId, setSelectedAlbumId] = useState('');
  const [newPhotoUrl, setNewPhotoUrl] = useState('');
  const [newPhotoCaption, setNewPhotoCaption] = useState('');
  const [newPhotoTags, setNewPhotoTags] = useState('');
  const [mediaUsage, setMediaUsage] = useState<{ files: number; bytes: number } | null>(null);
  const [isImportingPhotos, setIsImportingPhotos] = useState(false);
  const [isDraggingPhotos, setIsDraggingPhotos] = useState(false);
  const [albumDraft, setAlbumDraft] = useState<{ title: string; description: string; tags: string } | null>(null);
  const [photoDrafts, setPhotoDrafts] = useState<Record<string, { caption: string; altText: string }>>({});

  // New Item (Wall Post / Like / Share / Recommendation / Comment) state
  const [itemType, setItemType] = useState<SharedItemType>('post');
  const [itemTitle, setItemTitle] = useState('');
  const [itemTargetUrl, setItemTargetUrl] = useState('');
  const [itemAuthorName, setItemAuthorName] = useState('');
  const [itemAuthorUrl, setItemAuthorUrl] = useState('');
  const [itemCategory, setItemCategory] = useState('status');
  const [itemCommentary, setItemCommentary] = useState('');
  const [itemMediaUrl, setItemMediaUrl] = useState('');
  const [itemRating, setItemRating] = useState<number>(5);
  const [itemTags, setItemTags] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

  // New Friend & Webring state
  const [friendSiteUrl, setFriendSiteUrl] = useState('');
  const [friendName, setFriendName] = useState('');
  const [friendAvatar, setFriendAvatar] = useState('');
  const [friendBio, setFriendBio] = useState('');
  const [friendRel, setFriendRel] = useState('friend, met');
  const [friendVisibility, setFriendVisibility] = useState<FriendVisibility>('private');

  const [ringHubUrl, setRingHubUrl] = useState('');
  const [isJoiningRing, setIsJoiningRing] = useState(false);
  const [lastRequestLink, setLastRequestLink] = useState<{ ringName: string; link: string } | null>(null);
  const [joinedRings, setJoinedRings] = useState<JoinedRing[]>([]);
  const [hostedRings, setHostedRings] = useState<HostedRing[]>([]);
  const [newHostedRingName, setNewHostedRingName] = useState('');
  const [newHostedRingDesc, setNewHostedRingDesc] = useState('');
  const [ringRequestLink, setRingRequestLink] = useState('');
  const [ringRequestReview, setRingRequestReview] = useState<RingRequestReview | null>(null);
  const [ringRequestError, setRingRequestError] = useState<string | null>(null);
  const [scheduleOverview, setScheduleOverview] = useState<ScheduleOverview | null>(null);
  const [runningJob, setRunningJob] = useState<'sync' | 'publish' | null>(null);
  const [publishedUpToDate, setPublishedUpToDate] = useState(false);

  // Editing an already-joined webring's name/description/neighbors
  const [editingRingId, setEditingRingId] = useState<string | null>(null);
  const [editRingDraft, setEditRingDraft] = useState<{
    name: string;
    hubUrl: string;
    description: string;
    prevSiteUrl: string;
    nextSiteUrl: string;
  }>({ name: '', hubUrl: '', description: '', prevSiteUrl: '', nextSiteUrl: '' });

  // Schema Inspector state
  const [selectedSchemaFile, setSelectedSchemaFile] = useState<
    'manifest' | 'did' | 'profile' | 'albums' | 'items' | 'connections'
  >('manifest');

  // GitHub Pages Deploy state
  const [githubCheckResult, setGithubCheckResult] = useState<{
    success: boolean;
    defaultBranch?: string;
    branchExists?: boolean;
    canPush?: boolean;
    pagesEnabled?: boolean;
    pagesUrl?: string;
    message: string;
  } | null>(null);
  const [githubChecking, setGithubChecking] = useState(false);
  const [githubDeploying, setGithubDeploying] = useState(false);

  // Local Test Export & Live HTTP Server Preview state
  const [testExportResult, setTestExportResult] = useState<TestExportPreviewState | null>(null);
  const [previewRenderMode, setPreviewRenderMode] = useState<'studio' | 'exported-http'>('studio');
  const [iframeRefreshKey, setIframeRefreshKey] = useState<number>(0);

  // MCP Agent Hub state
  const [mcpInfo, setMcpInfo] = useState<{
    status: {
      running: boolean;
      port: number;
      endpointUrl: string;
      sseUrl: string;
      authorizedEndpointUrl?: string;
      authorizedSseUrl?: string;
      toolCount: number;
      resourceCount: number;
      promptCount: number;
    };
    cliScriptPath: string;
    userDataDir: string;
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    resources: Array<{ uri: string; name: string; description: string; mimeType: string }>;
    prompts: Array<{ name: string; description: string }>;
    activityLog: Array<{
      id: string;
      timestamp: string;
      method: string;
      toolName?: string;
      personaId: string;
      summary: string;
      success: boolean;
    }>;
  } | null>(null);
  const [selectedMcpTool, setSelectedMcpTool] = useState<string>('webring_list_personas');
  const [mcpToolArgsJson, setMcpToolArgsJson] = useState<string>('{}');
  const [mcpToolOutput, setMcpToolOutput] = useState<string>('');

  const notify = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => {
      setStatusMessage((prev) => (prev === msg ? null : prev));
    }, 5000);
  };

  const refreshStudioData = async () => {
    if (!window.studioApi) return;
    const data = await window.studioApi.getBundle();
    if (data.activePersonaId) {
      setActivePersonaId(data.activePersonaId);
    }
    if (data.personas) {
      setPersonas(data.personas);
    }
    setBundle(data.bundle);
    setAllFriends(data.allFriends || []);
    setAllEndorsements(data.allEndorsements || []);
    setNetworkFeed(data.networkFeed || []);
    setSavedPosts(data.savedPosts || []);
    if (typeof data.feedRetentionDays === 'number') setFeedRetentionDays(data.feedRetentionDays);
    setFeedExclusions(data.feedExclusions || { muted: 0, blocked: 0, unverified: 0 });
    setModeration(data.moderation || []);
    setChangesSinceLastPublish(data.changesSinceLastPublish || 0);
    setJoinedRings(data.joinedRings || []);
    setHostedRings(data.hostedRings || []);
    setPublishedUpToDate(Boolean(data.publishedUpToDate));
    if (window.studioApi.getSchedule) {
      window.studioApi.getSchedule().then(setScheduleOverview).catch(() => undefined);
    }

    const p = data.profileWithSettings;
    setSiteUrl(p.siteUrl);
    setHandle(p.handle);
    setDisplayName(p.displayName);
    setTagline(p.tagline);
    setBio(p.bio);
    setLocation(p.location);
    setAvatarUrl(p.avatarUrl);
    setBannerUrl(p.bannerUrl);
    setInterestsInput((p.interests || []).join(', '));
    setTheme(p.theme);
    setPreviewHtml(data.previewHtml || '');
    setAtprotoHandle(p.atprotoHandle || '');
    setCustomLinks((p.customLinks || []).map((l) => ({ label: l.label, url: l.url })));
    if (p.publishSettings) {
      // Required fields always come from the profile; these defaults cover the optional ones
      setPublishSettings({
        password: '',
        atprotoPdsUrl: 'https://bsky.social',
        publishFriendsList: false,
        stripRelationshipTags: true,
        publishEndorsements: false,
        redactItemSourceAuthors: false,
        analyticsEnabled: false,
        analyticsMeasurementId: '',
        analyticsRespectDnt: true,
        analyticsAnonymizeIp: true,
        analyticsTrackRingInteractions: true,
        adsEnabled: false,
        adsPublisherId: '',
        adsEnableAutoAds: true,
        adsGenerateAdsTxt: true,
        adsHeaderSlotId: '',
        adsInFeedSlotId: '',
        adsFooterSlotId: '',
        githubOwner: '',
        githubRepo: '',
        githubBranch: 'gh-pages',
        githubToken: '',
        githubCustomDomain: '',
        ...p.publishSettings,
      });
    }
    if (data.bundle.albums.albums.length > 0) {
      const currentExists = data.bundle.albums.albums.some((a) => a.id === selectedAlbumId);
      if (!currentExists) {
        setSelectedAlbumId(data.bundle.albums.albums[0].id);
      }
    } else {
      setSelectedAlbumId('');
    }
  };

  const handleSwitchPersona = async (personaId: string) => {
    if (!window.studioApi || personaId === activePersonaId) return;
    await window.studioApi.switchPersona(personaId);
    setSelectedAlbumId('');
    setTestExportResult(null);
    setPreviewRenderMode('studio');
    await refreshStudioData();
    const target = personas.find((p) => p.id === personaId);
    notify(
      `Switched to persona "${target?.label || personaId}" — loaded isolated SQLite DB & Ed25519 keypair!`
    );
  };

  const handleCreatePersona = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.studioApi || !newPersonaLabel.trim() || !newPersonaDisplayName.trim()) return;
    const res = await window.studioApi.createPersona({
      label: newPersonaLabel.trim(),
      displayName: newPersonaDisplayName.trim(),
      siteUrl: newPersonaSiteUrl.trim() || undefined,
      tagline: newPersonaTagline.trim() || undefined,
      theme: newPersonaTheme,
    });
    setNewPersonaLabel('');
    setNewPersonaDisplayName('');
    setNewPersonaSiteUrl('');
    setNewPersonaTagline('');
    setSelectedAlbumId('');
    setShowPersonaModal(false);
    await refreshStudioData();
    notify(
      `Created compartmentalized persona "${res.created.label}" (${res.created.did}) with its own SQLite DB and Ed25519 keypair!`
    );
  };

  const handleRenamePersona = async (personaId: string) => {
    if (!window.studioApi || !editingPersonaLabel.trim()) return;
    await window.studioApi.updatePersonaLabel(personaId, editingPersonaLabel.trim());
    setEditingPersonaId(null);
    setEditingPersonaLabel('');
    await refreshStudioData();
    notify('Updated persona studio label!');
  };

  const handleDeletePersona = async (personaId: string, label: string) => {
    if (!window.studioApi || personaId === 'default') return;
    const confirmed = window.confirm(
      `Delete persona "${label}" and its local SQLite database? (Exported site folders are not deleted.)`
    );
    if (!confirmed) return;
    await window.studioApi.deletePersona(personaId, true);
    setSelectedAlbumId('');
    await refreshStudioData();
    notify(`Deleted persona "${label}".`);
  };

  // The site preview runs sandboxed; its links arrive here instead of navigating the preview
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!previewFrameRef.current || event.source !== previewFrameRef.current.contentWindow) return;
      const data = event.data as { type?: string; href?: string } | null;
      if (!data || typeof data.href !== 'string') return;
      if (data.type === 'webring-preview-deeplink') {
        const parsed = parseWebringUri(data.href);
        if (parsed) handleIncomingDeepLink(parsed);
      } else if (data.type === 'webring-preview-open' && /^https?:/i.test(data.href)) {
        window.studioApi?.openExternal(data.href);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });

  useEffect(() => {
    refreshStudioData();
    if (window.studioApi?.getMcpInfo) {
      window.studioApi.getMcpInfo().then((info) => setMcpInfo(info));
    }
    const cleanups: Array<() => void> = [];
    if (window.studioApi) {
      cleanups.push(
        window.studioApi.onDeepLink((action) => {
          handleIncomingDeepLink(action);
        })
      );
      if (window.studioApi.onScheduleUpdated) {
        // A scheduled job finished (maybe for this persona): refresh what's on screen
        cleanups.push(window.studioApi.onScheduleUpdated(() => refreshStudioData()));
      }
      if (window.studioApi.onRingRequestLink) {
        cleanups.push(
          window.studioApi.onRingRequestLink((link) => {
            // Opens the review screen only; approving still needs a click
            setActiveTab('friends');
            handleReviewRingRequest(link);
          })
        );
      }
      if (window.studioApi.onMcpActivity) {
        cleanups.push(
          window.studioApi.onMcpActivity(() => {
            refreshStudioData();
            window.studioApi?.getMcpInfo?.().then((info) => setMcpInfo(info));
          })
        );
      }
    }
    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, []);

  const handleIncomingDeepLink = (action: WebringDeepLinkAction) => {
    if (action.action === 'friend') {
      setFriendSiteUrl(action.targetUrl);
      setFriendName(action.title || action.authorName || 'New Ring Friend');
      setFriendAvatar(action.mediaUrl || '');
      setActiveTab('friends');
      notify(`Deep Link: Pre-filled friend "${action.title || action.targetUrl}"`);
    } else if (action.action === 'join-ring') {
      // Only pre-fills the join form; nothing is requested until the user clicks
      setRingHubUrl(action.targetUrl);
      setActiveTab('friends');
      notify(`Deep Link: Ready to join webring "${action.title || action.targetUrl}". Review it, then click Request to Join.`);
    } else {
      const mappedType: SharedItemType =
        action.action === 'like'
          ? 'like'
          : action.action === 'comment'
          ? 'comment'
          : 'share';
      setItemType(mappedType);
      setItemTargetUrl(action.targetUrl);
      setItemTitle(
        action.action === 'comment'
          ? `Re: ${action.title || 'Post'}`
          : action.title || 'Shared via Webring'
      );
      setItemAuthorUrl(action.authorUrl || '');
      setItemAuthorName(action.authorName || '');
      setItemMediaUrl(action.action === 'comment' ? '' : action.mediaUrl || '');
      setItemCategory(action.action === 'comment' ? 'comment' : action.category || 'general');
      setActiveTab('items');
      notify(
        `webring:// Deep Link intercepted! Ready to ${action.action.toUpperCase()} "${
          action.title || action.targetUrl
        }"`
      );
    }
  };

  // Uploads are saved on the profile immediately; only this field changes, so other unsaved
  // edits in the form stay as they are
  const handleUploadProfileImage = async (kind: 'avatar' | 'banner', filePath?: string) => {
    if (!window.studioApi) return;
    try {
      const result = await window.studioApi.setProfileImage(kind, filePath);
      if (!result) return;
      if (kind === 'avatar') setAvatarUrl(result.url);
      else setBannerUrl(result.url);
      setBundle((prev) => (prev ? { ...prev, profile: { ...prev.profile, [kind === 'avatar' ? 'avatarUrl' : 'bannerUrl']: result.url } } : prev));
      notify(kind === 'avatar' ? 'Profile photo uploaded and saved.' : 'Banner image uploaded and saved.');
    } catch (err) {
      notify(`Couldn't use that image: ${err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)}`);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.studioApi) return;
    await window.studioApi.updateProfile({
      siteUrl,
      handle,
      displayName,
      tagline,
      bio,
      location,
      avatarUrl,
      bannerUrl,
      interests: interestsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      theme,
      atprotoHandle,
      customLinks: customLinks
        .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
        .filter((l) => l.label && l.url),
      publishSettings,
    });
    await refreshStudioData();
    notify('Profile & DID identity updated and re-signed with Ed25519 keypair!');
  };

  const handleCreateAlbum = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAlbumTitle.trim() || !window.studioApi) return;
    const created = (await window.studioApi.createAlbum({
      title: newAlbumTitle.trim(),
      description: newAlbumDesc.trim(),
      tags: newAlbumTags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    })) as { id: string };
    setNewAlbumTitle('');
    setNewAlbumDesc('');
    setNewAlbumTags('');
    setSelectedAlbumId(created.id);
    await refreshStudioData();
    notify(`Created photo album "${newAlbumTitle}"`);
  };

  const handleAddPhoto = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAlbumId || !newPhotoUrl.trim() || !window.studioApi) return;
    await window.studioApi.addPhoto({
      albumId: selectedAlbumId,
      url: newPhotoUrl.trim(),
      thumbUrl: newPhotoUrl.trim(),
      caption: newPhotoCaption.trim(),
      tags: newPhotoTags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setNewPhotoUrl('');
    setNewPhotoCaption('');
    setNewPhotoTags('');
    await refreshStudioData();
    notify('Added photo and indexed canonical URI in albums.json!');
  };

  const refreshMediaUsage = async () => {
    if (!window.studioApi?.getMediaUsage) return;
    setMediaUsage(await window.studioApi.getMediaUsage());
  };

  const handleImportPhotos = async (filePaths?: string[]) => {
    if (!selectedAlbumId || !window.studioApi || isImportingPhotos) return;
    setIsImportingPhotos(true);
    notify('Importing photos...');
    try {
      const report = await window.studioApi.importPhotos(selectedAlbumId, filePaths);
      await refreshStudioData();
      await refreshMediaUsage();
      if (report.added.length || report.failed.length) {
        notify(
          `Added ${report.added.length} photo(s).` +
            (report.failed.length
              ? ` Couldn't import ${report.failed.map((f) => `${f.file} (${f.error})`).join(', ')}`
              : '')
        );
      }
    } finally {
      setIsImportingPhotos(false);
    }
  };

  const handleDropPhotos = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingPhotos(false);
    if (!window.studioApi) return;
    const paths = Array.from(e.dataTransfer.files)
      .map((file) => window.studioApi!.getPathForFile(file))
      .filter((p) => /\.(jpe?g|png)$/i.test(p));
    if (paths.length === 0) {
      notify('Drop JPEG or PNG photos.');
      return;
    }
    await handleImportPhotos(paths);
  };

  const handleSavePhotoDetails = async (photoId: string) => {
    const draft = photoDrafts[photoId];
    if (!draft || !window.studioApi) return;
    await window.studioApi.updatePhoto(photoId, { caption: draft.caption, altText: draft.altText });
    setPhotoDrafts((prev) => {
      const next = { ...prev };
      delete next[photoId];
      return next;
    });
    await refreshStudioData();
  };

  const handlePhotoAction = async (
    photo: { id: string; caption: string; thumbUrl: string },
    action: 'up' | 'down' | 'cover' | 'replace' | 'delete'
  ) => {
    if (!window.studioApi) return;
    if (action === 'up' || action === 'down') await window.studioApi.movePhoto(photo.id, action);
    if (action === 'cover' && selectedAlbumId) {
      await window.studioApi.updateAlbum(selectedAlbumId, { coverUrl: photo.thumbUrl });
      notify('Set as album cover.');
    }
    if (action === 'replace') {
      const res = await window.studioApi.replacePhoto(photo.id);
      if (res.replaced) notify('Photo replaced. It goes live at your next publish.');
    }
    if (action === 'delete') {
      if (!window.confirm(`Delete this photo${photo.caption ? ` ("${photo.caption}")` : ''}? It's removed from your site at the next publish.`)) {
        return;
      }
      await window.studioApi.deletePhoto(photo.id);
    }
    await refreshStudioData();
    await refreshMediaUsage();
  };

  const handleSaveAlbum = async () => {
    if (!albumDraft || !selectedAlbumId || !window.studioApi) return;
    await window.studioApi.updateAlbum(selectedAlbumId, {
      title: albumDraft.title.trim(),
      description: albumDraft.description.trim(),
      tags: albumDraft.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setAlbumDraft(null);
    await refreshStudioData();
    notify('Album saved.');
  };

  const handleDeleteAlbum = async (album: { id: string; title: string; photos: unknown[] }) => {
    if (!window.studioApi) return;
    if (
      !window.confirm(
        `Delete the album "${album.title}" and its ${album.photos.length} photo(s)? They're removed from your site at the next publish.`
      )
    ) {
      return;
    }
    await window.studioApi.deleteAlbum(album.id);
    setSelectedAlbumId('');
    await refreshStudioData();
    await refreshMediaUsage();
  };

  const handleForgetPublishHistory = async () => {
    if (!window.studioApi) return;
    if (
      !window.confirm(
        'Forget what Studio has published? The next publish to each destination re-uploads every file. Use this if files on your server or repo were changed or deleted by hand.'
      )
    ) {
      return;
    }
    await window.studioApi.forgetPublishHistory();
    notify('Publish history cleared. The next publish uploads everything.');
  };

  const handlePickLocalPostImage = async () => {
    if (!window.studioApi) return;
    const imported = await window.studioApi.importImage();
    if (imported) {
      setItemMediaUrl(imported.url);
      notify(`Attached ${imported.fileName} to your post (resized, location data removed).`);
    }
  };

  const handleSaveItemEdit = async (item: SharedItem, edit: ItemEdit) => {
    if (!window.studioApi) return;
    await window.studioApi.updateItem(item.id, edit);
    setEditingItemId(null);
    await refreshStudioData();
    notify(item.type === 'post' ? 'Wall Post updated. Publish to put the change on your site.' : 'Item updated. Publish to put the change on your site.');
  };

  const handleDeleteItem = async (item: SharedItem) => {
    if (!window.studioApi) return;
    const what = item.type === 'post' ? 'Wall Post' : item.type;
    if (!window.confirm(`Delete this ${what} ("${item.title}")? It's removed from your site at the next publish.`)) return;
    await window.studioApi.deleteItem(item.id);
    if (editingItemId === item.id) setEditingItemId(null);
    await refreshStudioData();
  };

  const handleCreateItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.studioApi) return;
    if (itemType === 'post') {
      if (!itemCommentary.trim() && !itemTitle.trim()) return;
    } else if (itemType === 'comment') {
      if (!itemTargetUrl.trim() || !itemCommentary.trim()) return;
    } else {
      if (!itemTitle.trim() || !itemTargetUrl.trim()) return;
    }

    await window.studioApi.createItem({
      type: itemType,
      title: itemTitle.trim(),
      targetUrl: itemTargetUrl.trim(),
      targetAuthorName: itemAuthorName.trim(),
      targetAuthorUrl: itemAuthorUrl.trim(),
      category: itemCategory,
      commentary: itemCommentary.trim(),
      mediaUrl: itemMediaUrl.trim(),
      rating: itemType === 'post' || itemType === 'comment' ? undefined : itemRating,
      tags: itemTags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setItemTitle('');
    setItemTargetUrl('');
    setItemAuthorName('');
    setItemAuthorUrl('');
    setItemCommentary('');
    setItemMediaUrl('');
    setItemTags('');
    await refreshStudioData();
    notify(
      itemType === 'post'
        ? 'Published new Wall Post to your profile & items.json!'
        : itemType === 'comment'
        ? 'Published signed Comment to your items.json (friends will see it under the post when synced)!'
        : `Indexed new ${itemType.toUpperCase()} item in items.json!`
    );
  };

  const handleAddFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!friendSiteUrl.trim() || !friendName.trim() || !window.studioApi) return;
    await window.studioApi.addFriend({
      siteUrl: friendSiteUrl.trim(),
      displayName: friendName.trim(),
      avatarUrl: friendAvatar.trim(),
      bio: friendBio.trim(),
      relationship: friendRel
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      visibility: friendVisibility,
    });
    if (friendVisibility === 'public' && !publishSettings.publishFriendsList) {
      const nextSettings = { ...publishSettings, publishFriendsList: true };
      setPublishSettings(nextSettings);
      await window.studioApi.updateProfile({ publishSettings: nextSettings });
    }
    setFriendSiteUrl('');
    setFriendName('');
    setFriendAvatar('');
    setFriendBio('');
    setFriendVisibility('private');
    await refreshStudioData();
    notify(
      friendVisibility === 'private'
        ? `Added ${friendName} as Private (Local Crawler Only — hidden from public connections.json)!`
        : `Added ${friendName} as Public (exported to connections.json)!`
    );
  };

  const handleUpdatePrivacySetting = async (patch: Partial<PublishSettingsState>) => {
    if (!window.studioApi) return;
    const nextSettings = { ...publishSettings, ...patch };
    setPublishSettings(nextSettings);
    await window.studioApi.updateProfile({ publishSettings: nextSettings });
    await refreshStudioData();
    notify('Updated social graph privacy policy and re-signed static JSON bundle!');
  };

  const errorMessage = (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  const handleRequestToJoinRing = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ringHubUrl.trim() || !window.studioApi || isJoiningRing) return;
    setIsJoiningRing(true);
    try {
      const res = await window.studioApi.requestToJoinRing(ringHubUrl.trim());
      setLastRequestLink({ ringName: res.ring.name, link: res.requestLink });
      setRingHubUrl('');
      await refreshStudioData();
      notify(
        res.ring.status === 'member'
          ? `You're already a member of "${res.ring.name}".`
          : `Request ready for "${res.ring.name}". Publish your site, then send the maintainer the link.`
      );
    } catch (err) {
      notify(`Couldn't join: ${errorMessage(err)}`);
    } finally {
      setIsJoiningRing(false);
    }
  };

  const handleReviewRingRequest = async (link = ringRequestLink) => {
    if (!window.studioApi || !link.trim()) return;
    setRingRequestLink(link);
    setRingRequestError(null);
    setRingRequestReview(null);
    try {
      setRingRequestReview(await window.studioApi.reviewRingRequest(link.trim()));
    } catch (err) {
      setRingRequestError(errorMessage(err));
    }
  };

  const handleDecideRingRequest = async (decision: 'approve' | 'decline' | 'ban') => {
    if (!window.studioApi || !ringRequestReview) return;
    let reason: string | undefined;
    if (decision === 'ban') {
      const answer = window.prompt(
        `Ban ${ringRequestReview.applicant.siteUrl} from "${ringRequestReview.ring.name}"? Optional private note:`,
        ''
      );
      if (answer === null) return;
      reason = answer;
    }
    try {
      await window.studioApi.decideRingRequest(ringRequestLink.trim(), decision, reason);
      setRingRequestReview(null);
      setRingRequestLink('');
      await refreshStudioData();
      notify(
        decision === 'approve'
          ? `Approved ${ringRequestReview.applicant.displayName}. Publish your site to make it live.`
          : decision === 'ban'
          ? `Banned ${ringRequestReview.applicant.siteUrl}.`
          : `Declined ${ringRequestReview.applicant.displayName}'s request.`
      );
    } catch (err) {
      setRingRequestError(errorMessage(err));
    }
  };

  const handleCreateHostedRing = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.studioApi || !newHostedRingName.trim()) return;
    const ring = await window.studioApi.createHostedRing({
      name: newHostedRingName.trim(),
      description: newHostedRingDesc.trim(),
    });
    setNewHostedRingName('');
    setNewHostedRingDesc('');
    await refreshStudioData();
    notify(`Created "${ring.name}". Publish your site to put its hub online.`);
  };

  const handleUpdateHostedRing = async (
    ring: HostedRing,
    updates: { maintainerIsMember?: boolean; status?: 'active' | 'closed' }
  ) => {
    if (!window.studioApi) return;
    if (
      updates.status === 'closed' &&
      !window.confirm(
        `Close "${ring.name}"? Members' Studios will drop it on their next sync after you publish. You can reopen it later.`
      )
    ) {
      return;
    }
    await window.studioApi.updateHostedRing(ring.id, updates);
    await refreshStudioData();
    notify(`Updated "${ring.name}". Publish to make it live.`);
  };

  const handleRingMemberAction = async (ring: HostedRing, member: { siteUrl: string; displayName: string }, action: RingMemberAction) => {
    if (!window.studioApi) return;
    let reason: string | undefined;
    if (action === 'remove' && !window.confirm(`Remove ${member.displayName} from "${ring.name}"? They can ask to join again.`)) {
      return;
    }
    if (action === 'ban') {
      const answer = window.prompt(`Ban ${member.siteUrl} from "${ring.name}"? Optional private note:`, '');
      if (answer === null) return;
      reason = answer;
    }
    await window.studioApi.updateRingMember(ring.id, member.siteUrl, { action, reason });
    await refreshStudioData();
  };

  const handleStartEditWebring = (ring: WebringMembership) => {
    setEditingRingId(ring.id);
    setEditRingDraft({
      name: ring.name,
      hubUrl: ring.hubUrl,
      description: ring.description || '',
      prevSiteUrl: ring.prevSiteUrl || '',
      nextSiteUrl: ring.nextSiteUrl || '',
    });
  };

  const handleCancelEditWebring = () => {
    setEditingRingId(null);
  };

  const handleSaveEditWebring = async () => {
    if (!editingRingId || !window.studioApi) return;
    await window.studioApi.updateWebring(editingRingId, {
      name: editRingDraft.name.trim(),
      hubUrl: editRingDraft.hubUrl.trim(),
      description: editRingDraft.description.trim(),
      prevSiteUrl: editRingDraft.prevSiteUrl.trim(),
      nextSiteUrl: editRingDraft.nextSiteUrl.trim(),
    });
    setEditingRingId(null);
    await refreshStudioData();
    notify(`Updated Webring "${editRingDraft.name.trim()}"!`);
  };

  const handleDeleteWebring = async (ring: WebringMembership) => {
    if (!window.studioApi) return;
    const confirmed = window.confirm(
      `Leave "${ring.name}"? Its bar disappears from your site at your next publish, and the maintainer's Studio removes you on its next sync.`
    );
    if (!confirmed) return;
    await window.studioApi.deleteWebring(ring.id);
    if (editingRingId === ring.id) setEditingRingId(null);
    await refreshStudioData();
    notify(`Left Webring "${ring.name}".`);
  };

  const handleSyncAllFriends = async () => {
    if (!window.studioApi || isSyncingFriends) return;
    if (allFriends.length === 0 && joinedRings.length === 0 && hostedRings.length === 0) {
      notify('Nothing to sync yet. Add a friend or join a ring in Friends & Webrings.');
      return;
    }
    setIsSyncingFriends(true);
    notify(`Syncing ${allFriends.length} friend site(s) and your rings...`);
    try {
      const results = await window.studioApi.crawlAllFriends();
      const rings = await window.studioApi.syncRings();
      await refreshStudioData();
      const ok = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success && !r.blocked).length;
      const blocked = results.filter((r) => r.blocked).length;
      const keyChanged = results.filter((r) => r.keyChangedWarning).length;
      const rejected = results.reduce((acc, r) => acc + (r.entriesRejected || 0), 0);
      const parts = [`${ok} synced`];
      if (failed) parts.push(`${failed} failed`);
      if (blocked) parts.push(`${blocked} blocked (skipped)`);
      if (keyChanged) parts.push(`${keyChanged} key changed`);
      if (rejected) parts.push(`${rejected} spoofed entries rejected`);
      const newMember = rings.joined.filter((r) => r.outcome === 'member').length;
      const removedFrom = rings.joined.filter((r) => r.outcome === 'removed' || r.outcome === 'closed');
      const leavers = rings.hosted.reduce((acc, r) => acc + r.autoRemoved.length, 0);
      if (newMember) parts.push(`${newMember} ring(s) current`);
      if (removedFrom.length) parts.push(`no longer in ${removedFrom.map((r) => `"${r.name}"`).join(', ')}`);
      if (leavers) parts.push(`${leavers} member(s) left your rings`);
      notify(`Sync: ${parts.join(', ')}.`);
    } finally {
      setIsSyncingFriends(false);
    }
  };

  const moderationFor = (siteUrl: string): ModerationAction | undefined =>
    moderation.find((m) => m.siteUrl === siteUrl.replace(/\/+$/, ''))?.action;

  const handleSetModeration = async (
    siteUrl: string,
    label: string,
    action: ModerationAction | null
  ) => {
    if (!window.studioApi) return;
    if (
      action === 'block' &&
      !window.confirm(
        `Block ${label}? Their posts are hidden, their endorsements are left out of your published site, and their site won't be crawled.`
      )
    ) {
      return;
    }
    await window.studioApi.setModeration(siteUrl, action);
    await refreshStudioData();
    notify(
      action === 'mute'
        ? `Muted ${label}. Their posts are hidden from your feed.`
        : action === 'block'
        ? `Blocked ${label}.`
        : `Cleared mute/block for ${label}.`
    );
  };

  const activeSchedule = scheduleOverview?.personas.find((p) => p.personaId === activePersonaId);

  const handleSetSchedule = async (
    change:
      | { sync?: Partial<ScheduleJob>; publish?: Partial<PersonaScheduleView['schedule']['publish']> }
      | { app: Partial<ScheduleOverview['app']> }
  ) => {
    if (!window.studioApi) return;
    const payload = 'app' in change ? change : { personaId: activePersonaId, ...change };
    setScheduleOverview(await window.studioApi.setSchedule(payload));
  };

  const handleRunJobNow = async (job: 'sync' | 'publish') => {
    if (!window.studioApi || runningJob) return;
    setRunningJob(job);
    notify(job === 'sync' ? 'Running scheduled sync...' : 'Running scheduled publish...');
    try {
      const { result, overview } = await window.studioApi.runJobNow(activePersonaId, job);
      setScheduleOverview(overview);
      await refreshStudioData();
      notify(`${job === 'sync' ? 'Sync' : 'Publish'}: ${result.message}`);
    } finally {
      setRunningJob(null);
    }
  };

  const renderPresetPicker = (preset: SchedulePreset, onChange: (preset: SchedulePreset) => void) => {
    const kindValue = preset.kind === 'interval' ? `interval-${preset.minutes}` : preset.kind;
    const time = preset.kind === 'interval' ? '09:00' : preset.time;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={kindValue}
          onChange={(e) => {
            const value = e.target.value;
            if (value.startsWith('interval-')) {
              onChange({ kind: 'interval', minutes: Number(value.split('-')[1]) as 15 | 60 | 360 | 720 });
            } else if (value === 'daily') {
              onChange({ kind: 'daily', time });
            } else {
              onChange({ kind: 'weekly', weekday: 1, time });
            }
          }}
          className="px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs"
        >
          <option value="interval-15">Every 15 minutes</option>
          <option value="interval-60">Every hour</option>
          <option value="interval-360">Every 6 hours</option>
          <option value="interval-720">Every 12 hours</option>
          <option value="daily">Daily at…</option>
          <option value="weekly">Weekly on…</option>
        </select>
        {preset.kind === 'weekly' && (
          <select
            value={preset.weekday}
            onChange={(e) => onChange({ ...preset, weekday: Number(e.target.value) })}
            className="px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs"
          >
            {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, i) => (
              <option key={day} value={i}>
                {day}
              </option>
            ))}
          </select>
        )}
        {preset.kind !== 'interval' && (
          <input
            type="time"
            value={preset.time}
            onChange={(e) => e.target.value && onChange({ ...preset, time: e.target.value })}
            className="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 text-xs"
          />
        )}
      </div>
    );
  };

  const renderJobStatus = (job: ScheduleJob, nextAt: string | null) => (
    <div className="text-[11px] text-slate-400 space-y-0.5">
      <div>
        {job.enabled
          ? scheduleOverview?.app.paused
            ? 'Paused'
            : nextAt
              ? `Next run ${formatUpcoming(nextAt)}`
              : ''
          : 'Off'}
      </div>
      {job.lastResult && (
        <div
          className={
            job.lastResult.status === 'failed'
              ? 'text-rose-300'
              : job.lastResult.status === 'skipped'
                ? 'text-slate-400'
                : 'text-emerald-300'
          }
          title={job.lastResult.at}
        >
          Last run {formatRelativeTime(job.lastResult.at)}: {job.lastResult.message}
        </div>
      )}
    </div>
  );

  const handleExportLocalSite = async () => {
    if (!window.studioApi) return;
    const res = await window.studioApi.exportLocal(publishSettings.exportPath || undefined);
    await refreshStudioData();
    notify(res.message);
  };

  const handleRunTestExportPreview = async (openInBrowser = false) => {
    if (!window.studioApi) return;
    const res = await window.studioApi.testExportPreview(openInBrowser);
    setTestExportResult(res);
    setPreviewRenderMode('exported-http');
    setIframeRefreshKey((k) => k + 1);
    notify(
      openInBrowser
        ? `Test export built (${res.filesWritten.length} files) and launched in browser at ${res.previewUrl}`
        : `Test export built (${res.filesWritten.length} files) & served locally at ${res.previewUrl}!`
    );
  };

  const handleChooseExportFolder = async () => {
    if (!window.studioApi) return;
    const chosen = await window.studioApi.chooseExportFolder();
    if (chosen) {
      const nextSettings = { ...publishSettings, exportPath: chosen };
      setPublishSettings(nextSettings);
      await window.studioApi.updateProfile({ publishSettings: nextSettings });
      notify(`Saved local export folder: ${chosen}`);
    }
  };

  const handleSaveRemoteSettings = async () => {
    if (!window.studioApi) return;
    await window.studioApi.updateProfile({ publishSettings });
    await refreshStudioData();
    notify(
      `Saved ${publishSettings.protocol.toUpperCase()} connection settings for this persona in SQLite!`
    );
  };

  const handleClearRemoteSettings = async () => {
    if (!window.studioApi) return;
    const activeLabel =
      personas.find((p) => p.id === activePersonaId)?.label || bundle?.profile.displayName || 'this persona';
    const confirmed = window.confirm(
      `Delete the stored SFTP/FTP server address, username, password, and remote path from ${activeLabel}'s database?`
    );
    if (!confirmed) return;

    const clearedSettings: PublishSettingsState = {
      ...publishSettings,
      protocol: 'sftp',
      host: '',
      port: 22,
      username: '',
      password: '',
      remotePath: '/var/www/html',
    };
    setPublishSettings(clearedSettings);
    await window.studioApi.updateProfile({ publishSettings: clearedSettings });
    await refreshStudioData();
    notify(`Deleted stored SFTP/FTP credentials from ${activeLabel}'s database.`);
  };

  const handlePublishRemote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.studioApi) return;
    await window.studioApi.updateProfile({ publishSettings });
    notify(`Saved settings & connecting to ${publishSettings.protocol.toUpperCase()} host ${publishSettings.host}...`);
    const res = await window.studioApi.publishRemote(publishSettings);
    await refreshStudioData();
    notify(res.message);
  };

  const handleSaveGithubSettings = async () => {
    if (!window.studioApi) return;
    await window.studioApi.updateProfile({ publishSettings });
    await refreshStudioData();
    notify('Saved GitHub Pages connection settings for this persona in SQLite!');
  };

  const handleClearGithubSettings = async () => {
    if (!window.studioApi) return;
    const activeLabel =
      personas.find((p) => p.id === activePersonaId)?.label || bundle?.profile.displayName || 'this persona';
    const confirmed = window.confirm(
      `Delete the stored GitHub owner, repo, branch, token, and custom domain from ${activeLabel}'s database?`
    );
    if (!confirmed) return;

    const clearedSettings: PublishSettingsState = {
      ...publishSettings,
      githubOwner: '',
      githubRepo: '',
      githubBranch: 'gh-pages',
      githubToken: '',
      githubCustomDomain: '',
    };
    setPublishSettings(clearedSettings);
    setGithubCheckResult(null);
    await window.studioApi.updateProfile({ publishSettings: clearedSettings });
    await refreshStudioData();
    notify(`Deleted stored GitHub Pages credentials from ${activeLabel}'s database.`);
  };

  const handleCheckGithubRepo = async () => {
    if (!window.studioApi) return;
    setGithubChecking(true);
    try {
      const res = await window.studioApi.checkGithubRepo(publishSettings);
      setGithubCheckResult(res);
      notify(res.message);
    } finally {
      setGithubChecking(false);
    }
  };

  const handlePublishGithub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.studioApi) return;
    await window.studioApi.updateProfile({ publishSettings });
    notify(`Saved settings & deploying to github.com/${publishSettings.githubOwner}/${publishSettings.githubRepo}...`);
    setGithubDeploying(true);
    try {
      const res = await window.studioApi.publishGithub(publishSettings);
      await refreshStudioData();
      notify(res.message);
    } finally {
      setGithubDeploying(false);
    }
  };

  if (!bundle) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center">
        <div className="text-center space-y-2">
          <RefreshCw className="w-8 h-8 animate-spin text-indigo-400 mx-auto" />
          <p className="text-sm font-medium">Initializing Local SQLite Database & Ed25519 Keys...</p>
        </div>
      </div>
    );
  }

  // Your own posts and photos, in the feed's shape. Built for display only: friends' entries come
  // from crawled, verified data, and yours are never mixed into that store.
  const myFeedEntries: NetworkFeedEntry[] = [
    ...bundle.items.items
      .filter((item) => item.type !== 'comment')
      .map((item) => ({
        id: `mine-${item.id}`,
        friendSiteUrl: bundle.profile.siteUrl,
        friendName: bundle.profile.displayName,
        friendAvatarUrl: bundle.profile.avatarUrl,
        friendDid: bundle.profile.did,
        entryType: item.type,
        title: item.title,
        canonicalUrl: item.canonicalUrl,
        targetUrl: item.targetUrl,
        commentary: item.commentary || '',
        mediaUrl: item.mediaUrl || '',
        tags: item.tags,
        createdAt: item.createdAt,
        verifiedSignature: true,
        isMine: true,
      })),
    ...bundle.albums.albums.flatMap((album) =>
      album.photos.map((photo) => ({
        id: `mine-${photo.id}`,
        friendSiteUrl: bundle.profile.siteUrl,
        friendName: bundle.profile.displayName,
        friendAvatarUrl: bundle.profile.avatarUrl,
        friendDid: bundle.profile.did,
        entryType: 'photo' as const,
        title: photo.caption || `${album.title} Photo`,
        canonicalUrl: photo.canonicalUrl,
        targetUrl: photo.url,
        commentary: `Published in album "${album.title}"`,
        mediaUrl: photo.thumbUrl || photo.url,
        tags: photo.tags,
        createdAt: photo.createdAt,
        verifiedSignature: true,
        isMine: true,
      }))
    ),
  ];
  const visibleFeed = (
    feedScope === 'saved'
      ? []
      : feedScope === 'friends'
        ? networkFeed
        : feedScope === 'me'
          ? myFeedEntries
          : [...networkFeed, ...myFeedEntries]
  )
    .filter((entry) => entry.entryType !== 'comment')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const savedByUrl = new Map(savedPosts.map((s) => [s.canonicalUrl, s]));

  const handleToggleSaved = async (entry: NetworkFeedEntry) => {
    if (!window.studioApi) return;
    const existing = savedByUrl.get(entry.canonicalUrl);
    try {
      if (existing) {
        await window.studioApi.unsavePost(existing.id);
        notify('Removed from Saved.');
      } else {
        const saved = await window.studioApi.savePost(entry.canonicalUrl);
        notify(
          saved.mediaUrl && !saved.localMediaUrl
            ? 'Saved. Its image couldn\'t be copied, so it links to the original.'
            : 'Saved: a private copy that stays after it leaves your feed.'
        );
      }
    } catch (err) {
      notify(`Couldn't save that: ${err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)}`);
    }
    await refreshStudioData();
  };

  const handleSetFeedRetention = async (days: number) => {
    if (!window.studioApi) return;
    const narrower = days !== 0 && (feedRetentionDays === 0 || days < feedRetentionDays);
    if (narrower && !window.confirm('Remove friends\' posts older than this from your feed now? Saved posts, and friends\' likes and comments on your posts, are kept.')) {
      return;
    }
    const result = await window.studioApi.setFeedRetention(days);
    setFeedRetentionDays(result.days);
    await refreshStudioData();
    notify(
      result.pruned
        ? `Removed ${result.pruned} older entr${result.pruned === 1 ? 'y' : 'ies'} from your feed.`
        : days === 0 || !narrower
          ? 'Feed window widened. The next sync brings back older posts friends still publish.'
          : 'Feed window updated.'
    );
  };

  const handleDeleteMyFeedEntry = async (entry: NetworkFeedEntry) => {
    if (!window.studioApi) return;
    if (!window.confirm(`Delete "${entry.title}"? It's removed from your site at the next publish.`)) return;
    const id = entry.id.replace(/^mine-/, '');
    if (entry.entryType === 'photo') await window.studioApi.deletePhoto(id);
    else await window.studioApi.deleteItem(id);
    await refreshStudioData();
  };

  const navItems: Array<{ id: StudioTab; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: 'profile', label: 'Profile & Identity', icon: <UserCheck className="w-4 h-4" /> },
    {
      id: 'albums',
      label: 'Media Library',
      icon: <Camera className="w-4 h-4" />,
      badge: bundle.manifest.stats.photoCount,
    },
    {
      id: 'items',
      label: 'Posts, Likes & Shares',
      icon: <MessageSquare className="w-4 h-4" />,
      badge: bundle.manifest.stats.itemCount,
    },
    {
      id: 'friends',
      label: 'Friends & Webrings',
      icon: <Users className="w-4 h-4" />,
      badge: allFriends.length,
    },
    {
      id: 'feed',
      label: 'Neighborhood Feed',
      icon: <Radio className="w-4 h-4" />,
      badge: networkFeed.length,
    },
    { id: 'preview', label: 'Site Design', icon: <Compass className="w-4 h-4" /> },
    { id: 'schemas', label: 'JSON Schema Output', icon: <Code2 className="w-4 h-4" /> },
    { id: 'publish', label: 'Publish & SFTP', icon: <UploadCloud className="w-4 h-4" /> },
    {
      id: 'mcp',
      label: 'AI Agent (MCP)',
      icon: <Sparkles className="w-4 h-4" />,
      badge: mcpInfo?.status.toolCount || 24,
    },
    { id: 'help', label: 'Help & Deploy Guide', icon: <BookOpen className="w-4 h-4" /> },
  ];

  const getSelectedSchemaJson = () => {
    switch (selectedSchemaFile) {
      case 'did':
        return bundle.didDocument;
      case 'manifest':
        return bundle.manifest;
      case 'profile':
        return bundle.profile;
      case 'albums':
        return bundle.albums;
      case 'items':
        return bundle.items;
      case 'connections':
        return bundle.connections;
    }
  };

  return (
    <div className="h-screen flex bg-slate-950 text-slate-100 overflow-hidden">
      {/* Left Sidebar Navigation */}
      <aside className="w-64 bg-slate-900/90 border-r border-slate-800 flex flex-col justify-between shrink-0">
        <div>
          <div className="p-5 border-b border-slate-800">
            <div className="flex items-center gap-2.5">
              <img src="./logo-mark.png" alt="" className="w-10 h-10 shrink-0" />
              <div>
                <h1 className="font-extrabold text-base tracking-tight">Webring Studio</h1>
                <p className="text-[11px] text-slate-400">Local SQLite • Static JSON v{WEBRING_SCHEMA_VERSION}</p>
              </div>
            </div>
          </div>

          {/* Active Persona Switcher (Strict Compartmentalization) */}
          <div className="p-3 border-b border-slate-800 bg-slate-950/60 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-400 flex items-center gap-1">
                <Layers className="w-3 h-3" />
                Active Persona ({personas.length || 1})
              </span>
              <button
                type="button"
                onClick={() => setShowPersonaModal(true)}
                className="text-[11px] px-2 py-0.5 rounded-md bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 font-semibold transition flex items-center gap-1"
                title="Create or manage compartmentalized online personas"
              >
                <Plus className="w-3 h-3" />
                Personas
              </button>
            </div>

            {personas.length > 1 ? (
              <select
                aria-label="Switch Active Persona"
                value={activePersonaId}
                onChange={(e) => handleSwitchPersona(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-semibold text-white focus:outline-none focus:border-indigo-500"
              >
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} — {p.displayName}
                  </option>
                ))}
              </select>
            ) : null}

            <div
              onClick={() => setShowPersonaModal(true)}
              className="p-2 rounded-xl bg-slate-900/90 border border-slate-800 hover:border-indigo-500/40 cursor-pointer transition flex items-center gap-2.5"
              title="Click to switch or create another compartmentalized persona"
            >
              <img
                src={
                  bundle.profile.avatarUrl ||
                  `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent(
                    bundle.profile.displayName
                  )}`
                }
                alt={bundle.profile.displayName}
                className="w-8 h-8 rounded-lg object-cover border border-slate-700 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-white truncate">
                    {bundle.profile.displayName}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 font-medium truncate">
                    {personas.find((p) => p.id === activePersonaId)?.label || 'Primary'}
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 font-mono truncate">{bundle.profile.did}</p>
              </div>
            </div>
          </div>

          <nav className="p-3 space-y-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                  activeTab === item.id
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                    : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  {item.icon}
                  {item.label}
                </span>
                {item.badge !== undefined && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      activeTab === item.id
                        ? 'bg-indigo-800 text-indigo-100'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* Bottom Identity & Quick Export Card */}
        <div className="p-4 border-t border-slate-800 space-y-2.5 bg-slate-900/50">
          <div className="text-xs space-y-1">
            <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
              <ShieldCheck className="w-4 h-4" />
              <span>Signed DID Ready</span>
            </div>
            <p className="font-mono text-[11px] text-slate-400 truncate" title={bundle.profile.did}>
              {bundle.profile.did}
            </p>
          </div>
          <button
            onClick={async () => {
              await handleRunTestExportPreview(false);
              setActiveTab('preview');
            }}
            className="w-full py-2 px-3 rounded-xl bg-indigo-600/25 hover:bg-indigo-600/40 border border-indigo-500/40 text-indigo-200 font-semibold text-xs flex items-center justify-center gap-1.5 transition"
            title="Build a local test export and preview it over a local HTTP server before publishing"
          >
            <Compass className="w-4 h-4 text-indigo-400" />
            Test Export & Preview
          </button>
          <button
            onClick={handleExportLocalSite}
            className="w-full py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow transition"
          >
            <FolderOutput className="w-4 h-4" />
            Quick Export Static Site
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Status Bar */}
        <header className="h-14 border-b border-slate-800 bg-slate-900/50 px-6 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <button
              type="button"
              onClick={() => setShowPersonaModal(true)}
              className="px-2.5 py-1 rounded-md bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 text-indigo-300 font-semibold flex items-center gap-1.5 transition"
              title="Click to switch or manage compartmentalized personas"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>
                Persona: {personas.find((p) => p.id === activePersonaId)?.label || 'Primary'}
              </span>
            </button>
            <span className="px-2.5 py-1 rounded-md bg-slate-800 text-slate-200 font-mono">
              {bundle.profile.siteUrl}
            </span>
            <span>•</span>
            <span>
              Endorsements Discovered:{' '}
              <strong className="text-pink-400">{allEndorsements.length}</strong>
            </span>
            <span>•</span>
            <span className="inline-flex items-center gap-1 text-emerald-400">
              <Lock className="w-3 h-3" />
              Publicly Exported Friends: <strong>{bundle.connections.friends.length}</strong> / {allFriends.length}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {statusMessage && (
              <div className="px-3 py-1 rounded-lg bg-indigo-500/20 border border-indigo-500/40 text-indigo-200 text-xs flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span className="truncate max-w-md">{statusMessage}</span>
              </div>
            )}
            <button
              onClick={handleSyncAllFriends}
              disabled={isSyncingFriends}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-xs font-medium text-indigo-300 flex items-center gap-1.5 border border-slate-700"
              title="Crawl every friend's signed JSON endpoints and refresh your feed and endorsements"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncingFriends ? 'animate-spin' : ''}`} />
              {isSyncingFriends ? 'Syncing...' : 'Sync All Friends'}
            </button>
          </div>
        </header>

        {/* Scrollable Workspace */}
        <div className="flex-1 overflow-y-auto p-6">
          {isPlaceholderSiteUrl(bundle.profile.siteUrl) && activeTab !== 'profile' && (
            <div className="max-w-5xl mx-auto mb-5 p-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex flex-wrap items-center justify-between gap-3 text-sm">
              <div>
                <strong className="text-amber-200">Set up your profile first.</strong>{' '}
                <span className="text-slate-300">
                  Add your site's public address (for example <code>https://yourname.github.io</code>)
                  and your name. Your identity and everything you publish are based on that address.
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab('profile')}
                className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-xs font-semibold"
              >
                Open Profile →
              </button>
            </div>
          )}
          {/* TAB 1: PROFILE & IDENTITY */}
          {activeTab === 'profile' && (
            <div className="max-w-4xl mx-auto space-y-6">
              <div>
                <h2 className="text-2xl font-bold">Profile & Federated Identity</h2>
                <p className="text-sm text-slate-400 mt-1">
                  Configure your personal profile site, theme, and W3C / ATProto <code>did:web</code>{' '}
                  identity. Saving automatically signs <code>/api/profile.json</code> and{' '}
                  <code>/.well-known/did.json</code>.
                </p>
              </div>

              <form
                onSubmit={handleSaveProfile}
                className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                      Hosted Website URL (Canonical Root)
                    </label>
                    <input
                      type="text"
                      value={siteUrl}
                      onChange={(e) => setSiteUrl(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm focus:border-indigo-500 focus:outline-none"
                      placeholder="https://yourname.example.com"
                    />
                    <p className="text-[11px] text-emerald-400 font-mono mt-1">
                      Generated DID: {siteUrlToDidWeb(siteUrl)}
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                      Display Name
                    </label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                      Tagline / Headline
                    </label>
                    <input
                      type="text"
                      value={tagline}
                      onChange={(e) => setTagline(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div className="text-xs text-slate-400 self-end pb-2">
                    Theme, colours and page layout are in{' '}
                    <button type="button" onClick={() => setActiveTab('preview')} className="text-indigo-300 hover:underline">
                      Site Design
                    </button>
                    .
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                    About / Bio
                  </label>
                  <textarea
                    rows={3}
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <ProfileImagePicker
                    kind="avatar"
                    label="Profile Photo"
                    value={avatarUrl}
                    savedValue={bundle.profile.avatarUrl || ''}
                    albums={bundle.albums.albums}
                    mediaSrc={mediaSrc}
                    onChange={setAvatarUrl}
                    onUpload={(filePath) => handleUploadProfileImage('avatar', filePath)}
                  />

                  <ProfileImagePicker
                    kind="banner"
                    label="Banner Image"
                    value={bannerUrl}
                    savedValue={bundle.profile.bannerUrl || ''}
                    albums={bundle.albums.albums}
                    mediaSrc={mediaSrc}
                    onChange={setBannerUrl}
                    onUpload={(filePath) => handleUploadProfileImage('banner', filePath)}
                  />

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                      Interests (Comma-separated tags)
                    </label>
                    <input
                      type="text"
                      value={interestsInput}
                      onChange={(e) => setInterestsInput(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm focus:border-indigo-500 focus:outline-none"
                      placeholder="Photography, IndieWeb, Sci-Fi, Synth"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
                      Bluesky / ATProto Handle (Optional)
                    </label>
                    <input
                      type="text"
                      value={atprotoHandle}
                      onChange={(e) => setAtprotoHandle(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm focus:border-indigo-500 focus:outline-none"
                      placeholder="yourname.bsky.social"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Custom Links (shown below your bio)
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setCustomLinks((prev) => [...prev, { label: '', url: '' }])
                      }
                      className="text-xs px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 font-medium"
                    >
                      + Add Link
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Use a URL starting with <code>./</code> (e.g. <code>./api/manifest.json</code>)
                    to point at a file inside your own exported site — not a leading{' '}
                    <code>/</code>, which breaks once your site is hosted in a subfolder (like a
                    GitHub Pages project site at <code>username.github.io/repo-name/</code>).
                  </p>
                  {customLinks.length === 0 && (
                    <p className="text-xs text-slate-500 italic">No custom links yet.</p>
                  )}
                  {customLinks.map((link, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={link.label}
                        onChange={(e) =>
                          setCustomLinks((prev) =>
                            prev.map((l, i) => (i === idx ? { ...l, label: e.target.value } : l))
                          )
                        }
                        placeholder="Label"
                        className="w-40 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                      <input
                        type="text"
                        value={link.url}
                        onChange={(e) =>
                          setCustomLinks((prev) =>
                            prev.map((l, i) => (i === idx ? { ...l, url: e.target.value } : l))
                          )
                        }
                        placeholder="./api/manifest.json or https://..."
                        className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setCustomLinks((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="p-2 rounded-lg bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/30 text-rose-300"
                        title="Remove this link"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="pt-2 flex items-center justify-between">
                  <div className="text-xs text-slate-400">
                    Ed25519 Verification Method:{' '}
                    <code className="text-indigo-300">{bundle.profile.did}#key-1</code>
                  </div>
                  <button
                    type="submit"
                    className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm shadow-lg shadow-indigo-600/25 transition"
                  >
                    Save & Sign Profile JSON
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* TAB 2: PHOTO ALBUMS */}
          {activeTab === 'albums' && (() => {
            const albums = bundle.albums.albums;
            const album = albums.find((a) => a.id === selectedAlbumId);
            const draft = album
              ? albumDraft || { title: album.title, description: album.description, tags: album.tags.join(', ') }
              : null;
            return (
            <div className="max-w-6xl mx-auto space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-bold">Media Library</h2>
                  <p className="text-sm text-slate-400 mt-1">
                    Albums of your own photos, kept on this computer and published with your site, by
                    folder, SFTP/FTP or GitHub Pages. Each album gets a signed manifest listing every
                    photo and its exact file.
                  </p>
                </div>
                {mediaUsage && (
                  <span className="text-xs text-slate-400 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800">
                    Library: {mediaUsage.files} files · {formatBytes(mediaUsage.bytes)}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-6">
                {/* Album list */}
                <div className="space-y-3">
                  <form
                    onSubmit={handleCreateAlbum}
                    className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2"
                  >
                    <h3 className="font-bold text-sm flex items-center gap-2">
                      <Plus className="w-4 h-4 text-indigo-400" /> New Album
                    </h3>
                    <input
                      type="text"
                      required
                      value={newAlbumTitle}
                      onChange={(e) => setNewAlbumTitle(e.target.value)}
                      placeholder="Album title"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                    />
                    <input
                      type="text"
                      value={newAlbumDesc}
                      onChange={(e) => setNewAlbumDesc(e.target.value)}
                      placeholder="Description (optional)"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                    />
                    <button
                      type="submit"
                      className="w-full px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs"
                    >
                      Create Album
                    </button>
                  </form>
                  {albums.length === 0 && (
                    <p className="text-xs text-slate-500 px-1">No albums yet.</p>
                  )}
                  {albums.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => {
                        setSelectedAlbumId(a.id);
                        setAlbumDraft(null);
                        refreshMediaUsage();
                      }}
                      className={`w-full flex items-center gap-3 p-2.5 rounded-xl border text-left transition ${
                        a.id === selectedAlbumId
                          ? 'bg-indigo-950/40 border-indigo-500/50'
                          : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      {a.coverUrl ? (
                        <img src={mediaSrc(a.coverUrl)} alt="" className="w-12 h-12 rounded-lg object-cover bg-slate-800" />
                      ) : (
                        <div className="w-12 h-12 rounded-lg bg-slate-800 flex items-center justify-center">
                          <Camera className="w-5 h-5 text-slate-500" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="font-semibold text-sm truncate">{a.title}</div>
                        <div className="text-[11px] text-slate-400">
                          {a.photos.length} photo{a.photos.length === 1 ? '' : 's'} · updated {formatRelativeTime(a.updatedAt)}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>

                {/* Selected album */}
                {!album || !draft ? (
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center text-sm text-slate-400">
                    Create an album, or pick one on the left, to add photos.
                  </div>
                ) : (
                  <div
                    className={`bg-slate-900 border rounded-2xl p-5 space-y-5 transition ${
                      isDraggingPhotos ? 'border-indigo-400 bg-indigo-950/20' : 'border-slate-800'
                    }`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDraggingPhotos(true);
                    }}
                    onDragLeave={() => setIsDraggingPhotos(false)}
                    onDrop={handleDropPhotos}
                  >
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <input
                        type="text"
                        value={draft.title}
                        onChange={(e) => setAlbumDraft({ ...draft, title: e.target.value })}
                        className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-semibold"
                      />
                      <input
                        type="text"
                        value={draft.tags}
                        onChange={(e) => setAlbumDraft({ ...draft, tags: e.target.value })}
                        placeholder="Tags, comma separated"
                        className="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                      <MarkdownField
                        value={draft.description}
                        onChange={(description) => setAlbumDraft({ ...draft, description })}
                        placeholder="Description (Markdown: headings, links, lists, tables)"
                        className="md:col-span-2"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {albumDraft && (
                        <button
                          type="button"
                          onClick={handleSaveAlbum}
                          className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                        >
                          Save Album
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isImportingPhotos}
                        onClick={() => handleImportPhotos()}
                        className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold flex items-center gap-1.5"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        {isImportingPhotos ? 'Importing...' : 'Add Photos'}
                      </button>
                      <span className="text-xs text-slate-500">or drop JPEG/PNG files here</span>
                      <button
                        type="button"
                        onClick={() => handleDeleteAlbum(album)}
                        className="ml-auto px-3 py-2 rounded-xl bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/30 text-rose-300 text-xs"
                      >
                        Delete Album
                      </button>
                    </div>

                    {album.photos.length === 0 ? (
                      <p className="text-sm text-slate-500 py-8 text-center">No photos yet.</p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                        {album.photos.map((photo, idx) => {
                          const photoDraft = photoDrafts[photo.id] || { caption: photo.caption, altText: photo.altText };
                          const isCover = album.coverUrl === photo.thumbUrl;
                          return (
                            <div key={photo.id} className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
                              <img
                                src={mediaSrc(photo.thumbUrl || photo.url)}
                                alt={photo.altText}
                                className="w-full aspect-[4/3] object-cover bg-slate-800"
                              />
                              <div className="p-2.5 space-y-1.5">
                                <input
                                  type="text"
                                  value={photoDraft.caption}
                                  placeholder="Caption"
                                  onChange={(e) =>
                                    setPhotoDrafts((prev) => ({ ...prev, [photo.id]: { ...photoDraft, caption: e.target.value } }))
                                  }
                                  onBlur={() => handleSavePhotoDetails(photo.id)}
                                  className="w-full px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs"
                                />
                                <input
                                  type="text"
                                  value={photoDraft.altText}
                                  placeholder="Alt text (describe the photo)"
                                  onChange={(e) =>
                                    setPhotoDrafts((prev) => ({ ...prev, [photo.id]: { ...photoDraft, altText: e.target.value } }))
                                  }
                                  onBlur={() => handleSavePhotoDetails(photo.id)}
                                  className="w-full px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs"
                                />
                                <div className="text-[10px] text-slate-500">
                                  {photo.width && photo.height ? `${photo.width}×${photo.height}` : 'External image'}
                                  {photo.bytes ? ` · ${formatBytes(photo.bytes)}` : ''}
                                  {isCover ? ' · Cover' : ''}
                                </div>
                                <div className="flex flex-wrap gap-1 text-[11px]">
                                  <button type="button" disabled={idx === 0} onClick={() => handlePhotoAction(photo, 'up')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40" title="Move earlier">←</button>
                                  <button type="button" disabled={idx === album.photos.length - 1} onClick={() => handlePhotoAction(photo, 'down')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40" title="Move later">→</button>
                                  {!isCover && (
                                    <button type="button" onClick={() => handlePhotoAction(photo, 'cover')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700">Cover</button>
                                  )}
                                  {photo.sha256 && (
                                    <button type="button" onClick={() => handlePhotoAction(photo, 'replace')} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700">Replace</button>
                                  )}
                                  <button type="button" onClick={() => handlePhotoAction(photo, 'delete')} className="px-2 py-1 rounded bg-rose-950/40 hover:bg-rose-900/50 text-rose-300">Delete</button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* External image by URL (not stored in the library) */}
                    <form onSubmit={handleAddPhoto} className="flex flex-wrap gap-2 border-t border-slate-800 pt-4">
                      <input
                        type="url"
                        value={newPhotoUrl}
                        onChange={(e) => setNewPhotoUrl(e.target.value)}
                        placeholder="Or link an image hosted elsewhere: https://..."
                        className="flex-1 min-w-[14rem] px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs"
                      />
                      <input
                        type="text"
                        value={newPhotoCaption}
                        onChange={(e) => setNewPhotoCaption(e.target.value)}
                        placeholder="Caption"
                        className="w-40 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs"
                      />
                      <button type="submit" className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs">
                        Add Link
                      </button>
                    </form>
                  </div>
                )}
              </div>

              <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 text-xs text-slate-400 space-y-2">
                <p>
                  <strong className="text-slate-200">What gets published:</strong> a web copy of each
                  photo (up to 2048 px) and a thumbnail, with camera details and GPS location removed.
                  Your originals stay on this computer. Replacing a photo publishes it under a new file
                  name, so nobody sees a stale copy.
                </p>
                <p>
                  Publishing only uploads what changed, and removes photos you deleted from your folder,
                  server or GitHub repo. It only ever removes files Studio published there; anything
                  else is left alone.
                </p>
                <button
                  type="button"
                  onClick={handleForgetPublishHistory}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                >
                  Re-upload everything at next publish
                </button>
              </div>
            </div>
            );
          })()}

          {/* TAB 3: WALL POSTS, LIKES & SHARES */}
          {activeTab === 'items' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <div>
                <h2 className="text-2xl font-bold">Wall Posts, Likes, Shares & Comments</h2>
                <p className="text-sm text-slate-400 mt-1">
                  Publish Facebook-style status updates and wall posts, curate articles/music/gear you
                  love, or post signed comments on friends' posts. Everything is cryptographically
                  signed into <code>/api/items.json</code> so your friend ring can pull and thread it!
                </p>
              </div>

              <form
                onSubmit={handleCreateItem}
                className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-bold text-base flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-amber-400" />
                    {itemType === 'post'
                      ? 'Compose a Wall Post / Status Update'
                      : itemType === 'comment'
                      ? 'Write a Signed Comment on a Friend’s Post'
                      : 'Log a Like, Share, or Recommendation'}
                  </h3>

                  {/* Quick Mode Selector Pills */}
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    {(
                      [
                        { id: 'post', label: '📝 Wall Post' },
                        { id: 'like', label: '♥ Like' },
                        { id: 'share', label: '↻ Share' },
                        { id: 'recommendation', label: '★ Recommend' },
                        { id: 'comment', label: '💬 Comment' },
                      ] as const
                    ).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setItemType(m.id);
                          if (m.id === 'post') setItemCategory('status');
                          if (m.id === 'comment') setItemCategory('comment');
                        }}
                        className={`px-3 py-1.5 rounded-lg font-semibold transition ${
                          itemType === m.id
                            ? 'bg-indigo-600 text-white shadow'
                            : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {itemType === 'post' ? (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="md:col-span-2">
                        <label className="block text-xs text-slate-400 mb-1">
                          Headline / Post Title (Optional — auto-generated from text if blank)
                        </label>
                        <input
                          type="text"
                          value={itemTitle}
                          onChange={(e) => setItemTitle(e.target.value)}
                          placeholder="e.g., Weekend Darkroom Notes & New Prints"
                          className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Topic / Category</label>
                        <select
                          value={itemCategory}
                          onChange={(e) => setItemCategory(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        >
                          <option value="status">Status Update / Wall Post</option>
                          <option value="article">Essay / Micro-Blog</option>
                          <option value="photo">Photo Post</option>
                          <option value="music">Music / Audio Note</option>
                          <option value="general">General</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Post Body (what's on your mind?) *
                      </label>
                      <MarkdownField
                        value={itemCommentary}
                        onChange={setItemCommentary}
                        rows={5}
                        placeholder={'Write your status update, thoughts, or story here.\n\nMarkdown works: **bold**, *italic*, [a link](https://…), lists, quotes and tables.'}
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="md:col-span-2">
                        <label className="block text-xs text-slate-400 mb-1">
                          Attach Photo or Media URL (Optional)
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={itemMediaUrl}
                            onChange={(e) => setItemMediaUrl(e.target.value)}
                            placeholder="https://... or import a local image"
                            className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                          />
                          <button
                            type="button"
                            onClick={handlePickLocalPostImage}
                            className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1.5 shrink-0"
                          >
                            <ImagePlus className="w-4 h-4 text-indigo-400" />
                            Import Image
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Tags (comma-separated)
                        </label>
                        <input
                          type="text"
                          value={itemTags}
                          onChange={(e) => setItemTags(e.target.value)}
                          placeholder="status, update, photography"
                          className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Interaction Type</label>
                        <select
                          value={itemType}
                          onChange={(e) => setItemType(e.target.value as SharedItemType)}
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        >
                          <option value="post">📝 Wall Post (Status Update)</option>
                          <option value="like">♥ Like (Thing I Like)</option>
                          <option value="share">↻ Share (Syndicated Item)</option>
                          <option value="recommendation">★ Recommendation (Gear / Book / Place)</option>
                          <option value="comment">💬 Comment (Reply to a Friend's Post)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Category</label>
                        <select
                          value={itemCategory}
                          onChange={(e) => setItemCategory(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        >
                          <option value="comment">Comment / Reply</option>
                          <option value="article">Article / Essay</option>
                          <option value="photo">Photo / Visual Art</option>
                          <option value="music">Music / Audio</option>
                          <option value="book">Book / Zine</option>
                          <option value="gear">Tool / Hardware / Gear</option>
                          <option value="general">General Web Item</option>
                        </select>
                      </div>

                      {itemType !== 'comment' && (
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">
                            Rating (1 - 5 Stars)
                          </label>
                          <select
                            value={itemRating}
                            onChange={(e) => setItemRating(Number(e.target.value))}
                            className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                          >
                            <option value={5}>★★★★★ (5/5 Essential)</option>
                            <option value={4}>★★★★☆ (4/5 Great)</option>
                            <option value={3}>★★★☆☆ (3/5 Good)</option>
                            <option value={2}>★★☆☆☆ (2/5 Meh)</option>
                            <option value={1}>★☆☆☆☆ (1/5 Skip)</option>
                          </select>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          {itemType === 'comment' ? 'Subject / Replying To' : 'Item Title *'}
                        </label>
                        <input
                          type="text"
                          required={itemType !== 'comment'}
                          value={itemTitle}
                          onChange={(e) => setItemTitle(e.target.value)}
                          placeholder={
                            itemType === 'comment'
                              ? 'Re: Friend’s post title'
                              : 'Title of the photo, post, album, or thing you like'
                          }
                          className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        />
                      </div>

                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          {itemType === 'comment'
                            ? "Target Post Canonical URI (Friend's Post or Photo URL) *"
                            : "Target URL (Indexed Website or Friend's Canonical Item URI) *"}
                        </label>
                        <input
                          type="text"
                          required
                          value={itemTargetUrl}
                          onChange={(e) => setItemTargetUrl(e.target.value)}
                          placeholder="https://friend.example/api/items.json#item-123"
                          className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Original Author Name
                        </label>
                        <input
                          type="text"
                          value={itemAuthorName}
                          onChange={(e) => setItemAuthorName(e.target.value)}
                          placeholder="e.g., Sam Okafor"
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Original Author Site URL
                        </label>
                        <input
                          type="text"
                          value={itemAuthorUrl}
                          onChange={(e) => setItemAuthorUrl(e.target.value)}
                          placeholder="https://author.example"
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Preview Image URL (Optional)
                        </label>
                        <input
                          type="text"
                          value={itemMediaUrl}
                          onChange={(e) => setItemMediaUrl(e.target.value)}
                          placeholder="https://..."
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="md:col-span-2">
                        <label className="block text-xs text-slate-400 mb-1">
                          {itemType === 'comment'
                            ? 'Your Comment / Reply *'
                            : 'Your Commentary / Notes'}
                        </label>
                        <textarea
                          rows={itemType === 'comment' ? 3 : 2}
                          required={itemType === 'comment'}
                          value={itemCommentary}
                          onChange={(e) => setItemCommentary(e.target.value)}
                          placeholder={
                            itemType === 'comment'
                              ? 'Write your reply to this post...'
                              : 'Why do you like or recommend this item?'
                          }
                          className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Tags (comma-separated)
                        </label>
                        <input
                          type="text"
                          value={itemTags}
                          onChange={(e) => setItemTags(e.target.value)}
                          placeholder="indieweb, music, synth"
                          className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                        />
                      </div>
                    </div>
                  </>
                )}

                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow"
                >
                  {itemType === 'post'
                    ? '+ Publish Wall Post to My Profile'
                    : itemType === 'comment'
                    ? '+ Publish Signed Comment to My Feed'
                    : '+ Publish Item to My Schema'}
                </button>
              </form>

              {/* Existing Items & Wall Posts Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {bundle.items.items.map((item) => {
                  const postComments = allEndorsements.filter(
                    (e) => e.targetCanonicalUrl === item.canonicalUrl && e.type === 'comment'
                  );
                  return (
                    <div
                      key={item.id}
                      className={`bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col justify-between ${
                        item.type === 'post' ? 'md:col-span-2' : ''
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <span
                            className={`text-[11px] uppercase font-bold px-2.5 py-0.5 rounded-full ${
                              item.type === 'post'
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                : item.type === 'like'
                                ? 'bg-pink-500/20 text-pink-400'
                                : item.type === 'recommendation'
                                ? 'bg-amber-500/20 text-amber-400'
                                : item.type === 'comment'
                                ? 'bg-purple-500/20 text-purple-300'
                                : 'bg-sky-500/20 text-sky-400'
                            }`}
                          >
                            {item.type === 'post' ? '📝 Wall Post' : item.type}
                          </span>
                          <div className="flex items-center gap-2">
                            {item.updatedAt && (
                              <span className="text-[10px] text-slate-500" title={`Edited ${new Date(item.updatedAt).toLocaleString()}`}>
                                edited
                              </span>
                            )}
                            {editingItemId !== item.id && (
                              <button
                                type="button"
                                onClick={() => setEditingItemId(item.id)}
                                className="text-slate-500 hover:text-indigo-300"
                                title="Edit"
                                aria-label={`Edit ${item.title}`}
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleDeleteItem(item)}
                              className="text-slate-500 hover:text-rose-400"
                              title="Delete"
                              aria-label={`Delete ${item.title}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                        {editingItemId === item.id ? (
                          <ItemEditor
                            item={item}
                            mediaSrc={mediaSrc}
                            onPickImage={async () => {
                              const imported = await window.studioApi?.importImage();
                              return imported ? imported.url : null;
                            }}
                            onSave={(edit) => handleSaveItemEdit(item, edit)}
                            onCancel={() => setEditingItemId(null)}
                          />
                        ) : (
                        <>
                        {item.mediaUrl && (
                          <img
                            src={mediaSrc(item.mediaUrl)}
                            alt={item.title}
                            className="w-full max-h-60 object-cover rounded-xl mb-3"
                          />
                        )}
                        <h4 className="font-bold text-base">{item.title}</h4>
                        {item.targetUrl !== item.canonicalUrl && (
                          <p className="text-xs text-indigo-400 font-mono truncate mt-0.5">
                            Target: {item.targetUrl}
                          </p>
                        )}
                        {item.type === 'post' ? (
                          <div
                            className="studio-prose text-sm text-slate-300 mt-2"
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(item.commentary) }}
                          />
                        ) : (
                          <p className="text-sm text-slate-300 mt-2 whitespace-pre-line">{item.commentary}</p>
                        )}
                        </>
                        )}

                        {postComments.length > 0 && (
                          <div className="mt-3 pt-2.5 border-t border-slate-800 space-y-1.5">
                            <p className="text-xs font-bold text-emerald-400">
                              💬 Discovered Ring Comments ({postComments.length})
                            </p>
                            {postComments.map((c) => (
                              <div
                                key={c.id}
                                className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-xs"
                              >
                                <span className="font-bold text-indigo-300">{c.authorName}: </span>
                                <span className="text-slate-300">{c.commentary}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-500 font-mono">
                        <span className="truncate">{item.canonicalUrl}</span>
                        <span>{item.category}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 4: FRIENDS & WEBRINGS */}
          {activeTab === 'friends' && (
            <div className="max-w-5xl mx-auto space-y-8">
              <div>
                <h2 className="text-2xl font-bold">Friend Connections & Webrings</h2>
                <p className="text-sm text-slate-400 mt-1">
                  Follow friends locally to pull their feeds into your Neighborhood Feed without
                  exposing your social graph to third-party web scrapers. By default, friends are{' '}
                  <strong>Private (Local SQLite Only)</strong> and omitted from{' '}
                  <code>/api/connections.json</code>.
                </p>
              </div>

              {/* Social Graph Privacy & Anti-Scraping Shield Panel */}
              <div className="bg-slate-900 border border-emerald-500/30 rounded-2xl p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                      <Lock className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="font-bold text-sm flex items-center gap-2">
                        Social Graph Privacy & Anti-Scraping Shield
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono">
                          {publishSettings.publishFriendsList
                            ? `${bundle.connections.friends.length} Public / ${
                                allFriends.length - bundle.connections.friends.length
                              } Private`
                            : '100% Local-Only Graph'}
                        </span>
                      </h3>
                      <p className="text-xs text-slate-400">
                        Control what social metadata is written to your static <code>/api/*.json</code>{' '}
                        files and <code>index.html</code>. Your local RingCrawler always indexes all{' '}
                        {allFriends.length} friend(s) regardless of public export settings.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 text-xs">
                  <label className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(publishSettings.publishFriendsList)}
                      onChange={(e) =>
                        handleUpdatePrivacySetting({ publishFriendsList: e.target.checked })
                      }
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <span className="font-semibold text-slate-200 block">
                        Publish Public Friends to Blogroll (<code>/api/connections.json</code>)
                      </span>
                      <span className="text-slate-400">
                        When unchecked (default), <code>friends: []</code> is exported so scrapers
                        cannot map your connections. When checked, only friends marked{' '}
                        <strong>Public</strong> below are exported.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={publishSettings.stripRelationshipTags !== false}
                      onChange={(e) =>
                        handleUpdatePrivacySetting({ stripRelationshipTags: e.target.checked })
                      }
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <span className="font-semibold text-slate-200 block">
                        Strip XFN Relationship Tags from Exported JSON
                      </span>
                      <span className="text-slate-400">
                        Keeps real-world tags (<code>met</code>, <code>kin</code>,{' '}
                        <code>colleague</code>, <code>muse</code>) in local SQLite only and strips
                        them from public JSON.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(publishSettings.publishEndorsements)}
                      onChange={(e) =>
                        handleUpdatePrivacySetting({ publishEndorsements: e.target.checked })
                      }
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <span className="font-semibold text-slate-200 block">
                        Publish Back-Endorsements in <code>/api/connections.json</code>
                      </span>
                      <span className="text-slate-400">
                        When unchecked, discovered likes/shares from peers remain visible in your
                        Studio without republishing peer interaction edges.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer md:col-span-2">
                    <input
                      type="checkbox"
                      checked={Boolean(publishSettings.redactItemSourceAuthors)}
                      onChange={(e) =>
                        handleUpdatePrivacySetting({ redactItemSourceAuthors: e.target.checked })
                      }
                      className="mt-0.5 accent-indigo-500"
                    />
                    <div>
                      <span className="font-semibold text-slate-200 block">
                        Redact Peer Author Attribution in <code>/api/items.json</code>
                      </span>
                      <span className="text-slate-400">
                        Strips <code>targetAuthorUrl</code>, <code>targetAuthorName</code>, and{' '}
                        <code>viaUrl</code> from exported items so shared links do not reveal which
                        friend you discovered them from.
                      </span>
                    </div>
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Add Friend Form */}
                <form
                  onSubmit={handleAddFriend}
                  className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4"
                >
                  <h3 className="font-bold text-base flex items-center gap-2">
                    <UserPlus className="w-4 h-4 text-emerald-400" /> Add Friend Profile Site
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Friend's Website URL</label>
                      <input
                        type="text"
                        required
                        value={friendSiteUrl}
                        onChange={(e) => setFriendSiteUrl(e.target.value)}
                        placeholder="https://friend.example"
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Display Name</label>
                      <input
                        type="text"
                        required
                        value={friendName}
                        onChange={(e) => setFriendName(e.target.value)}
                        placeholder="Devon K."
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Relationship Tags (Local SQLite)
                      </label>
                      <input
                        type="text"
                        value={friendRel}
                        onChange={(e) => setFriendRel(e.target.value)}
                        placeholder="friend, met, colleague, muse"
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Connection Visibility
                      </label>
                      <select
                        value={friendVisibility}
                        onChange={(e) => setFriendVisibility(e.target.value as FriendVisibility)}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      >
                        <option value="private">🔒 Private (Local Crawler Only)</option>
                        <option value="public">🌐 Public (Allow on Blogroll)</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Avatar URL (Optional)</label>
                      <input
                        type="text"
                        value={friendAvatar}
                        onChange={(e) => setFriendAvatar(e.target.value)}
                        placeholder="https://..."
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Short Bio Note</label>
                      <input
                        type="text"
                        value={friendBio}
                        onChange={(e) => setFriendBio(e.target.value)}
                        placeholder="How you know them..."
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs"
                  >
                    + Add Friend to Local Ring
                  </button>
                </form>

                {/* Join a Webring (curated: verify the hub, then send the maintainer a signed request) */}
                <form
                  onSubmit={handleRequestToJoinRing}
                  className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4"
                >
                  <h3 className="font-bold text-base flex items-center gap-2">
                    <Layers className="w-4 h-4 text-indigo-400" /> Join a Webring
                  </h3>
                  <p className="text-xs text-slate-400">
                    Paste the ring's hub address (from its directory page or a member's{' '}
                    <strong>Join Ring</strong> link). Studio checks the ring's signature and creates a
                    private, signed request link for you to send the ring's maintainer. Publish your
                    site first so the maintainer can verify it.
                  </p>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Ring Hub URL (https)</label>
                    <input
                      type="url"
                      required
                      value={ringHubUrl}
                      onChange={(e) => setRingHubUrl(e.target.value)}
                      placeholder="https://maintainer.example/api/rings/photo-ring.json"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isJoiningRing}
                    className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-semibold text-xs"
                  >
                    {isJoiningRing ? 'Checking ring...' : 'Check Ring & Request to Join'}
                  </button>
                  {lastRequestLink && (
                    <div className="p-3 rounded-xl bg-indigo-950/40 border border-indigo-500/30 space-y-2 text-xs">
                      <p className="text-indigo-200">
                        Send this link to the maintainer of <strong>{lastRequestLink.ringName}</strong>{' '}
                        (email, chat, anything). You'll appear in the ring after they approve it and
                        publish, and you next sync.
                      </p>
                      <div className="flex gap-2">
                        <code className="flex-1 truncate px-2 py-1 rounded bg-slate-950 text-slate-300">
                          {lastRequestLink.link}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(lastRequestLink.link);
                            notify('Copied request link.');
                          }}
                          className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3" /> Copy
                        </button>
                      </div>
                    </div>
                  )}
                </form>
              </div>

              {/* Joined Webrings List (edit the banner text shown on your site) */}
              {joinedRings.length > 0 && (
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <h3 className="font-bold text-lg">
                      Rings You've Joined ({joinedRings.length})
                    </h3>
                    <p className="text-xs text-slate-400">
                      Rings marked <strong>Member</strong> show as a bar on your site. Sync All
                      refreshes them.
                    </p>
                  </div>
                  <div className="space-y-3">
                    {joinedRings.map((ring) => {
                      const isEditing = editingRingId === ring.id;
                      const statusStyle: Record<JoinedRingStatus, string> = {
                        member: 'bg-emerald-500/20 text-emerald-300',
                        requested: 'bg-amber-500/20 text-amber-300',
                        removed: 'bg-rose-500/20 text-rose-300',
                        closed: 'bg-slate-700 text-slate-300',
                        legacy: 'bg-slate-700 text-slate-300',
                      };
                      const statusLabel: Record<JoinedRingStatus, string> = {
                        member: 'Member',
                        requested: 'Requested',
                        removed: 'Removed by maintainer',
                        closed: 'Ring closed',
                        legacy: 'Unverified (older ring)',
                      };
                      return (
                        <div
                          key={ring.id}
                          className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3"
                        >
                          {isEditing ? (
                            <>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-xs text-slate-400 mb-1">Webring Name</label>
                                  <input
                                    type="text"
                                    value={editRingDraft.name}
                                    onChange={(e) =>
                                      setEditRingDraft((prev) => ({ ...prev, name: e.target.value }))
                                    }
                                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs text-slate-400 mb-1">Webring Hub JSON URL</label>
                                  <input
                                    type="text"
                                    value={editRingDraft.hubUrl}
                                    onChange={(e) =>
                                      setEditRingDraft((prev) => ({ ...prev, hubUrl: e.target.value }))
                                    }
                                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                                  />
                                </div>
                              </div>
                              <div>
                                <label className="block text-xs text-slate-400 mb-1">Description</label>
                                <input
                                  type="text"
                                  value={editRingDraft.description}
                                  onChange={(e) =>
                                    setEditRingDraft((prev) => ({ ...prev, description: e.target.value }))
                                  }
                                  placeholder="A circle of independent creators..."
                                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                                />
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-xs text-slate-400 mb-1">Previous Neighbor URL</label>
                                  <input
                                    type="text"
                                    value={editRingDraft.prevSiteUrl}
                                    onChange={(e) =>
                                      setEditRingDraft((prev) => ({ ...prev, prevSiteUrl: e.target.value }))
                                    }
                                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs text-slate-400 mb-1">Next Neighbor URL</label>
                                  <input
                                    type="text"
                                    value={editRingDraft.nextSiteUrl}
                                    onChange={(e) =>
                                      setEditRingDraft((prev) => ({ ...prev, nextSiteUrl: e.target.value }))
                                    }
                                    className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                                  />
                                </div>
                              </div>
                              <div className="flex items-center gap-2 pt-1">
                                <button
                                  type="button"
                                  onClick={handleSaveEditWebring}
                                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center gap-1.5"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  Save Changes
                                </button>
                                <button
                                  type="button"
                                  onClick={handleCancelEditWebring}
                                  className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium"
                                >
                                  Cancel
                                </button>
                              </div>
                            </>
                          ) : (
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 text-[10px] font-bold tracking-wide">
                                    WEBRING
                                  </span>
                                  <h4 className="font-bold text-sm truncate">{ring.name}</h4>
                                </div>
                                {ring.description && (
                                  <p className="text-xs text-slate-400 mt-1">— {ring.description}</p>
                                )}
                                <p className="text-xs text-indigo-400 font-mono truncate mt-1">{ring.hubUrl}</p>
                                <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[11px] text-slate-400">
                                  <span className={`px-2 py-0.5 rounded-full font-medium ${statusStyle[ring.status]}`}>
                                    {statusLabel[ring.status]}
                                  </span>
                                  {ring.status === 'member' && (
                                    <span>
                                      {ring.memberCount} member{ring.memberCount === 1 ? '' : 's'}
                                      {ring.hubVerified ? ' · ✓ signed hub' : ' · unsigned hub'}
                                    </span>
                                  )}
                                  <span>
                                    {ring.lastSyncedAt
                                      ? `Synced ${formatRelativeTime(ring.lastSyncedAt)}`
                                      : 'Not synced yet'}
                                  </span>
                                </div>
                                {ring.syncWarning && (
                                  <p className="text-[11px] text-amber-300 mt-1">⚠ {ring.syncWarning}</p>
                                )}
                                {ring.status === 'requested' && (
                                  <p className="text-[11px] text-slate-400 mt-1">
                                    Waiting for the maintainer. Send them your request link, then use
                                    Sync All after they approve and publish.
                                  </p>
                                )}
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                {ring.status === 'requested' && ring.requestToken && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      navigator.clipboard.writeText(
                                        `webring://ring-request?token=${encodeURIComponent(ring.requestToken!)}`
                                      );
                                      notify('Copied request link.');
                                    }}
                                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1"
                                  >
                                    <Copy className="w-3 h-3" /> Request Link
                                  </button>
                                )}
                                {ring.status === 'legacy' && (
                                  <button
                                    type="button"
                                    onClick={() => handleStartEditWebring(ring)}
                                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium"
                                  >
                                    Edit
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleDeleteWebring(ring)}
                                  className="px-2.5 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/30 text-rose-300"
                                  title="Leave this webring (removes its banner from your site)"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Rings this persona maintains */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-bold text-lg">Rings You Host ({hostedRings.length})</h3>
                  <p className="text-xs text-slate-400">
                    Each ring is published as a signed hub plus a directory page. Changes go live when
                    you publish.
                  </p>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <form
                    onSubmit={handleCreateHostedRing}
                    className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3"
                  >
                    <h4 className="font-bold text-sm">Start a New Ring</h4>
                    <input
                      type="text"
                      required
                      value={newHostedRingName}
                      onChange={(e) => setNewHostedRingName(e.target.value)}
                      placeholder="Analog Photo Ring"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                    />
                    <input
                      type="text"
                      value={newHostedRingDesc}
                      onChange={(e) => setNewHostedRingDesc(e.target.value)}
                      placeholder="What the ring is about"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                    />
                    <button
                      type="submit"
                      className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs"
                    >
                      + Create Ring
                    </button>
                  </form>

                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
                    <h4 className="font-bold text-sm">Review a Join Request</h4>
                    <p className="text-xs text-slate-400">
                      Paste the <code>webring://ring-request</code> link an applicant sent you. Studio
                      checks their signature against their site before you decide.
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={ringRequestLink}
                        onChange={(e) => setRingRequestLink(e.target.value)}
                        placeholder="webring://ring-request?token=..."
                        className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => handleReviewRingRequest()}
                        className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium"
                      >
                        Check
                      </button>
                    </div>
                    {ringRequestError && <p className="text-xs text-rose-300">⚠ {ringRequestError}</p>}
                    {ringRequestReview && (
                      <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2 text-xs">
                        <p>
                          <strong>{ringRequestReview.applicant.displayName}</strong>{' '}
                          <span className="font-mono text-indigo-300">{ringRequestReview.applicant.siteUrl}</span>{' '}
                          wants to join <strong>{ringRequestReview.ring.name}</strong>.{' '}
                          <span className="text-emerald-300">✓ Signature verified</span>
                        </p>
                        {ringRequestReview.state === 'already-member' && (
                          <p className="text-slate-400">They're already a member.</p>
                        )}
                        {ringRequestReview.state === 'banned' && (
                          <p className="text-rose-300">
                            This site is banned from the ring
                            {ringRequestReview.banReason ? ` (${ringRequestReview.banReason})` : ''}.
                            Unban them below to approve.
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {ringRequestReview.state === 'new' && (
                            <button
                              type="button"
                              onClick={() => handleDecideRingRequest('approve')}
                              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                            >
                              Approve
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleDecideRingRequest('decline')}
                            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700"
                          >
                            Decline
                          </button>
                          {ringRequestReview.state !== 'banned' && (
                            <button
                              type="button"
                              onClick={() => handleDecideRingRequest('ban')}
                              className="px-3 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/30 text-rose-300"
                            >
                              Ban
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {hostedRings.map((ring) => (
                  <div key={ring.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="font-bold text-sm">{ring.name}</h4>
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                              ring.status === 'active'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-slate-700 text-slate-300'
                            }`}
                          >
                            {ring.status === 'active' ? 'Active' : 'Closed'}
                          </span>
                        </div>
                        {ring.description && <p className="text-xs text-slate-400 mt-0.5">{ring.description}</p>}
                        <p className="text-[11px] font-mono text-indigo-300 truncate mt-1">{ring.hubUrl}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(ring.hubUrl);
                            notify('Copied hub URL. Share it (or your directory page) with people who want to join.');
                          }}
                          className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3" /> Hub URL
                        </button>
                        <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800">
                          <input
                            type="checkbox"
                            checked={ring.maintainerIsMember}
                            onChange={(e) => handleUpdateHostedRing(ring, { maintainerIsMember: e.target.checked })}
                            className="accent-indigo-500"
                          />
                          I'm a member
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            handleUpdateHostedRing(ring, { status: ring.status === 'active' ? 'closed' : 'active' })
                          }
                          className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700"
                        >
                          {ring.status === 'active' ? 'Close Ring' : 'Reopen'}
                        </button>
                      </div>
                    </div>

                    {ring.members.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        No other members yet. Share the hub URL, then review the request links people send you.
                      </p>
                    ) : (
                      <ul className="divide-y divide-slate-800 text-xs">
                        {ring.members.map((member, idx) => (
                          <li key={member.siteUrl} className="py-2 flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <span className="font-medium">{member.displayName}</span>{' '}
                              <span className="font-mono text-slate-400">{member.siteUrl}</span>
                              <div className="text-[11px] text-slate-500">
                                {member.confirmedAt
                                  ? `Confirmed${member.lastVerifiedAt ? ` · checked ${formatRelativeTime(member.lastVerifiedAt)}` : ''}`
                                  : 'Approved, waiting for them to publish the ring'}
                                {member.hidden && ' · hidden from Prev/Next/Random'}
                                {member.flagged && (
                                  <span className="text-amber-300">
                                    {' '}· ⚠ site unreachable or key changed for over a week
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                disabled={idx === 0}
                                onClick={() => handleRingMemberAction(ring, member, 'up')}
                                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40"
                                title="Move up"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                disabled={idx === ring.members.length - 1}
                                onClick={() => handleRingMemberAction(ring, member, 'down')}
                                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40"
                                title="Move down"
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRingMemberAction(ring, member, member.hidden ? 'show' : 'hide')}
                                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700"
                                title="Hidden members stay in the ring but are skipped by Prev / Next / Random"
                              >
                                {member.hidden ? 'Show' : 'Hide'}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRingMemberAction(ring, member, 'remove')}
                                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700"
                              >
                                Remove
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRingMemberAction(ring, member, 'ban')}
                                className="px-2 py-1 rounded bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/30 text-rose-300"
                              >
                                Ban
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}

                    {ring.bans.length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-slate-400">Banned sites ({ring.bans.length}, private)</summary>
                        <ul className="mt-2 space-y-1">
                          {ring.bans.map((ban) => (
                            <li key={ban.siteUrl} className="flex items-center justify-between gap-2">
                              <span className="font-mono text-slate-400">
                                {ban.siteUrl}
                                {ban.reason ? ` · ${ban.reason}` : ''}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  handleRingMemberAction(ring, { siteUrl: ban.siteUrl, displayName: ban.siteUrl }, 'unban')
                                }
                                className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700"
                              >
                                Unban
                              </button>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ))}
              </div>

              {/* Friends List */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <h3 className="font-bold text-lg">
                    Local Ring Friends ({allFriends.length} Total •{' '}
                    {bundle.connections.friends.length} Exported to Public JSON)
                  </h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {allFriends.map((friend) => {
                    const isPublic = friend.visibility === 'public';
                    const isActuallyExported =
                      isPublic && Boolean(publishSettings.publishFriendsList);
                    return (
                      <div
                        key={friend.id}
                        className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-3"
                      >
                        <div className="flex items-start gap-3 min-w-0">
                          <img
                            src={
                              friend.avatarUrl ||
                              `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent(
                                friend.displayName
                              )}`
                            }
                            alt={friend.displayName}
                            className="w-12 h-12 rounded-full object-cover bg-slate-800 shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <h4 className="font-bold text-sm truncate">{friend.displayName}</h4>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${
                                  isActuallyExported
                                    ? 'bg-amber-500/20 text-amber-300'
                                    : 'bg-emerald-500/20 text-emerald-300'
                                }`}
                              >
                                {isActuallyExported
                                  ? '🌐 Exported'
                                  : isPublic
                                  ? '🌐 Public (Blogroll Off)'
                                  : '🔒 Private (Local Only)'}
                              </span>
                              {friend.keyStatus === 'pinned' && (
                                <span
                                  className="text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                                  title="Ed25519 Public Key Pinned via Trust-On-First-Use (TOFU)"
                                >
                                  🔐 Key Pinned (TOFU)
                                </span>
                              )}
                              {friend.keyStatus === 'changed' && (
                                <span
                                  className="text-[10px] px-2 py-0.5 rounded-full font-bold whitespace-nowrap bg-rose-500/20 text-rose-300 border border-rose-500/40"
                                  title="WARNING: Friend domain's Ed25519 key in did.json changed unexpectedly! Signatures rejected."
                                >
                                  🚨 Key Changed Warning!
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-indigo-400 font-mono truncate mt-1.5" title={friend.siteUrl}>
                              {friend.siteUrl}
                            </p>
                            <p
                              className="text-[11px] text-slate-500 mt-0.5"
                              title={friend.lastCrawledAt || undefined}
                            >
                              {friend.lastCrawledAt
                                ? `Last synced ${formatRelativeTime(friend.lastCrawledAt)}`
                                : 'Never synced'}
                              {moderationFor(friend.siteUrl) === 'mute' && ' · Muted'}
                              {moderationFor(friend.siteUrl) === 'block' && ' · Blocked'}
                            </p>
                            {friend.bio && (
                              <p className="text-xs text-slate-400 line-clamp-2 mt-1" title={friend.bio}>
                                {friend.bio}
                              </p>
                            )}
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {friend.relationship.map((r) => (
                                <span
                                  key={r}
                                  className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 whitespace-nowrap"
                                >
                                  {r}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-800">
                          <button
                            onClick={async () => {
                              const nextVis: FriendVisibility = isPublic ? 'private' : 'public';
                              await window.studioApi?.setFriendVisibility(friend.id, nextVis);
                              if (nextVis === 'public' && !publishSettings.publishFriendsList) {
                                const nextSettings = {
                                  ...publishSettings,
                                  publishFriendsList: true,
                                };
                                setPublishSettings(nextSettings);
                                await window.studioApi?.updateProfile({
                                  publishSettings: nextSettings,
                                });
                              }
                              await refreshStudioData();
                              notify(
                                `${friend.displayName} is now ${
                                  nextVis === 'private'
                                    ? 'Private (Local Crawler Only — hidden from connections.json)'
                                    : 'Public (Exported to connections.json & profile site)'
                                }`
                              );
                            }}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs"
                            title="Toggle whether this friend is exported to public connections.json or kept local-only"
                          >
                            {isPublic ? 'Make Private' : 'Make Public'}
                          </button>
                          <button
                            onClick={async () => {
                              notify(`Crawling ${friend.siteUrl}...`);
                              const res = await window.studioApi?.crawlFriend(friend.siteUrl);
                              await refreshStudioData();
                              if (res?.success) {
                                notify(
                                  `Synced ${friend.displayName}: ${res.itemsIndexed} items indexed` +
                                    (res.entriesPruned ? `, ${res.entriesPruned} removed` : '') +
                                    (res.entriesRejected
                                      ? `, ${res.entriesRejected} spoofed entries rejected`
                                      : '') +
                                    '.'
                                );
                              } else if (res?.blocked) {
                                notify(`${friend.displayName} is blocked, so their site wasn't crawled.`);
                              } else {
                                notify(
                                  `Couldn't sync ${friend.siteUrl}: ${res?.error || 'site unreachable'}`
                                );
                              }
                            }}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs flex items-center gap-1"
                          >
                            <RefreshCw className="w-3 h-3" /> Sync JSON
                          </button>
                          <select
                            value={moderationFor(friend.siteUrl) || ''}
                            onChange={(e) =>
                              handleSetModeration(
                                friend.siteUrl,
                                friend.displayName,
                                (e.target.value || null) as ModerationAction | null
                              )
                            }
                            className="px-2 py-1.5 rounded-lg bg-slate-800 text-xs"
                            title="Mute hides this friend from your feed. Block also drops their endorsements from your published site and stops crawling them."
                          >
                            <option value="">Visible</option>
                            <option value="mute">Muted</option>
                            <option value="block">Blocked</option>
                          </select>
                          <button
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  `Remove ${friend.displayName}? Their crawled posts and endorsements are deleted too.`
                                )
                              ) {
                                return;
                              }
                              await window.studioApi?.deleteFriend(friend.id);
                              await refreshStudioData();
                            }}
                            className="ml-auto text-slate-500 hover:text-rose-400 p-1"
                            title={`Remove ${friend.displayName}`}
                            aria-label={`Remove ${friend.displayName}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: NEIGHBORHOOD FEED (PULL FEDERATION) */}
          {activeTab === 'feed' && (
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold">Neighborhood Ring Feed</h2>
                  <p className="text-sm text-slate-400 mt-1">
                    Chronological, algorithm-free updates pulled directly from your friends' static{' '}
                    <code>/api/albums.json</code> and <code>/api/items.json</code> endpoints.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex rounded-xl bg-slate-900 border border-slate-800 p-1 text-xs" role="tablist" aria-label="Show posts from">
                    {(
                      [
                        ['friends', 'Friends only'],
                        ['everyone', 'Everyone'],
                        ['me', 'Just me'],
                        ['saved', `Saved${savedPosts.length ? ` (${savedPosts.length})` : ''}`],
                      ] as const
                    ).map(([scope, label]) => (
                      <button
                        key={scope}
                        type="button"
                        role="tab"
                        aria-selected={feedScope === scope}
                        onClick={() => setFeedScope(scope)}
                        className={`px-3 py-1.5 rounded-lg font-medium transition ${
                          feedScope === scope ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-slate-400" title="How long friends' posts stay in your feed">
                    Keep
                    <select
                      value={feedRetentionDays}
                      onChange={(e) => handleSetFeedRetention(Number(e.target.value))}
                      className="px-2 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200"
                    >
                      <option value={7}>1 week</option>
                      <option value={30}>1 month</option>
                      <option value={90}>3 months</option>
                      <option value={365}>1 year</option>
                      <option value={0}>Forever</option>
                    </select>
                  </label>
                  <button
                    onClick={handleSyncAllFriends}
                    disabled={isSyncingFriends}
                    className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white font-semibold text-xs flex items-center gap-2 shadow"
                  >
                    <RefreshCw className={`w-4 h-4 ${isSyncingFriends ? 'animate-spin' : ''}`} />
                    {isSyncingFriends ? 'Syncing...' : 'Sync All Friends Now'}
                  </button>
                </div>
              </div>

              <p className="text-xs text-slate-400">
                Showing {visibleFeed.length} entr{visibleFeed.length === 1 ? 'y' : 'ies'} from{' '}
                {new Set(visibleFeed.map((e) => e.friendSiteUrl)).size} site(s)
                {feedExclusions.muted + feedExclusions.blocked > 0 &&
                  ` · ${feedExclusions.muted + feedExclusions.blocked} hidden (muted ${feedExclusions.muted}, blocked ${feedExclusions.blocked})`}
                {feedExclusions.unverified > 0 &&
                  ` · ${feedExclusions.unverified} shown without a verified signature`}
                . Feed entries are never published; blocked sites' endorsements and unverified
                endorsements are also left out of your exported site.
              </p>

              {moderation.length > 0 && (
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Muted & Blocked Sites
                  </h3>
                  {moderation.map((m) => (
                    <div key={m.siteUrl} className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-mono text-slate-300 truncate">{m.siteUrl}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`px-2 py-0.5 rounded-full font-medium ${
                            m.action === 'block'
                              ? 'bg-rose-500/20 text-rose-300'
                              : 'bg-amber-500/20 text-amber-300'
                          }`}
                        >
                          {m.action === 'block' ? 'Blocked' : 'Muted'}
                        </span>
                        <button
                          onClick={() => handleSetModeration(m.siteUrl, m.siteUrl, null)}
                          className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700"
                        >
                          {m.action === 'block' ? 'Unblock' : 'Unmute'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {feedScope === 'saved' ? (
                <SavedPostsView
                  saved={savedPosts}
                  mediaSrc={mediaSrc}
                  onOpen={(url) => window.studioApi?.openExternal(url)}
                  onRemove={async (saved) => {
                    if (!window.studioApi) return;
                    if (!window.confirm(`Remove "${saved.title}" from Saved? Its local image copy is deleted too.`)) return;
                    await window.studioApi.unsavePost(saved.id);
                    await refreshStudioData();
                  }}
                  onSaveNote={async (saved, note) => {
                    await window.studioApi?.updateSavedNote(saved.id, note);
                    setSavedPosts((prev) => prev.map((s) => (s.id === saved.id ? { ...s, note } : s)));
                  }}
                />
              ) : visibleFeed.length === 0 ? (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center space-y-3">
                  <Radio className="w-10 h-10 text-indigo-400 mx-auto" />
                  {feedScope === 'me' ? (
                    <>
                      <h3 className="font-bold text-base">You haven't posted yet</h3>
                      <p className="text-xs text-slate-400 max-w-md mx-auto">
                        Your wall posts, likes, shares and photos appear here once you add them.
                      </p>
                    </>
                  ) : (
                    <>
                      <h3 className="font-bold text-base">Your Neighborhood Feed is Ready</h3>
                      <p className="text-xs text-slate-400 max-w-md mx-auto">
                        Add friends in <strong>Friends &amp; Webrings</strong>, then click{' '}
                        <strong>"Sync All Friends Now"</strong> above to pull their signed posts and
                        photos into your feed.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {visibleFeed
                    .map((entry) => {
                      const peerComments = networkFeed.filter(
                        (c) => c.entryType === 'comment' && c.targetUrl === entry.canonicalUrl
                      );
                      const myComments = bundle.items.items.filter(
                        (c) => c.type === 'comment' && c.targetUrl === entry.canonicalUrl
                      );

                      return (
                        <div
                          key={entry.id}
                          className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4"
                        >
                          <div className="space-y-2 min-w-0">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <img
                                  src={
                                    entry.friendAvatarUrl ||
                                    `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent(
                                      entry.friendName
                                    )}`
                                  }
                                  alt={entry.friendName}
                                  className="w-8 h-8 rounded-full object-cover shrink-0"
                                />
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-bold text-sm">{entry.friendName}</span>
                                    {entry.isMine ? (
                                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-semibold">
                                        You
                                      </span>
                                    ) : (
                                      entry.verifiedSignature && (
                                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-mono">
                                          ✓ Verified DID Signature
                                        </span>
                                      )
                                    )}
                                  </div>
                                  <p className="text-[11px] text-slate-400 font-mono truncate">
                                    {entry.friendSiteUrl}
                                  </p>
                                  {!entry.isMine && (
                                  <div className="flex gap-2 mt-0.5 text-[10px]">
                                    <button
                                      onClick={() =>
                                        handleSetModeration(entry.friendSiteUrl, entry.friendName, 'mute')
                                      }
                                      className="text-slate-500 hover:text-amber-300"
                                    >
                                      Mute
                                    </button>
                                    <button
                                      onClick={() =>
                                        handleSetModeration(entry.friendSiteUrl, entry.friendName, 'block')
                                      }
                                      className="text-slate-500 hover:text-rose-300"
                                    >
                                      Block
                                    </button>
                                  </div>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                              {!entry.isMine && (
                                <button
                                  type="button"
                                  onClick={() => handleToggleSaved(entry)}
                                  className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                                    savedByUrl.has(entry.canonicalUrl)
                                      ? 'bg-amber-500/20 text-amber-300'
                                      : 'text-slate-400 hover:text-amber-300'
                                  }`}
                                  title={savedByUrl.has(entry.canonicalUrl) ? 'Remove from Saved' : 'Save a private copy'}
                                >
                                  {savedByUrl.has(entry.canonicalUrl) ? '★ Saved' : '☆ Save'}
                                </button>
                              )}
                              <span
                                className={`text-xs uppercase font-bold px-2.5 py-0.5 rounded-full shrink-0 ${
                                  entry.entryType === 'post'
                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                    : 'bg-indigo-500/20 text-indigo-300'
                                }`}
                              >
                                {entry.entryType === 'post' ? '📝 Wall Post' : entry.entryType}
                              </span>
                              </div>
                            </div>

                            {entry.mediaUrl && (
                              <img
                                src={entry.mediaUrl}
                                alt={entry.title}
                                className="w-full max-h-72 object-cover rounded-xl mt-2"
                              />
                            )}

                            <h4 className="font-bold text-base pt-1">{entry.title}</h4>
                            {entry.entryType === 'post' ? (
                              // Friends' posts are Markdown too; the renderer escapes everything first
                              <div
                                className="studio-prose text-sm text-slate-300"
                                dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.commentary) }}
                              />
                            ) : (
                              <p className="text-sm text-slate-300 whitespace-pre-line">{entry.commentary}</p>
                            )}
                            <p className="text-xs font-mono text-indigo-400 truncate">
                              Indexed Target: {entry.targetUrl}
                            </p>

                            {entry.isMine ? (
                              <div className="flex flex-wrap gap-2 pt-1">
                                <button
                                  onClick={() => window.studioApi?.openExternal(entry.friendSiteUrl)}
                                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1"
                                  title="Opens your published site (as of your last publish)"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" /> View my site
                                </button>
                                <button
                                  onClick={() => handleDeleteMyFeedEntry(entry)}
                                  className="px-3 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/30 text-rose-300 text-xs font-medium flex items-center gap-1"
                                >
                                  <Trash2 className="w-3.5 h-3.5" /> Delete
                                </button>
                              </div>
                            ) : (
                            <div className="flex flex-wrap gap-2 pt-1">
                              <button
                                onClick={() =>
                                  handleIncomingDeepLink({
                                    action: 'like',
                                    targetUrl: entry.canonicalUrl,
                                    title: entry.title,
                                    authorName: entry.friendName,
                                    authorUrl: entry.friendSiteUrl,
                                    mediaUrl: entry.mediaUrl,
                                  })
                                }
                                className="px-3 py-1.5 rounded-lg bg-pink-500/20 text-pink-300 hover:bg-pink-500/30 text-xs font-medium flex items-center gap-1"
                              >
                                <Heart className="w-3.5 h-3.5" /> Like
                              </button>
                              <button
                                onClick={() =>
                                  handleIncomingDeepLink({
                                    action: 'comment',
                                    targetUrl: entry.canonicalUrl,
                                    title: entry.title,
                                    authorName: entry.friendName,
                                    authorUrl: entry.friendSiteUrl,
                                  })
                                }
                                className="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 text-xs font-medium flex items-center gap-1"
                              >
                                <MessageSquare className="w-3.5 h-3.5" /> Comment
                              </button>
                              <button
                                onClick={() =>
                                  handleIncomingDeepLink({
                                    action: 'share',
                                    targetUrl: entry.targetUrl,
                                    title: entry.title,
                                    authorName: entry.friendName,
                                    authorUrl: entry.friendSiteUrl,
                                    mediaUrl: entry.mediaUrl,
                                  })
                                }
                                className="px-3 py-1.5 rounded-lg bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 text-xs font-medium flex items-center gap-1"
                              >
                                <Repeat2 className="w-3.5 h-3.5" /> Re-share
                              </button>
                            </div>
                            )}
                          </div>

                          {/* Threaded Comments Under This Feed Post */}
                          {(peerComments.length > 0 || myComments.length > 0) && (
                            <div className="pt-3 border-t border-slate-800 space-y-2">
                              <p className="text-xs font-bold text-slate-400 flex items-center gap-1.5">
                                <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />
                                Threaded Ring Comments ({peerComments.length + myComments.length})
                              </p>
                              {peerComments.map((c) => (
                                <div
                                  key={c.id}
                                  className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs space-y-1"
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="font-bold text-indigo-300">
                                      {c.friendName} ({c.friendSiteUrl})
                                    </span>
                                    <span className="text-[10px] text-slate-500">
                                      {new Date(c.createdAt).toLocaleDateString()}
                                    </span>
                                  </div>
                                  <p className="text-slate-200 whitespace-pre-line">
                                    {c.commentary}
                                  </p>
                                </div>
                              ))}
                              {myComments.map((c) => (
                                <div
                                  key={c.id}
                                  className="p-3 rounded-xl bg-emerald-950/20 border border-emerald-500/30 text-xs space-y-1"
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="font-bold text-emerald-300">
                                      {bundle.profile.displayName} (You)
                                    </span>
                                    <span className="text-[10px] text-slate-500">
                                      {new Date(c.createdAt).toLocaleDateString()}
                                    </span>
                                  </div>
                                  <p className="text-slate-200 whitespace-pre-line">
                                    {c.commentary}
                                  </p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          {/* TAB 6: LIVE SITE PREVIEW */}
          {activeTab === 'preview' && (
            <div className="grid grid-cols-1 xl:grid-cols-[22rem_1fr] gap-5 items-start">
              <SiteDesignPanel
                theme={bundle.profile.theme}
                appearance={bundle.profile.appearance}
                layout={bundle.profile.layout}
                albums={bundle.albums.albums}
                items={bundle.items.items}
                publishFriendsList={Boolean(publishSettings.publishFriendsList)}
                guestbookConfigured={Boolean(bundle.profile.commentConfig && bundle.profile.commentConfig.provider !== 'none')}
                mediaSrc={mediaSrc}
                onSave={async (updates) => {
                  if (!window.studioApi) return;
                  await window.studioApi.updateProfile(updates);
                  await refreshStudioData();
                }}
              />
            <div className="space-y-4 min-w-0">
              {/* Top Preview Mode & Local Test Export Bar */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPreviewRenderMode('studio')}
                      className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 ${
                        previewRenderMode === 'studio'
                          ? 'bg-indigo-600 text-white shadow'
                          : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                      }`}
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Studio Interactive Preview
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!testExportResult) {
                          await handleRunTestExportPreview(false);
                        } else {
                          setPreviewRenderMode('exported-http');
                        }
                      }}
                      className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition flex items-center gap-1.5 ${
                        previewRenderMode === 'exported-http'
                          ? 'bg-emerald-600 text-white shadow'
                          : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
                      }`}
                    >
                      <Globe className="w-3.5 h-3.5" />
                      Test-Exported Static Build (Local HTTP Server)
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleRunTestExportPreview(false)}
                      className="px-3.5 py-2 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 font-semibold text-xs flex items-center gap-1.5 transition"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      {testExportResult ? 'Rebuild Local Test Export' : 'Run Local Test Export'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRunTestExportPreview(true)}
                      className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow transition"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Test Export & Open in Browser
                    </button>
                  </div>
                </div>

                {/* Test Export Pre-Publish Verification Report */}
                {testExportResult && (
                  <div className="p-3.5 rounded-xl bg-slate-950 border border-emerald-500/30 space-y-2.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold text-[11px]">
                          ✓ LOCAL TEST BUILD READY
                        </span>
                        <span className="text-slate-300">
                          Serving exported files on loopback HTTP server:
                        </span>
                        <button
                          type="button"
                          onClick={() => window.studioApi?.openExternal(testExportResult.previewUrl)}
                          className="font-mono text-indigo-400 hover:text-indigo-300 underline font-semibold flex items-center gap-1"
                        >
                          {testExportResult.previewUrl}
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            window.studioApi?.openExternal(
                              `${testExportResult.previewUrl}api/manifest.json`
                            )
                          }
                          className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 font-mono text-[11px] text-slate-300"
                        >
                          /api/manifest.json ↗
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            window.studioApi?.openExternal(
                              `${testExportResult.previewUrl}.well-known/did.json`
                            )
                          }
                          className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 font-mono text-[11px] text-slate-300"
                        >
                          /.well-known/did.json ↗
                        </button>
                        <button
                          type="button"
                          onClick={() => window.studioApi?.openPath(testExportResult.outputDir)}
                          className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-200 font-medium flex items-center gap-1"
                        >
                          <FolderOutput className="w-3 h-3" />
                          Open Test Folder
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400 pt-1 border-t border-slate-800/80">
                      <span className="text-emerald-400 font-medium">
                        {testExportResult.checks.hasIndexHtml ? '✓ index.html' : '✗ index.html'}
                      </span>
                      <span className="text-emerald-400 font-medium">
                        {testExportResult.checks.hasNoJekyll
                          ? '✓ .nojekyll (GitHub Pages ready)'
                          : '✗ .nojekyll'}
                      </span>
                      <span className="text-emerald-400 font-medium">
                        {testExportResult.checks.hasDidJson
                          ? '✓ did.json & /.well-known/did.json (Ed25519 Signed)'
                          : '✗ did.json'}
                      </span>
                      <span>
                        • Files Written: <strong>{testExportResult.filesWritten.length}</strong> (
                        {testExportResult.filesWritten
                          .map((f) => `${f.relativePath} (${(f.sizeBytes / 1024).toFixed(1)} KB)`)
                          .join(', ')}
                        )
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 pt-1">
                  <span>
                    {previewRenderMode === 'exported-http' && testExportResult ? (
                      <>
                        <strong>Live Exported Site Preview:</strong> Rendering the actual exported{' '}
                        <code>index.html</code> and fetching <code>/api/*.json</code> over{' '}
                        <code>{testExportResult.previewUrl}</code> exactly as visitors will see it
                        after publishing.
                      </>
                    ) : (
                      <>
                        <strong>Interactive Preview:</strong> Clicking any <em>Like</em>,{' '}
                        <em>Share</em>, or <em>Add Friend</em> button below simulates a{' '}
                        <code>webring://</code> protocol action inside the Studio.
                      </>
                    )}
                  </span>
                  <span className="font-mono text-indigo-400">Theme: {bundle.profile.theme}</span>
                </div>
              </div>

              <div className="rounded-2xl overflow-hidden border border-slate-800 shadow-2xl bg-slate-950">
                {previewRenderMode === 'exported-http' && testExportResult ? (
                  <iframe
                    key={`${testExportResult.previewUrl}-${iframeRefreshKey}`}
                    src={testExportResult.previewUrl}
                    title="Exported Static Profile Site Preview"
                    className="w-full h-[75vh] border-0 bg-slate-950"
                  />
                ) : (
                  <iframe
                    ref={previewFrameRef}
                    srcDoc={previewHtml}
                    sandbox="allow-scripts"
                    title="Site preview"
                    className="w-full h-[75vh] border-0 bg-slate-950"
                  />
                )}
              </div>
            </div>
            </div>
          )}

          {/* TAB 7: JSON SCHEMA INSPECTOR */}
          {activeTab === 'schemas' && (
            <div className="max-w-5xl mx-auto space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold">Standardized JSON Schema Output</h2>
                  <p className="text-sm text-slate-400 mt-1">
                    Inspect the live signed JSON documents that power your profile site and allow
                    other Webring Studio clients and ATProto bridges to index your content.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      { id: 'manifest', label: '/api/manifest.json' },
                      { id: 'did', label: '/.well-known/did.json' },
                      { id: 'profile', label: '/api/profile.json' },
                      { id: 'albums', label: '/api/albums.json' },
                      { id: 'items', label: '/api/items.json' },
                      { id: 'connections', label: '/api/connections.json' },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setSelectedSchemaFile(tab.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-mono transition ${
                        selectedSchemaFile === tab.id
                          ? 'bg-indigo-600 text-white'
                          : 'bg-slate-900 text-slate-400 hover:bg-slate-800'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
                <div className="px-4 py-2.5 bg-slate-950 border-b border-slate-800 flex items-center justify-between text-xs font-mono text-slate-400">
                  <span>Signed with Ed25519Signature2020 ({bundle.profile.did}#key-1)</span>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(
                        JSON.stringify(getSelectedSchemaJson(), null, 2)
                      );
                      notify('Copied JSON document to clipboard!');
                    }}
                    className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300"
                  >
                    <Copy className="w-3.5 h-3.5" /> Copy JSON
                  </button>
                </div>
                <pre className="p-5 text-xs font-mono text-emerald-300 overflow-x-auto max-h-[65vh]">
                  {JSON.stringify(getSelectedSchemaJson(), null, 2)}
                </pre>
              </div>
            </div>
          )}

          {/* TAB 8: PUBLISH & SFTP */}
          {activeTab === 'publish' && (
            <div className="max-w-4xl mx-auto space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold">Publish Static Profile Website & JSON Feeds</h2>
                  <p className="text-sm text-slate-400 mt-1">
                    Export your self-contained profile website and signed JSON endpoints to a local
                    folder (for GitHub Pages, Neocities, Netlify, or any HTTP host) or upload directly
                    via built-in SFTP/FTP.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setHelpSection('github-pages');
                    setActiveTab('help');
                  }}
                  className="px-3.5 py-2 rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/30 text-indigo-300 font-semibold text-xs flex items-center gap-1.5"
                >
                  <BookOpen className="w-4 h-4" />
                  Step-by-Step Deployment Guide
                </button>
              </div>

              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 text-sm flex flex-wrap items-center justify-between gap-3">
                {publishSettings.lastPublishedAt ? (
                  <div className="space-y-0.5">
                    <p>
                      Last published{' '}
                      <strong title={publishSettings.lastPublishedAt}>
                        {formatRelativeTime(publishSettings.lastPublishedAt)}
                      </strong>{' '}
                      <span className="text-xs text-slate-500 font-mono">
                        ({new Date(publishSettings.lastPublishedAt).toLocaleString()})
                      </span>
                    </p>
                    <p className="text-xs text-slate-400">
                      Your public site is a snapshot from that moment. Anything added since then,
                      including newly synced endorsements, appears after you publish again.
                      {publishSettings.lastPublishedCounts &&
                        ` It contains ${publishSettings.lastPublishedCounts.itemCount} items, ${publishSettings.lastPublishedCounts.photoCount} photos and ${publishSettings.lastPublishedCounts.endorsementCount} endorsements.`}
                    </p>
                  </div>
                ) : (
                  <p className="text-slate-400">Not published yet.</p>
                )}
                {publishSettings.lastPublishedAt && publishedUpToDate && (
                  <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 font-medium">
                    ✓ Up to date
                  </span>
                )}
                {publishSettings.lastPublishedAt && !publishedUpToDate && changesSinceLastPublish > 0 && (
                  <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 font-medium">
                    {changesSinceLastPublish} change{changesSinceLastPublish === 1 ? '' : 's'} since
                    last publish
                  </span>
                )}
              </div>

              {/* Scheduled sync & publish */}
              {scheduleOverview && activeSchedule && (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-bold text-base flex items-center gap-2">
                        <RefreshCw className="w-4 h-4 text-indigo-400" /> Schedule
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">
                        Keep <strong>{activeSchedule.label}</strong> synced and published automatically.
                        Schedules run while Studio is open or in the menu bar; missed runs happen once
                        when Studio is back.
                      </p>
                    </div>
                    {scheduleOverview.app.paused && (
                      <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 font-medium">
                        All schedules paused
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                      <label className="flex items-center gap-2 text-sm font-semibold">
                        <input
                          type="checkbox"
                          checked={activeSchedule.schedule.sync.enabled}
                          onChange={(e) => handleSetSchedule({ sync: { enabled: e.target.checked } })}
                          className="accent-indigo-500"
                        />
                        Sync friends &amp; rings
                      </label>
                      {renderPresetPicker(activeSchedule.schedule.sync.preset, (preset) =>
                        handleSetSchedule({ sync: { preset } })
                      )}
                      {renderJobStatus(activeSchedule.schedule.sync, activeSchedule.nextSyncAt)}
                      <button
                        type="button"
                        disabled={Boolean(runningJob)}
                        onClick={() => handleRunJobNow('sync')}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs"
                      >
                        {runningJob === 'sync' ? 'Syncing...' : 'Run now'}
                      </button>
                    </div>

                    <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                      <label className="flex items-center gap-2 text-sm font-semibold">
                        <input
                          type="checkbox"
                          checked={activeSchedule.schedule.publish.enabled}
                          onChange={(e) => handleSetSchedule({ publish: { enabled: e.target.checked } })}
                          className="accent-indigo-500"
                        />
                        Publish if anything changed
                      </label>
                      {renderPresetPicker(activeSchedule.schedule.publish.preset, (preset) =>
                        handleSetSchedule({ publish: { preset } })
                      )}
                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        <select
                          value={activeSchedule.schedule.publish.destination}
                          onChange={(e) =>
                            handleSetSchedule({
                              publish: { destination: e.target.value as 'local' | 'remote' | 'github' },
                            })
                          }
                          className="px-2 py-1.5 rounded-lg bg-slate-900 border border-slate-800"
                        >
                          <option value="local">To export folder</option>
                          <option value="remote">To SFTP / FTP host</option>
                          <option value="github">To GitHub Pages</option>
                        </select>
                        <label className="flex items-center gap-1.5 text-slate-300">
                          <input
                            type="checkbox"
                            checked={activeSchedule.schedule.publish.syncFirst}
                            onChange={(e) => handleSetSchedule({ publish: { syncFirst: e.target.checked } })}
                            className="accent-indigo-500"
                          />
                          Sync first
                        </label>
                      </div>
                      {renderJobStatus(activeSchedule.schedule.publish, activeSchedule.nextPublishAt)}
                      <button
                        type="button"
                        disabled={Boolean(runningJob)}
                        onClick={() => handleRunJobNow('publish')}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs"
                      >
                        {runningJob === 'publish' ? 'Publishing...' : 'Run now'}
                      </button>
                    </div>
                  </div>

                  {scheduleOverview.personas.length > 1 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-slate-500 text-left">
                          <tr>
                            <th className="py-1 pr-3 font-medium">Persona</th>
                            <th className="py-1 pr-3 font-medium">Sync</th>
                            <th className="py-1 font-medium">Publish</th>
                          </tr>
                        </thead>
                        <tbody className="text-slate-300">
                          {scheduleOverview.personas.map((p) => (
                            <tr key={p.personaId} className="border-t border-slate-800">
                              <td className="py-1.5 pr-3">{p.label}</td>
                              <td className="py-1.5 pr-3">
                                {p.schedule.sync.enabled
                                  ? `${p.describe.sync}${p.nextSyncAt ? ` · ${formatUpcoming(p.nextSyncAt)}` : ''}`
                                  : 'Off'}
                                {p.schedule.sync.lastResult?.status === 'failed' && (
                                  <span className="text-rose-300"> · last run failed</span>
                                )}
                              </td>
                              <td className="py-1.5">
                                {p.schedule.publish.enabled
                                  ? `${p.describe.publish}${p.nextPublishAt ? ` · ${formatUpcoming(p.nextPublishAt)}` : ''}`
                                  : 'Off'}
                                {p.schedule.publish.lastResult?.status === 'failed' && (
                                  <span className="text-rose-300"> · last run failed</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-4 text-xs text-slate-300 border-t border-slate-800 pt-4">
                    {(
                      [
                        ['runInBackground', 'Keep running in the menu bar when the window is closed'],
                        ['startAtLogin', 'Start Studio at login (in the menu bar)'],
                        ['notifyOnFailure', 'Notify me when a scheduled job fails'],
                        ['paused', 'Pause all schedules'],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={scheduleOverview.app[key]}
                          onChange={(e) => handleSetSchedule({ app: { [key]: e.target.checked } })}
                          className="accent-indigo-500"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  {!scheduleOverview.app.runInBackground && (
                    <p className="text-[11px] text-amber-300">
                      With background mode off, schedules only run while the Studio window is open.
                    </p>
                  )}
                </div>
              )}

              {/* Pre-Publish Test Export & Local Browser Preview */}
              <div className="bg-indigo-950/25 border border-indigo-500/30 rounded-2xl p-6 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300">
                      Recommended Pre-Flight Step
                    </span>
                    <h3 className="font-bold text-lg flex items-center gap-2 pt-1">
                      <Compass className="w-5 h-5 text-indigo-400" />
                      Test Export Locally & Preview Before Publishing
                    </h3>
                    <p className="text-xs text-slate-300 max-w-2xl leading-relaxed">
                      Generates a clean staging build of your static website (<code>index.html</code>,{' '}
                      <code>.nojekyll</code>, <code>/.well-known/did.json</code>, and signed{' '}
                      <code>/api/*.json</code> endpoints) and serves it on a local loopback web server (
                      <code>127.0.0.1</code>) so you can inspect and test everything in your browser
                      before deploying to GitHub Pages or SFTP/FTP.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2.5 shrink-0">
                    <button
                      type="button"
                      onClick={async () => {
                        await handleRunTestExportPreview(false);
                        setActiveTab('preview');
                      }}
                      className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow flex items-center gap-1.5 transition"
                    >
                      <Compass className="w-4 h-4" />
                      Test Export & Preview in Studio
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRunTestExportPreview(true)}
                      className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold text-xs flex items-center gap-1.5 transition"
                    >
                      <ExternalLink className="w-4 h-4 text-indigo-400" />
                      Test Export & Open in Browser
                    </button>
                  </div>
                </div>

                {testExportResult && (
                  <div className="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-emerald-400 font-semibold">
                        ✓ Active Test Server:
                      </span>
                      <button
                        type="button"
                        onClick={() => window.studioApi?.openExternal(testExportResult.previewUrl)}
                        className="font-mono text-indigo-400 hover:underline font-semibold"
                      >
                        {testExportResult.previewUrl} ↗
                      </button>
                      <span className="text-slate-500">•</span>
                      <span className="text-slate-400">
                        {testExportResult.filesWritten.length} files generated •{' '}
                        {testExportResult.checks.publicFriendsExported} public friend(s) in{' '}
                        <code>connections.json</code>
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => window.studioApi?.openPath(testExportResult.outputDir)}
                      className="text-xs text-slate-300 hover:text-white underline flex items-center gap-1"
                    >
                      <FolderOutput className="w-3.5 h-3.5" />
                      Inspect Test Files on Disk
                    </button>
                  </div>
                )}
              </div>

              {/* Option 1: Local Directory Export */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
                <h3 className="font-bold text-lg flex items-center gap-2">
                  <FolderOutput className="w-5 h-5 text-emerald-400" />
                  1. Local Folder Export (Static HTML + JSON Bundle)
                </h3>
                <p className="text-xs text-slate-400">
                  Generates <code>index.html</code>, <code>/.well-known/did.json</code>,{' '}
                  <code>/api/manifest.json</code>, <code>/api/profile.json</code>,{' '}
                  <code>/api/albums.json</code>, <code>/api/items.json</code>,{' '}
                  <code>/api/connections.json</code>, and a signed hub plus directory page for each
                  ring you host.
                </p>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={publishSettings.exportPath}
                    onChange={(e) =>
                      setPublishSettings((prev) => ({ ...prev, exportPath: e.target.value }))
                    }
                    placeholder="Default: AppData/webring-studio/exported-profile-site"
                    className="flex-1 px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                  />
                  <button
                    type="button"
                    onClick={handleChooseExportFolder}
                    className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium"
                  >
                    Choose Folder...
                  </button>
                </div>

                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={handleExportLocalSite}
                    className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs shadow flex items-center gap-2"
                  >
                    <FolderOutput className="w-4 h-4" />
                    Export Static Site Now
                  </button>
                  {publishSettings.exportPath && (
                    <button
                      type="button"
                      onClick={() => window.studioApi?.openPath(publishSettings.exportPath)}
                      className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1.5"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Open Exported Folder
                    </button>
                  )}
                </div>
              </div>

              {/* Option 2: Built-in SFTP / FTP Uploader */}
              <form
                onSubmit={handlePublishRemote}
                className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-bold text-lg flex items-center gap-2">
                      <Server className="w-5 h-5 text-indigo-400" />
                      2. Direct SFTP / FTP Web Host Uploader
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Connection settings are stored in this persona’s isolated SQLite database so
                      each persona can publish to its own web host.
                    </p>
                  </div>
                  {(publishSettings.host || publishSettings.username || publishSettings.password) && (
                    <span className="text-[11px] px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-medium flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Stored for Persona: {personas.find((p) => p.id === activePersonaId)?.label || 'Primary'}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Protocol</label>
                    <select
                      value={publishSettings.protocol}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({
                          ...prev,
                          protocol: e.target.value as 'sftp' | 'ftp',
                          port: e.target.value === 'sftp' ? 22 : 21,
                        }))
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                    >
                      <option value="sftp">SFTP (SSH File Transfer)</option>
                      <option value="ftp">FTP (Standard)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Host / Server Address</label>
                    <input
                      type="text"
                      required
                      value={publishSettings.host}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({ ...prev, host: e.target.value }))
                      }
                      placeholder="sftp.myhost.example.com"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Port</label>
                    <input
                      type="number"
                      value={publishSettings.port}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({ ...prev, port: Number(e.target.value) }))
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Username</label>
                    <input
                      type="text"
                      required
                      value={publishSettings.username}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({ ...prev, username: e.target.value }))
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Password</label>
                    <input
                      type="password"
                      value={publishSettings.password || ''}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({ ...prev, password: e.target.value }))
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Remote Web Root Path</label>
                    <input
                      type="text"
                      required
                      value={publishSettings.remotePath}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({ ...prev, remotePath: e.target.value }))
                      }
                      placeholder="/var/www/html"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/80">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={handleSaveRemoteSettings}
                      className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold text-xs flex items-center gap-1.5 transition"
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      Save SFTP / FTP Settings
                    </button>
                    <button
                      type="submit"
                      className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow flex items-center gap-2 transition"
                    >
                      <UploadCloud className="w-4 h-4" />
                      Save & Upload to Remote Host
                    </button>
                  </div>

                  {(publishSettings.host ||
                    publishSettings.username ||
                    publishSettings.password ||
                    (publishSettings.remotePath &&
                      publishSettings.remotePath !== '/var/www/html')) && (
                    <button
                      type="button"
                      onClick={handleClearRemoteSettings}
                      className="px-3.5 py-2 rounded-xl bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/30 text-rose-300 font-semibold text-xs flex items-center gap-1.5 transition"
                      title="Delete the stored SFTP/FTP server credentials from this persona's SQLite database"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete Stored SFTP / FTP Info
                    </button>
                  )}
                </div>
              </form>

              {/* Option 3: GitHub Pages Deploy */}
              <form
                onSubmit={handlePublishGithub}
                className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-bold text-lg flex items-center gap-2">
                      <Globe className="w-5 h-5 text-slate-200" />
                      3. GitHub Pages Deploy
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Pushes the generated site straight to a repo branch via the GitHub API and
                      enables Pages for it. Needs a token with <code>repo</code> scope (classic) or
                      Contents + Pages read/write (fine-grained). Stored in this persona's SQLite
                      database, same as the SFTP/FTP credentials above.
                    </p>
                  </div>
                  {(publishSettings.githubOwner || publishSettings.githubRepo) && (
                    <span className="text-[11px] px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-medium flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Stored for Persona: {personas.find((p) => p.id === activePersonaId)?.label || 'Primary'}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Repo Owner (user or org)</label>
                    <input
                      type="text"
                      required
                      value={publishSettings.githubOwner || ''}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({ ...prev, githubOwner: e.target.value }))
                      }
                      placeholder="octocat"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Repository Name</label>
                    <input
                      type="text"
                      required
                      value={publishSettings.githubRepo || ''}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({ ...prev, githubRepo: e.target.value }))
                      }
                      placeholder="octocat.github.io"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Branch</label>
                    <input
                      type="text"
                      value={publishSettings.githubBranch || 'gh-pages'}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({ ...prev, githubBranch: e.target.value }))
                      }
                      placeholder="gh-pages"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Personal Access Token
                    </label>
                    <input
                      type="password"
                      required
                      value={publishSettings.githubToken || ''}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({ ...prev, githubToken: e.target.value }))
                      }
                      placeholder="ghp_..."
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Custom Domain (optional — writes <code>CNAME</code>)
                    </label>
                    <input
                      type="text"
                      value={publishSettings.githubCustomDomain || ''}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({ ...prev, githubCustomDomain: e.target.value }))
                      }
                      placeholder="yourdomain.com"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                </div>

                {githubCheckResult && (
                  <div
                    className={`p-3 rounded-xl text-xs border ${
                      githubCheckResult.success
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                        : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
                    }`}
                  >
                    {githubCheckResult.message}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/80">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={handleCheckGithubRepo}
                      disabled={githubChecking}
                      className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold text-xs flex items-center gap-1.5 transition disabled:opacity-50"
                    >
                      <RefreshCw className={`w-4 h-4 text-indigo-400 ${githubChecking ? 'animate-spin' : ''}`} />
                      {githubChecking ? 'Checking...' : 'Check Repo Access'}
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveGithubSettings}
                      className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 font-semibold text-xs flex items-center gap-1.5 transition"
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      Save GitHub Settings
                    </button>
                    <button
                      type="submit"
                      disabled={githubDeploying}
                      className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow flex items-center gap-2 transition disabled:opacity-50"
                    >
                      <UploadCloud className={`w-4 h-4 ${githubDeploying ? 'animate-pulse' : ''}`} />
                      {githubDeploying ? 'Deploying...' : 'Save & Deploy to GitHub Pages'}
                    </button>
                  </div>

                  {(publishSettings.githubOwner ||
                    publishSettings.githubRepo ||
                    publishSettings.githubToken) && (
                    <button
                      type="button"
                      onClick={handleClearGithubSettings}
                      className="px-3.5 py-2 rounded-xl bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/30 text-rose-300 font-semibold text-xs flex items-center gap-1.5 transition"
                      title="Delete the stored GitHub owner, repo, branch, token, and custom domain from this persona's SQLite database"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete Stored GitHub Info
                    </button>
                  )}
                </div>
              </form>

              {/* Option 4: Real-Time Static Site Comments (Optional Third-Party Provider) */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-bold text-lg flex items-center gap-2">
                      <MessageSquare className="w-5 h-5 text-purple-400" />
                      4. Real-Time Public Comment Threads (Optional — Giscus / Utterances)
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">
                      In addition to zero-setup pull-federated ring comments, you can optionally
                      embed live real-time comment threads on every Wall Post on your static website
                      powered by GitHub Discussions (Giscus) or GitHub Issues (Utterances).
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Real-Time Comment Provider
                    </label>
                    <select
                      value={publishSettings.commentProvider || 'none'}
                      onChange={(e) =>
                        handleUpdatePrivacySetting({
                          commentProvider: e.target.value as 'none' | 'giscus' | 'utterances',
                        })
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                    >
                      <option value="none">
                        None (Use Native Pull-Federated Ring Comments Only)
                      </option>
                      <option value="giscus">
                        Giscus (GitHub Discussions — Free, Real-Time, Recommended)
                      </option>
                      <option value="utterances">
                        Utterances (GitHub Issues — Free, Lightweight)
                      </option>
                    </select>
                  </div>

                  {publishSettings.commentProvider &&
                    publishSettings.commentProvider !== 'none' && (
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">
                          Public GitHub Repository (<code>username/repo</code>)
                        </label>
                        <input
                          type="text"
                          value={publishSettings.giscusRepo || ''}
                          onChange={(e) =>
                            setPublishSettings((prev) => ({ ...prev, giscusRepo: e.target.value }))
                          }
                          onBlur={() =>
                            handleUpdatePrivacySetting({ giscusRepo: publishSettings.giscusRepo })
                          }
                          placeholder="e.g., alexrivera/alexrivera.github.io"
                          className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                        />
                      </div>
                    )}
                </div>

                {publishSettings.commentProvider === 'giscus' && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Giscus Repo ID (Optional, from giscus.app)
                      </label>
                      <input
                        type="text"
                        value={publishSettings.giscusRepoId || ''}
                        onChange={(e) =>
                          setPublishSettings((prev) => ({ ...prev, giscusRepoId: e.target.value }))
                        }
                        onBlur={() =>
                          handleUpdatePrivacySetting({ giscusRepoId: publishSettings.giscusRepoId })
                        }
                        placeholder="R_kgDO..."
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Discussions Category Name
                      </label>
                      <input
                        type="text"
                        value={publishSettings.giscusCategory || 'General'}
                        onChange={(e) =>
                          setPublishSettings((prev) => ({
                            ...prev,
                            giscusCategory: e.target.value,
                          }))
                        }
                        onBlur={() =>
                          handleUpdatePrivacySetting({
                            giscusCategory: publishSettings.giscusCategory,
                          })
                        }
                        placeholder="General"
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Giscus Category ID (Optional)
                      </label>
                      <input
                        type="text"
                        value={publishSettings.giscusCategoryId || ''}
                        onChange={(e) =>
                          setPublishSettings((prev) => ({
                            ...prev,
                            giscusCategoryId: e.target.value,
                          }))
                        }
                        onBlur={() =>
                          handleUpdatePrivacySetting({
                            giscusCategoryId: publishSettings.giscusCategoryId,
                          })
                        }
                        placeholder="DIC_kwDO..."
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Option 5: Optional Add-On 1 — Google Analytics (GA4) */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                        Optional Add-On 1
                      </span>
                      {bundle.profile.analyticsAddon?.enabled && (
                        <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-mono">
                          ✓ Active: {bundle.profile.analyticsAddon.measurementId}
                        </span>
                      )}
                    </div>
                    <h3 className="font-bold text-lg mt-1">
                      5. Google Analytics (GA4) Profile Add-On
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Optionally inject Google Analytics 4 (<code>gtag.js</code>) into your exported{' '}
                      <code>index.html</code> and dynamically whitelist Google Analytics in the
                      Content-Security-Policy header.
                    </p>
                  </div>

                  <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer text-xs font-semibold">
                    <input
                      type="checkbox"
                      checked={Boolean(publishSettings.analyticsEnabled)}
                      onChange={(e) =>
                        handleUpdatePrivacySetting({ analyticsEnabled: e.target.checked })
                      }
                      className="accent-indigo-500"
                    />
                    <span>Enable Google Analytics Add-On</span>
                  </label>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      GA4 Measurement ID (Format: <code>G-XXXXXXXXXX</code>)
                    </label>
                    <input
                      type="text"
                      value={publishSettings.analyticsMeasurementId || ''}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({
                          ...prev,
                          analyticsMeasurementId: e.target.value.toUpperCase(),
                        }))
                      }
                      placeholder="G-1A2B3C4D5E"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                  <div className="flex flex-col justify-center gap-1.5 text-xs pt-2">
                    <label className="inline-flex items-center gap-2 cursor-pointer text-slate-300">
                      <input
                        type="checkbox"
                        checked={publishSettings.analyticsRespectDnt !== false}
                        onChange={(e) =>
                          setPublishSettings((prev) => ({
                            ...prev,
                            analyticsRespectDnt: e.target.checked,
                          }))
                        }
                        className="accent-indigo-500"
                      />
                      <span>Respect Visitor Browser Do-Not-Track (DNT)</span>
                    </label>
                    <label className="inline-flex items-center gap-2 cursor-pointer text-slate-300">
                      <input
                        type="checkbox"
                        checked={publishSettings.analyticsAnonymizeIp !== false}
                        onChange={(e) =>
                          setPublishSettings((prev) => ({
                            ...prev,
                            analyticsAnonymizeIp: e.target.checked,
                          }))
                        }
                        className="accent-indigo-500"
                      />
                      <span>Anonymize Visitor IP Addresses (<code>anonymize_ip: true</code>)</span>
                    </label>
                    <label className="inline-flex items-center gap-2 cursor-pointer text-slate-300">
                      <input
                        type="checkbox"
                        checked={publishSettings.analyticsTrackRingInteractions !== false}
                        onChange={(e) =>
                          setPublishSettings((prev) => ({
                            ...prev,
                            analyticsTrackRingInteractions: e.target.checked,
                          }))
                        }
                        className="accent-indigo-500"
                      />
                      <span>
                        Track Webring Like / Share / Comment Clicks (<code>webring_interact</code>)
                      </span>
                    </label>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/80">
                  <button
                    type="button"
                    onClick={handleSaveRemoteSettings}
                    className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow transition"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    Save Analytics Add-On Settings
                  </button>
                  {(publishSettings.analyticsMeasurementId || publishSettings.analyticsEnabled) && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (
                          !window.confirm(
                            'Delete the stored Google Analytics Measurement ID and disable the Analytics add-on for this persona?'
                          )
                        ) {
                          return;
                        }
                        await handleUpdatePrivacySetting({
                          analyticsEnabled: false,
                          analyticsMeasurementId: '',
                          analyticsRespectDnt: true,
                          analyticsAnonymizeIp: true,
                          analyticsTrackRingInteractions: true,
                        });
                      }}
                      className="px-3.5 py-2 rounded-xl bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/30 text-rose-300 font-semibold text-xs flex items-center gap-1.5 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete Stored Analytics Info
                    </button>
                  )}
                </div>
              </div>

              {/* Option 6: Optional Add-On 2 — Google AdSense / Ads Monetization */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                        Optional Add-On 2
                      </span>
                      {bundle.profile.adsAddon?.enabled && (
                        <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-mono">
                          ✓ Active: {bundle.profile.adsAddon.publisherId} (+ /ads.txt)
                        </span>
                      )}
                    </div>
                    <h3 className="font-bold text-lg mt-1">
                      6. Google AdSense / Ads Monetization Add-On
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Offset your hosting costs by enabling Google AdSense on your static profile
                      site. Automatically generates <code>/ads.txt</code> in your exported site root
                      and renders responsive ad slots.
                    </p>
                  </div>

                  <label className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer text-xs font-semibold">
                    <input
                      type="checkbox"
                      checked={Boolean(publishSettings.adsEnabled)}
                      onChange={(e) =>
                        handleUpdatePrivacySetting({ adsEnabled: e.target.checked })
                      }
                      className="accent-emerald-500"
                    />
                    <span>Enable Google AdSense Add-On</span>
                  </label>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      AdSense Publisher ID (Format: <code>ca-pub-1234567890123456</code>)
                    </label>
                    <input
                      type="text"
                      value={publishSettings.adsPublisherId || ''}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({
                          ...prev,
                          adsPublisherId: e.target.value,
                        }))
                      }
                      placeholder="ca-pub-1234567890123456"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                  <div className="flex flex-col justify-center gap-1.5 text-xs pt-2">
                    <label className="inline-flex items-center gap-2 cursor-pointer text-slate-300">
                      <input
                        type="checkbox"
                        checked={publishSettings.adsEnableAutoAds !== false}
                        onChange={(e) =>
                          setPublishSettings((prev) => ({
                            ...prev,
                            adsEnableAutoAds: e.target.checked,
                          }))
                        }
                        className="accent-emerald-500"
                      />
                      <span>Enable Google Auto Ads Script in Page Head</span>
                    </label>
                    <label className="inline-flex items-center gap-2 cursor-pointer text-slate-300">
                      <input
                        type="checkbox"
                        checked={publishSettings.adsGenerateAdsTxt !== false}
                        onChange={(e) =>
                          setPublishSettings((prev) => ({
                            ...prev,
                            adsGenerateAdsTxt: e.target.checked,
                          }))
                        }
                        className="accent-emerald-500"
                      />
                      <span>
                        Generate Root <code>/ads.txt</code> File Automatically (IAB Authorized
                        Digital Sellers)
                      </span>
                    </label>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Profile Banner Ad Slot ID (Optional)
                    </label>
                    <input
                      type="text"
                      value={publishSettings.adsHeaderSlotId || ''}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({
                          ...prev,
                          adsHeaderSlotId: e.target.value,
                        }))
                      }
                      placeholder="e.g., 1234567890"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      In-Feed Ad Slot ID (Between Albums & Posts)
                    </label>
                    <input
                      type="text"
                      value={publishSettings.adsInFeedSlotId || ''}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({
                          ...prev,
                          adsInFeedSlotId: e.target.value,
                        }))
                      }
                      placeholder="e.g., 2345678901"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Footer Ad Slot ID (Optional)
                    </label>
                    <input
                      type="text"
                      value={publishSettings.adsFooterSlotId || ''}
                      onChange={(e) =>
                        setPublishSettings((prev) => ({
                          ...prev,
                          adsFooterSlotId: e.target.value,
                        }))
                      }
                      placeholder="e.g., 3456789012"
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-800/80">
                  <button
                    type="button"
                    onClick={handleSaveRemoteSettings}
                    className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow transition"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    Save AdSense Add-On Settings
                  </button>
                  {(publishSettings.adsPublisherId ||
                    publishSettings.adsEnabled ||
                    publishSettings.adsHeaderSlotId ||
                    publishSettings.adsInFeedSlotId ||
                    publishSettings.adsFooterSlotId) && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (
                          !window.confirm(
                            'Delete the stored Google AdSense Publisher ID, ad slot IDs, and disable the AdSense add-on for this persona?'
                          )
                        ) {
                          return;
                        }
                        await handleUpdatePrivacySetting({
                          adsEnabled: false,
                          adsPublisherId: '',
                          adsEnableAutoAds: true,
                          adsGenerateAdsTxt: true,
                          adsHeaderSlotId: '',
                          adsInFeedSlotId: '',
                          adsFooterSlotId: '',
                        });
                      }}
                      className="px-3.5 py-2 rounded-xl bg-rose-950/40 hover:bg-rose-900/50 border border-rose-500/30 text-rose-300 font-semibold text-xs flex items-center gap-1.5 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete Stored AdSense Info
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 9: AI AGENT & MODEL CONTEXT PROTOCOL (MCP) HUB */}
          {activeTab === 'mcp' && (
            <div className="max-w-5xl mx-auto space-y-6 pb-12">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold flex items-center gap-2.5">
                    <Sparkles className="w-6 h-6 text-indigo-400" />
                    AI Agent & MCP Automation Hub
                  </h2>
                  <p className="text-sm text-slate-400 mt-1">
                    Connect any Model Context Protocol (MCP) agent (Google Antigravity, Claude
                    Desktop, Cursor, Windsurf, or scheduled scripts) to manage your personas,
                    publish wall posts, crawl your friend ring, and deploy your static sites.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-mono font-semibold flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    {mcpInfo?.status.running
                      ? `Live HTTP MCP: ${mcpInfo.status.endpointUrl}`
                      : 'STDIO & HTTP MCP Ready'}
                  </span>
                </div>
              </div>

              {/* Dual Transport Configuration Cards */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* STDIO Config Card */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                        Option 1 • Standalone STDIO Transport
                      </span>
                      <h3 className="font-bold text-base mt-1">
                        Antigravity / Claude Desktop / Cursor Config
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const snippet = JSON.stringify(
                          {
                            mcpServers: {
                              'webring-studio': {
                                command: 'node',
                                args: [
                                  mcpInfo?.cliScriptPath ||
                                    'dist-electron/electron/mcp/cli.js',
                                  '--data-dir',
                                  mcpInfo?.userDataDir || './user-data',
                                ],
                              },
                            },
                          },
                          null,
                          2
                        );
                        navigator.clipboard.writeText(snippet);
                        notify('Copied STDIO mcpServers JSON configuration to clipboard!');
                      }}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5"
                    >
                      <Copy className="w-3.5 h-3.5" /> Copy JSON
                    </button>
                  </div>
                  <p className="text-xs text-slate-400">
                    Spawns the headless Webring Studio MCP server over <code>stdin/stdout</code>.
                    Works even when the Webring Studio desktop window is closed!
                  </p>
                  <pre className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-[11px] font-mono text-emerald-300 overflow-x-auto">
                    {JSON.stringify(
                      {
                        mcpServers: {
                          'webring-studio': {
                            command: 'node',
                            args: [
                              mcpInfo?.cliScriptPath ||
                                'dist-electron/electron/mcp/cli.js',
                              '--data-dir',
                              mcpInfo?.userDataDir || '<your-userData-path>',
                            ],
                          },
                        },
                      },
                      null,
                      2
                    )}
                  </pre>
                </div>

                {/* Live Loopback HTTP Config Card */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                        Option 2 • Live Studio Loopback HTTP / SSE
                      </span>
                      <h3 className="font-bold text-base mt-1">
                        Live Connected Studio Endpoint
                      </h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const snippet = JSON.stringify(
                          {
                            mcpServers: {
                              'webring-studio-live': {
                                url:
                                  mcpInfo?.status.authorizedEndpointUrl ||
                                  'http://127.0.0.1:<port>/mcp?token=<token>',
                              },
                            },
                          },
                          null,
                          2
                        );
                        navigator.clipboard.writeText(snippet);
                        notify('Copied Live HTTP MCP configuration to clipboard!');
                      }}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5"
                    >
                      <Copy className="w-3.5 h-3.5" /> Copy URL Config
                    </button>
                  </div>
                  <p className="text-xs text-slate-400">
                    Connects directly to this running Studio window on <code>127.0.0.1</code>. Any
                    posts, comments, persona switches, or crawls performed by your agent update this
                    UI in real time! The port stays the same across restarts. Use the URLs below,
                    which include your access token: clients running inside a browser or Electron
                    window (anything that sends an <code>Origin</code> header) are refused without
                    it, so web pages can't control Studio. Treat the token like a password.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (!mcpInfo?.status.authorizedSseUrl) return;
                        navigator.clipboard.writeText(mcpInfo.status.authorizedSseUrl);
                        notify('Copied SSE URL (with access token) to clipboard!');
                      }}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1.5"
                    >
                      <Copy className="w-3.5 h-3.5" /> Copy SSE URL
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!mcpInfo?.status.authorizedEndpointUrl) return;
                        navigator.clipboard.writeText(mcpInfo.status.authorizedEndpointUrl);
                        notify('Copied HTTP URL (with access token) to clipboard!');
                      }}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium flex items-center gap-1.5"
                    >
                      <Copy className="w-3.5 h-3.5" /> Copy HTTP URL
                    </button>
                  </div>
                  <pre className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-[11px] font-mono text-indigo-300 overflow-x-auto">
                    {JSON.stringify(
                      {
                        mcpServers: {
                          'webring-studio-live': {
                            url:
                              mcpInfo?.status.authorizedEndpointUrl ||
                              'http://127.0.0.1:<port>/mcp?token=<token>',
                            sseUrl:
                              mcpInfo?.status.authorizedSseUrl ||
                              'http://127.0.0.1:<port>/mcp/sse?token=<token>',
                          },
                        },
                      },
                      null,
                      2
                    )}
                  </pre>
                </div>
              </div>

              {/* Interactive MCP Tool Tester & One-Click Automation Runner */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-lg">
                      Interactive MCP Tool Console ({mcpInfo?.tools.length || 21} Tools Available)
                    </h3>
                    <p className="text-xs text-slate-400">
                      Test any MCP tool directly against your active persona or trigger a 1-click
                      agent workflow below.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await window.studioApi?.callMcpTool?.(
                          'webring_create_post',
                          {
                            commentary:
                              'Automated Wall Update published via the Webring Studio MCP Server! 🤖✨',
                            tags: ['mcp', 'automation', 'indieweb'],
                          }
                        );
                        setMcpToolOutput(res?.content?.[0]?.text || '');
                        await refreshStudioData();
                        const info = await window.studioApi?.getMcpInfo?.();
                        if (info) setMcpInfo(info);
                        notify('Executed webring_create_post via MCP!');
                      }}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600/25 hover:bg-indigo-600/40 border border-indigo-500/40 text-indigo-200 text-xs font-semibold"
                    >
                      ⚡ Quick Test: Post to Wall via MCP
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await window.studioApi?.callMcpTool?.(
                          'webring_crawl_all_friends',
                          {}
                        );
                        setMcpToolOutput(res?.content?.[0]?.text || '');
                        await refreshStudioData();
                        const info = await window.studioApi?.getMcpInfo?.();
                        if (info) setMcpInfo(info);
                        notify('Executed webring_crawl_all_friends via MCP!');
                      }}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600/25 hover:bg-emerald-600/40 border border-emerald-500/40 text-emerald-200 text-xs font-semibold"
                    >
                      ⚡ Quick Test: Crawl Ring via MCP
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                  <div className="lg:col-span-5 space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1">
                        Select MCP Tool
                      </label>
                      <select
                        value={selectedMcpTool}
                        onChange={(e) => {
                          const toolName = e.target.value;
                          setSelectedMcpTool(toolName);
                          if (toolName === 'webring_create_post') {
                            setMcpToolArgsJson(
                              JSON.stringify(
                                {
                                  commentary: 'Sharing a new update from my MCP agent!',
                                  tags: ['webring', 'agent'],
                                },
                                null,
                                2
                              )
                            );
                          } else if (toolName === 'webring_interact_with_url') {
                            setMcpToolArgsJson(
                              JSON.stringify(
                                {
                                  type: 'comment',
                                  targetUrl: 'https://friend.example/api/items.json#item-1',
                                  commentary: 'Love this!',
                                },
                                null,
                                2
                              )
                            );
                          } else if (toolName === 'webring_configure_analytics_addon') {
                            setMcpToolArgsJson(
                              JSON.stringify(
                                {
                                  enabled: true,
                                  measurementId: 'G-1A2B3C4D5E',
                                  respectDoNotTrack: true,
                                  anonymizeIp: true,
                                  trackRingInteractions: true,
                                },
                                null,
                                2
                              )
                            );
                          } else if (toolName === 'webring_configure_ads_addon') {
                            setMcpToolArgsJson(
                              JSON.stringify(
                                {
                                  enabled: true,
                                  publisherId: 'ca-pub-1234567890123456',
                                  enableAutoAds: true,
                                  generateAdsTxt: true,
                                  headerSlotId: '1122334455',
                                  inFeedSlotId: '5566778899',
                                },
                                null,
                                2
                              )
                            );
                          } else {
                            setMcpToolArgsJson('{}');
                          }
                        }}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-white"
                      >
                        {(mcpInfo?.tools || []).map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-slate-400 mt-1.5">
                        {
                          mcpInfo?.tools.find((t) => t.name === selectedMcpTool)
                            ?.description
                        }
                      </p>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-300 mb-1">
                        JSON Arguments (<code>params.arguments</code>)
                      </label>
                      <textarea
                        rows={5}
                        value={mcpToolArgsJson}
                        onChange={(e) => setMcpToolArgsJson(e.target.value)}
                        className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-slate-200"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const parsedArgs = JSON.parse(mcpToolArgsJson || '{}');
                          const res = await window.studioApi?.callMcpTool?.(
                            selectedMcpTool,
                            parsedArgs
                          );
                          setMcpToolOutput(res?.content?.[0]?.text || JSON.stringify(res, null, 2));
                          await refreshStudioData();
                          const info = await window.studioApi?.getMcpInfo?.();
                          if (info) setMcpInfo(info);
                          notify(`Executed MCP tool: ${selectedMcpTool}`);
                        } catch (err: unknown) {
                          setMcpToolOutput(
                            `Invalid JSON arguments: ${
                              err instanceof Error ? err.message : String(err)
                            }`
                          );
                        }
                      }}
                      className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow transition"
                    >
                      Run MCP Tool ({selectedMcpTool})
                    </button>
                  </div>

                  <div className="lg:col-span-7 flex flex-col">
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      MCP Tool JSON-RPC Result
                    </label>
                    <pre className="flex-1 min-h-[220px] max-h-[340px] p-4 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-emerald-300 overflow-auto">
                      {mcpToolOutput ||
                        '// Click "Run MCP Tool" or a Quick Test button to inspect the JSON-RPC response...'}
                    </pre>
                  </div>
                </div>
              </div>

              {/* Example Natural-Language Prompts & Live Agent Activity Log */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
                  <h3 className="font-bold text-base">
                    Example Prompts You Can Give Your AI Agent
                  </h3>
                  <div className="space-y-2.5 text-xs">
                    <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                      <span className="text-[10px] font-bold uppercase text-indigo-400">
                        Daily Ring Sync & Commenting
                      </span>
                      <p className="text-slate-200 italic">
                        "Crawl all my friends in Webring Studio, summarize any new wall posts or
                        photos in my Neighborhood Feed, and post a friendly comment on the most
                        interesting one."
                      </p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                      <span className="text-[10px] font-bold uppercase text-emerald-400">
                        Multi-Persona Publishing
                      </span>
                      <p className="text-slate-200 italic">
                        "Switch to my Music Alias persona, create a new wall post about my latest
                        tape loop study with tags #modular and #ambient, and export the signed
                        static website."
                      </p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1">
                      <span className="text-[10px] font-bold uppercase text-amber-400">
                        OPSEC & Privacy Audit
                      </span>
                      <p className="text-slate-200 italic">
                        "Run the opsec-privacy-audit prompt on my Webring Studio personas and verify
                        that all my friends are set to private crawler-only visibility."
                      </p>
                    </div>
                  </div>
                </div>

                {/* Live Agent Activity Log */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-base">Live MCP Agent Activity Log</h3>
                    <span className="text-xs text-slate-400">
                      {mcpInfo?.activityLog.length || 0} event(s)
                    </span>
                  </div>
                  {!mcpInfo?.activityLog || mcpInfo.activityLog.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">
                      No MCP agent calls recorded in this session yet. Use the Tool Console above or
                      connect an external MCP agent!
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {mcpInfo.activityLog.map((entry) => (
                        <div
                          key={entry.id}
                          className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span
                                className={`w-2 h-2 rounded-full ${
                                  entry.success ? 'bg-emerald-400' : 'bg-rose-400'
                                }`}
                              />
                              <span className="font-mono font-bold text-indigo-300">
                                {entry.toolName || entry.method}
                              </span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                                {entry.personaId}
                              </span>
                            </div>
                            <p className="text-slate-300 truncate mt-0.5">{entry.summary}</p>
                          </div>
                          <span className="text-[10px] text-slate-500 font-mono shrink-0">
                            {new Date(entry.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 10: HELP & DEPLOYMENT GUIDE */}
          {activeTab === 'help' && (
            <div className="max-w-5xl mx-auto space-y-6 pb-12">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold flex items-center gap-2.5">
                    <BookOpen className="w-6 h-6 text-indigo-400" />
                    Webring Studio — Help, Features & Step-by-Step Guide
                  </h2>
                  <p className="text-sm text-slate-400 mt-1">
                    Complete documentation for compartmentalized personas, wall posts & threaded
                    comments, syncing friends with mute &amp; block, local test exports,{' '}
                    <strong>GitHub Pages</strong> & <strong>SFTP / FTP</strong> deployment and
                    publish snapshots, <strong>Google Analytics / AdSense</strong> add-ons, and
                    secure local <strong>AI Agent (MCP)</strong> automation.
                  </p>
                </div>

                {/* Section Switcher Pills */}
                <div className="flex flex-wrap gap-1.5 bg-slate-900 p-1.5 rounded-xl border border-slate-800">
                  {(
                    [
                      { id: 'quickstart', label: '1. Quickstart & Personas' },
                      { id: 'github-pages', label: '2. GitHub Pages Guide' },
                      { id: 'ftp-sftp', label: '3. FTP / SFTP Host Guide' },
                      { id: 'addons', label: '4. Analytics & AdSense Add-Ons' },
                      { id: 'mcp-agents', label: '5. AI Agent (MCP) Guide' },
                      { id: 'privacy-faq', label: '6. Security & Privacy FAQ' },
                      { id: 'webrings', label: '7. Webrings Guide' },
                    ] as const
                  ).map((sec) => (
                    <button
                      key={sec.id}
                      onClick={() => setHelpSection(sec.id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                        helpSection === sec.id
                          ? 'bg-indigo-600 text-white shadow'
                          : 'text-slate-400 hover:text-white hover:bg-slate-800'
                      }`}
                    >
                      {sec.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quick Navigation Banner */}
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
                <div className="space-y-1">
                  <div className="text-slate-400">
                    Example Canonical Root URL:{' '}
                    <code className="text-indigo-300 font-bold">https://example.com</code> or{' '}
                    <code className="text-indigo-300 font-bold">https://yourname.github.io</code>
                  </div>
                  <div className="text-slate-400">
                    Example W3C / ATProto Identity:{' '}
                    <code className="text-emerald-400 font-bold">did:web:example.com</code>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setShowPersonaModal(true)}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium"
                  >
                    Manage Personas →
                  </button>
                  <button
                    onClick={() => setActiveTab('profile')}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium"
                  >
                    Edit Profile URL →
                  </button>
                  <button
                    onClick={() => setActiveTab('publish')}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                  >
                    Go to Publish Tab →
                  </button>
                </div>
              </div>

              {/* SECTION 1: QUICKSTART, MULTI-PERSONA, WALL POSTS & LOCAL TEST PREVIEW */}
              {helpSection === 'quickstart' && (
                <div className="space-y-6">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
                    <h3 className="text-lg font-bold text-white">
                      How Webring Studio Works (Zero-Backend Architecture)
                    </h3>
                    <p className="text-sm text-slate-300 leading-relaxed">
                      Unlike centralized social networks, Webring Studio stores your data locally in a{' '}
                      <strong>SQLite database</strong> on your computer and compiles a{' '}
                      <strong>100% static website</strong> (HTML + cryptographically signed JSON
                      files). You can host those files anywhere for free—no database server, PHP, or
                      Node.js backend required on your web host.
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-indigo-400">
                          Step 1 • Identity & Personas
                        </div>
                        <h4 className="font-bold text-sm">Configure Canonical URL & Personas</h4>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          In <strong>Profile & Identity</strong>, enter the final web address where
                          your site will live (e.g., <code>https://yourname.github.io</code>). Need
                          separate identities (personal, music alias, professional)? Use the{' '}
                          <strong>Persona Switcher</strong> in the top-left sidebar to create strictly
                          compartmentalized personas with separate SQLite databases and Ed25519 keys.
                        </p>
                        <div className="flex gap-3 pt-1">
                          <button
                            onClick={() => setActiveTab('profile')}
                            className="text-xs text-indigo-400 hover:underline font-medium"
                          >
                            Open Profile →
                          </button>
                          <button
                            onClick={() => setShowPersonaModal(true)}
                            className="text-xs text-indigo-400 hover:underline font-medium"
                          >
                            Manage Personas →
                          </button>
                        </div>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                          Step 2 • Wall Posts, Comments & Photos
                        </div>
                        <h4 className="font-bold text-sm">Publish Posts, Replies & Galleries</h4>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          Post native status updates (<code>post</code>), threaded replies to friends
                          (<code>comment</code>), likes, and recommendations in{' '}
                          <strong>Wall, Likes & Comments</strong>, or add your own photos in the{' '}
                          <strong>Media Library</strong>. Photos are published as resized copies with
                          location data removed, with a signed manifest per album. Every post and photo
                          receives a permanent canonical URI so peers in your ring can reply or like it. Use the pencil on any of
                          your items to edit it later; its URI stays the same. Wall posts support Markdown.
                        </p>
                        <div className="flex gap-3 pt-1">
                          <button
                            onClick={() => setActiveTab('items')}
                            className="text-xs text-emerald-400 hover:underline font-medium"
                          >
                            Open Wall & Comments →
                          </button>
                          <button
                            onClick={() => setActiveTab('albums')}
                            className="text-xs text-emerald-400 hover:underline font-medium"
                          >
                            Open Photo Albums →
                          </button>
                        </div>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-amber-400">
                          Step 3 • Friends & Neighborhood Feed
                        </div>
                        <h4 className="font-bold text-sm">Build Your Ring & Reply to Friends</h4>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          Add friends' profile URLs in <strong>Friends & Webrings</strong>. Friends
                          default to <strong>🔒 Private (Local Crawler Only)</strong> so your Studio
                          pulls their posts into your <strong>Neighborhood Feed</strong> without
                          exposing your social graph publicly. Click <strong>💬 Reply</strong> on any
                          feed item to publish a signed threaded comment!
                        </p>
                        <ul className="text-xs text-slate-400 list-disc list-inside space-y-1">
                          <li>
                            <strong>Sync All Friends</strong> (top bar or Feed tab) crawls every
                            friend's signed JSON. Each friend card shows when it was last synced.
                          </li>
                          <li>
                            Your feed keeps friends' posts for a window you choose (<strong>Keep</strong> on
                            the Feed tab, 3 months by default), and files that haven't changed aren't
                            downloaded again. Use <strong>☆ Save</strong> to keep a private copy of a post
                            and its image for good, under <strong>Saved</strong>.
                          </li>
                          <li>
                            Use <strong>Mute</strong> or <strong>Block</strong> on a friend or feed
                            post to curate your feed (see the Security &amp; Privacy FAQ).
                          </li>
                          <li>
                            Removing a friend also deletes the posts and endorsements crawled from
                            their site.
                          </li>
                          <li>
                            The feed shows <strong>Friends only</strong> by default. Choose{' '}
                            <strong>Everyone</strong> to see your own posts and photos alongside
                            theirs, with replies threaded under each, or <strong>Just me</strong>.
                          </li>
                        </ul>
                        <div className="flex gap-3 pt-1">
                          <button
                            onClick={() => setActiveTab('friends')}
                            className="text-xs text-amber-400 hover:underline font-medium"
                          >
                            Friends & Rings →
                          </button>
                          <button
                            onClick={() => setActiveTab('feed')}
                            className="text-xs text-amber-400 hover:underline font-medium"
                          >
                            Neighborhood Feed →
                          </button>
                        </div>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-cyan-400">
                          Step 4 • Local Test Export Preview
                        </div>
                        <h4 className="font-bold text-sm">Test Export on Localhost Before Live</h4>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          In <strong>Site Design</strong> or <strong>Publish & SFTP</strong>,
                          click <strong>Run Local Test Export & Preview</strong>. Webring Studio writes
                          your complete static bundle to a local sandbox folder, runs pre-flight
                          verification checks, and serves it over a real local HTTP server (
                          <code>http://127.0.0.1:&lt;port&gt;</code>).
                        </p>
                        <button
                          onClick={() => setActiveTab('preview')}
                          className="text-xs text-cyan-400 hover:underline font-medium pt-1 inline-block"
                        >
                          Open Site Design →
                        </button>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-pink-400">
                          Design • Themes & Templates
                        </div>
                        <h4 className="font-bold text-sm">Pick a Look for Your Page</h4>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          In <strong>Site Design</strong>, choose a classic theme (colours and fonts) or a
                          social-style template that also rearranges the page: <strong>Facepace</strong>{' '}
                          (cover photo, intro sidebar, post cards), <strong>Tweetdeck</strong> (a column per
                          block), <strong>XtraSpecial</strong> (timeline between two rails),{' '}
                          <strong>Instapick</strong> (stats, album highlights, square grid) or{' '}
                          <strong>Tik Talk</strong> (vertical reel). Your blocks keep their order; friends,
                          contact, links and guestbook go in the sidebar or rail where a template has one.
                          Accent, font and the other options still apply. Interactive extras (on by
                          default) add a photo lightbox, a larger post view with shareable links,
                          sortable tables, and a short note before Like, Share and other actions open
                          Webring Studio (the browser's own "Open …?" prompt can't be changed).
                        </p>
                        <button
                          onClick={() => setActiveTab('preview')}
                          className="text-xs text-pink-400 hover:underline font-medium pt-1 inline-block"
                        >
                          Choose a template →
                        </button>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-purple-400">
                          Step 5 • Optional Profile Add-Ons
                        </div>
                        <h4 className="font-bold text-sm">GA4 Analytics, AdSense & Guestbook</h4>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          Optionally enable <strong>Google Analytics (GA4)</strong>,{' '}
                          <strong>Google AdSense</strong> (with automatic root <code>/ads.txt</code>{' '}
                          generation to offset hosting costs), or a <strong>Giscus / Utterances</strong>{' '}
                          GitHub guestbook widget in the <strong>Publish & SFTP</strong> tab.
                        </p>
                        <button
                          onClick={() => setHelpSection('addons')}
                          className="text-xs text-purple-400 hover:underline font-medium pt-1 inline-block"
                        >
                          Read Add-Ons Guide →
                        </button>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-pink-400">
                          Step 6 • Deploy or Automate via MCP
                        </div>
                        <h4 className="font-bold text-sm">Publish to Host or Connect AI Agent</h4>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          Deploy your static files to <strong>GitHub Pages</strong> or via{' '}
                          <strong>SFTP / FTP</strong> (with saved per-persona credentials), or connect
                          an AI agent via the <strong>AI Agent (MCP)</strong> tab to automate posting,
                          ring crawling, and publishing via natural language prompts.
                        </p>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          Your public site is a <strong>snapshot</strong>. The Publish tab shows when
                          you last published and how many changes you've made since. New posts and
                          newly synced endorsements go live the next time you publish.
                        </p>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          Use the <strong>Schedule</strong> card on the Publish tab to sync and publish
                          automatically for each persona (every 15 minutes up to weekly). Scheduled
                          publishes skip when nothing changed. With background mode on, closing the window
                          keeps Studio in the menu bar so schedules keep running; it can also start at
                          login. Missed runs happen once when Studio is back.
                        </p>
                        <div className="flex gap-3 pt-1">
                          <button
                            onClick={() => setHelpSection('github-pages')}
                            className="text-xs text-pink-400 hover:underline font-medium"
                          >
                            GitHub Pages →
                          </button>
                          <button
                            onClick={() => setHelpSection('mcp-agents')}
                            className="text-xs text-pink-400 hover:underline font-medium"
                          >
                            MCP Agent Guide →
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Generated Directory Structure Card */}
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-3">
                    <h3 className="font-bold text-base">
                      What Files Does Webring Studio Generate?
                    </h3>
                    <p className="text-xs text-slate-400">
                      Every export creates a self-contained folder with the following structure:
                    </p>
                    <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-slate-300 overflow-x-auto leading-relaxed">
{`exported-profile-site/
├── index.html               # Standalone interactive profile site (hardened CSP + embedded bundle)
├── .nojekyll                # Tells GitHub Pages NOT to ignore the .well-known folder
├── ads.txt                  # (Optional) IAB Authorized Digital Sellers file when AdSense is enabled
├── .well-known/
│   └── did.json             # W3C / ATProto did:web identity & Ed25519 public key
├── api/
│   ├── manifest.json        # Signed discovery entrypoint for RingCrawler peers
│   ├── profile.json         # Signed bio, avatar, links, theme, handle & add-on metadata
│   ├── albums.json          # Signed photo galleries with canonical item URIs
│   ├── items.json           # Signed wall posts, threaded comments, likes & recommendations
│   ├── connections.json     # Signed webring bars, opt-in public friends & incoming peer replies
│   └── rings/<name>.json    # Signed member list for each ring you host
├── rings/<name>/index.html  # Script-free directory page for each ring you host
└── media/
    └── albums/              # Local imported photos copied automatically`}
                    </pre>
                  </div>
                </div>
              )}

              {/* SECTION 2: GITHUB PAGES STEP-BY-STEP GUIDE */}
              {helpSection === 'github-pages' && (
                <div className="space-y-6">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
                    <div className="border-b border-slate-800 pb-4">
                      <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300">
                        Free Static Hosting
                      </span>
                      <h3 className="text-xl font-bold mt-2">
                        Deploying Your Profile to GitHub Pages (Step-by-Step)
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">
                        GitHub Pages hosts static HTML & JSON files for free over HTTPS with full
                        support for <code>/.well-known/did.json</code> and optional GitHub Discussions
                        guestbooks (Giscus).
                      </p>
                    </div>

                    <div className="p-3.5 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-200 flex items-start gap-2.5">
                      <UploadCloud className="w-4 h-4 mt-0.5 shrink-0" />
                      <span>
                        <strong>Skip the terminal:</strong> Webring Studio can push and deploy for you
                        directly from the app. Go to the <strong>Publish & SFTP</strong> tab → <em>3.
                        GitHub Pages Deploy</em>, add a repo + access token, and click{' '}
                        <strong>Save & Deploy to GitHub Pages</strong>. The steps below are what it does
                        under the hood, and are here for anyone who prefers plain <code>git</code>.
                      </span>
                    </div>

                    {/* Step 1 */}
                    <div className="space-y-2">
                      <h4 className="font-bold text-sm text-indigo-300">
                        Step 1: Set Your GitHub Pages URL in "Profile & Identity"
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        Before exporting, make sure your <strong>Hosted Website URL</strong> matches
                        your GitHub Pages address so your cryptographic signatures and{' '}
                        <code>did:web</code> identity match your live domain:
                      </p>
                      <ul className="text-xs text-slate-400 list-disc list-inside space-y-1 pl-2">
                        <li>
                          <strong>User Site (Recommended):</strong>{' '}
                          <code>https://&lt;your-github-username&gt;.github.io</code> → produces{' '}
                          <code>did:web:&lt;your-github-username&gt;.github.io</code>
                        </li>
                        <li>
                          <strong>Project Repository Site:</strong>{' '}
                          <code>https://&lt;your-github-username&gt;.github.io/&lt;repo-name&gt;</code>{' '}
                          → produces{' '}
                          <code>did:web:&lt;your-github-username&gt;.github.io:&lt;repo-name&gt;</code>
                        </li>
                        <li>
                          <strong>Custom Domain on GitHub Pages:</strong>{' '}
                          <code>https://yourcustomdomain.com</code> → produces{' '}
                          <code>did:web:yourcustomdomain.com</code>
                        </li>
                      </ul>
                      <p className="text-xs text-slate-400">
                        Click <strong>Save & Sign Profile JSON</strong> on the Profile tab after
                        updating your URL.
                      </p>
                    </div>

                    {/* Step 2 */}
                    <div className="space-y-2 pt-2 border-t border-slate-800/80">
                      <h4 className="font-bold text-sm text-indigo-300">
                        Step 2: Preview Locally & Export Your Static Site Folder
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        You can first test your build using <strong>Run Local Test Export & Preview</strong>{' '}
                        in the <strong>Site Design</strong> tab. When ready, go to the{' '}
                        <strong>Publish & SFTP</strong> tab (or click <em>Quick Export Static Site</em>{' '}
                        in the bottom-left sidebar) and export your site to a local folder on your
                        computer—for example, <code>C:\Users\you\my-webring-site</code>.
                      </p>
                      <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200">
                        <strong>Built-in GitHub Pages Fix (<code>.nojekyll</code>):</strong> By
                        default, GitHub Pages runs Jekyll, which ignores folders starting with a dot
                        like <code>.well-known/</code>. Webring Studio automatically writes an empty{' '}
                        <code>.nojekyll</code> file in your export folder so GitHub Pages serves{' '}
                        <code>/.well-known/did.json</code> without any 404 errors!
                      </div>
                    </div>

                    {/* Step 3 */}
                    <div className="space-y-2 pt-2 border-t border-slate-800/80">
                      <h4 className="font-bold text-sm text-indigo-300">
                        Step 3: Create a GitHub Repository & Push Your Exported Files
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        1. On GitHub, create a new <strong>Public</strong> repository named{' '}
                        <code>&lt;your-github-username&gt;.github.io</code> (leave "Add a README"
                        unchecked).
                        <br />
                        2. Open a terminal inside your exported folder and run:
                      </p>
                      <div className="relative">
                        <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-emerald-300 overflow-x-auto leading-relaxed">
{`cd "path/to/exported-profile-site"
git init
git branch -M main
git add -A
git commit -m "Publish signed Webring Studio profile"
git remote add origin https://github.com/<your-github-username>/<your-github-username>.github.io.git
git push -u origin main --force`}
                        </pre>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(
                              `cd "path/to/exported-profile-site"\ngit init\ngit branch -M main\ngit add -A\ngit commit -m "Publish signed Webring Studio profile"\ngit remote add origin https://github.com/<your-github-username>/<your-github-username>.github.io.git\ngit push -u origin main --force`
                            );
                            notify('Copied GitHub Pages git commands to clipboard!');
                          }}
                          className="absolute top-3 right-3 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3" /> Copy Commands
                        </button>
                      </div>
                      <p className="text-[11px] text-slate-400">
                        <em>Tip:</em> Whenever you update your profile or add photos later, simply
                        click <strong>Quick Export Static Site</strong> into that same folder and run{' '}
                        <code>git add -A && git commit -m "Update profile" && git push</code>!
                      </p>
                    </div>

                    {/* Step 4 */}
                    <div className="space-y-2 pt-2 border-t border-slate-800/80">
                      <h4 className="font-bold text-sm text-indigo-300">
                        Step 4: Enable GitHub Pages & Verify Your Live Endpoints
                      </h4>
                      <ol className="text-xs text-slate-300 list-decimal list-inside space-y-1.5 pl-1">
                        <li>
                          On GitHub, open your repository and go to{' '}
                          <strong>Settings → Pages</strong>.
                        </li>
                        <li>
                          Under <strong>Build and deployment</strong>, set <strong>Source</strong> to{' '}
                          <code>Deploy from a branch</code>, select branch <code>main</code> and
                          folder <code>/ (root)</code>, then click <strong>Save</strong>.
                        </li>
                        <li>
                          Wait ~60 seconds, then visit your live URL:{' '}
                          <code className="text-indigo-300">https://&lt;your-github-username&gt;.github.io</code>
                        </li>
                        <li>
                          Verify your federated JSON endpoints are reachable in your browser:
                          <ul className="list-disc list-inside pl-5 mt-1 text-slate-400 font-mono">
                            <li>https://example.com/.well-known/did.json</li>
                            <li>https://example.com/api/manifest.json</li>
                            <li>https://example.com/api/profile.json</li>
                          </ul>
                        </li>
                      </ol>
                    </div>
                  </div>
                </div>
              )}

              {/* SECTION 3: HOSTED SFTP / FTP GUIDE */}
              {helpSection === 'ftp-sftp' && (
                <div className="space-y-6">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
                    <div className="border-b border-slate-800 pb-4">
                      <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">
                        Direct One-Click Upload + Per-Persona Credential Storage
                      </span>
                      <h3 className="text-xl font-bold mt-2">
                        Deploying to a Web Host via SFTP or FTP (Step-by-Step)
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">
                        Webring Studio includes a built-in SFTP (SSH) and FTP client so you can publish
                        directly to any shared web host (cPanel, DreamHost, NearlyFreeSpeech, Porkbun)
                        or Linux VPS without external FTP software.
                      </p>
                    </div>

                    {/* Step 1 */}
                    <div className="space-y-2">
                      <h4 className="font-bold text-sm text-emerald-300">
                        Step 1: Set Your Domain in "Profile & Identity"
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        Open the <strong>Profile & Identity</strong> tab and set{' '}
                        <strong>Hosted Website URL</strong> to your domain or subdomain (for example,{' '}
                        <code>https://alice.example.com</code> or{' '}
                        <code>https://example.com/~alice</code>). Click{' '}
                        <strong>Save & Sign Profile JSON</strong>.
                      </p>
                    </div>

                    {/* Step 2 */}
                    <div className="space-y-2 pt-2 border-t border-slate-800/80">
                      <h4 className="font-bold text-sm text-emerald-300">
                        Step 2: Enter & Save Your SFTP or FTP Credentials in "Publish & SFTP"
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        Open the <strong>Publish & SFTP</strong> tab and fill in the{' '}
                        <strong>Direct SFTP / FTP Web Host Uploader</strong> card:
                      </p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs border border-slate-800 rounded-xl overflow-hidden">
                          <thead className="bg-slate-950 text-slate-400">
                            <tr>
                              <th className="p-2.5 border-b border-slate-800">Field</th>
                              <th className="p-2.5 border-b border-slate-800">Recommended Value</th>
                              <th className="p-2.5 border-b border-slate-800">Notes</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800 text-slate-300">
                            <tr>
                              <td className="p-2.5 font-semibold">Protocol</td>
                              <td className="p-2.5 font-mono text-indigo-300">
                                SFTP (Port 22) or FTP (Port 21)
                              </td>
                              <td className="p-2.5 text-slate-400">
                                Prefer <strong>SFTP</strong> whenever your host supports SSH/SFTP
                                for encrypted transfers.
                              </td>
                            </tr>
                            <tr>
                              <td className="p-2.5 font-semibold">Host / Server</td>
                              <td className="p-2.5 font-mono text-indigo-300">
                                yourdomain.com or ftp.yourdomain.com
                              </td>
                              <td className="p-2.5 text-slate-400">
                                Found in your hosting control panel or VPS IP address.
                              </td>
                            </tr>
                            <tr>
                              <td className="p-2.5 font-semibold">Remote Web Root Path</td>
                              <td className="p-2.5 font-mono text-indigo-300">
                                /public_html or /var/www/html
                              </td>
                              <td className="p-2.5 text-slate-400">
                                Common roots: cPanel = <code>/public_html</code> • NearlyFreeSpeech
                                = <code>/home/public</code> • Debian/Ubuntu VPS ={' '}
                                <code>/var/www/html</code>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-200 space-y-1">
                        <strong>Per-Persona Credential Persistence & Deletion:</strong> Click{' '}
                        <strong>Save SFTP/FTP Settings to Profile DB</strong> (or upload directly) to
                        persist your host, port, username, password, and remote path inside the active
                        persona's isolated SQLite database so you don't need to re-enter them each
                        session. You can purge saved credentials anytime by clicking{' '}
                        <strong>Delete Stored SFTP/FTP Info</strong> (protected by a confirmation
                        prompt).
                      </div>
                    </div>

                    {/* Step 3 */}
                    <div className="space-y-2 pt-2 border-t border-slate-800/80">
                      <h4 className="font-bold text-sm text-emerald-300">
                        Step 3: Click "Build & Upload to Remote Host"
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        When you click <strong>Build & Upload to Remote Host</strong>, Webring Studio:
                      </p>
                      <ol className="text-xs text-slate-400 list-decimal list-inside space-y-1 pl-1">
                        <li>
                          Compiles and signs your latest JSON bundle, <code>index.html</code>, and
                          optional <code>ads.txt</code> into a temporary staging folder.
                        </li>
                        <li>
                          Connects via SFTP or FTP and recursively creates{' '}
                          <code>.well-known/</code>, <code>api/</code>, and <code>media/</code> on
                          your remote server.
                        </li>
                        <li>
                          Uploads all files and removes the temporary staging directory.
                        </li>
                      </ol>
                    </div>

                    {/* Step 4: CORS */}
                    <div className="space-y-2 pt-2 border-t border-slate-800/80">
                      <h4 className="font-bold text-sm text-emerald-300">
                        Step 4 (Optional): Enable CORS for Browser-Based Webring Viewers
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        The Webring Studio desktop app crawls peers directly from Node.js (so it
                        never gets blocked by browser CORS rules). However, if you want browser-based
                        webring widgets on other websites to fetch your <code>/api/*.json</code>{' '}
                        files directly in the browser, you can add a <code>.htaccess</code> file (on
                        Apache/cPanel hosts) inside your web root:
                      </p>
                      <pre className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-amber-300 overflow-x-auto">
{`<IfModule mod_headers.c>
  <FilesMatch "\\.(json)$">
    Header set Access-Control-Allow-Origin "*"
  </FilesMatch>
</IfModule>`}
                      </pre>
                    </div>
                  </div>
                </div>
              )}

              {/* SECTION 4: GOOGLE ANALYTICS (GA4) & GOOGLE ADSENSE MONETIZATION ADD-ONS */}
              {helpSection === 'addons' && (
                <div className="space-y-6">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
                    <div className="border-b border-slate-800 pb-4">
                      <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300">
                        Optional Static Profile Add-Ons
                      </span>
                      <h3 className="text-xl font-bold mt-2">
                        Google Analytics (GA4), Google AdSense & Public Guestbook Add-Ons
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">
                        Every persona can optionally enable visitor analytics, ad monetization (to
                        offset domain and web hosting costs), and GitHub-backed public guestbooks.
                        When disabled, zero third-party scripts or CSP domains are included in your
                        exported HTML.
                      </p>
                    </div>

                    {/* Add-On 1: Google Analytics GA4 */}
                    <div className="space-y-2">
                      <h4 className="font-bold text-sm text-indigo-300">
                        1. Google Analytics 4 (GA4) Telemetry Add-On
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        Located in <strong>Publish & SFTP → 5. Google Analytics (GA4) Profile Add-On</strong>:
                      </p>
                      <ol className="text-xs text-slate-400 list-decimal list-inside space-y-1.5 pl-1">
                        <li>
                          In your Google Analytics dashboard, create a <strong>Web Data Stream</strong>{' '}
                          for your profile domain and copy your <strong>Measurement ID</strong>{' '}
                          (formatted as <code>G-XXXXXXXXXX</code>).
                        </li>
                        <li>
                          Toggle <strong>Enable GA4 Add-On</strong> in Webring Studio and paste your{' '}
                          <code>G-XXXXXXXXXX</code> ID.
                        </li>
                        <li>
                          Configure the built-in privacy & telemetry options:
                          <ul className="list-disc list-inside pl-5 mt-1 space-y-1">
                            <li>
                              <strong>Respect Browser Do-Not-Track (DNT):</strong> Skips loading{' '}
                              <code>gtag.js</code> when a visitor's browser sends{' '}
                              <code>navigator.doNotTrack === "1"</code>.
                            </li>
                            <li>
                              <strong>Anonymize Visitor IPs:</strong> Passes{' '}
                              <code>anonymize_ip: true</code> to GA4 config.
                            </li>
                            <li>
                              <strong>Track Outbound Webring Navigation Clicks:</strong> Automatically
                              fires custom <code>webring_interact</code> events whenever visitors
                              click Prev, Next, Random, or Directory links on your webring bar.
                            </li>
                          </ul>
                        </li>
                        <li>
                          Click <strong>Save Analytics Add-On Settings</strong> (or{' '}
                          <strong>Delete Stored Analytics Info</strong> to wipe and disable it).
                        </li>
                      </ol>
                    </div>

                    {/* Add-On 2: Google AdSense */}
                    <div className="space-y-2 pt-3 border-t border-slate-800/80">
                      <h4 className="font-bold text-sm text-amber-300">
                        2. Google AdSense / Ads Monetization Add-On & Automatic <code>/ads.txt</code>
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        Located in <strong>Publish & SFTP → 6. Google AdSense / Ads Monetization Add-On</strong>.
                        Designed so static profile owners can generate ad revenue to offset hosting or
                        custom domain costs:
                      </p>
                      <ol className="text-xs text-slate-400 list-decimal list-inside space-y-1.5 pl-1">
                        <li>
                          Sign up at Google AdSense, add your profile domain, and copy your{' '}
                          <strong>Publisher ID</strong> (formatted as{' '}
                          <code>ca-pub-1234567890123456</code> or <code>pub-1234567890123456</code>;
                          Webring Studio automatically normalizes both formats).
                        </li>
                        <li>
                          Keep <strong>Generate <code>/ads.txt</code> in Site Root</strong> enabled.
                          Whenever you export or upload via SFTP/FTP, Webring Studio writes a
                          standards-compliant IAB Authorized Digital Sellers file at{' '}
                          <code>https://example.com/ads.txt</code> containing:
                          <pre className="mt-1.5 p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px] font-mono text-amber-300">
{`google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0`}
                          </pre>
                        </li>
                        <li>
                          Choose between <strong>AdSense Auto Ads</strong> (Google automatically places
                          responsive ads) and/or <strong>Manual Ad Unit Slots</strong> by entering your
                          10-digit numeric Slot IDs for:
                          <ul className="list-disc list-inside pl-5 mt-1 space-y-0.5">
                            <li>
                              <strong>Header Banner Slot ID:</strong> Renders above your main profile
                              tabs.
                            </li>
                            <li>
                              <strong>In-Feed Native Slot ID:</strong> Renders inside your Wall &
                              Activity stream.
                            </li>
                            <li>
                              <strong>Footer Banner Slot ID:</strong> Renders at the bottom of your
                              profile page.
                            </li>
                          </ul>
                        </li>
                        <li>
                          Click <strong>Save AdSense Add-On Settings</strong> and preview the slot
                          placements directly in the <strong>Site Design</strong> tab!
                        </li>
                      </ol>
                    </div>

                    {/* Add-On 3: Dynamic CSP & Guestbook */}
                    <div className="space-y-2 pt-3 border-t border-slate-800/80">
                      <h4 className="font-bold text-sm text-emerald-300">
                        3. Public Guestbook Widget (Giscus / Utterances) & Dynamic CSP Hardening
                      </h4>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        In <strong>Publish & SFTP → 4. Real-Time Public Comment Threads</strong>, you can
                        also enable <strong>Giscus (GitHub Discussions)</strong> or{' '}
                        <strong>Utterances (GitHub Issues)</strong> so visitors without Webring Studio
                        can leave comments at the bottom of your wall.
                      </p>
                      <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-400">
                        <strong className="text-slate-200">
                          🔒 Conditional Content-Security-Policy (CSP):
                        </strong>{' '}
                        Webring Studio's static site generator enforces a strict{' '}
                        <code>&lt;meta http-equiv="Content-Security-Policy"&gt;</code> header. It
                        automatically whitelists Google Analytics (<code>googletagmanager.com</code>)
                        or Google AdSense (<code>pagead2.googlesyndication.com</code>,{' '}
                        <code>googleads.g.doubleclick.net</code>) domains <strong>only</strong> on
                        personas where you explicitly enable those add-ons.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* SECTION 5: AI AGENT & MODEL CONTEXT PROTOCOL (MCP) AUTOMATION GUIDE */}
              {helpSection === 'mcp-agents' && (
                <div className="space-y-6">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
                    <div className="border-b border-slate-800 pb-4">
                      <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300">
                        {mcpInfo?.tools.length ?? 38} MCP Tools •{' '}
                        {mcpInfo?.resources.length ?? 5} Resources •{' '}
                        {mcpInfo?.prompts.length ?? 3} Guided Prompts
                      </span>
                      <h3 className="text-xl font-bold mt-2">
                        Automating Webring Studio with an AI Agent (MCP Guide)
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">
                        Webring Studio includes a full Model Context Protocol (MCP) JSON-RPC 2.0
                        server so local AI agents (Google Antigravity, Claude Desktop, Cursor,
                        Windsurf, or custom scripts) can manage your personas, publish posts, crawl
                        friends, configure add-ons, and deploy your sites on your behalf.
                      </p>
                    </div>

                    {/* Dual Transports */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                          Transport Option 1 • Headless STDIO
                        </span>
                        <h4 className="font-bold text-sm">Standalone CLI Server</h4>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          Spawns <code>dist-electron/electron/mcp/cli.js --data-dir &lt;path&gt;</code>{' '}
                          over standard input/output. Ideal for Claude Desktop, Cursor, or scheduled
                          background tasks—works even when the Webring Studio desktop window is closed.
                        </p>
                        <p className="text-xs text-amber-300/90 leading-relaxed">
                          It can read, post and sync, but it <strong>can't publish</strong>: your
                          signing key is locked in the OS keychain, which only the running Studio app
                          can open. Use Transport Option 2 for publishing.
                        </p>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                          Transport Option 2 • Live Loopback HTTP / SSE
                        </span>
                        <h4 className="font-bold text-sm">Live Studio Window Sync</h4>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          While Webring Studio is open, it listens on{' '}
                          <code>{mcpInfo?.status.endpointUrl || 'http://127.0.0.1:<port>/mcp'}</code>{' '}
                          (SSE: <code>/mcp/sse</code>). The port stays the same across restarts. Any
                          tool call executed by your AI agent updates the Studio UI and Live Activity
                          Log in real time, and this transport can publish.
                        </p>
                        <p className="text-xs text-slate-400 leading-relaxed">
                          Clients that run inside a browser or Electron window send an{' '}
                          <code>Origin</code> header and must use the URL with your{' '}
                          <strong>access token</strong> (<code>?token=…</code>). Command-line agents
                          don't need it. Web pages are always refused.
                        </p>
                      </div>
                    </div>

                    {/* Electron / browser-based client setup */}
                    <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-500/30 space-y-2">
                      <h4 className="font-bold text-sm text-emerald-300">
                        Connecting an Electron or browser-based MCP client (SSE)
                      </h4>
                      <ol className="text-xs text-slate-300 list-decimal list-inside space-y-1">
                        <li>Open Webring Studio (it must be running for SSE).</li>
                        <li>
                          In the <strong>AI Agent (MCP)</strong> tab, click{' '}
                          <strong>Copy SSE URL</strong>. It includes your access token.
                        </li>
                        <li>
                          In your client, add a server with transport <strong>SSE</strong> and paste
                          the URL. Leave the command, arguments and environment variables empty.
                        </li>
                      </ol>
                      <p className="text-xs text-slate-400 leading-relaxed">
                        Treat the token like a password: anything that has it can control Studio. To
                        issue a new one, quit Studio, delete <code>mcp-http.json</code> from the Studio
                        data folder, and reopen it.
                      </p>
                    </div>

                    {/* Available Tool Categories */}
                    <div className="space-y-2 pt-2 border-t border-slate-800/80">
                      <h4 className="font-bold text-sm text-indigo-300">
                        What Can Your AI Agent Control via MCP?
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-slate-300">
                        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                          <strong className="text-white block mb-1">
                            🎭 Personas & Identity (5 tools)
                          </strong>
                          <code>webring_list_personas</code>, <code>webring_create_persona</code>,{' '}
                          <code>webring_switch_persona</code>, <code>webring_get_profile</code>,{' '}
                          <code>webring_update_profile</code>
                        </div>
                        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                          <strong className="text-white block mb-1">
                            💬 Wall Posts, Replies & Albums (9 tools)
                          </strong>
                          <code>webring_list_items</code>, <code>webring_create_post</code>,{' '}
                          <code>webring_interact_with_url</code>, <code>webring_delete_item</code>,{' '}
                          <code>webring_list_albums</code>, <code>webring_create_album</code>,{' '}
                          <code>webring_add_photo</code>, <code>webring_delete_album</code>,{' '}
                          <code>webring_delete_photo</code>
                        </div>
                        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                          <strong className="text-white block mb-1">
                            🕸️ Friends, Moderation & Neighborhood Feed (9 tools)
                          </strong>
                          <code>webring_list_friends</code>, <code>webring_add_friend</code>,{' '}
                          <code>webring_set_friend_visibility</code>,{' '}
                          <code>webring_set_moderation</code>, <code>webring_delete_friend</code>,{' '}
                          <code>webring_crawl_friend</code>, <code>webring_crawl_all_friends</code>,{' '}
                          <code>webring_get_neighborhood_feed</code>,{' '}
                          <code>webring_get_endorsements</code>
                        </div>
                        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                          <strong className="text-white block mb-1">💍 Webrings (7 tools)</strong>
                          <code>webring_list_rings</code>, <code>webring_join_ring</code>,{' '}
                          <code>webring_leave_ring</code>, <code>webring_sync_rings</code>,{' '}
                          <code>webring_create_hosted_ring</code>,{' '}
                          <code>webring_review_ring_request</code>, <code>webring_set_ring_member</code>
                        </div>
                        <div className="p-3 rounded-xl bg-slate-950 border border-slate-800">
                          <strong className="text-white block mb-1">
                            🚀 Publishing, Schedules & Add-Ons (8 tools)
                          </strong>
                          <code>webring_export_static_site</code>,{' '}
                          <code>webring_start_preview_server</code>, <code>webring_get_schedule</code>,{' '}
                          <code>webring_set_schedule</code>, <code>webring_run_scheduled_job</code>,{' '}
                          <code>webring_get_addons</code>,{' '}
                          <code>webring_configure_analytics_addon</code>,{' '}
                          <code>webring_configure_ads_addon</code>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2">
                      <p className="text-xs text-slate-400">
                        Ready to copy your one-click MCP configuration or test tools interactively?
                      </p>
                      <button
                        type="button"
                        onClick={() => setActiveTab('mcp')}
                        className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
                      >
                        Open AI Agent (MCP) Hub →
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* SECTION 7: WEBRINGS */}
              {helpSection === 'webrings' && (
                <div className="space-y-6">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
                    <div className="border-b border-slate-800 pb-4">
                      <h3 className="text-xl font-bold">Webrings: Joining, Hosting & Membership</h3>
                      <p className="text-xs text-slate-400 mt-1">
                        A webring is a circle of sites linked by <strong>← Prev</strong>,{' '}
                        <strong>Next →</strong> and <strong>Random</strong>. Each ring has a{' '}
                        <strong>maintainer</strong> who decides who's in it. Everything works with static
                        files: the maintainer publishes a signed member list (the ring's{' '}
                        <em>hub</em>), and each member's site lists the rings it belongs to. You're a
                        member when both agree.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <h4 className="font-bold text-sm text-indigo-300">Joining a ring</h4>
                        <ol className="list-decimal list-inside space-y-1 text-slate-300">
                          <li>Publish your site at least once (the maintainer checks it).</li>
                          <li>
                            In <strong>Friends &amp; Webrings → Join a Webring</strong>, paste the ring's
                            hub URL (or click <strong>Join Ring</strong> on a member's site).
                          </li>
                          <li>
                            Studio verifies the ring and gives you a private, signed{' '}
                            <strong>request link</strong>. Send it to the maintainer any way you like.
                          </li>
                          <li>
                            Once they approve and publish, click <strong>Sync All</strong>. The ring
                            becomes <strong>Member</strong>; publish to show its bar on your site.
                          </li>
                        </ol>
                        <p className="text-slate-400">
                          Your request is never published, so nobody else can see that you applied or
                          were declined. You can join as many rings as you like.
                        </p>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <h4 className="font-bold text-sm text-emerald-300">Hosting a ring</h4>
                        <ol className="list-decimal list-inside space-y-1 text-slate-300">
                          <li>
                            In <strong>Rings You Host</strong>, create a ring and publish. Your site now
                            has its signed hub (<code>api/rings/&lt;name&gt;.json</code>) and a public
                            directory page (<code>rings/&lt;name&gt;/</code>).
                          </li>
                          <li>Share the hub URL or the directory page with people who'd like to join.</li>
                          <li>
                            Paste each request link into <strong>Review a Join Request</strong>. Studio
                            checks the applicant's signature; you choose Approve, Decline or Ban.
                          </li>
                          <li>Publish to make approvals and other changes live.</li>
                        </ol>
                        <p className="text-slate-400">
                          You can host several rings, each separate from your friend list. Use{' '}
                          <strong>I'm a member</strong> to include or leave out your own site.
                        </p>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <h4 className="font-bold text-sm text-amber-300">Leaving, removal &amp; bans</h4>
                        <ul className="list-disc list-inside space-y-1 text-slate-300">
                          <li>
                            <strong>Leaving:</strong> remove the ring from your list and publish. The
                            maintainer's next Sync All notices and removes you.
                          </li>
                          <li>
                            <strong>Removed:</strong> the maintainer drops you from the hub. Your next
                            sync marks the ring <em>Removed</em> and its bar disappears at your next
                            publish. You can ask to join again.
                          </li>
                          <li>
                            <strong>Banned:</strong> like removal, but new requests from your site (or
                            your key, even on a new domain) are declined. Bans are private to the
                            maintainer.
                          </li>
                          <li>
                            <strong>Hidden:</strong> a maintainer can keep a member in the ring but skip
                            them in Prev / Next / Random.
                          </li>
                          <li>
                            <strong>Closed ring:</strong> the maintainer closes it; members' bars go away
                            after their next sync and publish.
                          </li>
                        </ul>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                        <h4 className="font-bold text-sm text-cyan-300">How links stay fresh</h4>
                        <ul className="list-disc list-inside space-y-1 text-slate-300">
                          <li>
                            Prev and Next are written into your page when you publish, so they work
                            without JavaScript.
                          </li>
                          <li>
                            When a visitor clicks Prev, Next or Random, the page quickly re-reads the
                            ring's hub so removed or hidden sites are skipped. If that fails, it uses the
                            saved link.
                          </li>
                          <li>
                            Studio only trusts a hub signed by its maintainer's key, served from the
                            maintainer's own site, and never older than the last one it saw. A key
                            change freezes the ring until you review it; it never removes anyone.
                          </li>
                          <li>
                            New members get 14 days to publish the ring before a maintainer's sync treats
                            them as having left.
                          </li>
                        </ul>
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => setActiveTab('friends')}
                        className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
                      >
                        Open Friends &amp; Webrings →
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* SECTION 6: SECURITY, PRIVACY & TROUBLESHOOTING FAQ */}
              {helpSection === 'privacy-faq' && (
                <div className="space-y-6">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
                    <h3 className="text-xl font-bold">
                      Security Hardening, Social Graph Privacy & Troubleshooting FAQ
                    </h3>

                    <div className="space-y-4">
                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                        <h4 className="font-bold text-sm text-emerald-400">
                          Q: Can strangers or bots scrape my JSON files to map my friend network?
                        </h4>
                        <p className="text-xs text-slate-300 leading-relaxed">
                          <strong>Not unless you explicitly choose to publish them.</strong> By
                          default, Webring Studio enables the{' '}
                          <strong>Social Graph Privacy & Anti-Scraping Shield</strong>:
                        </p>
                        <ul className="text-xs text-slate-400 list-disc list-inside space-y-1 pl-2">
                          <li>
                            Every friend you add defaults to{' '}
                            <strong>🔒 Private (Local Crawler Only)</strong>. They are stored only in
                            your local SQLite database so your desktop Studio can pull their updates
                            into your <em>Neighborhood Feed</em>.
                          </li>
                          <li>
                            Your exported <code>/api/connections.json</code> contains{' '}
                            <code>friends: []</code> unless you mark specific friends as{' '}
                            <strong>🌐 Public</strong>.
                          </li>
                          <li>
                            Even for friends you mark <strong>Public</strong>, real-world XFN
                            relationship tags (<code>met</code>, <code>kin</code>,{' '}
                            <code>colleague</code>) are stripped from the exported JSON by default.
                          </li>
                        </ul>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                        <h4 className="font-bold text-sm text-purple-400">
                          Q: If I manage multiple online personas in Webring Studio, can anyone link
                          them together?
                        </h4>
                        <p className="text-xs text-slate-300 leading-relaxed">
                          <strong>No.</strong> Webring Studio enforces{' '}
                          <strong>Strict Multi-Persona Compartmentalization</strong>: each persona has
                          its own isolated SQLite database file (<code>persona-&lt;id&gt;.sqlite</code>),
                          its own freshly generated Ed25519 cryptographic keypair and{' '}
                          <code>did:web</code> identity, its own isolated media store folder, and its
                          own export folder, SFTP credentials, and analytics/ad add-on settings. In
                          addition, the Persona Manager displays an automatic{' '}
                          <strong>OPSEC Correlation Warning</strong> if you accidentally assign two
                          personas to the same domain hostname.
                        </p>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                        <h4 className="font-bold text-sm text-amber-400">
                          Q: How do Wall Replies, "Like", and "Add to Friend Ring" work on a static
                          site without a backend server?
                        </h4>
                        <p className="text-xs text-slate-300 leading-relaxed">
                          Webring Studio uses a <strong>Dual-Layer Social Architecture</strong>:
                        </p>
                        <ul className="text-xs text-slate-400 list-disc list-inside space-y-1 pl-2">
                          <li>
                            <strong>Layer 1 (Sovereign Ring Replies & Likes):</strong> Clicking{' '}
                            <strong>💬 Reply</strong> or <strong>♥ Like</strong> on a peer's static
                            site (or inside your Neighborhood Feed) creates a signed entry in your own{' '}
                            <code>/api/items.json</code> pointing to the friend's canonical item URI.
                            When your friend crawls the ring, their Studio verifies your Ed25519
                            signature and threads your reply directly under their post!
                          </li>
                          <li>
                            <strong>Layer 2 (Optional Public Guestbook):</strong> For casual web
                            visitors who don't use Webring Studio, you can enable the optional{' '}
                            <strong>Giscus / Utterances</strong> widget in the Publish tab.
                          </li>
                        </ul>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                        <h4 className="font-bold text-sm text-cyan-400">
                          Q: What security protections guard against malicious peer sites during
                          crawling?
                        </h4>
                        <p className="text-xs text-slate-300 leading-relaxed">
                          Webring Studio's <code>RingCrawler</code> and static site generator include
                          these defenses:
                        </p>
                        <ul className="text-xs text-slate-400 list-disc list-inside space-y-1 pl-2">
                          <li>
                            <strong>Signature checks on every document:</strong> each crawled JSON file
                            must carry a valid Ed25519 signature from the key in the friend's{' '}
                            <code>did.json</code>. Unverified content shows without the ✓ Verified
                            badge.
                          </li>
                          <li>
                            <strong>Key pinning:</strong> the first key seen for a friend is pinned. If
                            it later changes, the friend gets a 🚨 Key Changed warning and nothing from
                            them verifies until you sort it out.
                          </li>
                          <li>
                            <strong>No impersonating other friends:</strong> posts whose address points
                            outside the friend's own site are rejected, so one friend can't overwrite
                            another friend's posts.
                          </li>
                          <li>
                            <strong>Safe removals:</strong> posts a friend deleted are removed from your
                            feed only after a verified sync. A failed or tampered fetch never deletes
                            anything.
                          </li>
                          <li>
                            <strong>Fetch limits:</strong> endpoints on another domain are refused, and
                            each file is limited to 5 MB and 10 seconds.
                          </li>
                          <li>
                            <strong>Private network guard:</strong> Studio refuses to fetch anything
                            on your computer, home network or cloud metadata addresses (for example{' '}
                            <code>127.0.0.1</code>, <code>192.168.x.x</code>,{' '}
                            <code>169.254.169.254</code>), so a peer can't use your Studio to probe
                            devices behind your firewall. This is checked on every connection,
                            including redirects.
                          </li>
                          <li>
                            <strong>XSS & Script-Breakout Neutralization:</strong> Escapes embedded
                            JSON payloads in <code>index.html</code> and blocks{' '}
                            <code>javascript:</code> and <code>data:</code> links.
                            Incoming <code>webring://</code> deep links only pre-fill a form; nothing is
                            saved until you submit it.
                          </li>
                        </ul>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                        <h4 className="font-bold text-sm text-rose-400">
                          Q: What's the difference between Mute and Block?
                        </h4>
                        <ul className="text-xs text-slate-400 list-disc list-inside space-y-1 pl-2">
                          <li>
                            <strong>Mute</strong> hides a site's posts from your Neighborhood Feed.
                            It's a personal reading preference and doesn't change your published site.
                          </li>
                          <li>
                            <strong>Block</strong> also stops Studio from crawling that site and keeps
                            their likes and comments off your published site.
                          </li>
                          <li>
                            Either way, the site is told nothing. Undo both from the{' '}
                            <strong>Muted &amp; Blocked Sites</strong> list in the Feed tab.
                          </li>
                          <li>
                            Separately, endorsements whose signature can't be verified are never
                            published, whatever your settings.
                          </li>
                        </ul>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                        <h4 className="font-bold text-sm text-emerald-400">
                          Q: Where are my signing key and publishing passwords stored?
                        </h4>
                        <p className="text-xs text-slate-300 leading-relaxed">
                          Each persona's Ed25519 private key is stored{' '}
                          <strong>encrypted at rest</strong> using your operating system's keychain
                          (Keychain on macOS, DPAPI on Windows, libsecret on Linux). It's never
                          exported or uploaded. Only the running Studio app can unlock it, which is
                          why publishing needs Studio open. If the keychain entry is deleted, the key
                          can't be recovered: you'd need a new key, and friends would see a Key
                          Changed warning.
                        </p>
                        <p className="text-xs text-slate-300 leading-relaxed">
                          Your SFTP/FTP password and GitHub token are encrypted the same way. Studio
                          shows them as <code>••••••••</code> once saved and only unlocks them at the
                          moment it connects to publish, including for scheduled publishes. If the
                          keychain entry is lost, just enter them again.
                        </p>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                        <h4 className="font-bold text-sm text-cyan-400">
                          Q: Can a website I visit control Studio through the MCP endpoint?
                        </h4>
                        <p className="text-xs text-slate-300 leading-relaxed">
                          <strong>No.</strong> The endpoint only listens on <code>127.0.0.1</code>,
                          and because web pages also run on your machine, it refuses browser-style
                          requests:
                        </p>
                        <ul className="text-xs text-slate-400 list-disc list-inside space-y-1 pl-2">
                          <li>
                            Requests with an <code>Origin</code> header (sent by web pages and app
                            windows) are refused unless they carry your access token.
                          </li>
                          <li>
                            The <code>Host</code> must be <code>127.0.0.1</code> or{' '}
                            <code>localhost</code>, which blocks DNS-rebinding tricks.
                          </li>
                          <li>
                            Commands must be sent as JSON, which pages can't do without permission.
                          </li>
                        </ul>
                      </div>

                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
                        <h4 className="font-bold text-sm text-indigo-400">
                          Q: Why does a friend's site show an unverified DID signature when crawled?
                        </h4>
                        <p className="text-xs text-slate-300 leading-relaxed">
                          Ed25519 signature verification checks two things: (1) that{' '}
                          <code>/.well-known/did.json</code> is reachable at the friend's domain, and
                          (2) that the JSON file wasn't modified after signing. If a friend deployed
                          to GitHub Pages before adding <code>.nojekyll</code>, GitHub Pages might
                          return 404 for <code>/.well-known/did.json</code>. Re-exporting from Webring
                          Studio automatically includes <code>.nojekyll</code> to fix this.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Credits, under every Help section */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center gap-4">
                <img src="./logo-mark.png" alt="" className="w-12 h-12 shrink-0" />
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-bold text-white">Credits</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Webring Studio · Envisioned &amp; Orchestrated by <strong className="text-slate-200">Corey Lines</strong> · Oct 2026
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => window.studioApi?.openExternal('https://github.com/lnsCorey/webring')}
                  className="text-xs text-indigo-400 hover:underline font-medium text-left"
                >
                  github.com/lnsCorey/webring →
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Multi-Persona Compartmentalization Manager Modal */}
      {showPersonaModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                  <Layers className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-extrabold text-white">
                    Online Personas & Compartmentalized Identities
                  </h2>
                  <p className="text-xs text-slate-400">
                    Each persona has an isolated SQLite database, independent Ed25519 keypair, separate media store, and separate export / host settings.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowPersonaModal(false)}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300"
              >
                Close ✕
              </button>
            </div>

            <div className="p-6 overflow-y-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* Left Column: Existing Personas List */}
              <div className="lg:col-span-7 space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Your Compartmentalized Personas ({personas.length})
                </h3>
                {(() => {
                  const hostMap = new Map<string, string[]>();
                  for (const p of personas) {
                    try {
                      const host = new URL(p.siteUrl).hostname.toLowerCase();
                      if (host && host !== 'my-profile.local') {
                        hostMap.set(host, [...(hostMap.get(host) || []), p.label]);
                      }
                    } catch {
                      // ignore invalid URL
                    }
                  }
                  const sharedHosts = Array.from(hostMap.entries()).filter(
                    ([, labels]) => labels.length > 1
                  );
                  if (sharedHosts.length === 0) return null;
                  return (
                    <div className="p-3.5 rounded-xl bg-amber-950/40 border border-amber-500/40 text-xs text-amber-200 space-y-1">
                      <p className="font-bold text-amber-300">
                        ⚠️ Cross-Persona OPSEC Correlation Warning
                      </p>
                      <p className="text-amber-200/90 leading-relaxed">
                        Multiple personas share the same domain hostname (
                        {sharedHosts
                          .map(([h, labels]) => `${h}: ${labels.join(' & ')}`)
                          .join('; ')}
                        ). Even though their SQLite databases and Ed25519 keys are strictly
                        isolated, hosting two personas on subpaths of the same domain or GitHub
                        Pages account allows observers to correlate them. Use separate domains or
                        separate hosting accounts for anonymous aliases.
                      </p>
                    </div>
                  );
                })()}
                <div className="space-y-3">
                  {personas.map((p) => {
                    const isActive = p.id === activePersonaId;
                    const isEditing = editingPersonaId === p.id;
                    return (
                      <div
                        key={p.id}
                        className={`p-4 rounded-xl border transition ${
                          isActive
                            ? 'bg-indigo-950/30 border-indigo-500/60 shadow-lg shadow-indigo-950/30'
                            : 'bg-slate-950/70 border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <img
                              src={
                                p.avatarUrl ||
                                `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent(
                                  p.displayName
                                )}`
                              }
                              alt={p.displayName}
                              className="w-12 h-12 rounded-xl object-cover border border-slate-700 shrink-0"
                            />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-bold text-sm text-white truncate">
                                  {p.displayName}
                                </span>
                                {isEditing ? (
                                  <span className="inline-flex items-center gap-1">
                                    <input
                                      type="text"
                                      value={editingPersonaLabel}
                                      onChange={(e) => setEditingPersonaLabel(e.target.value)}
                                      className="px-2 py-0.5 rounded bg-slate-900 border border-indigo-500 text-xs text-white w-32"
                                      placeholder="Studio Label"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => handleRenamePersona(p.id)}
                                      className="text-[10px] px-2 py-0.5 rounded bg-emerald-600 text-white font-semibold"
                                    >
                                      Save
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setEditingPersonaId(null)}
                                      className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400"
                                    >
                                      Cancel
                                    </button>
                                  </span>
                                ) : (
                                  <span
                                    onClick={() => {
                                      setEditingPersonaId(p.id);
                                      setEditingPersonaLabel(p.label);
                                    }}
                                    className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-semibold cursor-pointer hover:bg-indigo-500/30"
                                    title="Click to rename studio label"
                                  >
                                    {p.label} ✎
                                  </span>
                                )}
                                {isActive && (
                                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">
                                    ACTIVE
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-slate-400 font-mono truncate mt-0.5">
                                {p.siteUrl}
                              </p>
                              <p className="text-[11px] text-emerald-400/90 font-mono truncate">
                                {p.did}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            {!isActive && (
                              <button
                                type="button"
                                onClick={() => handleSwitchPersona(p.id)}
                                className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition"
                              >
                                Switch
                              </button>
                            )}
                            {p.id !== 'default' && (
                              <button
                                type="button"
                                onClick={() => handleDeletePersona(p.id, p.label)}
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-950/60 text-slate-400 hover:text-rose-300 transition"
                                title="Delete this persona"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                          <div className="flex items-center gap-3">
                            <span>📸 {p.stats?.photoCount ?? 0} photos</span>
                            <span>✨ {p.stats?.itemCount ?? 0} items</span>
                            <span>🤝 {p.stats?.friendCount ?? 0} friends</span>
                          </div>
                          <span className="font-mono text-[10px] text-slate-500" title="Isolated SQLite Database File">
                            DB: {p.dbFileName}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Right Column: Create New Persona Form */}
              <div className="lg:col-span-5 bg-slate-950 border border-slate-800 rounded-xl p-5 space-y-4 self-start">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <UserPlus className="w-4 h-4 text-indigo-400" />
                    Create New Online Persona
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Generates a fresh SQLite database, a brand-new Ed25519 cryptographic keypair, and an isolated media store so this persona cannot be correlated with your other identities.
                  </p>
                </div>

                <form onSubmit={handleCreatePersona} className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Studio Workspace Label *
                    </label>
                    <input
                      type="text"
                      required
                      value={newPersonaLabel}
                      onChange={(e) => setNewPersonaLabel(e.target.value)}
                      placeholder="e.g., Alt Handle / Music Alias / Professional"
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white"
                    />
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Private label shown only inside your local Studio switcher.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Public Display Name / Handle *
                    </label>
                    <input
                      type="text"
                      required
                      value={newPersonaDisplayName}
                      onChange={(e) => setNewPersonaDisplayName(e.target.value)}
                      placeholder="e.g., Nightowl Synth"
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Hosted Website URL (Domain or Subpath)
                    </label>
                    <input
                      type="url"
                      value={newPersonaSiteUrl}
                      onChange={(e) => setNewPersonaSiteUrl(e.target.value)}
                      placeholder="https://nightowl.github.io or https://domain.com/alt"
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white font-mono"
                    />
                    {newPersonaSiteUrl.trim() && (
                      <p className="text-[11px] text-emerald-400 font-mono mt-1 truncate">
                        DID: {siteUrlToDidWeb(newPersonaSiteUrl.trim())}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Tagline (Optional)
                    </label>
                    <input
                      type="text"
                      value={newPersonaTagline}
                      onChange={(e) => setNewPersonaTagline(e.target.value)}
                      placeholder="Ambient electronics & late-night field recordings"
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      Initial Visual Theme
                    </label>
                    <select
                      value={newPersonaTheme}
                      onChange={(e) => setNewPersonaTheme(e.target.value as ProfileTheme)}
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-sm text-white"
                    >
                      {(Object.keys(THEME_LABELS) as ProfileTheme[]).map((id) => (
                        <option key={id} value={id}>{THEME_LABELS[id]}</option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="submit"
                    className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 transition"
                  >
                    <Plus className="w-4 h-4" />
                    Create Isolated Persona & Switch
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

