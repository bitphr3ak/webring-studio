import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  shell,
  Tray,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { PersonaManager } from './services/personaManager';
import { LocalPreviewServer } from './services/localPreviewServer';
import { WebringMcpServer } from './mcp/mcpServer';
import { McpHttpServer } from './mcp/mcpHttpServer';
import { DEMO_PEER_FOLDER_NAME } from './db/legacyDemoContent';
import { isRingMemberFlagged } from './services/ringService';
import {
  describePreset,
  jobNextRunAt,
  PersonaSchedule,
  PublishDestination,
  ScheduledJobKind,
  Scheduler,
  SchedulerConfig,
} from './services/scheduler';
import { publishTo, runScheduledPublish, runSyncAll, summarizeSync } from './services/jobs';
import {
  cleanUpLibrary,
  deleteAlbumWithFiles,
  deletePhotoWithFiles,
  importPhotosIntoAlbum,
  replacePhotoImage,
  setProfileImageFromFile,
} from './services/mediaLibrary';
import { showSplash } from './splash';
import { savePost, unsavePost } from './services/savedPosts';

// Lets the Studio window show Media Library images: studio-media://local/<path> maps to the
// active persona's library file for media/<path>. Must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'studio-media', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
import {
  CreatePersonaInput,
  ModerationAction,
  parseRingRequestUri,
  parseWebringUri,
} from '../src/shared/schema';

let mainWindow: BrowserWindow | null = null;
let personaManager: PersonaManager;
let localPreviewServer: LocalPreviewServer;
let webringMcpServer: WebringMcpServer;
let mcpHttpServer: McpHttpServer;
let scheduler: Scheduler;
let tray: Tray | null = null;
let isQuitting = false;
let startupComplete = false;

const publishPaths = () => ({ userDataDir: app.getPath('userData'), tempDir: app.getPath('temp') });

