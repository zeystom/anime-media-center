import { app, BrowserWindow, Notification } from 'electron';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { resolveUserDataPath } from './userDataPath';
import { storage, autoDetectWhisperPath, findExecutableInDir, findExecutableInPath } from './storage';

export interface WhisperEngineDownloadProgress {
  isDownloading: boolean;
  phase: 'idle' | 'downloading' | 'extracting' | 'completed' | 'error';
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  error?: string | null;
  whisperPath?: string | null;
  message?: string;
}

const GITHUB_OWNER = 'Purfview';
const GITHUB_REPO = 'whisper-standalone-win';
const GITHUB_TAG = 'Faster-Whisper-XXL';
const DEFAULT_FALLBACK_URL =
  'https://github.com/Purfview/whisper-standalone-win/releases/download/Faster-Whisper-XXL/Faster-Whisper-XXL_r245.4_windows.7z';
const DEFAULT_EXPECTED_SIZE = 1424256246;

let engineState: WhisperEngineDownloadProgress = {
  isDownloading: false,
  phase: 'idle',
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  error: null,
  whisperPath: null,
  message: '',
};

let activeAbortController: AbortController | null = null;
let activeExtractProcess: ChildProcess | null = null;
let currentTempArchivePath: string | null = null;
let currentTargetDir: string | null = null;
let getMainWindowRef: (() => BrowserWindow | null) | null = null;

export function initWhisperEngineDownloader(mainWindowGetter: () => BrowserWindow | null): void {
  getMainWindowRef = mainWindowGetter;
}

export function getWhisperEngineState(): WhisperEngineDownloadProgress {
  return { ...engineState };
}

function broadcastState(): void {
  const win = getMainWindowRef ? getMainWindowRef() : null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('whisper:engine-download-progress', { ...engineState });
    win.webContents.send('whisper:engine-download-status', {
      isDownloading: engineState.isDownloading,
      phase: engineState.phase,
      error: engineState.error,
    });
  }
}

/**
 * Resolves the download URL and expected size for the Faster-Whisper-XXL Windows archive.
 * Checks the GitHub API first, falling back to the known release URL.
 */
