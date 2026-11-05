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

export interface RemoteEpisodeInfo {
  number: number;
  title: string | null;
  thumbnailUrl: string | null;
  airDate: string | null;
  runtime: number | null;
}

const ANIZIP_ENDPOINT = 'https://api.ani.zip/mappings';
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const memoryCache = new Map<number, RemoteEpisodeInfo[]>();
const inFlightRequests = new Map<number, Promise<RemoteEpisodeInfo[]>>();

/**
 * Picks a display title out of an ani.zip episode entry, which may expose the
 * title as a plain string or as a locale map ({ en, x-jat, ja, ... }).
 */
function pickEpisodeTitle(ep: any): string | null {
  const t = ep?.title;
  if (typeof t === 'string' && t.trim()) {
    return t.trim();
  }
  if (t && typeof t === 'object') {
    const preferred = t.en || t['en_us'] || t['x-jat'] || t.ja;
    if (typeof preferred === 'string' && preferred.trim()) {
      return preferred.trim();
    }
    const anyString = Object.values(t).find((v) => typeof v === 'string' && (v as string).trim());
    if (typeof anyString === 'string' && anyString.trim()) {
      return anyString.trim();
    }
  }
  const fallback = ep?.titleEn ?? ep?.title_en;
  return typeof fallback === 'string' && fallback.trim() ? fallback.trim() : null;
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
    if (!Number.isFinite(number)) continue;

    const runtimeRaw = ep.runtime ?? ep.length;
    const runtime = Number(runtimeRaw);

    byNumber.set(number, {
      number,
      title: pickEpisodeTitle(ep),
      thumbnailUrl: typeof ep.image === 'string' && ep.image ? ep.image : null,
      airDate: ep.airDate ?? ep.airdate ?? ep.airDateUtc ?? null,
      runtime: Number.isFinite(runtime) && runtime > 0 ? runtime : null,
    });
  }

  return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
}

/**
 * Reads the disk cache for an anilist ID. Returns { episodes, fetchedAt } or
 * null; never throws.
 */
function readDiskCache(anilistId: number): { episodes: RemoteEpisodeInfo[]; fetchedAt: number } | null {
  try {
    const cacheFile = path.join(storage.getMetadataCacheDir(), `anizip_${anilistId}.json`);
    if (!fs.existsSync(cacheFile)) return null;
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (!parsed || !Array.isArray(parsed.episodes) || typeof parsed.fetchedAt !== 'number') return null;
    return { episodes: parsed.episodes, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

/**
 * Fetches the full remote episode list for an AniList ID from ani.zip.
 * Cached in memory and on disk for 7 days, deduplicates concurrent requests
 * and falls back to a stale disk cache on failure. Never throws; resolves []
 * when nothing is available.
 */
export async function fetchAniZipMappings(anilistId: number): Promise<RemoteEpisodeInfo[]> {
  const id = Math.trunc(Number(anilistId));
  if (!Number.isFinite(id) || id <= 0) return [];

  // 1. In-memory cache
  const mem = memoryCache.get(id);
  if (mem) return mem;

  // 2. Disk cache (7 days)
  const disk = readDiskCache(id);
  if (disk && Date.now() - disk.fetchedAt < CACHE_TTL_MS) {
    memoryCache.set(id, disk.episodes);
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`ani.zip returned HTTP ${res.status}`);
      }
      const json = await res.json();
      const episodes = normalizeAniZipEpisodes(json);

      // Persist to disk cache
      try {
        fs.writeFileSync(
          path.join(storage.getMetadataCacheDir(), `anizip_${id}.json`),
          JSON.stringify({ anilistId: id, fetchedAt: Date.now(), episodes }, null, 2),
          'utf-8'
        );
      } catch {}

      memoryCache.set(id, episodes);
      return episodes;
    } catch (err: any) {
      // Stale disk cache is better than nothing
      if (disk && disk.episodes.length > 0) {
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
