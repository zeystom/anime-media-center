import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const startupApp = app as typeof app & {
  __kaikoStartupSplash?: BrowserWindow;
  __kaikoStartupShownAt?: number;
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const visibleWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
    if (!visibleWindow) return;
    if (!visibleWindow.isVisible()) visibleWindow.show();
    visibleWindow.focus();
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.animemediacenter.app');
    }

    const icon = path.join(__dirname, '../app-icon.ico');
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    const splashPath = app.isPackaged
      ? path.join(__dirname, '../dist/kaiko-splash.html')
      : path.join(app.getAppPath(), 'public/kaiko-splash.html');

    const splash = new BrowserWindow({
      x,
      y,
      width,
      height,
      minWidth: 1024,
      minHeight: 700,
      show: false,
      opacity: 0,
      backgroundColor: '#09080f',
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
    splash.setMenu(null);
    splash.removeMenu();
    // Opacity is zero from construction, so maximize can establish the final
    // viewport before Chromium paints without exposing the native white frame.
    // Avoid resizing between the splash's first frame and its animation.
    splash.maximize();

    // Register controls before loading the startup page so they remain live
    // even while the heavier application modules are still initializing.
    ipcMain.handle('window:minimize', () => {
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
    splash.on('maximize', emitMaximizeState);
    splash.on('unmaximize', emitMaximizeState);

    startupApp.__kaikoStartupSplash = splash;
    startupApp.__kaikoStartupShownAt = Date.now();

    // Wait for the first composed splash frame. Maximizing a hidden HWND before
    // Chromium paints can expose the native white frame on Windows.
    splash.once('ready-to-show', () => {
      if (splash.isDestroyed()) return;
      splash.show();
      setTimeout(() => {
        if (!splash.isDestroyed()) splash.setOpacity(1);
      }, 100);
    });

    // This is the app's only native window. Reuse its WebContents for the UI
    // so startup cannot create a second visible window.
    void splash.loadFile(splashPath).catch((error) => {
      console.error('[Electron] Could not load startup splash:', error);
    });

    // Heavy application imports begin only after the dark native window exists.
    try {
      await import('./main');
    } catch (error) {
      console.error('[Electron] Failed to start Kaiko:', error);
    }
  });
}
