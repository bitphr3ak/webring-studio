import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as jpegJs from 'jpeg-js';
import { PNG } from 'pngjs';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vm from 'vm';
import * as http from 'http';
import {
  buildCanonicalUrl,
  buildDidDocument,
  buildWebringUri,
  generateIdentityKeyPair,
  isPlaceholderSiteUrl,
  parseLayout,
  ProfileDocumentSchema,
  type Appearance,
  type LayoutBlock,
  type ProfileTheme,
  parseWebringUri,
  signDocument,
  siteUrlToDidWeb,
  verifyDocumentSignature,
  WebringManifestSchema,
} from '../src/shared/schema';
import { STORED_SECRET_PLACEHOLDER, StudioDatabase } from '../electron/db/database';
import { LEGACY_DEMO_PHOTOS, LEGACY_DEMO_PROFILE } from '../electron/db/legacyDemoContent';
import { StaticSiteGenerator } from '../electron/services/siteGenerator';
import { renderTemplatePage } from '../electron/services/siteTemplates';
import { installPageEnhancements } from '../electron/services/pageEnhancements';
import { defaultJsonFetcher, RingCrawler } from '../electron/services/ringCrawler';
import { RingService } from '../electron/services/ringService';
import { jobNextRunAt, nextRunAt, Scheduler } from '../electron/services/scheduler';
import { runScheduledPublish } from '../electron/services/jobs';
import { isPrivateNetworkAddress } from '../electron/security/networkGuard';
import { PersonaManager } from '../electron/services/personaManager';
import { gitBlobSha, SitePublisher } from '../electron/services/publisher';
import { savePost, unsavePost } from '../electron/services/savedPosts';
import {
  cleanUpLibrary,
  deletePhotoWithFiles,
  importPhotosIntoAlbum,
  MediaLibrary,
  optimizeLegacyPhotos,
  replacePhotoImage,
  setProfileImageFromFile,
  sha256Hex,
} from '../electron/services/mediaLibrary';
import { readJpegOrientation, UnsupportedImageError } from '../electron/services/imagePipeline';
import { markdownToPlainText, renderMarkdown } from '../src/shared/markdown';
import { applySyncPlan, hashStagedFiles, planSync } from '../electron/services/publishSync';
import { KeyCipher, KeyVaultUnavailableError } from '../electron/security/keyVault';
import { LocalPreviewServer } from '../electron/services/localPreviewServer';
import { WebringMcpServer } from '../electron/mcp/mcpServer';
import { McpHttpServer } from '../electron/mcp/mcpHttpServer';

describe('Webring Schema, DID Identity & Ed25519 Signatures', () => {
  it('converts website URLs into standard W3C / ATProto did:web identifiers', () => {
    expect(siteUrlToDidWeb('https://alice.indiering.social')).toBe(
      'did:web:alice.indiering.social'
    );
    expect(siteUrlToDidWeb('https://example.com/users/bob/')).toBe(
      'did:web:example.com:users:bob'
    );
  });

  it('builds deterministic canonical URLs for albums, photos, and shared items', () => {
    expect(buildCanonicalUrl('https://alice.example.com/', 'albums', 'alb-1')).toBe(
      'https://alice.example.com/api/albums.json#album-alb-1'
    );
    expect(buildCanonicalUrl('https://alice.example.com', 'photos', 'ph-99')).toBe(
      'https://alice.example.com/api/albums.json#photo-ph-99'
    );
    expect(buildCanonicalUrl('https://alice.example.com', 'items', 'it-42')).toBe(
      'https://alice.example.com/api/items.json#item-it-42'
    );
  });

  it('signs JSON documents with Ed25519 and verifies tampering', () => {
    const { publicKeyPem, privateKeyPem } = generateIdentityKeyPair();
    const did = 'did:web:alice.example.com';
    const didDoc = buildDidDocument('https://alice.example.com', publicKeyPem, 'alice.bsky.social');
    expect(didDoc.id).toBe(did);

    const payload = {
      schemaVersion: '1.0.0',
      siteUrl: 'https://alice.example.com',
      did,
      title: 'Test Payload',
    };

    const signed = signDocument(payload, did, privateKeyPem);
    expect(signed.proof).toBeDefined();
    expect(verifyDocumentSignature(signed, publicKeyPem)).toBe(true);

    // Tamper with the signed document and verify signature fails
    const tampered = { ...signed, title: 'Modified Title' };
    expect(verifyDocumentSignature(tampered, publicKeyPem)).toBe(false);
  });

  it('round-trips webring:// deep link URIs for static site interactions', () => {
    const uri = buildWebringUri({
      action: 'like',
      targetUrl: 'https://alice.example.com/api/albums.json#photo-1',
      title: 'Misty Trail',
      authorName: 'Alice',
      authorUrl: 'https://alice.example.com',
      category: 'photo',
    });

    const parsed = parseWebringUri(uri);
    expect(parsed).toEqual({
      action: 'like',
      targetUrl: 'https://alice.example.com/api/albums.json#photo-1',
      title: 'Misty Trail',
      authorName: 'Alice',
      authorUrl: 'https://alice.example.com',
      mediaUrl: undefined,
      category: 'photo',
    });
  });
});

