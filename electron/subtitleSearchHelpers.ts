/**
 * Pure helper functions for online subtitle search, archive file matching,
 * episode/release scoring, and path validation. Zero Electron dependencies so
 * plain Node.js unit tests can import it directly.
 */

import path from 'path';
import { extractEpisodeNumber } from './episodes.ts';
import { findAllowedRootFor } from './pathSafety.ts';
import { parseReleaseSync } from '../src/lib/releaseParser/index.ts';
import { isSignsSubtitleTitle, isAllowedSignsLanguage } from './assSignsExtractor.ts';
import type { OnlineSubtitleResult } from './types.ts';

export interface TsukiHimeAttachment {
  id: number;
  type: number; // 0 = font, 1 = subtitle, 3 = tags/meta
  info?: {
    codec?: string;
    lang?: string;
    name?: string;
    default?: number;
    enabled?: number;
    forced?: number;
    trackid?: number;
    tracknum?: number;
    mime?: string;
  };
}

export interface TsukiHimeFileEntry {
  id: number;
  filename: string;
  size?: number;
  attachments?: TsukiHimeAttachment[];
}

export interface TsukiHimeTorrentSummary {
  id: number;
  name: string;
  btih?: string;
  audiolangs?: string[];
  sublangs?: string[];
  episode_no?: number | null;
  animetosho?: boolean;
  anime?: {
    id: number;
    title?: string;
    english_title?: string;
  };
}

/**
 * Ensures we only read/write subtitle sidecars for video files inside the
 * user's configured library folders (or the specific video directory when valid).
 */
export function isAllowedLibraryVideoPath(videoPath: string, allowedRoots: string[]): boolean {
  if (!videoPath || typeof videoPath !== 'string') return false;
  const cleanRoots = Array.isArray(allowedRoots) ? allowedRoots.filter((r) => typeof r === 'string' && r.trim()) : [];
  if (cleanRoots.length === 0) return false;
  return findAllowedRootFor(videoPath, cleanRoots) !== null;
}

/**
 * Computes the sidecar path next to `videoPath` that matches `findExternalSubtitles()`.
 * Never collides with `<base>.whisper.srt`.
 */
export function buildTargetSubtitlePath(
  videoPath: string,
  mode: 'signs' | 'main',
  format: 'ass' | 'ssa' | 'srt' | 'vtt'
): string {
  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const base = path.basename(videoPath, ext);
  const safeFormat = format === 'ssa' ? 'ssa' : format === 'vtt' ? 'vtt' : format === 'srt' ? 'srt' : 'ass';
  const suffix = mode === 'signs' ? '.en.signs' : '.en';
  return path.join(dir, `${base}${suffix}.${safeFormat}`);
}

/**
 * Decodes raw subtitle bytes handling UTF-8 BOM, UTF-16LE BOM, UTF-16BE BOM,
 * and plain UTF-8 text.
 */
export function decodeSubtitleBuffer(buf: Buffer): string {
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Swap bytes to decode UTF-16BE cleanly
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  return buf.toString('utf-8');
}

function detectFileKind(name: string): {
  isExtra: boolean;
  isMovie: boolean;
  isOva: boolean;
  isSpecial: boolean;
} {
  const lower = name.toLowerCase();
  const isExtra = /\b(?:ncop|nced|pv|preview|trailer|creditless|menu|cm)\d*\b/i.test(lower);
  const isMovie = /\b(?:movie|film|gekijouban)\b/i.test(lower);
  const isOva = /\b(?:ova|oad|ona)\b/i.test(lower);
  const isSpecial = /\b(?:special|specials|sp)\b/i.test(lower);
  return { isExtra, isMovie, isOva, isSpecial };
}

function inferSeasonFromPath(filePath: string): number | null {
  const parsed = parseReleaseSync(filePath);
  if (parsed.season !== null) return parsed.season;
  const normalized = filePath.replace(/[_.-]/g, ' ');
  const m = normalized.match(/\b(?:season|series|s)\s*0*(\d{1,2})\b/i);
  if (m) return parseInt(m[1], 10);
  const ord = normalized.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i);
  if (ord) return parseInt(ord[1], 10);
  // Japanese sequels like "K-On!!" or "Working'!!" often denote season 2 in folder names
  if (/!!/.test(filePath) && !/!!!/.test(filePath)) return 2;
  return null;
}

/**
 * Picks the best matching episode file inside a TsukiHime torrent (supports both
 * single-episode releases and multi-season complete batches like `[Anime Time] K-On!`).
 */
