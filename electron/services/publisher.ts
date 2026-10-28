import * as fs from 'fs';
import * as path from 'path';
import SftpClient from 'ssh2-sftp-client';
import * as ftp from 'basic-ftp';
import * as crypto from 'crypto';
import {
  applySyncPlan,
  describeOutcome,
  finishLocalExport,
  hashStagedFiles,
  planSync,
  STUDIO_OWNED_PREFIXES,
} from './publishSync';
import { PublishSettings } from '../db/database';
import { StaticSiteGenerator } from './siteGenerator';

export interface PublishResult {
  success: boolean;
  mode: 'local' | 'sftp' | 'ftp' | 'github-pages';
  destination: string;
  filesPublished: number;
  uploaded?: number;
  unchanged?: number;
  removed?: number;
  message: string;
}

/** Git's blob id for file contents: sha1("blob <size>\0" + content). */
export function gitBlobSha(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function missingNote(missing: string[]): string {
  return missing.length
    ? ` ${missing.length} photo file(s) are missing from the Media Library and weren't published.`
    : '';
}

export interface GitHubRepoCheckResult {
  success: boolean;
  defaultBranch?: string;
  branchExists?: boolean;
  canPush?: boolean;
  pagesEnabled?: boolean;
  pagesUrl?: string;
  message: string;
}

const GITHUB_API_BASE = 'https://api.github.com';

export class SitePublisher {
  constructor(private generator: StaticSiteGenerator) {}

  /**
   * Exports the generated static website and JSON schemas to a local folder.
   */
  public publishToLocalDirectory(targetDir: string): PublishResult {
    try {
      const result = this.generator.generateToDirectory(targetDir);
      const outcome = finishLocalExport(this.generator.database, targetDir, result.filesWritten);
      this.generator.recordPublished(result.bundle);
      return {
        success: true,
        mode: 'local',
        destination: result.outputDir,
        filesPublished: outcome.uploaded,
        ...outcome,
        message: `Exported to ${result.outputDir}: ${describeOutcome(outcome)}.${missingNote(result.missingMedia)}`,
      };
    } catch (err: unknown) {
      return {
        success: false,
        mode: 'local',
        destination: targetDir,
        filesPublished: 0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Generates the site to a staging folder and uploads what changed to the configured SFTP or
   * FTP folder, deleting files Studio published there before that are no longer part of the site.
   */
  public async publishToRemoteHost(
    settings: PublishSettings,
    stagingDir: string
  ): Promise<PublishResult> {
    const genResult = this.generator.generateToDirectory(stagingDir);
    const db = this.generator.database;
    const mode = settings.protocol === 'sftp' ? 'sftp' : 'ftp';
    const port = settings.port || (mode === 'sftp' ? 22 : 21);
    const root = (settings.remotePath || '/').replace(/\/+$/, '') || '';
    const remote = (relPath: string) => `${root}/${relPath}`;
    const destination = `${mode}://${settings.username}@${settings.host}:${port}${root || '/'}`;
    const files = hashStagedFiles(stagingDir);

    if (mode === 'sftp') {
      const sftp = new SftpClient();
      try {
        await sftp.connect({ host: settings.host, port, username: settings.username, password: settings.password });
        const owned = await this.listSftpOwned(sftp, root);
        const plan = planSync(files, db.getPublishLedger(destination), owned);
        const madeDirs = new Set<string>();
        const outcome = await applySyncPlan(db, destination, stagingDir, plan, {
          upload: async (localFile, relPath) => {
            const dir = path.posix.dirname(remote(relPath));
            if (!madeDirs.has(dir)) {
              await sftp.mkdir(dir, true).catch(() => undefined);
              await sftp.chmod(dir, 0o755).catch(() => undefined);
              madeDirs.add(dir);
            }
            await sftp.fastPut(localFile, remote(relPath));
            await sftp.chmod(remote(relPath), 0o644).catch(() => undefined);
          },
          remove: async (relPath) => {
            await sftp.delete(remote(relPath), true);
          },
        });
        await sftp.end();
        this.generator.recordPublished(genResult.bundle);
        return {
          success: true,
          mode,
          destination: `sftp://${settings.host}:${port}${root || '/'}`,
          filesPublished: outcome.uploaded,
          ...outcome,
          message: `Published via SFTP to ${settings.host}:${root || '/'}: ${describeOutcome(outcome)}.${missingNote(genResult.missingMedia)}`,
        };
      } catch (err: unknown) {
        await sftp.end().catch(() => undefined);
        return {
          success: false,
          mode,
          destination: settings.host,
          filesPublished: 0,
          message: `SFTP upload failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const client = new ftp.Client();
    try {
      await client.access({ host: settings.host, port, user: settings.username, password: settings.password, secure: false });
      const owned = await this.listFtpOwned(client, root);
      const plan = planSync(files, db.getPublishLedger(destination), owned);
      const outcome = await applySyncPlan(db, destination, stagingDir, plan, {
        upload: async (localFile, relPath) => {
          // ensureDir also moves into that folder, so upload by file name
          await client.ensureDir(path.posix.dirname(remote(relPath)));
          await client.uploadFrom(localFile, path.posix.basename(relPath));
        },
        remove: async (relPath) => {
          await client.remove(remote(relPath), true);
        },
      });
      client.close();
      this.generator.recordPublished(genResult.bundle);
      return {
        success: true,
        mode,
        destination: `ftp://${settings.host}:${port}${root || '/'}`,
        filesPublished: outcome.uploaded,
        ...outcome,
        message: `Published via FTP to ${settings.host}:${root || '/'}: ${describeOutcome(outcome)}.${missingNote(genResult.missingMedia)}`,
      };
    } catch (err: unknown) {
      client.close();
      return {
        success: false,
        mode,
        destination: settings.host,
        filesPublished: 0,
        message: `FTP upload failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Studio-owned files already on an SFTP host (missing folders are fine: nothing to clean). */
  private async listSftpOwned(sftp: SftpClient, root: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries: Array<{ name: string; type: string }>;
      try {
        entries = await sftp.list(`${root}/${rel}`);
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = `${rel}/${entry.name}`;
        if (entry.type === 'd') await walk(child);
        else found.push(child);
      }
    };
    for (const prefix of STUDIO_OWNED_PREFIXES) await walk(prefix.replace(/\/$/, ''));
    return found;
  }

  private async listFtpOwned(client: ftp.Client, root: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries: ftp.FileInfo[];
      try {
        entries = await client.list(`${root}/${rel}`);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue;
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory) await walk(child);
        else found.push(child);
      }
    };
    for (const prefix of STUDIO_OWNED_PREFIXES) await walk(prefix.replace(/\/$/, ''));
    return found;
  }

  /**
   * Generates the site to a staging folder and pushes it to a GitHub repository branch via the
   * GitHub REST "Git Data" API (blobs/trees/commits), then enables/updates GitHub Pages for that
   * repo to serve from the branch. Requires a Personal Access Token with `repo` scope (classic)
   * or Contents: Read & Write + Pages: Read & Write (fine-grained).
   */
  public async publishToGitHubPages(
    settings: PublishSettings,
    stagingDir: string
  ): Promise<PublishResult> {
    const owner = (settings.githubOwner || '').trim();
    const repo = (settings.githubRepo || '').trim();
    const branch = (settings.githubBranch || 'gh-pages').trim();
    const token = (settings.githubToken || '').trim();

    if (!owner || !repo || !token) {
      return {
        success: false,
        mode: 'github-pages',
        destination: '',
        filesPublished: 0,
        message: 'GitHub Pages deploy requires an owner, repository name, and access token.',
      };
    }

    const genResult = this.generator.generateToDirectory(stagingDir);

    const customDomain = (settings.githubCustomDomain || '').trim();
    if (customDomain) {
      fs.writeFileSync(path.join(stagingDir, 'CNAME'), `${customDomain}\n`, 'utf8');
      genResult.filesWritten.push('CNAME');
    }

    const gh = this.githubRequest.bind(this, token);
    const repoPath = `/repos/${owner}/${repo}`;

    try {
      // 0. Confirm up front that the token can actually push, so a permissions problem fails fast
      // with a clear message instead of after reads (and maybe a branch creation) have succeeded.
      const repoInfoRes = await gh(repoPath);
      if (repoInfoRes.status !== 200) {
        throw new Error(
          `Repository ${owner}/${repo} not found or token lacks access (HTTP ${repoInfoRes.status})${this.githubErrorDetail(repoInfoRes.body)}`
        );
      }
      const repoInfoBody = repoInfoRes.body as {
        default_branch: string;
        permissions?: { push?: boolean; admin?: boolean };
      };
      if (repoInfoBody.permissions && repoInfoBody.permissions.push === false) {
        throw new Error(
          `Resource not accessible by personal access token — it can read ${owner}/${repo} but not push to it. ` +
            `For a classic token, grant the "repo" scope; for a fine-grained token, grant "Contents: Read and write" ` +
            `(and "Pages: Read and write" to auto-enable Pages) on this repository, then save your settings again.`
        );
      }

      // 1. Resolve (or create) the target branch's current commit + tree.
      let baseCommitSha: string;
      const refRes = await gh(`${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`);
      if (refRes.status === 200) {
        baseCommitSha = (refRes.body as { object: { sha: string } }).object.sha;
      } else if (refRes.status === 404) {
        const defaultBranch = repoInfoBody.default_branch;
        const defaultRefRes = await gh(
          `${repoPath}/git/ref/heads/${encodeURIComponent(defaultBranch)}`
        );
        if (defaultRefRes.status !== 200) {
          throw new Error(`Repository ${owner}/${repo} has no commits yet; push an initial commit first.`);
        }
        const defaultSha = (defaultRefRes.body as { object: { sha: string } }).object.sha;
        const createRefRes = await gh(`${repoPath}/git/refs`, 'POST', {
          ref: `refs/heads/${branch}`,
          sha: defaultSha,
        });
        if (createRefRes.status !== 201) {
          throw new Error(`Failed to create branch "${branch}" (HTTP ${createRefRes.status})${this.githubErrorDetail(createRefRes.body)}`);
        }
        baseCommitSha = defaultSha;
      } else {
        throw new Error(`Failed to resolve branch "${branch}" (HTTP ${refRes.status})${this.githubErrorDetail(refRes.body)}`);
      }

      const baseCommitRes = await gh(`${repoPath}/git/commits/${baseCommitSha}`);
      if (baseCommitRes.status !== 200) {
        throw new Error(`Failed to read base commit (HTTP ${baseCommitRes.status})${this.githubErrorDetail(baseCommitRes.body)}`);
      }
      const baseTreeSha = (baseCommitRes.body as { tree: { sha: string } }).tree.sha;

      // 2. Compare with what's on the branch: GitHub identifies files by their git blob hash, so
      // unchanged files (most photos, most of the time) aren't uploaded again.
      const remoteTreeRes = await gh(`${repoPath}/git/trees/${baseTreeSha}?recursive=1`);
      const remoteTree = new Map<string, string>();
      let remoteComplete = false;
      if (remoteTreeRes.status === 200) {
        const body = remoteTreeRes.body as { truncated?: boolean; tree: Array<{ path: string; type: string; sha: string }> };
        for (const entry of body.tree) if (entry.type === 'blob') remoteTree.set(entry.path, entry.sha);
        remoteComplete = !body.truncated;
      }
      const destination = `github:${owner}/${repo}@${branch}`;
      const db = this.generator.database;
      const ledger = db.getPublishLedger(destination);
      const files = hashStagedFiles(stagingDir);
      const toUpload = [...files.keys()].filter(
        (relPath) => remoteTree.get(relPath) !== gitBlobSha(fs.readFileSync(path.join(stagingDir, relPath)))
      );
      // Only delete what Studio published here (or owns outright), and only if it's still there
      const plan = planSync(files, ledger, remoteComplete ? [...remoteTree.keys()] : []);
      const toRemove = plan.remove.filter((relPath) => remoteTree.has(relPath));
      if (toUpload.length === 0 && toRemove.length === 0) {
        for (const [relPath, hash] of files) db.setPublishLedgerEntry(destination, relPath, hash);
        this.generator.recordPublished(genResult.bundle);
        return {
          success: true,
          mode: 'github-pages',
          destination: `https://github.com/${owner}/${repo}/tree/${branch}`,
          filesPublished: 0,
          uploaded: 0,
          unchanged: files.size,
          removed: 0,
          message: `${owner}/${repo}@${branch} is already up to date.${missingNote(genResult.missingMedia)}`,
        };
      }

      // 3. Upload changed files as blobs. GitHub's abuse-detection rate limiter flags concurrent
      // writes to this endpoint, so these go one at a time (retried internally with backoff by
      // githubRequest on 403/429) rather than in parallel chunks.
      const treeEntries: Array<{ path: string; mode: string; type: string; sha: string | null }> = [];
      for (const relPath of toUpload) {
        const content = fs.readFileSync(path.join(stagingDir, relPath)).toString('base64');
        const blobRes = await gh(`${repoPath}/git/blobs`, 'POST', {
          content,
          encoding: 'base64',
        });
        if (blobRes.status !== 201) {
          throw new Error(
            `Failed to upload "${relPath}" (HTTP ${blobRes.status})${this.githubErrorDetail(blobRes.body)}`
          );
        }
        treeEntries.push({
          path: relPath,
          mode: '100644',
          type: 'blob',
          sha: (blobRes.body as { sha: string }).sha,
        });
      }
      for (const relPath of toRemove) {
        treeEntries.push({ path: relPath, mode: '100644', type: 'blob', sha: null });
      }

      // 4. Create a new tree + commit on top of the branch's current state, then fast-forward the ref.
      const treeRes = await gh(`${repoPath}/git/trees`, 'POST', {
        base_tree: baseTreeSha,
        tree: treeEntries,
      });
      if (treeRes.status !== 201) {
        throw new Error(`Failed to create tree (HTTP ${treeRes.status})${this.githubErrorDetail(treeRes.body)}`);
      }
      const newTreeSha = (treeRes.body as { sha: string }).sha;

      const commitRes = await gh(`${repoPath}/git/commits`, 'POST', {
        message: `Publish site via Webring Studio (${toUpload.length} changed, ${toRemove.length} removed)`,
        tree: newTreeSha,
        parents: [baseCommitSha],
      });
      if (commitRes.status !== 201) {
        throw new Error(`Failed to create commit (HTTP ${commitRes.status})${this.githubErrorDetail(commitRes.body)}`);
      }
      const newCommitSha = (commitRes.body as { sha: string }).sha;

      const updateRefRes = await gh(`${repoPath}/git/refs/heads/${encodeURIComponent(branch)}`, 'PATCH', {
        sha: newCommitSha,
        force: true,
      });
      if (updateRefRes.status !== 200) {
        throw new Error(`Failed to update branch "${branch}" (HTTP ${updateRefRes.status})${this.githubErrorDetail(updateRefRes.body)}`);
      }

      for (const [relPath, hash] of files) db.setPublishLedgerEntry(destination, relPath, hash);
      for (const relPath of plan.remove) db.setPublishLedgerEntry(destination, relPath, null);

      // 5. Ensure GitHub Pages is configured to serve from this branch (best-effort; not fatal).
      let pagesNote = '';
      try {
        const pagesCreateRes = await gh(`${repoPath}/pages`, 'POST', {
          source: { branch, path: '/' },
        });
        if (pagesCreateRes.status === 201) {
          pagesNote = ' GitHub Pages was enabled for this repo.';
        } else if (pagesCreateRes.status === 409) {
          await gh(`${repoPath}/pages`, 'PUT', { source: { branch, path: '/' } });
        }
      } catch {
        pagesNote = ' (Could not confirm GitHub Pages site settings — check them in the repo settings.)';
      }

      this.generator.recordPublished(genResult.bundle);
      return {
        success: true,
        mode: 'github-pages',
        destination: `https://github.com/${owner}/${repo}/tree/${branch}`,
        filesPublished: toUpload.length,
        uploaded: toUpload.length,
        unchanged: files.size - toUpload.length,
        removed: toRemove.length,
        message: `Pushed to ${owner}/${repo}@${branch}: ${toUpload.length} uploaded, ${files.size - toUpload.length} unchanged${toRemove.length ? `, ${toRemove.length} removed` : ''}.${pagesNote}${missingNote(genResult.missingMedia)}`,
      };
    } catch (err: unknown) {
      return {
        success: false,
        mode: 'github-pages',
        destination: `${owner}/${repo}`,
        filesPublished: 0,
        message: `GitHub Pages deploy failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Verifies the stored GitHub token can see the repo and reports branch/Pages status, without
   * publishing anything — used by the "Check Repo Access" button.
   */
  public async checkGitHubRepo(settings: PublishSettings): Promise<GitHubRepoCheckResult> {
    const owner = (settings.githubOwner || '').trim();
    const repo = (settings.githubRepo || '').trim();
    const branch = (settings.githubBranch || 'gh-pages').trim();
    const token = (settings.githubToken || '').trim();

    if (!owner || !repo || !token) {
      return { success: false, message: 'Enter an owner, repository name, and access token first.' };
    }

    const gh = this.githubRequest.bind(this, token);
    const repoPath = `/repos/${owner}/${repo}`;

    const repoRes = await gh(repoPath);
    if (repoRes.status === 401) {
      return { success: false, message: 'GitHub rejected the token (401 Unauthorized).' };
    }
    if (repoRes.status === 404) {
      return { success: false, message: `Repository ${owner}/${repo} was not found, or the token can't see it.` };
    }
    if (repoRes.status !== 200) {
      return { success: false, message: `GitHub returned HTTP ${repoRes.status}.` };
    }

    const repoInfoBody = repoRes.body as {
      default_branch: string;
      permissions?: { push?: boolean };
    };
    const defaultBranch = repoInfoBody.default_branch;
    const canPush = repoInfoBody.permissions?.push !== false;

    if (!canPush) {
      return {
        success: false,
        defaultBranch,
        canPush: false,
        message:
          `Token can read ${owner}/${repo} but can't push to it. For a classic token, grant the ` +
          `"repo" scope; for a fine-grained token, grant "Contents: Read and write" on this repo.`,
      };
    }

    const refRes = await gh(`${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`);
    const branchExists = refRes.status === 200;

    const pagesRes = await gh(`${repoPath}/pages`);
    const pagesEnabled = pagesRes.status === 200;
    const pagesUrl = pagesEnabled ? (pagesRes.body as { html_url?: string }).html_url : undefined;

    return {
      success: true,
      defaultBranch,
      branchExists,
      canPush,
      pagesEnabled,
      pagesUrl,
      message: branchExists
        ? `Connected to ${owner}/${repo}. Branch "${branch}" exists.${pagesEnabled ? ' GitHub Pages is already enabled.' : ' GitHub Pages is not yet enabled — it will be enabled on first deploy.'}`
        : `Connected to ${owner}/${repo}. Branch "${branch}" doesn't exist yet — it will be created from "${defaultBranch}" on first deploy.`,
    };
  }

  /**
   * GitHub aggressively secondary-rate-limits concurrent writes to mutating endpoints (like blob
   * creation), returning 403 with a `retry_after`/Retry-After hint rather than a scope/permission
   * error. We retry those (and raw 429s) with backoff instead of failing the whole deploy on one
   * unlucky request.
   */
  private async githubRequest(
    token: string,
    urlPath: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
    body?: unknown,
    attempt = 1
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${GITHUB_API_BASE}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'webring-studio',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    const isRateLimited =
      res.status === 429 ||
      (res.status === 403 &&
        (res.headers.get('retry-after') ||
          res.headers.get('x-ratelimit-remaining') === '0' ||
          /rate limit/i.test(String((parsed as { message?: string }).message || ''))));

    if (isRateLimited && attempt < 5) {
      const retryAfterHeader = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.githubRequest(token, urlPath, method, body, attempt + 1);
    }

    return { status: res.status, body: parsed };
  }

  /** Extracts GitHub's human-readable `message` field from a response body, if present. */
  private githubErrorDetail(body: unknown): string {
    const msg = (body as { message?: string } | null)?.message;
    return msg ? ` — ${msg}` : '';
  }
}