describe('Two-Peer Pull Federation, Static Site Generation & Endorsement Discovery', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('edits a published post in place: same address, friends get the new text, comments stay attached', async () => {
    const aliceDir = path.join(tempRoot, 'alice');
    const bobDir = path.join(tempRoot, 'bob');
    const aliceDb = new StudioDatabase(aliceDir, 'alice.sqlite');
    const bobDb = new StudioDatabase(bobDir, 'bob.sqlite');
    aliceDb.updateProfile({ siteUrl: 'https://alice.ring.test', displayName: 'Alice' });
    bobDb.updateProfile({ siteUrl: 'https://bob.ring.test', displayName: 'Bob' });

    const post = aliceDb.createItem({ type: 'post', commentary: 'Frist post!\nMore to come.' });
    expect(post.title).toBe('Frist post!');
    const aliceOut = path.join(aliceDir, 'out');
    const aliceGenerator = new StaticSiteGenerator(aliceDb);
    aliceGenerator.generateToDirectory(aliceOut);
    const publishedAt = new Date().toISOString();
    const fingerprint = aliceGenerator.contentFingerprint();

    // Bob syncs Alice and comments on the post
    await new RingCrawler(bobDb).crawlFriendSite('https://alice.ring.test', aliceOut);
    bobDb.createItem({ type: 'comment', targetUrl: post.canonicalUrl, targetAuthorName: 'Alice', commentary: 'Welcome!' });
    const bobOut = path.join(bobDir, 'out');
    new StaticSiteGenerator(bobDb).generateToDirectory(bobOut);

    await new Promise((r) => setTimeout(r, 5));
    const edited = aliceDb.updateItem(post.id, { commentary: 'First post!\nMore to come.', tags: ['hello', ' '] });
    expect(edited).toMatchObject({ id: post.id, canonicalUrl: post.canonicalUrl, createdAt: post.createdAt, title: 'First post!', tags: ['hello'] });
    expect(edited.updatedAt! > post.createdAt).toBe(true);
    expect(aliceDb.countChangesSince(publishedAt)).toBe(1);
    expect(aliceGenerator.contentFingerprint()).not.toBe(fingerprint);
    // A title the user typed is kept when only the text changes
    expect(aliceDb.updateItem(post.id, { title: 'Hello, ring' }).title).toBe('Hello, ring');
    expect(aliceDb.updateItem(post.id, { commentary: 'First post, edited again.' }).title).toBe('Hello, ring');

    aliceGenerator.generateToDirectory(aliceOut);
    const items = JSON.parse(fs.readFileSync(path.join(aliceOut, 'api/items.json'), 'utf8'));
    const didDoc = JSON.parse(fs.readFileSync(path.join(aliceOut, '.well-known/did.json'), 'utf8'));
    expect(verifyDocumentSignature(items, didDoc.verificationMethod[0].publicKeyPem)).toBe(true);
    expect(items.items[0]).toMatchObject({ id: post.id, commentary: 'First post, edited again.' });
    expect(items.items[0].updatedAt).toBeDefined();

    // Bob's next sync replaces his copy; Alice still sees Bob's comment on the same post
    await new RingCrawler(bobDb).crawlFriendSite('https://alice.ring.test', aliceOut);
    const inFeed = bobDb.getNetworkFeed().filter((f) => f.canonicalUrl === post.canonicalUrl);
    expect(inFeed).toHaveLength(1);
    expect(inFeed[0].commentary).toBe('First post, edited again.');
    await new RingCrawler(aliceDb).crawlFriendSite('https://bob.ring.test', bobOut);
    expect(aliceDb.getEndorsements().some((e) => e.type === 'comment' && e.targetCanonicalUrl === post.canonicalUrl)).toBe(true);
    aliceDb.close();
    bobDb.close();
  });

  it('exports Alice and Bob static JSON sites and indexes mutual likes/shares across the ring', async () => {
    const aliceDir = path.join(tempRoot, 'alice');
    const bobDir = path.join(tempRoot, 'bob');

    const aliceDb = new StudioDatabase(aliceDir, 'alice.sqlite');
    const bobDb = new StudioDatabase(bobDir, 'bob.sqlite');

    // 1. Configure Alice's profile & create a new photo in her album
    aliceDb.updateProfile({
      siteUrl: 'https://alice.ring.test',
      handle: 'alice.ring.test',
      displayName: 'Alice Wonderland',
    });
    const aliceAlbum = aliceDb.createAlbum({
      title: 'Botanical Glasshouse',
      description: 'Rare ferns and orchids',
      tags: ['botany', 'glasshouse'],
    });
    const alicePhoto = aliceDb.addPhotoToAlbum({
      albumId: aliceAlbum.id,
      url: 'https://alice.ring.test/media/fern.jpg',
      caption: 'Silver fern frond',
      tags: ['fern'],
    });

    const aliceOutDir = path.join(aliceDir, 'public_html');
    const aliceGenerator = new StaticSiteGenerator(aliceDb);
    const aliceGenResult = aliceGenerator.generateToDirectory(aliceOutDir);

    expect(aliceGenResult.filesWritten).toContain('.well-known/did.json');
    expect(aliceGenResult.filesWritten).toContain('api/manifest.json');
    expect(aliceGenResult.filesWritten).toContain('api/albums.json');
    expect(aliceGenResult.filesWritten).toContain('index.html');
    expect(aliceGenResult.filesWritten).toContain('.nojekyll');

    // Validate generated manifest on disk
    const manifestOnDisk = JSON.parse(
      fs.readFileSync(path.join(aliceOutDir, 'api/manifest.json'), 'utf8')
    );
    expect(() => WebringManifestSchema.parse(manifestOnDisk)).not.toThrow();

    // 2. Configure Bob's profile, crawl Alice's static JSON site, and like Alice's photo
    bobDb.updateProfile({
      siteUrl: 'https://bob.ring.test',
      handle: 'bob.ring.test',
      displayName: 'Bob Builder',
    });

    const bobCrawler = new RingCrawler(bobDb);
    const crawlAliceRes = await bobCrawler.crawlFriendSite('https://alice.ring.test', aliceOutDir);
    expect(crawlAliceRes.success).toBe(true);
    expect(crawlAliceRes.verifiedSignature).toBe(true);
    expect(crawlAliceRes.photosIndexed).toBeGreaterThan(0);

    // Bob's neighborhood feed now contains Alice's photo
    const bobFeed = bobDb.getNetworkFeed();
    expect(bobFeed.some((f) => f.canonicalUrl === alicePhoto.canonicalUrl)).toBe(true);

    // Bob likes Alice's photo by referencing its canonicalUrl
    bobDb.createItem({
      type: 'like',
      title: 'Loved Alice’s Silver Fern Photo!',
      targetUrl: alicePhoto.canonicalUrl,
      targetAuthorName: 'Alice Wonderland',
      targetAuthorUrl: 'https://alice.ring.test',
      category: 'photo',
      commentary: 'Incredible detail on those fronds!',
      tags: ['botany', 'ring-love'],
    });

    const bobOutDir = path.join(bobDir, 'public_html');
    const bobGenerator = new StaticSiteGenerator(bobDb);
    bobGenerator.generateToDirectory(bobOutDir);

    // 3. Alice crawls Bob's static JSON site and automatically discovers Bob's endorsement!
    const aliceCrawler = new RingCrawler(aliceDb);
    const crawlBobRes = await aliceCrawler.crawlFriendSite('https://bob.ring.test', bobOutDir);
    expect(crawlBobRes.success).toBe(true);
    expect(crawlBobRes.verifiedSignature).toBe(true);
    expect(crawlBobRes.endorsementsFound).toBe(1);

    const aliceEndorsements = aliceDb.getEndorsements();
    expect(aliceEndorsements).toHaveLength(1);
    expect(aliceEndorsements[0].targetCanonicalUrl).toBe(alicePhoto.canonicalUrl);
    expect(aliceEndorsements[0].authorName).toBe('Bob Builder');
    expect(aliceEndorsements[0].verifiedSignature).toBe(true);

    aliceDb.close();
    bobDb.close();
  });

  it('protects the social graph by default: crawls private friends locally without leaking connections in static JSON or HTML', async () => {
    const aliceDir = path.join(tempRoot, 'alice-priv');
    const bobDir = path.join(tempRoot, 'bob-priv');
    const carolDir = path.join(tempRoot, 'carol-priv');

    const aliceDb = new StudioDatabase(aliceDir, 'alice.sqlite');
    const bobDb = new StudioDatabase(bobDir, 'bob.sqlite');

    bobDb.updateProfile({
      siteUrl: 'https://bob-secret.ring.test',
      handle: 'bob-secret.ring.test',
      displayName: 'Bob Secret',
    });
    const bobOutDir = path.join(bobDir, 'public_html');
    new StaticSiteGenerator(bobDb).generateToDirectory(bobOutDir);

    // Alice adds Bob (default visibility: 'private') and Carol (explicitly 'public')
    const bobFriend = aliceDb.addOrUpdateFriend({
      siteUrl: 'https://bob-secret.ring.test',
      displayName: 'Bob Secret',
      relationship: ['friend', 'kin', 'met'],
    });
    expect(bobFriend.visibility).toBe('private');

    const carolFriend = aliceDb.addOrUpdateFriend({
      siteUrl: 'https://carol-public.ring.test',
      displayName: 'Carol Public',
      relationship: ['friend', 'colleague'],
      visibility: 'public',
    });
    expect(carolFriend.visibility).toBe('public');

    // Alice crawls Bob's site into her local SQLite feed
    const aliceCrawler = new RingCrawler(aliceDb);
    const crawlRes = await aliceCrawler.crawlFriendSite('https://bob-secret.ring.test', bobOutDir);
    expect(crawlRes.success).toBe(true);
    // Crawling must preserve Bob's private visibility
    expect(
      aliceDb.getFriends().find((f) => f.siteUrl === 'https://bob-secret.ring.test')?.visibility
    ).toBe('private');

    // 1. Default export: publishFriendsList is false, publishWebringHub is false
    const aliceOutDir = path.join(aliceDir, 'public_html');
    const aliceGen = new StaticSiteGenerator(aliceDb);
    const defaultExport = aliceGen.generateToDirectory(aliceOutDir);

    expect(defaultExport.bundle.connections.friends).toHaveLength(0);
    expect(defaultExport.bundle.manifest.stats.friendCount).toBe(0);
    expect(fs.existsSync(path.join(aliceOutDir, 'api/webring-hub.json'))).toBe(false);

    const connectionsJsonRaw = fs.readFileSync(
      path.join(aliceOutDir, 'api/connections.json'),
      'utf8'
    );
    const indexHtmlRaw = fs.readFileSync(path.join(aliceOutDir, 'index.html'), 'utf8');
    expect(connectionsJsonRaw).not.toContain('bob-secret.ring.test');
    expect(connectionsJsonRaw).not.toContain('carol-public.ring.test');
    expect(indexHtmlRaw).not.toContain('bob-secret.ring.test');

    // 2. Enable publishFriendsList (with stripRelationshipTags: true by default)
    aliceDb.updateProfile({
      publishSettings: {
        publishFriendsList: true,
        stripRelationshipTags: true,
        redactItemSourceAuthors: true,
      },
    });
    const selectiveExport = aliceGen.generateToDirectory(aliceOutDir);

    // Only Carol (public) is exported; Bob (private) is still hidden!
    expect(selectiveExport.bundle.connections.friends).toHaveLength(1);
    expect(selectiveExport.bundle.connections.friends[0].siteUrl).toBe(
      'https://carol-public.ring.test'
    );
    // XFN relationship tags ('friend', 'colleague') are stripped from exported JSON
    expect(selectiveExport.bundle.connections.friends[0].relationship).toEqual([]);
    // Local SQLite still retains Carol's relationship tags
    expect(
      aliceDb.getFriends().find((f) => f.id === carolFriend.id)?.relationship
    ).toEqual(['friend', 'colleague']);

    // Redacted item source authors in exported items.json
    expect(
      selectiveExport.bundle.items.items.every(
        (i) => i.targetAuthorUrl === undefined && i.targetAuthorName === undefined
      )
    ).toBe(true);

    aliceDb.close();
    bobDb.close();
    if (fs.existsSync(carolDir)) {
      fs.rmSync(carolDir, { recursive: true, force: true });
    }
  });

  it('compartmentalizes multiple online personas with isolated SQLite DBs, Ed25519 keys, DIDs, and friend graphs', () => {
    const userDataDir = path.join(tempRoot, 'multi-persona-studio');
    const manager = new PersonaManager(userDataDir);

    try {
      // 1. Default persona is initialized automatically
      const initialList = manager.listPersonas();
      expect(initialList.personas).toHaveLength(1);
      expect(initialList.personas[0].id).toBe('default');
      expect(initialList.personas[0].dbFileName).toBe('webring-studio.sqlite');

      const primaryCtx = manager.getActiveContext();
      const primaryProfile = primaryCtx.db.getProfile();
      primaryCtx.db.addOrUpdateFriend({
        siteUrl: 'https://primary-only-friend.test',
        displayName: 'Primary Circle Friend',
        visibility: 'private',
      });

      // 2. Create a second compartmentalized persona (e.g. a synth music alias on a subpath or separate domain)
      const secondCreated = manager.createPersona({
        label: 'Synth Alias',
        displayName: 'Nightowl Modular',
        siteUrl: 'https://user.github.io/nightowl',
        tagline: 'Late-night tape loops & Eurorack patches',
        theme: 'cyber-terminal',
      });
      const secondSummary = secondCreated.created;

      expect(secondSummary.id).not.toBe('default');
      expect(secondSummary.dbFileName).toMatch(/^persona-.*\.sqlite$/);
      expect(secondSummary.did).toBe('did:web:user.github.io:nightowl');
      expect(manager.getActivePersonaId()).toBe(secondSummary.id);

      const secondCtx = manager.getActiveContext();
      const secondProfile = secondCtx.db.getProfile();

      // 3. Verify strict cryptographic and social compartmentalization
      expect(secondProfile.publicKeyPem).not.toBe(primaryProfile.publicKeyPem);
      expect(secondProfile.did).not.toBe(primaryProfile.did);
      expect(secondCtx.db.getFriends()).toHaveLength(0);
      expect(secondCtx.db.getAlbums()).toHaveLength(0);
      expect(secondCtx.db.getItems()).toHaveLength(0);

      // Add an item and friend exclusively to Persona 2
      secondCtx.db.createItem({
        type: 'recommendation',
        title: 'Tape Loop Technique #4',
        targetUrl: 'https://synth.example.com/tape-loops',
        category: 'music',
        commentary: 'Essential cassette splice guide.',
        tags: ['modular', 'tape'],
      });

      // Export Persona 2 static site and verify subpath did.json + .well-known/did.json
      const persona2Out = path.join(tempRoot, 'out-persona-2');
      const gen2 = secondCtx.siteGenerator.generateToDirectory(persona2Out);
      expect(gen2.filesWritten).toContain('.well-known/did.json');
      expect(gen2.filesWritten).toContain('did.json');
      expect(gen2.bundle.didDocument.id).toBe('did:web:user.github.io:nightowl');

      // 4. Switch back to Persona 1 ('default') and confirm zero cross-contamination
      manager.switchPersona('default');
      expect(manager.getActivePersonaId()).toBe('default');
      const switchedBackCtx = manager.getActiveContext();
      expect(switchedBackCtx.db.getProfile().did).toBe(primaryProfile.did);
      expect(
        switchedBackCtx.db.getFriends().some((f) => f.siteUrl === 'https://primary-only-friend.test')
      ).toBe(true);
      expect(
        switchedBackCtx.db.getItems().some((i) => i.title === 'Tape Loop Technique #4')
      ).toBe(false);

      // Verify per-persona SFTP/FTP publishing credentials persistence & deletion
      switchedBackCtx.db.updateProfile({
        publishSettings: {
          ...switchedBackCtx.db.getProfile().publishSettings,
          protocol: 'sftp',
          host: 'sftp.primary-host.example',
          port: 2222,
          username: 'alex_admin',
          password: 'super-secret-sftp-password',
          remotePath: '/var/www/alex',
        },
      });
      expect(switchedBackCtx.db.getProfile().publishSettings.host).toBe('sftp.primary-host.example');
      // The profile only shows a placeholder; the real value is for the publisher
      expect(switchedBackCtx.db.getProfile().publishSettings.password).toBe(STORED_SECRET_PLACEHOLDER);
      expect(switchedBackCtx.db.getPublishCredentials().password).toBe('super-secret-sftp-password');

      // Persona 2's SFTP settings remain completely blank/isolated
      manager.switchPersona(secondSummary.id);
      expect(manager.getActiveContext().db.getProfile().publishSettings.host).toBe('');
      expect(manager.getActiveContext().db.getProfile().publishSettings.password).toBe('');

      // Switch back to Persona 1, confirm SFTP credentials persisted across persona switches, then clear them
      manager.switchPersona('default');
      expect(manager.getActiveContext().db.getProfile().publishSettings.host).toBe(
        'sftp.primary-host.example'
      );
      manager.getActiveContext().db.updateProfile({
        publishSettings: {
          ...manager.getActiveContext().db.getProfile().publishSettings,
          protocol: 'sftp',
          host: '',
          port: 22,
          username: '',
          password: '',
          remotePath: '/var/www/html',
        },
      });
      expect(manager.getActiveContext().db.getProfile().publishSettings.host).toBe('');
      expect(manager.getActiveContext().db.getProfile().publishSettings.password).toBe('');

      // 5. Rename and delete Persona 2
      const renamedList = manager.updatePersonaLabel(secondSummary.id, 'Underground Synth');
      expect(renamedList.personas.find((p) => p.id === secondSummary.id)?.label).toBe(
        'Underground Synth'
      );

      const delRes = manager.deletePersona(secondSummary.id);
      expect(delRes.personas).toHaveLength(1);
      expect(delRes.activePersonaId).toBe('default');

      // Primary persona cannot be deleted
      expect(() => manager.deletePersona('default')).toThrow();
    } finally {
      manager.closeAll();
    }
  });

  it('builds a local test export and serves it over a loopback HTTP preview server', async () => {
    const studioDir = path.join(tempRoot, 'preview-studio');
    const previewOutDir = path.join(tempRoot, 'preview-out');
    const db = new StudioDatabase(studioDir, 'preview.sqlite');
    const generator = new StaticSiteGenerator(db);
    const previewServer = new LocalPreviewServer();

    try {
      const res = await previewServer.runTestExportAndServe(generator, previewOutDir);
      expect(res.success).toBe(true);
      expect(res.port).toBeGreaterThan(0);
      expect(res.previewUrl).toBe(`http://127.0.0.1:${res.port}/`);
      expect(res.checks.hasIndexHtml).toBe(true);
      expect(res.checks.hasNoJekyll).toBe(true);
      expect(res.checks.hasDidJson).toBe(true);
      expect(res.checks.hasManifestJson).toBe(true);

      // Fetch the live served index.html and /api/manifest.json over HTTP
      const htmlResp = await fetch(res.previewUrl);
      expect(htmlResp.status).toBe(200);
      const htmlText = await htmlResp.text();
      expect(htmlText).toContain('window.__WEBRING_BUNDLE__');

      const manifestResp = await fetch(`${res.previewUrl}api/manifest.json`);
      expect(manifestResp.status).toBe(200);
      const manifestJson = await manifestResp.json();
      expect(() => WebringManifestSchema.parse(manifestJson)).not.toThrow();
    } finally {
      await previewServer.stop();
      db.close();
    }
  });

  it('publishes Wall Posts and federates threaded Comments across peer static sites', async () => {
    const aliceDir = path.join(tempRoot, 'alice-wall');
    const bobDir = path.join(tempRoot, 'bob-wall');
    const aliceDb = new StudioDatabase(aliceDir, 'alice.sqlite');
    const bobDb = new StudioDatabase(bobDir, 'bob.sqlite');

    try {
      aliceDb.updateProfile({
        siteUrl: 'https://alice-wall.ring.test',
        handle: 'alice-wall.ring.test',
        displayName: 'Alice Wall',
        publishSettings: {
          publishEndorsements: true,
          commentProvider: 'giscus',
          giscusRepo: 'alice/alice.github.io',
        },
      });

      // 1. Alice writes a Wall Post without needing to specify a title or external targetUrl
      const wallPost = aliceDb.createItem({
        type: 'post',
        commentary: 'Hello from my new static wall! Anyone up for a synth jam this weekend?',
        tags: ['wall', 'jam'],
      });
      expect(wallPost.type).toBe('post');
      expect(wallPost.targetUrl).toBe(wallPost.canonicalUrl);
      expect(wallPost.title).toContain('Hello from my new static wall!');

      const aliceOut = path.join(aliceDir, 'public_html');
      new StaticSiteGenerator(aliceDb).generateToDirectory(aliceOut);

      // 2. Bob crawls Alice's static site and sees her Wall Post in his Neighborhood Feed
      bobDb.updateProfile({
        siteUrl: 'https://bob-wall.ring.test',
        handle: 'bob-wall.ring.test',
        displayName: 'Bob Commenter',
      });
      const bobCrawler = new RingCrawler(bobDb);
      const crawlAlice = await bobCrawler.crawlFriendSite('https://alice-wall.ring.test', aliceOut);
      expect(crawlAlice.success).toBe(true);

      const bobFeed = bobDb.getNetworkFeed();
      const crawledPost = bobFeed.find((e) => e.canonicalUrl === wallPost.canonicalUrl);
      expect(crawledPost).toBeDefined();
      expect(crawledPost?.entryType).toBe('post');

      // 3. Bob replies with a Comment targeting Alice's Wall Post canonicalUrl
      const bobComment = bobDb.createItem({
        type: 'comment',
        targetUrl: wallPost.canonicalUrl,
        targetAuthorName: 'Alice Wall',
        targetAuthorUrl: 'https://alice-wall.ring.test',
        commentary: 'Count me in! Bringing my Eurorack case and tape delay.',
      });
      expect(bobComment.type).toBe('comment');

      const bobOut = path.join(bobDir, 'public_html');
      new StaticSiteGenerator(bobDb).generateToDirectory(bobOut);

      // 4. Alice crawls Bob's static site and discovers Bob's verified Comment on her Wall Post
      const aliceCrawler = new RingCrawler(aliceDb);
      const crawlBob = await aliceCrawler.crawlFriendSite('https://bob-wall.ring.test', bobOut);
      expect(crawlBob.success).toBe(true);
      expect(crawlBob.endorsementsFound).toBe(1);

      const aliceEndorsements = aliceDb.getEndorsements();
      expect(aliceEndorsements).toHaveLength(1);
      expect(aliceEndorsements[0].type).toBe('comment');
      expect(aliceEndorsements[0].commentary).toContain('Bringing my Eurorack case');

      // 5. Alice re-exports her site; her bundle includes both Bob's comment and her Giscus live-thread config
      const reExport = new StaticSiteGenerator(aliceDb).generateToDirectory(aliceOut);
      expect(reExport.bundle.profile.commentConfig?.provider).toBe('giscus');
      expect(reExport.bundle.profile.commentConfig?.giscusRepo).toBe('alice/alice.github.io');
      expect(reExport.bundle.connections.endorsements[0].commentary).toContain(
        'Bringing my Eurorack case'
      );
    } finally {
      aliceDb.close();
      bobDb.close();
    }
  });

  it('hardens static HTML against DOM XSS, verifies per-document Ed25519 signatures, and enforces TOFU key pinning', async () => {
    const aliceDir = path.join(tempRoot, 'alice-sec');
    const bobDir = path.join(tempRoot, 'bob-sec');
    const aliceDb = new StudioDatabase(aliceDir, 'alice.sqlite');
    const bobDb = new StudioDatabase(bobDir, 'bob.sqlite');

    try {
      // 1. FIX-01: Test DOM XSS & script breakout escaping in generated standalone index.html
      aliceDb.updateProfile({
        siteUrl: 'https://alice-sec.ring.test',
        handle: 'alice-sec.ring.test',
        displayName: 'Alice </script><script>window.__XSS=1</script>',
        bio: '<img src=x onerror="alert(1)">',
        customLinks: [{ label: 'Malicious Link', url: 'javascript:alert(1)' }],
      });
      const alicePost = aliceDb.createItem({
        type: 'post',
        title: 'Security Test Post <svg onload=alert(1)>',
        commentary: 'Testing HTML escaping in standalone bundle',
      });

      const aliceOut = path.join(aliceDir, 'public_html');
      new StaticSiteGenerator(aliceDb).generateToDirectory(aliceOut);
      const indexHtml = fs.readFileSync(path.join(aliceOut, 'index.html'), 'utf8');

      // Inline JSON script block must never contain literal </script>
      expect(indexHtml).not.toContain('</script><script>window.__XSS=1');
      expect(indexHtml).toContain('\\u003c/script\\u003e\\u003cscript\\u003ewindow.__XSS=1');
      expect(indexHtml).toContain('http-equiv="Content-Security-Policy"');
      expect(indexHtml).toContain('function esc(');
      expect(indexHtml).toContain('function safeUrl(');

      // 2. FIX-02 & FIX-04: Bob publishes a valid site and likes Alice's post; Alice crawls Bob (TOFU pins Bob's key)
      bobDb.updateProfile({
        siteUrl: 'https://bob-sec.ring.test',
        handle: 'bob-sec.ring.test',
        displayName: 'Bob Secure',
      });
      const bobAlbum = bobDb.createAlbum({ title: 'Verified Album' });
      bobDb.addPhotoToAlbum({
        albumId: bobAlbum.id,
        url: 'https://bob-sec.ring.test/photo.jpg',
        caption: 'Authentic Photo',
      });
      bobDb.createItem({
        type: 'like',
        title: 'Liked Alice Post',
        targetUrl: alicePost.canonicalUrl,
        commentary: 'Legitimate signed endorsement!',
      });

      const bobOut = path.join(bobDir, 'public_html');
      new StaticSiteGenerator(bobDb).generateToDirectory(bobOut);

      const aliceCrawler = new RingCrawler(aliceDb);
      const firstCrawl = await aliceCrawler.crawlFriendSite('https://bob-sec.ring.test', bobOut);
      expect(firstCrawl.success).toBe(true);
      expect(firstCrawl.verifiedSignature).toBe(true);
      expect(firstCrawl.keyChangedWarning).toBe(false);

      // Confirm Bob's Ed25519 public key is now TOFU-pinned in Alice's database
      const bobFriendAfterFirst = aliceDb
        .getFriends()
        .find((f) => f.siteUrl === 'https://bob-sec.ring.test');
      expect(bobFriendAfterFirst?.keyStatus).toBe('pinned');
      expect(bobFriendAfterFirst?.pinnedPublicKeyPem).toContain('BEGIN PUBLIC KEY');
      const originalPinnedKey = bobFriendAfterFirst!.pinnedPublicKeyPem;

      // 3. FIX-02: Tamper ONLY with Bob's api/items.json on disk while leaving api/profile.json & api/albums.json valid
      const itemsJsonPath = path.join(bobOut, 'api/items.json');
      const rawItemsDoc = JSON.parse(fs.readFileSync(itemsJsonPath, 'utf8'));
      rawItemsDoc.items[0].commentary = 'TAMPERED UNSIGNED COMMENTARY!';
      fs.writeFileSync(itemsJsonPath, JSON.stringify(rawItemsDoc, null, 2), 'utf8');

      const tamperedCrawl = await aliceCrawler.crawlFriendSite('https://bob-sec.ring.test', bobOut);
      expect(tamperedCrawl.success).toBe(true);
      // Overall crawl signature verification must fail because items.json was tampered with
      expect(tamperedCrawl.verifiedSignature).toBe(false);

      // Photos from untampered albums.json remain verified, while tampered items/endorsements are marked unverified!
      const feedAfterTamper = aliceDb.getNetworkFeed();
      const photoEntry = feedAfterTamper.find((e) => e.entryType === 'photo');
      const itemEntry = feedAfterTamper.find((e) => e.entryType === 'like');
      expect(photoEntry?.verifiedSignature).toBe(true);
      expect(itemEntry?.verifiedSignature).toBe(false);
      expect(aliceDb.getEndorsements()[0]?.verifiedSignature).toBe(false);

      // 4. FIX-04: Simulate domain hijack / key swap on Bob's site with a rogue Ed25519 keypair
      const rogueDir = path.join(tempRoot, 'bob-rogue');
      const rogueDb = new StudioDatabase(rogueDir, 'rogue.sqlite');
      rogueDb.updateProfile({
        siteUrl: 'https://bob-sec.ring.test',
        handle: 'bob-sec.ring.test',
        displayName: 'Bob Hijacked',
      });
      rogueDb.createItem({
        type: 'like',
        title: 'Forged Like by Attacker',
        targetUrl: alicePost.canonicalUrl,
        commentary: 'Signed with attacker key after domain takeover',
      });
      const rogueOut = path.join(rogueDir, 'public_html');
      new StaticSiteGenerator(rogueDb).generateToDirectory(rogueOut);

      // Alice crawls Bob's URL (now serving rogueOut signed by a different keypair)
      const hijackCrawl = await aliceCrawler.crawlFriendSite('https://bob-sec.ring.test', rogueOut);
      expect(hijackCrawl.success).toBe(true);
      expect(hijackCrawl.keyChangedWarning).toBe(true);
      expect(hijackCrawl.verifiedSignature).toBe(false);

      const bobFriendAfterHijack = aliceDb
        .getFriends()
        .find((f) => f.siteUrl === 'https://bob-sec.ring.test');
      expect(bobFriendAfterHijack?.keyStatus).toBe('changed');
      // Original pinned key must NOT be overwritten by the attacker's key
      expect(bobFriendAfterHijack?.pinnedPublicKeyPem).toBe(originalPinnedKey);

      rogueDb.close();
    } finally {
      aliceDb.close();
      bobDb.close();
    }
  });

  it('exposes a full Model Context Protocol (MCP) JSON-RPC 2.0 & Loopback HTTP interface for autonomous agent management', async () => {
    const studioDataDir = path.join(tempRoot, 'mcp-studio');
    const peerDataDir = path.join(tempRoot, 'mcp-peer');
    const manager = new PersonaManager(studioDataDir);
    const mcpServer = new WebringMcpServer(manager, studioDataDir);
    const httpServer = new McpHttpServer(mcpServer);
    const peerDb = new StudioDatabase(peerDataDir, 'peer.sqlite');

    try {
      // 1. Test MCP initialize, tools/list, resources/list, prompts/list
      const initRes = await mcpServer.handleJsonRpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      });
      expect(initRes?.result).toBeDefined();

      const toolsRes = await mcpServer.handleJsonRpc({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });
      const tools = (toolsRes?.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.length).toBeGreaterThanOrEqual(21);
      expect(tools.some((t) => t.name === 'webring_create_post')).toBe(true);
      expect(tools.some((t) => t.name === 'webring_crawl_friend')).toBe(true);

      // 2. Agent creates a new persona via MCP tool call
      const createPersonaRes = await mcpServer.executeToolCall('webring_create_persona', {
        label: 'Agent Managed Persona',
        displayName: 'AutoBot Indie',
        siteUrl: 'https://autobot.indiering.test',
        theme: 'cyber-terminal',
      });
      expect(createPersonaRes.isError).toBeUndefined();
      const createdPersonaId = (
        createPersonaRes.data as { created: { id: string } }
      ).created.id;
      expect(manager.getActivePersonaId()).toBe(createdPersonaId);

      // 3. Agent publishes a Wall Post via MCP
      const createPostRes = await mcpServer.executeToolCall('webring_create_post', {
        commentary: 'Hello from my autonomous MCP agent! Managing my webring via JSON-RPC.',
        tags: ['mcp', 'agent', 'webring'],
      });
      expect(createPostRes.isError).toBeUndefined();

      // 4. Set up a peer site on disk and have the Agent crawl the peer and post a comment via MCP
      peerDb.updateProfile({
        siteUrl: 'https://friend-peer.ring.test',
        handle: 'friend-peer.ring.test',
        displayName: 'Peer Friend',
      });
      const peerPost = peerDb.createItem({
        type: 'post',
        commentary: 'Anyone automating their IndieWeb studio with MCP agents?',
      });
      const peerOutDir = path.join(peerDataDir, 'public_html');
      new StaticSiteGenerator(peerDb).generateToDirectory(peerOutDir);

      const crawlRes = await mcpServer.executeToolCall('webring_crawl_friend', {
        siteUrl: 'https://friend-peer.ring.test',
        localDirOverride: peerOutDir,
      });
      expect((crawlRes.data as { verifiedSignature: boolean }).verifiedSignature).toBe(true);

      // Agent reads Neighborhood Feed via MCP and replies to Peer Friend's post
      const feedRes = await mcpServer.executeToolCall('webring_get_neighborhood_feed', {
        entryType: 'post',
        verifiedOnly: true,
      });
      const feedEntries = (feedRes.data as { entries: Array<{ canonicalUrl: string }> }).entries;
      expect(feedEntries.some((e) => e.canonicalUrl === peerPost.canonicalUrl)).toBe(true);

      await mcpServer.executeToolCall('webring_interact_with_url', {
        type: 'comment',
        targetUrl: peerPost.canonicalUrl,
        targetAuthorName: 'Peer Friend',
        targetAuthorUrl: 'https://friend-peer.ring.test',
        commentary: 'Yes! Replying right now via webring_interact_with_url over MCP!',
      });

      // 5. Agent exports the signed static site via MCP and verifies over Loopback HTTP /mcp endpoint
      const exportOutDir = path.join(tempRoot, 'mcp-exported-site');
      const exportRes = await mcpServer.executeToolCall('webring_export_static_site', {
        targetDir: exportOutDir,
      });
      expect((exportRes.data as { success: boolean }).success).toBe(true);
      expect(fs.existsSync(path.join(exportOutDir, 'index.html'))).toBe(true);

      const httpStatus = await httpServer.start(0);
      expect(httpStatus.running).toBe(true);
      expect(httpStatus.port).toBeGreaterThan(0);

      const httpRpcResp = await fetch(httpStatus.endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'resources/read',
          params: { uri: 'webring://active/bundle' },
        }),
      });
      expect(httpRpcResp.status).toBe(200);
      const httpRpcJson = (await httpRpcResp.json()) as {
        result: { contents: Array<{ text: string }> };
      };
      const bundleFromResource = JSON.parse(httpRpcJson.result.contents[0].text);
      expect(bundleFromResource.profile.displayName).toBe('AutoBot Indie');
      expect(bundleFromResource.items.items).toHaveLength(2); // 1 wall post + 1 comment
      expect(httpRpcResp.headers.get('access-control-allow-origin')).toBeNull();

      // Browser-style requests are refused before any tool runs
      const rawPost = (headers: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          const body = JSON.stringify({
            jsonrpc: '2.0',
            id: 100,
            method: 'tools/call',
            params: { name: 'webring_create_post', arguments: { commentary: 'Injected by a web page' } },
          });
          const req = http.request(
            { host: '127.0.0.1', port: httpStatus.port, path: '/mcp', method: 'POST', headers },
            (res) => {
              res.resume();
              resolve(res.statusCode || 0);
            }
          );
          req.on('error', reject);
          req.end(body);
        });
      const loopbackHost = `127.0.0.1:${httpStatus.port}`;
      expect(
        await rawPost({ Host: loopbackHost, 'Content-Type': 'application/json', Origin: 'https://evil.example' })
      ).toBe(403);
      expect(await rawPost({ Host: loopbackHost, 'Content-Type': 'text/plain' })).toBe(415);
      expect(await rawPost({ Host: 'evil.example', 'Content-Type': 'application/json' })).toBe(403);
      expect(manager.getActiveContext().db.getItems()).toHaveLength(2);

      // An Electron-style client holding the token is allowed, with CORS for its origin
      const electronOrigin = 'app://mcp-client';
      const tokenUrl = httpStatus.authorizedEndpointUrl!;
      const preflight = await fetch(tokenUrl, {
        method: 'OPTIONS',
        headers: { Origin: electronOrigin },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(electronOrigin);
      const tokenResp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: electronOrigin },
        body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list' }),
      });
      expect(tokenResp.status).toBe(200);
      expect(tokenResp.headers.get('access-control-allow-origin')).toBe(electronOrigin);
      const wrongToken = await fetch(tokenUrl.replace(/token=[0-9a-f]+/, 'token=nope'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: electronOrigin },
        body: JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list' }),
      });
      expect(wrongToken.status).toBe(403);

      // The SSE handshake hands token-holding clients a message URL that keeps the token
      const sseController = new AbortController();
      const sseResp = await fetch(httpStatus.authorizedSseUrl!, {
        headers: { Origin: electronOrigin },
        signal: sseController.signal,
      });
      const firstChunk = new TextDecoder().decode((await sseResp.body!.getReader().read()).value);
      sseController.abort();
      expect(firstChunk).toContain('/mcp/message?token=');

      // The unauthenticated health check never reveals the token
      const health = await (await fetch(`http://127.0.0.1:${httpStatus.port}/mcp/health`)).text();
      expect(health).not.toContain('token');
    } finally {
      await httpServer.stop();
      peerDb.close();
      manager.closeAll();
    }
  });

  it('supports optional Google Analytics (GA4) and Google AdSense add-ons with dynamic CSP, /ads.txt generation, and MCP control', async () => {
    const studioDataDir = path.join(tempRoot, 'addons-studio');
    const outDir = path.join(tempRoot, 'addons-out');
    const manager = new PersonaManager(studioDataDir);
    const mcpServer = new WebringMcpServer(manager, studioDataDir);

    try {
      // 1. Default export (both add-ons disabled): zero Google scripts in CSP or HTML, and no ads.txt
      const ctx = manager.getActiveContext();
      const defaultGen = ctx.siteGenerator.generateToDirectory(outDir);
      const defaultHtml = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      expect(defaultGen.filesWritten).not.toContain('ads.txt');
      expect(fs.existsSync(path.join(outDir, 'ads.txt'))).toBe(false);
      expect(defaultHtml).not.toContain('googletagmanager.com');
      expect(defaultHtml).not.toContain('googlesyndication.com');

      // 2. Phase 1: Configure Google Analytics (GA4) Add-On via MCP
      const badGaRes = await mcpServer.executeToolCall('webring_configure_analytics_addon', {
        enabled: true,
        measurementId: '<script>evil</script>',
      });
      expect(badGaRes.isError).toBe(true);

      const gaRes = await mcpServer.executeToolCall('webring_configure_analytics_addon', {
        enabled: true,
        measurementId: 'G-98765ABCDE',
        respectDoNotTrack: true,
        anonymizeIp: true,
        trackRingInteractions: true,
      });
      expect(gaRes.isError).toBeUndefined();

      ctx.siteGenerator.generateToDirectory(outDir);
      const htmlWithGa = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      expect(htmlWithGa).toContain(
        'https://www.googletagmanager.com/gtag/js?id=G-98765ABCDE'
      );
      expect(htmlWithGa).toContain("gtag('config', 'G-98765ABCDE'");
      expect(htmlWithGa).toContain('webring_interact');

      // 3. Phase 2: Configure Google AdSense Add-On via MCP (with Auto Ads, /ads.txt, and Ad Slots)
      const adsRes = await mcpServer.executeToolCall('webring_configure_ads_addon', {
        enabled: true,
        publisherId: 'pub-1234567890123456', // Automatically normalized to ca-pub-1234567890123456
        enableAutoAds: true,
        generateAdsTxt: true,
        headerSlotId: '1111122222',
        inFeedSlotId: '3333344444',
        footerSlotId: '5555566666',
      });
      expect(adsRes.isError).toBeUndefined();

      const adsGen = ctx.siteGenerator.generateToDirectory(outDir);
      expect(adsGen.filesWritten).toContain('ads.txt');
      const adsTxtContent = fs.readFileSync(path.join(outDir, 'ads.txt'), 'utf8');
      expect(adsTxtContent.trim()).toBe(
        'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0'
      );

      const htmlWithAds = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      expect(htmlWithAds).toContain(
        'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1234567890123456'
      );
      expect(htmlWithAds).toContain('1111122222');
      expect(htmlWithAds).toContain('3333344444');
      expect(htmlWithAds).toContain('5555566666');

      // Verify .htaccess is generated for subdirectory DirectoryIndex and JSON CORS
      expect(adsGen.filesWritten).toContain('.htaccess');
      const htaccess = fs.readFileSync(path.join(outDir, '.htaccess'), 'utf8');
      expect(htaccess).toContain('DirectoryIndex index.html');

      // Verify all inline <script> blocks in index.html are 100% syntactically valid JavaScript
      const scriptBlocks = Array.from(
        htmlWithAds.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)
      );
      expect(scriptBlocks.length).toBeGreaterThanOrEqual(2);
      for (const match of scriptBlocks) {
        expect(() => new Function(match[1])).not.toThrow();
      }

      // Inspect add-ons via webring_get_addons MCP tool
      const getAddonsRes = await mcpServer.executeToolCall('webring_get_addons', {});
      const addonsData = getAddonsRes.data as {
        analyticsAddon: { enabled: boolean; measurementId: string };
        adsAddon: { enabled: boolean; publisherId: string };
      };
      expect(addonsData.analyticsAddon.enabled).toBe(true);
      expect(addonsData.analyticsAddon.measurementId).toBe('G-98765ABCDE');
      expect(addonsData.adsAddon.enabled).toBe(true);
      expect(addonsData.adsAddon.publisherId).toBe('ca-pub-1234567890123456');

      // 4. Clear both add-ons via MCP and verify /ads.txt and Google scripts are removed on re-export
      await mcpServer.executeToolCall('webring_configure_analytics_addon', { clear: true });
      await mcpServer.executeToolCall('webring_configure_ads_addon', { clear: true });

      const cleanGen = ctx.siteGenerator.generateToDirectory(outDir);
      expect(cleanGen.filesWritten).not.toContain('ads.txt');
      expect(fs.existsSync(path.join(outDir, 'ads.txt'))).toBe(false);
      const htmlCleaned = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      expect(htmlCleaned).not.toContain('G-98765ABCDE');
      expect(htmlCleaned).not.toContain('ca-pub-1234567890123456');
    } finally {
      manager.closeAll();
    }
  });
});

