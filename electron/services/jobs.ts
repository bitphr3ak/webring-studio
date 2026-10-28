import * as fs from 'fs';
import * as path from 'path';
import { ActivePersonaContext } from './personaManager';
import { PublishResult } from './publisher';
import { CrawlSiteResult } from './ringCrawler';
import { HostedRingSyncResult, JoinedRingSyncResult } from './ringService';
import { JobResult, PublishDestination } from './scheduler';

/**
 * Sync All and publishing for one persona context, shared by the Studio buttons, the MCP tools
 * and the scheduler so they all behave the same.
 */

export interface SyncAllResult {
  friends: CrawlSiteResult[];
  rings: { joined: JoinedRingSyncResult[]; hosted: HostedRingSyncResult[] };
}

export async function runSyncAll(ctx: ActivePersonaContext): Promise<SyncAllResult> {
  const friends = await ctx.ringCrawler.crawlAllFriends();
  const joined = await ctx.ringService.syncJoinedRings();
  const hosted = await ctx.ringService.syncHostedRings();
  return { friends, rings: { joined, hosted } };
}

export function summarizeSync(result: SyncAllResult): JobResult {
  const failedFriends = result.friends.filter((r) => !r.success && !r.blocked).length;
  const ringErrors = result.rings.joined.filter((r) => r.outcome === 'error').length;
  const parts = [`${result.friends.filter((r) => r.success).length}/${result.friends.length} friends synced`];
  if (result.rings.joined.length) parts.push(`${result.rings.joined.length} joined ring(s) checked`);
  const leavers = result.rings.hosted.reduce((acc, r) => acc + r.autoRemoved.length, 0);
  if (leavers) parts.push(`${leavers} member(s) left your rings`);
  if (failedFriends) parts.push(`${failedFriends} friend site(s) unreachable`);
  if (ringErrors) parts.push(`${ringErrors} ring(s) couldn't be checked`);
  return {
    at: new Date().toISOString(),
    // Some unreachable peers are normal; the job itself still worked
    status: 'ok',
    message: parts.join(', '),
  };
}

export interface PublishPaths {
  userDataDir: string;
  tempDir: string;
}

export function defaultExportPath(ctx: ActivePersonaContext, paths: PublishPaths): string {
  const profile = ctx.db.getProfile();
  const folder = ctx.persona.id === 'default' ? 'exported-profile-site' : `exported-profile-site-${ctx.persona.id}`;
  return profile.publishSettings?.exportPath || path.join(paths.userDataDir, folder);
}

/**
 * Publishes the persona's site to a destination using its saved settings. Refuses (without
 * publishing anything) when the destination isn't set up.
 */
export async function publishTo(
  ctx: ActivePersonaContext,
  destination: PublishDestination,
  paths: PublishPaths,
  overrides?: { targetDir?: string }
): Promise<PublishResult> {
  const masked = ctx.db.getProfile().publishSettings;
  if (destination === 'local') {
    const settings = masked;
    const outDir = overrides?.targetDir || defaultExportPath(ctx, paths);
    const result = ctx.sitePublisher.publishToLocalDirectory(outDir);
    if (result.success && settings.exportPath !== outDir) {
      ctx.db.updateProfile({ publishSettings: { exportPath: outDir } });
    }
    return result;
  }
  // Credentials are decrypted only here, right before connecting
  const settings = ctx.db.withStoredCredentials(masked);
  if (destination === 'remote') {
    if (!settings.host?.trim() || !settings.username?.trim()) {
      return {
        success: false,
        mode: settings.protocol,
        destination: '',
        filesPublished: 0,
        message: 'SFTP/FTP publishing needs a host and username. Set them in the Publish tab.',
      };
    }
    const stagingDir = path.join(paths.tempDir, `webring-studio-staging-${ctx.persona.id}`);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    return ctx.sitePublisher.publishToRemoteHost(settings, stagingDir);
  }
  const stagingDir = path.join(paths.tempDir, `webring-studio-github-staging-${ctx.persona.id}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  return ctx.sitePublisher.publishToGitHubPages(settings, stagingDir);
}

/**
 * The scheduled publish: optionally sync first, then publish only if the site would change.
 */
export async function runScheduledPublish(
  ctx: ActivePersonaContext,
  destination: PublishDestination,
  syncFirst: boolean,
  paths: PublishPaths
): Promise<JobResult> {
  if (syncFirst) {
    await runSyncAll(ctx);
  }
  const fingerprint = ctx.siteGenerator.contentFingerprint();
  if (fingerprint === ctx.db.getProfile().publishSettings.lastPublishedFingerprint) {
    return { at: new Date().toISOString(), status: 'skipped', message: 'No changes since the last publish.' };
  }
  const result = await publishTo(ctx, destination, paths);
  return {
    at: new Date().toISOString(),
    status: result.success ? 'ok' : 'failed',
    message: result.message,
  };
}