async function resolveReleaseAsset(): Promise<{ url: string; size: number }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${GITHUB_TAG}`,
      {
        signal: controller.signal,
        headers: { 'User-Agent': 'Kaiko-Media-Center' },
      }
    );
    clearTimeout(timeout);

    if (resp.ok) {
      const data: any = await resp.json();
      const assets: any[] = Array.isArray(data.assets) ? data.assets : [];
      const winAsset = assets.find(
        (a) =>
          typeof a.name === 'string' &&
          a.name.toLowerCase().startsWith('faster-whisper-xxl_') &&
          a.name.toLowerCase().endsWith('_windows.7z')
      );
      if (winAsset && winAsset.browser_download_url) {
        return {
          url: winAsset.browser_download_url,
          size: typeof winAsset.size === 'number' && winAsset.size > 0 ? winAsset.size : DEFAULT_EXPECTED_SIZE,
        };
      }
    }
  } catch (err: any) {
    console.warn('[WhisperEngineDownloader] GitHub API release check failed, using fallback URL:', err?.message || err);
  }

  return {
    url: DEFAULT_FALLBACK_URL,
    size: DEFAULT_EXPECTED_SIZE,
  };
}

export interface ArchiveExtractor {
  type: '7z' | 'tar';
  path: string;
  cwd: string;
}

/**
 * Resolves the best available extraction tool for .7z archives.
 * Prioritizes the bundled 7z.exe (with 7z.dll), falling back to system 7-Zip, then tar.exe.
 */
export function resolveArchiveExtractor(): ArchiveExtractor | null {
  // 1. Packaged application resources (bundled in NSIS installer: resources/bin/7z.exe)
  if (process.resourcesPath) {
    const bundled7z = path.join(process.resourcesPath, 'bin', '7z.exe');
    if (fs.existsSync(bundled7z)) {
      return { type: '7z', path: bundled7z, cwd: path.dirname(bundled7z) };
    }
  }

  // 2. Application path (development mode / unpacked)
  if (app && typeof app.getAppPath === 'function') {
    try {
      const app7z = path.join(app.getAppPath(), 'bin', '7z.exe');
      if (fs.existsSync(app7z)) {
        return { type: '7z', path: app7z, cwd: path.dirname(app7z) };
      }
    } catch {}
  }

  // 3. Local repo bin directory
  const local7z = path.join(process.cwd(), 'bin', '7z.exe');
  if (fs.existsSync(local7z)) {
    return { type: '7z', path: local7z, cwd: path.dirname(local7z) };
  }

  // 4. Executable sibling directory
  try {
    const execDir = path.dirname(process.execPath);
    const execBin7z = path.join(execDir, 'bin', '7z.exe');
    if (fs.existsSync(execBin7z)) {
      return { type: '7z', path: execBin7z, cwd: path.dirname(execBin7z) };
    }
    const execRes7z = path.join(execDir, 'resources', 'bin', '7z.exe');
    if (fs.existsSync(execRes7z)) {
      return { type: '7z', path: execRes7z, cwd: path.dirname(execRes7z) };
    }
  } catch {}

  // 5. Node modules vendor (development fallback)
  const vendor7z = path.join(process.cwd(), 'node_modules', 'electron-winstaller', 'vendor', '7z-x64.exe');
  if (fs.existsSync(vendor7z)) {
    return { type: '7z', path: vendor7z, cwd: path.dirname(vendor7z) };
  }

  // 6. User installed 7-Zip in standard system paths
  const systemCandidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  for (const cand of systemCandidates) {
    if (fs.existsSync(cand)) {
      return { type: '7z', path: cand, cwd: path.dirname(cand) };
    }
  }

  const fromPath7z = findExecutableInPath('7z.exe');
  if (fromPath7z) {
    return { type: '7z', path: fromPath7z, cwd: path.dirname(fromPath7z) };
  }
  const fromPath7za = findExecutableInPath('7za.exe');
  if (fromPath7za) {
    return { type: '7z', path: fromPath7za, cwd: path.dirname(fromPath7za) };
  }

  // 7. Fallback to Windows built-in tar.exe (for systems where bsdtar supports .7z)
  const tarFromPath = findExecutableInPath('tar.exe');
  if (tarFromPath) {
    return { type: 'tar', path: tarFromPath, cwd: process.cwd() };
  }
  const sysTar = 'C:\\Windows\\System32\\tar.exe';
  if (fs.existsSync(sysTar)) {
    return { type: 'tar', path: sysTar, cwd: process.cwd() };
  }

  return null;
}

/**
 * Initiates the download and extraction of the Faster-Whisper-XXL engine.
 */
export async function downloadWhisperEngine(): Promise<{ success: boolean; whisperPath?: string; error?: string }> {
  if (engineState.isDownloading) {
    return { success: false, error: 'Engine download is already in progress' };
  }

  const userData = app ? resolveUserDataPath() : path.join(process.env.APPDATA || '', 'Kaiko');
  const targetDir = path.join(userData, 'bin', 'faster-whisper-xxl');
  currentTargetDir = targetDir;

  const tempDir = app && typeof app.getPath === 'function' ? app.getPath('temp') : process.cwd();
  const tempArchive = path.join(tempDir, `Faster-Whisper-XXL-windows-${Date.now()}.7z`);
  currentTempArchivePath = tempArchive;

  activeAbortController = new AbortController();

  engineState = {
    isDownloading: true,
    phase: 'downloading',
    percent: 0,
    transferred: 0,
    total: DEFAULT_EXPECTED_SIZE,
    bytesPerSecond: 0,
    error: null,
    whisperPath: null,
    message: 'Connecting to download server...',
  };
  broadcastState();

  try {
    const { url, size } = await resolveReleaseAsset();
    if (activeAbortController?.signal.aborted) {
      throw new Error('Download cancelled by user');
    }

    engineState.total = size;
    engineState.message = 'Downloading Faster-Whisper-XXL standalone archive...';
    broadcastState();

    const resp = await fetch(url, {
      signal: activeAbortController?.signal,
      headers: { 'User-Agent': 'Kaiko-Media-Center' },
    });

    if (!resp.ok) {
      throw new Error(`HTTP error ${resp.status} while fetching archive`);
    }

    const headerLen = parseInt(resp.headers.get('content-length') || '0', 10);
    const totalBytes = headerLen > 0 ? headerLen : size;
    engineState.total = totalBytes;

    if (!resp.body) {
      throw new Error('Response body stream is empty');
    }

    const fileStream = fs.createWriteStream(tempArchive);
    const reader = resp.body.getReader();

    let transferred = 0;
    let lastTime = Date.now();
    let lastBytes = 0;

    while (true) {
      if (activeAbortController?.signal.aborted) {
        fileStream.destroy();
        try { if (fs.existsSync(tempArchive)) fs.unlinkSync(tempArchive); } catch {}
        throw new Error('Download cancelled by user');
      }

      const { done, value } = await reader.read();
      if (done) break;

      fileStream.write(value);
      transferred += value.length;

      const now = Date.now();
      if (now - lastTime >= 200) {
        const bps = Math.round(((transferred - lastBytes) / (now - lastTime)) * 1000);
        lastTime = now;
        lastBytes = transferred;
        const pct = totalBytes > 0 ? Math.min(99, Math.round((transferred / totalBytes) * 100)) : 0;

        engineState.transferred = transferred;
        engineState.bytesPerSecond = Math.max(0, bps);
        engineState.percent = pct;
        engineState.message = `Downloading Faster-Whisper-XXL (${pct}%)...`;
        broadcastState();
      }
    }

    fileStream.end();
    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', () => resolve());
      fileStream.on('error', reject);
    });

    if (activeAbortController?.signal.aborted) {
      try { if (fs.existsSync(tempArchive)) fs.unlinkSync(tempArchive); } catch {}
      throw new Error('Download cancelled by user');
    }

    // Phase: Extracting
    engineState.phase = 'extracting';
    engineState.percent = 0;
    engineState.bytesPerSecond = 0;
    engineState.message = 'Extracting Faster-Whisper-XXL engine into application storage...';
    broadcastState();

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const extractor = resolveArchiveExtractor();
    if (!extractor) {
      throw new Error('No archive extraction tool found (neither bundled 7z.exe nor system tar.exe available)');
    }

    console.log(`[WhisperEngineDownloader] Extracting via ${extractor.type} (${extractor.path}) to ${targetDir}`);

    await new Promise<void>((resolve, reject) => {
      let args: string[] = [];
      if (extractor.type === '7z') {
        // -y: assume yes on all queries, -aoa: overwrite all, -bsp1: stream extraction percentage to stdout
        args = ['x', tempArchive, `-o${targetDir}`, '-y', '-aoa', '-bsp1'];
      } else {
        args = ['-xf', tempArchive, '-C', targetDir];
      }

      const child = spawn(extractor.path, args, {
        cwd: extractor.cwd,
        windowsHide: true,
      });
      activeExtractProcess = child;

      let stdoutText = '';
      let stderrText = '';

      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        stdoutText += text;
        if (extractor.type === '7z') {
          const match = text.match(/(\d+)%/);
          if (match) {
            const pct = parseInt(match[1], 10);
            if (!isNaN(pct) && pct >= 0 && pct <= 100) {
              engineState.percent = pct;
              engineState.message = `Extracting Faster-Whisper-XXL engine (${pct}%)...`;
              broadcastState();
            }
          }
        }
      });

      child.stderr?.on('data', (chunk) => {
        stderrText += chunk.toString();
      });

      child.on('error', (err) => {
        activeExtractProcess = null;
        reject(new Error(`Failed to run ${extractor.type} extraction tool: ${err.message}`));
      });

      child.on('close', (code) => {
        activeExtractProcess = null;
        if (code === 0) {
          resolve();
        } else {
          const detail = (stderrText || stdoutText).trim();
          const cleanDetail = detail ? detail.replace(/\r?\n/g, ' ').slice(0, 300) : '';
          reject(new Error(`Extraction process failed with exit code ${code}${cleanDetail ? `: ${cleanDetail}` : ''}`));
        }
      });
    });

    // Cleanup archive
    try { if (fs.existsSync(tempArchive)) fs.unlinkSync(tempArchive); } catch {}
    currentTempArchivePath = null;

    // Locate the extracted executable
    const exePath = findExecutableInDir(targetDir, 'faster-whisper-xxl.exe');
    if (!exePath || !fs.existsSync(exePath)) {
      throw new Error(`Extraction finished, but faster-whisper-xxl.exe was not found inside ${targetDir}`);
    }

    // Persist path in settings and refresh binary detection
    storage.updateSettings({ whisperPath: exePath });
    autoDetectWhisperPath(true);

    engineState = {
      isDownloading: false,
      phase: 'completed',
      percent: 100,
      transferred: totalBytes,
      total: totalBytes,
      bytesPerSecond: 0,
      error: null,
      whisperPath: exePath,
      message: 'Faster-Whisper-XXL engine installed and configured successfully!',
    };
    broadcastState();

    try {
      if (Notification.isSupported()) {
        new Notification({
          title: 'Kaiko - Faster-Whisper Ready',
          body: 'Faster-Whisper-XXL engine has been downloaded and configured successfully.',
          silent: true,
        }).show();
      }
    } catch {}

    return { success: true, whisperPath: exePath };
  } catch (err: any) {
    const isCancelled = err?.message?.includes('cancelled');
    try { if (currentTempArchivePath && fs.existsSync(currentTempArchivePath)) fs.unlinkSync(currentTempArchivePath); } catch {}
    currentTempArchivePath = null;

    engineState = {
      isDownloading: false,
      phase: isCancelled ? 'idle' : 'error',
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      error: isCancelled ? null : (err?.message || 'Failed to download Faster-Whisper engine'),
      whisperPath: null,
      message: isCancelled ? 'Download cancelled' : `Error: ${err?.message || 'Download failed'}`,
    };
    broadcastState();

    return { success: false, error: err?.message || 'Failed to download engine' };
  } finally {
    activeAbortController = null;
    activeExtractProcess = null;
  }
}

/**
 * Cancels any active Faster-Whisper engine download or extraction.
 */
export async function cancelWhisperEngineDownload(): Promise<boolean> {
  if (!engineState.isDownloading) return false;

  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }

  if (activeExtractProcess) {
    try {
      activeExtractProcess.kill();
    } catch {}
    activeExtractProcess = null;
  }

  if (currentTempArchivePath) {
    try {
      if (fs.existsSync(currentTempArchivePath)) {
        fs.unlinkSync(currentTempArchivePath);
      }
    } catch {}
    currentTempArchivePath = null;
  }

  engineState = {
    isDownloading: false,
    phase: 'idle',
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    error: null,
    whisperPath: null,
    message: 'Download cancelled',
  };
  broadcastState();

  return true;
}

/**
 * Deletes the installed Faster-Whisper-XXL engine from application storage.
 */
export async function deleteWhisperEngine(): Promise<{ success: boolean; error?: string }> {
  try {
    if (engineState.isDownloading) {
      await cancelWhisperEngineDownload();
    }

    const userData = app ? resolveUserDataPath() : path.join(process.env.APPDATA || '', 'Kaiko');
    const kaikoDir = path.join(userData, 'bin', 'faster-whisper-xxl');

    if (fs.existsSync(kaikoDir)) {
      try {
        fs.rmSync(kaikoDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (rmErr: any) {
        console.warn('[WhisperEngineDownloader] Failed to remove kaikoDir:', rmErr);
      }
    }

    const settings = storage.getSettings();
    if (settings.whisperPath) {
      try {
        const resolvedWhisper = path.resolve(settings.whisperPath);
        const resolvedUserData = path.resolve(userData);
        if (resolvedWhisper.startsWith(resolvedUserData) && fs.existsSync(resolvedWhisper)) {
          try {
            fs.rmSync(resolvedWhisper, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          } catch {}
        }
      } catch {}
    }

    // Always clear saved whisperPath in settings and invalidate detection cache
    storage.updateSettings({ whisperPath: '' });
    autoDetectWhisperPath(true);

    engineState = {
      isDownloading: false,
      phase: 'idle',
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      error: null,
      whisperPath: null,
      message: '',
    };
    broadcastState();

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Failed to delete engine' };
  }
}

