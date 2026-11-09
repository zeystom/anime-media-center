import { app, BrowserWindow } from 'electron';
import { createRequire } from 'module';
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import type { UpdaterState, UpdateInfoPayload } from './types.ts';
import { storage } from './storage.ts';

const require = createRequire(import.meta.url);

export const GITHUB_OWNER = 'zeystom';
export const GITHUB_REPO = 'anime-media-center';

export function isNewerVersion(latest?: string | null, current?: string | null): boolean {
  if (!latest || typeof latest !== 'string') return false;
  if (!current || typeof current !== 'string') return true;
  const clean = (v: string) => v.replace(/^v/i, '').trim();
  const lParts = clean(latest).split('.').map((p) => parseInt(p, 10) || 0);
  const cParts = clean(current).split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(lParts.length, cParts.length); i++) {
    const l = lParts[i] ?? 0;
    const c = cParts[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

export function getAppVersion(): string {
  try {
    if (app && typeof app.getVersion === 'function') {
      const v = app.getVersion();
      if (v) return v;
    }
  } catch {}
  return '1.0.4';
}

let updaterState: UpdaterState = {
  status: 'idle',
  currentVersion: getAppVersion(),
  updateInfo: null,
  downloadProgress: null,
  error: null,
};

let getMainWindowRef: (() => BrowserWindow | null) | null = null;
let isStartupCheckInProgress = false;
let downloadedInstallerPath: string | null = null;
let periodicTimer: NodeJS.Timeout | null = null;

function broadcastState() {
  const win = getMainWindowRef ? getMainWindowRef() : null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:state-changed', { ...updaterState });
  }
}

function broadcastStartupPrompt(updateInfo: UpdateInfoPayload) {
  const win = getMainWindowRef ? getMainWindowRef() : null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:startup-update-available', updateInfo);
  }
}

let autoUpdaterInstance: AppUpdater | null = null;

export function getAutoUpdater(): AppUpdater | null {
  if (!autoUpdaterInstance) {
    try {
      const eu = require('electron-updater');
      autoUpdaterInstance = eu.autoUpdater || (eu.default && eu.default.autoUpdater) || null;
    } catch (err) {
      console.warn('[Updater] electron-updater could not be loaded:', err);
    }
  }
  return autoUpdaterInstance;
}

export function initUpdater(mainWindowGetter: () => BrowserWindow | null): void {
  getMainWindowRef = mainWindowGetter;
  updaterState.currentVersion = getAppVersion();

  startPeriodicUpdateCheck();

  const updater = getAutoUpdater();
  if (!updater) return;

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  try {
    if (app && !app.isPackaged) {
      updater.forceDevUpdateConfig = true;
    }
    updater.setFeedURL({
      provider: 'github',
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
    });
  } catch (err) {
    console.warn('[Updater] Feed URL initialization error:', err);
  }

  updater.on('checking-for-update', () => {
    updaterState.status = 'checking';
    updaterState.error = null;
    broadcastState();
  });

  updater.on('update-available', (info: UpdateInfo) => {
    const rawNotes = info.releaseNotes;
    let notes: string | null = null;
    if (typeof rawNotes === 'string') {
      notes = rawNotes;
    } else if (Array.isArray(rawNotes)) {
      notes = rawNotes.map((n) => (typeof n === 'string' ? n : n.note || '')).join('\n');
    }

    const payload: UpdateInfoPayload = {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: notes,
    };

    updaterState.status = 'available';
    updaterState.updateInfo = payload;
    updaterState.error = null;
    broadcastState();

    if (isStartupCheckInProgress) {
      isStartupCheckInProgress = false;
      broadcastStartupPrompt(payload);
    } else {
      const s = storage.getSettings();
      if (s.autoUpdate !== false) {
        // Auto-download in background if enabled
        downloadUpdate().catch((e) => console.warn('[Updater] Auto-download failed:', e));
      }
    }
  });

  updater.on('update-not-available', (info: UpdateInfo) => {
    updaterState.status = 'not-available';
    updaterState.updateInfo = info ? { version: info.version } : null;
    updaterState.error = null;
    isStartupCheckInProgress = false;
    broadcastState();
  });

  updater.on('error', (err: Error) => {
    console.warn('[Updater] autoUpdater event error:', err?.message || err);
    updaterState.status = 'error';
    updaterState.error = err?.message || 'Check failed';
    isStartupCheckInProgress = false;
    broadcastState();
  });

  updater.on('download-progress', (progress) => {
    updaterState.status = 'downloading';
    updaterState.downloadProgress = {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    };
    broadcastState();
  });

  updater.on('update-downloaded', (_info) => {
    updaterState.status = 'downloaded';
    updaterState.downloadProgress = null;
    updaterState.error = null;
    broadcastState();
  });
}

