/**
 * Catalog & metadata service: trending / seasonal / all-time popular listings,
 * airing schedule, recommendations, search and per-title details.
 *
 * Every service function is backed by the AniList GraphQL client (anilist.ts)
 * through a 3-layer cache mirroring kitsu.ts patterns: in-memory entries with
 * per-function TTL, disk JSON persisted as catalog_<name>.json inside
 * storage.getMetadataCacheDir(), and in-flight request deduplication.
 * All functions degrade gracefully: on network failure they return stale
 * cached data when present, otherwise an empty array / null — they never
 * throw to the caller.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { storage } from './storage.ts';
import {
  queryTrending,
  queryPopularSeason,
  queryAllTimePopular,
  queryAiringSchedule,
  queryRecommendations,
  querySearch,
  queryDetails,
  type AniListMedia,
  type AniListSeason,
} from './anilist.ts';

// --- Public types -----------------------------------------------------------

export interface CatalogNextAiringEpisode {
  episode: number;
  airingAt: number;
  timeUntilAiring: number;
}

export interface CatalogItem {
  anilistId: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[];
  posterUrl: string | null;
  bannerUrl: string | null;
  description: string | null;
  genres: string[];
  tags: string[];
  averageScore: number | null;
  episodesCount: number | null;
  durationMinutes: number | null;
  format: string | null;
  status: string | null;
  season: string | null;
  seasonYear: number | null;
  nextAiringEpisode: CatalogNextAiringEpisode | null;
  studios: string[];
}

export interface AiringEntry {
  anilistId: number;
  idMal: number | null;
  /** English title, falling back to romaji. */
  title: string;
  posterUrl: string | null;
  episode: number | null;
  airingAt: number;
}

// --- Cache plumbing ---------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const memoryCache = new Map<string, CacheEntry<unknown>>();
const inFlightRequests = new Map<string, Promise<unknown>>();

const TTL_TRENDING_MS = 30 * 60 * 1000; // 30 minutes
const TTL_POPULAR_SEASON_MS = 6 * 60 * 60 * 1000; // 6 hours
const TTL_ALL_TIME_POPULAR_MS = 24 * 60 * 60 * 1000; // 24 hours
const TTL_AIRING_SCHEDULE_MS = 30 * 60 * 1000; // 30 minutes
const TTL_RECOMMENDATIONS_MS = 6 * 60 * 60 * 1000; // 6 hours
const TTL_SEARCH_MS = 5 * 60 * 1000; // 5 minutes (memory only)
const TTL_DETAILS_MS = 24 * 60 * 60 * 1000; // 24 hours

const DEFAULT_LIST_PER_PAGE = 24;

/**
 * Reads a disk cache entry (catalog_<name>.json). Returns null on any
 * problem; never throws.
 */
function readDiskCache(cacheName: string): CacheEntry<unknown> | null {
  try {
    const cacheFile = path.join(storage.getMetadataCacheDir(), `catalog_${cacheName}.json`);
    if (!fs.existsSync(cacheFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.fetchedAt !== 'number' || !('data' in parsed)) {
      return null;
    }
    return { data: parsed.data, fetchedAt: parsed.fetchedAt };
  } catch (err: any) {
    console.error(`Failed to read catalog cache ${cacheName}:`, err?.message || err);
    return null;
  }
}

/**
 * Persists a cache entry to disk (best effort; never throws).
 */
function writeDiskCache(cacheName: string, entry: CacheEntry<unknown>): void {
  try {
    const cacheFile = path.join(storage.getMetadataCacheDir(), `catalog_${cacheName}.json`);
    fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), 'utf-8');
  } catch (err: any) {
    console.error(`Failed to write catalog cache ${cacheName}:`, err?.message || err);
  }
}

/**
 * Shared cached-service plumbing: memory layer -> disk layer -> in-flight
 * dedup -> network fetch with stale-on-error fallback. The returned promise
 * never rejects.
 */
async function cachedServiceCall<T>(
  cacheName: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  options: { emptyValue: T; useDiskCache?: boolean }
): Promise<T> {
  const useDiskCache = options.useDiskCache !== false;

  // 1. In-memory cache
  const mem = memoryCache.get(cacheName);
  if (mem && Date.now() - mem.fetchedAt < ttlMs) {
    return mem.data as T;
  }

  // 2. Disk cache
  let disk: CacheEntry<unknown> | null = null;
  if (useDiskCache) {
    disk = readDiskCache(cacheName);
    if (disk && Date.now() - disk.fetchedAt < ttlMs) {
      memoryCache.set(cacheName, disk);
      return disk.data as T;
    }
  }

  // 3. In-flight deduplication
  const pending = inFlightRequests.get(cacheName);
  if (pending) {
    return pending as Promise<T>;
  }

  const request = (async () => {
    try {
      const data = await fetcher();
      const entry: CacheEntry<T> = { data, fetchedAt: Date.now() };
      memoryCache.set(cacheName, entry);
      if (useDiskCache) {
        writeDiskCache(cacheName, entry);
      }
      return data;
    } catch (err: any) {
      // Degrade gracefully: stale cache beats an empty result
      console.error(`Catalog refresh failed for ${cacheName}, serving stale data if available:`, err?.message || err);
      if (disk) {
        return disk.data as T;
      }
      if (mem) {
        return mem.data as T;
      }
      return options.emptyValue;
    } finally {
      inFlightRequests.delete(cacheName);
    }
  })();

  inFlightRequests.set(cacheName, request);
  return request;
}

