/**
 * Fetches full remote episode lists (titles, thumbnails, air dates, runtimes)
 * from the ani.zip mappings API (AniDB/TVDB episode data cross-mapped to
 * AniList IDs).
 *
 * Observed live response shape (verified 2026-11 against api.ani.zip for
 * anilist_id=154587 and 21) — the payload is FLAT, not wrapped in `data`:
 *   {
 *     titles: { en, ja, x-jat, ... },
 *     episodes: { "1": { number|episodeNumber, episode: "1", title: { en, x-jat, ja, ... } | string,
 *                        airdate, airDate, airDateUtc, runtime, length, image, ... }, ... },
 *     episodeCount, specialCount, images: [...], mappings: { mal_id, anidb_id, ... }
 *   }
 * Episode `title` may be a locale map (current TVDB-backed data) or a plain
 * string (older entries), so both shapes are normalized. Results are cached in
 * memory and on disk for 7 days (anizip_<id>.json in the metadata cache dir),
 * with stale-cache fallback and in-flight dedup; this module never throws.
 */
import fs from 'fs';
import path from 'path';
import { storage } from './storage.ts';
import { runAniListQuery } from './anilist';
import { getFribbIndex, lookupFribbIds } from './fribb.ts';

export interface RemoteEpisodeInfo {
  number: number;
  title: string | null;
  thumbnailUrl: string | null;
  airDate: string | null;
  runtime: number | null;
}

/** Episode list plus the airing context the detail page renders it against. */
export interface RemoteEpisodesResult {
  episodes: RemoteEpisodeInfo[];
  /** Episodes that have actually aired: 0 before the premiere, nextAiring-1
   *  while airing, null when finished or unknown. */
  airedThrough: number | null;
  /** Next scheduled airing (ms epoch) or null. */
  nextAiringAt: number | null;
  /** Series artwork from ani.zip/TVDB — AniList has no bannerImage for many
   *  airing seasons; this powers the hero backdrop fallback. */
  bannerUrl: string | null;
  posterUrl: string | null;
}

const ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
const REQUEST_TIMEOUT_MS = 8000;
// ani.zip answers slowly under flap (observed live 8 s aborts mid-listing) —
// give its requests their own, more patient budget.
const ANIZIP_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Ongoing series gain episodes weekly; a cached episode list must not outlive
// the next airing event (plus grace) or new episodes stay hidden until TTL.
const AIRING_GRACE_MS = 10 * 60 * 1000;
// Incomplete snapshots (missing titles/previews, junk shorts, empty mappings)
// are served only briefly — ani.zip data propagates gradually and a later
// response is often richer, so a partial cache must not outlive this window.
const INCOMPLETE_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
// If an incomplete cache has already had time to settle, revalidate it once
// in the background. Some mappings (including DanMachi cour listings) gain
// titles/stills after the initial AniZip snapshot, and serving that partial
// snapshot forever made the episode grid look permanently empty.
const INCOMPLETE_REVALIDATE_AFTER_MS = 2 * 60 * 1000;

// Streaming-platform listings (AniList streamingEpisodes mirrors Crunchyroll)
// interleave official shorts/specials — e.g. AoT's "Chimi Chara Theater" rows —
// into the main episode numbering. ani.zip/AniDB is curated and never does
// this, so these patterns only gate rows SOURCED from platform listings.
const JUNK_TITLE_RE = /chimi\s*chara|chibi\s*(?:chara|theater)|picture\s*drama/i;

interface MemoryEpisodes {
  episodes: RemoteEpisodeInfo[];
  fetchedAt: number;
  /** Next scheduled airing (ms epoch) for ongoing titles; null otherwise. */
  nextAiringAt: number | null;
}

const memoryCache = new Map<number, MemoryEpisodes>();
const kitsuIdMemoryCache = new Map<number, string | null>();
const aniZipEpisodeCountCache = new Map<number, number | null>();
const inFlightRequests = new Map<number, Promise<RemoteEpisodeInfo[]>>();

/**
 * Whether a cached episode list is still fresh. Static lists live the full
 * TTL; lists for ongoing titles expire once their next scheduled episode has
 * aired so the following refresh picks it up.
 */
function cacheEntryFresh(entry: { fetchedAt: number; nextAiringAt: number | null }, now = Date.now()): boolean {
  if (now - entry.fetchedAt >= CACHE_TTL_MS) return false;
  if (entry.nextAiringAt != null && now >= entry.nextAiringAt + AIRING_GRACE_MS) return false;
  return true;
}

function englishTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  if (!title || /[\u3040-\u30ff\u3400-\u9fff]/u.test(title)) return null;
  return title;
}

/**
 * Picks a display title out of an ani.zip episode entry, which may expose the
 * title as a plain string or as a locale map ({ en, x-jat, ja, ... }).
 */
function pickEpisodeTitle(ep: any): string | null {
  const t = ep?.title;
  if (typeof t === 'string') {
    const title = englishTitle(t);
    if (title) return title;
  }
  if (t && typeof t === 'object') {
    for (const [locale, value] of Object.entries(t)) {
      const normalizedLocale = locale.toLowerCase().replace(/_/g, '-');
      if (normalizedLocale === 'en' || normalizedLocale.startsWith('en-')) {
        const title = englishTitle(value);
        if (title) return title;
      }
    }
  }
  return englishTitle(ep?.titleEn ?? ep?.title_en);
}

/**
 * Normalizes a raw ani.zip mappings payload into a RemoteEpisodeInfo[] sorted
 * by episode number. Accepts both the flat live payload and the documented
 * `{ data: { episodes } }` wrapper, plus array-shaped episode lists.
 */
export function normalizeAniZipEpisodes(payload: any): RemoteEpisodeInfo[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = payload.data && typeof payload.data === 'object' && payload.data.episodes ? payload.data : payload;
  const rawEpisodes = data.episodes;
  if (!rawEpisodes || typeof rawEpisodes !== 'object') return [];

  const source: [string, any][] = Array.isArray(rawEpisodes)
    ? rawEpisodes.map((ep, i) => [String(i + 1), ep])
    : Object.entries(rawEpisodes);

  const byNumber = new Map<number, RemoteEpisodeInfo>();
  for (const [key, ep] of source) {
    if (!ep || typeof ep !== 'object') continue;
    const number = Number(ep.episodeNumber ?? ep.number ?? ep.episode ?? key);
    if (!Number.isInteger(number) || number <= 0) continue;

    const runtimeRaw = ep.runtime ?? ep.length;
    const runtime = Number(runtimeRaw);

    byNumber.set(number, {
      number,
      title: pickEpisodeTitle(ep),
      thumbnailUrl: typeof ep.image === 'string' && ep.image ? ep.image : null,
      // Prefer the precise UTC timestamp: a date-only airDate parses as UTC
      // midnight and skews relative "aired X ago" labels by up to a day.
      airDate: ep.airDateUtc ?? ep.airDate ?? ep.airdate ?? null,
      runtime: Number.isFinite(runtime) && runtime > 0 ? runtime : null,
    });
  }

  return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
}