describe('Feed Integrity, Moderation & Publish Snapshot', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-curation-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const makeSite = (name: string) => {
    const dir = path.join(tempRoot, name);
    const db = new StudioDatabase(dir, `${name}.sqlite`);
    const siteUrl = `https://${name}.ring.test`;
    db.updateProfile({ siteUrl, handle: `${name}.ring.test`, displayName: name });
    const outDir = path.join(dir, 'public_html');
    const publish = () => new StaticSiteGenerator(db).generateToDirectory(outDir);
    return { db, siteUrl, outDir, publish };
  };

  it('rejects entries whose canonical URL points at another friend’s site', async () => {
    const alice = makeSite('alice');
    const carol = makeSite('carol');
    const mallory = makeSite('mallory');
    try {
      const carolPost = carol.db.createItem({ type: 'post', title: 'Carol original', commentary: 'real' });
      carol.publish();
      await new RingCrawler(alice.db).crawlFriendSite(carol.siteUrl, carol.outDir);

      // Mallory publishes a validly signed items.json claiming Carol's canonical URL
      mallory.db.createItem({ type: 'post', title: 'Spoofed', commentary: 'fake' });
      mallory.publish();
      const itemsPath = path.join(mallory.outDir, 'api/items.json');
      const { proof: _proof, ...itemsDoc } = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
      itemsDoc.items[0].canonicalUrl = carolPost.canonicalUrl;
      const resigned = signDocument(
        itemsDoc,
        siteUrlToDidWeb(mallory.siteUrl),
        mallory.db.getKeys().privateKeyPem
      );
      fs.writeFileSync(itemsPath, JSON.stringify(resigned));

      const res = await new RingCrawler(alice.db).crawlFriendSite(mallory.siteUrl, mallory.outDir);
      expect(res.success).toBe(true);
      expect(res.entriesRejected).toBe(1);

      const carolEntry = alice.db.getNetworkFeed().find((e) => e.canonicalUrl === carolPost.canonicalUrl);
      expect(carolEntry?.title).toBe('Carol original');
      expect(carolEntry?.friendSiteUrl).toBe(carol.siteUrl);
    } finally {
      alice.db.close();
      carol.db.close();
      mallory.db.close();
    }
  });

  it('prunes items a friend deleted, but never on a failed or unverified fetch', async () => {
    const alice = makeSite('alice');
    const bob = makeSite('bob');
    try {
      const keep = bob.db.createItem({ type: 'post', title: 'Keep me', commentary: '' });
      const drop = bob.db.createItem({ type: 'post', title: 'Delete me', commentary: '' });
      bob.publish();
      const crawler = new RingCrawler(alice.db);
      await crawler.crawlFriendSite(bob.siteUrl, bob.outDir);
      expect(alice.db.getNetworkFeed()).toHaveLength(2);

      bob.db.deleteItem(drop.id);
      bob.publish();

      // Tampered (unverified) items.json must not delete anything
      const itemsPath = path.join(bob.outDir, 'api/items.json');
      const original = fs.readFileSync(itemsPath, 'utf8');
      const tampered = JSON.parse(original);
      tampered.items = [];
      fs.writeFileSync(itemsPath, JSON.stringify(tampered));
      const tamperedRes = await crawler.crawlFriendSite(bob.siteUrl, bob.outDir);
      expect(tamperedRes.entriesPruned).toBe(0);
      expect(alice.db.getNetworkFeed()).toHaveLength(2);

      // Missing items.json must not delete anything either
      fs.rmSync(itemsPath);
      await crawler.crawlFriendSite(bob.siteUrl, bob.outDir);
      expect(alice.db.getNetworkFeed()).toHaveLength(2);

      fs.writeFileSync(itemsPath, original);
      const res = await crawler.crawlFriendSite(bob.siteUrl, bob.outDir);
      expect(res.entriesPruned).toBe(1);
      expect(alice.db.getNetworkFeed().map((e) => e.canonicalUrl)).toEqual([keep.canonicalUrl]);
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it('deleting a friend removes their feed entries and endorsements', async () => {
    const alice = makeSite('alice');
    const bob = makeSite('bob');
    try {
      const alicePost = alice.db.createItem({ type: 'post', title: 'Hello', commentary: '' });
      bob.db.createItem({ type: 'like', title: 'Nice', targetUrl: alicePost.canonicalUrl, commentary: '' });
      bob.publish();
      await new RingCrawler(alice.db).crawlFriendSite(bob.siteUrl, bob.outDir);
      expect(alice.db.getNetworkFeed().length).toBeGreaterThan(0);
      expect(alice.db.getEndorsements()).toHaveLength(1);

      const bobFriend = alice.db.getFriends().find((f) => f.siteUrl === bob.siteUrl)!;
      expect(bobFriend.lastCrawledAt).toBeTruthy();
      alice.db.deleteFriend(bobFriend.id);

      expect(alice.db.getNetworkFeed()).toHaveLength(0);
      expect(alice.db.getEndorsements()).toHaveLength(0);
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it('mute hides from the feed only; block also drops endorsements from the export and skips crawling', async () => {
    const alice = makeSite('alice');
    const bob = makeSite('bob');
    try {
      alice.db.updateProfile({ publishSettings: { publishEndorsements: true } });
      const alicePost = alice.db.createItem({ type: 'post', title: 'Hello', commentary: '' });
      bob.db.createItem({ type: 'like', title: 'Nice', targetUrl: alicePost.canonicalUrl, commentary: '' });
      bob.publish();
      const crawler = new RingCrawler(alice.db);
      await crawler.crawlFriendSite(bob.siteUrl, bob.outDir);

      alice.db.setModeration(bob.siteUrl, 'mute');
      const mutedFeed = alice.db.getCuratedNetworkFeed();
      expect(mutedFeed.entries).toHaveLength(0);
      expect(mutedFeed.excluded.muted).toBeGreaterThan(0);
      expect(alice.db.buildSignedSiteBundle().connections.endorsements).toHaveLength(1);

      alice.db.setModeration(bob.siteUrl, 'block');
      expect(alice.db.getCuratedNetworkFeed().excluded.blocked).toBeGreaterThan(0);
      expect(alice.db.buildSignedSiteBundle().connections.endorsements).toHaveLength(0);
      const blockedCrawl = await crawler.crawlFriendSite(bob.siteUrl, bob.outDir);
      expect(blockedCrawl.blocked).toBe(true);
      expect(blockedCrawl.success).toBe(false);

      alice.db.setModeration(bob.siteUrl, null);
      expect(alice.db.getModeration()).toHaveLength(0);
      expect(alice.db.buildSignedSiteBundle().connections.endorsements).toHaveLength(1);
    } finally {
      alice.db.close();
      bob.db.close();
    }
  });

  it('never publishes unverified endorsements', () => {
    const alice = makeSite('alice');
    try {
      alice.db.updateProfile({ publishSettings: { publishEndorsements: true } });
      const alicePost = alice.db.createItem({ type: 'post', title: 'Hello', commentary: '' });
      alice.db.upsertEndorsement({
        targetCanonicalUrl: alicePost.canonicalUrl,
        authorSiteUrl: 'https://unknown.ring.test',
        authorName: 'Unknown',
        authorAvatarUrl: '',
        type: 'like',
        commentary: '',
        sourceItemUrl: 'https://unknown.ring.test/api/items.json#item-1',
        createdAt: new Date().toISOString(),
        verifiedSignature: false,
      });
      expect(alice.db.getCuratedEndorsements().entries).toHaveLength(1);
      expect(alice.db.getCuratedEndorsements({ forExport: true }).excluded.unverified).toBe(1);
      expect(alice.db.buildSignedSiteBundle().connections.endorsements).toHaveLength(0);
    } finally {
      alice.db.close();
    }
  });

  it('records when the site was last published and counts changes since', async () => {
    const alice = makeSite('alice');
    try {
      expect(alice.db.getProfile().publishSettings.lastPublishedAt).toBeUndefined();
      const res = new SitePublisher(new StaticSiteGenerator(alice.db)).publishToLocalDirectory(alice.outDir);
      expect(res.success).toBe(true);

      const settings = alice.db.getProfile().publishSettings;
      expect(settings.lastPublishedAt).toBeTruthy();
      expect(settings.lastPublishedCounts?.endorsementCount).toBe(0);
      expect(alice.db.countChangesSince(settings.lastPublishedAt)).toBe(0);

      await new Promise((r) => setTimeout(r, 5));
      alice.db.createItem({ type: 'post', title: 'After publish', commentary: '' });
      expect(alice.db.countChangesSince(settings.lastPublishedAt)).toBe(1);
    } finally {
      alice.db.close();
    }
  });
});

describe('Private Key Encryption at Rest', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-keyvault-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  // Stand-in for Electron safeStorage: reversible, and obviously not plaintext
  const fakeCipher: KeyCipher = {
    isAvailable: () => true,
    encrypt: (plainText) => Buffer.from(plainText, 'utf8').reverse(),
    decrypt: (cipherText) => Buffer.from(cipherText).reverse().toString('utf8'),
  };

  const readStoredKey = (dbFile: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(dbFile);
    const row = raw.prepare('SELECT private_key_pem FROM profile WHERE id = 1').get() as {
      private_key_pem: string;
    };
    raw.close();
    return row.private_key_pem;
  };

  it('migrates a plaintext key to encrypted storage and still signs', () => {
    const plainDb = new StudioDatabase(tempRoot, 'p.sqlite');
    const originalKey = plainDb.getKeys().privateKeyPem;
    plainDb.close();
    expect(readStoredKey(path.join(tempRoot, 'p.sqlite'))).toContain('BEGIN PRIVATE KEY');

    const sealedDb = new StudioDatabase(tempRoot, 'p.sqlite', { keyCipher: fakeCipher });
    expect(readStoredKey(path.join(tempRoot, 'p.sqlite'))).toMatch(/^enc:v1:/);
    expect(sealedDb.getKeys().privateKeyPem).toBe(originalKey);
    const bundle = sealedDb.buildSignedSiteBundle();
    expect(verifyDocumentSignature(bundle.profile, sealedDb.getKeys().publicKeyPem)).toBe(true);
    sealedDb.close();
  });

  it('seals publishing credentials, never returns them from getProfile, and keeps them through the form', () => {
    // An older install stored them in plaintext
    const legacy = new StudioDatabase(tempRoot, 'creds.sqlite');
    legacy.updateProfile({ publishSettings: { password: 'sftp-secret', githubToken: 'ghp_legacy' } });
    legacy.close();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const readStored = () => {
      const raw = new DatabaseSync(path.join(tempRoot, 'creds.sqlite'));
      const row = raw.prepare('SELECT publish_settings_json FROM profile WHERE id = 1').get() as {
        publish_settings_json: string;
      };
      raw.close();
      return JSON.parse(row.publish_settings_json);
    };
    expect(readStored().password).toBe('sftp-secret');

    const db = new StudioDatabase(tempRoot, 'creds.sqlite', { keyCipher: fakeCipher });
    try {
      // Sealed on open, masked on read, readable only via getPublishCredentials
      expect(readStored().password).toMatch(/^enc:v1:/);
      expect(readStored().githubToken).toMatch(/^enc:v1:/);
      const shown = db.getProfile().publishSettings;
      expect(shown.password).toBe(STORED_SECRET_PLACEHOLDER);
      expect(shown.githubToken).toBe(STORED_SECRET_PLACEHOLDER);
      expect(db.getPublishCredentials()).toEqual({ password: 'sftp-secret', githubToken: 'ghp_legacy' });

      // Saving the form as shown (placeholders) keeps the stored values
      db.updateProfile({ publishSettings: { ...shown, host: 'example.org' } });
      expect(db.getPublishCredentials()).toEqual({ password: 'sftp-secret', githubToken: 'ghp_legacy' });
      expect(db.withStoredCredentials(db.getProfile().publishSettings).password).toBe('sftp-secret');

      // A new value replaces (sealed); '' clears
      db.updateProfile({ publishSettings: { githubToken: 'ghp_new' } });
      expect(readStored().githubToken).toMatch(/^enc:v1:/);
      expect(db.getPublishCredentials().githubToken).toBe('ghp_new');
      db.updateProfile({ publishSettings: { password: '' } });
      expect(db.getPublishCredentials().password).toBe('');
      expect(db.getProfile().publishSettings.password).toBe('');

      // Nothing secret reaches the published site
      const out = path.join(tempRoot, 'creds-out');
      new StaticSiteGenerator(db).generateToDirectory(out);
      const published = fs
        .readdirSync(path.join(out, 'api'))
        .map((f) => fs.readFileSync(path.join(out, 'api', f), 'utf8'))
        .join('\n');
      expect(published).not.toContain('ghp_new');
    } finally {
      db.close();
    }

    // Outside the app the profile still reads fine, but the credentials can't be opened
    const cli = new StudioDatabase(tempRoot, 'creds.sqlite');
    try {
      expect(cli.getProfile().publishSettings.githubToken).toBe(STORED_SECRET_PLACEHOLDER);
      expect(() => cli.getPublishCredentials()).toThrow(KeyVaultUnavailableError);
    } finally {
      cli.close();
    }
  });

  it('fails cleanly when signing without the keychain (stdio MCP CLI)', () => {
    new StudioDatabase(tempRoot, 'c.sqlite', { keyCipher: fakeCipher }).close();

    const cliDb = new StudioDatabase(tempRoot, 'c.sqlite');
    expect(cliDb.getProfile().displayName).toBeTruthy();
    expect(() => cliDb.buildSignedSiteBundle()).toThrow(KeyVaultUnavailableError);
    const res = new SitePublisher(new StaticSiteGenerator(cliDb)).publishToLocalDirectory(
      path.join(tempRoot, 'out')
    );
    expect(res.success).toBe(false);
    expect(res.message).toContain('Open Webring Studio to publish');
    cliDb.close();
  });
});

describe('Loopback MCP HTTP Settings', () => {
  it('keeps the same port and access token across restarts', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-mcp-http-'));
    const manager = new PersonaManager(tempRoot);
    const settingsPath = path.join(tempRoot, 'mcp-http.json');
    try {
      const first = new McpHttpServer(new WebringMcpServer(manager, tempRoot), { settingsPath });
      const firstStatus = await first.start(0);
      await first.stop();

      const second = new McpHttpServer(new WebringMcpServer(manager, tempRoot), { settingsPath });
      const secondStatus = await second.start(0);
      await second.stop();

      expect(secondStatus.port).toBe(firstStatus.port);
      expect(secondStatus.authorizedSseUrl).toBe(firstStatus.authorizedSseUrl);
      expect((fs.statSync(settingsPath).mode & 0o777).toString(8)).toBe('600');
    } finally {
      manager.closeAll();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('SSRF Guard for Peer Crawling', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secret: 'internal-only' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    delete process.env.WEBRING_ALLOW_PRIVATE_PEERS;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('classifies private, local and metadata addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateNetworkAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1']) {
      expect(isPrivateNetworkAddress(ip), ip).toBe(false);
    }
  });

  it('refuses to fetch loopback addresses by IP or hostname', async () => {
    await expect(defaultJsonFetcher(`http://127.0.0.1:${port}/api/manifest.json`)).rejects.toThrow(
      /private or local network address/
    );
    await expect(defaultJsonFetcher(`http://localhost:${port}/api/manifest.json`)).rejects.toThrow(
      /private or local network address/
    );
    await expect(defaultJsonFetcher(`http://[::1]:${port}/x`)).rejects.toThrow(
      /private or local network address/
    );
  });

  it('reports a blocked peer as a failed crawl, and allows it when explicitly enabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-ssrf-'));
    const db = new StudioDatabase(dir, 'ssrf.sqlite');
    try {
      const res = await new RingCrawler(db).crawlFriendSite(`http://127.0.0.1:${port}`);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/private or local network address/);

      process.env.WEBRING_ALLOW_PRIVATE_PEERS = '1';
      await expect(defaultJsonFetcher(`http://127.0.0.1:${port}/x`)).resolves.toEqual({
        secret: 'internal-only',
      });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Curated Webrings (hosted rings, signed requests, sync)', () => {
  let tempRoot: string;
  const sites = new Map<string, { db: StudioDatabase; outDir: string }>();

  // Serves https://<name>.ring.test/... from each site's published folder
  const fetcher = async (url: string): Promise<unknown> => {
    const parsed = new URL(url);
    const site = sites.get(parsed.origin);
    if (!site) throw new Error(`HTTP 404 fetching ${url}`);
    const file = path.join(site.outDir, decodeURIComponent(parsed.pathname));
    if (!fs.existsSync(file)) throw new Error(`HTTP 404 fetching ${url}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };

  const makeSite = (name: string) => {
    const siteUrl = `https://${name}.ring.test`;
    const dir = path.join(tempRoot, name);
    const db = new StudioDatabase(dir, `${name}.sqlite`);
    db.updateProfile({ siteUrl, handle: `${name}.ring.test`, displayName: name });
    const outDir = path.join(dir, 'public_html');
    sites.set(siteUrl, { db, outDir });
    return {
      db,
      siteUrl,
      outDir,
      rings: new RingService(db, fetcher),
      publish: () => new StaticSiteGenerator(db).generateToDirectory(outDir),
    };
  };

  const tick = () => new Promise((r) => setTimeout(r, 5));

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-rings-'));
    sites.clear();
  });

  afterEach(() => {
    for (const { db } of sites.values()) db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('joins a ring end to end: signed request, approval, membership on both sides', async () => {
    const maya = makeSite('maya');
    const bob = makeSite('bob');
    const carol = makeSite('carol');
    const ring = maya.db.createHostedRing({ name: 'Photo Ring', description: 'Film photographers' });
    maya.publish();
    bob.publish();
    carol.publish();

    const { ring: bobRing, requestLink } = await bob.rings.requestToJoin(ring.hubUrl);
    expect(bobRing.status).toBe('requested');
    expect(requestLink).toMatch(/^webring:\/\/ring-request\?token=/);
    // Requests are private: nothing about the request is published
    bob.publish();
    expect(bob.db.buildSignedSiteBundle().connections.webrings).toHaveLength(0);

    const review = await maya.rings.reviewRequest(requestLink);
    expect(review.state).toBe('new');
    expect(review.applicant.siteUrl).toBe(bob.siteUrl);
    await maya.rings.decideRequest(requestLink, 'approve');
    const { requestLink: carolLink } = await carol.rings.requestToJoin(ring.hubUrl);
    await maya.rings.decideRequest(carolLink, 'approve');
    await tick();
    maya.publish();

    const [bobSync] = await bob.rings.syncJoinedRings();
    expect(bobSync.outcome).toBe('member');
    const joined = bob.db.getJoinedRings()[0];
    expect(joined.status).toBe('member');
    expect(joined.memberCount).toBe(3);
    // Order is maya, bob, carol
    expect(joined.prevSiteUrl).toBe(maya.siteUrl);
    expect(joined.nextSiteUrl).toBe(carol.siteUrl);
    bob.publish();
    expect(bob.db.buildSignedSiteBundle().connections.webrings[0].hubUrl).toBe(ring.hubUrl);

    const [hostedSync] = await maya.rings.syncHostedRings();
    expect(hostedSync.confirmed).toEqual([bob.siteUrl]);
    expect(hostedSync.autoRemoved).toEqual([]);
    // Carol hasn't published the ring yet but is inside the grace period
    expect(maya.db.getHostedRing(ring.id).members.map((m) => m.siteUrl)).toContain(carol.siteUrl);
  });

  it('removes a confirmed member who leaves, and propagates removal and bans to the member', async () => {
    const maya = makeSite('maya');
    const bob = makeSite('bob');
    const ring = maya.db.createHostedRing({ name: 'Ring' });
    maya.publish();
    bob.publish();
    const { requestLink } = await bob.rings.requestToJoin(ring.hubUrl);
    await maya.rings.decideRequest(requestLink, 'approve');
    await tick();
    maya.publish();
    await bob.rings.syncJoinedRings();
    bob.publish();
    await maya.rings.syncHostedRings();

    // Bob leaves; Maya's sync removes him because he had confirmed before
    bob.db.deleteWebring(bob.db.getJoinedRings()[0].id);
    bob.publish();
    const [afterLeave] = await maya.rings.syncHostedRings();
    expect(afterLeave.autoRemoved).toEqual([bob.siteUrl]);

    // Bob re-joins, then Maya bans him
    const again = await bob.rings.requestToJoin(ring.hubUrl);
    await maya.rings.decideRequest(again.requestLink, 'approve');
    await tick();
    maya.publish();
    await bob.rings.syncJoinedRings();
    expect(bob.db.getJoinedRings()[0].status).toBe('member');
    await maya.rings.decideRequest(again.requestLink, 'ban', 'spam');
    await tick();
    maya.publish();
    const [removed] = await bob.rings.syncJoinedRings();
    expect(removed.outcome).toBe('removed');
    expect(bob.db.buildSignedSiteBundle().connections.webrings).toHaveLength(0);

    // A fresh request from a banned site is recognised and can't be approved
    const third = await bob.rings.requestToJoin(ring.hubUrl);
    expect((await maya.rings.reviewRequest(third.requestLink)).state).toBe('banned');
    await expect(maya.rings.decideRequest(third.requestLink, 'approve')).rejects.toThrow(/banned/);
  });

  it('ignores stale hub copies, and never removes anyone on a changed key or unsigned hub', async () => {
    const maya = makeSite('maya');
    const bob = makeSite('bob');
    const ring = maya.db.createHostedRing({ name: 'Ring' });
    maya.publish();
    bob.publish();
    const hubFile = path.join(maya.outDir, ring.hubPath);
    const beforeBob = fs.readFileSync(hubFile, 'utf8');
    const { requestLink } = await bob.rings.requestToJoin(ring.hubUrl);
    await maya.rings.decideRequest(requestLink, 'approve');
    await tick();
    maya.publish();
    await bob.rings.syncJoinedRings();
    expect(bob.db.getJoinedRings()[0].status).toBe('member');

    // An older (signed, valid) copy that doesn't list Bob is ignored
    const current = fs.readFileSync(hubFile, 'utf8');
    fs.writeFileSync(hubFile, beforeBob);
    expect((await bob.rings.syncJoinedRings())[0].outcome).toBe('unchanged');
    expect(bob.db.getJoinedRings()[0].status).toBe('member');

    // An unsigned hub that drops Bob can't remove him
    const unsigned = JSON.parse(current);
    delete unsigned.proof;
    unsigned.members = unsigned.members.filter((m: { siteUrl: string }) => m.siteUrl !== bob.siteUrl);
    unsigned.updatedAt = new Date(Date.now() + 60000).toISOString();
    fs.writeFileSync(hubFile, JSON.stringify(unsigned));
    expect((await bob.rings.syncJoinedRings())[0].outcome).toBe('unchanged');
    expect(bob.db.getJoinedRings()[0].status).toBe('member');

    // A changed maintainer key freezes the ring instead of removing anyone
    fs.writeFileSync(hubFile, current);
    const didFile = path.join(maya.outDir, '.well-known/did.json');
    const didDoc = JSON.parse(fs.readFileSync(didFile, 'utf8'));
    didDoc.verificationMethod[0].publicKeyPem = generateIdentityKeyPair().publicKeyPem;
    fs.writeFileSync(didFile, JSON.stringify(didDoc));
    const [frozen] = await bob.rings.syncJoinedRings();
    expect(frozen.outcome).toBe('unchanged');
    expect(frozen.warning).toMatch(/key changed/);
    expect(bob.db.getJoinedRings()[0].status).toBe('member');
  });

  it('refuses re-hosted hubs and non-https hub URLs, and propagates a closed ring', async () => {
    const maya = makeSite('maya');
    const mallory = makeSite('mallory');
    const bob = makeSite('bob');
    const ring = maya.db.createHostedRing({ name: 'Ring' });
    maya.publish();
    mallory.publish();
    bob.publish();

    // Mallory re-hosts Maya's signed hub on her own site
    const copyPath = path.join(mallory.outDir, 'api/rings/copied.json');
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    fs.copyFileSync(path.join(maya.outDir, ring.hubPath), copyPath);
    await expect(bob.rings.requestToJoin(`${mallory.siteUrl}/api/rings/copied.json`)).rejects.toThrow(
      /lives at/
    );
    await expect(bob.rings.requestToJoin(`file://${path.join(maya.outDir, ring.hubPath)}`)).rejects.toThrow(
      /https/
    );
    await expect(bob.rings.requestToJoin(ring.hubUrl.replace('https:', 'http:'))).rejects.toThrow(/https/);

    const { requestLink } = await bob.rings.requestToJoin(ring.hubUrl);
    await maya.rings.decideRequest(requestLink, 'approve');
    await tick();
    maya.publish();
    await bob.rings.syncJoinedRings();
    maya.db.updateHostedRing(ring.id, { status: 'closed' });
    await tick();
    maya.publish();
    expect((await bob.rings.syncJoinedRings())[0].outcome).toBe('closed');
    expect(bob.db.buildSignedSiteBundle().connections.webrings).toHaveLength(0);
    // The closed hub is still published, with no members
    const closedDoc = JSON.parse(fs.readFileSync(path.join(maya.outDir, ring.hubPath), 'utf8'));
    expect(closedDoc.status).toBe('closed');
    expect(closedDoc.members).toEqual([]);
  });

  it('rejects tampered, expired or misdirected requests', async () => {
    const maya = makeSite('maya');
    const bob = makeSite('bob');
    const other = makeSite('other');
    const ring = maya.db.createHostedRing({ name: 'Ring' });
    other.db.createHostedRing({ name: 'Other Ring' });
    maya.publish();
    bob.publish();
    other.publish();
    const { requestLink } = await bob.rings.requestToJoin(ring.hubUrl);

    const token = requestLink.split('token=')[1];
    const decoded = JSON.parse(Buffer.from(decodeURIComponent(token), 'base64url').toString('utf8'));
    decoded.displayName = 'Impostor';
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    await expect(maya.rings.reviewRequest(tampered)).rejects.toThrow(/signature/);

    await expect(other.rings.reviewRequest(requestLink)).rejects.toThrow(/doesn’t host/);
    await expect(maya.rings.reviewRequest('webring://ring-request?token=garbage')).rejects.toThrow(/damaged/);
  });

  it('publishes small rings sensibly and converts the old hub in place', async () => {
    const maya = makeSite('maya');
    maya.db.createHostedRing({ name: 'Solo' });
    const solo = maya.db.getWebrings()[0];
    expect(solo.memberCount).toBe(1);
    expect(solo.prevSiteUrl).toBeUndefined();
    expect(solo.nextSiteUrl).toBeUndefined();

    // Old install: hub setting on, one public friend
    const legacyDir = path.join(tempRoot, 'legacy');
    const legacy = new StudioDatabase(legacyDir, 'legacy.sqlite');
    legacy.updateProfile({ siteUrl: 'https://legacy.ring.test', publishSettings: { publishWebringHub: true } });
    legacy.addOrUpdateFriend({ siteUrl: 'https://pal.ring.test', displayName: 'Pal', visibility: 'public' });
    legacy.close();

    const reopened = new StudioDatabase(legacyDir, 'legacy.sqlite');
    try {
      const [hosted] = reopened.getHostedRings();
      expect(hosted.hubPath).toBe('api/webring-hub.json');
      expect(hosted.members.map((m) => m.siteUrl)).toContain('https://pal.ring.test');
      expect(reopened.getProfile().publishSettings.publishWebringHub).toBe(false);
      expect(reopened.getJoinedRings().every((r) => r.status === 'legacy')).toBe(true);
      const out = path.join(legacyDir, 'out');
      new StaticSiteGenerator(reopened).generateToDirectory(out);
      const hub = JSON.parse(fs.readFileSync(path.join(out, 'api/webring-hub.json'), 'utf8'));
      expect(hub.hubUrl).toBe('https://legacy.ring.test/api/webring-hub.json');
      expect(hub.proof).toBeDefined();
    } finally {
      reopened.close();
    }
  });
});

describe('Scheduled Sync & Publish', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-schedule-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);

  it('computes the next run for each preset, catching up once after a gap', () => {
    // Interval: one interval after the anchor
    expect(nextRunAt({ kind: 'interval', minutes: 60 }, local(2026, 3, 2, 10, 15))).toEqual(local(2026, 3, 2, 11, 15));
    // Daily: later today, or tomorrow once the time has passed
    expect(nextRunAt({ kind: 'daily', time: '09:30' }, local(2026, 3, 2, 8, 0))).toEqual(local(2026, 3, 2, 9, 30));
    expect(nextRunAt({ kind: 'daily', time: '09:30' }, local(2026, 3, 2, 9, 30))).toEqual(local(2026, 3, 3, 9, 30));
    // Weekly (2026-03-02 is a Monday): Friday this week; Monday at the same time moves a week on
    expect(nextRunAt({ kind: 'weekly', weekday: 5, time: '18:00' }, local(2026, 3, 2, 12, 0))).toEqual(
      local(2026, 3, 6, 18, 0)
    );
    expect(nextRunAt({ kind: 'weekly', weekday: 1, time: '12:00' }, local(2026, 3, 2, 12, 0))).toEqual(
      local(2026, 3, 9, 12, 0)
    );
    // Daily slots keep local wall-clock time across a month of days (incl. any DST change)
    const later = nextRunAt({ kind: 'daily', time: '07:00' }, local(2026, 3, 28, 23, 0));
    expect([later.getHours(), later.getMinutes()]).toEqual([7, 0]);
    // After a long gap the job is due once; running moves the anchor to "now"
    const job = { enabled: true, preset: { kind: 'daily' as const, time: '09:00' }, since: local(2026, 3, 1, 8, 0).toISOString() };
    expect(jobNextRunAt(job) <= local(2026, 3, 20, 12, 0)).toBe(true);
    const afterRun = { ...job, lastRunAt: local(2026, 3, 20, 12, 0).toISOString() };
    expect(jobNextRunAt(afterRun)).toEqual(local(2026, 3, 21, 9, 0));
  });

  it('queues due jobs in order, one at a time, and respects pause and disabled schedules', async () => {
    let now = local(2026, 3, 2, 8, 0);
    const calls: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const slow = async (label: string) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      calls.push(label);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      return { at: now.toISOString(), status: 'ok' as const, message: label };
    };
    const scheduler = new Scheduler({
      configPath: path.join(tempRoot, 'scheduler.json'),
      listPersonaIds: () => ['a', 'b'],
      now: () => now,
      runner: {
        sync: (id) => slow(`sync:${id}`),
        publish: (id, destination) => slow(`publish:${id}:${destination}`),
      },
    });
    scheduler.setPersonaSchedule('a', {
      sync: { enabled: true, preset: { kind: 'interval', minutes: 15 } },
      publish: { enabled: true, preset: { kind: 'interval', minutes: 60 }, destination: 'github' },
    });
    scheduler.setPersonaSchedule('b', { sync: { enabled: true, preset: { kind: 'interval', minutes: 60 } } });

    await scheduler.tick();
    expect(calls).toEqual([]);

    now = local(2026, 3, 2, 9, 5);
    await scheduler.tick();
    expect(calls).toEqual(['sync:a', 'publish:a:github', 'sync:b']);
    expect(maxConcurrent).toBe(1);
    const config = scheduler.loadConfig();
    expect(config.personas.a.sync.lastResult?.message).toBe('sync:a');
    expect(config.history).toHaveLength(3);

    // Ran at 09:05, so nothing is due a minute later; paused stops everything
    now = local(2026, 3, 2, 9, 6);
    await scheduler.tick();
    expect(calls).toHaveLength(3);
    scheduler.setAppSettings({ paused: true });
    now = local(2026, 3, 2, 12, 0);
    await scheduler.tick();
    expect(calls).toHaveLength(3);

    // Edits written by another process (e.g. the MCP CLI) are picked up on the next tick
    const raw = JSON.parse(fs.readFileSync(path.join(tempRoot, 'scheduler.json'), 'utf8'));
    raw.paused = false;
    raw.personas.b.sync.enabled = false;
    fs.writeFileSync(path.join(tempRoot, 'scheduler.json'), JSON.stringify(raw));
    await scheduler.tick();
    expect(calls.slice(3)).toEqual(['sync:a', 'publish:a:github']);

    // Schedules for deleted personas are dropped
    const pruned = new Scheduler({
      configPath: path.join(tempRoot, 'scheduler.json'),
      listPersonaIds: () => ['a'],
      runner: { sync: () => slow('x'), publish: () => slow('y') },
    });
    expect(Object.keys(pruned.loadConfig().personas)).toEqual(['a']);
  });

  it('records a failed job as a run so it waits for its next slot, and serialises with manual work', async () => {
    let now = local(2026, 3, 2, 10, 0);
    const scheduler = new Scheduler({
      configPath: path.join(tempRoot, 'scheduler.json'),
      listPersonaIds: () => ['a'],
      now: () => now,
      runner: {
        sync: () => Promise.reject(new Error('host unreachable')),
        publish: () => Promise.reject(new Error('unused')),
      },
    });
    scheduler.setPersonaSchedule('a', { sync: { enabled: true, preset: { kind: 'interval', minutes: 15 } } });
    now = local(2026, 3, 2, 10, 20);
    await scheduler.tick();
    const first = scheduler.loadConfig().personas.a.sync;
    expect(first.lastResult?.status).toBe('failed');
    expect(first.lastResult?.message).toBe('host unreachable');
    now = local(2026, 3, 2, 10, 21);
    await scheduler.tick();
    expect(scheduler.loadConfig().history).toHaveLength(1);

    const order: string[] = [];
    const manual = scheduler.runExclusive('a', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('manual');
    });
    const second = scheduler.runExclusive('a', async () => {
      order.push('second');
    });
    await Promise.all([manual, second]);
    expect(order).toEqual(['manual', 'second']);
  });

  it('fingerprints site content, ignoring timestamps and signatures', async () => {
    const dir = path.join(tempRoot, 'fp');
    const mediaDir = path.join(dir, 'media');
    const db = new StudioDatabase(dir, 'fp.sqlite');
    try {
      db.updateProfile({ siteUrl: 'https://fp.ring.test' });
      const generator = new StaticSiteGenerator(db, mediaDir);
      const base = generator.contentFingerprint();
      await new Promise((r) => setTimeout(r, 5));
      expect(generator.contentFingerprint()).toBe(base);

      db.createItem({ type: 'post', title: 'New', commentary: '' });
      const afterPost = generator.contentFingerprint();
      expect(afterPost).not.toBe(base);

      db.updateProfile({ publishSettings: { publishEndorsements: true } });
      db.upsertEndorsement({
        targetCanonicalUrl: 'https://fp.ring.test/api/items.json#item-x',
        authorSiteUrl: 'https://pal.ring.test',
        authorName: 'Pal',
        authorAvatarUrl: '',
        type: 'like',
        commentary: '',
        sourceItemUrl: 'https://pal.ring.test/api/items.json#item-1',
        createdAt: new Date().toISOString(),
        verifiedSignature: true,
      });
      const afterEndorsement = generator.contentFingerprint();
      expect(afterEndorsement).not.toBe(afterPost);

      const ring = db.createHostedRing({ name: 'FP Ring' });
      const afterRing = generator.contentFingerprint();
      expect(afterRing).not.toBe(afterEndorsement);
      db.addRingMember(ring.id, { siteUrl: 'https://pal.ring.test', displayName: 'Pal', did: '', keyFingerprint: '' });
      const afterMember = generator.contentFingerprint();
      expect(afterMember).not.toBe(afterRing);

      // Files no photo uses aren't published, so they don't count
      fs.mkdirSync(path.join(mediaDir, 'albums', 'a1'), { recursive: true });
      fs.writeFileSync(path.join(mediaDir, 'stray.jpg'), 'pixels');
      expect(generator.contentFingerprint()).toBe(afterMember);
      // A photo's file changing on disk does
      const album = db.createAlbum({ title: 'FP' });
      fs.writeFileSync(path.join(mediaDir, 'albums', 'a1', 'p.jpg'), 'pixels');
      db.addPhotoToAlbum({ albumId: album.id, url: 'media/albums/a1/p.jpg' });
      const withPhoto = generator.contentFingerprint();
      expect(withPhoto).not.toBe(afterMember);
      fs.writeFileSync(path.join(mediaDir, 'albums', 'a1', 'p.jpg'), 'different pixels');
      expect(generator.contentFingerprint()).not.toBe(withPhoto);
    } finally {
      db.close();
    }
  });

  it('runs a scheduled publish for a non-active persona with its own key, skipping when unchanged', async () => {
    const manager = new PersonaManager(path.join(tempRoot, 'studio'));
    try {
      const created = manager.createPersona({
        label: 'Second',
        displayName: 'Second Self',
        siteUrl: 'https://second.ring.test',
      });
      const secondId = created.created.id;
      manager.switchPersona('default');
      const activeBefore = manager.getActiveContext().db.getProfile().siteUrl;
      const exportDir = path.join(tempRoot, 'second-export');
      const paths = { userDataDir: path.join(tempRoot, 'studio'), tempDir: tempRoot };

      const first = await manager.withPersonaContext(secondId, async (ctx) => {
        ctx.db.updateProfile({ publishSettings: { exportPath: exportDir } });
        return runScheduledPublish(ctx, 'local', false, paths);
      });
      expect(first.status).toBe('ok');
      const didDoc = JSON.parse(fs.readFileSync(path.join(exportDir, '.well-known/did.json'), 'utf8'));
      expect(didDoc.id).toBe('did:web:second.ring.test');
      const profileDoc = JSON.parse(fs.readFileSync(path.join(exportDir, 'api/profile.json'), 'utf8'));
      expect(verifyDocumentSignature(profileDoc, didDoc.verificationMethod[0].publicKeyPem)).toBe(true);

      const second = await manager.withPersonaContext(secondId, (ctx) =>
        runScheduledPublish(ctx, 'local', false, paths)
      );
      expect(second.status).toBe('skipped');

      // The active persona is untouched and still usable
      expect(manager.getActivePersonaId()).toBe('default');
      expect(manager.getActiveContext().db.getProfile().siteUrl).toBe(activeBefore);

      // A destination that isn't set up fails without publishing anything
      const remote = await manager.withPersonaContext(secondId, async (ctx) => {
        ctx.db.createItem({ type: 'post', title: 'Changed', commentary: '' });
        return runScheduledPublish(ctx, 'remote', false, paths);
      });
      expect(remote.status).toBe('failed');
      expect(remote.message).toMatch(/host and username/);
    } finally {
      manager.closeAll();
    }
  });
});

