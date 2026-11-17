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
  return '1.0.11';
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
let activeDownloadPromise: Promise<{ success: boolean; error?: string }> | null = null;
// Progress is tracked per phase ('delta' vs 'full'); a phase restart (electron-updater
// falling back from differential to full download) resets these via resetProgressWindow().
let phaseMaxPercent = 0;
let phaseMaxTransferred = 0;
let lastProgressTotal = 0;
let currentPhase: 'delta' | 'full' = 'full';
let startupUpdatePayload: UpdateInfoPayload | null = null;

function resetProgressWindow(total: number, phase: 'delta' | 'full') {
  phaseMaxPercent = 1;
  phaseMaxTransferred = 0;
  lastProgressTotal = total;
  currentPhase = phase;
}

export function getStartupUpdateInfo(): UpdateInfoPayload | null {
  return startupUpdatePayload;
}

function broadcastState() {
  const win = getMainWindowRef ? getMainWindowRef() : null;
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:state-changed', { ...updaterState });
  }
}

function broadcastStartupPrompt(updateInfo: UpdateInfoPayload) {
  startupUpdatePayload = updateInfo;
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

export async function fetchReleaseNotesForVersion(version: string): Promise<string | null> {
  if (!version) return null;
  try {
    const cleanTag = version.startsWith('v') ? version : `v${version}`;
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${cleanTag}`, {
      headers: { 'User-Agent': `Kaiko/${updaterState.currentVersion || getAppVersion()}` },
    });
    if (resp.ok) {
      const data: any = await resp.json();
      if (data && typeof data.body === 'string' && data.body.trim()) {
        return data.body.trim();
      }
    }
  } catch (e) {
    console.warn(`[Updater] Failed to fetch release notes for tag ${version}:`, e);
  }

  // Fallback to latest release if specific tag fails
  try {
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`, {
      headers: { 'User-Agent': `Kaiko/${updaterState.currentVersion || getAppVersion()}` },
    });
    if (resp.ok) {
      const data: any = await resp.json();
      if (data && typeof data.body === 'string' && data.body.trim()) {
        return data.body.trim();
      }
    }
  } catch {}
  return null;
}