export function matchEpisodeFileInTsukiHimeFiles(
  files: TsukiHimeFileEntry[],
  localFileName: string,
  targetEpisode: number | null,
  targetSeason: number | null
): TsukiHimeFileEntry | null {
  if (!Array.isArray(files) || files.length === 0) return null;

  const videoFiles = files.filter((f) => /\.(?:mkv|mp4|avi|webm|m4v|ass|srt)$/i.test(f.filename || ''));
  const pool = videoFiles.length > 0 ? videoFiles : files;
  if (pool.length === 1) {
    const only = pool[0];
    if (targetEpisode !== null) {
      const ep = extractEpisodeNumber(path.posix.basename(only.filename)).episodeNum;
      if (ep !== null && ep !== targetEpisode) return null;
    }
    return only;
  }

  const localKind = detectFileKind(localFileName);
  let best: TsukiHimeFileEntry | null = null;
  let bestScore = -Infinity;

  for (const file of pool) {
    const relPath = file.filename || '';
    const baseName = path.posix.basename(relPath);
    const kind = detectFileKind(relPath);

    // Never match NCOP/NCED/PV unless the local video itself is one
    if (kind.isExtra && !localKind.isExtra) continue;
    if (kind.isMovie !== localKind.isMovie && (kind.isMovie || localKind.isMovie)) continue;
    if (kind.isOva !== localKind.isOva && (kind.isOva || localKind.isOva)) continue;
    if (kind.isSpecial !== localKind.isSpecial && (kind.isSpecial || localKind.isSpecial)) continue;

    let score = 0;

    if (localKind.isMovie && kind.isMovie) {
      score += 120;
    }

    const fileEp = extractEpisodeNumber(baseName).episodeNum;
    if (targetEpisode !== null) {
      if (fileEp === targetEpisode) {
        score += 150;
      } else if (fileEp !== null) {
        // Explicit wrong episode
        continue;
      } else {
        score -= 40;
      }
    }

    const fileSeason = inferSeasonFromPath(relPath);
    if (targetSeason !== null && fileSeason !== null) {
      if (fileSeason === targetSeason) score += 60;
      else score -= 140;
    } else if ((targetSeason === 1 || targetSeason === null) && fileSeason !== null && fileSeason > 1) {
      // Unqualified Season 1 episode names (e.g. "K-On! - 02.mkv") must not pick Season 2+ in complete-series packs
      score -= 100;
    } else if (targetSeason === 1 && fileSeason === null) {
      score += 10;
    }

    // Prefer files that actually have text subtitle attachments
    const textSubs = (file.attachments || []).filter(
      (a) => a.type === 1 && /^(?:ass|ssa|srt|subrip|vtt|webvtt)$/i.test(a.info?.codec || '')
    );
    if (textSubs.length > 0) score += 25;
    if (textSubs.some((a) => a.info?.forced === 1 || isSignsSubtitleTitle(a.info?.name))) score += 15;

    if (score > bestScore) {
      bestScore = score;
      best = file;
    }
  }

  return bestScore > 0 ? best : null;
}

/**
 * Picks the best subtitle file inside an unpacked archive (e.g. SubSource/SubDL ZIP).
 */
