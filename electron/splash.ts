import { BrowserWindow } from 'electron';

/** The splash's animation ends at 2.8 s (assets/splash.html); it closes just after. */
const SPLASH_MS = 2850;
/** If the splash can't be shown quickly, give up and let the main window appear. */
const SHOW_TIMEOUT_MS = 1500;

/**
 * Shows the start-up splash in a small frameless window and resolves when it has finished (or
 * couldn't be shown), so the main window can appear in its place. Its 3-second clock starts when
 * it's actually on screen, so the animation is never cut short.
 */
export function showSplash(htmlPath: string): Promise<void> {
  return new Promise((resolve) => {
    let splash: BrowserWindow | null = new BrowserWindow({
      width: 560,
      height: 440,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      center: true,
      show: false,
      backgroundColor: '#090d16',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const finish = () => {
      if (splash && !splash.isDestroyed()) splash.destroy();
      splash = null;
      resolve();
    };
    // Shown once the page is ready; the CSS animation is restarted then, so it plays in full
    const giveUp = setTimeout(finish, SHOW_TIMEOUT_MS);
    splash.once('ready-to-show', () => {
      clearTimeout(giveUp);
      if (!splash || splash.isDestroyed()) return;
      splash.webContents
        .executeJavaScript("document.body.classList.add('play')")
        .catch(() => undefined)
        .finally(() => {
          splash?.show();
          setTimeout(finish, SPLASH_MS);
        });
    });
    splash.webContents.on('will-navigate', (event) => event.preventDefault());
    splash.loadFile(htmlPath).catch(finish);
  });
}
