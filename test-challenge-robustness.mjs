// test-challenge-robustness.ts
import assert from "assert";
import fs6 from "fs";
import path7 from "path";
import http2 from "http";
import net from "net";

// electron/server.ts
import http from "http";
import url from "url";
import fs4 from "fs";
import path5 from "path";
import crypto from "crypto";
import { spawn as spawn2 } from "child_process";

// electron/storage.ts
import fs from "fs";
import path2 from "path";
import { execSync } from "child_process";

// test-mock-electron.js
import path from "path";
var app = {
  getPath: (name) => path.join(process.cwd(), ".test_storage", name)
};

// electron/storage.ts
var exePathCache = /* @__PURE__ */ new Map();
function findExecutableInPath(exeName) {
  const cached = exePathCache.get(exeName);
  if (cached && Date.now() - cached.time < 6e4) {
    return cached.path;
  }
  let result = null;
  try {
    const out = execSync(`where.exe ${exeName}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && fs.existsSync(lines[0])) {
      result = lines[0];
    }
  } catch {
  }
  exePathCache.set(exeName, { path: result, time: Date.now() });
  return result;
}
var cachedAutoWhisper = null;
function autoDetectWhisperPath(forceFresh = false) {
  if (!forceFresh && cachedAutoWhisper && Date.now() - cachedAutoWhisper.time < 6e4) {
    return cachedAutoWhisper.path;
  }
  let result = "";
  const appData = process.env.APPDATA || "";
  const seWhisper = path2.join(appData, "Subtitle Edit", "SpeechToText", "Purfview-Faster-Whisper-XXL", "faster-whisper-xxl.exe");
  if (fs.existsSync(seWhisper)) {
    result = seWhisper;
  } else {
    const localBin = path2.join(process.cwd(), "bin", "faster-whisper-xxl.exe");
    if (fs.existsSync(localBin)) {
      result = localBin;
    } else {
      const userProfile = process.env.USERPROFILE || "";
      const commonDirs = [
        path2.join(userProfile, "Faster-Whisper-XXL", "faster-whisper-xxl.exe"),
        path2.join(userProfile, "Downloads", "Faster-Whisper-XXL", "faster-whisper-xxl.exe"),
        "C:\\Faster-Whisper-XXL\\faster-whisper-xxl.exe",
        "C:\\Program Files\\Faster-Whisper-XXL\\faster-whisper-xxl.exe"
      ];
      for (const p of commonDirs) {
        if (fs.existsSync(p)) {
          result = p;
          break;
        }
      }
      if (!result) {
        const fromPath = findExecutableInPath("faster-whisper-xxl.exe");
        if (fromPath) result = fromPath;
      }
    }
  }
  cachedAutoWhisper = { path: result, time: Date.now() };
  return result;
}
var cachedAutoFfmpeg = null;
function autoDetectFfmpegPath(knownWhisperPath, forceFresh = false) {
  if (!forceFresh && cachedAutoFfmpeg && Date.now() - cachedAutoFfmpeg.time < 6e4 && cachedAutoFfmpeg.forWhisper === knownWhisperPath) {
    return cachedAutoFfmpeg.path;
  }
  let result = "";
  if (knownWhisperPath && fs.existsSync(knownWhisperPath)) {
    const siblingFfmpeg = path2.join(path2.dirname(knownWhisperPath), "ffmpeg.exe");
    if (fs.existsSync(siblingFfmpeg)) {
      result = siblingFfmpeg;
    }
  }
  if (!result) {
    const appData = process.env.APPDATA || "";
    const seFfmpeg = path2.join(appData, "Subtitle Edit", "SpeechToText", "Purfview-Faster-Whisper-XXL", "ffmpeg.exe");
    if (fs.existsSync(seFfmpeg)) {
      result = seFfmpeg;
    } else {
      const seFfmpegDirect = path2.join(appData, "Subtitle Edit", "ffmpeg.exe");
      if (fs.existsSync(seFfmpegDirect)) {
        result = seFfmpegDirect;
      } else {
        const fromPath = findExecutableInPath("ffmpeg.exe");
        if (fromPath) {
          result = fromPath;
        } else {
          const localAppData = process.env.LOCALAPPDATA || "";
          const userProfile = process.env.USERPROFILE || "";
          const candidates = [
            path2.join(process.cwd(), "bin", "ffmpeg.exe"),
            "C:\\ffmpeg\\bin\\ffmpeg.exe",
            "C:\\ffmpeg\\ffmpeg.exe",
            "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
            "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
            path2.join(localAppData, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
            path2.join(userProfile, "scoop", "shims", "ffmpeg.exe")
          ];
          for (const c of candidates) {
            if (fs.existsSync(c)) {
              result = c;
              break;
            }
          }
        }
      }
    }
  }
  cachedAutoFfmpeg = { path: result, time: Date.now(), forWhisper: knownWhisperPath };
  return result;
}
function autoDetectLibraryRoots() {
  const userProfile = process.env.USERPROFILE || "";
  const videosDir = path2.join(userProfile, "Videos");
  if (fs.existsSync(videosDir)) {
    return [videosDir];
  }
  return [];
}
function renameSyncWithRetry(src, dest, maxRetries = 5) {
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      lastError = err;
      if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
        const delayMs = (attempt + 1) * 30;
        const start = Date.now();
        while (Date.now() - start < delayMs) {
        }
      } else {
        throw err;
      }
    }
  }
  try {
    fs.copyFileSync(src, dest);
    try {
      fs.unlinkSync(src);
    } catch {
    }
  } catch (copyErr) {
    throw lastError || copyErr;
  }
}
function saveJsonSync(targetFile, data) {
  const tmpFile = `${targetFile}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
    renameSyncWithRetry(tmpFile, targetFile, 5);
  } catch (e) {
    console.error(`Failed to atomic write to ${targetFile}:`, e);
    throw e;
  } finally {
    try {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    } catch {
    }
  }
}
var StorageService = class {
  baseDir;
  settingsFile;
  historyFile;
  seasonRulesFile;
  cachedSettings = null;
  settingsMtime = 0;
  historyCache = null;
  seasonRulesCache = null;
  historySaveTimer = null;
  historyDirty = false;
  constructor() {
    try {
      this.baseDir = app ? app.getPath("userData") : path2.join(process.env.APPDATA || "", "anime-media-center");
    } catch {
      this.baseDir = path2.join(process.env.APPDATA || "", "anime-media-center");
    }
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    this.settingsFile = path2.join(this.baseDir, "settings.json");
    this.historyFile = path2.join(this.baseDir, "history.json");
    this.seasonRulesFile = path2.join(this.baseDir, "season-rules.json");
  }
  getThumbnailDir() {
    const dir = path2.join(this.baseDir, "thumbnails");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }
  getSubtitleCacheDir() {
    const dir = path2.join(this.baseDir, "subtitles_cache");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }
  getMetadataCacheDir() {
    const dir = path2.join(this.baseDir, "metadata_cache");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }
  getSettings() {
    try {
      if (fs.existsSync(this.settingsFile)) {
        const stat = fs.statSync(this.settingsFile);
        if (this.cachedSettings && stat.mtimeMs === this.settingsMtime) {
          return this.cachedSettings;
        }
        const raw = fs.readFileSync(this.settingsFile, "utf-8");
        const parsed = JSON.parse(raw);
        const libraryFolders = Array.isArray(parsed.libraryFolders) ? parsed.libraryFolders : parsed.defaultLibraryRoot ? [parsed.defaultLibraryRoot] : autoDetectLibraryRoots();
        const defaultLibraryRoot = parsed.defaultLibraryRoot || (libraryFolders[0] || "");
        let ffmpegPath = typeof parsed.ffmpegPath === "string" ? parsed.ffmpegPath : "";
        let whisperPath = typeof parsed.whisperPath === "string" ? parsed.whisperPath : "";
        if (!whisperPath) {
          whisperPath = autoDetectWhisperPath();
        }
        if (!ffmpegPath) {
          ffmpegPath = autoDetectFfmpegPath(whisperPath);
        }
        const res = {
          ffmpegPath,
          whisperPath,
          defaultLibraryRoot,
          libraryFolders,
          autoPlayNext: parsed.autoPlayNext ?? true,
          subtitlesFontSize: parsed.subtitlesFontSize ?? 38,
          subtitlesOutline: true,
          subtitlesTextColor: parsed.subtitlesTextColor || "#ffffff",
          subtitlesFontFamily: parsed.subtitlesFontFamily || "sans",
          subtitlesBgStyle: parsed.subtitlesBgStyle || "none",
          subtitlesOutlineWidth: parsed.subtitlesOutlineWidth || "thick",
          subtitlesOutlineColor: parsed.subtitlesOutlineColor || "#000000",
          hideDownloadingAnime: parsed.hideDownloadingAnime ?? false
        };
        this.cachedSettings = res;
        this.settingsMtime = stat.mtimeMs;
        return res;
      }
    } catch (e) {
      console.error("Failed to read settings:", e);
    }
    const whisper = autoDetectWhisperPath();
    const ffmpeg = autoDetectFfmpegPath(whisper);
    const roots = autoDetectLibraryRoots();
    const defaults = {
      ffmpegPath: ffmpeg,
      whisperPath: whisper,
      defaultLibraryRoot: roots[0] || "",
      libraryFolders: roots,
      autoPlayNext: true,
      subtitlesFontSize: 38,
      subtitlesOutline: true,
      subtitlesTextColor: "#ffffff",
      subtitlesFontFamily: "sans",
      subtitlesBgStyle: "none",
      subtitlesOutlineWidth: "thick",
      subtitlesOutlineColor: "#000000",
      hideDownloadingAnime: false
    };
    this.cachedSettings = defaults;
    return defaults;
  }
  updateSettings(settings) {
    const current = this.getSettings();
    const updated = { ...current, ...settings };
    if (Array.isArray(updated.libraryFolders) && updated.libraryFolders.length > 0) {
      updated.defaultLibraryRoot = updated.libraryFolders[0];
    } else if (Array.isArray(updated.libraryFolders) && updated.libraryFolders.length === 0) {
      updated.defaultLibraryRoot = "";
    }
    try {
      saveJsonSync(this.settingsFile, updated);
      const stat = fs.statSync(this.settingsFile);
      this.settingsMtime = stat.mtimeMs;
      this.cachedSettings = updated;
    } catch (e) {
      console.error("Failed to write settings:", e);
    }
    return updated;
  }
  getAllPlaybackProgress() {
    if (this.historyCache !== null) {
      return this.historyCache;
    }
    if (fs.existsSync(this.historyFile)) {
      try {
        const raw = fs.readFileSync(this.historyFile, "utf-8");
        this.historyCache = JSON.parse(raw);
        return this.historyCache;
      } catch (e) {
        console.error("Corrupted history.json, archiving to history.json.bak:", e);
        try {
          renameSyncWithRetry(this.historyFile, `${this.historyFile}.bak`, 3);
        } catch {
        }
        this.historyCache = {};
        return this.historyCache;
      }
    }
    this.historyCache = {};
    return this.historyCache;
  }
  savePlaybackProgress(progress) {
    const all = this.getAllPlaybackProgress();
    all[progress.filePath] = progress;
    this.historyDirty = true;
    if (!this.historySaveTimer) {
      this.historySaveTimer = setTimeout(() => {
        this.flushHistory();
      }, 7e3);
    }
  }
  flushHistory() {
    if (this.historySaveTimer) {
      clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
    }
    if (!this.historyDirty || !this.historyCache) return;
    try {
      saveJsonSync(this.historyFile, this.historyCache);
      this.historyDirty = false;
    } catch (e) {
      console.error("Failed to write history:", e);
    }
  }
  getSeasonPreference(folderPath) {
    if (this.seasonRulesCache !== null) {
      return this.seasonRulesCache[folderPath] || null;
    }
    try {
      if (fs.existsSync(this.seasonRulesFile)) {
        const raw = fs.readFileSync(this.seasonRulesFile, "utf-8");
        this.seasonRulesCache = JSON.parse(raw);
        return this.seasonRulesCache[folderPath] || null;
      }
    } catch (e) {
      console.error("Failed to read season rules:", e);
    }
    this.seasonRulesCache = {};
    return null;
  }
  saveSeasonPreference(folderPath, pref) {
    try {
      let rules = {};
      if (this.seasonRulesCache !== null) {
        rules = { ...this.seasonRulesCache };
      } else if (fs.existsSync(this.seasonRulesFile)) {
        try {
          rules = JSON.parse(fs.readFileSync(this.seasonRulesFile, "utf-8"));
        } catch {
        }
      }
      rules[folderPath] = pref;
      saveJsonSync(this.seasonRulesFile, rules);
      this.seasonRulesCache = rules;
    } catch (e) {
      console.error("Failed to write season rules:", e);
    }
  }
};
var storage = new StorageService();

// electron/ffmpeg.ts
import { spawn } from "child_process";
import fs2 from "fs";
import path3 from "path";
function readMkvDuration(filePath) {
  try {
    const fd = fs2.openSync(filePath, "r");
    const buf = Buffer.alloc(65536);
    const bytesRead = fs2.readSync(fd, buf, 0, 65536, 0);
    fs2.closeSync(fd);
    if (bytesRead < 4) return null;
    let timecodeScale = 1e6;
    const tcIdx = buf.indexOf(Buffer.from([42, 215, 177]));
    if (tcIdx !== -1 && tcIdx + 3 < bytesRead) {
      let firstByte2 = buf[tcIdx + 3];
      let numBytes2 = 1;
      let mask2 = 128;
      while ((firstByte2 & mask2) === 0 && numBytes2 <= 8) {
        mask2 >>= 1;
        numBytes2++;
      }
      const tcLen = firstByte2 & mask2 - 1;
      const tcStart = tcIdx + 3 + numBytes2;
      if (tcLen > 0 && tcLen <= 8 && tcStart + tcLen <= bytesRead) {
        let val = 0;
        for (let i = 0; i < tcLen; i++) {
          val = val * 256 + buf[tcStart + i];
        }
        if (val > 0) timecodeScale = val;
      }
    }
    const idx = buf.indexOf(Buffer.from([68, 137]));
    if (idx === -1 || idx + 2 >= bytesRead) return null;
    let firstByte = buf[idx + 2];
    let numBytes = 1;
    let mask = 128;
    while ((firstByte & mask) === 0 && numBytes <= 8) {
      mask >>= 1;
      numBytes++;
    }
    const length = firstByte & mask - 1;
    const dataStart = idx + 2 + numBytes;
    if (length <= 0 || dataStart + length > bytesRead) return null;
    if (length === 4) {
      const rawDur = buf.readFloatBE(dataStart);
      if (rawDur > 0 && !isNaN(rawDur)) {
        return rawDur * timecodeScale / 1e9;
      }
    } else if (length === 8) {
      const rawDur = buf.readDoubleBE(dataStart);
      if (rawDur > 0 && !isNaN(rawDur)) {
        return rawDur * timecodeScale / 1e9;
      }
    }
    return null;
  } catch {
    return null;
  }
}
async function generateSingleThumbnail(filePath, timeSec, ffmpegPath, outputPath, signalOrOptions, signal) {
  if (fs2.existsSync(outputPath)) {
    return outputPath;
  }
  const isCard = typeof signalOrOptions === "object" && signalOrOptions !== null && !(signalOrOptions instanceof AbortSignal) && "isCard" in signalOrOptions ? Boolean(signalOrOptions.isCard) : false;
  const activeSignal = signalOrOptions instanceof AbortSignal ? signalOrOptions : signal;
  if (activeSignal?.aborted) {
    return "";
  }
  return new Promise((resolve) => {
    const parentDir = path3.dirname(outputPath);
    if (!fs2.existsSync(parentDir)) {
      fs2.mkdirSync(parentDir, { recursive: true });
    }
    const fastArgs = isCard ? [
      "-hide_banner",
      "-y",
      "-ss",
      timeSec.toString(),
      "-i",
      filePath,
      "-an",
      "-sn",
      "-threads",
      "2",
      "-vf",
      "thumbnail=50,scale=640:360",
      "-frames:v",
      "1",
      "-q:v",
      "2",
      outputPath
    ] : [
      "-hide_banner",
      "-y",
      "-probesize",
      "32768",
      "-analyzeduration",
      "0",
      "-noaccurate_seek",
      "-ss",
      timeSec.toString(),
      "-skip_frame",
      "nokey",
      "-i",
      filePath,
      "-an",
      "-sn",
      "-dn",
      "-threads",
      "2",
      "-frames:v",
      "1",
      "-vf",
      "scale=160:90:flags=fast_bilinear",
      "-q:v",
      "5",
      outputPath
    ];
    let child = spawn(ffmpegPath, fastArgs, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
    const onAbort = () => {
      try {
        child.kill();
      } catch {
      }
      resolve("");
    };
    if (activeSignal) {
      activeSignal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("close", (code) => {
      if (activeSignal) {
        activeSignal.removeEventListener("abort", onAbort);
      }
      if (code === 0 && fs2.existsSync(outputPath) && fs2.statSync(outputPath).size > 100) {
        resolve(outputPath);
      } else {
        if (activeSignal?.aborted) return resolve("");
        const fallbackArgs = isCard ? [
          "-hide_banner",
          "-y",
          "-ss",
          timeSec.toString(),
          "-i",
          filePath,
          "-an",
          "-sn",
          "-threads",
          "2",
          "-vf",
          "scale=640:360",
          "-frames:v",
          "1",
          "-q:v",
          "2",
          outputPath
        ] : [
          "-hide_banner",
          "-y",
          "-ss",
          timeSec.toString(),
          "-i",
          filePath,
          "-an",
          "-sn",
          "-threads",
          "2",
          "-frames:v",
          "1",
          "-vf",
          "scale=160:90",
          "-q:v",
          "5",
          outputPath
        ];
        const fbChild = spawn(ffmpegPath, fallbackArgs, {
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore"]
        });
        if (activeSignal) {
          activeSignal.addEventListener("abort", () => {
            try {
              fbChild.kill();
            } catch {
            }
            resolve("");
          }, { once: true });
        }
        fbChild.on("close", (fbCode) => {
          if (fbCode === 0 && fs2.existsSync(outputPath)) {
            resolve(outputPath);
          } else {
            resolve("");
          }
        });
        fbChild.on("error", () => resolve(""));
      }
    });
    child.on("error", () => {
      if (activeSignal) activeSignal.removeEventListener("abort", onAbort);
      resolve("");
    });
  });
}

// electron/torrents.ts
import fs3 from "fs";
import path4 from "path";
var statusCache = /* @__PURE__ */ new Map();
var TEMP_COMPANION_EXTENSIONS = [
  ".!qb",
  ".!ut",
  ".part",
  ".crdownload",
  ".downloading",
  ".aria2",
  ".fdmdownload",
  ".bc!",
  ".tixati",
  ".piece",
  ".vuzedl",
  ".incomplete",
  ".tmp"
];
function checkEpisodeDownloading(fullPath, filesInDir, stat) {
  const fileName = path4.basename(fullPath).toLowerCase();
  const now = Date.now();
  const cached = statusCache.get(fullPath);
  if (cached && !cached.isDownloading && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    if (now - cached.checkedAt < 3e5) {
      return { isDownloading: false };
    }
  }
  function calculateSampleProgress(fullPath2, logicalSize, filesInDir2, fileName2, matchedExt) {
    if (logicalSize <= 0) return 0;
    let targetPath = fullPath2;
    if (!fs3.existsSync(targetPath)) {
      const companionPath = path4.join(path4.dirname(fullPath2), `${path4.basename(fullPath2)}${matchedExt}`);
      if (fs3.existsSync(companionPath)) {
        targetPath = companionPath;
      } else {
        return void 0;
      }
    }
    try {
      const fileStat = fs3.statSync(targetPath);
      if (fileStat.size > 0 && fileStat.size < logicalSize * 0.99) {
        return Math.min(99, Math.max(1, Math.round(fileStat.size / logicalSize * 100)));
      }
      const fd = fs3.openSync(targetPath, "r");
      try {
        const checkPoints = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
        const buf = Buffer.alloc(16384);
        let nonZeroCount = 0;
        for (const frac of checkPoints) {
          const offset = Math.floor(fileStat.size * frac);
          const bytesRead = fs3.readSync(fd, buf, 0, 16384, offset);
          if (bytesRead > 0) {
            let hasData = false;
            for (let i = 0; i < bytesRead; i++) {
              if (buf[i] !== 0) {
                hasData = true;
                break;
              }
            }
            if (hasData) nonZeroCount++;
          }
        }
        return Math.min(99, Math.max(1, Math.round(nonZeroCount / checkPoints.length * 100)));
      } finally {
        fs3.closeSync(fd);
      }
    } catch {
      return void 0;
    }
  }
  for (const ext of TEMP_COMPANION_EXTENSIONS) {
    if (filesInDir.has(`${fileName}${ext}`) || fileName.endsWith(ext) || fileName.includes(`${ext}.`)) {
      let progress = stat.blocks && stat.size > 0 ? Math.min(99, Math.max(0, Math.round(stat.blocks * 512 / stat.size * 100))) : void 0;
      if (progress === void 0 && stat.size > 0) {
        progress = calculateSampleProgress(fullPath, stat.size, filesInDir, fileName, ext);
      }
      const res2 = { isDownloading: true, downloadProgress: progress };
      statusCache.set(fullPath, { ...res2, progress, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
      return res2;
    }
  }
  if (stat.size === 0 || stat.size < 512 * 1024) {
    const res2 = { isDownloading: true, downloadProgress: 0 };
    statusCache.set(fullPath, { ...res2, progress: 0, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
    return res2;
  }
  if (stat.blocks && stat.size > 5 * 1024 * 1024) {
    const allocatedBytes = stat.blocks * 512;
    if (allocatedBytes < stat.size * 0.99) {
      const progress = Math.min(99, Math.max(0, Math.round(allocatedBytes / stat.size * 100)));
      const res2 = { isDownloading: true, downloadProgress: progress };
      statusCache.set(fullPath, { ...res2, progress, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
      return res2;
    }
  }
  if (stat.size > 5 * 1024 * 1024) {
    try {
      const fd = fs3.openSync(fullPath, "r");
      try {
        const headBuf = Buffer.alloc(16);
        fs3.readSync(fd, headBuf, 0, 16, 0);
        if (fileName.endsWith(".mkv")) {
          if (headBuf[0] !== 26 || headBuf[1] !== 69 || headBuf[2] !== 223 || headBuf[3] !== 163) {
            const res2 = { isDownloading: true, downloadProgress: 0 };
            statusCache.set(fullPath, { ...res2, progress: 0, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
            return res2;
          }
        } else {
          let headAllZero = true;
          for (let i = 0; i < 16; i++) {
            if (headBuf[i] !== 0) {
              headAllZero = false;
              break;
            }
          }
          if (headAllZero) {
            const res2 = { isDownloading: true, downloadProgress: 0 };
            statusCache.set(fullPath, { ...res2, progress: 0, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
            return res2;
          }
        }
        const tailCheckSize = Math.min(16384, stat.size);
        const tailBuf = Buffer.alloc(tailCheckSize);
        fs3.readSync(fd, tailBuf, 0, tailCheckSize, stat.size - tailCheckSize);
        let tailAllZero = true;
        for (let i = 0; i < tailCheckSize; i++) {
          if (tailBuf[i] !== 0) {
            tailAllZero = false;
            break;
          }
        }
        const checkPoints = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
        const sampleBuf = Buffer.alloc(16384);
        let zeroCheckpoints = 0;
        for (const frac of checkPoints) {
          const offset = Math.floor(stat.size * frac);
          const bytesRead = fs3.readSync(fd, sampleBuf, 0, 16384, offset);
          if (bytesRead > 0) {
            let zeroCount = 0;
            for (let i = 0; i < bytesRead; i++) {
              if (sampleBuf[i] === 0) zeroCount++;
            }
            if (zeroCount >= bytesRead * 0.98) {
              zeroCheckpoints++;
            }
          }
        }
        if (tailAllZero || zeroCheckpoints > 0) {
          let progress;
          if (stat.blocks && stat.size > 0) {
            progress = Math.min(99, Math.max(0, Math.round(stat.blocks * 512 / stat.size * 100)));
          } else {
            const nonZero = checkPoints.length - zeroCheckpoints;
            progress = Math.min(
              99,
              Math.max(1, Math.round(nonZero / (checkPoints.length + (tailAllZero ? 1 : 0)) * 100))
            );
          }
          const res2 = { isDownloading: true, downloadProgress: progress };
          statusCache.set(fullPath, { ...res2, progress, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
          return res2;
        }
      } finally {
        fs3.closeSync(fd);
      }
    } catch {
    }
  }
  const res = { isDownloading: false };
  statusCache.set(fullPath, { ...res, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
  return res;
}
function isEpisodeDownloading(fullPath, filesInDir, stat) {
  return checkEpisodeDownloading(fullPath, filesInDir, stat).isDownloading;
}

// electron/server.ts
var codecCache = /* @__PURE__ */ new Map();
var hasNvencCache = null;
async function checkNvencSupport(ffmpegPath) {
  if (hasNvencCache !== null) return hasNvencCache;
  if (!ffmpegPath) return false;
  return new Promise((resolve) => {
    try {
      const p = spawn2(ffmpegPath, [
        "-hide_banner",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:d=0.1",
        "-c:v",
        "h264_nvenc",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "null",
        "-"
      ], { windowsHide: true });
      p.on("close", (code) => {
        hasNvencCache = code === 0;
        resolve(hasNvencCache);
      });
      p.on("error", () => {
        hasNvencCache = false;
        resolve(false);
      });
    } catch {
      hasNvencCache = false;
      resolve(false);
    }
  });
}
async function getVideoFormat(filePath, ffmpegPath) {
  const cached = codecCache.get(filePath);
  if (cached) return cached;
  if (!ffmpegPath) return { codec: "hevc", canDirectStream: false };
  return new Promise((resolve) => {
    try {
      const p = spawn2(ffmpegPath, ["-hide_banner", "-i", filePath], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"]
      });
      let stderr = "";
      p.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      p.on("close", () => {
        const match = stderr.match(/Stream #0:\d+.*?: Video: ([a-zA-Z0-9_-]+)(?:.*?, ([a-zA-Z0-9_]+))?/i);
        const codec = match ? match[1].toLowerCase() : "hevc";
        const pixFmt = match && match[2] ? match[2].toLowerCase() : "";
        const is10Bit = /10|12|p10|p12/i.test(pixFmt) || /10/i.test(stderr.split("Video:")[1]?.split(",")[0] || "");
        const isH264 = /h264|avc/i.test(codec);
        const canDirectStream = isH264 && !is10Bit;
        const info = { codec, canDirectStream };
        codecCache.set(filePath, info);
        resolve(info);
      });
      p.on("error", () => resolve({ codec: "hevc", canDirectStream: false }));
    } catch {
      resolve({ codec: "hevc", canDirectStream: false });
    }
  });
}
var ThumbnailQueue = class {
  running = 0;
  queue = [];
  concurrency;
  constructor(concurrency = 3) {
    this.concurrency = concurrency;
  }
  async acquire() {
    if (this.running >= this.concurrency) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    };
  }
};
function isPathInside(child, root) {
  try {
    const rel = path5.relative(path5.resolve(root), path5.resolve(child));
    return rel === "" || !rel.startsWith("..") && !path5.isAbsolute(rel);
  } catch {
    return false;
  }
}
function isAllowedFilePath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const settings = storage.getSettings();
  const roots = [];
  if (Array.isArray(settings.libraryFolders)) {
    roots.push(...settings.libraryFolders);
  }
  if (settings.defaultLibraryRoot) {
    roots.push(settings.defaultLibraryRoot);
  }
  const thumbDir = storage.getThumbnailDir();
  roots.push(thumbDir);
  for (const root of roots) {
    if (!root) continue;
    if (isPathInside(targetPath, root)) {
      return true;
    }
  }
  return false;
}
var LocalStreamServer = class {
  server = null;
  port = 0;
  activeStreams = /* @__PURE__ */ new Set();
  currentStreamProcess = null;
  currentStreamResponse = null;
  inFlightThumbs = /* @__PURE__ */ new Map();
  cachedThumbFiles = /* @__PURE__ */ new Set();
  cardThumbQueue = new ThumbnailQueue(3);
  scrubberThumbQueue = new ThumbnailQueue(2);
  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          console.log(`[StreamServer] Running on http://127.0.0.1:${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error("Failed to obtain server address"));
        }
      });
      this.server.on("error", (err) => {
        console.error("[StreamServer] Error:", err);
        reject(err);
      });
    });
  }
  getPort() {
    return this.port;
  }
  handleRequest(req, res) {
    const origin = req.headers.origin;
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    let allowedOrigin = null;
    if (!origin) {
    } else if (origin === "null" || origin.startsWith("file://") || devServerUrl && (origin === devServerUrl || origin === devServerUrl.replace(/\/$/, ""))) {
      allowedOrigin = origin;
    } else {
      res.writeHead(403);
      res.end("Forbidden: Origin not allowed");
      return;
    }
    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }
    const parsedUrl = url.parse(req.url || "", true);
    const pathname = parsedUrl.pathname;
    if (pathname === "/stream") {
      this.handleStream(req, res, parsedUrl.query).catch((err) => {
        console.error("[StreamServer] handleStream unhandled rejection:", err);
        if (!res.headersSent && !res.destroyed && !res.writableEnded) {
          try {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`Internal Server Error: ${err?.message || "Streaming failed"}`);
          } catch {
          }
        }
      });
    } else if (pathname === "/thumb") {
      this.handleThumb(req, res, parsedUrl.query);
    } else if (pathname?.startsWith("/font/")) {
      this.handleFont(req, res, pathname);
    } else if (pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", port: this.port }));
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  }
  async handleStream(req, res, query) {
    try {
      const filePath = query.file;
      const audioTrackStr = query.audioTrack || "0";
      const startTimeStr = query.startTime || "0";
      if (!filePath || !isAllowedFilePath(filePath) || !fs4.existsSync(filePath)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Access denied or file not found");
        return;
      }
      try {
        const dir = path5.dirname(filePath);
        const filesInDir = new Set(fs4.readdirSync(dir).map((f) => f.toLowerCase()));
        const stat = fs4.statSync(filePath);
        if (isEpisodeDownloading(filePath, filesInDir, stat)) {
          res.writeHead(423, { "Content-Type": "text/plain" });
          res.end("File is currently downloading in torrent client and cannot be streamed yet.");
          return;
        }
      } catch {
      }
      const settings = storage.getSettings();
      const ffmpegPath = settings.ffmpegPath;
      const startTime = Math.max(0, parseFloat(startTimeStr) || 0);
      const audioTrack = parseInt(audioTrackStr, 10) || 0;
      console.log(`[StreamServer] Streaming: "${filePath}" audioIndex:${audioTrack} startTime:${startTime}s`);
      const videoFormat = await getVideoFormat(filePath, ffmpegPath);
      const hasNvenc = await checkNvencSupport(ffmpegPath);
      this.stopActiveStreams();
      const args = [
        "-hide_banner",
        "-ss",
        startTime.toString(),
        "-i",
        filePath,
        "-map",
        "0:v:0",
        "-map",
        `0:a:${audioTrack}?`
      ];
      if (hasNvenc) {
        args.push(
          "-c:v",
          "h264_nvenc",
          "-pix_fmt",
          "yuv420p",
          "-preset",
          "p1",
          "-tune",
          "ll",
          "-cq",
          "19",
          "-g",
          "24",
          "-forced-idr",
          "1"
        );
      } else if (!videoFormat.canDirectStream) {
        args.push(
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-crf",
          "20",
          "-g",
          "24"
        );
      } else {
        args.push("-c:v", "copy");
      }
      args.push(
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-b:a",
        "256k",
        "-af",
        "aresample=async=1:first_pts=0",
        "-avoid_negative_ts",
        "make_zero",
        "-map_chapters",
        "-1",
        "-dn",
        "-sn",
        "-flush_packets",
        "1",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "pipe:1"
      );
      let ffmpeg;
      try {
        ffmpeg = spawn2(ffmpegPath, args, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"]
        });
      } catch (spawnErr) {
        console.error("[StreamServer] Failed to spawn FFmpeg:", spawnErr);
        if (!res.headersSent && !res.destroyed && !res.writableEnded) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`Failed to spawn FFmpeg: ${spawnErr.message}`);
        }
        return;
      }
      this.currentStreamProcess = ffmpeg;
      this.currentStreamResponse = res;
      this.activeStreams.add(ffmpeg);
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Transfer-Encoding": "chunked",
        "Accept-Ranges": "none",
        "Cache-Control": "no-cache, no-store",
        "Connection": "close"
      });
      ffmpeg.stdout?.pipe(res);
      let killed = false;
      const cleanup = () => {
        if (!killed) {
          killed = true;
          this.activeStreams.delete(ffmpeg);
          if (this.currentStreamProcess === ffmpeg) {
            this.currentStreamProcess = null;
          }
          if (this.currentStreamResponse === res) {
            this.currentStreamResponse = null;
          }
          try {
            ffmpeg.stdout?.unpipe();
            ffmpeg.stdout?.destroy();
          } catch {
          }
          try {
            ffmpeg.kill();
          } catch {
          }
        }
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      ffmpeg.on("close", cleanup);
      ffmpeg.on("error", (err) => {
        console.error("[StreamServer] FFmpeg process error:", err);
        cleanup();
      });
    } catch (err) {
      console.error("[StreamServer] Stream handling error:", err);
      if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        try {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`Streaming error: ${err.message || "Stream processing failed"}`);
        } catch {
        }
      }
    }
  }
  async handleThumb(req, res, query) {
    const filePath = query.file;
    const timeStr = query.time || "0";
    const isCard = query.type === "card";
    if (!filePath || !isAllowedFilePath(filePath) || !fs4.existsSync(filePath)) {
      res.writeHead(403);
      res.end("Access denied or file not found");
      return;
    }
    if (isCard) {
      const dir = path5.dirname(filePath);
      const base = path5.parse(filePath).name;
      const candidates = [
        path5.join(dir, `${base}.jpg`),
        path5.join(dir, `${base}.png`),
        path5.join(dir, `${base}-thumb.jpg`),
        path5.join(dir, `${base}-thumb.png`),
        path5.join(dir, `${base}.thumb.jpg`)
      ];
      for (const cand of candidates) {
        if (fs4.existsSync(cand)) {
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.writeHead(200, {
              "Content-Type": cand.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
              "Cache-Control": "public, max-age=86400"
            });
            const sidecarStream = fs4.createReadStream(cand);
            sidecarStream.on("error", () => {
              try {
                sidecarStream.destroy();
              } catch {
              }
            });
            sidecarStream.pipe(res);
          }
          return;
        }
      }
    }
    const queryDuration = parseFloat(query.duration);
    let duration = !isNaN(queryDuration) && queryDuration > 0 ? queryDuration : storage.getAllPlaybackProgress()[filePath]?.duration;
    if (!duration || duration <= 0) {
      const mkvDur = readMkvDuration(filePath);
      if (mkvDur && mkvDur > 0) {
        duration = Math.round(mkvDur);
      }
    }
    const rawTargetTime = isCard ? timeStr && timeStr !== "60" && timeStr !== "0" ? parseFloat(timeStr) : 280 : Math.floor(Math.max(0, parseFloat(timeStr) || 0) / 5) * 5;
    let targetTime = rawTargetTime;
    if (duration && duration > 0) {
      if (isCard) {
        targetTime = Math.min(rawTargetTime, Math.max(1, duration * 0.2));
      } else {
        targetTime = Math.min(rawTargetTime, Math.max(0, duration - 1));
      }
    }
    const fileHash = crypto.createHash("md5").update(filePath).digest("hex").slice(0, 16);
    const thumbDir = path5.join(storage.getThumbnailDir(), fileHash);
    const thumbFile = isCard ? path5.join(thumbDir, "card_hq.jpg") : path5.join(thumbDir, `thumb_${Math.floor(targetTime / 5) * 5}.jpg`);
    if (this.cachedThumbFiles.has(thumbFile) || fs4.existsSync(thumbFile)) {
      this.cachedThumbFiles.add(thumbFile);
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=86400"
        });
        const hitStream = fs4.createReadStream(thumbFile);
        hitStream.on("error", () => {
          try {
            hitStream.destroy();
          } catch {
          }
        });
        hitStream.pipe(res);
      }
      return;
    }
    try {
      const settings = storage.getSettings();
      let thumbPromise = this.inFlightThumbs.get(thumbFile);
      if (!thumbPromise) {
        thumbPromise = (async () => {
          const release = isCard ? await this.cardThumbQueue.acquire() : await this.scrubberThumbQueue.acquire();
          try {
            return await generateSingleThumbnail(
              filePath,
              targetTime,
              settings.ffmpegPath,
              thumbFile,
              { isCard }
            );
          } finally {
            release();
          }
        })();
        this.inFlightThumbs.set(thumbFile, thumbPromise);
        thumbPromise.finally(() => this.inFlightThumbs.delete(thumbFile));
      }
      const generated = await thumbPromise;
      if (res.writableEnded || res.destroyed || !res.socket?.writable) {
        return;
      }
      if (generated && fs4.existsSync(generated)) {
        this.cachedThumbFiles.add(generated);
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=86400"
          });
          const genStream = fs4.createReadStream(generated);
          genStream.on("error", (err) => {
            console.error("[StreamServer] Thumbnail stream pipe error:", err);
            try {
              genStream.destroy();
            } catch {
            }
          });
          genStream.pipe(res);
        }
      } else {
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.writeHead(404);
          res.end("Thumbnail not ready");
        }
      }
    } catch (e) {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        try {
          res.writeHead(500);
          res.end("Error generating thumbnail");
        } catch {
        }
      }
    }
  }
  handleFont(req, res, rawPathname) {
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(rawPathname);
    } catch {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }
    if (!decodedPath.startsWith("/font/")) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const segments = decodedPath.slice("/font/".length).split("/").filter(Boolean);
    if (segments.length !== 2) {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }
    const [fileHash, fontName] = segments;
    if (!/^[a-f0-9]{16}$/i.test(fileHash)) {
      res.writeHead(400);
      res.end("Invalid file hash");
      return;
    }
    if (fontName.includes("..") || fontName.includes("/") || fontName.includes("\\") || path5.isAbsolute(fontName)) {
      res.writeHead(400);
      res.end("Invalid font name");
      return;
    }
    const fontsBaseDir = path5.resolve(storage.getThumbnailDir(), "fonts", fileHash);
    const resolvedFontPath = path5.resolve(fontsBaseDir, fontName);
    if (!isPathInside(resolvedFontPath, fontsBaseDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (fs4.existsSync(resolvedFontPath)) {
      const ext = path5.extname(fontName).toLowerCase();
      const contentType = ext === ".otf" ? "font/otf" : ext === ".woff2" ? "font/woff2" : ext === ".woff" ? "font/woff" : "font/ttf";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400"
      });
      fs4.createReadStream(resolvedFontPath).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("Font not found");
  }
  stopActiveStreams() {
    for (const p of this.activeStreams) {
      try {
        p.stdout?.unpipe();
        p.stdout?.destroy();
        p.kill();
      } catch {
      }
    }
    this.activeStreams.clear();
    this.currentStreamProcess = null;
    if (this.currentStreamResponse && !this.currentStreamResponse.writableEnded) {
      try {
        this.currentStreamResponse.end();
      } catch {
      }
      this.currentStreamResponse = null;
    }
  }
  stop() {
    this.stopActiveStreams();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
};
var streamServer = new LocalStreamServer();

// electron/kitsu.ts
import fs5 from "fs";
import path6 from "path";
import crypto2 from "crypto";
var memoryCache = /* @__PURE__ */ new Map();
var notFoundCache = /* @__PURE__ */ new Map();
var inFlightRequests = /* @__PURE__ */ new Map();
function isSequelTitle(title) {
  if (!title) return false;
  if (/\b(?:The\s+)?Final\s+Season\b/i.test(title)) return true;
  if (/\bSeason\s*0*([2-9]|\d{2,})\b/i.test(title)) return true;
  if (/\b([2-9]|\d{2,})(?:nd|rd|th)\s*Season\b/i.test(title)) return true;
  if (/\bSecond\s*Season\b/i.test(title)) return true;
  if (/\bThird\s*Season\b/i.test(title)) return true;
  if (/\bFourth\s*Season\b/i.test(title)) return true;
  if (/\b(?:II|III|IV|V|VI)\b/.test(title)) return true;
  return false;
}
function buildAnimeSearchQueries(raw) {
  if (!raw) return { primary: "", fallback: null, targetSeason: null, targetPart: null };
  let str = raw;
  str = str.replace(/\[[^\]]*\]/g, "");
  str = str.replace(/\([^)]*\)/g, "");
  str = str.replace(/-\s*[A-Za-z0-9_]+$/, "");
  const junkPattern = /\b(2160p|4k|1080p|720p|576p|480p|bluray|bdrip|remux|web-dl|webrip|web|dvdrip|dvd|hevc|x265|x264|h264|h265|avc|repack|dual-?audio|multi-?audio|dolby|truehd|atmos|dts|ddp\d*|flac|aac|opus)\b/i;
  const match = str.match(junkPattern);
  if (match && match.index !== void 0) {
    str = str.substring(0, match.index);
  }
  str = str.replace(/[-_–—.]+/g, " ").replace(/\s+/g, " ").trim();
  const seasonMatch = str.match(/\b(?:S|Season\s*)0*(\d+)\b/i);
  const targetSeason = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
  const partMatch = str.match(/\b(Part|Cour)\s*0*(\d+)\b/i);
  const targetPart = partMatch ? parseInt(partMatch[2], 10) : null;
  const finalSeasonMatch = /\b(?:The\s+)?Final\s+Season\b/i.test(str);
  const baseTitle = str.replace(/\bS\d{1,2}\b/gi, "").replace(/\b(Season|Part|Cour)\s*\d+\b/gi, "").replace(/\b(The\s+)?Final\s+Season\b/gi, "").replace(/\s+/g, " ").trim();
  if (targetSeason !== null && targetSeason >= 2) {
    const partSuffix = targetPart ? ` Part ${targetPart}` : "";
    const primary = `${baseTitle} Season ${targetSeason}${partSuffix}`.trim();
    return { primary, fallback: baseTitle || null, targetSeason, targetPart };
  }
  if (finalSeasonMatch) {
    const partSuffix = targetPart ? ` Part ${targetPart}` : "";
    const primary = `${baseTitle} The Final Season${partSuffix}`.trim();
    return { primary, fallback: baseTitle || null, targetSeason: "final", targetPart };
  }
  if (targetPart !== null && (targetSeason === null || targetSeason === 1)) {
    const primary = `${baseTitle} Part ${targetPart}`.trim();
    return { primary, fallback: baseTitle || null, targetSeason: targetSeason || 1, targetPart };
  }
  return {
    primary: baseTitle || str,
    fallback: null,
    targetSeason: targetSeason || 1,
    targetPart: null
  };
}
function parseAniListEpisodeTitle(raw) {
  if (!raw) return null;
  const match = raw.match(/^(?:Episode|Ep\.?|E)?\s*(\d+)\s*[-–—:.]\s*(.+)$/i);
  if (match) {
    const num = parseInt(match[1], 10);
    const title = match[2].trim();
    if (!isNaN(num) && title.length > 0) {
      return { number: num, title };
    }
  }
  return null;
}
async function fetchAniListMetadata(query, targetSeason = null) {
  const gqlQuery = `
    query ($search: String) {
      Page(page: 1, perPage: 5) {
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          id
          idMal
          title {
            romaji
            english
            native
          }
          bannerImage
          coverImage {
            extraLarge
            large
          }
          description
          genres
          averageScore
          streamingEpisodes {
            title
            thumbnail
          }
        }
      }
    }
  `;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "AnimeMediaCenter/1.0"
    },
    body: JSON.stringify({
      query: gqlQuery,
      variables: { search: query }
    }),
    signal: AbortSignal.timeout(5e3)
  });
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1e3 : 2e3;
    await new Promise((r) => setTimeout(r, Math.min(delay, 5e3)));
    throw new Error("AniList rate limited (429)");
  }
  if (!res.ok) {
    throw new Error(`AniList returned HTTP ${res.status}`);
  }
  const json = await res.json();
  const mediaList = json.data?.Page?.media;
  if (!Array.isArray(mediaList) || mediaList.length === 0) return null;
  let media = mediaList[0];
  if (mediaList.length > 1) {
    if (targetSeason === 1 || targetSeason === null) {
      const nonSequel = mediaList.find((m) => {
        const t = m.title?.english || m.title?.romaji || "";
        return !isSequelTitle(t);
      });
      if (nonSequel) media = nonSequel;
    } else if (typeof targetSeason === "number" && targetSeason >= 2) {
      const matching = mediaList.find((m) => {
        const t = m.title?.english || m.title?.romaji || "";
        return new RegExp(`\\b(?:Season\\s*0*${targetSeason}|${targetSeason}(?:nd|rd|th)\\s*Season)\\b`, "i").test(t) || targetSeason === 2 && /\b(?:II|Second\s*Season)\b/i.test(t) || targetSeason === 3 && /\b(?:III|Third\s*Season)\b/i.test(t) || targetSeason === 4 && /\b(?:IV|Fourth\s*Season)\b/i.test(t);
      });
      if (matching) media = matching;
    }
  }
  const malId = media.idMal || null;
  const canonicalTitle = media.title?.english || media.title?.romaji || query;
  const posterUrl = media.coverImage?.extraLarge || media.coverImage?.large || null;
  const bannerUrl = media.bannerImage || null;
  const synopsis = media.description ? media.description.replace(/<[^>]+>/g, "").trim() : null;
  const genres = Array.isArray(media.genres) ? media.genres : [];
  const averageScore = typeof media.averageScore === "number" ? media.averageScore : null;
  const episodes = {};
  if (Array.isArray(media.streamingEpisodes)) {
    for (const ep of media.streamingEpisodes) {
      if (!ep.title) continue;
      const parsed = parseAniListEpisodeTitle(ep.title);
      if (parsed) {
        episodes[parsed.number] = {
          number: parsed.number,
          title: parsed.title,
          thumbnailUrl: ep.thumbnail || null,
          synopsis: null
        };
      }
    }
  }
  return {
    malId,
    canonicalTitle,
    posterUrl,
    bannerUrl,
    synopsis,
    genres,
    averageScore,
    episodes
  };
}
async function fetchKitsuMetadata(query, targetSeason = null) {
  const searchUrl = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=5`;
  const searchRes = await fetch(searchUrl, {
    headers: {
      Accept: "application/vnd.api+json",
      "User-Agent": "AnimeMediaCenter/1.0"
    },
    signal: AbortSignal.timeout(5e3)
  });
  if (searchRes.status === 429) {
    const retryAfter = searchRes.headers.get("Retry-After");
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1e3 : 2e3;
    await new Promise((r) => setTimeout(r, Math.min(delay, 5e3)));
    throw new Error("Kitsu rate limited (429)");
  }
  if (!searchRes.ok) {
    throw new Error(`Kitsu returned HTTP ${searchRes.status}`);
  }
  const searchJson = await searchRes.json();
  if (!searchJson.data || searchJson.data.length === 0) return null;
  let animeItem = searchJson.data[0];
  if (searchJson.data.length > 1) {
    if (targetSeason === 1 || targetSeason === null) {
      const nonSequel = searchJson.data.find((item) => {
        const t = item.attributes?.titles?.en || item.attributes?.titles?.en_jp || item.attributes?.canonicalTitle || "";
        return !isSequelTitle(t);
      });
      if (nonSequel) animeItem = nonSequel;
    } else if (typeof targetSeason === "number" && targetSeason >= 2) {
      const matching = searchJson.data.find((item) => {
        const t = item.attributes?.titles?.en || item.attributes?.titles?.en_jp || item.attributes?.canonicalTitle || "";
        return new RegExp(`\\b(?:Season\\s*0*${targetSeason}|${targetSeason}(?:nd|rd|th)\\s*Season)\\b`, "i").test(t) || targetSeason === 2 && /\b(?:II|Second\s*Season)\b/i.test(t) || targetSeason === 3 && /\b(?:III|Third\s*Season)\b/i.test(t) || targetSeason === 4 && /\b(?:IV|Fourth\s*Season)\b/i.test(t);
      });
      if (matching) animeItem = matching;
    }
  }
  const animeId = animeItem.id;
  const canonicalTitle = animeItem.attributes?.titles?.en || animeItem.attributes?.canonicalTitle || animeItem.attributes?.titles?.en_jp || query;
  const posterUrl = animeItem.attributes?.posterImage?.large || animeItem.attributes?.posterImage?.original || null;
  const episodes = {};
  let offset = 0;
  const limit = 50;
  const maxEpisodes = 1500;
  while (offset < maxEpisodes) {
    try {
      const epUrl = `https://kitsu.io/api/edge/anime/${animeId}/episodes?page[limit]=${limit}&page[offset]=${offset}&sort=number`;
      const epRes = await fetch(epUrl, {
        headers: {
          Accept: "application/vnd.api+json",
          "User-Agent": "AnimeMediaCenter/1.0"
        },
        signal: AbortSignal.timeout(6e3)
      });
      if (!epRes.ok) break;
      const epJson = await epRes.json();
      if (!Array.isArray(epJson.data) || epJson.data.length === 0) break;
      for (const item of epJson.data) {
        const attrs = item.attributes;
        const num = attrs.number;
        if (num) {
          episodes[num] = {
            number: num,
            title: attrs.canonicalTitle || attrs.titles?.en_us || attrs.titles?.en_jp || null,
            synopsis: attrs.synopsis || null,
            thumbnailUrl: attrs.thumbnail?.original || attrs.thumbnail?.large || null
          };
        }
      }
      if (epJson.data.length < limit || !epJson.links?.next) {
        break;
      }
      offset += limit;
    } catch {
      break;
    }
  }
  return {
    animeId,
    canonicalTitle,
    posterUrl,
    episodes
  };
}
async function getKitsuMetadata(rawSeriesName) {
  const { primary, fallback, targetSeason } = buildAnimeSearchQueries(rawSeriesName);
  if (!primary) return null;
  const cacheKey = crypto2.createHash("md5").update(primary.toLowerCase()).digest("hex").slice(0, 16);
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey);
  }
  const notFoundExpires = notFoundCache.get(cacheKey);
  if (notFoundExpires && Date.now() < notFoundExpires) {
    return null;
  }
  const cacheDir = storage.getMetadataCacheDir();
  const cacheFile = path6.join(cacheDir, `kitsu_${cacheKey}.json`);
  if (fs5.existsSync(cacheFile)) {
    try {
      const data = JSON.parse(fs5.readFileSync(cacheFile, "utf-8"));
      if (data.fetchedAt && Date.now() - data.fetchedAt < 14 * 24 * 60 * 60 * 1e3) {
        memoryCache.set(cacheKey, data);
        return data;
      }
    } catch {
    }
  }
  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey);
  }
  const fetchPromise = (async () => {
    try {
      let aniListSuccess = false;
      let kitsuSuccess = false;
      const [aniListResult, kitsuResult] = await Promise.allSettled([
        fetchAniListMetadata(primary, targetSeason),
        fetchKitsuMetadata(primary, targetSeason)
      ]);
      let aniList = null;
      let kitsu = null;
      if (aniListResult.status === "fulfilled") {
        aniList = aniListResult.value;
        aniListSuccess = true;
      }
      if (kitsuResult.status === "fulfilled") {
        kitsu = kitsuResult.value;
        kitsuSuccess = true;
      }
      if (!aniList && !kitsu && fallback && fallback.toLowerCase() !== primary.toLowerCase()) {
        const [aniListFb, kitsuFb] = await Promise.allSettled([
          fetchAniListMetadata(fallback, targetSeason),
          fetchKitsuMetadata(fallback, targetSeason)
        ]);
        if (aniListFb.status === "fulfilled") {
          aniList = aniListFb.value;
          aniListSuccess = true;
        }
        if (kitsuFb.status === "fulfilled") {
          kitsu = kitsuFb.value;
          kitsuSuccess = true;
        }
      }
      if (!aniList && !kitsu) {
        if (aniListSuccess && kitsuSuccess) {
          notFoundCache.set(cacheKey, Date.now() + 60 * 60 * 1e3);
        }
        return null;
      }
      const animeId = kitsu?.animeId || "anilist";
      const canonicalTitle = aniList?.canonicalTitle || kitsu?.canonicalTitle || primary;
      const posterUrl = aniList?.posterUrl || kitsu?.posterUrl || null;
      const mergedEpisodes = {};
      const allEpNumbers = /* @__PURE__ */ new Set([
        ...Object.keys(aniList?.episodes || {}).map(Number),
        ...Object.keys(kitsu?.episodes || {}).map(Number)
      ]);
      for (const epNum of allEpNumbers) {
        const aniEp = aniList?.episodes[epNum];
        const kitEp = kitsu?.episodes[epNum];
        mergedEpisodes[epNum] = {
          number: epNum,
          title: aniEp?.title || kitEp?.title || null,
          thumbnailUrl: kitEp?.thumbnailUrl || aniEp?.thumbnailUrl || null,
          synopsis: kitEp?.synopsis || aniEp?.synopsis || null
        };
      }
      const malId = aniList?.malId || null;
      const bannerUrl = aniList?.bannerUrl || null;
      const synopsis = aniList?.synopsis || null;
      const genres = aniList?.genres || [];
      const averageScore = aniList?.averageScore || null;
      const result = {
        animeId,
        malId,
        canonicalTitle,
        posterUrl,
        bannerUrl,
        synopsis,
        genres,
        averageScore,
        episodes: mergedEpisodes,
        fetchedAt: Date.now()
      };
      try {
        fs5.writeFileSync(cacheFile, JSON.stringify(result, null, 2), "utf-8");
      } catch {
      }
      memoryCache.set(cacheKey, result);
      return result;
    } catch {
      return null;
    }
  })();
  inFlightRequests.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}

// test-challenge-robustness.ts
var uncaughtErrors = [];
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]:", err);
  uncaughtErrors.push(err);
});
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]:", err);
  uncaughtErrors.push(err);
});
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function runChallenges() {
  console.log("================================================================");
  console.log("Starting Empirical Challenger Test Suite (Milestone 1 Core)");
  console.log("================================================================\n");
  console.log("--- CHALLENGE 1: HTTP Server Resilience & Abrupt Socket Aborts ---");
  const testDir = path7.join(process.cwd(), ".test_server_resilience_tmp");
  fs6.mkdirSync(testDir, { recursive: true });
  const dummyVideo = path7.join(testDir, "test-episode-01.mkv");
  fs6.writeFileSync(dummyVideo, Buffer.alloc(1024 * 1024, 85));
  const sidecarThumb = path7.join(testDir, "test-episode-01.jpg");
  const dummyJpgData = Buffer.alloc(64 * 1024, 170);
  dummyJpgData[0] = 255;
  dummyJpgData[1] = 216;
  dummyJpgData[dummyJpgData.length - 2] = 255;
  dummyJpgData[dummyJpgData.length - 1] = 217;
  fs6.writeFileSync(sidecarThumb, dummyJpgData);
  const currentSettings = storage.getSettings();
  storage.updateSettings({
    libraryFolders: Array.from(/* @__PURE__ */ new Set([...currentSettings.libraryFolders || [], testDir]))
  });
  const server = new LocalStreamServer();
  const port = await server.start();
  assert(port > 0, `Server must start on valid port (got ${port})`);
  console.log(`\u2713 LocalStreamServer started on 127.0.0.1:${port}`);
  console.log("1A. Simulating 50 rapid socket aborts before headers...");
  const abortPromises = [];
  for (let i = 0; i < 50; i++) {
    abortPromises.push(
      new Promise((resolve) => {
        const client = net.connect(port, "127.0.0.1", () => {
          client.write(`GET /thumb?file=${encodeURIComponent(dummyVideo)}&type=card HTTP/1.1\r
Host: 127.0.0.1:${port}\r
Connection: close\r
\r
`);
          client.destroy();
          resolve();
        });
        client.on("error", () => resolve());
      })
    );
  }
  await Promise.all(abortPromises);
  await sleep(100);
  console.log("\u2713 50 rapid socket aborts handled without server crash");
  console.log("1B. Simulating 50 staggered socket aborts mid-stream...");
  const staggeredPromises = [];
  for (let i = 0; i < 50; i++) {
    staggeredPromises.push(
      new Promise((resolve) => {
        const delay = Math.floor(Math.random() * 30);
        const client = net.connect(port, "127.0.0.1", () => {
          client.write(`GET /thumb?file=${encodeURIComponent(dummyVideo)}&type=card HTTP/1.1\r
Host: 127.0.0.1:${port}\r
Connection: close\r
\r
`);
          setTimeout(() => {
            client.destroy();
            resolve();
          }, delay);
        });
        client.on("error", () => resolve());
      })
    );
  }
  await Promise.all(staggeredPromises);
  await sleep(100);
  console.log("\u2713 50 staggered mid-stream aborts handled cleanly");
  console.log("1C. Verifying server remains fully operational after aborts...");
  const normalRes = await new Promise((resolve, reject) => {
    http2.get(`http://127.0.0.1:${port}/thumb?file=${encodeURIComponent(dummyVideo)}&type=card`, (res) => {
      let len = 0;
      res.on("data", (chunk) => {
        len += chunk.length;
      });
      res.on("end", () => resolve({ statusCode: res.statusCode || 0, dataLength: len }));
      res.on("error", reject);
    }).on("error", reject);
  });
  assert.strictEqual(normalRes.statusCode, 200, `Expected 200 OK after barrage, got ${normalRes.statusCode}`);
  assert.strictEqual(normalRes.dataLength, dummyJpgData.length, "Must return full thumbnail data");
  console.log("\u2713 Server responded 200 OK with correct thumbnail content");
  console.log("1D. Verifying security rejection on forbidden file paths...");
  const forbiddenRes = await new Promise((resolve, reject) => {
    http2.get(`http://127.0.0.1:${port}/thumb?file=C:\\Windows\\System32\\calc.exe&type=card`, (res) => {
      resolve(res.statusCode || 0);
    }).on("error", reject);
  });
  assert.strictEqual(forbiddenRes, 403, "Must return 403 Forbidden for unauthorized paths");
  console.log("\u2713 Security checks return 403 Forbidden as expected");
  console.log("1E. Verifying /stream endpoint handles abrupt client disconnects...");
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => {
      const client = net.connect(port, "127.0.0.1", () => {
        client.write(`GET /stream?file=${encodeURIComponent(dummyVideo)} HTTP/1.1\r
Host: 127.0.0.1:${port}\r
Connection: close\r
\r
`);
        setTimeout(() => {
          client.destroy();
          resolve();
        }, 10);
      });
      client.on("error", () => resolve());
    });
  }
  await sleep(150);
  console.log("\u2713 /stream endpoint handles abrupt client disconnects cleanly");
  server.stopActiveStreams();
  await sleep(200);
  fs6.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log("--- CHALLENGE 2: Kitsu Pagination Logic Stress Testing ---");
  const origFetch = global.fetch;
  function createMockEpisodeData(startNum, count) {
    return Array.from({ length: count }, (_, idx) => {
      const epNum = startNum + idx;
      return {
        id: `ep-${epNum}`,
        type: "episodes",
        attributes: {
          number: epNum,
          canonicalTitle: `Episode ${epNum} Title`,
          synopsis: `Synopsis for episode ${epNum}`,
          thumbnail: {
            original: `https://media.kitsu.io/episodes/${epNum}.jpg`
          }
        }
      };
    });
  }
  console.log("2A. Testing 50 items with links.next absent...");
  const showName2A = `Challenge Show 2A ${Date.now()}`;
  let fetchCount2A = 0;
  global.fetch = async (input) => {
    const urlStr = typeof input === "string" ? input : input.url;
    if (urlStr.includes("graphql.anilist.co")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (urlStr.includes("filter[text]=")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "anime-2a", attributes: { canonicalTitle: showName2A } }]
        })
      };
    }
    if (urlStr.includes("/episodes?")) {
      fetchCount2A++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: createMockEpisodeData(1, 50),
          links: {}
          // No next link
        })
      };
    }
    return { ok: false, status: 404 };
  };
  const result2A = await getKitsuMetadata(showName2A);
  assert(result2A, "Result 2A must exist");
  assert.strictEqual(fetchCount2A, 1, `Expected 1 episode fetch call, got ${fetchCount2A}`);
  assert.strictEqual(Object.keys(result2A.episodes).length, 50, "Must have exactly 50 episodes");
  console.log("\u2713 50 items with absent next link terminated after 1 page");
  console.log("2B. Testing 100 items across 2 pages...");
  const showName2B = `Challenge Show 2B ${Date.now()}`;
  let fetchCount2B = 0;
  global.fetch = async (input) => {
    const urlStr = typeof input === "string" ? input : input.url;
    if (urlStr.includes("graphql.anilist.co")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (urlStr.includes("filter[text]=")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "anime-2b", attributes: { canonicalTitle: showName2B } }]
        })
      };
    }
    if (urlStr.includes("/episodes?")) {
      fetchCount2B++;
      const isPage1 = urlStr.includes("page[offset]=0");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: isPage1 ? createMockEpisodeData(1, 50) : createMockEpisodeData(51, 50),
          links: isPage1 ? { next: "https://kitsu.io/api/edge/anime/anime-2b/episodes?page[offset]=50" } : {}
        })
      };
    }
    return { ok: false, status: 404 };
  };
  const result2B = await getKitsuMetadata(showName2B);
  assert(result2B, "Result 2B must exist");
  assert.strictEqual(fetchCount2B, 2, `Expected 2 episode fetch calls, got ${fetchCount2B}`);
  assert.strictEqual(Object.keys(result2B.episodes).length, 100, "Must have exactly 100 episodes");
  assert(result2B.episodes[1] && result2B.episodes[100], "Must contain episode 1 and episode 100");
  console.log("\u2713 100 items across 2 pages terminated cleanly after 2 pages");
  console.log("2C. Testing 150 items across 3 pages...");
  const showName2C = `Challenge Show 2C ${Date.now()}`;
  let fetchCount2C = 0;
  global.fetch = async (input) => {
    const urlStr = typeof input === "string" ? input : input.url;
    if (urlStr.includes("graphql.anilist.co")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (urlStr.includes("filter[text]=")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "anime-2c", attributes: { canonicalTitle: showName2C } }]
        })
      };
    }
    if (urlStr.includes("/episodes?")) {
      fetchCount2C++;
      let startEp = 1;
      let hasNext = true;
      if (urlStr.includes("page[offset]=0")) {
        startEp = 1;
      } else if (urlStr.includes("page[offset]=50")) {
        startEp = 51;
      } else if (urlStr.includes("page[offset]=100")) {
        startEp = 101;
        hasNext = false;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: createMockEpisodeData(startEp, 50),
          links: hasNext ? { next: `https://kitsu.io/api/edge/anime/anime-2c/episodes?page[offset]=${startEp + 49}` } : {}
        })
      };
    }
    return { ok: false, status: 404 };
  };
  const result2C = await getKitsuMetadata(showName2C);
  assert(result2C, "Result 2C must exist");
  assert.strictEqual(fetchCount2C, 3, `Expected 3 episode fetch calls, got ${fetchCount2C}`);
  assert.strictEqual(Object.keys(result2C.episodes).length, 150, "Must have exactly 150 episodes");
  assert(result2C.episodes[1] && result2C.episodes[150], "Must contain episode 1 and episode 150");
  console.log("\u2713 150 items across 3 pages terminated cleanly after 3 pages");
  console.log("2D. Testing termination when data.length < limit (even if next link is present)...");
  const showName2D = `Challenge Show 2D ${Date.now()}`;
  let fetchCount2D = 0;
  global.fetch = async (input) => {
    const urlStr = typeof input === "string" ? input : input.url;
    if (urlStr.includes("graphql.anilist.co")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (urlStr.includes("filter[text]=")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "anime-2d", attributes: { canonicalTitle: showName2D } }]
        })
      };
    }
    if (urlStr.includes("/episodes?")) {
      fetchCount2D++;
      const isPage1 = urlStr.includes("page[offset]=0");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: isPage1 ? createMockEpisodeData(1, 50) : createMockEpisodeData(51, 30),
          // Notice links.next is maliciously present on page 2 even though count < 50
          links: { next: "https://kitsu.io/api/edge/anime/anime-2d/episodes?page[offset]=80" }
        })
      };
    }
    return { ok: false, status: 404 };
  };
  const result2D = await getKitsuMetadata(showName2D);
  assert(result2D, "Result 2D must exist");
  assert.strictEqual(fetchCount2D, 2, `Expected termination after 2 pages, got ${fetchCount2D}`);
  assert.strictEqual(Object.keys(result2D.episodes).length, 80, "Must have exactly 80 episodes");
  console.log("\u2713 Loop terminated immediately when data.length < limit (80 episodes)");
  console.log("2E. Testing 1500-episode safeguard limit...");
  const showName2E = `Challenge Show 2E ${Date.now()}`;
  let fetchCount2E = 0;
  global.fetch = async (input) => {
    const urlStr = typeof input === "string" ? input : input.url;
    if (urlStr.includes("graphql.anilist.co")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (urlStr.includes("filter[text]=")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "anime-2e", attributes: { canonicalTitle: showName2E } }]
        })
      };
    }
    if (urlStr.includes("/episodes?")) {
      fetchCount2E++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: createMockEpisodeData(fetchCount2E * 50 - 49, 50),
          links: { next: "https://kitsu.io/api/edge/anime/anime-2e/episodes?page[offset]=infinite" }
        })
      };
    }
    return { ok: false, status: 404 };
  };
  const result2E = await getKitsuMetadata(showName2E);
  assert(result2E, "Result 2E must exist");
  assert.strictEqual(fetchCount2E, 30, `Expected exactly 30 pages for 1500 cap, got ${fetchCount2E}`);
  assert.strictEqual(Object.keys(result2E.episodes).length, 1500, "Must cap at 1500 episodes");
  console.log("\u2713 1500-episode safeguard cap halted loop as intended");
  global.fetch = origFetch;
  console.log("\u2713 Kitsu pagination stress tests PASSED 100%!\n");
  console.log("--- CHALLENGE 3: Torrent Progress Detection (stat.blocks === undefined) ---");
  const torrentDir = path7.join(process.cwd(), ".test_torrent_resilience_tmp");
  fs6.mkdirSync(torrentDir, { recursive: true });
  console.log("3A. Companion file (.!qb) with partial size (45MB out of 100MB)...");
  const ep3APath = path7.join(torrentDir, "Episode3A.mkv");
  const comp3APath = path7.join(torrentDir, "Episode3A.mkv.!qb");
  fs6.writeFileSync(comp3APath, Buffer.alloc(45e4, 17));
  const filesInDir3A = /* @__PURE__ */ new Set(["Episode3A.mkv.!qb".toLowerCase()]);
  const stat3A = { size: 1e6, blocks: void 0, mtimeMs: Date.now() };
  const res3A = checkEpisodeDownloading(ep3APath, filesInDir3A, stat3A);
  assert.strictEqual(res3A.isDownloading, true, "Must detect as downloading");
  assert(typeof res3A.downloadProgress === "number", "downloadProgress must be a number");
  assert.strictEqual(res3A.downloadProgress, 45, `Expected 45% progress, got ${res3A.downloadProgress}`);
  console.log(`\u2713 3A verified: isDownloading=${res3A.isDownloading}, downloadProgress=${res3A.downloadProgress}%`);
  console.log("3B. Companion file pre-allocated with sparse zero checkpoints (4/10 non-zero)...");
  const ep3BPath = path7.join(torrentDir, "Episode3B.mkv");
  const comp3BPath = path7.join(torrentDir, "Episode3B.mkv.!qb");
  const size3B = 10 * 1024 * 1024;
  const fd3B = fs6.openSync(comp3BPath, "w");
  const zeroChunk = Buffer.alloc(64 * 1024, 0);
  for (let b = 0; b < size3B; b += zeroChunk.length) {
    fs6.writeSync(fd3B, zeroChunk);
  }
  const nonZeroBuf = Buffer.alloc(16384, 119);
  for (const frac of [0.05, 0.15, 0.25, 0.35]) {
    fs6.writeSync(fd3B, nonZeroBuf, 0, nonZeroBuf.length, Math.floor(size3B * frac));
  }
  fs6.closeSync(fd3B);
  const filesInDir3B = /* @__PURE__ */ new Set(["Episode3B.mkv.!qb".toLowerCase()]);
  const stat3B = { size: size3B, blocks: void 0, mtimeMs: Date.now() };
  const res3B = checkEpisodeDownloading(ep3BPath, filesInDir3B, stat3B);
  assert.strictEqual(res3B.isDownloading, true, "Must detect as downloading");
  assert.strictEqual(res3B.downloadProgress, 40, `Expected 40% (4/10 non-zero), got ${res3B.downloadProgress}`);
  console.log(`\u2713 3B verified: isDownloading=${res3B.isDownloading}, downloadProgress=${res3B.downloadProgress}%`);
  console.log("3C. Direct video file > 5MB with EBML header but zero tail...");
  const ep3CPath = path7.join(torrentDir, "Episode3C.mkv");
  const size3C = 8 * 1024 * 1024;
  const fd3C = fs6.openSync(ep3CPath, "w");
  const dataPattern = Buffer.alloc(64 * 1024, 51);
  for (let b = 0; b < size3C; b += dataPattern.length) {
    fs6.writeSync(fd3C, dataPattern);
  }
  const ebmlHeader = Buffer.from([26, 69, 223, 163]);
  fs6.writeSync(fd3C, ebmlHeader, 0, 4, 0);
  const zeroTail = Buffer.alloc(16384, 0);
  fs6.writeSync(fd3C, zeroTail, 0, zeroTail.length, size3C - zeroTail.length);
  fs6.closeSync(fd3C);
  const stat3C = { size: size3C, blocks: void 0, mtimeMs: Date.now() };
  const res3C = checkEpisodeDownloading(ep3CPath, /* @__PURE__ */ new Set(["Episode3C.mkv"]), stat3C);
  assert.strictEqual(res3C.isDownloading, true, "Must detect incomplete download due to zero tail");
  assert(typeof res3C.downloadProgress === "number", "Must compute progress despite stat.blocks === undefined");
  assert(res3C.downloadProgress > 0 && res3C.downloadProgress <= 99, `Progress must be in 1-99 range, got ${res3C.downloadProgress}`);
  console.log(`\u2713 3C verified: isDownloading=${res3C.isDownloading}, downloadProgress=${res3C.downloadProgress}%`);
  console.log("3D. Direct video file with valid tail but 3 internal zero checkpoints...");
  const ep3DPath = path7.join(torrentDir, "Episode3D.mkv");
  const size3D = 8 * 1024 * 1024;
  const fd3D = fs6.openSync(ep3DPath, "w");
  for (let b = 0; b < size3D; b += dataPattern.length) {
    fs6.writeSync(fd3D, dataPattern);
  }
  fs6.writeSync(fd3D, ebmlHeader, 0, 4, 0);
  const zeroBlock = Buffer.alloc(16384, 0);
  for (const frac of [0.3, 0.5, 0.7]) {
    fs6.writeSync(fd3D, zeroBlock, 0, zeroBlock.length, Math.floor(size3D * frac));
  }
  fs6.closeSync(fd3D);
  const stat3D = { size: size3D, blocks: void 0, mtimeMs: Date.now() };
  const res3D = checkEpisodeDownloading(ep3DPath, /* @__PURE__ */ new Set(["Episode3D.mkv"]), stat3D);
  assert.strictEqual(res3D.isDownloading, true, "Must detect incomplete download due to internal zero checkpoints");
  assert(typeof res3D.downloadProgress === "number", "Must compute progress");
  assert(res3D.downloadProgress > 0 && res3D.downloadProgress <= 99, `Progress must be in 1-99 range, got ${res3D.downloadProgress}`);
  console.log(`\u2713 3D verified: isDownloading=${res3D.isDownloading}, downloadProgress=${res3D.downloadProgress}%`);
  console.log("3E. Completed video file (all checkpoints and tail populated)...");
  const ep3EPath = path7.join(torrentDir, "Episode3E.mkv");
  const size3E = 8 * 1024 * 1024;
  const fd3E = fs6.openSync(ep3EPath, "w");
  for (let b = 0; b < size3E; b += dataPattern.length) {
    fs6.writeSync(fd3E, dataPattern);
  }
  fs6.writeSync(fd3E, ebmlHeader, 0, 4, 0);
  fs6.closeSync(fd3E);
  const stat3E = { size: size3E, blocks: void 0, mtimeMs: Date.now() };
  const res3E = checkEpisodeDownloading(ep3EPath, /* @__PURE__ */ new Set(["Episode3E.mkv"]), stat3E);
  assert.strictEqual(res3E.isDownloading, false, "Completed episode must NOT be marked as downloading");
  assert.strictEqual(res3E.downloadProgress, void 0, "Completed episode downloadProgress should be undefined");
  console.log(`\u2713 3E verified: isDownloading=${res3E.isDownloading}, downloadProgress=${res3E.downloadProgress}`);
  console.log("3F. Stub file < 512KB...");
  const stat3F = { size: 128 * 1024, blocks: void 0, mtimeMs: Date.now() };
  const res3F = checkEpisodeDownloading("C:/dummy/stub.mkv", /* @__PURE__ */ new Set(["stub.mkv"]), stat3F);
  assert.strictEqual(res3F.isDownloading, true, "Stub file must be flagged as downloading");
  assert.strictEqual(res3F.downloadProgress, 0, "Stub file must have progress 0");
  console.log(`\u2713 3F verified: isDownloading=${res3F.isDownloading}, downloadProgress=${res3F.downloadProgress}%`);
  fs6.rmSync(torrentDir, { recursive: true, force: true });
  console.log("\u2713 Torrent progress detection with stat.blocks === undefined PASSED 100%!\n");
  assert.strictEqual(uncaughtErrors.length, 0, "No uncaught exceptions occurred across entire challenge");
  console.log("================================================================");
  console.log("ALL EMPIRICAL CHALLENGES PASSED WITH ZERO CRASHES OR VIOLATIONS!");
  console.log("================================================================");
  process.exit(0);
}
runChallenges().catch((err) => {
  console.error("CHALLENGE FAILED WITH ERROR:", err);
  process.exit(1);
});
