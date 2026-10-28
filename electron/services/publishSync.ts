import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { StudioDatabase } from '../db/database';

/**
 * Incremental publishing. Each destination (a local folder, an SFTP/FTP folder, a GitHub branch)
 * has a ledger of the files Studio last put there and their hashes. A publish uploads only new or
 * changed files and deletes only files Studio itself created that are no longer part of the
 * site, never anything else the user keeps at the destination (README, CNAME, other pages).
 * Files under media/albums/ and media/profile/ are always Studio's (the Media Library writes them), so stale photos
 * from before the ledger existed are cleaned up too.
 */

/** Paths that only the Media Library ever writes; safe to delete when no longer published. */
export const STUDIO_OWNED_PREFIXES = ['media/albums/', 'media/profile/'];

export interface SyncPlan {
  /** path -> sha256 for every file in the generated site */
  files: Map<string, string>;
  upload: string[];
  unchanged: string[];
  remove: string[];
}

export interface SyncOutcome {
  uploaded: number;
  unchanged: number;
  removed: number;
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function listFilesRecursive(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

export function isStudioOwned(filePath: string): boolean {
  return STUDIO_OWNED_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

/** Upload order: media first, then data, and pages last, so the live site never references a missing file. */
function uploadRank(filePath: string): number {
  if (filePath.startsWith('media/')) return 0;
  if (filePath.endsWith('.html')) return 2;
  return 1;
}

/**
 * Works out what to upload and delete.
 * @param files       every generated file and its hash
 * @param ledger      what Studio last published here (path -> hash)
 * @param remoteOwned Studio-owned paths found at the destination, if it could be listed
 */
export function planSync(
  files: Map<string, string>,
  ledger: Map<string, string>,
  remoteOwned: string[] = []
): SyncPlan {
  const upload: string[] = [];
  const unchanged: string[] = [];
  for (const [filePath, hash] of files) {
    if (ledger.get(filePath) === hash) unchanged.push(filePath);
    else upload.push(filePath);
  }
  upload.sort((a, b) => uploadRank(a) - uploadRank(b) || a.localeCompare(b));
  const candidates = new Set([...ledger.keys(), ...remoteOwned.filter(isStudioOwned)]);
  const remove = [...candidates].filter((p) => !files.has(p)).sort();
  return { files, upload, unchanged, remove };
}

export function hashStagedFiles(stagingDir: string): Map<string, string> {
  return new Map(listFilesRecursive(stagingDir).map((rel) => [rel, sha256File(path.join(stagingDir, rel))]));
}

/** A place files can be written to and removed from, by site-relative path. */
export interface SyncTarget {
  upload(localFile: string, relPath: string): Promise<void>;
  remove(relPath: string): Promise<void>;
}

/**
 * Applies a plan, recording each file in the ledger as soon as it's done, so an interrupted
 * publish picks up where it stopped.
 */
export async function applySyncPlan(
  db: StudioDatabase,
  destination: string,
  stagingDir: string,
  plan: SyncPlan,
  target: SyncTarget
): Promise<SyncOutcome> {
  for (const relPath of plan.upload) {
    await target.upload(path.join(stagingDir, relPath), relPath);
    db.setPublishLedgerEntry(destination, relPath, plan.files.get(relPath)!);
  }
  // Files that matched may be missing from the ledger (e.g. first run after an upgrade)
  for (const relPath of plan.unchanged) {
    db.setPublishLedgerEntry(destination, relPath, plan.files.get(relPath)!);
  }
  for (const relPath of plan.remove) {
    await target.remove(relPath);
    db.setPublishLedgerEntry(destination, relPath, null);
  }
  return { uploaded: plan.upload.length, unchanged: plan.unchanged.length, removed: plan.remove.length };
}

/**
 * Local export: the generator has already written the site into `outDir`; delete what Studio
 * put there before and no longer publishes, and record the new contents.
 */
export function finishLocalExport(
  db: StudioDatabase,
  outDir: string,
  writtenFiles: string[]
): SyncOutcome {
  const destination = `local:${path.resolve(outDir)}`;
  const ledger = db.getPublishLedger(destination);
  const written = new Set(writtenFiles);
  const present = listFilesRecursive(outDir);
  const files = new Map([...written].filter((f) => fs.existsSync(path.join(outDir, f))).map((f) => [f, sha256File(path.join(outDir, f))]));
  const plan = planSync(files, ledger, present.filter(isStudioOwned));
  let uploaded = 0;
  for (const [filePath, hash] of files) {
    if (ledger.get(filePath) !== hash) uploaded++;
    db.setPublishLedgerEntry(destination, filePath, hash);
  }
  for (const relPath of plan.remove) {
    fs.rmSync(path.join(outDir, relPath), { force: true });
    db.setPublishLedgerEntry(destination, relPath, null);
  }
  return { uploaded, unchanged: files.size - uploaded, removed: plan.remove.length };
}

export function describeOutcome(outcome: SyncOutcome): string {
  const parts = [`${outcome.uploaded} uploaded`, `${outcome.unchanged} unchanged`];
  if (outcome.removed) parts.push(`${outcome.removed} removed`);
  return parts.join(', ');
}