/** Applies "start at login": launches hidden in the tray with --background. */
function applyLoginItem(config: SchedulerConfig) {
  if (process.platform === 'linux') return; // Not supported by Electron on Linux
  app.setLoginItemSettings({ openAtLogin: config.startAtLogin, args: ['--background'] });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function personaLabel(personaId: string): string {
  return personaManager.listPersonaRecords().find((p) => p.id === personaId)?.label || personaId;
}

/** Every persona's schedule with its next run, for the UI, tray and MCP. */
function scheduleOverview() {
  const config = scheduler.loadConfig();
  const personas = personaManager.listPersonaRecords().map((record) => {
    const schedule: PersonaSchedule = scheduler.getPersonaSchedule(record.id);
    const next = (job: ScheduledJobKind) =>
      schedule[job].enabled && !config.paused ? jobNextRunAt(schedule[job]).toISOString() : null;
    return {
      personaId: record.id,
      label: record.label,
      schedule,
      nextSyncAt: next('sync'),
      nextPublishAt: next('publish'),
      describe: {
        sync: describePreset(schedule.sync.preset),
        publish: describePreset(schedule.publish.preset),
      },
    };
  });
  return {
    app: {
      runInBackground: config.runInBackground,
      startAtLogin: config.startAtLogin,
      paused: config.paused,
      notifyOnFailure: config.notifyOnFailure,
    },
    personas,
    history: config.history.map((h) => ({ ...h, label: personaLabel(h.personaId) })),
    running: scheduler.isRunning(),
  };
}

function refreshTrayMenu() {
  if (!tray) return;
  const overview = scheduleOverview();
  const upcoming = overview.personas
    .flatMap((p) => [
      p.nextSyncAt ? { at: p.nextSyncAt, text: `${p.label}: sync` } : null,
      p.nextPublishAt ? { at: p.nextPublishAt, text: `${p.label}: publish` } : null,
    ])
    .filter((x): x is { at: string; text: string } => Boolean(x))
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  const activeId = personaManager.getActivePersonaId();
  const nextLabel = overview.app.paused
    ? 'Schedules paused'
    : upcoming
      ? `Next: ${upcoming.text} at ${new Date(upcoming.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : 'No schedules set';
  tray.setToolTip(`Webring Studio — ${nextLabel}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Webring Studio', click: () => showMainWindow() },
      { type: 'separator' },
      { label: nextLabel, enabled: false },
      {
        label: `Sync now (${personaLabel(activeId)})`,
        click: () => void scheduler.runNow(activeId, 'sync'),
      },
      {
        label: `Publish now (${personaLabel(activeId)})`,
        click: () => void scheduler.runNow(activeId, 'publish'),
      },
      {
        label: overview.app.paused ? 'Resume schedules' : 'Pause schedules',
        click: () => {
          scheduler.setAppSettings({ paused: !overview.app.paused });
          refreshTrayMenu();
          mainWindow?.webContents.send('studio:schedule-updated');
          if (overview.app.paused) void scheduler.tick();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit Webring Studio',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

/** Branded images generated from images/logo-icon.png by scripts/generate-icons.py. */
const assetPath = (name: string) => path.join(__dirname, '../../electron/assets', name);

function createTray() {
  // macOS menu bars want a monochrome template; Windows and Linux trays show the colour logo
  const isMac = process.platform === 'darwin';
  const iconPath = assetPath(isMac ? 'trayTemplate.png' : 'trayIcon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  if (icon.isEmpty() && process.platform === 'darwin') tray.setTitle('◎');
  tray.on('click', () => {
    if (process.platform !== 'darwin') showMainWindow();
  });
  refreshTrayMenu();
}

async function initServices() {
  const userDataDir = app.getPath('userData');
  // Seal each persona's Ed25519 private key with the OS keychain while the app is running
  personaManager = new PersonaManager(userDataDir, {
    keyCipher: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plainText) => safeStorage.encryptString(plainText),
      decrypt: (cipherText) => safeStorage.decryptString(cipherText),
    },
  });
  localPreviewServer = new LocalPreviewServer();
  webringMcpServer = new WebringMcpServer(
    personaManager,
    userDataDir,
    localPreviewServer,
    (entry) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('studio:mcp-activity', entry);
      }
    }
  );
  scheduler = new Scheduler({
    configPath: path.join(userDataDir, 'scheduler.json'),
    listPersonaIds: () => personaManager.listPersonaRecords().map((p) => p.id),
    runner: {
      sync: (personaId) =>
        personaManager.withPersonaContext(personaId, async (ctx) => summarizeSync(await runSyncAll(ctx))),
      publish: (personaId, destination, syncFirst) =>
        personaManager.withPersonaContext(personaId, (ctx) =>
          runScheduledPublish(ctx, destination, syncFirst, publishPaths())
        ),
    },
    onJobFinished: (personaId, job, result) => {
      const config = scheduler.loadConfig();
      if (result.status === 'failed' && config.notifyOnFailure && Notification.isSupported()) {
        new Notification({
          title: `Scheduled ${job} failed: ${personaLabel(personaId)}`,
          body: result.message.slice(0, 200),
        }).show();
      }
      refreshTrayMenu();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('studio:schedule-updated', { personaId, job, result });
      }
    },
  });
  applyLoginItem(scheduler.loadConfig());

  // Older versions generated a fictional demo friend's site here; it's no longer used
  fs.rmSync(path.join(userDataDir, DEMO_PEER_FOLDER_NAME), { recursive: true, force: true });
  webringMcpServer.attachScheduler(scheduler);

  mcpHttpServer = new McpHttpServer(webringMcpServer, {
    settingsPath: path.join(userDataDir, 'mcp-http.json'),
  });
  await mcpHttpServer.start(0);
}

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    show,
    // Window and taskbar icon on Windows and Linux (macOS uses the app/dock icon)
    icon: assetPath('app-icon.png'),
    width: 1380,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Webring Studio — Decentralized Profile & Ring Manager',
    backgroundColor: '#090d16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Links inside Studio (Markdown previews, posts) never open in an Electron window, which would
  // get Studio's preload API: web links go to the default browser, anything else is ignored
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appUrl = mainWindow?.webContents.getURL() || '';
    const sameDocument = url.split('#')[0] === appUrl.split('#')[0];
    if (sameDocument) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url) && !url.startsWith(process.env.VITE_DEV_SERVER_URL || '\u0000')) void shell.openExternal(url);
  });

  // In background mode, closing the window hides it so schedules keep running in the tray
  mainWindow.on('close', (event) => {
    if (!isQuitting && scheduler?.loadConfig().runInBackground) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    const indexHtmlPath = path.join(__dirname, '../../dist/index.html');
    mainWindow.loadFile(indexHtmlPath);
  }
}