export function startPeriodicUpdateCheck(): void {
  if (periodicTimer) return;
  // Check every 4 hours in the background
  const INTERVAL_MS = 4 * 60 * 60 * 1000;
  periodicTimer = setInterval(() => {
    try {
      const s = storage.getSettings();
      if (s.autoUpdate !== false) {
        checkForUpdates(false).catch((err) => {
          console.warn('[Updater] Periodic background check failed:', err);
        });
      }
    } catch {}
  }, INTERVAL_MS);
  if (typeof periodicTimer.unref === 'function') {
    periodicTimer.unref();
  }
}

export async function checkForUpdates(isStartup = false): Promise<UpdaterState> {
  if (isStartup) {
    const currentSettings = storage.getSettings();
    if (currentSettings.checkForUpdatesOnStartup === false) {
      return { ...updaterState };
    }
    isStartupCheckInProgress = true;
  } else {
    isStartupCheckInProgress = false;
  }

  updaterState.currentVersion = getAppVersion();
  updaterState.status = 'checking';
  updaterState.error = null;
  broadcastState();

  const updater = getAutoUpdater();
  let checkedViaAutoUpdater = false;

  if (updater) {
    try {
      if (app && !app.isPackaged) {
        updater.forceDevUpdateConfig = true;
      }
      updater.setFeedURL({
        provider: 'github',
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
      });

      const res = await updater.checkForUpdates();
      if (res && res.updateInfo) {
        checkedViaAutoUpdater = true;
      }
    } catch (err: any) {
      console.warn('[Updater] autoUpdater.checkForUpdates() threw, will try fallback:', err?.message || err);
    }
  }

  // Fallback to direct GitHub Releases API check if autoUpdater failed or threw
  if (!checkedViaAutoUpdater) {
    try {
      const resp = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`, {
        headers: { 'User-Agent': `Kaiko/${updaterState.currentVersion}` },
      });
      if (resp.ok) {
        const data: any = await resp.json();
        const tag = (data.tag_name || '').replace(/^v/i, '').trim();
        const cur = updaterState.currentVersion;
        const assets: any[] = Array.isArray(data.assets) ? data.assets : [];
        const exeAsset = assets.find((a) => typeof a.name === 'string' && a.name.toLowerCase().endsWith('.exe'));

        const payload: UpdateInfoPayload = {
          version: tag,
          releaseDate: data.published_at,
          releaseNotes: data.body || null,
          downloadUrl: exeAsset?.browser_download_url || null,
          fileName: exeAsset?.name || `Kaiko-Setup-${tag}.exe`,
          fileSize: typeof exeAsset?.size === 'number' ? exeAsset.size : null,
        };

        if (tag && isNewerVersion(tag, cur)) {
          updaterState.status = 'available';
          updaterState.updateInfo = payload;
          updaterState.error = null;
          broadcastState();

          if (isStartupCheckInProgress) {
            isStartupCheckInProgress = false;
            broadcastStartupPrompt(payload);
          } else {
            const s = storage.getSettings();
            if (s.autoUpdate !== false) {
              downloadUpdate().catch((e) => console.warn('[Updater] Auto-download failed:', e));
            }
          }
          return { ...updaterState };
        } else {
          updaterState.status = 'not-available';
          updaterState.updateInfo = tag ? { version: tag } : null;
          updaterState.error = null;
          isStartupCheckInProgress = false;
          broadcastState();
          return { ...updaterState };
        }
      } else {
        const errorMsg = resp.status === 403
          ? 'GitHub API rate limit exceeded (please try again later)'
          : `Update server error (HTTP ${resp.status})`;
        updaterState.status = 'error';
        updaterState.error = errorMsg;
        isStartupCheckInProgress = false;
        broadcastState();
        return { ...updaterState };
      }
    } catch (apiErr: any) {
      console.warn('[Updater] GitHub API fallback threw:', apiErr?.message || apiErr);
      if (updaterState.status === 'checking') {
        updaterState.status = 'error';
        updaterState.error = apiErr?.message || 'Could not reach update server';
        isStartupCheckInProgress = false;
        broadcastState();
      }
    }
  }

  return { ...updaterState };
}

async function downloadDirectAsset(url: string, fileName?: string | null, expectedSize?: number | null): Promise<void> {
  const fs = require('fs');
  const path = require('path');
  const tempDir = (app && typeof app.getPath === 'function') ? app.getPath('temp') : process.cwd();
  const targetName = fileName || `Kaiko-Setup-${updaterState.updateInfo?.version || 'update'}.exe`;
  const targetPath = path.join(tempDir, targetName);

  const resp = await fetch(url, { headers: { 'User-Agent': `Kaiko/${updaterState.currentVersion}` } });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} while downloading installer`);
  }

  const total = parseInt(resp.headers.get('content-length') || '0', 10) || expectedSize || 100 * 1024 * 1024;
  const fileStream = fs.createWriteStream(targetPath);

  if (!resp.body) {
    throw new Error('Response body is empty');
  }

  const reader = resp.body.getReader();
  let transferred = 0;
  let lastTime = Date.now();
  let lastBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(value);
      transferred += value.length;

      const now = Date.now();
      if (now - lastTime >= 250) {
        const bps = Math.round(((transferred - lastBytes) / (now - lastTime)) * 1000);
        lastTime = now;
        lastBytes = transferred;
        updaterState.downloadProgress = {
          percent: Math.min(100, Math.round((transferred / total) * 100)),
          bytesPerSecond: bps,
          transferred,
          total,
        };
        broadcastState();
      }
    }
    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', () => resolve());
      fileStream.on('error', reject);
    });

    downloadedInstallerPath = targetPath;
    updaterState.status = 'downloaded';
    updaterState.downloadProgress = null;
    updaterState.error = null;
    broadcastState();
  } catch (err) {
    fileStream.destroy();
    try { fs.unlinkSync(targetPath); } catch {}
    throw err;
  }
}

