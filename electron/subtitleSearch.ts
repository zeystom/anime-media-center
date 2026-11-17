/**
 * Online Subtitle Search & Signs/Songs Extractor Service.
 *
 * Combines:
 *  1. Local extraction of Signs & Songs from an embedded `.ass`/`.ssa` track
 *     already inside the video container (zero network needed).
 *  2. Keyless anime-first search via TsukiHime (`api.tsukihime.org/v1` +
 *     `storage.tsukihime.org`), which hosts extracted `.ass` tracks and fonts.
 *  3. Optional BYOC API-key providers: SubSource, SubDL, and OpenSubtitles.
 *
 * When a Signs search only finds a full `.ass` track, `extractSignsFromAss`
 * strips spoken dialogue and saves a clean `<episode>.en.signs.ass` sidecar.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { app } from 'electron';
import { storage, findExecutableInPath } from './storage.ts';
import {
  probeMkv,
  extractEmbeddedAss,
  getFolderHash,
  invalidateProbeCache,
} from './ffmpeg.ts';
import { getFribbIndex, lookupFribbIds } from './fribb.ts';
import { querySearch } from './anilist.ts';
import { extractEpisodeNumber } from './episodes.ts';
import { parseRelease } from '../src/lib/releaseParser/index.ts';
import {
  extractSignsFromAss,
  findReferencedAssFontTokens,
  isAllowedSignsLanguage,
  isSignsSubtitleTitle,
} from './assSignsExtractor.ts';
import {
  buildTargetSubtitlePath,
  decodeSubtitleBuffer,
  isAllowedLibraryVideoPath,
  matchEpisodeFileInTsukiHimeFiles,
  normalizeSubtitleFormat,
  pickBestSubtitleFileFromList,
  scoreOnlineSubtitleResult,
  scoreTsukiHimeTorrentCandidate,
  type TsukiHimeFileEntry,
  type TsukiHimeTorrentSummary,
} from './subtitleSearchHelpers.ts';
import type {
  AppSettings,
  OnlineSubtitleResult,
  SubtitleActionResult,
  SubtitleSearchProviderReport,
  SubtitleSearchResponse,
} from './types.ts';

const REQUEST_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_TSUKIHIME_TORRENT_DETAILS = 7;
const MAX_FONTS_PER_DOWNLOAD = 20;

function getKaikoUserAgent(): string {
  try {
    const ver = app && typeof app.getVersion === 'function' ? app.getVersion() : '';
    if (ver) return `Kaiko/${ver}`;
  } catch {}
  return 'Kaiko/3.3.2';
}

function runExecFileBuffer(cmd: string, args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });
}

function detectTextSubtitleFormat(content: string): 'ass' | 'srt' | 'vtt' {
  if (/\[Script Info\]/i.test(content) && /\[Events\]/i.test(content)) return 'ass';
  if (/^WEBVTT/i.test(content.trimStart())) return 'vtt';
  return 'srt';
}

type FetchImpl = typeof fetch;
let cachedNetFetch: FetchImpl | null | undefined;

async function resolveFetch(): Promise<FetchImpl> {
  if (cachedNetFetch === undefined) {
    cachedNetFetch = null;
    try {
      const electronModule = (await import('electron')) as unknown as { net?: { fetch?: unknown } };
      if (electronModule?.net && typeof electronModule.net.fetch === 'function') {
        cachedNetFetch = (electronModule.net.fetch as FetchImpl).bind(electronModule.net);
      }
    } catch {}
  }
  return cachedNetFetch ?? globalThis.fetch;
}

function getAllowedRoots(settings: AppSettings): string[] {
  const roots: string[] = [];
  if (Array.isArray(settings.libraryFolders)) roots.push(...settings.libraryFolders);
  if (settings.defaultLibraryRoot) roots.push(settings.defaultLibraryRoot);
  return roots;
}

function resolve7zExecutable(): string | null {
  try {
    if (process.resourcesPath) {
      const bundled = path.join(process.resourcesPath, 'bin', '7z.exe');
      if (fs.existsSync(bundled)) return bundled;
    }
  } catch {}
  try {
    if (app && typeof app.getAppPath === 'function') {
      const app7z = path.join(app.getAppPath(), 'bin', '7z.exe');
      if (fs.existsSync(app7z)) return app7z;
    }
  } catch {}
  const local7z = path.join(process.cwd(), 'bin', '7z.exe');
  if (fs.existsSync(local7z)) return local7z;
  try {
    const execDir = path.dirname(process.execPath);
    for (const rel of [path.join(execDir, 'bin', '7z.exe'), path.join(execDir, 'resources', 'bin', '7z.exe')]) {
      if (fs.existsSync(rel)) return rel;
    }
  } catch {}
  for (const cand of ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe']) {
    if (fs.existsSync(cand)) return cand;
  }
  return findExecutableInPath('7z.exe') || findExecutableInPath('7za.exe');
}

function isArchiveBuffer(buf: Buffer): boolean {
  if (!buf || buf.length < 6) return false;
  // XZ: FD 37 7A 58 5A 00
  if (buf[0] === 0xfd && buf[1] === 0x37 && buf[2] === 0x7a && buf[3] === 0x58 && buf[4] === 0x5a) return true;
  // ZIP: PK\x03\x04
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return true;
  // 7z: 37 7A BC AF 27 1C
  if (buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf) return true;
  // RAR: Rar!
  if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return true;
  // GZIP: 1F 8B
  if (buf[0] === 0x1f && buf[1] === 0x8b) return true;
  return false;
}

async function decompressSingleXzBuffer(buf: Buffer): Promise<Buffer> {
  const sevenZip = resolve7zExecutable();
  if (!sevenZip) {
    throw new Error('7z.exe was not found to decompress subtitle attachment.');
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiko-sub-xz-'));
  try {
    const tmpXz = path.join(tmpDir, 'payload.xz');
    fs.writeFileSync(tmpXz, buf);
    return await runExecFileBuffer(sevenZip, ['e', '-so', tmpXz], path.dirname(sevenZip));
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

async function unpackArchiveSubtitle(
  buf: Buffer,
  targetEpisode: number | null,
  preferSigns: boolean
): Promise<{ content: string; format: 'ass' | 'ssa' | 'srt' | 'vtt' }> {
  if (!isArchiveBuffer(buf)) {
    const content = decodeSubtitleBuffer(buf);
    return { content, format: detectTextSubtitleFormat(content) };
  }

  // Single .xz stream (TsukiHime attachment)
  if (buf[0] === 0xfd && buf[1] === 0x37 && buf[2] === 0x7a && buf[3] === 0x58) {
    const raw = await decompressSingleXzBuffer(buf);
    const content = decodeSubtitleBuffer(raw);
    return { content, format: detectTextSubtitleFormat(content) };
  }

  // Container archive (.zip / .7z / .rar)
  const sevenZip = resolve7zExecutable();
  if (!sevenZip) {
    throw new Error('7z.exe was not found to unpack downloaded subtitle archive.');
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiko-sub-arc-'));
  try {
    const archivePath = path.join(tmpDir, 'archive.bin');
    const outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(archivePath, buf);

    await runExecFileBuffer(sevenZip, ['x', archivePath, `-o${outDir}`, '-y'], path.dirname(sevenZip));

    const collected: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) collected.push(full);
      }
    };
    walk(outDir);

    const chosen = pickBestSubtitleFileFromList(collected, targetEpisode, preferSigns);
    if (!chosen) {
      throw new Error('Downloaded archive did not contain any .ass or .srt subtitle files.');
    }
    const content = decodeSubtitleBuffer(fs.readFileSync(chosen));
    const ext = path.extname(chosen).toLowerCase().replace('.', '');
    return { content, format: normalizeSubtitleFormat(ext) };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

async function fetchJson<T = any>(url: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const f = await resolveFetch();
  const res = await f(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': getKaikoUserAgent(),
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${errText ? `: ${errText.slice(0, 120)}` : ''}`);
  }
  return (await res.json()) as T;
}

async function fetchBuffer(url: string, init?: RequestInit, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<Buffer> {
  const f = await resolveFetch();
  const res = await f(url, {
    ...init,
    headers: {
      'User-Agent': getKaikoUserAgent(),
      ...(init?.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

interface SearchContext {
  filePath: string;
  fileName: string;
  cleanSeriesTitle: string;
  queryTitle: string;
  episodeNumber: number | null;
  seasonNumber: number | null;
  releaseGroup: string | null;
  anilistId: number | null;
  imdbId: string | null;
  tvdbId: number | null;
}

async function resolveSearchContext(params: {
  filePath: string;
  folderPath?: string;
  animeTitle?: string;
  anilistId?: number | null;
  queryOverride?: string;
}): Promise<SearchContext> {
  const fileName = path.basename(params.filePath);
  const parsed = await parseRelease(fileName);
  const epInfo = extractEpisodeNumber(fileName);

  const fallbackFolderTitle = params.folderPath
    ? path.basename(params.folderPath).replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
    : '';

  const cleanSeriesTitle =
    (params.animeTitle && params.animeTitle.trim()) ||
    parsed.animeTitle ||
    fallbackFolderTitle ||
    path.basename(fileName, path.extname(fileName));

  const queryTitle = (params.queryOverride && params.queryOverride.trim()) || cleanSeriesTitle;

  let anilistId = typeof params.anilistId === 'number' && params.anilistId > 0 ? params.anilistId : null;
  if (!anilistId && cleanSeriesTitle) {
    try {
      const hits = await querySearch(cleanSeriesTitle, 5);
      if (hits.length > 0 && hits[0]?.id) {
        anilistId = hits[0].id;
      }
    } catch {}
  }

  let imdbId: string | null = null;
  let tvdbId: number | null = null;
  if (anilistId) {
    try {
      await getFribbIndex();
      const ids = lookupFribbIds(anilistId);
      if (ids) {
        imdbId = ids.imdbId;
        tvdbId = ids.tvdbId;
      }
    } catch {}
  }

  return {
    filePath: params.filePath,
    fileName,
    cleanSeriesTitle,
    queryTitle,
    episodeNumber: epInfo.episodeNum ?? parsed.episodeNumber ?? null,
    seasonNumber: parsed.season ?? null,
    releaseGroup: parsed.releaseGroup || null,
    anilistId,
    imdbId,
    tvdbId,
  };
}

// ---- Provider 1: TsukiHime (keyless anime-first ASS + fonts) ----

async function searchTsukiHimeProvider(
  ctx: SearchContext,
  mode: 'signs' | 'all',
  hasQueryOverride: boolean
): Promise<Omit<OnlineSubtitleResult, 'matchScore'>[]> {
  const animeIds = new Set<number>();

  if (!hasQueryOverride && ctx.anilistId) {
    try {
      const anime = await fetchJson<{ id?: number }>(`https://api.tsukihime.org/v1/animes/anilist/${ctx.anilistId}`);
      if (anime?.id) animeIds.add(anime.id);
    } catch {}
  }

  // Also search by anime title when AniList ID is missing, overridden, or sequel/movie folder may share S1 ID
  const needTextAnimeSearch =
    hasQueryOverride ||
    animeIds.size === 0 ||
    (ctx.seasonNumber !== null && ctx.seasonNumber > 1) ||
    /\b(?:movie|film|ova|special)\b/i.test(ctx.fileName);

  if (needTextAnimeSearch && ctx.queryTitle) {
    try {
      const res = await fetchJson<{ results?: Array<{ id?: number }> }>(
        `https://api.tsukihime.org/v1/animes?q=${encodeURIComponent(ctx.queryTitle)}&limit=5`
      );
      for (const a of res.results || []) {
        if (a?.id) animeIds.add(a.id);
        if (animeIds.size >= 3) break;
      }
    } catch {}
  }

  const candidateTorrents = new Map<number, TsukiHimeTorrentSummary>();

  const torrentQueries: Promise<void>[] = [];
  for (const aid of animeIds) {
    torrentQueries.push(
      fetchJson<{ results?: TsukiHimeTorrentSummary[] }>(
        `https://api.tsukihime.org/v1/torrents?anime_id=${aid}&limit=35`
      )
        .then((d) => {
          for (const t of d.results || []) {
            if (t?.id) candidateTorrents.set(t.id, t);
          }
        })
        .catch(() => {})
    );
  }

  if (hasQueryOverride || animeIds.size === 0) {
    torrentQueries.push(
      fetchJson<{ results?: TsukiHimeTorrentSummary[] }>(
        `https://api.tsukihime.org/v1/search/torrents?q=${encodeURIComponent(ctx.queryTitle)}&limit=20`
      )
        .then((d) => {
          for (const t of d.results || []) {
            if (t?.id) candidateTorrents.set(t.id, t);
          }
        })
        .catch(() => {})
    );
  }

  await Promise.allSettled(torrentQueries);

  if (candidateTorrents.size === 0) return [];

  const rankedTorrents = [...candidateTorrents.values()]
    .map((t) => ({
      torrent: t,
      score: scoreTsukiHimeTorrentCandidate(t, {
        targetEpisode: ctx.episodeNumber,
        localReleaseGroup: ctx.releaseGroup,
        localTitle: ctx.cleanSeriesTitle,
      }),
    }))
    .filter((x) => x.score > -100)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_TSUKIHIME_TORRENT_DETAILS);

  const detailResults = await Promise.allSettled(
    rankedTorrents.map(({ torrent }) =>
      fetchJson<{
        id: number;
        name: string;
        animetosho?: boolean;
        files?: TsukiHimeFileEntry[];
      }>(`https://api.tsukihime.org/v1/torrents/${torrent.id}`)
    )
  );

  const out: Omit<OnlineSubtitleResult, 'matchScore'>[] = [];
  const seenKey = new Set<string>();

  for (const settled of detailResults) {
    if (settled.status !== 'fulfilled') continue;
    const tor = settled.value;
    if (!tor || !Array.isArray(tor.files)) continue;

    const matchedFile = matchEpisodeFileInTsukiHimeFiles(
      tor.files,
      ctx.fileName,
      ctx.episodeNumber,
      ctx.seasonNumber
    );
    if (!matchedFile || !Array.isArray(matchedFile.attachments)) continue;

    const fontAttachments = matchedFile.attachments
      .filter((a) => a.type === 0 && a.id && a.info?.name && /\.(?:ttf|otf|woff2?)$/i.test(a.info.name))
      .map((a) => ({ id: a.id, name: a.info!.name! }));

    const subAttachments = matchedFile.attachments.filter((a) => a.type === 1 && a.id && a.info);

    for (const sub of subAttachments) {
      const info = sub.info!;
      const rawCodec = (info.codec || '').toUpperCase();
      if (!/^(?:ASS|SSA|SRT|SUBRIP|VTT|WEBVTT|S_TEXT\/ASS|S_TEXT\/SSA|S_TEXT\/UTF8|S_TEXT\/WEBVTT)$/.test(rawCodec)) continue;

      const lang = (info.lang || 'en').toLowerCase();
      if (!isAllowedSignsLanguage(lang)) continue;

      const trackName = (info.name || '').trim();
      const isSignsOnly =
        info.forced === 1 ||
        lang === 'zxx' ||
        isSignsSubtitleTitle(trackName);

      // Foreign/undetermined tracks without signs markers are skipped
      if ((lang === 'zxx' || lang === 'und') && !isSignsOnly) continue;

      const format = normalizeSubtitleFormat(rawCodec);
      const isAss = format === 'ass' || format === 'ssa';
      const canExtractSigns = !isSignsOnly && isAss;

      if (mode === 'signs' && !isSignsOnly && !canExtractSigns) continue;

      const dedupeKey = `${sub.id}`;
      if (seenKey.has(dedupeKey)) continue;
      seenKey.add(dedupeKey);

      const displayTitle = trackName || (isSignsOnly ? 'Signs & Songs' : `Full Subtitles (${format.toUpperCase()})`);
      out.push({
        id: `tsukihime-${sub.id}`,
        provider: 'tsukihime',
        providerLabel: 'TsukiHime',
        title: displayTitle,
        releaseName: tor.name,
        format,
        language: lang || 'en',
        isSignsOnly,
        canExtractSigns,
        sourceRef: {
          provider: 'tsukihime',
          tsukihimeTorrentId: tor.id,
          tsukihimeFileId: matchedFile.id,
          tsukihimeAttachId: sub.id,
          tsukihimeIsTosho: Boolean(tor.animetosho),
          tsukihimeAttachName: `sub.${format}`,
          tsukihimeFontAttachments: fontAttachments,
        },
      });
    }
  }

  return out;
}

// ---- Provider 2: SubSource (optional X-API-Key) ----

async function searchSubSourceProvider(
  ctx: SearchContext,
  mode: 'signs' | 'all',
  apiKey: string
): Promise<Omit<OnlineSubtitleResult, 'matchScore'>[]> {
  const headers = { 'X-API-Key': apiKey };
  let movies: Array<{ movieId?: number; id?: number; title?: string }> = [];

  if (ctx.imdbId) {
    try {
      const r = await fetchJson<{ data?: typeof movies }>(
        `https://api.subsource.net/api/v1/movies/search?searchType=imdb&imdb=${encodeURIComponent(ctx.imdbId)}`,
        { headers }
      );
      if (Array.isArray(r?.data)) movies = r.data;
    } catch {}
  }

  if (movies.length === 0 && ctx.queryTitle) {
    const r = await fetchJson<{ data?: typeof movies }>(
      `https://api.subsource.net/api/v1/movies/search?searchType=text&q=${encodeURIComponent(ctx.queryTitle)}`,
      { headers }
    );
    if (Array.isArray(r?.data)) movies = r.data;
  }

  const firstMovie = movies[0];
  const movieId = firstMovie?.movieId ?? firstMovie?.id;
  if (!movieId) return [];

  const subsRes = await fetchJson<{ data?: any[] }>(
    `https://api.subsource.net/api/v1/subtitles?movieId=${movieId}&language=english`,
    { headers }
  );
  const rawSubs = Array.isArray(subsRes?.data) ? subsRes.data : [];

  const out: Omit<OnlineSubtitleResult, 'matchScore'>[] = [];
  for (const item of rawSubs) {
    const subId = item?.subtitleId ?? item?.id;
    if (!subId) continue;

    const releaseName = String(item?.releaseName || item?.release_name || item?.title || firstMovie?.title || '').trim();
    const isFullSeason = Boolean(item?.fullSeason || item?.full_season);
    if (!isFullSeason && ctx.episodeNumber !== null) {
      const ep = extractEpisodeNumber(releaseName).episodeNum;
      if (ep !== null && ep !== ctx.episodeNumber) continue;
    }

    const isSignsOnly = Boolean(item?.forced) || isSignsSubtitleTitle(releaseName);
    const guessedFormat = /\.ass\b/i.test(releaseName) ? 'ass' : 'srt';
    const canExtractSigns = !isSignsOnly && guessedFormat === 'ass';
    if (mode === 'signs' && !isSignsOnly && !canExtractSigns) {
      // SubSource often packs .ass inside ZIPs without putting .ass in releaseName;
      // allow anime season/episode packs in 'all' mode, and signs-labeled or .ass in 'signs' mode.
      if (!/\b(?:ass|ssa|signs?|forced|dual[\s._-]*audio)\b/i.test(releaseName)) continue;
    }

    out.push({
      id: `subsource-${subId}`,
      provider: 'subsource',
      providerLabel: 'SubSource',
      title: releaseName || `SubSource #${subId}`,
      releaseName,
      format: guessedFormat,
      language: 'en',
      isSignsOnly,
      canExtractSigns: !isSignsOnly,
      downloadCount: typeof item?.downloads === 'number' ? item.downloads : undefined,
      sourceRef: {
        provider: 'subsource',
        subsourceId: Number(subId),
      },
    });
  }

  return out;
}

// ---- Provider 3: SubDL (optional api_key) ----

async function searchSubDLProvider(
  ctx: SearchContext,
  mode: 'signs' | 'all',
  apiKey: string
): Promise<Omit<OnlineSubtitleResult, 'matchScore'>[]> {
  const qs = new URLSearchParams({
    api_key: apiKey,
    languages: 'en',
    subs_per_page: '30',
  });
  if (ctx.imdbId) qs.set('imdb_id', ctx.imdbId);
  else qs.set('film_name', ctx.queryTitle);
  if (ctx.seasonNumber !== null) qs.set('season_number', String(ctx.seasonNumber));
  if (ctx.episodeNumber !== null) qs.set('episode_number', String(ctx.episodeNumber));

  const res = await fetchJson<{ status?: boolean; subtitles?: any[] }>(
    `https://api.subdl.com/api/v1/subtitles?${qs.toString()}`
  );
  const list = Array.isArray(res?.subtitles) ? res.subtitles : [];

  const out: Omit<OnlineSubtitleResult, 'matchScore'>[] = [];
  for (let idx = 0; idx < list.length; idx++) {
    const s = list[idx];
    if (!s?.url) continue;
    const rel = String(s.release_name || s.name || '').trim();
    const isSignsOnly = isSignsSubtitleTitle(rel);
    const guessedFormat = /\.ass\b/i.test(rel) ? 'ass' : 'srt';
    if (mode === 'signs' && !isSignsOnly && !/\b(?:ass|ssa|signs?|forced|dual[\s._-]*audio)\b/i.test(rel)) {
      continue;
    }

    out.push({
      id: `subdl-${idx}-${String(s.url)}`,
      provider: 'subdl',
      providerLabel: 'SubDL',
      title: rel || s.name || 'SubDL Subtitle',
      releaseName: rel,
      format: guessedFormat,
      language: 'en',
      isSignsOnly,
      canExtractSigns: !isSignsOnly && guessedFormat === 'ass',
      sourceRef: {
        provider: 'subdl',
        subdlUrl: String(s.url),
      },
    });
  }

  return out;
}

// ---- Provider 4: OpenSubtitles REST API (optional Api-Key) ----

async function searchOpenSubtitlesProvider(
  ctx: SearchContext,
  mode: 'signs' | 'all',
  apiKey: string
): Promise<Omit<OnlineSubtitleResult, 'matchScore'>[]> {
  const qs = new URLSearchParams({ languages: 'en' });
  if (ctx.imdbId) {
    qs.set('imdb_id', ctx.imdbId.replace(/^tt/i, ''));
  } else {
    qs.set('query', ctx.queryTitle);
  }
  if (ctx.seasonNumber !== null) qs.set('season_number', String(ctx.seasonNumber));
  if (ctx.episodeNumber !== null) qs.set('episode_number', String(ctx.episodeNumber));

  const res = await fetchJson<{ data?: any[] }>(
    `https://api.opensubtitles.com/api/v1/subtitles?${qs.toString()}`,
    {
      headers: {
        'Api-Key': apiKey,
        'User-Agent': getKaikoUserAgent().replace('/', ' v'),
      },
    }
  );

  const items = Array.isArray(res?.data) ? res.data : [];
  const out: Omit<OnlineSubtitleResult, 'matchScore'>[] = [];

  for (const row of items) {
    const attrs = row?.attributes;
    const file = Array.isArray(attrs?.files) ? attrs.files[0] : null;
    if (!attrs || !file?.file_id) continue;

    const releaseName = String(attrs.release || file.file_name || '').trim();
    const isSignsOnly = Boolean(attrs.foreign_parts_only) || isSignsSubtitleTitle(releaseName);
    const format = normalizeSubtitleFormat(path.extname(file.file_name || '') || 'srt');
    const canExtractSigns = !isSignsOnly && (format === 'ass' || format === 'ssa');

    if (mode === 'signs' && !isSignsOnly && !canExtractSigns) continue;

    out.push({
      id: `opensubtitles-${file.file_id}`,
      provider: 'opensubtitles',
      providerLabel: 'OpenSubtitles',
      title: releaseName || file.file_name || `OpenSubtitles #${file.file_id}`,
      releaseName,
      format,
      language: String(attrs.language || 'en').toLowerCase(),
      isSignsOnly,
      canExtractSigns,
      downloadCount: typeof attrs.download_count === 'number' ? attrs.download_count : undefined,
      sourceRef: {
        provider: 'opensubtitles',
        opensubtitlesFileId: Number(file.file_id),
      },
    });
  }

  return out;
}

// ---- Public Orchestrators ----

export async function searchOnlineSubtitles(params: {
  filePath: string;
  folderPath?: string;
  animeTitle?: string;
  anilistId?: number | null;
  mode: 'signs' | 'all';
  queryOverride?: string;
}): Promise<SubtitleSearchResponse> {
  const settings = storage.getSettings();
  const ctx = await resolveSearchContext(params);
  const mode: 'signs' | 'all' = params.mode === 'all' ? 'all' : 'signs';
  const hasOverride = Boolean(params.queryOverride && params.queryOverride.trim());

  const reports: SubtitleSearchProviderReport[] = [];
  const rawResults: Omit<OnlineSubtitleResult, 'matchScore'>[] = [];

  const subsourceKey = (settings.subsourceApiKey || '').trim();
  const subdlKey = (settings.subdlApiKey || '').trim();
  const opensubsKey = (settings.opensubtitlesApiKey || '').trim();

  const tasks: Array<Promise<void>> = [];

  tasks.push(
    searchTsukiHimeProvider(ctx, mode, hasOverride)
      .then((items) => {
        rawResults.push(...items);
        reports.push({ provider: 'tsukihime', label: 'TsukiHime', ok: true, count: items.length });
      })
      .catch((err: any) => {
        reports.push({
          provider: 'tsukihime',
          label: 'TsukiHime',
          ok: false,
          count: 0,
          error: err?.message || 'Request failed',
        });
      })
  );

  if (subsourceKey) {
    tasks.push(
      searchSubSourceProvider(ctx, mode, subsourceKey)
        .then((items) => {
          rawResults.push(...items);
          reports.push({ provider: 'subsource', label: 'SubSource', ok: true, count: items.length });
        })
        .catch((err: any) => {
          reports.push({
            provider: 'subsource',
            label: 'SubSource',
            ok: false,
            count: 0,
            error: err?.message || 'Request failed',
          });
        })
    );
  } else {
    reports.push({
      provider: 'subsource',
      label: 'SubSource',
      ok: false,
      count: 0,
      skippedReason: 'missing-api-key',
    });
  }

  if (subdlKey) {
    tasks.push(
      searchSubDLProvider(ctx, mode, subdlKey)
        .then((items) => {
          rawResults.push(...items);
          reports.push({ provider: 'subdl', label: 'SubDL', ok: true, count: items.length });
        })
        .catch((err: any) => {
          reports.push({
            provider: 'subdl',
            label: 'SubDL',
            ok: false,
            count: 0,
            error: err?.message || 'Request failed',
          });
        })
    );
  } else {
    reports.push({
      provider: 'subdl',
      label: 'SubDL',
      ok: false,
      count: 0,
      skippedReason: 'missing-api-key',
    });
  }

  if (opensubsKey) {
    tasks.push(
      searchOpenSubtitlesProvider(ctx, mode, opensubsKey)
        .then((items) => {
          rawResults.push(...items);
          reports.push({ provider: 'opensubtitles', label: 'OpenSubtitles', ok: true, count: items.length });
        })
        .catch((err: any) => {
          reports.push({
            provider: 'opensubtitles',
            label: 'OpenSubtitles',
            ok: false,
            count: 0,
            error: err?.message || 'Request failed',
          });
        })
    );
  } else {
    reports.push({
      provider: 'opensubtitles',
      label: 'OpenSubtitles',
      ok: false,
      count: 0,
      skippedReason: 'missing-api-key',
    });
  }

  await Promise.allSettled(tasks);

  const scored: OnlineSubtitleResult[] = rawResults
    .map((item) => ({
      ...item,
      matchScore: scoreOnlineSubtitleResult(item, {
        mode,
        localReleaseGroup: ctx.releaseGroup,
        localFileName: ctx.fileName,
      }),
    }))
    .sort((a, b) => b.matchScore - a.matchScore);

  return {
    results: scored,
    reports,
    resolvedIds: {
      anilistId: ctx.anilistId,
      imdbId: ctx.imdbId,
      tvdbId: ctx.tvdbId,
    },
    episodeNumber: ctx.episodeNumber,
    seasonNumber: ctx.seasonNumber,
    queryUsed: ctx.queryTitle,
  };
}

async function fetchTsukiHimeAttachmentBytes(
  attachId: number,
  isTosho: boolean,
  fileName: string
): Promise<Buffer> {
  const hex = attachId.toString(16).padStart(8, '0');
  const safeName = encodeURIComponent(fileName || 'attachment.bin');
  const primaryPrefix = isTosho ? 'tosho/attach' : 'attach';
  const fallbackPrefix = isTosho ? 'attach' : 'tosho/attach';

  try {
    return await fetchBuffer(`https://storage.tsukihime.org/${primaryPrefix}/${hex}/${safeName}.xz`);
  } catch {
    return await fetchBuffer(`https://storage.tsukihime.org/${fallbackPrefix}/${hex}/${safeName}.xz`);
  }
}

async function cacheMissingTsukiHimeFonts(
  videoPath: string,
  assContent: string,
  fontAttachments: Array<{ id: number; name: string }>,
  isTosho: boolean
): Promise<void> {
  if (!assContent || fontAttachments.length === 0) return;
  const referenced = findReferencedAssFontTokens(assContent);
  if (referenced.size === 0) return;

  const folderHash = getFolderHash(videoPath);
  const fontsDir = path.join(storage.getThumbnailDir(), 'fonts', folderHash);
  if (!fs.existsSync(fontsDir)) {
    fs.mkdirSync(fontsDir, { recursive: true });
  }

  const existingLower = new Set(
    fs.readdirSync(fontsDir).map((f) => f.toLowerCase())
  );

  const toFetch: Array<{ id: number; name: string }> = [];
  for (const att of fontAttachments) {
    const baseName = path.basename(att.name);
    if (!baseName || baseName.toLowerCase().endsWith('.ttc')) continue;
    if (baseName.toLowerCase().includes('arialunicodems')) continue;
    if (existingLower.has(baseName.toLowerCase())) continue;

    const cleanFile = baseName.toLowerCase().replace(/[\s-_]/g, '');
    let matchesRef = false;
    for (const ref of referenced) {
      if (cleanFile.includes(ref) || ref.includes(cleanFile.replace(/\.[a-z0-9]+$/, ''))) {
        matchesRef = true;
        break;
      }
    }
    if (matchesRef) {
      toFetch.push({ id: att.id, name: baseName });
      if (toFetch.length >= MAX_FONTS_PER_DOWNLOAD) break;
    }
  }

  if (toFetch.length === 0) return;

  await Promise.allSettled(
    toFetch.map(async (font) => {
      const xzBuf = await fetchTsukiHimeAttachmentBytes(font.id, isTosho, font.name);
      const rawFont = await decompressSingleXzBuffer(xzBuf);
      if (rawFont.length > 0) {
        const dest = path.join(fontsDir, font.name);
        fs.writeFileSync(dest, rawFont);
      }
    })
  );
}

async function finalizeSavedSubtitle(
  filePath: string,
  targetPath: string,
  ffmpegPath: string,
  keptCuesCount?: number,
  totalCuesCount?: number
): Promise<SubtitleActionResult> {
  invalidateProbeCache(filePath);
  const metadata = await probeMkv(filePath, ffmpegPath);
  const savedTrack = metadata.subtitleTracks.find(
    (t) => t.type === 'external' && t.filePath && path.resolve(t.filePath) === path.resolve(targetPath)
  );
  return {
    success: true,
    savedPath: targetPath,
    trackId: savedTrack?.id,
    keptCuesCount,
    totalCuesCount,
    metadata,
  };
}

/**
 * Downloads the selected online subtitle, optionally filters full `.ass` scripts
 * down to Signs & Songs only, writes the sidecar beside `filePath`, caches
 * referenced TsukiHime fonts if needed, and re-probes the video metadata.
 */
