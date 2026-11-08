import fs from 'fs';
import path from 'path';
import { storage } from './storage';

const SOURCE_URL = 'https://cdn.jsdelivr.net/gh/subhajeetch-fl/anime-mapper@main/data/search-index.json';
const UPDATE_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const MINIMUM_RATING_COUNT = 20_000;

interface AgeRatingCache {
  checkedAt: number;
  ratings: Record<string, number>;
}

let currentRatings: Record<string, number> = {};
let lastCheckedAt = 0;
let initialized = false;
let updaterStarted = false;
let updatePromise: Promise<void> | null = null;
let updateTimer: NodeJS.Timeout | null = null;

function cachePath(): string {
  return path.join(storage.getMetadataCacheDir(), 'age-ratings.json');
}

function readCache(): void {
  if (initialized) return;
  initialized = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as Partial<AgeRatingCache>;
    if (!parsed || typeof parsed !== 'object' || !parsed.ratings || typeof parsed.ratings !== 'object') return;
    const ratings: Record<string, number> = {};
    for (const [id, code] of Object.entries(parsed.ratings)) {
      if (/^[1-9]\d*$/.test(id) && Number.isInteger(code) && code >= 0 && code <= 5) ratings[id] = code;
    }
    if (Object.keys(ratings).length < MINIMUM_RATING_COUNT) return;
    currentRatings = ratings;
    lastCheckedAt = Number.isFinite(parsed.checkedAt) ? Number(parsed.checkedAt) : 0;
  } catch {
    // First install has no downloaded copy yet; the renderer keeps using its bundled fallback.
  }
}

export function getUpdatedAgeRatings(): Record<string, number> {
  readCache();
  return currentRatings;
}

function normalizeRating(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const rating = value.trim().toUpperCase();
  if (/^PG\s*-\s*13\b/.test(rating)) return 2;
  if (/^R\s*\+/.test(rating)) return 4;
  if (/^R\s*-\s*17\+/.test(rating) || rating === 'R') return 3;
  if (/^RX\b/.test(rating)) return 5;
  if (/^PG\b/.test(rating)) return 1;
  if (/^G\b/.test(rating)) return 0;
  return null;
}

async function downloadRatings(): Promise<Record<string, number>> {
  const response = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'AnimeMediaCenter/1.0 (age-rating database update)' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Age-rating source returned HTTP ${response.status}`);
  const entries = await response.json() as Array<{ id?: unknown; r?: unknown }>;
  if (!Array.isArray(entries)) throw new Error('Age-rating source returned an invalid index');

  const ratings: Record<string, number> = {};
  for (const anime of entries) {
    const id = Number(anime?.id);
    const code = normalizeRating(anime?.r);
    if (Number.isSafeInteger(id) && id > 0 && code != null) ratings[id] = code;
  }
  if (Object.keys(ratings).length < MINIMUM_RATING_COUNT) {
    throw new Error(`Age-rating source returned too few ratings (${Object.keys(ratings).length})`);
  }
  return ratings;
}

function persistCache(cache: AgeRatingCache): void {
  const target = cachePath();
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cache), 'utf8');
  fs.renameSync(temporary, target);
}

function scheduleUpdate(delayMs: number, onUpdated: (ratings: Record<string, number>) => void): void {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    void refreshAgeRatings(onUpdated);
  }, Math.max(0, delayMs));
  updateTimer.unref?.();
}

async function refreshAgeRatings(onUpdated: (ratings: Record<string, number>) => void): Promise<void> {
  if (updatePromise) return updatePromise;
  updatePromise = (async () => {
    try {
      const freshRatings = await downloadRatings();
      const changed = JSON.stringify(freshRatings) !== JSON.stringify(currentRatings);
      const checkedAt = Date.now();
      persistCache({ checkedAt, ratings: freshRatings });
      currentRatings = freshRatings;
      lastCheckedAt = checkedAt;
      if (changed) onUpdated(currentRatings);
      console.info(`[Age ratings] Updated local database (${Object.keys(freshRatings).length} titles).`);
      scheduleUpdate(UPDATE_INTERVAL_MS, onUpdated);
    } catch (error) {
      console.warn('[Age ratings] Background update failed; keeping the local database:', error);
      scheduleUpdate(RETRY_INTERVAL_MS, onUpdated);
    }
  })().finally(() => {
    updatePromise = null;
  });
  return updatePromise;
}

/** Loads the installed cache and refreshes it in the background at least every three days. */
export function startAgeRatingsUpdater(onUpdated: (ratings: Record<string, number>) => void): void {
  if (updaterStarted) return;
  updaterStarted = true;
  readCache();
  const ageMs = Date.now() - lastCheckedAt;
  const hasDownloadedCopy = Object.keys(currentRatings).length >= MINIMUM_RATING_COUNT;
  if (!hasDownloadedCopy || ageMs >= UPDATE_INTERVAL_MS) {
    void refreshAgeRatings(onUpdated);
  } else {
    scheduleUpdate(UPDATE_INTERVAL_MS - ageMs, onUpdated);
  }
}