export function initUpdater(mainWindowGetter: () => BrowserWindow | null): void {
  getMainWindowRef = mainWindowGetter;
  updaterState.currentVersion = getAppVersion();

  startPeriodicUpdateCheck();

  const updater = getAutoUpdater();
  if (!updater) return;

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  // Allow differential blockmap downloads when falling back to electron-updater.
  (updater as any).disableDifferentialDownload = false;

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

  updater.on('update-available', async (info: UpdateInfo) => {
    const rawNotes = info.releaseNotes;
    let notes: string | null = null;
    if (typeof rawNotes === 'string') {
      notes = rawNotes;
    } else if (Array.isArray(rawNotes)) {
      notes = rawNotes.map((n) => (typeof n === 'string' ? n : n.note || '')).join('\n');
    }

    if (!notes || !notes.trim()) {
      notes = await fetchReleaseNotesForVersion(info.version);
    }

    const dlUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${info.version}/Kaiko-Setup-${info.version}.exe`;
    const firstFile = Array.isArray((info as any).files) && (info as any).files.length > 0 ? (info as any).files[0] : null;
    const payload: UpdateInfoPayload = {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: notes,
      downloadUrl: dlUrl,
      fileName: `Kaiko-Setup-${info.version}.exe`,
      fileSize: typeof firstFile?.size === 'number' ? firstFile.size : null,
      sha512: firstFile?.sha512 || (info as any).sha512 || null,
    };

    updaterState.status = 'available';
    updaterState.updateInfo = payload;
    updaterState.error = null;
    broadcastState();

    if (isStartupCheckInProgress) {
      isStartupCheckInProgress = false;
      broadcastStartupPrompt(payload);
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
    const total = progress.total || 0;
    const transferred = progress.transferred || 0;
    // Differential download silently falls back to a full download: transferred restarts
    // from ~0 while the total jumps to the full installer size. Detect that and start a
    // new progress window so the UI shows a reset instead of a stuck monotonic percent.
    const phaseRestart = lastProgressTotal > 0 && total > lastProgressTotal * 1.5 && transferred < phaseMaxTransferred;
    if (phaseRestart) {
      resetProgressWindow(total, 'full');
    }
    const pct = typeof progress.percent === 'number' ? Math.round(progress.percent) : 0;
    phaseMaxPercent = Math.max(phaseMaxPercent, Math.min(100, pct));
    phaseMaxTransferred = Math.max(phaseMaxTransferred, transferred);
    lastProgressTotal = Math.max(lastProgressTotal, total);
    updaterState.downloadProgress = {
      percent: phaseMaxPercent,
      bytesPerSecond: Math.max(0, Math.round(progress.bytesPerSecond || 0)),
      transferred: phaseMaxTransferred,
      total: lastProgressTotal,
      phase: currentPhase,
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
      (updater as any).disableDifferentialDownload = false;
      updater.setFeedURL({
        provider: 'github',
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
      });

      const res = await updater.checkForUpdates();
      if (res && res.updateInfo) {
        checkedViaAutoUpdater = true;
        const info = res.updateInfo;
        const tag = (info.version || '').replace(/^v/i, '').trim();
        const cur = updaterState.currentVersion;

        let notes: string | null = null;
        if (typeof info.releaseNotes === 'string') {
          notes = info.releaseNotes;
        } else if (Array.isArray(info.releaseNotes)) {
          notes = info.releaseNotes.map((n: any) => (typeof n === 'string' ? n : n.note || '')).join('\n');
        }

        if (!notes || !notes.trim()) {
          notes = await fetchReleaseNotesForVersion(tag);
        }

        const dlUrl = tag
          ? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${tag}/Kaiko-Setup-${tag}.exe`
          : null;
        const firstFile = Array.isArray((info as any).files) && (info as any).files.length > 0 ? (info as any).files[0] : null;
        const payload: UpdateInfoPayload = {
          version: tag,
          releaseDate: info.releaseDate,
          releaseNotes: notes,
          downloadUrl: dlUrl,
          fileName: tag ? `Kaiko-Setup-${tag}.exe` : null,
          fileSize: typeof firstFile?.size === 'number' ? firstFile.size : null,
          sha512: firstFile?.sha512 || (info as any).sha512 || null,
        };

        if (tag && isNewerVersion(tag, cur)) {
          updaterState.status = 'available';
          updaterState.updateInfo = payload;
          updaterState.error = null;
          broadcastState();

          if (isStartupCheckInProgress) {
            isStartupCheckInProgress = false;
            broadcastStartupPrompt(payload);
          }
          return { ...updaterState };
        } else {
          updaterState.status = 'not-available';
          updaterState.updateInfo = tag ? { version: tag, releaseNotes: notes } : null;
          updaterState.error = null;
          isStartupCheckInProgress = false;
          broadcastState();
          return { ...updaterState };
        }
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

const PARALLEL_DOWNLOAD_CONNECTIONS = 6;
const PARALLEL_MIN_SIZE_BYTES = 4 * 1024 * 1024;
const DELTA_MAX_RATIO = 0.75;
const DELTA_COALESCE_GAP_BYTES = 16 * 1024;
const DELTA_MAX_MERGED_RANGE_BYTES = 4 * 1024 * 1024;

export interface BlockMapFile {
  name: string;
  offset?: number;
  sizes: number[];
  checksums: string[];
}

export interface BlockMapData {
  version?: string;
  files: BlockMapFile[];
}

export type DeltaOperation =
  | { kind: 'copy'; oldStart: number; oldEnd: number; newStart: number; newEnd: number }
  | { kind: 'download'; newStart: number; newEnd: number };

export function parseLatestYmlMeta(rawYaml: string): { sha512?: string; size?: number; path?: string } {
  if (!rawYaml || typeof rawYaml !== 'string') return {};
  const shaMatch = rawYaml.match(/^\s*sha512:\s*['"]?([A-Za-z0-9+/=]+)['"]?\s*$/m);
  const sizeMatch = rawYaml.match(/^\s*size:\s*(\d+)\s*$/m);
  const pathMatch = rawYaml.match(/^\s*path:\s*['"]?(.+?)['"]?\s*$/m);
  return {
    sha512: shaMatch?.[1],
    size: sizeMatch ? parseInt(sizeMatch[1], 10) : undefined,
    path: pathMatch?.[1],
  };
}

export function computeDeltaOperations(
  oldBlockMap: BlockMapData,
  newBlockMap: BlockMapData
): { operations: DeltaOperation[]; downloadBytes: number; copyBytes: number; totalNewBytes: number } {
  if (!oldBlockMap?.files?.length || !newBlockMap?.files?.length) {
    throw new Error('Blockmap has no files');
  }
  if (oldBlockMap.version !== newBlockMap.version) {
    throw new Error(`Blockmap version mismatch (${oldBlockMap.version} vs ${newBlockMap.version})`);
  }

  const newFile = newBlockMap.files[0];
  const oldFile = oldBlockMap.files.find((f) => f.name === newFile.name) || oldBlockMap.files[0];
  if (!oldFile || newFile.sizes.length !== newFile.checksums.length || oldFile.sizes.length !== oldFile.checksums.length) {
    throw new Error('Malformed blockmap arrays');
  }

  const oldChecksumMap = new Map<string, { offset: number; size: number }>();
  let oldCursor = oldFile.offset ?? 0;
  for (let i = 0; i < oldFile.checksums.length; i++) {
    const size = oldFile.sizes[i];
    const checksum = oldFile.checksums[i];
    if (!oldChecksumMap.has(checksum)) {
      oldChecksumMap.set(checksum, { offset: oldCursor, size });
    }
    oldCursor += size;
  }

  const rawOps: DeltaOperation[] = [];
  let newCursor = newFile.offset ?? 0;
  for (let i = 0; i < newFile.checksums.length; i++) {
    const size = newFile.sizes[i];
    const checksum = newFile.checksums[i];
    const match = oldChecksumMap.get(checksum);
    const prev = rawOps[rawOps.length - 1];

    if (match && match.size === size) {
      if (prev && prev.kind === 'copy' && prev.oldEnd === match.offset && prev.newEnd === newCursor) {
        prev.oldEnd += size;
        prev.newEnd += size;
      } else {
        rawOps.push({
          kind: 'copy',
          oldStart: match.offset,
          oldEnd: match.offset + size,
          newStart: newCursor,
          newEnd: newCursor + size,
        });
      }
    } else if (prev && prev.kind === 'download' && prev.newEnd === newCursor) {
      prev.newEnd += size;
    } else {
      rawOps.push({
        kind: 'download',
        newStart: newCursor,
        newEnd: newCursor + size,
      });
    }
    newCursor += size;
  }

  // Coalesce tiny COPY gaps between DOWNLOAD chunks so one HTTP Range request
  // covers localized edits cleanly without thousands of extra round-trips.
  const operations: DeltaOperation[] = [];
  for (let i = 0; i < rawOps.length; i++) {
    const op = rawOps[i];
    const prev = operations[operations.length - 1];
    const next = rawOps[i + 1];
    if (
      op.kind === 'copy' &&
      prev?.kind === 'download' &&
      next?.kind === 'download' &&
      op.newEnd - op.newStart <= DELTA_COALESCE_GAP_BYTES &&
      next.newEnd - prev.newStart <= DELTA_MAX_MERGED_RANGE_BYTES
    ) {
      prev.newEnd = next.newEnd;
      i++;
      continue;
    }
    operations.push({ ...op });
  }

  let downloadBytes = 0;
  let copyBytes = 0;
  for (const op of operations) {
    const len = op.newEnd - op.newStart;
    if (op.kind === 'download') downloadBytes += len;
    else copyBytes += len;
  }

  return { operations, downloadBytes, copyBytes, totalNewBytes: newCursor };
}

function publishProgress(transferred: number, total: number, bytesPerSecond: number, phase: 'delta' | 'full') {
  phaseMaxTransferred = Math.max(phaseMaxTransferred, transferred);
  lastProgressTotal = total;
  const currentPercent = total > 0 ? Math.min(100, Math.max(1, Math.round((transferred / total) * 100))) : 0;
  phaseMaxPercent = Math.max(phaseMaxPercent, currentPercent);
  updaterState.downloadProgress = {
    percent: phaseMaxPercent,
    bytesPerSecond: Math.max(0, bytesPerSecond),
    transferred,
    total,
    phase,
  };
  broadcastState();
}

function resolveUpdaterCacheDir(): string | null {
  const path = require('path');
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'anime-media-center-updater');
  }
  try {
    if (app && typeof app.getPath === 'function') {
      return path.join(path.dirname(app.getPath('appData')), 'Local', 'anime-media-center-updater');
    }
  } catch {}
  return null;
}

async function fetchBlockMap(url: string, userAgent: string): Promise<BlockMapData> {
  const zlib = require('zlib');
  const resp = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!resp.ok) {
    throw new Error(`Blockmap HTTP ${resp.status} for ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
}

async function fetchReleaseYmlMeta(version: string, userAgent: string): Promise<{ sha512?: string; size?: number }> {
  const url = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}/latest.yml`;
  const resp = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!resp.ok) return {};
  const text = await resp.text();
  return parseLatestYmlMeta(text);
}

async function verifyFileSha512(filePath: string, expectedSha512: string): Promise<boolean> {
  const fs = require('fs');
  const crypto = require('crypto');
  const hash = crypto.createHash('sha512');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('base64') === expectedSha512;
}

async function tryParallelDeltaDownload(
  dlUrl: string,
  targetPath: string,
  userAgent: string,
  targetVersion: string,
  expectedSha512?: string | null,
  expectedSize?: number | null
): Promise<boolean> {
  const fs = require('fs');
  const path = require('path');
  const zlib = require('zlib');

  const cacheDir = resolveUpdaterCacheDir();
  if (!cacheDir) return false;
  const oldInstallerPath = path.join(cacheDir, 'installer.exe');
  if (!fs.existsSync(oldInstallerPath)) return false;

  const oldStat = fs.statSync(oldInstallerPath);
  if (!oldStat.isFile() || oldStat.size <= 0) return false;

  const curVer = updaterState.currentVersion;
  let newBlockMap: BlockMapData;
  let oldBlockMap: BlockMapData;

  try {
    const newBlockMapPromise = fetchBlockMap(`${dlUrl}.blockmap`, userAgent);
    const cachedOldBmPath = path.join(cacheDir, `blockmap-${curVer}.json.gz`);
    let oldBlockMapPromise: Promise<BlockMapData>;
    if (fs.existsSync(cachedOldBmPath)) {
      oldBlockMapPromise = fs.promises
        .readFile(cachedOldBmPath)
        .then((buf: Buffer) => JSON.parse(zlib.gunzipSync(buf).toString('utf8')));
    } else {
      const oldBmUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${curVer}/Kaiko-Setup-${curVer}.exe.blockmap`;
      oldBlockMapPromise = fetchBlockMap(oldBmUrl, userAgent).then(async (bm) => {
        try {
          await fs.promises.mkdir(cacheDir, { recursive: true });
          await fs.promises.writeFile(cachedOldBmPath, zlib.gzipSync(JSON.stringify(bm)));
        } catch {}
        return bm;
      });
    }

    [newBlockMap, oldBlockMap] = await Promise.all([newBlockMapPromise, oldBlockMapPromise]);
  } catch (err: any) {
    console.warn('[Updater] Blockmap fetch failed, falling back to full installer:', err?.message || err);
    return false;
  }

  const oldFileEntry = oldBlockMap.files?.[0];
  if (!oldFileEntry) return false;
  const expectedOldSize = (oldFileEntry.offset ?? 0) + oldFileEntry.sizes.reduce((a, b) => a + b, 0);
  if (oldStat.size !== expectedOldSize) {
    console.warn(`[Updater] Cached installer size (${oldStat.size}) != v${curVer} blockmap (${expectedOldSize}), using full download`);
    return false;
  }

  let plan: ReturnType<typeof computeDeltaOperations>;
  try {
    plan = computeDeltaOperations(oldBlockMap, newBlockMap);
  } catch (err: any) {
    console.warn('[Updater] Delta plan failed, using full download:', err?.message || err);
    return false;
  }

  const { operations, downloadBytes, totalNewBytes } = plan;
  if (downloadBytes <= 0 || totalNewBytes <= 0 || downloadBytes > totalNewBytes * DELTA_MAX_RATIO) {
    console.log(`[Updater] Delta (${downloadBytes} B) exceeds threshold for ${totalNewBytes} B, using full download`);
    return false;
  }
  if (expectedSize && expectedSize > 0 && totalNewBytes !== expectedSize) {
    console.warn(`[Updater] Blockmap total (${totalNewBytes}) != expectedSize (${expectedSize}), using full download`);
    return false;
  }

  let sha512 = expectedSha512 || null;
  if (!sha512) {
    try {
      const ymlMeta = await fetchReleaseYmlMeta(targetVersion, userAgent);
      sha512 = ymlMeta.sha512 || null;
    } catch {}
  }
  if (!sha512) {
    console.warn('[Updater] No expected SHA-512 for delta verification, falling back to full download');
    return false;
  }

  let probeResp: Response;
  try {
    probeResp = await fetch(dlUrl, { headers: { 'User-Agent': userAgent, Range: 'bytes=0-0' } });
    try { await probeResp.body?.cancel(); } catch {}
  } catch {
    return false;
  }
  if (probeResp.status !== 206) {
    return false;
  }
  const resolvedUrl = probeResp.url || dlUrl;

  console.log(
    `[Updater] Delta download: ${(downloadBytes / 1048576).toFixed(2)} MB of ${(totalNewBytes / 1048576).toFixed(2)} MB ` +
    `(${Math.round((downloadBytes / totalNewBytes) * 100)}% across ${operations.filter((o) => o.kind === 'download').length} ranges)`
  );

  resetProgressWindow(downloadBytes, 'delta');
  updaterState.downloadProgress = {
    percent: 1,
    bytesPerSecond: 0,
    transferred: 0,
    total: downloadBytes,
    phase: 'delta',
  };
  broadcastState();

  const oldHandle = await fs.promises.open(oldInstallerPath, 'r');
  const newHandle = await fs.promises.open(targetPath, 'w');
  const abortCtrl = new AbortController();

  try {
    const copyBuf = Buffer.allocUnsafe(1024 * 1024);
    for (const op of operations) {
      if (op.kind !== 'copy') continue;
      let srcOffset = op.oldStart;
      let dstOffset = op.newStart;
      let remaining = op.oldEnd - op.oldStart;
      while (remaining > 0) {
        const chunkLen = Math.min(copyBuf.length, remaining);
        const { bytesRead } = await oldHandle.read(copyBuf, 0, chunkLen, srcOffset);
        if (bytesRead <= 0) {
          throw new Error(`Unexpected EOF reading cached installer at offset ${srcOffset}`);
        }
        await newHandle.write(copyBuf, 0, bytesRead, dstOffset);
        srcOffset += bytesRead;
        dstOffset += bytesRead;
        remaining -= bytesRead;
      }
    }

    const downloadOps = operations.filter((op): op is Extract<DeltaOperation, { kind: 'download' }> => op.kind === 'download');
    let nextOpIndex = 0;
    let transferred = 0;
    let lastTime = Date.now();
    let lastBytes = 0;

    const fetchRangeWithRetry = async (op: Extract<DeltaOperation, { kind: 'download' }>) => {
      const expectedLen = op.newEnd - op.newStart;
      for (let attempt = 0; attempt < 2; attempt++) {
        let segTransferred = 0;
        let writeOffset = op.newStart;
        try {
          const segResp = await fetch(resolvedUrl, {
            headers: { 'User-Agent': userAgent, Range: `bytes=${op.newStart}-${op.newEnd - 1}` },
            signal: abortCtrl.signal,
          });
          if (segResp.status !== 206 || !segResp.body) {
            throw new Error(`Segment HTTP ${segResp.status} for ${op.newStart}-${op.newEnd - 1}`);
          }
          const reader = segResp.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await newHandle.write(value, 0, value.length, writeOffset);
            writeOffset += value.length;
            segTransferred += value.length;
            transferred += value.length;

            const now = Date.now();
            if (now - lastTime >= 150) {
              const elapsed = Math.max(1, now - lastTime);
              const bps = Math.round(((transferred - lastBytes) / elapsed) * 1000);
              lastTime = now;
              lastBytes = transferred;
              publishProgress(transferred, downloadBytes, bps, 'delta');
            }
          }
          if (segTransferred !== expectedLen) {
            throw new Error(`Truncated delta range ${op.newStart}-${op.newEnd - 1}: got ${segTransferred} of ${expectedLen}`);
          }
          return;
        } catch (err) {
          transferred = Math.max(0, transferred - segTransferred);
          if (attempt === 1 || abortCtrl.signal.aborted) throw err;
        }
      }
    };

    const workerCount = Math.min(PARALLEL_DOWNLOAD_CONNECTIONS, downloadOps.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextOpIndex++;
        if (idx >= downloadOps.length) return;
        await fetchRangeWithRetry(downloadOps[idx]).catch((err) => {
          abortCtrl.abort();
          throw err;
        });
      }
    });

    await Promise.all(workers);
    await newHandle.close();
    await oldHandle.close();

    const finalStat = fs.statSync(targetPath);
    if (finalStat.size !== totalNewBytes) {
      throw new Error(`Assembled delta size ${finalStat.size} != expected ${totalNewBytes}`);
    }
    const shaOk = await verifyFileSha512(targetPath, sha512);
    if (!shaOk) {
      throw new Error('Assembled delta installer failed SHA-512 verification');
    }

    try {
      const targetBmPath = path.join(cacheDir, `blockmap-${targetVersion}.json.gz`);
      await fs.promises.writeFile(targetBmPath, zlib.gzipSync(JSON.stringify(newBlockMap)));
    } catch {}

    downloadedInstallerPath = targetPath;
    updaterState.status = 'downloaded';
    updaterState.downloadProgress = null;
    updaterState.error = null;
    broadcastState();
    return true;
  } catch (err: any) {
    await newHandle.close().catch(() => {});
    await oldHandle.close().catch(() => {});
    try { fs.unlinkSync(targetPath); } catch {}
    console.warn('[Updater] Parallel delta download failed, falling back to full installer:', err?.message || err);
    return false;
  }
}

async function tryParallelRangeDownload(
  url: string,
  targetPath: string,
  userAgent: string,
  expectedSize?: number | null
): Promise<boolean> {
  const fs = require('fs');
  let probeResp: Response;
  try {
    probeResp = await fetch(url, {
      headers: { 'User-Agent': userAgent, Range: 'bytes=0-0' },
    });
  } catch (err: any) {
    console.warn('[Updater] Range probe failed, using single-stream download:', err?.message || err);
    return false;
  }

  try {
    await probeResp.body?.cancel();
  } catch {}

  if (probeResp.status !== 206) {
    return false;
  }

  const contentRange = probeResp.headers.get('content-range') || '';
  const match = contentRange.match(/\/(\d+)$/);
  const rangeTotal = match ? parseInt(match[1], 10) : (expectedSize && expectedSize > 0 ? expectedSize : 0);
  if (!Number.isFinite(rangeTotal) || rangeTotal < PARALLEL_MIN_SIZE_BYTES) {
    return false;
  }

  const resolvedUrl = probeResp.url || url;
  const partCount = PARALLEL_DOWNLOAD_CONNECTIONS;
  const chunkSize = Math.ceil(rangeTotal / partCount);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < partCount; i++) {
    const start = i * chunkSize;
    if (start >= rangeTotal) break;
    const end = Math.min(rangeTotal - 1, (i + 1) * chunkSize - 1);
    ranges.push({ start, end });
  }

  resetProgressWindow(rangeTotal, 'full');
  updaterState.downloadProgress = {
    percent: 1,
    bytesPerSecond: 0,
    transferred: 0,
    total: rangeTotal,
    phase: 'full',
  };
  broadcastState();

  const fileHandle = await fs.promises.open(targetPath, 'w');
  const abortCtrl = new AbortController();
  let transferred = 0;
  let lastTime = Date.now();
  let lastBytes = 0;

  const downloadRange = async (start: number, end: number) => {
    const segResp = await fetch(resolvedUrl, {
      headers: { 'User-Agent': userAgent, Range: `bytes=${start}-${end}` },
      signal: abortCtrl.signal,
    });
    if (segResp.status !== 206 || !segResp.body) {
      throw new Error(`Segment HTTP ${segResp.status} for range ${start}-${end}`);
    }

    const reader = segResp.body.getReader();
    const expectedLen = end - start + 1;
    let writeOffset = start;
    let segTransferred = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await fileHandle.write(value, 0, value.length, writeOffset);
      writeOffset += value.length;
      segTransferred += value.length;
      transferred += value.length;

      const now = Date.now();
      if (now - lastTime >= 150) {
        const elapsed = Math.max(1, now - lastTime);
        const bps = Math.round(((transferred - lastBytes) / elapsed) * 1000);
        lastTime = now;
        lastBytes = transferred;
        publishProgress(transferred, rangeTotal, bps, 'full');
      }
    }

    if (segTransferred !== expectedLen) {
      throw new Error(`Truncated segment ${start}-${end}: got ${segTransferred} of ${expectedLen} bytes`);
    }
  };

  const workerPromises = ranges.map(({ start, end }) =>
    downloadRange(start, end).catch((err) => {
      abortCtrl.abort();
      throw err;
    })
  );

  try {
    try {
      await Promise.all(workerPromises);
    } finally {
      await Promise.allSettled(workerPromises);
      await fileHandle.close().catch(() => {});
    }

    if (transferred !== rangeTotal) {
      throw new Error(`Incomplete parallel download: got ${transferred} of ${rangeTotal} bytes`);
    }

    downloadedInstallerPath = targetPath;
    updaterState.status = 'downloaded';
    updaterState.downloadProgress = null;
    updaterState.error = null;
    broadcastState();
    return true;
  } catch (err: any) {
    console.warn('[Updater] Parallel range download failed, falling back to single-stream:', err?.message || err);
    try { fs.unlinkSync(targetPath); } catch {}
    return false;
  }
}

async function downloadDirectAsset(url: string, fileName?: string | null, expectedSize?: number | null): Promise<void> {
  const fs = require('fs');
  const path = require('path');
  const tempDir = (app && typeof app.getPath === 'function') ? app.getPath('temp') : process.cwd();
  const targetName = fileName || `Kaiko-Setup-${updaterState.updateInfo?.version || 'update'}.exe`;
  const targetPath = path.join(tempDir, targetName);
  const userAgent = `Kaiko/${updaterState.currentVersion}`;

  const parallelDone = await tryParallelRangeDownload(url, targetPath, userAgent, expectedSize);
  if (parallelDone) {
    return;
  }

  const resp = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} while downloading installer`);
  }

  const headerLen = parseInt(resp.headers.get('content-length') || '0', 10);
  const total = (headerLen && headerLen > 0)
    ? headerLen
    : (expectedSize && expectedSize > 0 ? expectedSize : 0);
  if (!resp.body) {
    throw new Error('Response body is empty');
  }

  const fileStream = fs.createWriteStream(targetPath);
  const reader = resp.body.getReader();
  let transferred = 0;
  let lastTime = Date.now();
  let lastBytes = 0;

  resetProgressWindow(total, 'full');

  // Immediate initial progress tick so the UI progress bar wakes up at 1%
  updaterState.downloadProgress = {
    percent: 1,
    bytesPerSecond: 0,
    transferred: 0,
    total,
    phase: 'full',
  };
  broadcastState();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(value);
      transferred += value.length;
      phaseMaxTransferred = Math.max(phaseMaxTransferred, transferred);

      const now = Date.now();
      if (now - lastTime >= 150) {
        const elapsed = Math.max(1, now - lastTime);
        const bps = Math.round(((transferred - lastBytes) / elapsed) * 1000);
        lastTime = now;
        lastBytes = transferred;
        publishProgress(transferred, total, bps, 'full');
      }
    }
    await new Promise<void>((resolve, reject) => {
      if (fileStream.writableFinished) {
        resolve();
        return;
      }
      fileStream.once('finish', () => resolve());
      fileStream.once('error', (err: any) => reject(err));
      fileStream.end();
    });

    if (total > 0 && transferred !== total) {
      throw new Error(`Incomplete installer download: got ${transferred} of ${total} bytes`);
    }

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
  if (activeDownloadPromise) {
    return activeDownloadPromise;
  }
  if (updaterState.status === 'downloaded') {
    return { success: true };
  }

  // The modal doubles as a release-notes viewer for the current version; never
  // re-download the same (or older) version through that path.
  if (!isNewerVersion(updaterState.updateInfo?.version, updaterState.currentVersion)) {
    updaterState.status = 'not-available';
    updaterState.error = null;
    broadcastState();
    return { success: false, error: 'You are already running the latest version' };
  }

  resetProgressWindow(updaterState.updateInfo?.fileSize || 0, 'full');

  activeDownloadPromise = (async () => {
    try {
      updaterState.status = 'downloading';
      const initialTotal = updaterState.updateInfo?.fileSize || 0;
      updaterState.downloadProgress = { percent: 1, bytesPerSecond: 0, transferred: 0, total: initialTotal, phase: 'full' };
      broadcastState();

      let dlUrl = updaterState.updateInfo?.downloadUrl;
      const targetVersion = updaterState.updateInfo?.version;
      if (!dlUrl && targetVersion) {
        dlUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${targetVersion}/Kaiko-Setup-${targetVersion}.exe`;
        if (updaterState.updateInfo) {
          updaterState.updateInfo.downloadUrl = dlUrl;
          updaterState.updateInfo.fileName = `Kaiko-Setup-${targetVersion}.exe`;
        }
      }

      if (dlUrl && targetVersion) {
        const path = require('path');
        const tempDir = (app && typeof app.getPath === 'function') ? app.getPath('temp') : process.cwd();
        const targetName = updaterState.updateInfo?.fileName || `Kaiko-Setup-${targetVersion}.exe`;
        const targetPath = path.join(tempDir, targetName);
        const userAgent = `Kaiko/${updaterState.currentVersion}`;

        // 1. Fast parallel blockmap delta download when the installed installer is cached locally.
        const deltaDone = await tryParallelDeltaDownload(
          dlUrl,
          targetPath,
          userAgent,
          targetVersion,
          updaterState.updateInfo?.sha512,
          updaterState.updateInfo?.fileSize
        );
        if (deltaDone) {
          return { success: true };
        }

        // 2. Direct multi-connection full download fallback.
        try {
          console.log('[Updater] Downloading installer via direct multi-connection transfer:', dlUrl);
          await downloadDirectAsset(dlUrl, updaterState.updateInfo?.fileName, updaterState.updateInfo?.fileSize);
          return { success: true };
        } catch (directErr: any) {
          console.warn('[Updater] Direct download failed, falling back to electron-updater:', directErr?.message || directErr);
        }
      }

      // 3. Fallback to electron-updater
      const updater = getAutoUpdater();
      if (updater && app && app.isPackaged) {
        try {
          (updater as any).disableDifferentialDownload = false;
          console.log('[Updater] Attempting fallback via electron-updater...');
          resetProgressWindow(initialTotal, 'full');
          await updater.downloadUpdate();
          return { success: true };
        } catch (updaterErr: any) {
          console.warn('[Updater] autoUpdater fallback failed:', updaterErr?.message || updaterErr);
        }
      }

      updaterState.status = 'error';
      updaterState.error = 'Could not download update file';
      broadcastState();
      return { success: false, error: updaterState.error };
    } finally {
      activeDownloadPromise = null;
    }
  })();

  return activeDownloadPromise;
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