export async function downloadAndSaveOnlineSubtitle(params: {
  filePath: string;
  result: OnlineSubtitleResult;
  targetMode: 'signs' | 'main';
  extractSignsOnly?: boolean;
}): Promise<SubtitleActionResult> {
  const settings = storage.getSettings();
  const { filePath, result, targetMode } = params;

  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'Video file was not found on disk.' };
  }
  if (!isAllowedLibraryVideoPath(filePath, getAllowedRoots(settings))) {
    return { success: false, error: 'Target video path is outside configured library folders.' };
  }

  const targetEp = extractEpisodeNumber(path.basename(filePath)).episodeNum;
  const preferSigns = targetMode === 'signs';

  try {
    let rawContent = '';
    let format: 'ass' | 'ssa' | 'srt' | 'vtt' = result.format;
    const ref = result.sourceRef;

    if (ref.provider === 'tsukihime' && ref.tsukihimeAttachId) {
      const xzBuf = await fetchTsukiHimeAttachmentBytes(
        ref.tsukihimeAttachId,
        Boolean(ref.tsukihimeIsTosho),
        ref.tsukihimeAttachName || `sub.${result.format}`
      );
      const unpacked = await unpackArchiveSubtitle(xzBuf, targetEp, preferSigns);
      rawContent = unpacked.content;
      format = unpacked.format;
    } else if (ref.provider === 'subsource' && ref.subsourceId) {
      const apiKey = (settings.subsourceApiKey || '').trim();
      if (!apiKey) return { success: false, error: 'SubSource API key is not configured.' };
      const buf = await fetchBuffer(
        `https://api.subsource.net/api/v1/subtitles/${ref.subsourceId}/download`,
        { headers: { 'X-API-Key': apiKey } }
      );
      const unpacked = await unpackArchiveSubtitle(buf, targetEp, preferSigns);
      rawContent = unpacked.content;
      format = unpacked.format;
    } else if (ref.provider === 'subdl' && ref.subdlUrl) {
      const apiKey = (settings.subdlApiKey || '').trim();
      const dlUrl = ref.subdlUrl.startsWith('http')
        ? ref.subdlUrl
        : `https://dl.subdl.com${ref.subdlUrl.startsWith('/') ? '' : '/'}${ref.subdlUrl}`;
      const buf = await fetchBuffer(
        dlUrl,
        apiKey ? { headers: { 'x-api-key': apiKey } } : undefined
      );
      const unpacked = await unpackArchiveSubtitle(buf, targetEp, preferSigns);
      rawContent = unpacked.content;
      format = unpacked.format;
    } else if (ref.provider === 'opensubtitles' && ref.opensubtitlesFileId) {
      const apiKey = (settings.opensubtitlesApiKey || '').trim();
      if (!apiKey) return { success: false, error: 'OpenSubtitles API key is not configured.' };
      const dlMeta = await fetchJson<{ link?: string; message?: string }>(
        'https://api.opensubtitles.com/api/v1/download',
        {
          method: 'POST',
          headers: {
            'Api-Key': apiKey,
            'Content-Type': 'application/json',
            'User-Agent': getKaikoUserAgent().replace('/', ' v'),
          },
          body: JSON.stringify({ file_id: ref.opensubtitlesFileId }),
        }
      );
      if (!dlMeta?.link) {
        return { success: false, error: dlMeta?.message || 'OpenSubtitles did not return a download link.' };
      }
      const buf = await fetchBuffer(dlMeta.link);
      const unpacked = await unpackArchiveSubtitle(buf, targetEp, preferSigns);
      rawContent = unpacked.content;
      format = unpacked.format;
    } else {
      return { success: false, error: 'Unsupported subtitle provider reference.' };
    }

    if (!rawContent || !rawContent.trim()) {
      return { success: false, error: 'Downloaded subtitle file is empty.' };
    }

    let finalContent = rawContent;
    let keptCuesCount: number | undefined;
    let totalCuesCount: number | undefined;

    if (
      targetMode === 'signs' &&
      params.extractSignsOnly !== false &&
      !result.isSignsOnly &&
      format !== 'ass' &&
      format !== 'ssa'
    ) {
      return {
        success: false,
        error: `Downloaded subtitle is a full .${format} dialogue file without ASS signs/songs layers.`,
      };
    }

    const shouldExtractSigns =
      targetMode === 'signs' &&
      params.extractSignsOnly !== false &&
      !result.isSignsOnly &&
      (format === 'ass' || format === 'ssa');

    if (shouldExtractSigns) {
      const extracted = extractSignsFromAss(rawContent);
      totalCuesCount = extracted.totalCount;
      keptCuesCount = extracted.keptCount;
      if (extracted.keptCount === 0) {
        return {
          success: false,
          error: 'No Signs, Songs, or typesetting layers were detected inside this ASS track (dialogue only).',
          keptCuesCount: 0,
          totalCuesCount: extracted.totalCount,
        };
      }
      finalContent = extracted.assContent;
    }

    const targetPath = buildTargetSubtitlePath(filePath, targetMode, format);
    fs.writeFileSync(targetPath, finalContent, 'utf-8');

    // Download referenced TsukiHime fonts in the background/before probing so JASSUB renders accurately
    if (
      ref.provider === 'tsukihime' &&
      (format === 'ass' || format === 'ssa') &&
      Array.isArray(ref.tsukihimeFontAttachments) &&
      ref.tsukihimeFontAttachments.length > 0
    ) {
      await cacheMissingTsukiHimeFonts(
        filePath,
        finalContent,
        ref.tsukihimeFontAttachments,
        Boolean(ref.tsukihimeIsTosho)
      ).catch(() => {});
    }

    return await finalizeSavedSubtitle(filePath, targetPath, settings.ffmpegPath, keptCuesCount, totalCuesCount);
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Failed to download subtitle.',
    };
  }
}