export async function downloadUpdate(): Promise<{ success: boolean; error?: string }> {
  const updater = getAutoUpdater();
  updaterState.status = 'downloading';
  updaterState.downloadProgress = { percent: 0, bytesPerSecond: 0, transferred: 0, total: 100 };
  broadcastState();

  if (updater) {
    try {
      await updater.downloadUpdate();
      return { success: true };
    } catch (err: any) {
      console.warn('[Updater] autoUpdater.downloadUpdate() threw, will try direct download fallback:', err?.message || err);
    }
  }

  const dlUrl = updaterState.updateInfo?.downloadUrl;
  if (dlUrl) {
    try {
      await downloadDirectAsset(dlUrl, updaterState.updateInfo?.fileName, updaterState.updateInfo?.fileSize);
      return { success: true };
    } catch (fallbackErr: any) {
      console.warn('[Updater] Direct download fallback failed:', fallbackErr?.message || fallbackErr);
      updaterState.status = 'error';
      updaterState.error = fallbackErr?.message || 'Download failed';
      broadcastState();
      return { success: false, error: updaterState.error || 'Download failed' };
    }
  }

  updaterState.status = 'error';
  updaterState.error = 'No download URL available for update';
  broadcastState();
  return { success: false, error: updaterState.error || 'No download URL available for update' };
}

export function installUpdate(): void {
  if (downloadedInstallerPath) {
    try {
      const fs = require('fs');
      if (fs.existsSync(downloadedInstallerPath)) {
        const { spawn } = require('child_process');
        const child = spawn(downloadedInstallerPath, [], { detached: true, stdio: 'ignore' });
        child.unref();
        if (app && typeof app.quit === 'function') {
          app.quit();
        }
        return;
      }
    } catch (err) {
      console.warn('[Updater] Direct installer spawn error:', err);
    }
  }

  const updater = getAutoUpdater();
  if (updater) {
    try {
      updater.quitAndInstall(false, true);
    } catch (err) {
      console.warn('[Updater] quitAndInstall threw:', err);
    }
  }
}

export function getUpdaterState(): UpdaterState {
  updaterState.currentVersion = getAppVersion();
  return { ...updaterState };
}