// --- Normalization ----------------------------------------------------------

/**
 * Converts a raw AniList media object into the normalized CatalogItem shape.
 * HTML tags are stripped from the description (same approach as kitsu.ts).
 */
export function normalizeMedia(raw: AniListMedia): CatalogItem {
  const rawDescription = typeof raw?.description === 'string' ? raw.description : '';
  const cleanedDescription = rawDescription.replace(/<[^>]+>/g, '').trim();

  return {
    anilistId: raw?.id,
    idMal: typeof raw?.idMal === 'number' ? raw.idMal : null,
    title: {
      romaji: raw?.title?.romaji || null,
      english: raw?.title?.english || null,
      native: raw?.title?.native || null,
    },
    synonyms: Array.isArray(raw?.synonyms) ? raw.synonyms.filter((s) => typeof s === 'string' && s.length > 0) : [],
    posterUrl: raw?.coverImage?.extraLarge || raw?.coverImage?.large || null,
    bannerUrl: raw?.bannerImage || null,
    description: cleanedDescription ? cleanedDescription : null,
    genres: Array.isArray(raw?.genres) ? raw.genres : [],
    // Names only; tag rank (agreement %) is fetched but intentionally not
    // surfaced to keep the IPC payload lean.
    tags: Array.isArray(raw?.tags) ? raw.tags.map((t) => t?.name).filter((n): n is string => !!n) : [],
    averageScore: typeof raw?.averageScore === 'number' ? raw.averageScore : null,
    episodesCount: typeof raw?.episodes === 'number' ? raw.episodes : null,
    durationMinutes: typeof raw?.duration === 'number' ? raw.duration : null,
    format: raw?.format || null,
    status: raw?.status || null,
    season: raw?.season || null,
    seasonYear: typeof raw?.seasonYear === 'number' ? raw.seasonYear : null,
    nextAiringEpisode: raw?.nextAiringEpisode
      ? {
          episode: raw.nextAiringEpisode.episode,
          airingAt: raw.nextAiringEpisode.airingAt,
          timeUntilAiring: raw.nextAiringEpisode.timeUntilAiring,
        }
      : null,
    studios: Array.isArray(raw?.studios?.nodes)
      ? raw.studios.nodes.map((n) => n?.name).filter((n): n is string => !!n)
      : [],
  };
}

// --- Season & week helpers --------------------------------------------------

/**
 * Derives the currently airing AniList season from a date, following AniList
 * conventions: Winter = Jan-Mar with December counting toward Winter of the
 * following year, Spring = Apr-Jun, Summer = Jul-Sep, Fall = Oct-Nov.
 */
export function getCurrentAniListSeason(date: Date = new Date()): { season: AniListSeason; year: number } {
  const month = date.getMonth();
  const year = date.getFullYear();
  if (month === 11) {
    return { season: 'WINTER', year: year + 1 };
  }
  if (month <= 2) {
    return { season: 'WINTER', year };
  }
  if (month <= 5) {
    return { season: 'SPRING', year };
  }
  if (month <= 8) {
    return { season: 'SUMMER', year };
  }
  return { season: 'FALL', year };
}

/**
 * Computes the [from, to] unix range (seconds) of the calendar week (Monday
 * 00:00 local time) that `weekOffset` points at, relative to the current week
 * (weekOffset = 0). The range is 7 days long, `to` exclusive.
 */
export function getAiringWeekRange(weekOffset = 0): { from: number; to: number } {
  const now = new Date();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysSinceMonday = (weekStart.getDay() + 6) % 7; // 0 = Monday
  weekStart.setDate(weekStart.getDate() - daysSinceMonday + weekOffset * 7);
  const from = Math.floor(weekStart.getTime() / 1000);
  return { from, to: from + 7 * 24 * 60 * 60 };
}

// --- Cached service functions -----------------------------------------------

/**
 * Currently trending anime. TTL 30 min.
 */
export async function getTrending(perPage = DEFAULT_LIST_PER_PAGE): Promise<CatalogItem[]> {
  return cachedServiceCall('trending', TTL_TRENDING_MS, async () => {
    const media = await queryTrending(perPage);
    return media.map(normalizeMedia);
  }, { emptyValue: [] });
}

/**
 * Most popular anime of the current season (derived from the current month
 * using AniList conventions). TTL 6 h.
 */
export async function getPopularSeason(perPage = DEFAULT_LIST_PER_PAGE): Promise<CatalogItem[]> {
  const { season, year } = getCurrentAniListSeason();
  return cachedServiceCall(`popular_season_${season}_${year}`, TTL_POPULAR_SEASON_MS, async () => {
    const media = await queryPopularSeason(season, year, perPage);
    return media.map(normalizeMedia);
  }, { emptyValue: [] });
}

