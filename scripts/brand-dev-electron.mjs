#!/usr/bin/env node
/**
 * When running from source on macOS, the Dock tooltip, the bold app menu name and Cmd+Tab come
 * from Electron's own app bundle (node_modules/electron/dist/Electron.app), which says "Electron".
 * This renames that bundle to "Webring Studio", gives it our icon, and re-signs it (ad-hoc, as it
 * shipped), so the dev app looks like the real thing.
 *
 * It deliberately does NOT change the package name or call app.setName(): those decide the data
 * folder (…/webring-studio), and changing them would hide every existing persona.
 *
 * Safe to run repeatedly (skips when already done), never fails the install, and does nothing on
 * Windows/Linux. Runs from `postinstall` and before `npm run dev` / `npm start`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'Webring Studio';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

function warn(message) {
  console.warn(`[brand-dev-electron] ${message}`);
}

function main() {
  if (process.platform !== 'darwin') return;

  const require = createRequire(import.meta.url);
  let electronDir;
  try {
    electronDir = path.dirname(require.resolve('electron/package.json'));
  } catch {
    return; // Electron not installed (e.g. production install)
  }
  const appBundle = path.join(electronDir, 'dist', 'Electron.app');

  // Electron 42+ downloads its binary on first use; fetch it now if needed
  if (!existsSync(appBundle)) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    run(process.execPath, [path.join(electronDir, 'cli.js'), '--version'], { env, stdio: 'ignore' });
  }
  if (!existsSync(appBundle)) {
    warn('Electron app not downloaded yet; the Dock will say "Electron" until the next run.');
    return;
  }

  const plist = path.join(appBundle, 'Contents', 'Info.plist');
  const bundleIcon = path.join(appBundle, 'Contents', 'Resources', 'electron.icns');
  const ourIcon = path.join(root, 'build', 'icon.icns');
  const hash = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : '');

  const currentName = run('plutil', ['-extract', 'CFBundleName', 'raw', plist]).stdout.trim();
  const iconDone = !existsSync(ourIcon) || hash(ourIcon) === hash(bundleIcon);
  if (currentName === APP_NAME && iconDone) return;

  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    const result = run('plutil', ['-replace', key, '-string', APP_NAME, plist]);
    if (result.status !== 0) {
      warn(`Couldn't set ${key}: ${result.stderr.trim()}`);
      return;
    }
  }
  if (existsSync(ourIcon)) copyFileSync(ourIcon, bundleIcon);

  // Editing the bundle invalidates its ad-hoc signature; re-sign it the same way it shipped
  const sign = run('codesign', ['--force', '--deep', '--sign', '-', appBundle]);
  if (sign.status !== 0) warn(`Re-signing failed: ${sign.stderr.trim()}`);

  // Make the Dock and Finder notice the new name and icon
  const now = new Date();
  utimesSync(appBundle, now, now);
  if (existsSync(LSREGISTER)) run(LSREGISTER, ['-f', appBundle]);

  console.log(`[brand-dev-electron] Dev app renamed to "${APP_NAME}" with the Webring Studio icon.`);
}

try {
  main();
} catch (err) {
  warn(`Skipped: ${err instanceof Error ? err.message : String(err)}`);
}