function handleDeepLinkUrl(rawUri: string) {
  // Ring requests only open the review screen; nothing is approved without the maintainer
  if (rawUri.startsWith('webring://ring-request') && parseRingRequestUri(rawUri) && mainWindow) {
    mainWindow.webContents.send('webring:ring-request', rawUri);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  const parsed = parseWebringUri(rawUri);
  if (parsed && mainWindow) {
    mainWindow.webContents.send('webring:deep-link', parsed);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

// Register custom protocol `webring://`
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('webring', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('webring');
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const uriArg = commandLine.find((arg) => arg.startsWith('webring://'));
    if (uriArg) {
      handleDeepLinkUrl(uriArg);
    }
    showMainWindow();
  });

  app.whenReady().then(async () => {
    // Launched at login: start quietly in the tray
    const startHidden =
      process.argv.includes('--background') ||
      (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
    // Opening the personas reads their keys from the OS keychain, which can block on a macOS
    // Keychain prompt, so this comes before the splash
    await initServices();
    registerIpcHandlers();
    // The splash plays while the main window loads; skipped in the background, for a webring://
    // link launch, or with --no-splash
    const launchedByLink = process.argv.some((arg) => arg.startsWith('webring://'));
    const splashDone =
      startHidden || launchedByLink || process.argv.includes('--no-splash')
        ? null
        : showSplash(assetPath('splash.html'));
    protocol.handle('studio-media', (request) => {
      // Studio uses studio-media://local/<path>; the site preview's <base> gives studio-media://local/media/<path>
      const relative = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, '')).replace(/^media\//, '');
      const file = personaManager.getActiveContext().mediaLibrary.resolveLocalUrl(`media/${relative}`);
      if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    // Packaged builds get their icon from build/icon.*; when running from source, show the logo
    // in the dock and About panel instead of Electron's default
    if (process.platform === 'darwin' && !app.isPackaged && fs.existsSync(assetPath('dock-icon.png'))) {
      app.dock?.setIcon(nativeImage.createFromPath(assetPath('dock-icon.png')));
    }
    app.setAboutPanelOptions({ applicationName: 'Webring Studio', iconPath: assetPath('app-icon.png') });
    createWindow(!startHidden && !splashDone);
    if (splashDone) {
      // Show the main window in the splash's place once it has played (unless the tray or a
      // second launch already showed it)
      void splashDone.then(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) showMainWindow();
      });
    }
    createTray();
    scheduler.start();
    // Catch up after sleep; the 60-second tick handles everything else
    powerMonitor.on('resume', () => void scheduler.tick());
    powerMonitor.on('unlock-screen', () => void scheduler.tick());
    startupComplete = true;

    // Check if launched with a webring:// URI
    const startupUri = process.argv.find((arg) => arg.startsWith('webring://'));
    if (startupUri) {
      setTimeout(() => handleDeepLinkUrl(startupUri), 1000);
    }
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLinkUrl(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !scheduler?.loadConfig().runInBackground) {
    app.quit();
  }
});

// macOS also fires 'activate' on launch; only honour dock clicks once startup is done
app.on('activate', () => {
  if (startupComplete) showMainWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  scheduler?.stop();
});

function registerIpcHandlers() {
  ipcMain.handle('studio:get-bundle', () => {
    const ctx = personaManager.getActiveContext();
    const bundle = ctx.db.buildSignedSiteBundle();
    const publishedBundle = ctx.db.buildSignedSiteBundle({ publish: true });
    const personaList = personaManager.listPersonas();
    const profileWithSettings = ctx.db.getProfile();
    const curatedFeed = ctx.db.getCuratedNetworkFeed();
    return {
      activePersonaId: personaList.activePersonaId,
      personas: personaList.personas,
      bundle,
      allFriends: ctx.db.getFriends(),
      allEndorsements: ctx.db.getEndorsements(),
      profileWithSettings,
      networkFeed: curatedFeed.entries,
      joinedRings: ctx.db.getJoinedRings(),
      hostedRings: ctx.db.getHostedRings().map((ring) => ({
        ...ring,
        members: ring.members.map((m) => ({ ...m, flagged: isRingMemberFlagged(m) })),
      })),
      feedExclusions: curatedFeed.excluded,
      moderation: ctx.db.getModeration(),
      changesSinceLastPublish: ctx.db.countChangesSince(
        profileWithSettings.publishSettings.lastPublishedAt
      ),
      publishedUpToDate:
        Boolean(profileWithSettings.publishSettings.lastPublishedFingerprint) &&
        ctx.siteGenerator.contentFingerprint(publishedBundle) ===
          profileWithSettings.publishSettings.lastPublishedFingerprint,
      // The preview shows the published page: recent items, with older ones under "Older posts"
      previewHtml: ctx.siteGenerator.buildStandaloneProfileHtml(publishedBundle, { preview: true }),
      savedPosts: ctx.db.getSavedPosts(),
      feedRetentionDays: ctx.db.getFeedRetentionDays(),
    };
  });

  // Saved posts and the feed window (both local only)
  ipcMain.handle('studio:save-post', async (_e, canonicalUrl: string) => {
    const ctx = personaManager.getActiveContext();
    return savePost(ctx.db, ctx.mediaLibrary, String(canonicalUrl));
  });
  ipcMain.handle('studio:unsave-post', (_e, savedId: string) => {
    const ctx = personaManager.getActiveContext();
    unsavePost(ctx.db, ctx.mediaLibrary, String(savedId));
    return { ok: true };
  });
  ipcMain.handle('studio:saved-note', (_e, savedId: string, note: string) => {
    personaManager.getActiveContext().db.updateSavedNote(String(savedId), String(note || ''));
    return { ok: true };
  });
  ipcMain.handle('studio:set-feed-retention', (_e, days: number) => {
    return personaManager.getActiveContext().db.setFeedRetentionDays(Number(days));
  });

  ipcMain.handle('studio:list-personas', () => {
    return personaManager.listPersonas();
  });

  ipcMain.handle('studio:create-persona', (_e, input: CreatePersonaInput) => {
    return personaManager.createPersona(input);
  });

  ipcMain.handle('studio:switch-persona', (_e, personaId: string) => {
    return personaManager.switchPersona(personaId);
  });

  ipcMain.handle('studio:update-persona-label', (_e, personaId: string, label: string) => {
    return personaManager.updatePersonaLabel(personaId, label);
  });

  ipcMain.handle('studio:delete-persona', (_e, personaId: string) => {
    return personaManager.deletePersona(personaId);
  });

  ipcMain.handle('studio:update-profile', (_e, updates) => {
    const ctx = personaManager.getActiveContext();
    const profile = ctx.db.updateProfile(updates);
    // A replaced profile photo or banner that was uploaded to the library is deleted here
    if (updates && typeof updates === 'object' && ('avatarUrl' in updates || 'bannerUrl' in updates)) {
      cleanUpLibrary(ctx.db, ctx.mediaLibrary);
    }
    return profile;
  });

  // Upload a local image as the profile photo or banner (picked here, or dropped in Studio)
  ipcMain.handle('studio:profile-set-image', async (_e, kind: 'avatar' | 'banner', filePath?: string) => {
    if (kind !== 'avatar' && kind !== 'banner') throw new Error('Unknown profile image.');
    let file = filePath;
    if (!file) {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: kind === 'avatar' ? 'Choose Profile Photo' : 'Choose Banner Image',
        properties: ['openFile'],
        filters: [{ name: 'Images (JPEG, PNG)', extensions: ['jpg', 'jpeg', 'png'] }],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      file = result.filePaths[0];
    }
    const ctx = personaManager.getActiveContext();
    return { url: setProfileImageFromFile(ctx.db, ctx.mediaLibrary, kind, file) };
  });

  ipcMain.handle('studio:create-album', (_e, input) => {
    return personaManager.getActiveContext().db.createAlbum(input);
  });

  ipcMain.handle('studio:delete-album', (_e, albumId: string) => {
    const ctx = personaManager.getActiveContext();
    deleteAlbumWithFiles(ctx.db, ctx.mediaLibrary, albumId);
    return { ok: true };
  });

  ipcMain.handle('studio:add-photo', (_e, input) => {
    return personaManager.getActiveContext().db.addPhotoToAlbum(input);
  });

  ipcMain.handle('studio:delete-photo', (_e, photoId: string) => {
    const ctx = personaManager.getActiveContext();
    deletePhotoWithFiles(ctx.db, ctx.mediaLibrary, photoId);
    return { ok: true };
  });

  const photoFilters = [{ name: 'Photos (JPEG, PNG)', extensions: ['jpg', 'jpeg', 'png'] }];

  ipcMain.handle('studio:media-import-photos', async (_e, albumId: string, filePaths?: string[]) => {
    let files = filePaths;
    if (!files) {
      if (!mainWindow) return { added: [], failed: [] };
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Add Photos to Album',
        properties: ['openFile', 'multiSelections'],
        filters: photoFilters,
      });
      if (result.canceled) return { added: [], failed: [] };
      files = result.filePaths;
    }
    const ctx = personaManager.getActiveContext();
    return importPhotosIntoAlbum(ctx.db, ctx.mediaLibrary, albumId, files);
  });

  // A single image for a wall post: same optimizing, metadata-stripping pipeline as album photos
  ipcMain.handle('studio:media-import-image', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach Image',
      properties: ['openFile'],
      filters: photoFilters,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const media = personaManager.getActiveContext().mediaLibrary.importPhoto(result.filePaths[0], 'wall-posts');
    return { url: media.url, fileName: path.basename(result.filePaths[0]) };
  });

  ipcMain.handle('studio:media-replace-photo', async (_e, photoId: string) => {
    if (!mainWindow) return { replaced: false };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Replace Photo',
      properties: ['openFile'],
      filters: photoFilters,
    });
    if (result.canceled || result.filePaths.length === 0) return { replaced: false };
    const ctx = personaManager.getActiveContext();
    replacePhotoImage(ctx.db, ctx.mediaLibrary, photoId, result.filePaths[0]);
    return { replaced: true };
  });

  ipcMain.handle(
    'studio:media-update-photo',
    (_e, photoId: string, updates: { caption?: string; altText?: string; tags?: string[] }) => {
      return personaManager.getActiveContext().db.updatePhotoDetails(photoId, updates);
    }
  );

  ipcMain.handle('studio:media-move-photo', (_e, photoId: string, direction: 'up' | 'down') => {
    personaManager.getActiveContext().db.movePhoto(photoId, direction);
    return { ok: true };
  });

  ipcMain.handle(
    'studio:media-update-album',
    (_e, albumId: string, updates: { title?: string; description?: string; tags?: string[]; coverUrl?: string }) => {
      return personaManager.getActiveContext().db.updateAlbum(albumId, updates);
    }
  );

  ipcMain.handle('studio:media-usage', () => {
    const ctx = personaManager.getActiveContext();
    cleanUpLibrary(ctx.db, ctx.mediaLibrary);
    return ctx.mediaLibrary.storageUsage();
  });

  ipcMain.handle('studio:forget-publish-history', () => {
    personaManager.getActiveContext().db.clearAllPublishLedgers();
    return { ok: true };
  });

  ipcMain.handle('studio:create-item', (_e, input) => {
    return personaManager.getActiveContext().db.createItem(input);
  });

  ipcMain.handle('studio:update-item', (_e, itemId: string, updates) => {
    const ctx = personaManager.getActiveContext();
    const item = ctx.db.updateItem(itemId, updates);
    cleanUpLibrary(ctx.db, ctx.mediaLibrary); // a replaced or removed post image
    return item;
  });

  ipcMain.handle('studio:delete-item', (_e, itemId: string) => {
    const ctx = personaManager.getActiveContext();
    ctx.db.deleteItem(itemId);
    cleanUpLibrary(ctx.db, ctx.mediaLibrary);
    return { ok: true };
  });

  ipcMain.handle('studio:add-friend', (_e, input) => {
    return personaManager.getActiveContext().db.addOrUpdateFriend(input);
  });

  ipcMain.handle('studio:set-friend-visibility', (_e, friendId: string, visibility: 'private' | 'public') => {
    return personaManager.getActiveContext().db.setFriendVisibility(friendId, visibility);
  });

  ipcMain.handle('studio:delete-friend', (_e, friendId: string) => {
    personaManager.getActiveContext().db.deleteFriend(friendId);
    return { ok: true };
  });

  ipcMain.handle('studio:set-moderation', (_e, siteUrl: string, action: ModerationAction | null) => {
    return personaManager.getActiveContext().db.setModeration(siteUrl, action);
  });

  ipcMain.handle('studio:update-webring', (_e, ringId: string, updates) => {
    return personaManager.getActiveContext().db.updateWebring(ringId, updates);
  });

  ipcMain.handle('studio:delete-webring', (_e, ringId: string) => {
    personaManager.getActiveContext().db.deleteWebring(ringId);
    return { ok: true };
  });

  ipcMain.handle('studio:crawl-friend', async (_e, siteUrl: string, localDirOverride?: string) => {
    return await personaManager.getActiveContext().ringCrawler.crawlFriendSite(siteUrl, localDirOverride);
  });

  // Manual syncs and publishes share the scheduler's per-persona lock, so they never overlap a scheduled run
  const withActiveLock = <T>(fn: () => Promise<T>) =>
    scheduler.runExclusive(personaManager.getActivePersonaId(), fn);

  ipcMain.handle('studio:crawl-all-friends', async () => {
    return withActiveLock(() => personaManager.getActiveContext().ringCrawler.crawlAllFriends());
  });

  ipcMain.handle('studio:ring-request-join', async (_e, hubUrl: string) => {
    return await personaManager.getActiveContext().ringService.requestToJoin(hubUrl);
  });

  ipcMain.handle('studio:ring-review-request', async (_e, link: string) => {
    return await personaManager.getActiveContext().ringService.reviewRequest(link);
  });

  ipcMain.handle(
    'studio:ring-decide-request',
    async (_e, link: string, decision: 'approve' | 'decline' | 'ban', reason?: string) => {
      return await personaManager.getActiveContext().ringService.decideRequest(link, decision, reason);
    }
  );

  ipcMain.handle('studio:ring-sync-all', async () => {
    return withActiveLock(async () => {
      const { ringService } = personaManager.getActiveContext();
      return {
        joined: await ringService.syncJoinedRings(),
        hosted: await ringService.syncHostedRings(),
      };
    });
  });

  ipcMain.handle('studio:get-schedule', () => scheduleOverview());

  ipcMain.handle(
    'studio:set-schedule',
    (
      _e,
      change:
        | { personaId: string; sync?: Record<string, unknown>; publish?: Record<string, unknown> }
        | { app: Partial<Pick<SchedulerConfig, 'runInBackground' | 'startAtLogin' | 'paused' | 'notifyOnFailure'>> }
    ) => {
      if ('app' in change) {
        const config = scheduler.setAppSettings(change.app);
        applyLoginItem(config);
      } else {
        scheduler.setPersonaSchedule(change.personaId, {
          sync: change.sync as Parameters<Scheduler['setPersonaSchedule']>[1]['sync'],
          publish: change.publish as Parameters<Scheduler['setPersonaSchedule']>[1]['publish'],
        });
      }
      refreshTrayMenu();
      return scheduleOverview();
    }
  );

  ipcMain.handle('studio:run-job-now', async (_e, personaId: string, job: ScheduledJobKind) => {
    const result = await scheduler.runNow(personaId, job);
    return { result, overview: scheduleOverview() };
  });

  ipcMain.handle('studio:hosted-ring-create', (_e, input: { name: string; description?: string }) => {
    return personaManager.getActiveContext().db.createHostedRing(input);
  });

  ipcMain.handle('studio:hosted-ring-update', (_e, ringId: string, updates) => {
    return personaManager.getActiveContext().db.updateHostedRing(ringId, updates);
  });

  ipcMain.handle(
    'studio:hosted-ring-member',
    (
      _e,
      ringId: string,
      siteUrl: string,
      change: { action: 'remove' | 'ban' | 'unban' | 'hide' | 'show' | 'up' | 'down'; reason?: string }
    ) => {
      const { db } = personaManager.getActiveContext();
      switch (change.action) {
        case 'remove':
          return db.removeRingMember(ringId, siteUrl);
        case 'ban':
          return db.banRingMember(ringId, { siteUrl, reason: change.reason });
        case 'unban':
          return db.unbanRingMember(ringId, siteUrl);
        case 'hide':
        case 'show':
          return db.setRingMemberHidden(ringId, siteUrl, change.action === 'hide');
        case 'up':
        case 'down':
          return db.moveRingMember(ringId, siteUrl, change.action);
      }
    }
  );

  ipcMain.handle('studio:choose-export-folder', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Export Folder for Static Profile Website',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('studio:export-local', (_e, targetDir?: string) => {
    return withActiveLock(() =>
      publishTo(personaManager.getActiveContext(), 'local', publishPaths(), { targetDir })
    );
  });

  ipcMain.handle('studio:test-export-preview', async (_e, openInBrowser?: boolean) => {
    const ctx = personaManager.getActiveContext();
    const previewDir = path.join(app.getPath('userData'), `test-preview-site-${ctx.persona.id}`);
    const result = await localPreviewServer.runTestExportAndServe(ctx.siteGenerator, previewDir);
    if (openInBrowser && result.previewUrl) {
      await shell.openExternal(result.previewUrl);
    }
    return result;
  });

  ipcMain.handle('studio:open-external', async (_e, url: string) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url);
    }
    return { ok: true };
  });

  // The Publish tab sends its current form; save it, then publish with the saved settings
  const publishWithSettings = (destination: PublishDestination, settings: unknown) =>
    withActiveLock(async () => {
      const ctx = personaManager.getActiveContext();
      const currentProfile = ctx.db.getProfile();
      ctx.db.updateProfile({
        publishSettings: {
          ...currentProfile.publishSettings,
          ...((settings as object) || {}),
        },
      });
      return publishTo(ctx, destination, publishPaths());
    });

  ipcMain.handle('studio:publish-remote', async (_e, settings) => publishWithSettings('remote', settings));

  ipcMain.handle('studio:publish-github', async (_e, settings) => publishWithSettings('github', settings));

  ipcMain.handle('studio:check-github-repo', async (_e, settings) => {
    const ctx = personaManager.getActiveContext();
    // The form shows a placeholder for a saved token; use the stored one in that case
    return await ctx.sitePublisher.checkGitHubRepo(ctx.db.withStoredCredentials(settings));
  });

  ipcMain.handle('studio:open-path', async (_e, targetPath: string) => {
    await shell.openPath(targetPath);
    return { ok: true };
  });

  ipcMain.handle('studio:get-mcp-info', () => {
    const cliScriptPath = path.resolve(__dirname, 'mcp/cli.js');
    return {
      status: mcpHttpServer.getStatus(),
      cliScriptPath,
      userDataDir: app.getPath('userData'),
      tools: webringMcpServer.getTools(),
      resources: webringMcpServer.getResources(),
      prompts: webringMcpServer.getPrompts(),
      activityLog: webringMcpServer.getActivityLog(),
    };
  });

  ipcMain.handle(
    'studio:call-mcp-tool',
    async (_e, toolName: string, args?: Record<string, unknown>) => {
      return await webringMcpServer.executeToolCall(toolName, args);
    }
  );
}

