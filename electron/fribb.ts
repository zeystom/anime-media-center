import fs from 'fs';
import path from 'path';
import { storage } from './storage.ts';

/**
 * Local ID crosswalk (Fribb/anime-lists, `anime-list-mini.json` — ~6 MB,
 * ~40k entries, IDs only). Downloaded once and cached on disk so cold opens
 * get kitsu/mal/tvdb ids at 0 ms instead of waiting on the flapping ani.zip
 * mappings endpoint.
 */
const FRIBB_ENDPOINT = 'https://cdn.jsdelivr.net/gh/Fribb/anime-lists@master/anime-list-mini.json';
const FRIBB_REFRESH_MS = 3 * 24 * 60 * 60 * 1000;
const FRIBB_DOWNLOAD_TIMEOUT_MS = 30000;
const FRIBB_RETRY_BACKOFF_MS = 60_000;

export interface FribbIds {
  kitsuId: number | null;
  malId: number | null;
  tvdbId: number | null;
}

let indexById = new Map<number, FribbIds>();
let loadedAt = 0;
let loadPromise: Promise<Map<number, FribbIds>> | null = null;
let lastDownloadAttemptAt = 0;
let kitsuToAnilist: Map<number, number> | null = null;
let kitsuReverseBuiltAt = 0;

function cacheFile(): string {
  return path.join(storage.getMetadataCacheDir(), 'fribb_anime_list.json');
}

function readDiskIndex(): { map: Map<number, FribbIds>; fetchedAt: number } | null {
  try {
    const file = cacheFile();
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed.fetchedAt !== 'number' || !parsed.mappings || typeof parsed.mappings !== 'object') return null;
    const map = new Map<number, FribbIds>();
    for (const [key, value] of Object.entries(parsed.mappings)) {
      const anilistId = Number(key);
      if (!Number.isInteger(anilistId) || anilistId <= 0 || !value || typeof value !== 'object') continue;
      const ids = value as Record<string, unknown>;
      map.set(anilistId, {
        kitsuId: Number.isInteger(ids.kitsuId) ? Number(ids.kitsuId) : null,
        malId: Number.isInteger(ids.malId) ? Number(ids.malId) : null,
        tvdbId: Number.isInteger(ids.tvdbId) ? Number(ids.tvdbId) : null,
      });
    }
    return { map, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

function writeDiskIndex(map: Map<number, FribbIds>): void {
  try {
    const mappings: Record<string, FribbIds> = {};
    for (const [anilistId, ids] of map) mappings[String(anilistId)] = ids;
    fs.writeFileSync(cacheFile(), JSON.stringify({ fetchedAt: Date.now(), mappings }), 'utf-8');
  } catch {}
}

async function downloadIndex(): Promise<Map<number, FribbIds>> {
  const res = await fetch(FRIBB_ENDPOINT, {
    headers: { Accept: 'application/json', 'User-Agent': 'AnimeMediaCenter/1.0' },
    signal: AbortSignal.timeout(FRIBB_DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Fribb list returned HTTP ${res.status}`);
  const payload = await res.json();
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const map = new Map<number, FribbIds>();
  for (const row of rows) {
    const anilistId = Number(row?.anilist_id);
    if (!Number.isInteger(anilistId) || anilistId <= 0) continue;
    map.set(anilistId, {
      kitsuId: Number.isInteger(row?.kitsu_id) ? Number(row.kitsu_id) : null,
      malId: Number.isInteger(row?.mal_id) ? Number(row.mal_id) : null,
      tvdbId: Number.isInteger(row?.tvdb_id) ? Number(row.tvdb_id) : null,
    });
  }
  return map;
}

/**
 * Loads the index: the disk copy is served instantly and refreshed in the
 * background when stale. Never throws — an empty map is a valid fallback.
 */
export async function getFribbIndex(): Promise<Map<number, FribbIds>> {
  if (indexById.size > 0 && Date.now() - loadedAt < FRIBB_REFRESH_MS) return indexById;
  if (!loadPromise) {
    loadPromise = (async () => {
      const disk = readDiskIndex();
      if (disk) {
        indexById = disk.map;
        loadedAt = disk.fetchedAt;
      }
      if (!disk || Date.now() - disk.fetchedAt > FRIBB_REFRESH_MS) {
        if (Date.now() - lastDownloadAttemptAt > FRIBB_RETRY_BACKOFF_MS) {
          lastDownloadAttemptAt = Date.now();
          void downloadIndex()
            .then((fresh) => {
              indexById = fresh;
              loadedAt = Date.now();
              writeDiskIndex(fresh);
            })
            .catch((err: any) => console.warn('[Fribb] index refresh failed:', err?.message || err));
        }
      }
      return indexById;
    })().finally(() => {
      loadPromise = null;
    });
  }
  return loadPromise;
}

/** Synchronous lookup over whatever index is loaded (warm via warmFribbIndex). */
export function lookupFribbIds(anilistId: number): FribbIds | null {
  return indexById.get(Math.trunc(Number(anilistId))) ?? null;
}

/** Reverse crosswalk: Kitsu id → AniList id. Rebuilt whenever the index is
 *  (re)loaded; returns null while the index is empty/unavailable. */
export function lookupAnilistIdByKitsu(kitsuId: number): number | null {
  if (!indexById.size) return null;
  if (!kitsuToAnilist || kitsuReverseBuiltAt !== loadedAt) {
    kitsuToAnilist = new Map();
    for (const [anilistId, ids] of indexById) {
      if (ids.kitsuId != null && !kitsuToAnilist.has(ids.kitsuId)) kitsuToAnilist.set(ids.kitsuId, anilistId);
    }
    kitsuReverseBuiltAt = loadedAt;
  }
  return kitsuToAnilist.get(Math.trunc(Number(kitsuId))) ?? null;
}

export function warmFribbIndex(): void {
  void getFribbIndex();
}