/**
 * All-time popular anime. TTL 24 h.
 */
export async function getAllTimePopular(perPage = DEFAULT_LIST_PER_PAGE): Promise<CatalogItem[]> {
  return cachedServiceCall('all_time_popular', TTL_ALL_TIME_POPULAR_MS, async () => {
    const media = await queryAllTimePopular(perPage);
    return media.map(normalizeMedia);
  }, { emptyValue: [] });
}

/**
 * Airing schedule entries for the calendar week (Monday-Sunday, local time)
 * `weekOffset` weeks from the current one, sorted by airingAt. TTL 30 min.
 */
export async function getAiringSchedule(weekOffset = 0): Promise<AiringEntry[]> {
  const offset = Math.trunc(Number(weekOffset) || 0);
  const { from, to } = getAiringWeekRange(offset);
  return cachedServiceCall(`schedule_${offset}`, TTL_AIRING_SCHEDULE_MS, async () => {
    const entries = await queryAiringSchedule(from, to, 50);
    const items: AiringEntry[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const media = entry.media;
      if (!media) continue;
      const airingAt = typeof entry.airingAt === 'number' ? entry.airingAt : 0;
      if (airingAt < from || airingAt >= to) continue; // paranoia against server drift
      const dedupeKey = `${media.id}:${entry.episode ?? '?'}:${airingAt}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      items.push({
        anilistId: media.id,
        idMal: typeof media.idMal === 'number' ? media.idMal : null,
        title: media.title?.english || media.title?.romaji || `Anime #${media.id}`,
        posterUrl: media.coverImage?.extraLarge || media.coverImage?.large || null,
        episode:
          typeof entry.episode === 'number'
            ? entry.episode
            : typeof media.nextAiringEpisode?.episode === 'number'
            ? media.nextAiringEpisode.episode
            : null,
        airingAt,
      });
    }
    items.sort((a, b) => a.airingAt - b.airingAt || a.anilistId - b.anilistId || (a.episode ?? 0) - (b.episode ?? 0));
    return items;
  }, { emptyValue: [] });
}

/**
 * Anime recommended for the given seed AniList IDs. Recommendations that
 * appear for more seeds rank first, then by average score; the seeds
 * themselves are always excluded. Cache key is a hash of the sorted seed
 * list. TTL 6 h.
 */
export async function getRecommendations(seedAnilistIds: number[], limit = 24): Promise<CatalogItem[]> {
  const seeds = Array.from(
    new Set(
      (Array.isArray(seedAnilistIds) ? seedAnilistIds : [])
        .map((id) => Math.trunc(Number(id)))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
  if (seeds.length === 0) return [];
  seeds.sort((a, b) => a - b);

  const seedKey = crypto.createHash('md5').update(seeds.join(',')).digest('hex');
  const cacheName = `recs_${seedKey}`;

  return cachedServiceCall(cacheName, TTL_RECOMMENDATIONS_MS, async () => {
    const recommended = await queryRecommendations(seeds);
    const seedSet = new Set(seeds);
    const counts = new Map<number, number>();
    const firstSeen = new Map<number, AniListMedia>();
    for (const media of recommended) {
      if (!media || seedSet.has(media.id)) continue;
      counts.set(media.id, (counts.get(media.id) || 0) + 1);
      if (!firstSeen.has(media.id)) {
        firstSeen.set(media.id, media);
      }
    }
    const ranked = Array.from(firstSeen.values())
      .sort((a, b) => {
        const ca = counts.get(a.id) || 0;
        const cb = counts.get(b.id) || 0;
        if (cb !== ca) return cb - ca;
        const sa = typeof a.averageScore === 'number' ? a.averageScore : 0;
        const sb = typeof b.averageScore === 'number' ? b.averageScore : 0;
        if (sb !== sa) return sb - sa;
        return a.id - b.id;
      })
      .slice(0, Math.max(1, limit));
    return ranked.map(normalizeMedia);
  }, { emptyValue: [] });
}

/**
 * Catalog search by title (memory cache only, 5 min TTL — searches are too
 * user-specific to be worth persisting to disk).
 */
export async function searchCatalog(query: string): Promise<CatalogItem[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const cacheName = `search_${crypto.createHash('md5').update(q.toLowerCase()).digest('hex')}`;
  return cachedServiceCall(cacheName, TTL_SEARCH_MS, async () => {
    const media = await querySearch(q, DEFAULT_LIST_PER_PAGE);
    return media.map(normalizeMedia);
  }, { emptyValue: [], useDiskCache: false });
}

/**
 * Full catalog details for a single AniList ID (null if the title does not
 * exist — successful misses are negatively cached for the TTL window).
 * TTL 24 h.
 */
export async function getCatalogDetails(anilistId: number): Promise<CatalogItem | null> {
  const id = Math.trunc(Number(anilistId));
  if (!Number.isFinite(id) || id <= 0) return null;
  return cachedServiceCall(`details_${id}`, TTL_DETAILS_MS, async () => {
    const media = await queryDetails(id);
    return media ? normalizeMedia(media) : null;
  }, { emptyValue: null });
}
