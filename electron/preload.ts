import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { WebringDeepLinkAction } from '../src/shared/schema';

contextBridge.exposeInMainWorld('studioApi', {
  getBundle: () => ipcRenderer.invoke('studio:get-bundle'),
  listPersonas: () => ipcRenderer.invoke('studio:list-personas'),
  createPersona: (input: unknown) => ipcRenderer.invoke('studio:create-persona', input),
  switchPersona: (personaId: string) => ipcRenderer.invoke('studio:switch-persona', personaId),
  updatePersonaLabel: (personaId: string, label: string) =>
    ipcRenderer.invoke('studio:update-persona-label', personaId, label),
  deletePersona: (personaId: string, deleteFiles?: boolean) =>
    ipcRenderer.invoke('studio:delete-persona', personaId, deleteFiles),
  updateProfile: (updates: unknown) => ipcRenderer.invoke('studio:update-profile', updates),
  createAlbum: (input: unknown) => ipcRenderer.invoke('studio:create-album', input),
  deleteAlbum: (albumId: string) => ipcRenderer.invoke('studio:delete-album', albumId),
  addPhoto: (input: unknown) => ipcRenderer.invoke('studio:add-photo', input),
  importPhotos: (albumId: string, filePaths?: string[]) =>
    ipcRenderer.invoke('studio:media-import-photos', albumId, filePaths),
  replacePhoto: (photoId: string) => ipcRenderer.invoke('studio:media-replace-photo', photoId),
  importImage: () => ipcRenderer.invoke('studio:media-import-image'),
  setProfileImage: (kind: 'avatar' | 'banner', filePath?: string) =>
    ipcRenderer.invoke('studio:profile-set-image', kind, filePath),
  updatePhoto: (photoId: string, updates: unknown) => ipcRenderer.invoke('studio:media-update-photo', photoId, updates),
  movePhoto: (photoId: string, direction: 'up' | 'down') =>
    ipcRenderer.invoke('studio:media-move-photo', photoId, direction),
  updateAlbum: (albumId: string, updates: unknown) => ipcRenderer.invoke('studio:media-update-album', albumId, updates),
  getMediaUsage: () => ipcRenderer.invoke('studio:media-usage'),
  forgetPublishHistory: () => ipcRenderer.invoke('studio:forget-publish-history'),
  // Dropped files carry no path in a sandboxed window; webUtils recovers it
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  deletePhoto: (photoId: string) => ipcRenderer.invoke('studio:delete-photo', photoId),
  createItem: (input: unknown) => ipcRenderer.invoke('studio:create-item', input),
  deleteItem: (itemId: string) => ipcRenderer.invoke('studio:delete-item', itemId),
  savePost: (canonicalUrl: string) => ipcRenderer.invoke('studio:save-post', canonicalUrl),
  unsavePost: (savedId: string) => ipcRenderer.invoke('studio:unsave-post', savedId),
  updateSavedNote: (savedId: string, note: string) => ipcRenderer.invoke('studio:saved-note', savedId, note),
  setFeedRetention: (days: number) => ipcRenderer.invoke('studio:set-feed-retention', days),
  updateItem: (itemId: string, updates: unknown) => ipcRenderer.invoke('studio:update-item', itemId, updates),
  addFriend: (input: unknown) => ipcRenderer.invoke('studio:add-friend', input),
  setFriendVisibility: (friendId: string, visibility: 'private' | 'public') =>
    ipcRenderer.invoke('studio:set-friend-visibility', friendId, visibility),
  deleteFriend: (friendId: string) => ipcRenderer.invoke('studio:delete-friend', friendId),
  setModeration: (siteUrl: string, action: 'mute' | 'block' | null) =>
    ipcRenderer.invoke('studio:set-moderation', siteUrl, action),
  updateWebring: (ringId: string, updates: unknown) =>
    ipcRenderer.invoke('studio:update-webring', ringId, updates),
  deleteWebring: (ringId: string) => ipcRenderer.invoke('studio:delete-webring', ringId),
  crawlFriend: (siteUrl: string, localDirOverride?: string) =>
    ipcRenderer.invoke('studio:crawl-friend', siteUrl, localDirOverride),
  crawlAllFriends: () => ipcRenderer.invoke('studio:crawl-all-friends'),
  requestToJoinRing: (hubUrl: string) => ipcRenderer.invoke('studio:ring-request-join', hubUrl),
  reviewRingRequest: (link: string) => ipcRenderer.invoke('studio:ring-review-request', link),
  decideRingRequest: (link: string, decision: 'approve' | 'decline' | 'ban', reason?: string) =>
    ipcRenderer.invoke('studio:ring-decide-request', link, decision, reason),
  syncRings: () => ipcRenderer.invoke('studio:ring-sync-all'),
  createHostedRing: (input: { name: string; description?: string }) =>
    ipcRenderer.invoke('studio:hosted-ring-create', input),
  updateHostedRing: (ringId: string, updates: unknown) =>
    ipcRenderer.invoke('studio:hosted-ring-update', ringId, updates),
  updateRingMember: (
    ringId: string,
    siteUrl: string,
    change: { action: 'remove' | 'ban' | 'unban' | 'hide' | 'show' | 'up' | 'down'; reason?: string }
  ) => ipcRenderer.invoke('studio:hosted-ring-member', ringId, siteUrl, change),
  chooseExportFolder: () => ipcRenderer.invoke('studio:choose-export-folder'),
  exportLocal: (targetDir?: string) => ipcRenderer.invoke('studio:export-local', targetDir),
  testExportPreview: (openInBrowser?: boolean) =>
    ipcRenderer.invoke('studio:test-export-preview', openInBrowser),
  openExternal: (url: string) => ipcRenderer.invoke('studio:open-external', url),
  publishRemote: (settings: unknown) => ipcRenderer.invoke('studio:publish-remote', settings),
  publishGithub: (settings: unknown) => ipcRenderer.invoke('studio:publish-github', settings),
  checkGithubRepo: (settings: unknown) => ipcRenderer.invoke('studio:check-github-repo', settings),
  openPath: (targetPath: string) => ipcRenderer.invoke('studio:open-path', targetPath),
  getMcpInfo: () => ipcRenderer.invoke('studio:get-mcp-info'),
  callMcpTool: (toolName: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke('studio:call-mcp-tool', toolName, args),
  onMcpActivity: (callback: (entry: unknown) => void) => {
    const listener = (_event: unknown, entry: unknown) => callback(entry);
    ipcRenderer.on('studio:mcp-activity', listener);
    return () => ipcRenderer.removeListener('studio:mcp-activity', listener);
  },
  getSchedule: () => ipcRenderer.invoke('studio:get-schedule'),
  setSchedule: (change: unknown) => ipcRenderer.invoke('studio:set-schedule', change),
  runJobNow: (personaId: string, job: 'sync' | 'publish') =>
    ipcRenderer.invoke('studio:run-job-now', personaId, job),
  onScheduleUpdated: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('studio:schedule-updated', listener);
    return () => ipcRenderer.removeListener('studio:schedule-updated', listener);
  },
  onRingRequestLink: (callback: (link: string) => void) => {
    const listener = (_event: unknown, link: string) => callback(link);
    ipcRenderer.on('webring:ring-request', listener);
    return () => ipcRenderer.removeListener('webring:ring-request', listener);
  },
  onDeepLink: (callback: (action: WebringDeepLinkAction) => void) => {
    const listener = (_event: unknown, action: WebringDeepLinkAction) => callback(action);
    ipcRenderer.on('webring:deep-link', listener);
    return () => ipcRenderer.removeListener('webring:deep-link', listener);
  },
});

