import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const startupApp = app as typeof app & {
  __kaikoStartupSplash?: BrowserWindow;
  __kaikoStartupShownAt?: number;
  __kaikoUserMinimized?: boolean;
};

// These need to be registered before app readiness. Keep Chromium's startup
// and rendering configuration in the lightweight entry point.
app.commandLine.appendSwitch('disable-direct-composition-video-overlays');
app.commandLine.appendSwitch('disable-features', 'DirectCompositionVideoOverlays');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Electron inherits its executable name in the Windows taskbar context menu
// during development unless the branded app name/AUMID are set before startup.
app.setName('Kaiko');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.animemediacenter.app');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const visibleWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
    if (!visibleWindow) return;
    if (visibleWindow.isMinimized()) visibleWindow.restore();
    if (!visibleWindow.isVisible()) visibleWindow.show();
    visibleWindow.focus();
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.animemediacenter.app');
    }

    const icon = path.join(__dirname, '../app-icon.ico');
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    const restoredWidth = Math.max(1024, Math.min(1400, Math.round(width * 0.82)));
    const restoredHeight = Math.max(700, Math.min(900, Math.round(height * 0.84)));
    const restoredX = Math.round(x + (width - restoredWidth) / 2);
    const restoredY = Math.round(y + (height - restoredHeight) / 2);
    const splashPath = app.isPackaged
      ? path.join(__dirname, '../dist/kaiko-splash.html')
      : path.join(app.getAppPath(), 'public/kaiko-splash.html');

    const splash = new BrowserWindow({
      x: restoredX,
      y: restoredY,
      width: restoredWidth,
      height: restoredHeight,
      minWidth: 1024,
      minHeight: 700,
      show: false,
      paintWhenInitiallyHidden: true,
      opacity: 0,
      backgroundColor: '#07060a',
      title: 'Kaiko — Starting',
      icon,
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    if (process.platform === 'win32') {
      const relaunchPath = app.isPackaged ? process.execPath : path.join(app.getAppPath(), 'Kaiko.exe');
      splash.setAppDetails({
        appId: 'com.animemediacenter.app',
        appIconPath: icon,
        relaunchCommand: `"${relaunchPath}"`,
        relaunchDisplayName: 'Kaiko',
      });
    }
    splash.setMenu(null);
    splash.removeMenu();
    // Establish the maximized geometry while opacity is 0 so Windows absorbs any
    // initial WM_ERASEBKGND/frame expose invisibly before reveal.
    splash.maximize();

    startupApp.__kaikoUserMinimized = false;

    // Register controls before loading the startup page so they remain live
    // even while the heavier application modules are still initializing.
    ipcMain.handle('window:minimize', () => {
      startupApp.__kaikoUserMinimized = true;
      if (!splash.isDestroyed()) splash.minimize();
    });
    ipcMain.handle('window:toggle-maximize', () => {
      if (splash.isDestroyed()) return false;
      if (splash.isMaximized()) splash.unmaximize();
      else splash.maximize();
      return splash.isMaximized();
    });
    ipcMain.handle('window:close', () => {
      if (!splash.isDestroyed()) splash.close();
    });
    ipcMain.handle('window:is-maximized', () => !splash.isDestroyed() && splash.isMaximized());
    const emitMaximizeState = () => {
      if (!splash.isDestroyed()) splash.webContents.send('window:maximized-change', splash.isMaximized());
    };
    splash.on('minimize', () => {
      startupApp.__kaikoUserMinimized = true;
    });
    splash.on('restore', () => {
      startupApp.__kaikoUserMinimized = false;
    });
    splash.on('maximize', () => {
      startupApp.__kaikoUserMinimized = false;
      emitMaximizeState();
    });
    splash.on('unmaximize', emitMaximizeState);

    startupApp.__kaikoStartupSplash = splash;

    let splashRevealed = false;
    let resolveSplashShown!: () => void;
    const splashShownPromise = new Promise<void>((resolve) => {
      resolveSplashShown = resolve;
    });

    const revealSplash = () => {
      if (splashRevealed) return;
      splashRevealed = true;
      if (splash.isDestroyed()) {
        resolveSplashShown();
        return;
      }
      // Show while still at opacity 0 so DWM/DirectComposition commits the dark
      // painted frame to the HWND swapchain before becoming visible.
      splash.show();
      setTimeout(() => {
        if (!splash.isDestroyed()) {
          if (splash.isMinimized() && !startupApp.__kaikoUserMinimized) splash.restore();
          splash.setOpacity(1);
          if (process.platform === 'win32') {
            splash.setAlwaysOnTop(true);
            splash.focus();
            splash.moveTop();
            splash.setAlwaysOnTop(false);
          }
          startupApp.__kaikoStartupShownAt = Date.now();
        }
        resolveSplashShown();
      }, 100);
    };

    splash.once('ready-to-show', revealSplash);
    splash.once('closed', resolveSplashShown);
    const fallbackRevealTimer = setTimeout(revealSplash, 800);

    // This is the app's only native window. Reuse its WebContents for the UI
    // so startup cannot create a second visible window.
    try {
      await splash.loadFile(splashPath);
    } catch (error) {
      console.error('[Electron] Could not load startup splash:', error);
      revealSplash();
    }
    await splashShownPromise;
    clearTimeout(fallbackRevealTimer);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Heavy application imports begin only after the dark native window is visible.
    try {
      await import('./main');
    } catch (error) {
      console.error('[Electron] Failed to start Kaiko:', error);
    }
  });
}