/**
 * Extracts an embedded `.ass`/`.ssa` track already present in the video container,
 * strips spoken dialogue using `extractSignsFromAss`, writes `<base>.en.signs.ass`,
 * and returns refreshed VideoMetadata so the player activates it immediately.
 */
export async function extractSignsFromEmbeddedAssTrack(params: {
  filePath: string;
  trackIndex: number;
}): Promise<SubtitleActionResult> {
  const settings = storage.getSettings();
  const { filePath, trackIndex } = params;

  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, error: 'Video file was not found on disk.' };
  }
  if (!isAllowedLibraryVideoPath(filePath, getAllowedRoots(settings))) {
    return { success: false, error: 'Target video path is outside configured library folders.' };
  }
  if (!settings.ffmpegPath || !fs.existsSync(settings.ffmpegPath)) {
    return { success: false, error: 'FFmpeg is not configured.' };
  }

  try {
    const assContent = await extractEmbeddedAss(filePath, trackIndex, settings.ffmpegPath);
    if (!assContent || !assContent.trim()) {
      return { success: false, error: 'Could not extract the embedded ASS track.' };
    }

    const extracted = extractSignsFromAss(assContent);
    if (extracted.keptCount === 0) {
      return {
        success: false,
        error: 'No Signs, Songs, or typesetting layers were detected inside this track (dialogue only).',
        keptCuesCount: 0,
        totalCuesCount: extracted.totalCount,
      };
    }

    const targetPath = buildTargetSubtitlePath(filePath, 'signs', 'ass');
    fs.writeFileSync(targetPath, extracted.assContent, 'utf-8');

    return await finalizeSavedSubtitle(filePath, targetPath, settings.ffmpegPath, extracted.keptCount, extracted.totalCount);
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Failed to extract signs from embedded ASS track.',
    };
  }
}