/**
 * Reads the disk cache for an anilist ID. Returns { episodes, fetchedAt } or
 * null; never throws.
 */
function readDiskCache(anilistId: number): { episodes: RemoteEpisodeInfo[]; fetchedAt: number; kitsuId?: string | null; episodeCount?: number | null; nextAiringAt: number | null } | null {
  try {
    const cacheFile = path.join(storage.getMetadataCacheDir(), `anizip_${anilistId}.json`);
    if (!fs.existsSync(cacheFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (!parsed || !Array.isArray(parsed.episodes) || typeof parsed.fetchedAt !== 'number') return null;
    const episodes = parsed.episodes.map((episode: RemoteEpisodeInfo) => ({
      ...episode,
      title: englishTitle(episode.title),
    }));
    const kitsuId = typeof parsed.kitsuId === 'string' || typeof parsed.kitsuId === 'number'
      ? String(parsed.kitsuId)
      : null;
    const episodeCount = Number.isInteger(parsed.episodeCount) && parsed.episodeCount > 0 ? parsed.episodeCount : null;
    const nextAiringAt = typeof parsed.nextAiringAt === 'number' && parsed.nextAiringAt > 0 ? parsed.nextAiringAt : null;
    if (episodeCount) aniZipEpisodeCountCache.set(anilistId, episodeCount);
    return { episodes, fetchedAt: parsed.fetchedAt, kitsuId, episodeCount, nextAiringAt };
  } catch {
    return null;
  }
}

/** Series artwork from the ani.zip payload's TVDB `images` array. */
interface AniZipArtwork {
  bannerUrl: string | null;
  posterUrl: string | null;
}

const artworkMemoryCache = new Map<number, AniZipArtwork>();

function normalizeArtwork(images: any): AniZipArtwork {
  const list = Array.isArray(images) ? images : [];
  const pick = (coverTypes: string[]): string | null => {
    for (const coverType of coverTypes) {
      const hit = list.find((image: any) => image?.coverType === coverType && typeof image?.url === 'string' && image.url);
      if (hit) return hit.url as string;
    }
    return null;
  };
  return { bannerUrl: pick(['Banner', 'Fanart']), posterUrl: pick(['Poster']) };
}

/** Artwork is monotonic: an empty or wrong-show payload must not erase a
 *  banner that an earlier snapshot already delivered. */
function mergeArtwork(next: AniZipArtwork, prev: AniZipArtwork | undefined | null): AniZipArtwork {
  return {
    bannerUrl: next.bannerUrl ?? prev?.bannerUrl ?? null,
    posterUrl: next.posterUrl ?? prev?.posterUrl ?? null,
  };
}

function snapshotComplete(episodes: RemoteEpisodeInfo[]): boolean {
  return episodes.length > 0
    && episodes.every((episode) => !!episode.title && !!episode.thumbnailUrl)
    && !episodes.some((episode) => JUNK_TITLE_RE.test(episode.title || ''));
}

function snapshotServeable(episodes: RemoteEpisodeInfo[], fetchedAt: number, now = Date.now()): boolean {
  return snapshotComplete(episodes) || now - fetchedAt < INCOMPLETE_SNAPSHOT_TTL_MS;
}

/** Marks how the last fetchAniZipMappings call for an id obtained its rows. */
const serveSourceById = new Map<number, 'network' | 'cache'>();

/** Kitsu fallback results — 20-per-page pagination means a long season costs
 *  up to 20 sequential requests; they must never repeat per view open. */
const kitsuEpisodesMemoryCache = new Map<string, { episodes: RemoteEpisodeInfo[]; fetchedAt: number }>();

function readKitsuEpisodesCache(kitsuId: string): { episodes: RemoteEpisodeInfo[]; fetchedAt: number } | null {
  try {
    const file = path.join(storage.getMetadataCacheDir(), `kitsu_eps_${kitsuId}.json`);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || !Array.isArray(parsed.episodes) || typeof parsed.fetchedAt !== 'number') return null;
    return { episodes: parsed.episodes, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

function writeKitsuEpisodesCache(kitsuId: string, episodes: RemoteEpisodeInfo[]): void {
  try {
    fs.writeFileSync(
      path.join(storage.getMetadataCacheDir(), `kitsu_eps_${kitsuId}.json`),
      JSON.stringify({ kitsuId, fetchedAt: Date.now(), episodes }, null, 2),
      'utf-8',
    );
  } catch {}
}

function kitsuCacheFresh(fetchedAt: number, episodes: RemoteEpisodeInfo[], now = Date.now()): boolean {
  return snapshotComplete(episodes)
    ? now - fetchedAt < CACHE_TTL_MS
    : now - fetchedAt < INCOMPLETE_SNAPSHOT_TTL_MS;
}

/**
 * Persists the AniList airing context (schedule spine, airing pointer, season
 * start) per id. Stable data — read back whenever the live context query
 * fails, so a rate-limited request cannot blank the schedule.
 */
interface AiringContextSnapshot {
  airedThrough: number | null;
  nextAiringAt: number | null;
  seasonStartAt: number | null;
  schedule: { episode: number; airingAt: number }[];
  bannerUrl: string | null;
  posterUrl: string | null;
  /** Series titles + season for the Kitsu identity check — stable data, so a
   *  served-from-cache context can still validate a Kitsu mapping. */
  identityTitles: string[];
  identitySeason: number | null;
}

function readAiringContext(anilistId: number): (AiringContextSnapshot & { fetchedAt: number }) | null {
  try {
    const file = path.join(storage.getMetadataCacheDir(), `anicontext_${anilistId}.json`);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.fetchedAt !== 'number') return null;
    const schedule = Array.isArray(parsed.schedule)
      ? parsed.schedule
        .filter((node: any) => Number.isInteger(node?.episode) && node.episode > 0 && Number.isFinite(node?.airingAt) && node.airingAt > 0)
        .map((node: any) => ({ episode: Number(node.episode), airingAt: Number(node.airingAt) }))
      : [];
    return {
      airedThrough: typeof parsed.airedThrough === 'number' ? parsed.airedThrough : null,
      nextAiringAt: typeof parsed.nextAiringAt === 'number' && parsed.nextAiringAt > 0 ? parsed.nextAiringAt : null,
      seasonStartAt: typeof parsed.seasonStartAt === 'number' && parsed.seasonStartAt > 0 ? parsed.seasonStartAt : null,
      bannerUrl: typeof parsed.bannerUrl === 'string' && parsed.bannerUrl ? parsed.bannerUrl : null,
      posterUrl: typeof parsed.posterUrl === 'string' && parsed.posterUrl ? parsed.posterUrl : null,
      identityTitles: Array.isArray(parsed.identityTitles) ? parsed.identityTitles.filter((t: unknown): t is string => typeof t === 'string' && !!t) : [],
      identitySeason: Number.isInteger(parsed.identitySeason) ? Number(parsed.identitySeason) : null,
      schedule,
      fetchedAt: parsed.fetchedAt,
    };
  } catch {
    return null;
  }
}

function writeAiringContext(anilistId: number, snapshot: AiringContextSnapshot): void {
  try {
    fs.writeFileSync(
      path.join(storage.getMetadataCacheDir(), `anicontext_${anilistId}.json`),
      JSON.stringify({ ...snapshot, schedule: snapshot.schedule.slice().sort((a, b) => a.episode - b.episode), fetchedAt: Date.now() }, null, 2),
      'utf-8',
    );
  } catch {}
}

/**
 * Fetches the full remote episode list for an AniList ID from ani.zip.
 * Cached in memory and on disk for 7 days (incomplete snapshots for 6 hours),
 * deduplicates concurrent requests and falls back to a stale disk cache on
 * failure. Never throws; resolves [] when nothing is available.
 */
export async function fetchAniZipMappings(anilistId: number, options: { bypassCache?: boolean } = {}): Promise<RemoteEpisodeInfo[]> {
  const id = Math.trunc(Number(anilistId));
  if (!Number.isFinite(id) || id <= 0) return [];
  const bypassCache = options.bypassCache === true;

  // 1. In-memory cache
  if (!bypassCache) {
    const mem = memoryCache.get(id);
    if (mem && cacheEntryFresh(mem) && snapshotServeable(mem.episodes, mem.fetchedAt)) {
      serveSourceById.set(id, 'cache');
      return mem.episodes;
    }
  }

  // 2. Disk cache (7 days; expires early for ongoing titles — see cacheEntryFresh)
  const disk = readDiskCache(id);
  if (disk?.kitsuId) kitsuIdMemoryCache.set(id, disk.kitsuId);
  if (disk?.episodeCount) aniZipEpisodeCountCache.set(id, disk.episodeCount);
  if (bypassCache && disk) disk.episodes = [];
  if (!bypassCache && disk && cacheEntryFresh(disk) && snapshotServeable(disk.episodes, disk.fetchedAt)) {
    serveSourceById.set(id, 'cache');
    memoryCache.set(id, { episodes: disk.episodes, fetchedAt: disk.fetchedAt, nextAiringAt: disk.nextAiringAt });
    return disk.episodes;
  }

  // 3. In-flight dedup
  const pending = inFlightRequests.get(id);
  if (pending) return pending;

  const request = (async () => {
    try {
      const res = await fetch(`${ANIZIP_ENDPOINT}?anilist_id=${id}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'AnimeMediaCenter/1.0',
        },
        signal: AbortSignal.timeout(ANIZIP_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`ani.zip returned HTTP ${res.status}`);
      }
      const json = await res.json();
      const episodes = normalizeAniZipEpisodes(json);
      const rawEpisodeCount = Number(json?.episodeCount);
      const episodeCount = Number.isInteger(rawEpisodeCount) && rawEpisodeCount > 0 ? rawEpisodeCount : null;
      aniZipEpisodeCountCache.set(id, episodeCount);
      artworkMemoryCache.set(id, mergeArtwork(normalizeArtwork(json?.images), artworkMemoryCache.get(id)));
      const rawKitsuId = json?.mappings?.kitsu_id;
      const kitsuId = typeof rawKitsuId === 'string' || typeof rawKitsuId === 'number'
        ? String(rawKitsuId).trim()
        : '';
      if (kitsuId && /^\d+$/.test(kitsuId)) kitsuIdMemoryCache.set(id, kitsuId);
      else kitsuIdMemoryCache.set(id, null);

      // Persist to disk cache
      try {
        fs.writeFileSync(
          path.join(storage.getMetadataCacheDir(), `anizip_${id}.json`),
          JSON.stringify({ anilistId: id, fetchedAt: Date.now(), kitsuId: kitsuId || null, episodeCount, nextAiringAt: disk?.nextAiringAt ?? null, episodes }, null, 2),
          'utf-8'
        );
      } catch {}

      memoryCache.set(id, { episodes, fetchedAt: Date.now(), nextAiringAt: disk?.nextAiringAt ?? null });
      serveSourceById.set(id, 'network');
      console.info(`[Episodes] AniZip ${id}: ${episodes.length} episode records; Kitsu mapping ${kitsuId || 'none'}`);
      return episodes;
    } catch (err: any) {
      // Stale disk cache is better than nothing
      if (disk && disk.episodes.length > 0) {
        serveSourceById.set(id, 'cache');
        console.error(`ani.zip fetch failed for anilist ${id}, using stale cache:`, err?.message || err);
        return disk.episodes;
      }
      console.error(`ani.zip fetch failed for anilist ${id}:`, err?.message || err);
      return [];
    } finally {
      inFlightRequests.delete(id);
    }
  })();

  inFlightRequests.set(id, request);
  return request;
}

function normalizedSeriesTitle(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKD').toLowerCase().replace(/\bseason\s*\d+\b|\b\d+(?:st|nd|rd|th)\s+season\b|\bs\d+\b/gi, '').replace(/[^a-z0-9]/g, '')
    : '';
}

function explicitSeason(value: string): number | null {
  const match = value.match(/\bseason\s*0*(\d+)\b|\b0*(\d+)(?:st|nd|rd|th)\s+season\b|\bs0*(\d+)\b/i);
  const result = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  return Number.isInteger(result) && result > 0 ? result : null;
}

async function fetchKitsuEpisodes(
  kitsuId: string,
  identity: { titles: string[]; episodeCount: number | null; season: number | null },
  maxPages: number = 20,
): Promise<RemoteEpisodeInfo[]> {
  // ani.zip's Kitsu crosswalk is not guaranteed to identify the same season.
  // Verify its title/count first so a short/spinoff series cannot be joined by
  // coincidentally matching episode numbers.
  const identityResponse = await fetch(`https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}`, {
    headers: { Accept: 'application/vnd.api+json', 'User-Agent': 'AnimeMediaCenter/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!identityResponse.ok) throw new Error(`Kitsu anime identity returned HTTP ${identityResponse.status}`);
  const identityPayload = await identityResponse.json();
  const attrs = identityPayload?.data?.attributes;
  const kitsuTitles = [attrs?.canonicalTitle, attrs?.titles?.en, attrs?.titles?.en_jp, attrs?.titles?.ja_jp, ...(attrs?.abbreviatedTitles || [])]
    .map(normalizedSeriesTitle).filter(Boolean);
  const matchingTitle = kitsuTitles.some((title) => identity.titles.some((candidate) => {
    const normalized = normalizedSeriesTitle(candidate);
    return normalized && (title === normalized || (title.length >= 10 && normalized.length >= 10 && (title.includes(normalized) || normalized.includes(title))));
  }));
  const kitsuCount = Number(attrs?.episodeCount);
  const kitsuSeason = explicitSeason([attrs?.canonicalTitle, attrs?.titles?.en, attrs?.titles?.en_jp].filter(Boolean).join(' '));
  if (!matchingTitle || (identity.episodeCount && Number.isInteger(kitsuCount) && kitsuCount !== identity.episodeCount) ||
      (identity.season != null && identity.season !== kitsuSeason)) {
    console.info(`[Episodes] Rejecting Kitsu mapping ${kitsuId}: series/season metadata does not match the AniList title.`);
    return [];
  }

  // Kitsu caps page[limit] at 20 (verified 2026-11: larger values return
  // HTTP 400 "Limit exceeds maximum page size of 20", killing the fallback).
  const limit = 20;
  const byNumber = new Map<number, RemoteEpisodeInfo>();
  let offset = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const url = `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/episodes?page[limit]=${limit}&page[offset]=${offset}&sort=number`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.api+json',
        'User-Agent': 'AnimeMediaCenter/1.0',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Kitsu episodes returned HTTP ${response.status}`);
    const payload = await response.json();
    const entries = Array.isArray(payload?.data) ? payload.data : [];
    if (entries.length === 0) break;

    for (const entry of entries) {
      const attrs = entry?.attributes;
      if (!attrs || typeof attrs !== 'object') continue;
      const number = Number(attrs.number);
      if (!Number.isInteger(number) || number <= 0) continue;
      const title = englishTitle(attrs.titles?.en ?? attrs.titles?.en_us ?? attrs.canonicalTitle);
      const thumbnail = attrs.thumbnail?.large ?? attrs.thumbnail?.original ?? attrs.thumbnail?.medium;
      const thumbnailUrl = typeof thumbnail === 'string' && thumbnail ? thumbnail : null;
      const rawAirDate = attrs.airdate ?? attrs.airDate ?? null;
      const airDate = typeof rawAirDate === 'string' ? rawAirDate : null;
      const airTime = airDate ? Date.parse(airDate) : Number.NaN;
      const aired = Number.isFinite(airTime) && airTime <= Date.now();
      // Kitsu pre-creates blank rows for the planned episode count. Keep only
      // aired rows (or entries that already have real metadata), not blanks.
      if (!aired && !title && !thumbnailUrl) continue;
      const runtime = Number(attrs.length);
      byNumber.set(number, {
        number,
        title,
        thumbnailUrl,
        airDate,
        runtime: Number.isFinite(runtime) && runtime > 0 ? runtime : null,
      });
    }

    if (entries.length < limit || !payload?.links?.next) break;
    offset += entries.length;
  }

  const episodes = Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
  console.info(`[Episodes] Kitsu ${kitsuId}: ${episodes.length} usable episodes (${episodes.filter((episode) => !!episode.title).length} English titles, ${episodes.filter((episode) => !!episode.thumbnailUrl).length} previews)`);
  return episodes;
}

/**
 * ani.zip is the primary episode source, but its title coverage varies by
 * title. Use AniList's official streaming episode list to fill missing English
 * names without replacing richer ani.zip stills, dates, or runtimes.
 * Returns the curated episode list (aired rows + future schedule rows) along
 * with the airing pointer so the UI can cap the grid independently of the
 * separate details request.
 */
// Cold/slow upstream (ani.zip flap, timeouts, retries) must never block the
// detail page: the pipeline is raced against this deadline, a placeholder
// payload is served immediately, and the renderer is pushed an update event
// when the full data lands.
const EPISODES_FAST_DEADLINE_MS = 4000;
// Hedged fast-source timer: when ani.zip has not answered by then, Kitsu page
// 1 (limit 20, offset 0 — one light request via the local ID index) fills the
// first visible page while ani.zip keeps running.
const EPISODES_HEDGE_MS = 900;
const inFlightEpisodesPipeline = new Map<number, Promise<RemoteEpisodesResult>>();
let remoteEpisodesUpdateListener: ((anilistId: number, result: RemoteEpisodesResult) => void) | null = null;

export function setRemoteEpisodesUpdateListener(listener: (anilistId: number, result: RemoteEpisodesResult) => void): void {
  remoteEpisodesUpdateListener = listener;
}

/** Resolves fast with the current-best payload; the full pipeline keeps
 *  running in the background and pushes an update event when it lands. */
async function raceEpisodesPipeline(id: number, pipeline: Promise<RemoteEpisodesResult>): Promise<RemoteEpisodesResult> {
  const raced = await Promise.race([
    pipeline.then(() => 'done' as const),
    new Promise<'deadline'>((resolve) => setTimeout(() => resolve('deadline'), EPISODES_FAST_DEADLINE_MS)),
  ]);
  if (raced === 'done') {
    inFlightEpisodesPipeline.delete(id);
    return pipeline;
  }
  void pipeline
    .then((fresh) => {
      remoteEpisodesUpdateListener?.(id, fresh);
      return fresh;
    })
    .catch(() => {})
    .finally(() => {
      inFlightEpisodesPipeline.delete(id);
    });
  return { episodes: [], airedThrough: null, nextAiringAt: null, bannerUrl: null, posterUrl: null };
}

export async function fetchRemoteEpisodes(anilistId: number): Promise<RemoteEpisodesResult> {
  const id = Math.trunc(Number(anilistId));
  if (!Number.isFinite(id) || id <= 0) {
    return { episodes: [], airedThrough: null, nextAiringAt: null, bannerUrl: null, posterUrl: null };
  }
  const existing = inFlightEpisodesPipeline.get(id);
  if (existing) return raceEpisodesPipeline(id, existing);
  const pipeline = runRemoteEpisodesPipeline(id, (payload) => remoteEpisodesUpdateListener?.(id, payload));
  inFlightEpisodesPipeline.set(id, pipeline);
  return raceEpisodesPipeline(id, pipeline);
}

/** True when a fresh ani.zip snapshot (memory or disk) already covers the id —
 *  hover-prefetches skip these ids since they would trigger no network work. */
export function isAniZipCacheFresh(anilistId: number): boolean {
  const id = Math.trunc(Number(anilistId));
  if (!Number.isFinite(id) || id <= 0) return false;
  const mem = memoryCache.get(id);
  if (mem && cacheEntryFresh(mem)) return true;
  const disk = readDiskCache(id);
  return !!disk && cacheEntryFresh(disk) && snapshotServeable(disk.episodes, disk.fetchedAt);
}

async function runRemoteEpisodesPipeline(anilistId: number, notify: (payload: RemoteEpisodesResult) => void): Promise<RemoteEpisodesResult> {
  const id = Math.trunc(Number(anilistId));
  const aniZipCacheAtStart = memoryCache.get(id) ?? readDiskCache(id);
  void getFribbIndex(); // self-heal the local ID index when the startup warm missed

  // Stage 1 — start the ani.zip fetch immediately and race it against the
  // hedge timer. The FIRST usable snapshot is pushed to the UI even when it
  // is partial, and the slow tail (flap retries, remaining Kitsu pages) keeps
  // pushing improvements in the background — on a cold cache the first 16
  // visible cards come alive in ~1 second instead of after the whole
  // pipeline settles.
  const aniZipPromise = fetchAniZipMappings(id).catch(() => [] as RemoteEpisodeInfo[]);
  const zipRace = Promise.race([
    aniZipPromise.then((rows) => ({ kind: 'zip' as const, rows })),
    new Promise<{ kind: 'hedge' }>((resolve) => setTimeout(() => resolve({ kind: 'hedge' }), EPISODES_HEDGE_MS)),
  ]);

  let aniListCount: number | null = null;
  // How many episodes have actually aired: NOT_YET_RELEASED => 0, RELEASING
  // => nextAiringEpisode.episode - 1, finished/cancelled => null (no cap).
  let airedThrough: number | null = null;
  // Next scheduled airing (ms epoch); drives the airing-aware cache TTL.
  // The AniList context (schedule spine, airing pointer, season start) is
  // stable data, so it is persisted per id: a failed/rate-limited context
  // query must not strip the schedule from the payload (one 429 otherwise
  // blanks the grid — observed live during startup request storms).
  const cachedContext = readAiringContext(id);
  let nextAiringAt = cachedContext?.nextAiringAt ?? readDiskCache(id)?.nextAiringAt ?? null;
  // First-episode air date (ms epoch). ani.zip crosswalks occasionally point at
  // the WRONG season of a franchise (observed live: AniList 195516, Kusuriya
  // S3, served the previous season's TVDB entry — different titles and air
  // dates a year off). Rows airing far before the season start are junk.
  let seasonStartAt: number | null = cachedContext?.seasonStartAt ?? null;
  const streamEpisodes = new Map<number, { title: string | null; thumbnailUrl: string | null }>();
  // AniList's per-episode airing times (episode -> ms epoch, aired + future
  // slots). The schedule spine of the merge below — ani.zip only enriches it
  // (same approach as Hayase's makeEpisodeList).
  const scheduleByNumber = new Map<number, number>();
  for (const node of cachedContext?.schedule || []) {
    scheduleByNumber.set(node.episode, node.airingAt);
  }
  let identity: { titles: string[]; episodeCount: number | null; season: number | null } = { titles: [], episodeCount: null, season: null };
  // Skip the live context query while the persisted one still stands: the
  // schedule and airing pointer are stable until the next airing event, and a
  // context query on every view open trips AniList's rate limit when browsing
  // (429 storms made every page crawl). Finished titles hold for the full TTL;
  // airing ones refresh exactly at the next airing slot (+ grace).
  const nowMs = Date.now();
  const contextStands = !!cachedContext && (
    cachedContext.nextAiringAt != null
      ? nowMs < cachedContext.nextAiringAt + AIRING_GRACE_MS
      : nowMs - cachedContext.fetchedAt < CACHE_TTL_MS
  );
  if (contextStands && cachedContext!.airedThrough != null) {
    airedThrough = cachedContext!.airedThrough;
  }
  const queryContext = () => runAniListQuery<{
    Media?: {
      episodes?: number | null;
      status?: string | null;
      startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
      nextAiringEpisode?: { episode?: number | null; airingAt?: number | null } | null;
      airingSchedule?: { nodes?: { episode?: number | null; airingAt?: number | null }[] | null } | null;
      title?: { english?: string | null; romaji?: string | null; native?: string | null } | null;
      synonyms?: string[] | null;
      streamingEpisodes?: { title?: string | null; thumbnail?: string | null }[] | null;
    } | null;
  }>(`query ($id: Int) { Media(id: $id, type: ANIME) { episodes status startDate { year month day } nextAiringEpisode { episode airingAt } airingSchedule(page: 1, perPage: 50) { nodes { episode airingAt } } title { english romaji native } synonyms streamingEpisodes { title thumbnail } } }`, { id });
  let contextFailed = false;
  if (!contextStands) {
    try {
      let data: Awaited<ReturnType<typeof queryContext>>;
      try {
        data = await queryContext();
      } catch {
        // AniList rate limits are transient — one short retry before falling
        // back to the persisted context below.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        data = await queryContext();
      }
    const media = data.Media;
    aniListCount = typeof media?.episodes === 'number' && Number.isInteger(media.episodes) && media.episodes > 0 ? media.episodes : null;
    if (media?.startDate?.year && media.startDate.month && media.startDate.day) {
      seasonStartAt = Date.UTC(media.startDate.year, media.startDate.month - 1, media.startDate.day);
    }
    if (media?.status === 'NOT_YET_RELEASED') {
      airedThrough = 0;
      nextAiringAt = null;
    } else if (media?.status === 'RELEASING') {
      const next = Number(media?.nextAiringEpisode?.episode);
      const airingAt = Number(media?.nextAiringEpisode?.airingAt);
      airedThrough = Number.isInteger(next) && next >= 1 ? next - 1 : null;
      nextAiringAt = Number.isFinite(airingAt) && airingAt > 0 ? airingAt * 1000 : null;
    } else {
      nextAiringAt = null;
    }
    const identityTitles = [media?.title?.english, media?.title?.romaji, media?.title?.native, ...(media?.synonyms || [])].filter((value): value is string => !!value)
    identity = {
      titles: identityTitles,
      episodeCount: aniListCount,
      season: identityTitles.map(explicitSeason).find((season) => season != null) ?? null,
    };
    for (const item of media?.streamingEpisodes || []) {
      // AniList often provides only "Episode 15" with a perfectly usable
      // thumbnail. Keep that image even without an episode-specific title.
      const match = item.title?.match(/^\s*(?:Episode|Ep\.?|E)\s*0*(\d+)(?:\s*[-–—:.]\s*(.+?))?\s*$/i);
      const title = match ? englishTitle(match[2]) : null;
      const number = Number(match?.[1]);
      const thumbnailUrl = typeof item.thumbnail === 'string' && item.thumbnail ? item.thumbnail : null;
      if (Number.isInteger(number) && number > 0 && (title || thumbnailUrl)) {
        streamEpisodes.set(number, { title, thumbnailUrl });
      }
    }
    for (const node of media?.airingSchedule?.nodes || []) {
      const number = Number(node?.episode);
      const airingAt = Number(node?.airingAt);
      if (!Number.isInteger(number) || number <= 0 || !Number.isFinite(airingAt) || airingAt <= 0) continue;
      if (!scheduleByNumber.has(number)) scheduleByNumber.set(number, airingAt * 1000);
    }
  } catch (err: any) {
    contextFailed = true;
    console.warn(`AniList episode context failed for ${id}:`, err?.message || err);
    }
  }
  if (contextStands || contextFailed) {
    // Serve the persisted context rather than nothing: the schedule spine and
    // the airing cap survive AniList hiccups until the next successful query.
    for (const node of cachedContext?.schedule || []) {
      if (!scheduleByNumber.has(node.episode)) scheduleByNumber.set(node.episode, node.airingAt);
    }
    if (airedThrough == null && cachedContext?.airedThrough != null) airedThrough = cachedContext.airedThrough;
    if (nextAiringAt == null && cachedContext?.nextAiringAt != null) nextAiringAt = cachedContext.nextAiringAt;
    if (seasonStartAt == null && cachedContext?.seasonStartAt != null) seasonStartAt = cachedContext.seasonStartAt;
    // Titles/season let the Kitsu identity check work on served-from-cache
    // runs (hedge page 1 and the fallback) without a live context query.
    if (identity.titles.length === 0 && cachedContext && cachedContext.identityTitles.length > 0) {
      identity = { titles: cachedContext.identityTitles, episodeCount: null, season: cachedContext.identitySeason };
    }
  }

  const maxEpisode = aniListCount ?? aniZipEpisodeCountCache.get(id) ?? null;
  const withinTitle = (episode: RemoteEpisodeInfo) => maxEpisode == null || episode.number <= maxEpisode;
  const now = Date.now();
  // AniList's airing pointer occasionally lags ani.zip/AniDB by a few hours,
  // so a known past air date overrides the numeric cap.
  const hasAired = (episode: RemoteEpisodeInfo) => {
    if (airedThrough == null || episode.number <= airedThrough) return true;
    if (!episode.airDate) return false;
    const airTime = Date.parse(episode.airDate);
    return Number.isFinite(airTime) && airTime <= now;
  };
  // ani.zip flaps between AniDB episode data and streaming-platform listings
  // that interleave shorts ("Chimi Chara Theater"…) into the main numbering.
  // Drop junk-titled ani.zip rows so those numbers are refilled from the
  // clean Kitsu/AniList streaming sources in the merge below.
  const isJunkTitle = (episode: RemoteEpisodeInfo) => JUNK_TITLE_RE.test(episode.title || '');
  // A crosswalk to the wrong season of a franchise ships confidently complete
  // rows whose air dates predate this season's start by months. A generous
  // 45-day window tolerates pre-air screenings and recap episodes.
  const WRONG_ENTRY_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
  const isWrongEntry = (episode: RemoteEpisodeInfo) => {
    if (seasonStartAt == null || !episode.airDate) return false;
    const airTime = Date.parse(episode.airDate);
    return Number.isFinite(airTime) && airTime < seasonStartAt - WRONG_ENTRY_WINDOW_MS;
  };
  const partitionAniZip = (rows: RemoteEpisodeInfo[]) => {
    const scoped = rows.filter((episode) => withinTitle(episode) && !isJunkTitle(episode) && !isWrongEntry(episode));
    return {
      scoped,
      droppedJunk: rows.length - scoped.length,
      droppedWrong: rows.filter((episode) => withinTitle(episode) && isWrongEntry(episode)).length,
    };
  };
  // Mutable merge state shared by the progressive pushes.
  let rawRows: RemoteEpisodeInfo[] = [];
  let scopedAniZip: RemoteEpisodeInfo[] = [];
  let droppedJunk = 0;
  let droppedWrong = 0;
  let alternateEpisodes: RemoteEpisodeInfo[] = [];
  let lastPushedJson = '';
  const snapshotScore = (rows: RemoteEpisodeInfo[]) =>
    rows.reduce((acc, episode) => acc + (episode.title ? 2 : 0) + (episode.thumbnailUrl ? 1 : 0) + (episode.airDate ? 1 : 0), 0);
  // Monotonic state: a later snapshot must never roll back what the UI
  // already shows. ani.zip flaps — a slow first request can land as an empty
  // or shrunken snapshot AFTER a richer one was already pushed (observed:
  // the grid collapsed from "filled" back to placeholders mid-visit). An
  // equal-or-better snapshot wins outright; a degraded one only fills gaps
  // by episode number.
  const acceptPartition = (rows: RemoteEpisodeInfo[]) => {
    const incoming = partitionAniZip(rows);
    const currentScore = snapshotScore(scopedAniZip);
    const incomingScore = snapshotScore(incoming.scoped);
    if (scopedAniZip.length === 0 || incomingScore >= currentScore) {
      rawRows = rows;
      ({ scoped: scopedAniZip, droppedJunk, droppedWrong } = incoming);
    } else {
      const byNumber = new Map(scopedAniZip.map((row) => [row.number, row]));
      for (const row of incoming.scoped) {
        if (!byNumber.has(row.number)) byNumber.set(row.number, row);
      }
      scopedAniZip = [...byNumber.values()].sort((a, b) => a.number - b.number);
      droppedJunk = Math.max(droppedJunk, incoming.droppedJunk);
      droppedWrong = Math.max(droppedWrong, incoming.droppedWrong);
    }
  };

  // Slot-based merge (Hayase-style): every slot 1..count renders; AniList
  // supplies the schedule spine and the planned count, ani.zip/Kitsu/streaming
  // enrich the slots. ani.zip rows resolve onto slots by number — or by
  // closest air date when specials interleave into the numbering or the
  // counts disagree, consuming rows so one entry cannot fill two slots.
  const buildCurrentPayload = (): RemoteEpisodesResult => {
    const aniZipCount = aniZipEpisodeCountCache.get(id) ?? null;
    const hasSpecials = maxEpisode != null && rawRows.some((episode) => episode.number > maxEpisode);
    const countMismatch = aniListCount != null && aniZipCount != null && aniZipCount !== aniListCount;
    const matchByDate = (hasSpecials || countMismatch) && scheduleByNumber.size > 0;
    const DATE_MATCH_TOLERANCE_MS = 3 * 24 * 60 * 60 * 1000;
    const rowPool = [...scopedAniZip];
    const consumed = new Set<RemoteEpisodeInfo>();
    const resolveAniZipRow = (number: number): RemoteEpisodeInfo | null => {
      const slot = scheduleByNumber.get(number);
      if (matchByDate && slot != null) {
        let best: RemoteEpisodeInfo | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const row of rowPool) {
          if (consumed.has(row) || !row.airDate) continue;
          const airTime = Date.parse(row.airDate);
          if (!Number.isFinite(airTime)) continue;
          const dist = Math.abs(airTime - slot);
          if (dist < bestDist || (dist === bestDist && best != null && Math.abs(row.number - number) < Math.abs(best.number - number))) {
            best = row;
            bestDist = dist;
          }
        }
        // A tight cutoff keeps a wrong-show crosswalk (dates months off) from
        // being stretched onto schedule slots.
        if (best != null && bestDist <= DATE_MATCH_TOLERANCE_MS) {
          consumed.add(best);
          return best;
        }
      }
      const byNumber = rowPool.find((row) => row.number === number && !consumed.has(row));
      if (byNumber) consumed.add(byNumber);
      return byNumber ?? null;
    };

    const slotCount = Math.max(
      aniListCount ?? 0,
      aniZipCount ?? 0,
      scopedAniZip.length > 0 ? scopedAniZip[scopedAniZip.length - 1].number : 0,
      scheduleByNumber.size > 0 ? Math.max(...scheduleByNumber.keys()) : 0,
      streamEpisodes.size > 0 ? Math.max(...streamEpisodes.keys()) : 0,
    );
    const mergedByNumber = new Map<number, RemoteEpisodeInfo>();
    for (let number = 1; number <= slotCount; number += 1) {
      if (maxEpisode != null && number > maxEpisode) break;
      const row = resolveAniZipRow(number);
      const alternate = alternateEpisodes.find((episode) => episode.number === number);
      const stream = streamEpisodes.get(number);
      const slotTime = scheduleByNumber.get(number);
      const slotIso = slotTime != null ? new Date(slotTime).toISOString() : null;
      const title = row?.title || alternate?.title || stream?.title || null;
      // Nothing at all for this slot (ani.zip/Kitsu/streaming/schedule).
      if (!row && !alternate && !stream && !slotIso) continue;
      // Platform-only rows (streaming list without an ani.zip/Kitsu row) are
      // usually shorts the platform interleaved into the season listing.
      if (!row && !alternate && stream && JUNK_TITLE_RE.test(title || '')) continue;
      mergedByNumber.set(number, {
        number,
        title,
        thumbnailUrl: row?.thumbnailUrl || alternate?.thumbnailUrl || stream?.thumbnailUrl || null,
        airDate: row?.airDate || alternate?.airDate || slotIso,
        runtime: row?.runtime || alternate?.runtime || null,
      });
    }
    const sorted = Array.from(mergedByNumber.values())
      .filter((episode) => {
        if (hasAired(episode)) return true;
        // Keep the upcoming schedule: future-dated rows power the "airs in …"
        // labels on the detail page. Undated rows beyond the airing pointer
        // stay out (Kitsu pre-creates blanks; AniList's planned count is not a
        // schedule and would fake a full unaired season).
        if (!episode.airDate) return false;
        const airTime = Date.parse(episode.airDate);
        return Number.isFinite(airTime) && airTime > now;
      })
      .sort((a, b) => a.number - b.number);

    // Series artwork travels with the same payload as the rows — a wrong-show
    // crosswalk poisons both, so only trust it when the rows are not poisoned.
    const artworkTrusted = scopedAniZip.length > 0 || droppedWrong === 0;
    const liveArtwork = artworkTrusted ? artworkMemoryCache.get(id) ?? null : null;
    return {
      episodes: sorted,
      airedThrough,
      nextAiringAt,
      bannerUrl: liveArtwork?.bannerUrl ?? cachedContext?.bannerUrl ?? null,
      posterUrl: liveArtwork?.posterUrl ?? cachedContext?.posterUrl ?? null,
    };
  };

  const pushBest = () => {
    const payload = buildCurrentPayload();
    const json = JSON.stringify(payload);
    if (json === lastPushedJson) return;
    lastPushedJson = json;
    notify(payload);
  };

  // Stage 2 — the first ani.zip snapshot (or the hedge when it stalls).
  const zipOrHedge = await zipRace;
  let pendingZip: Promise<RemoteEpisodeInfo[]> | null = null;
  if (zipOrHedge.kind === 'zip') {
    acceptPartition(zipOrHedge.rows);
  } else {
    pendingZip = aniZipPromise;
  }
  pushBest();

  // Stage 3 — hedge: ani.zip is stalling, so fill the first visible page from
  // Kitsu right now (limit 20, offset 0 — one light request via the local ID
  // index) and push the moment it lands. ani.zip keeps running and enriches
  // the rest later.
  if (pendingZip) {
    const hedgeKitsuIdRaw = kitsuIdMemoryCache.get(id) ?? lookupFribbIds(id)?.kitsuId ?? null;
    const hedgeKitsuId = hedgeKitsuIdRaw == null ? null : String(hedgeKitsuIdRaw);
    if (hedgeKitsuId) {
      try {
        alternateEpisodes = (await fetchKitsuEpisodes(hedgeKitsuId, identity, 1)).filter(withinTitle);
        pushBest();
      } catch (err: any) {
        console.warn(`[Episodes] Kitsu hedge page failed for AniList ${id}:`, err?.message || err);
      }
    }
  }

  // Stage 4 — ani.zip whenever it lands on the hedge path: merged
  // monotonically (a degraded flap never rolls the grid back), pushed only
  // when it actually added something.
  if (pendingZip) {
    acceptPartition(await pendingZip);
    pushBest();
  }

  // ani.zip flaps between snapshots (verified live: complete, partial with a
  // freshly-aired episode untitled, a wrong-season crosswalk, empty). A
  // poisoned or partial NETWORK read is retried with the cache bypassed —
  // each attempt is a fresh roll, merged monotonically and pushed only when
  // it filled something. Complete cache-served reads do not retry; aged
  // incomplete caches get one bounded revalidation to heal empty cards.
  const shouldRevalidateIncomplete = serveSourceById.get(id) === 'cache'
    && !!aniZipCacheAtStart
    && Date.now() - aniZipCacheAtStart.fetchedAt >= INCOMPLETE_REVALIDATE_AFTER_MS
    && !snapshotComplete(aniZipCacheAtStart.episodes);
  if (serveSourceById.get(id) === 'network' || shouldRevalidateIncomplete) {
    // Network snapshots can be retried twice to ride out a provider flap;
    // cached partials get one refresh per view-open to avoid request storms.
    const maxAttempts = shouldRevalidateIncomplete ? 1 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const knownAired = airedThrough ?? scopedAniZip.length;
      const incomplete = scopedAniZip.length < knownAired ||
        scopedAniZip.some((episode) => episode.number <= knownAired && (!episode.title || !episode.thumbnailUrl));
      if (!incomplete && droppedWrong === 0) break;
      const beforeLen = scopedAniZip.length;
      const beforeScore = snapshotScore(scopedAniZip);
      const retried = await fetchAniZipMappings(id, { bypassCache: true });
      acceptPartition(retried);
      if (snapshotScore(scopedAniZip) <= beforeScore && scopedAniZip.length === beforeLen) break;
      pushBest();
    }
  }

  // Stage 6 — full Kitsu fallback (memory/disk cached) when the rows are
  // incomplete. Kitsu paginates 20 episodes per request — a 170-episode
  // season costs up to 9 sequential calls, so the result is cached and never
  // refetched per view open.
  const kitsuIdRaw = kitsuIdMemoryCache.get(id) ?? lookupFribbIds(id)?.kitsuId ?? null;
  const kitsuId = kitsuIdRaw == null ? null : String(kitsuIdRaw);
  if (kitsuId && (scopedAniZip.length === 0 || droppedJunk > 0 || droppedWrong > 0 || scopedAniZip.some((episode) => !episode.title || !episode.thumbnailUrl))) {
    const cachedKitsu = kitsuEpisodesMemoryCache.get(kitsuId) ?? readKitsuEpisodesCache(kitsuId);
    if (cachedKitsu && kitsuCacheFresh(cachedKitsu.fetchedAt, cachedKitsu.episodes)) {
      kitsuEpisodesMemoryCache.set(kitsuId, cachedKitsu);
      alternateEpisodes = cachedKitsu.episodes.filter(withinTitle);
      pushBest();
    } else {
      try {
        const full = (await fetchKitsuEpisodes(kitsuId, identity)).filter(withinTitle);
        if (full.length > 0) {
          alternateEpisodes = full;
          const kitsuCacheEntry = { episodes: full, fetchedAt: Date.now() };
          kitsuEpisodesMemoryCache.set(kitsuId, kitsuCacheEntry);
          writeKitsuEpisodesCache(kitsuId, full);
          pushBest();
        }
      } catch (err: any) {
        console.warn(`[Episodes] Kitsu fallback failed for AniList ${id} (Kitsu ${kitsuId}):`, err?.message || err);
      }
    }
  }

  const final = buildCurrentPayload();
  if (final.episodes.length > 0) {
    // Preserve the age of an incomplete cache across opens; otherwise writing
    // the merged fallback rows with a fresh timestamp could postpone its
    // bounded revalidation indefinitely.
    const fetchedAt = serveSourceById.get(id) === 'cache' && !snapshotComplete(final.episodes)
      ? aniZipCacheAtStart?.fetchedAt ?? Date.now()
      : Date.now();
    // Only the FINAL merged snapshot is persisted as the ani.zip rows cache —
    // intermediate progressive payloads (Kitsu page 1 alone etc.) must not
    // pin an incomplete list for its TTL.
    memoryCache.set(id, { episodes: final.episodes, fetchedAt, nextAiringAt });
    try {
      fs.writeFileSync(
        path.join(storage.getMetadataCacheDir(), `anizip_${id}.json`),
        JSON.stringify({ anilistId: id, fetchedAt, kitsuId: kitsuId ?? null, episodeCount: maxEpisode, nextAiringAt, episodes: final.episodes }, null, 2),
        'utf-8',
      );
    } catch {}
  }
  writeAiringContext(id, {
    airedThrough,
    nextAiringAt,
    seasonStartAt,
    bannerUrl: final.bannerUrl,
    posterUrl: final.posterUrl,
    identityTitles: identity.titles,
    identitySeason: identity.season,
    schedule: [...scheduleByNumber].map(([episode, airingAt]) => ({ episode, airingAt })),
  });
  pushBest();
  return final;
}