describe('Release defaults (no sample content)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-defaults-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('starts new installs empty, with a placeholder profile', () => {
    const db = new StudioDatabase(tempRoot, 'fresh.sqlite');
    try {
      const profile = db.getProfile();
      expect(isPlaceholderSiteUrl(profile.siteUrl)).toBe(true);
      expect(profile.displayName).toBe('Your Name');
      expect(profile.bio).toBe('');
      expect(db.getItems()).toHaveLength(0);
      expect(db.getAlbums()).toHaveLength(0);
      expect(db.getFriends()).toHaveLength(0);
      expect(db.getJoinedRings()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('removes untouched sample content from older installs and keeps anything edited', () => {
    const dbFile = path.join(tempRoot, 'old.sqlite');
    new StudioDatabase(tempRoot, 'old.sqlite').close();

    // Recreate what older versions seeded, as an old install would have it
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(dbFile);
    const now = new Date().toISOString();
    raw.prepare(
      `UPDATE profile SET site_url = ?, handle = ?, display_name = ?, tagline = ?, bio = ?, location = ?,
         avatar_url = ?, banner_url = ?, interests_json = ?, atproto_handle = ?, publish_settings_json = '{}'`
    ).run(
      LEGACY_DEMO_PROFILE.siteUrl,
      LEGACY_DEMO_PROFILE.handle,
      LEGACY_DEMO_PROFILE.displayName,
      'My own tagline', // the user changed this one
      LEGACY_DEMO_PROFILE.bio,
      LEGACY_DEMO_PROFILE.location,
      LEGACY_DEMO_PROFILE.avatarUrl,
      LEGACY_DEMO_PROFILE.bannerUrl,
      JSON.stringify(LEGACY_DEMO_PROFILE.interests),
      LEGACY_DEMO_PROFILE.atprotoHandle
    );
    raw.prepare(
      `INSERT INTO albums (id, title, description, cover_url, tags_json, created_at, updated_at)
       VALUES ('album-pnw-trails', 'Misty Morning Trails', '', '', '[]', ?, ?)`
    ).run(now, now);
    raw.prepare(
      `INSERT INTO photos (id, album_id, url, thumb_url, caption, alt_text, tags_json, created_at)
       VALUES ('photo-sunbeams', 'album-pnw-trails', ?, '', '', '', '[]', ?)`
    ).run(LEGACY_DEMO_PHOTOS[0].url, now);
    const insertItem = raw.prepare(
      `INSERT INTO items (id, type, title, target_url, category, commentary, tags_json, created_at)
       VALUES (?, 'post', ?, '', 'status', '', '[]', ?)`
    );
    insertItem.run('item-welcome-post', 'Building My Own Static Social Wall on the IndieWeb', now);
    insertItem.run('item-camera-rec', 'My edited review of the OM-1', now); // edited: keep
    insertItem.run('item-user-post', 'A post the user wrote', now); // not seeded: keep
    raw.prepare(
      `INSERT INTO friends (id, site_url, did, display_name, handle, relationship_json, visibility, added_at)
       VALUES ('friend-maya', 'https://maya.indiering.social', 'did:web:maya.indiering.social', 'Maya Lin', 'maya', '[]', 'private', ?)`
    ).run(now);
    raw.prepare(
      `INSERT INTO network_feed (id, friend_site_url, friend_name, entry_type, title, canonical_url, target_url, created_at)
       VALUES ('feed-demo', 'https://maya.indiering.social', 'Maya Lin', 'post', 'Demo', 'https://maya.indiering.social/api/items.json#x', '', ?)`
    ).run(now);
    raw.prepare(
      `INSERT INTO webrings (id, name, hub_url, description, prev_site_url, next_site_url, joined_at)
       VALUES ('ring-indie-craft', 'Indie Craft & Photo Ring', 'https://ring.indiecraft.org/webring-hub.json', '', '', '', ?)`
    ).run(now);
    raw.close();

    const db = new StudioDatabase(tempRoot, 'old.sqlite');
    try {
      const profile = db.getProfile();
      expect(isPlaceholderSiteUrl(profile.siteUrl)).toBe(true);
      expect(profile.displayName).toBe('Your Name');
      expect(profile.tagline).toBe('My own tagline');
      expect(profile.bio).toBe('');
      expect(profile.interests).toEqual([]);
      expect(db.getItems().map((i) => i.id).sort()).toEqual(['item-camera-rec', 'item-user-post']);
      expect(db.getAlbums()).toHaveLength(0);
      expect(db.getFriends()).toHaveLength(0);
      expect(db.getNetworkFeed()).toHaveLength(0);
      expect(db.getJoinedRings()).toHaveLength(0);
    } finally {
      db.close();
    }

    // Runs once: content added afterwards with the same ids is left alone
    const again = new DatabaseSync(dbFile);
    again.prepare(
      `INSERT INTO items (id, type, title, target_url, category, commentary, tags_json, created_at)
       VALUES ('item-welcome-post', 'post', 'Building My Own Static Social Wall on the IndieWeb', '', 'status', '', '[]', ?)`
    ).run(now);
    again.close();
    const reopened = new StudioDatabase(tempRoot, 'old.sqlite');
    try {
      expect(reopened.getItems().some((i) => i.id === 'item-welcome-post')).toBe(true);
    } finally {
      reopened.close();
    }
  });
});

describe('Media Library', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-media-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /** A JPEG with an EXIF block (orientation + a fake GPS marker) like a phone photo. */
  const makePhoneJpeg = (width: number, height: number, orientation: number, seed = 0): Buffer => {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4] = (i + seed) % 256;
      data[i * 4 + 1] = (i * 3 + seed) % 256;
      data[i * 4 + 2] = 128;
      data[i * 4 + 3] = 255;
    }
    const encoded = jpegJs.encode({ data, width, height }, 90).data;
    const tiff = Buffer.alloc(26);
    tiff.write('II', 0, 'ascii');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8); // one IFD entry
    tiff.writeUInt16LE(0x0112, 10); // Orientation
    tiff.writeUInt16LE(3, 12); // SHORT
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    tiff.writeUInt32LE(0, 22);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff, Buffer.from('GPS-SECRET-48.8584N', 'ascii')]);
    const header = Buffer.from([0xff, 0xe1, 0, 0]);
    header.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([encoded.subarray(0, 2), header, payload, encoded.subarray(2)]);
  };

  const makeSite = (name: string) => {
    const dir = path.join(tempRoot, name);
    const db = new StudioDatabase(dir, `${name}.sqlite`);
    db.updateProfile({ siteUrl: `https://${name}.example`, displayName: name });
    const mediaDir = path.join(dir, 'media-store');
    const library = new MediaLibrary(mediaDir);
    const generator = new StaticSiteGenerator(db, mediaDir);
    return { db, library, generator, publisher: new SitePublisher(generator), dir };
  };

  it('cleans up a post image that was replaced, removed or deleted with its post', () => {
    const site = makeSite('posts');
    const image = (name: string, seed: number) => {
      const file = path.join(tempRoot, name);
      fs.writeFileSync(file, makePhoneJpeg(600, 400, 1, seed));
      return site.library.importPhoto(file, 'wall-posts').url;
    };
    const first = image('one.jpg', 1);
    const post = site.db.createItem({ type: 'post', commentary: 'Look', mediaUrl: first });
    const second = image('two.jpg', 2);
    site.db.updateItem(post.id, { mediaUrl: second });
    cleanUpLibrary(site.db, site.library);
    expect(fs.existsSync(site.library.resolveLocalUrl(first)!)).toBe(false);
    expect(fs.existsSync(site.library.resolveLocalUrl(second)!)).toBe(true);
    site.db.deleteItem(post.id);
    cleanUpLibrary(site.db, site.library);
    expect(fs.existsSync(site.library.resolveLocalUrl(second)!)).toBe(false);
    site.db.close();
  });

  it('keeps exactly one uploaded profile photo and banner, replacing the old file', () => {
    const site = makeSite('prof');
    const write = (name: string, jpeg: Buffer) => {
      const file = path.join(tempRoot, name);
      fs.writeFileSync(file, jpeg);
      return file;
    };
    const firstAvatar = setProfileImageFromFile(site.db, site.library, 'avatar', write('a1.jpg', makePhoneJpeg(1600, 1200, 6, 1)));
    expect(firstAvatar).toMatch(/^media\/profile\/avatar-[0-9a-f]{20}\.jpg$/);
    const firstFile = site.library.resolveLocalUrl(firstAvatar)!;
    const decoded = jpegJs.decode(fs.readFileSync(firstFile));
    expect([decoded.width, decoded.height]).toEqual([600, 800]); // upright (orientation 6), fits 800
    expect(fs.readFileSync(firstFile).includes(Buffer.from('GPS-SECRET'))).toBe(false);

    const banner = setProfileImageFromFile(site.db, site.library, 'banner', write('b.jpg', makePhoneJpeg(3000, 1000, 1, 3)));
    const avatar = setProfileImageFromFile(site.db, site.library, 'avatar', write('a2.jpg', makePhoneJpeg(1600, 1200, 1, 2)));
    expect(avatar).not.toBe(firstAvatar);
    expect(fs.existsSync(firstFile)).toBe(false); // the old upload is gone
    expect(site.db.getProfile()).toMatchObject({ avatarUrl: avatar, bannerUrl: banner });
    expect(fs.readdirSync(path.join(site.dir, 'media-store', 'profile'))).toHaveLength(2);

    const out = path.join(tempRoot, 'out');
    site.generator.generateToDirectory(out);
    expect(fs.existsSync(path.join(out, avatar))).toBe(true);
    expect(fs.existsSync(path.join(out, banner))).toBe(true);

    // Switching to an album photo removes the uploaded file; the photo stays while it's in use
    const album = site.db.createAlbum({ title: 'Me' });
    const report = importPhotosIntoAlbum(site.db, site.library, album.id, [write('me.jpg', makePhoneJpeg(900, 900, 1, 4))]);
    const photo = site.db.getAlbums()[0].photos[0];
    site.db.updateProfile({ avatarUrl: photo.thumbUrl });
    cleanUpLibrary(site.db, site.library);
    expect(fs.existsSync(site.library.resolveLocalUrl(avatar)!)).toBe(false);
    deletePhotoWithFiles(site.db, site.library, report.added[0]);
    expect(fs.existsSync(site.library.resolveLocalUrl(photo.thumbUrl)!)).toBe(true);
    site.db.close();
  });

  it('publishes upright, resized, metadata-free copies and keeps the original locally', () => {
    const source = path.join(tempRoot, 'phone.jpg');
    fs.writeFileSync(source, makePhoneJpeg(3000, 1000, 6));
    expect(readJpegOrientation(fs.readFileSync(source))).toBe(6);

    const library = new MediaLibrary(path.join(tempRoot, 'store'));
    const media = library.importPhoto(source, 'album-1');
    // Orientation 6 = rotate 90°, so a 3000x1000 landscape becomes portrait, then fits 2048
    expect([media.width, media.height]).toEqual([683, 2048]);
    expect(Math.max(media.thumbWidth, media.thumbHeight)).toBe(480);
    const web = fs.readFileSync(library.resolveLocalUrl(media.url)!);
    expect(web.includes(Buffer.from('GPS-SECRET'))).toBe(false);
    expect(web.includes(Buffer.from('Exif'))).toBe(false);
    expect(sha256Hex(web)).toBe(media.sha256);
    expect(media.url).toBe(`media/albums/album-1/${media.sha256.slice(0, 20)}.jpg`);
    expect(fs.readFileSync(media.originalPath).equals(fs.readFileSync(source))).toBe(true);

    // PNG keeps transparency
    const png = new PNG({ width: 4, height: 4 });
    png.data.fill(0);
    const pngPath = path.join(tempRoot, 'logo.png');
    fs.writeFileSync(pngPath, PNG.sync.write(png));
    const pngMedia = library.importPhoto(pngPath, 'album-1');
    expect(pngMedia.mimeType).toBe('image/png');
    expect(PNG.sync.read(fs.readFileSync(library.resolveLocalUrl(pngMedia.url)!)).data[3]).toBe(0);

    // Other formats are refused with a clear message, and paths can't escape the library
    const gif = path.join(tempRoot, 'anim.gif');
    fs.writeFileSync(gif, 'GIF89a....');
    expect(() => library.importPhoto(gif, 'album-1')).toThrow(UnsupportedImageError);
    expect(library.resolveLocalUrl('media/../../etc/passwd')).toBeNull();
  });

  it('exports albums with signed manifests and reflects replaced and removed photos', () => {
    const site = makeSite('alice');
    const album = site.db.createAlbum({ title: 'Trip' });
    const files = [0, 1].map((n) => {
      const f = path.join(tempRoot, `p${n}.jpg`);
      fs.writeFileSync(f, makePhoneJpeg(64, 48, 1, n * 50));
      return f;
    });
    const report = importPhotosIntoAlbum(site.db, site.library, album.id, files);
    expect(report.added).toHaveLength(2);

    const out = path.join(tempRoot, 'export');
    fs.mkdirSync(path.join(out, 'media/albums/old'), { recursive: true });
    fs.writeFileSync(path.join(out, 'README.md'), 'mine'); // not Studio's: must survive
    fs.writeFileSync(path.join(out, 'media/albums/old/stale.jpg'), 'old'); // Studio's old photo area
    expect(site.publisher.publishToLocalDirectory(out).success).toBe(true);

    const manifestPath = path.join(out, `media/albums/${album.id}/manifest.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const didDoc = JSON.parse(fs.readFileSync(path.join(out, '.well-known/did.json'), 'utf8'));
    expect(verifyDocumentSignature(manifest, didDoc.verificationMethod[0].publicKeyPem)).toBe(true);
    expect(manifest.photos).toHaveLength(2);
    for (const photo of manifest.photos) {
      expect(sha256Hex(fs.readFileSync(path.join(out, photo.image.url)))).toBe(photo.image.sha256);
      expect(sha256Hex(fs.readFileSync(path.join(out, photo.thumbnail.url)))).toBe(photo.thumbnail.sha256);
    }
    const albumsDoc = JSON.parse(fs.readFileSync(path.join(out, 'api/albums.json'), 'utf8'));
    expect(albumsDoc.albums[0].manifestUrl).toBe(`media/albums/${album.id}/manifest.json`);
    expect(fs.existsSync(path.join(out, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'media/albums/old/stale.jpg'))).toBe(false);

    // Replace the first photo's image: new file published, old one gone, same photo id
    const [first, second] = manifest.photos;
    const replacement = path.join(tempRoot, 'new.jpg');
    fs.writeFileSync(replacement, makePhoneJpeg(64, 48, 1, 200));
    replacePhotoImage(site.db, site.library, first.id, replacement);
    site.publisher.publishToLocalDirectory(out);
    const afterReplace = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const replaced = afterReplace.photos.find((p: { id: string }) => p.id === first.id);
    expect(replaced.image.sha256).not.toBe(first.image.sha256);
    expect(fs.existsSync(path.join(out, first.image.url))).toBe(false);
    expect(fs.existsSync(path.join(out, replaced.image.url))).toBe(true);
    expect(site.library.resolveLocalUrl(first.image.url) && fs.existsSync(site.library.resolveLocalUrl(first.image.url)!)).toBe(false);

    // Remove the second photo
    deletePhotoWithFiles(site.db, site.library, second.id);
    site.publisher.publishToLocalDirectory(out);
    const afterDelete = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(afterDelete.photos.map((p: { id: string }) => p.id)).toEqual([first.id]);
    expect(fs.existsSync(path.join(out, second.image.url))).toBe(false);
    expect(fs.existsSync(path.join(out, 'README.md'))).toBe(true);
    site.db.close();
  });

  it('uploads only changes to a remote folder and deletes only files Studio published', async () => {
    const site = makeSite('bob');
    const album = site.db.createAlbum({ title: 'Remote' });
    const photoFile = path.join(tempRoot, 'r.jpg');
    fs.writeFileSync(photoFile, makePhoneJpeg(40, 30, 1));
    importPhotosIntoAlbum(site.db, site.library, album.id, [photoFile]);

    const remote = new Map<string, Buffer>([['notes/keep.txt', Buffer.from('user file')]]);
    const uploads: string[] = [];
    const target = {
      upload: async (localFile: string, relPath: string) => {
        uploads.push(relPath);
        remote.set(relPath, fs.readFileSync(localFile));
      },
      remove: async (relPath: string) => {
        remote.delete(relPath);
      },
    };
    const publishOnce = async () => {
      const staging = fs.mkdtempSync(path.join(tempRoot, 'stage-'));
      site.generator.generateToDirectory(staging);
      const files = hashStagedFiles(staging);
      const owned = [...remote.keys()];
      const plan = planSync(files, site.db.getPublishLedger('ftp://test'), owned);
      return applySyncPlan(site.db, 'ftp://test', staging, plan, target);
    };

    const first = await publishOnce();
    expect(first.removed).toBe(0);
    const photoPaths = [...remote.keys()].filter((p) => p.endsWith('.jpg'));
    expect(photoPaths).toHaveLength(2); // web copy + thumbnail
    // Media goes up before the pages that reference it
    expect(uploads.findIndex((p) => p.endsWith('.jpg'))).toBeLessThan(uploads.indexOf('index.html'));

    uploads.length = 0;
    await publishOnce();
    expect(uploads.filter((p) => p.endsWith('.jpg'))).toEqual([]); // unchanged photos not re-sent

    const photoId = site.db.getAlbums()[0].photos[0].id;
    deletePhotoWithFiles(site.db, site.library, photoId);
    const third = await publishOnce();
    expect(third.removed).toBeGreaterThanOrEqual(2);
    expect([...remote.keys()].some((p) => p.endsWith('.jpg'))).toBe(false);
    expect(remote.has('notes/keep.txt')).toBe(true);
    site.db.close();
  });

  it('pushes only changed files to GitHub and removes deleted photos from the branch', async () => {
    // A tiny in-memory GitHub: refs, commits, flat trees and blobs
    const blobs = new Map<string, Buffer>();
    const trees = new Map<string, Map<string, string>>();
    const commits = new Map<string, { tree: string }>();
    const refs = new Map<string, string>();
    let counter = 0;
    const newId = () => `id${++counter}`;
    const readme = Buffer.from('# my repo');
    const readmeSha = gitBlobSha(readme);
    blobs.set(readmeSha, readme);
    trees.set('t0', new Map([['README.md', readmeSha]]));
    commits.set('c0', { tree: 't0' });
    refs.set('gh-pages', 'c0');
    const blobPosts: string[] = [];
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
      const route = new URL(url).pathname.replace('/repos/o/r', '');
      const method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(init.body) : {};
      if (route === '' && method === 'GET') return json(200, { default_branch: 'main', permissions: { push: true } });
      if (route.startsWith('/git/ref/heads/')) {
        const sha = refs.get(decodeURIComponent(route.slice('/git/ref/heads/'.length)));
        return sha ? json(200, { object: { sha } }) : json(404, {});
      }
      if (route.startsWith('/git/commits/') && method === 'GET') {
        return json(200, { tree: { sha: commits.get(route.slice('/git/commits/'.length))!.tree } });
      }
      if (route.startsWith('/git/trees/') && method === 'GET') {
        const tree = trees.get(route.slice('/git/trees/'.length))!;
        return json(200, { truncated: false, tree: [...tree].map(([p, sha]) => ({ path: p, type: 'blob', sha })) });
      }
      if (route === '/git/blobs') {
        const content = Buffer.from(body.content, 'base64');
        const sha = gitBlobSha(content);
        blobs.set(sha, content);
        blobPosts.push(sha);
        return json(201, { sha });
      }
      if (route === '/git/trees') {
        const tree = new Map(trees.get(body.base_tree)!);
        for (const entry of body.tree) {
          if (entry.sha === null) tree.delete(entry.path);
          else tree.set(entry.path, entry.sha);
        }
        const id = newId();
        trees.set(id, tree);
        return json(201, { sha: id });
      }
      if (route === '/git/commits') {
        const id = newId();
        commits.set(id, { tree: body.tree });
        return json(201, { sha: id });
      }
      if (route.startsWith('/git/refs/heads/')) {
        refs.set(decodeURIComponent(route.slice('/git/refs/heads/'.length)), body.sha);
        return json(200, {});
      }
      if (route === '/pages') return json(409, {});
      return json(404, { message: `unhandled ${method} ${route}` });
    });
    const branchFiles = () => trees.get(commits.get(refs.get('gh-pages')!)!.tree)!;

    const site = makeSite('carol');
    const settings = { ...site.db.getProfile().publishSettings, githubOwner: 'o', githubRepo: 'r', githubBranch: 'gh-pages', githubToken: 'tok' };
    const album = site.db.createAlbum({ title: 'GH' });
    const f = path.join(tempRoot, 'g.jpg');
    fs.writeFileSync(f, makePhoneJpeg(40, 30, 1));
    importPhotosIntoAlbum(site.db, site.library, album.id, [f]);
    const photo = site.db.getAlbums()[0].photos[0];

    const first = await site.publisher.publishToGitHubPages(settings, fs.mkdtempSync(path.join(tempRoot, 'gh-')));
    expect(first.success).toBe(true);
    expect(branchFiles().has(photo.url)).toBe(true);
    expect(branchFiles().has(photo.thumbUrl)).toBe(true);
    expect(branchFiles().has(`media/albums/${album.id}/manifest.json`)).toBe(true);
    expect(branchFiles().has('README.md')).toBe(true);

    blobPosts.length = 0;
    const second = await site.publisher.publishToGitHubPages(settings, fs.mkdtempSync(path.join(tempRoot, 'gh-')));
    expect(second.success).toBe(true);
    const photoBlob = gitBlobSha(fs.readFileSync(site.library.resolveLocalUrl(photo.url)!));
    expect(blobPosts).not.toContain(photoBlob); // unchanged photo not uploaded again

    deletePhotoWithFiles(site.db, site.library, photo.id);
    const third = await site.publisher.publishToGitHubPages(settings, fs.mkdtempSync(path.join(tempRoot, 'gh-')));
    expect(third.success).toBe(true);
    expect(third.removed).toBeGreaterThanOrEqual(2);
    expect(branchFiles().has(photo.url)).toBe(false);
    expect(branchFiles().has(photo.thumbUrl)).toBe(false);
    expect(branchFiles().has('README.md')).toBe(true);
    site.db.close();
  });

  it('upgrades photos imported before the Media Library, once', () => {
    const site = makeSite('dave');
    const album = site.db.createAlbum({ title: 'Old' });
    const legacyDir = path.join(site.library.rootDir, 'albums', album.id);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'photo-123.jpg'), makePhoneJpeg(100, 80, 1));
    site.db.addPhotoToAlbum({ albumId: album.id, url: `media/albums/${album.id}/photo-123.jpg` });

    expect(optimizeLegacyPhotos(site.db, site.library)).toBe(1);
    const photo = site.db.getAlbums()[0].photos[0];
    expect(photo.sha256).toBeTruthy();
    expect(photo.url).not.toContain('photo-123');
    expect(fs.existsSync(path.join(legacyDir, 'photo-123.jpg'))).toBe(false);
    expect(optimizeLegacyPhotos(site.db, site.library)).toBe(0);
    site.db.close();
  });

  it('lets friends see replaced and removed photos when they sync', async () => {
    const owner = makeSite('erin');
    const album = owner.db.createAlbum({ title: 'Shared' });
    const files = [0, 1].map((n) => {
      const f = path.join(tempRoot, `s${n}.jpg`);
      fs.writeFileSync(f, makePhoneJpeg(32, 32, 1, n * 70));
      return f;
    });
    importPhotosIntoAlbum(owner.db, owner.library, album.id, files);
    const out = path.join(tempRoot, 'erin-site');
    owner.publisher.publishToLocalDirectory(out);

    const friend = makeSite('frank');
    const crawler = new RingCrawler(friend.db);
    await crawler.crawlFriendSite('https://erin.example', out);
    const [keep, drop] = owner.db.getAlbums()[0].photos;
    expect(friend.db.getNetworkFeed().filter((e) => e.entryType === 'photo')).toHaveLength(2);

    const replacement = path.join(tempRoot, 'swap.jpg');
    fs.writeFileSync(replacement, makePhoneJpeg(32, 32, 1, 222));
    replacePhotoImage(owner.db, owner.library, keep.id, replacement);
    deletePhotoWithFiles(owner.db, owner.library, drop.id);
    owner.publisher.publishToLocalDirectory(out);
    await crawler.crawlFriendSite('https://erin.example', out);

    const photos = friend.db.getNetworkFeed().filter((e) => e.entryType === 'photo');
    expect(photos).toHaveLength(1);
    expect(photos[0].canonicalUrl).toBe(keep.canonicalUrl);
    expect(photos[0].mediaUrl).toContain(owner.db.getAlbums()[0].photos[0].sha256!.slice(0, 20));
    owner.db.close();
    friend.db.close();
  });
});

describe('History window: published archives, feed window, conditional sync, saved posts', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-history-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const DAY = 86400000;
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
  /** Moves an item (or a feed row) back in time; tests only. */
  const raw = (db: StudioDatabase) => (db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
  const backdate = (db: StudioDatabase, id: string, iso: string) => raw(db).prepare('UPDATE items SET created_at = ? WHERE id = ?').run(iso, id);

  /** Alice with 70 posts: 40 from the last 40 days and 30 from 100–390 days ago. */
  const makeAlice = () => {
    const dir = path.join(tempRoot, 'alice');
    const db = new StudioDatabase(dir, 'alice.sqlite');
    db.updateProfile({ siteUrl: 'https://alice.ring.test', displayName: 'Alice' });
    const posts: Array<{ id: string; canonicalUrl: string; createdAt: string }> = [];
    for (let i = 0; i < 70; i++) {
      const post = db.createItem({ type: 'post', commentary: `Post number ${i} <b>bold?</b>` });
      const createdAt = i < 40 ? daysAgo(i) : daysAgo(100 + (i - 40) * 10);
      backdate(db, post.id, createdAt);
      posts.push({ id: post.id, canonicalUrl: post.canonicalUrl, createdAt });
    }
    return { db, dir, posts };
  };

  it('publishes recent items in items.json and older ones in signed, stable monthly archives', () => {
    const { db, dir } = makeAlice();
    const out = path.join(dir, 'out');
    new StaticSiteGenerator(db).generateToDirectory(out);
    const didDoc = JSON.parse(fs.readFileSync(path.join(out, '.well-known/did.json'), 'utf8'));
    const key = didDoc.verificationMethod[0].publicKeyPem;
    const items = JSON.parse(fs.readFileSync(path.join(out, 'api/items.json'), 'utf8'));
    expect(verifyDocumentSignature(items, key)).toBe(true);
    expect(items.items).toHaveLength(50); // 40 within 90 days, topped up to the 50 newest
    expect(items.archive.since).toBe(items.items[49].createdAt);
    const months = items.archive.months as Array<{ month: string; url: string; count: number }>;
    expect(months.reduce((n, m) => n + m.count, 0)).toBe(20);
    const archived: string[] = [];
    for (const m of months) {
      expect(m.url).toBe(`/api/archive/items-${m.month}.json`);
      const doc = JSON.parse(fs.readFileSync(path.join(out, m.url), 'utf8'));
      expect(verifyDocumentSignature(doc, key)).toBe(true);
      expect(doc.items.every((i: { createdAt: string }) => i.createdAt.startsWith(m.month))).toBe(true);
      archived.push(...doc.items.map((i: { id: string }) => i.id));
    }
    expect(new Set([...items.items.map((i: { id: string }) => i.id), ...archived]).size).toBe(70);

    // Unchanged months are byte-identical on the next publish (no re-upload); Studio still sees all 70
    const before = months.map((m) => fs.readFileSync(path.join(out, m.url), 'utf8'));
    new StaticSiteGenerator(db).generateToDirectory(out);
    expect(months.map((m) => fs.readFileSync(path.join(out, m.url), 'utf8'))).toEqual(before);
    expect(db.buildSignedSiteBundle().items.items).toHaveLength(70);
    expect(db.buildSignedSiteBundle().archives).toBeUndefined();
    db.close();
  });

  it('shows Older posts on the page and loads a month in the page layout', async () => {
    const { db } = makeAlice();
    for (const theme of ['neo-webring', 'xtraspecial'] as ProfileTheme[]) {
      db.updateProfile({ theme });
      const generator = new StaticSiteGenerator(db);
      const bundle = db.buildSignedSiteBundle({ publish: true });
      expect(generator.buildStandaloneProfileHtml(bundle)).not.toContain('window.__WEBRING_ARCHIVES__ ='); // fetched, not embedded
      const preview = generator.buildStandaloneProfileHtml(bundle, { preview: true });
      expect(preview).toContain('window.__WEBRING_ARCHIVES__ =');

      // A small DOM stand-in that can click a month button
      const scripts = [...preview.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      const appended: Array<{ innerHTML: string }> = [];
      const listeners: Array<(ev: unknown) => unknown> = [];
      const root = {
        innerHTML: '',
        addEventListener: (_type: string, fn: (ev: unknown) => unknown) => listeners.push(fn),
        querySelectorAll: () => [],
        querySelector: (sel: string) => (sel === '[data-archive-list]' ? { appendChild: (el: { innerHTML: string }) => appended.push(el) } : null),
      };
      const windowStub: Record<string, unknown> = { location: { protocol: 'file:' } };
      const context = vm.createContext({
        window: windowStub,
        document: {
          body: { className: '', setAttribute: () => undefined, removeAttribute: () => undefined, style: { setProperty: () => undefined } },
          getElementById: (id: string) => (id === 'profile-root' ? root : null),
          addEventListener: () => undefined,
          createElement: () => ({ setAttribute: () => undefined, className: '', innerHTML: '' }),
        },
        URLSearchParams,
        console,
        setTimeout,
        parent: { postMessage: () => undefined },
      });
      for (const code of scripts) vm.runInContext(code, context);
      await new Promise((r) => setTimeout(r, 20));
      expect(root.innerHTML).toContain('Older posts');
      const month = bundle.items.archive!.months[0];
      expect(root.innerHTML).toContain(`data-archive-url="${month.url}"`);
      const button = {
        disabled: false,
        classList: { add: () => undefined },
        setAttribute: () => undefined,
        getAttribute: (name: string) => (name === 'data-archive-url' ? month.url : 'That month'),
      };
      for (const fn of listeners) {
        await fn({ target: { closest: (sel: string) => (sel === '[data-archive-url]' ? button : null) } });
      }
      expect(appended).toHaveLength(1);
      expect(appended[0].innerHTML).toContain('That month');
      expect(appended[0].innerHTML).toContain('Post number');
      expect(appended[0].innerHTML).not.toContain('<b>bold?</b>');
      expect(appended[0].innerHTML).toContain(theme === 'xtraspecial' ? 'tw-row' : 'card-surface');
    }
    db.close();
  });

  it('keeps a friend\'s archived posts and old comments, and still prunes deletions inside their window', async () => {
    const alice = makeAlice();
    const out = path.join(alice.dir, 'out');
    new StaticSiteGenerator(alice.db).generateToDirectory(out);
    const bobDb = new StudioDatabase(path.join(tempRoot, 'bob'), 'bob.sqlite');
    bobDb.updateProfile({ siteUrl: 'https://bob.ring.test', displayName: 'Bob' });
    bobDb.setFeedRetentionDays(0);

    // Bob's feed already had an archived Alice post, a since-deleted recent one, and an old comment of hers on his post
    const archivedPost = alice.posts[69];
    const feedRow = (canonicalUrl: string, createdAt: string) => ({
      friendSiteUrl: 'https://alice.ring.test', friendName: 'Alice', friendAvatarUrl: '', friendDid: 'did:web:alice.ring.test',
      entryType: 'post' as const, title: 't', canonicalUrl, targetUrl: canonicalUrl, commentary: '', mediaUrl: '', tags: [],
      createdAt, verifiedSignature: true,
    });
    bobDb.upsertNetworkFeedEntry(feedRow(archivedPost.canonicalUrl, archivedPost.createdAt));
    bobDb.upsertNetworkFeedEntry(feedRow('https://alice.ring.test/api/items.json#item-item-gone', daysAgo(1)));
    bobDb.upsertEndorsement({
      targetCanonicalUrl: 'https://bob.ring.test/api/items.json#item-item-x', authorSiteUrl: 'https://alice.ring.test', authorName: 'Alice',
      authorAvatarUrl: '', type: 'comment', commentary: 'Nice!', sourceItemUrl: 'https://alice.ring.test/api/items.json#item-item-oldcomment',
      createdAt: daysAgo(300), verifiedSignature: true,
    });

    const result = await new RingCrawler(bobDb).crawlFriendSite('https://alice.ring.test', out);
    expect(result.verifiedSignature).toBe(true);
    const feedUrls = bobDb.getNetworkFeed().map((f) => f.canonicalUrl);
    expect(feedUrls).toContain(archivedPost.canonicalUrl);
    expect(feedUrls).not.toContain('https://alice.ring.test/api/items.json#item-item-gone');
    expect(bobDb.getEndorsements().some((e) => e.sourceItemUrl.endsWith('item-oldcomment'))).toBe(true);
    alice.db.close();
    bobDb.close();
  });

  it('keeps the feed to the chosen window, without touching saved posts or endorsements', async () => {
    const alice = makeAlice();
    const out = path.join(alice.dir, 'out');
    new StaticSiteGenerator(alice.db).generateToDirectory(out);
    const bobDir = path.join(tempRoot, 'bob');
    const bobDb = new StudioDatabase(bobDir, 'bob.sqlite');
    bobDb.updateProfile({ siteUrl: 'https://bob.ring.test', displayName: 'Bob' });
    expect(bobDb.getFeedRetentionDays()).toBe(90);

    await new RingCrawler(bobDb).crawlFriendSite('https://alice.ring.test', out);
    expect(bobDb.getNetworkFeed()).toHaveLength(40); // the 10 older posts in items.json are outside 90 days

    const library = new MediaLibrary(path.join(bobDir, 'media-store'));
    const keep = bobDb.getNetworkFeed().find((f) => f.createdAt < daysAgo(20))!;
    const saved = await savePost(bobDb, library, keep.canonicalUrl, { note: 'try this' });
    bobDb.setFetchValidators('https://alice.ring.test/api/items.json', 'https://alice.ring.test', { etag: '"v1"' });

    expect(bobDb.setFeedRetentionDays(7).pruned).toBe(33); // days 7–39
    expect(bobDb.getNetworkFeed().every((f) => f.createdAt >= daysAgo(7))).toBe(true);
    expect(bobDb.getSavedPosts()).toMatchObject([{ id: saved.id, note: 'try this', canonicalUrl: keep.canonicalUrl }]);
    expect(bobDb.getFetchValidators('https://alice.ring.test/api/items.json')).not.toBeNull(); // narrowing keeps the cache
    bobDb.setFeedRetentionDays(30);
    expect(bobDb.getFetchValidators('https://alice.ring.test/api/items.json')).toBeNull(); // widening downloads again
    alice.db.close();
    bobDb.close();
  });

  it('skips unchanged files using ETag / Last-Modified, and only remembers verified ones', async () => {
    const alice = makeAlice();
    const out = path.join(alice.dir, 'out');
    new StaticSiteGenerator(alice.db).generateToDirectory(out);
    const bobDb = new StudioDatabase(path.join(tempRoot, 'bob'), 'bob.sqlite');
    bobDb.updateProfile({ siteUrl: 'https://bob.ring.test', displayName: 'Bob' });
    const fileFor = (url: string) => path.join(out, new URL(url).pathname);
    const plain = async (url: string) => JSON.parse(fs.readFileSync(fileFor(url), 'utf8'));
    const sent: Array<{ url: string; validators: unknown }> = [];
    const conditional = async (url: string, validators: { etag: string; lastModified: string } | null) => {
      sent.push({ url, validators });
      if (validators?.etag === `"${path.basename(url)}"`) return { notModified: true as const };
      return { json: await plain(url), etag: `"${path.basename(url)}"`, lastModified: 'Mon, 26 Oct 2026 10:00:00 GMT' };
    };
    const crawler = new RingCrawler(bobDb, plain, conditional);

    const first = await crawler.crawlFriendSite('https://alice.ring.test');
    expect(first.success).toBe(true);
    expect(first.unchanged).toBeUndefined();
    expect(sent.every((s) => s.validators === null)).toBe(true);
    const feedSize = bobDb.getNetworkFeed().length;

    sent.length = 0;
    const second = await crawler.crawlFriendSite('https://alice.ring.test');
    expect(second.unchanged).toEqual(['/api/albums.json', '/api/items.json']);
    expect(sent.find((s) => s.url.endsWith('/api/items.json'))!.validators).toEqual({
      etag: '"items.json"',
      lastModified: 'Mon, 26 Oct 2026 10:00:00 GMT',
    });
    expect(bobDb.getNetworkFeed()).toHaveLength(feedSize); // nothing reprocessed or pruned
    alice.db.close();
    bobDb.close();
  });

  it('saves a private copy of a friend\'s post with its image, never published, removed on unsave', async () => {
    const bobDir = path.join(tempRoot, 'bob');
    const bobDb = new StudioDatabase(bobDir, 'bob.sqlite');
    bobDb.updateProfile({ siteUrl: 'https://bob.ring.test', displayName: 'Bob' });
    const library = new MediaLibrary(path.join(bobDir, 'media-store'));
    const url = 'https://alice.ring.test/api/items.json#item-item-recipe';
    bobDb.upsertNetworkFeedEntry({
      friendSiteUrl: 'https://alice.ring.test', friendName: 'Alice', friendAvatarUrl: '', friendDid: 'did:web:alice.ring.test',
      entryType: 'post', title: 'Pancakes', canonicalUrl: url, targetUrl: url, commentary: '## Recipe\n\n- flour', tags: ['food'],
      mediaUrl: 'https://alice.ring.test/media/pancakes.jpg', createdAt: daysAgo(3), verifiedSignature: true,
    });
    const pixels = Buffer.alloc(64 * 48 * 4, 200);
    const jpeg = jpegJs.encode({ data: pixels, width: 64, height: 48 }, 90).data;
    const fetched: string[] = [];
    const saved = await savePost(bobDb, library, url, {
      fetchImage: async (u) => {
        fetched.push(u);
        return { body: Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xfe, 0, 12]), Buffer.from('GPS-SECRET'), jpeg.subarray(2)]), contentType: 'image/jpeg' };
      },
    });
    expect(fetched).toEqual(['https://alice.ring.test/media/pancakes.jpg']);
    expect(saved).toMatchObject({ title: 'Pancakes', commentary: '## Recipe\n\n- flour', tags: ['food'], verifiedSignature: true });
    expect(saved.localMediaUrl).toMatch(/^media\/saved\/[0-9a-f]{20}\.jpg$/);
    const file = library.resolveLocalUrl(saved.localMediaUrl)!;
    expect(fs.readFileSync(file).includes(Buffer.from('GPS-SECRET'))).toBe(false);
    expect((await savePost(bobDb, library, url)).id).toBe(saved.id); // saving twice keeps one copy

    // Survives the friend leaving the feed and library clean-up; never published
    raw(bobDb).prepare('DELETE FROM network_feed').run();
    cleanUpLibrary(bobDb, library);
    expect(fs.existsSync(file)).toBe(true);
    expect(bobDb.getLocalMediaReferences().urls.has(saved.localMediaUrl)).toBe(false);
    const out = path.join(bobDir, 'out');
    new StaticSiteGenerator(bobDb, path.join(bobDir, 'media-store')).generateToDirectory(out);
    expect(fs.existsSync(path.join(out, saved.localMediaUrl))).toBe(false);
    expect(fs.readFileSync(path.join(out, 'api/items.json'), 'utf8')).not.toContain('Pancakes');

    unsavePost(bobDb, library, saved.id);
    expect(bobDb.getSavedPosts()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    // A failed image download still saves the post
    bobDb.upsertNetworkFeedEntry({
      friendSiteUrl: 'https://alice.ring.test', friendName: 'Alice', friendAvatarUrl: '', friendDid: '', entryType: 'photo', title: 'Gone',
      canonicalUrl: 'https://alice.ring.test/api/albums.json#photo-1', targetUrl: '', commentary: '', tags: [],
      mediaUrl: 'https://alice.ring.test/media/gone.jpg', createdAt: daysAgo(1), verifiedSignature: false,
    });
    const noImage = await savePost(bobDb, library, 'https://alice.ring.test/api/albums.json#photo-1', {
      fetchImage: async () => {
        throw new Error('404');
      },
    });
    expect(noImage.localMediaUrl).toBe('');
    bobDb.close();
  });
});

describe('Media Library references', () => {
  it('keeps and publishes post images and covers that live in the library', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-mediaref-'));
    try {
      const db = new StudioDatabase(tempRoot, 'r.sqlite');
      const mediaDir = path.join(tempRoot, 'media-store');
      const library = new MediaLibrary(mediaDir);
      const postImage = path.join(mediaDir, 'albums', 'wall-posts', 'post.jpg');
      fs.mkdirSync(path.dirname(postImage), { recursive: true });
      fs.writeFileSync(postImage, 'jpeg bytes');
      fs.writeFileSync(path.join(mediaDir, 'albums', 'wall-posts', 'orphan.jpg'), 'unused');
      db.createItem({ type: 'post', title: 'With image', commentary: '', mediaUrl: 'media/albums/wall-posts/post.jpg' });

      expect(cleanUpLibrary(db, library)).toBe(1); // only the orphan
      expect(fs.existsSync(postImage)).toBe(true);
      const out = path.join(tempRoot, 'out');
      new StaticSiteGenerator(db, mediaDir).generateToDirectory(out);
      expect(fs.existsSync(path.join(out, 'media/albums/wall-posts/post.jpg'))).toBe(true);
      db.close();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('Site Design (look & feel, page layout)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-design-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /** Runs the published page's scripts against a tiny fake DOM and returns what they render. */
  const renderPage = async (html: string) => {
    const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const root = { innerHTML: '', addEventListener: () => undefined, querySelectorAll: () => [] };
    const attrs = new Map<string, string>();
    const styles = new Map<string, string>();
    const body = {
      className: '',
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
      style: { setProperty: (k: string, v: string) => styles.set(k, v) },
    };
    const windowStub: Record<string, unknown> = { location: { protocol: 'file:' } };
    const context = vm.createContext({
      window: windowStub,
      document: {
        body,
        getElementById: (id: string) => (id === 'profile-root' ? root : null),
        addEventListener: () => undefined,
        createElement: () => ({ setAttribute: () => undefined }),
      },
      URLSearchParams,
      console,
      setTimeout,
      parent: { postMessage: () => undefined },
    });
    windowStub.document = (context as { document: unknown }).document;
    for (const code of scripts) {
      // `window.__WEBRING_BUNDLE__ = …` must land on the window stub
      vm.runInContext(code.replace(/^\s*window\./, 'window.'), context);
    }
    await new Promise((r) => setTimeout(r, 20)); // let the async page script finish
    return { html: root.innerHTML, attrs, styles };
  };

  const blockOrder = (html: string) => [...html.matchAll(/data-block="([a-z]+)"/g)].map((m) => m[1]);

  it('renders the default layout like the page did before layouts existed', async () => {
    const db = new StudioDatabase(tempRoot, 'd.sqlite');
    db.createAlbum({ title: 'Trips' });
    db.createItem({ type: 'post', title: 'Hello', commentary: '' });
    const page = await renderPage(new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle()));
    expect(blockOrder(page.html)).toEqual(['albums', 'items']); // no public friends, no guestbook configured
    expect(page.html).toContain('📸 Photo Albums');
    expect(page.html).toContain('✨ Shared Items &amp; Things I Like');
    db.close();
  });

  it('follows a custom layout: order, hidden blocks, titles, text with tables, unknown blocks dropped', async () => {
    const db = new StudioDatabase(tempRoot, 'c.sqlite');
    db.createItem({ type: 'post', title: 'My post', commentary: '' });
    db.createItem({ type: 'recommendation', title: 'A great book', commentary: '' });
    db.updateProfile({
      layout: [
        { id: 'intro', type: 'text', visible: true, title: 'About me', options: { markdown: '**Hi!**\n\n| Year | Event |\n|---|---|\n| 2026 | Joined |\n\n<script>alert(1)</script>' } },
        { id: 'future', type: 'hologram', visible: true, options: {} },
        { id: 'recs', type: 'items', visible: true, title: 'Recommendations', options: { kinds: ['recommendation'] } },
        { id: 'albums', type: 'albums', visible: false, options: { style: 'grid' } },
        { id: 'links', type: 'links', visible: true, title: '', options: { links: [{ label: 'Blog', url: 'https://blog.example' }, { label: 'Bad', url: 'javascript:alert(1)' }] } },
      ] as unknown as LayoutBlock[],
    });
    expect(db.getProfile().layout!.map((b) => b.id)).toEqual(['intro', 'recs', 'albums', 'links']);

    const page = await renderPage(new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle()));
    expect(blockOrder(page.html)).toEqual(['text', 'items', 'links']);
    expect(page.html).toContain('<h2 class="text-2xl font-bold mb-4 flex items-center gap-2">About me</h2>');
    expect(page.html).toContain('<table><thead><tr><th>Year</th><th>Event</th></tr></thead>');
    expect(page.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.html).not.toContain('<script>alert(1)');
    expect(page.html).toContain('A great book');
    expect(page.html).not.toContain('My post'); // only recommendations in that block
    expect(page.html).toContain('https://blog.example');
    expect(page.html).toContain('#blocked-unsafe-url');
    db.close();
  });

  it('signs appearance and layout into profile.json and applies the look & feel', async () => {
    const db = new StudioDatabase(tempRoot, 'a.sqlite');
    db.updateProfile({
      appearance: { accent: '#ff6600', font: 'serif', corners: 'sharp', avatarShape: 'circle', bannerHeight: 'nope' } as unknown as Appearance,
      layout: [],
    });
    const profile = db.getProfile();
    expect(profile.appearance).toEqual({ accent: '#ff6600', font: 'serif', corners: 'sharp', avatarShape: 'circle' });
    expect(profile.layout).toEqual([]);

    const out = path.join(tempRoot, 'out');
    new StaticSiteGenerator(db).generateToDirectory(out);
    const published = JSON.parse(fs.readFileSync(path.join(out, 'api/profile.json'), 'utf8'));
    const didDoc = JSON.parse(fs.readFileSync(path.join(out, '.well-known/did.json'), 'utf8'));
    expect(verifyDocumentSignature(published, didDoc.verificationMethod[0].publicKeyPem)).toBe(true);
    expect(published.appearance.accent).toBe('#ff6600');
    expect(published.layout).toEqual([]);

    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    expect(html).toMatch(/<body[^>]*data-font="serif"[^>]*data-corners="sharp"/);
    const page = await renderPage(html);
    expect(page.attrs.get('data-avatar')).toBe('circle');
    expect(page.styles.get('--accent')).toBe('#ff6600');
    expect(blockOrder(page.html)).toEqual([]); // an emptied layout stays empty
    db.close();
  });

  it('keeps preview-only extras out of the published page', () => {
    const db = new StudioDatabase(tempRoot, 'p.sqlite');
    const generator = new StaticSiteGenerator(db);
    const bundle = db.buildSignedSiteBundle();
    const published = generator.buildStandaloneProfileHtml(bundle);
    const preview = generator.buildStandaloneProfileHtml(bundle, { preview: true });
    for (const marker of ['<base href="studio-media://local/"', 'studio-media:', 'webring-preview-deeplink']) {
      expect(published).not.toContain(marker);
      expect(preview).toContain(marker);
    }
    db.close();
  });

  it('parses friends’ profiles leniently', () => {
    const parsed = ProfileDocumentSchema.parse({
      did: 'did:web:x.example',
      siteUrl: 'https://x.example',
      handle: 'x',
      displayName: 'X',
      updatedAt: new Date().toISOString(),
      appearance: { accent: 'red', font: 'comic-sans', corners: 'soft' },
      layout: [{ id: 'a', type: 'text', options: { markdown: 'hi' } }, { nonsense: true }, 'string'],
    });
    expect(parsed.appearance).toEqual({ corners: 'soft' });
    expect(parsed.layout!.map((b) => b.id)).toEqual(['a']);
    expect(parseLayout('not an array')).toEqual([]);
  });

  it('renders Markdown safely', () => {
    expect(renderMarkdown('[x](javascript:alert(1)) [y](data:text/html,hi) [z](//evil.example)')).not.toMatch(/href=/);
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(renderMarkdown('[site](https://a.example)')).toContain('<a href="https://a.example" target="_blank" rel="noopener noreferrer">site</a>');
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('# Title')).toBe('<h2>Title</h2>');
    // It must work as embedded, standalone source
    const standalone = new Function(`return ${renderMarkdown.toString()}`)() as (s: string) => string;
    expect(standalone('**b**')).toBe('<p><strong>b</strong></p>');
  });

  describe('social-style templates', () => {
    const XSS = '<img src=x onerror=alert(1)>';
    const setUp = (file: string, theme: ProfileTheme) => {
      const db = new StudioDatabase(tempRoot, file);
      const album = db.createAlbum({ title: 'Trips' });
      db.addPhotoToAlbum({ albumId: album.id, url: 'media/albums/a1/p.jpg' });
      db.createItem({ type: 'post', title: 'Hello world', commentary: XSS, mediaUrl: 'media/albums/wall-posts/x.jpg' });
      db.createItem({ type: 'recommendation', title: 'A great book', commentary: 'Read it' });
      db.updateProfile({
        theme,
        bio: XSS,
        layout: [
          { id: 'links', type: 'links', visible: true, title: 'Find me', options: { links: [{ label: 'Blog', url: 'https://blog.example' }] } },
          { id: 'albums', type: 'albums', visible: true, options: { style: 'grid' } },
          { id: 'items', type: 'items', visible: true, options: { kinds: ['post', 'recommendation'] } },
          { id: 'hidden', type: 'text', visible: false, options: { markdown: 'secret block' } },
        ],
      });
      return db;
    };
    const shellMarkers: Array<[ProfileTheme, string, string[]]> = [
      ['facepace', 'sidebar', ['fp-topbar', 'fp-post', 'data-region="aside"', '+ Add friend']],
      ['tweetdeck', 'deck', ['td-deck', 'data-region="column"', 'tw-row']],
      ['xtraspecial', 'rails', ['xs-left', 'xs-right', 'tw-row', 'data-region="nav"']],
      ['instapick', 'grid', ['ip-highlights', 'tpl-grid', 'tpl-tile']],
      ['tiktalk', 'reel', ['tt-reel', 'tt-card', 'tt-rail']],
    ];

    for (const [theme, shell, markers] of shellMarkers) {
      it(`renders ${theme} as the ${shell} arrangement, safely`, async () => {
        const db = setUp(`${theme}.sqlite`, theme);
        const html = new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle());
        expect(html).toMatch(new RegExp(`<body class="theme-${theme} shell-${shell}`));
        const page = await renderPage(html);
        expect(page.html).toContain(`data-shell="${shell}"`);
        for (const marker of markers) expect(page.html).toContain(marker);
        // Sidebar and deck show "links" first; the others place sidebar blocks after the main column
        const sideFirst = shell === 'sidebar' || shell === 'deck';
        expect(blockOrder(page.html)).toEqual(sideFirst ? ['links', 'albums', 'items'] : ['albums', 'items', 'links']);
        expect(page.html).toContain('Hello world');
        expect(page.html).toContain('A great book');
        expect(page.html).toContain('https://blog.example');
        expect(page.html).not.toContain('secret block');
        expect(page.html).not.toContain('<img src=x');
        expect(page.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        db.close();
      });
    }

    it('puts sidebar blocks in the sidebar and the rest in the main column', async () => {
      const db = setUp('regions.sqlite', 'facepace');
      const page = await renderPage(new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle()));
      const aside = page.html.slice(page.html.indexOf('data-region="aside"'), page.html.indexOf('data-region="main"'));
      expect(blockOrder(aside)).toEqual(['links']);
      expect(blockOrder(page.html.slice(page.html.indexOf('data-region="main"')))).toEqual(['albums', 'items']);
      db.close();
    });

    it('keeps the classic themes on the standard page', async () => {
      const db = setUp('classic.sqlite', 'minimal-zine');
      const page = await renderPage(new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle()));
      expect(page.html).not.toContain('data-shell=');
      expect(page.html).toContain('+ Add to Friend Ring');
      expect(blockOrder(page.html)).toEqual(['links', 'albums', 'items']);
      db.close();
    });

    it('falls back to Neo-Webring for an unknown theme, on the page and in a friend’s profile', async () => {
      const db = setUp('unknown.sqlite', 'tiktalk');
      const bundle = db.buildSignedSiteBundle();
      const odd = { ...bundle, profile: { ...bundle.profile, theme: 'hologram' as ProfileTheme } };
      const html = new StaticSiteGenerator(db).buildStandaloneProfileHtml(odd);
      expect(html).toContain('<body class="theme-neo-webring shell-stack');
      const page = await renderPage(html);
      expect(page.html).not.toContain('data-shell=');
      db.close();

      const parsed = ProfileDocumentSchema.parse({
        did: 'did:web:x.example',
        siteUrl: 'https://x.example',
        handle: 'x',
        displayName: 'X',
        updatedAt: new Date().toISOString(),
        theme: 'from-the-future',
      });
      expect(parsed.theme).toBe('neo-webring');
      expect(ProfileDocumentSchema.parse({ ...parsed, theme: 'instapick' }).theme).toBe('instapick');
    });

    it('marks photos and posts for the interactive viewer, and can leave the extras out', async () => {
      for (const theme of ['neo-webring', 'instapick', 'facepace'] as ProfileTheme[]) {
        const db = setUp(`viewer-${theme}.sqlite`, theme);
        const html = new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle());
        expect(html).toContain('function installPageEnhancements');
        const page = await renderPage(html); // no <dialog> in the harness: plain links stay
        const photo = db.getAlbums()[0].photos[0];
        expect(page.html).toContain(`data-lightbox data-photo-id="${photo.id}"`);
        expect(page.html).toMatch(/data-open-post="[^"]+"/);
        expect(page.html).not.toContain('Untitled Photo');
        db.close();
      }
      const db = setUp('viewer-off.sqlite', 'neo-webring');
      db.updateProfile({ appearance: { interactions: 'off' } });
      expect(db.getProfile().appearance).toEqual({ interactions: 'off' });
      const html = new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle());
      expect(html).not.toContain('function installPageEnhancements');
      expect(html).not.toContain('.wr-dialog');
      expect((await renderPage(html)).html).toContain('Hello world');
      db.close();
    });

    it('renders album descriptions as safe Markdown in every arrangement', async () => {
      for (const theme of ['neo-webring', 'facepace', 'instapick'] as ProfileTheme[]) {
        const db = new StudioDatabase(tempRoot, `album-md-${theme}.sqlite`);
        const album = db.createAlbum({
          title: 'Trip',
          description: '## Day one\n\nWe saw [the lake](https://lake.example) and:\n\n- hills\n- birds\n\n<script>alert(1)</script> [bad](javascript:alert(1))',
        });
        db.addPhotoToAlbum({ albumId: album.id, url: 'media/albums/a1/p.jpg' });
        db.updateProfile({ theme });
        const page = await renderPage(new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle()));
        expect(page.html).toContain('<h3>Day one</h3>');
        expect(page.html).toContain('<a href="https://lake.example" target="_blank" rel="noopener noreferrer">the lake</a>');
        expect(page.html).toContain('<ul><li>hills</li><li>birds</li></ul>');
        expect(page.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(page.html).not.toContain('<script>alert(1)');
        expect(page.html).not.toContain('javascript:alert');
        db.close();
      }
    });

    it('renders wall posts as safe Markdown, with plain-text titles and snippets', async () => {
      const body = '# Big news\n\nRead [the write-up](https://news.example) — it is **great**.\n\n- one\n- two\n\n<script>alert(1)</script> [x](javascript:alert(1))';
      for (const theme of ['neo-webring', 'xtraspecial', 'instapick'] as ProfileTheme[]) {
        const db = new StudioDatabase(tempRoot, `md-post-${theme}.sqlite`);
        db.updateProfile({ theme });
        const post = db.createItem({ type: 'post', commentary: body });
        expect(post.title).toBe('Big news');
        db.createItem({ type: 'like', title: 'A *starred* thing', targetUrl: 'https://thing.example', commentary: 'Plain **notes**' });
        const page = await renderPage(new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle()));
        expect(page.html).not.toContain('<script>alert(1)');
        expect(page.html).not.toContain('javascript:alert');
        if (theme === 'instapick') {
          // Tiles show a plain-text snippet
          expect(page.html).toContain('Read the write-up — it is great.');
        } else {
          // The heading is shown once, not repeated as a separate title
          expect(page.html).toContain('<h2>Big news</h2>');
          expect(page.html).not.toMatch(/<h4[^>]*>\s*<span>Big news<\/span>|<p class="font-bold">Big news<\/p>/);
          expect(page.html).toContain('<a href="https://news.example" target="_blank" rel="noopener noreferrer">the write-up</a>');
          expect(page.html).toContain('<ul><li>one</li><li>two</li></ul>');
          expect(page.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
          expect(page.html).toContain('Plain **notes**'); // only wall posts are Markdown
        }
        db.close();
      }
      expect(markdownToPlainText('> **Hello** [there](https://x.example)\n\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe('Hello there\n\n a b \n 1 2');
      const standalone = new Function(`return ${markdownToPlainText.toString()}`)() as (s: string) => string;
      expect(standalone('*hi*')).toBe('hi');
    });

    it('treats a post written before the site URL was set as the user\'s own post', async () => {
      const db = new StudioDatabase(tempRoot, 'placeholder.sqlite'); // starts on the placeholder URL
      const post = db.createItem({ type: 'post', title: 'Early post', commentary: 'Hi' });
      const like = db.createItem({ type: 'like', title: 'Elsewhere', targetUrl: 'https://other.example/x' });
      db.updateProfile({ siteUrl: 'https://me.example' });
      const items = db.getItems();
      const mine = items.find((i) => i.id === post.id)!;
      expect(mine.canonicalUrl).toBe(`https://me.example/api/items.json#item-${post.id}`);
      expect(mine.targetUrl).toBe(mine.canonicalUrl);
      expect(items.find((i) => i.id === like.id)!.targetUrl).toBe('https://other.example/x');
      const page = await renderPage(new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle()));
      expect(page.html).not.toContain('Early post ↗');
      db.close();
    });

    it('marks edited items on the page, in a classic theme and a template', async () => {
      for (const theme of ['neo-webring', 'facepace'] as ProfileTheme[]) {
        const db = new StudioDatabase(tempRoot, `edited-${theme}.sqlite`);
        db.updateProfile({ theme });
        db.createItem({ type: 'post', commentary: 'Untouched post' });
        const changed = db.createItem({ type: 'post', commentary: 'Old text' });
        db.updateItem(changed.id, { commentary: 'New <b>text</b>' });
        const page = await renderPage(new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle()));
        expect(page.html.match(/class="item-edited"/g)).toHaveLength(1);
        expect(page.html).toContain('New &lt;b&gt;text&lt;/b&gt;');
        expect(page.html).not.toContain('Old text');
        db.close();
      }
    });

    it('embeds interactive extras that run standalone', () => {
      const source = installPageEnhancements.toString();
      expect(source).not.toMatch(/<\/script/i);
      expect(typeof new Function(`return ${source}`)()).toBe('function');
    });

    it('embeds a template renderer that runs standalone', () => {
      const standalone = new Function(`return ${renderTemplatePage.toString()}`)();
      expect(typeof standalone).toBe('function');
      expect(renderTemplatePage.toString()).not.toMatch(/<\/script/i);
    });
  });
});