export function pickBestSubtitleFileFromList(
  filePaths: string[],
  targetEpisode: number | null,
  preferSigns: boolean
): string | null {
  const candidates = filePaths.filter(
    (p) =>
      /\.(?:ass|ssa|srt|vtt)$/i.test(p) &&
      !/__MACOSX/i.test(p) &&
      !/[/\\]\._/.test(p)
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  let best: string | null = null;
  let bestScore = -Infinity;

  for (const filePath of candidates) {
    const base = path.basename(filePath);
    const ext = path.extname(base).toLowerCase();
    const ep = extractEpisodeNumber(base).episodeNum;
    const isSigns = isSignsSubtitleTitle(base);

    let score = 0;
    if (targetEpisode !== null) {
      if (ep === targetEpisode) score += 120;
      else if (ep !== null) score -= 120;
    }
    if (preferSigns) {
      if (isSigns) score += 60;
      if (ext === '.ass' || ext === '.ssa') score += 35;
    } else {
      if (!isSigns) score += 30;
      if (ext === '.ass' || ext === '.ssa') score += 10;
    }
    if (/(?:^|[._\s-])(?:en|eng|english)(?:$|[._\s-])/i.test(base)) score += 15;

    if (score > bestScore) {
      bestScore = score;
      best = filePath;
    }
  }

  return best;
}

/**
 * Scores an online subtitle result relative to the current episode, release group,
 * and search mode (`signs` vs `all`).
 */
export function scoreOnlineSubtitleResult(
  item: Omit<OnlineSubtitleResult, 'matchScore'>,
  context: {
    mode: 'signs' | 'all';
    localReleaseGroup?: string | null;
    localFileName?: string;
  }
): number {
  let score = 0;
  const isAss = item.format === 'ass' || item.format === 'ssa';

  if (context.mode === 'signs') {
    if (item.isSignsOnly && isAss) score += 200;
    else if (item.isSignsOnly) score += 145;
    else if (item.canExtractSigns) score += 110;
    else score += 10;
  } else {
    if (!item.isSignsOnly && isAss) score += 140;
    else if (!item.isSignsOnly) score += 110;
    else score += 30;
  }

  // Provider trust for anime typesetting
  if (item.provider === 'tsukihime') score += 35;
  else if (item.provider === 'subsource') score += 20;
  else if (item.provider === 'subdl') score += 18;
  else if (item.provider === 'opensubtitles') score += 15;

  // Exact release group match gives near-perfect timing alignment
  const hay = `${item.releaseName || ''} ${item.title}`.toLowerCase();
  if (context.localReleaseGroup) {
    const grp = context.localReleaseGroup.trim().toLowerCase();
    if (grp && hay.includes(grp)) {
      score += 60;
    }
  }

  // Boost well-known high-accuracy anime groups
  if (/\b(?:mtbb|koala|anime\s*time|tsundere|semisu|subsplease|erai-raws|some-stuffs|judas|ember|doki|commie|kawaiika)\b/i.test(hay)) {
    score += 12;
  }

  if (typeof item.downloadCount === 'number' && item.downloadCount > 0) {
    score += Math.min(10, Math.floor(Math.log10(item.downloadCount + 1) * 3));
  }

  return score;
}

/**
 * Scores a TsukiHime torrent summary so we only fetch `/v1/torrents/{id}` detail
 * JSON for the strongest candidates.
 */
export function scoreTsukiHimeTorrentCandidate(
  torrent: TsukiHimeTorrentSummary,
  context: {
    targetEpisode: number | null;
    localReleaseGroup?: string | null;
    localTitle?: string;
  }
): number {
  const name = (torrent.name || '').trim();
  if (!name) return -999;

  // Skip explicit wrong single-episode torrents
  if (
    torrent.episode_no !== null &&
    torrent.episode_no !== undefined &&
    context.targetEpisode !== null &&
    torrent.episode_no !== context.targetEpisode
  ) {
    return -999;
  }

  // Skip torrents that explicitly only carry non-English / non-zxx subs
  const sublangs = Array.isArray(torrent.sublangs) ? torrent.sublangs.map((s) => s.toLowerCase()) : [];
  if (sublangs.length > 0 && !sublangs.some((l) => isAllowedSignsLanguage(l))) {
    return -999;
  }

  let score = 0;
  if (torrent.episode_no === context.targetEpisode && context.targetEpisode !== null) score += 50;
  else if (torrent.episode_no === null || torrent.episode_no === undefined) score += 25; // Batch / Season pack

  if (sublangs.includes('en') || sublangs.includes('eng') || sublangs.includes('zxx')) score += 30;
  if (Array.isArray(torrent.audiolangs) && torrent.audiolangs.includes('en')) score += 20; // Dual-audio often has dedicated Signs track

  if (context.localReleaseGroup) {
    const grp = context.localReleaseGroup.trim().toLowerCase();
    if (grp && name.toLowerCase().includes(grp)) score += 80;
  }

  if (/dual[\s._-]*audio/i.test(name)) score += 15;
  if (/\[(?:mtbb|koala|anime\s*time|tsundere|semisu|subsplease|erai-raws|some-stuffs|judas|ember)\]/i.test(name)) {
    score += 15;
  }
  if (/bdmv|raws?\b/i.test(name) && sublangs.length === 0) score -= 40;

  return score;
}

export function normalizeSubtitleFormat(raw?: string | null): 'ass' | 'ssa' | 'srt' | 'vtt' {
  const c = (raw || '').trim().toLowerCase();
  if (c === 'ass' || c === 's_text/ass' || c.endsWith('.ass')) return 'ass';
  if (c === 'ssa' || c === 's_text/ssa' || c.endsWith('.ssa')) return 'ssa';
  if (c === 'vtt' || c === 'webvtt' || c === 's_text/webvtt' || c.endsWith('.vtt')) return 'vtt';
  return 'srt';
}
