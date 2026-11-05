/**
 * Watchlist export/import: AnimeCenter JSON payloads and the MyAnimeList XML
 * export format.
 *
 * Design notes (mirrors userDataBackup.ts):
 * - Status mapping, XML build/parse, JSON payload build/apply and the MAL
 *   import record builder are pure and free of electron imports so plain Node
 *   tests can exercise them directly.
 * - exportWatchlist / importWatchlist resolve the live storage + userLibrary
 *   singletons through the registry registered by storage.ts / userLibrary.ts
 *   (userDataBackup.registerMainServices) instead of static electron imports.
 * - The atomic write and rename-with-retry logic are reimplemented locally
 *   following the same approach as storage.ts's saveJsonSync.
 */
import fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import type { UserLibraryEntry, UserListStatus } from './userLibrary.ts';
import type { PlaybackProgress, SeasonPreference } from './types.ts';
import { requireMainServices } from './userDataBackup.ts';

export type WatchlistExportFormat = 'json' | 'mal-xml';

export type MalStatus = 'Watching' | 'Completed' | 'On-Hold' | 'Dropped' | 'Plan to Watch';

/**
 * Synthetic anilistId base for entries imported from MAL XML that have no
 * AniList mapping yet: anilistId >= MAL_ONLY_ANILIST_ID_BASE means the real
 * MAL id is anilistId - MAL_ONLY_ANILIST_ID_BASE (which also equals idMal).
 * The offset sits far above the current AniList id space (< ~2e8) so it never
 * collides with real entries, and every existing numeric-id invariant of the
 * user library keeps holding.
 */
export const MAL_ONLY_ANILIST_ID_BASE = 1000000000;

const USER_TO_MAL: Record<UserListStatus, MalStatus> = {
  watching: 'Watching',
  completed: 'Completed',
  paused: 'On-Hold',
  dropped: 'Dropped',
  planning: 'Plan to Watch',
};

const MAL_TO_USER: Record<string, UserListStatus> = {
  watching: 'watching',
  completed: 'completed',
  'on hold': 'paused',
  dropped: 'dropped',
  'plan to watch': 'planning',
};

/**
 * Maps an internal UserListStatus to the MyAnimeList my_status string.
 */
export function mapStatusToMal(status: UserListStatus): MalStatus {
  return USER_TO_MAL[status] ?? 'Plan to Watch';
}

/**
 * Tolerant inverse of mapStatusToMal: case-insensitive and accepts spaces,
 * underscores or hyphens as separators ('plan_to_watch', 'Plan to Watch',
 * 'on_hold', 'ON-Hold', ...). Returns null for unmappable input.
 */
export function mapStatusFromMal(s: string): UserListStatus | null {
  if (typeof s !== 'string') return null;
  const normalized = s.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  return MAL_TO_USER[normalized] ?? null;
}

/**
 * Escapes XML special characters in text content.
 */
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'
  );
}

/**
 * True when the entry carries a usable MyAnimeList id (only those can be
 * represented in the MAL export format).
 */
function hasValidIdMal(entry: UserLibraryEntry | null | undefined): entry is UserLibraryEntry & { idMal: number } {
  if (!entry || typeof entry !== 'object') return false;
  const idMal = Math.trunc(Number(entry.idMal));
  return Number.isFinite(idMal) && idMal > 0;
}

/**
 * Builds a MyAnimeList-compatible XML export string. Only entries carrying an
 * idMal are included; titles are XML-escaped.
 */
export function buildMalXml(entries: UserLibraryEntry[]): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<myanimelist>',
    '<myinfo>',
    '<user_export_type>1</user_export_type>',
    '</myinfo>',
  ];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!hasValidIdMal(entry)) continue;
    const watched =
      typeof entry.progress === 'number' && Number.isFinite(entry.progress) ? Math.max(0, Math.trunc(entry.progress)) : 0;
    const score =
      typeof entry.score === 'number' && Number.isFinite(entry.score) ? Math.min(10, Math.max(0, entry.score)) : 0;
    const status = mapStatusToMal(entry.status);
    parts.push(
      '<anime>',
      `<series_animedb_id>${Math.trunc(entry.idMal)}</series_animedb_id>`,
      `<series_title>${escapeXml(String(entry.titleSnapshot ?? ''))}</series_title>`,
      '<series_type/>',
      '<series_episodes/>',
      '<my_id>0</my_id>',
      `<my_watched_episodes>${watched}</my_watched_episodes>`,
      '<my_start_date>0000-00-00</my_start_date>',
      '<my_finish_date>0000-00-00</my_finish_date>',
      '<my_rated/>',
      `<my_score>${score}</my_score>`,
      '<my_storage/>',
      '<my_storage_value>0</my_storage_value>',
      '<my_comments><![CDATA[Exported by AnimeCenter]]></my_comments>',
      '<my_times_watched>0</my_times_watched>',
      `<my_status>${status}</my_status>`,
      '<my_rewatching>0</my_rewatching>',
      '<my_rewatching_ep>0</my_rewatching_ep>',
      '<my_tags></my_tags>',
      '</anime>'
    );
  }
  parts.push('</myanimelist>');
  return parts.join('');
}

/**
 * A single anime parsed out of a MAL XML export. score keeps the raw MAL
 * rating (0 = unrated); null means the field was missing or not numeric.
 */
export interface ParsedMalAnime {
  idMal: number;
  title: string;
  watchedEpisodes: number;
  status: UserListStatus;
  score: number | null;
}

function toInt(value: unknown, fallback: number): number {
  const num = Math.trunc(Number(value));
  return Number.isFinite(num) ? num : fallback;
}

/**
 * parseTagValue/parseAttributeValue keep numeric XML text as numbers, but be
 * tolerant of strings, empty elements and missing fields.
 */
function parseMalScore(raw: unknown): number | null {
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(num)) return null;
  return Math.min(10, Math.max(0, num));
}

/**
 * Parses a MAL XML export into entries plus a skipped count. Entries with an
 * invalid series_animedb_id or an unmappable my_status are skipped (counted,
 * never guessed). Malformed XML degrades gracefully to an empty result
 * instead of throwing. See parseMalXml for the plain-array variant.
 */
export function parseMalXmlDetailed(xml: string): { entries: ParsedMalAnime[]; skipped: number } {
  const entries: ParsedMalAnime[] = [];
  let skipped = 0;
  if (typeof xml !== 'string' || !xml.includes('<myanimelist')) {
    return { entries, skipped };
  }
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: true,
      parseAttributeValue: true,
      trimValues: true,
      processEntities: true,
    });
    const doc = parser.parse(xml);
    const root = doc && typeof doc === 'object' ? (doc.myanimelist ?? doc) : null;
    let animeList = root && typeof root === 'object' ? root.anime : null;
    if (!animeList) {
      return { entries, skipped };
    }
    if (!Array.isArray(animeList)) {
      animeList = [animeList];
    }
    for (const node of animeList) {
      if (!node || typeof node !== 'object') {
        skipped++;
        continue;
      }
      const idMal = toInt(node.series_animedb_id, 0);
      if (idMal <= 0) {
        skipped++;
        continue;
      }
      const status = mapStatusFromMal(typeof node.my_status === 'string' ? node.my_status : String(node.my_status ?? ''));
      if (!status) {
        skipped++;
        continue;
      }
      entries.push({
        idMal,
        title: typeof node.series_title === 'string' ? node.series_title : String(node.series_title ?? ''),
        watchedEpisodes: Math.max(0, toInt(node.my_watched_episodes, 0)),
        status,
        score: parseMalScore(node.my_score),
      });
    }
  } catch (e) {
    console.error('Failed to parse MAL XML watchlist:', e);
  }
  return { entries, skipped };
}

/**
 * Parses a MAL XML export; entries with an invalid id or unmappable status
 * are skipped. See parseMalXmlDetailed for the skipped count.
 */
export function parseMalXml(xml: string): ParsedMalAnime[] {
  return parseMalXmlDetailed(xml).entries;
}

/**
 * Pure merge step behind importWatchlist('mal-xml'): builds the record to
 * pass to UserLibrary.mergeEntries. Existing entries are matched by idMal so
 * AniList-tracked titles absorb their MAL progress; unmatched titles become
 * MAL-only entries with a synthetic anilistId (see MAL_ONLY_ANILIST_ID_BASE).
 * Incoming wins when its progress is higher or the entry is missing; MAL
 * score 0 (unrated) maps to null.
 */
export function buildMalImportRecord(
  parsed: ParsedMalAnime[],
  existing: Record<number, UserLibraryEntry>,
  now: number = Date.now()
): Record<number, UserLibraryEntry> {
  const byIdMal = new Map<number, UserLibraryEntry>();
  for (const entry of Object.values(existing ?? {})) {
    if (hasValidIdMal(entry) && !byIdMal.has(entry.idMal)) {
      byIdMal.set(entry.idMal, entry);
    }
  }

  const record: Record<number, UserLibraryEntry> = {};
  for (const item of Array.isArray(parsed) ? parsed : []) {
    if (!item || typeof item !== 'object') continue;
    const score = item.score !== null && item.score >= 1 && item.score <= 10 ? item.score : null;
    const target = byIdMal.get(item.idMal);

    if (!target) {
      const anilistId = MAL_ONLY_ANILIST_ID_BASE + item.idMal;
      record[anilistId] = {
        anilistId,
        idMal: item.idMal,
        titleSnapshot: item.title,
        status: item.status,
        score,
        progress: item.watchedEpisodes,
        updatedAt: now,
      };
      continue;
    }

    const incomingWins = item.watchedEpisodes > target.progress;
    const progress = Math.max(target.progress, item.watchedEpisodes);
    const status = incomingWins ? item.status : target.status;
    const entryScore = incomingWins ? score ?? target.score ?? null : target.score ?? score;
    if (progress === target.progress && status === target.status && entryScore === target.score) {
      continue; // nothing to merge
    }
    record[target.anilistId] = {
      ...target,
      progress,
      status,
      score: entryScore,
      updatedAt: now,
    };
  }
  return record;
}

// ---------------------------------------------------------------------------
// AnimeCenter JSON payload (watchlist export = backup payload minus settings)
// ---------------------------------------------------------------------------

export interface WatchlistJsonPayload {
  format: 'animecenter-watchlist';
  version: 1;
  exportedAt: number;
  history?: Record<string, PlaybackProgress>;
  seasonRules?: Record<string, SeasonPreference>;
  userLibrary?: Record<number, UserLibraryEntry>;
}

/**
 * Builds the AnimeCenter watchlist JSON payload (same data as the Documents
 * backup minus settings).
 */
export function buildWatchlistJson(deps: {
  history?: Record<string, PlaybackProgress>;
  seasonRules?: Record<string, SeasonPreference>;
  userLibrary?: Record<number, UserLibraryEntry>;
}): WatchlistJsonPayload {
  const payload: WatchlistJsonPayload = {
    format: 'animecenter-watchlist',
    version: 1,
    exportedAt: Date.now(),
  };
  if (deps.history) payload.history = deps.history;
  if (deps.seasonRules) payload.seasonRules = deps.seasonRules;
  if (deps.userLibrary) payload.userLibrary = deps.userLibrary;
  return payload;
}

export interface WatchlistMergeDeps {
  mergeHistory: (records: Record<string, PlaybackProgress>) => number;
  mergeSeasonRules: (rules: Record<string, SeasonPreference>) => number;
  mergeEntries: (entries: Record<number, UserLibraryEntry>) => number;
}

/**
 * Pure apply step behind importWatchlist for AnimeCenter JSON payloads:
 * validates the payload and feeds its sections to the merge callbacks
 * (storage.mergePlaybackProgress / storage.mergeSeasonRules /
 * userLibrary.mergeEntries). Returns per-store merged counts. Throws when the
 * payload is not an AnimeCenter watchlist/backup document.
 */
export function applyWatchlistJson(
  payload: unknown,
  deps: WatchlistMergeDeps
): { history: number; seasonRules: number; userLibrary: number } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid watchlist payload: expected an object');
  }
  const doc = payload as { format?: unknown; version?: unknown; history?: unknown; seasonRules?: unknown; userLibrary?: unknown };
  if (doc.format !== 'animecenter-watchlist' && doc.format !== 'animecenter-backup') {
    throw new Error(`Unsupported watchlist payload format: ${String(doc.format)}`);
  }
  if (doc.version !== 1) {
    throw new Error(`Unsupported watchlist payload version: ${String(doc.version)}`);
  }
  const history =
    doc.history && typeof doc.history === 'object' && !Array.isArray(doc.history)
      ? deps.mergeHistory(doc.history as Record<string, PlaybackProgress>)
      : 0;
  const seasonRules =
    doc.seasonRules && typeof doc.seasonRules === 'object' && !Array.isArray(doc.seasonRules)
      ? deps.mergeSeasonRules(doc.seasonRules as Record<string, SeasonPreference>)
      : 0;
  const userLibrary =
    doc.userLibrary && typeof doc.userLibrary === 'object' && !Array.isArray(doc.userLibrary)
      ? deps.mergeEntries(doc.userLibrary as Record<number, UserLibraryEntry>)
      : 0;
  return { history, seasonRules, userLibrary };
}

// ---------------------------------------------------------------------------
// Atomic write (mirrors storage.ts saveJsonSync for arbitrary text)
// ---------------------------------------------------------------------------

function renameSyncWithRetry(src: string, dest: string, maxRetries = 5): void {
  let lastError: any = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err: any) {
      lastError = err;
      if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
        const delayMs = (attempt + 1) * 30;
        const start = Date.now();
        while (Date.now() - start < delayMs) {
          // brief synchronous spin wait
        }
      } else {
        throw err;
      }
    }
  }

  // Fallback if rename continues failing after retries on Windows NTFS
  try {
    fs.copyFileSync(src, dest);
    try {
      fs.unlinkSync(src);
    } catch {}
  } catch (copyErr) {
    throw lastError || copyErr;
  }
}

function writeTextAtomic(targetFile: string, data: string): void {
  const tmpFile = `${targetFile}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmpFile, data, 'utf-8');
    renameSyncWithRetry(tmpFile, targetFile, 5);
  } catch (e) {
    console.error(`Failed to atomic write to ${targetFile}:`, e);
    throw e;
  } finally {
    try {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// IPC-facing wrappers (registered main-process services required)
// ---------------------------------------------------------------------------

/**
 * Exports the live watchlist to filePath. 'json' writes the AnimeCenter
 * watchlist payload (history + season rules + user library); 'mal-xml' writes
 * a MyAnimeList-compatible XML of the user library entries that carry an
 * idMal. Returns the number of user library entries exported.
 */
export async function exportWatchlist(
  format: WatchlistExportFormat,
  filePath: string
): Promise<{ success: boolean; count?: number; error?: string }> {
  try {
    const { storage, userLibrary } = requireMainServices();
    const entries = userLibrary.getAll();
    if (format === 'mal-xml') {
      const list = Object.values(entries);
      writeTextAtomic(filePath, buildMalXml(list));
      return { success: true, count: list.filter((entry) => hasValidIdMal(entry)).length };
    }
    if (format !== 'json') {
      return { success: false, error: `Unsupported watchlist export format: ${String(format)}` };
    }
    const payload = buildWatchlistJson({
      history: storage.getAllPlaybackProgress(),
      seasonRules: storage.getAllSeasonRules(),
      userLibrary: entries,
    });
    writeTextAtomic(filePath, JSON.stringify(payload, null, 2));
    return { success: true, count: Object.keys(entries).length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error('Watchlist export failed:', error);
    return { success: false, error };
  }
}

/**
 * Detects the payload kind by extension and content ('<?xml' / '<' prefix for
 * MAL XML, '{' for AnimeCenter JSON).
 */
function looksLikeXml(filePath: string, raw: string): boolean {
  const trimmed = raw.trimStart();
  const isXmlPath = /\.xml$/i.test(filePath);
  const isJsonPath = /\.json$/i.test(filePath);
  if (isXmlPath) return true;
  if (isJsonPath) return false;
  return trimmed.startsWith('<');
}

/**
 * Imports a watchlist file into the live stores.
 * - AnimeCenter JSON (also accepts a Documents backup payload): merges
 *   history, season rules and user library via the additive merge methods.
 * - MyAnimeList XML: upserts user library entries (idMal set, synthetic
 *   anilistId when unmatched, titleSnapshot from the XML, progress = watched
 *   episodes, score 1-10 kept with 0 = unrated, updatedAt = now); existing
 *   entries are matched by idMal and incoming wins when its progress is
 *   higher.
 *
 * `imported` is the number of user library entries merged for MAL XML and the
 * total number of merged records (history + season rules + library) for
 * AnimeCenter JSON; `skipped` counts MAL XML entries with an invalid id or an
 * unmappable status.
 */
export async function importWatchlist(
  filePath: string
): Promise<{ success: boolean; imported?: number; skipped?: number; error?: string }> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const { storage, userLibrary } = requireMainServices();

    if (looksLikeXml(filePath, raw)) {
      const { entries, skipped } = parseMalXmlDetailed(raw);
      if (entries.length === 0) {
        return {
          success: false,
          error: 'No importable MAL entries found (malformed file, no anime data, or unmappable statuses)',
        };
      }
      const record = buildMalImportRecord(entries, userLibrary.getAll());
      const imported = userLibrary.mergeEntries(record);
      userLibrary.flush();
      return { success: true, imported, skipped };
    }

    const payload = JSON.parse(raw);
    const counts = applyWatchlistJson(payload, {
      mergeHistory: (records) => storage.mergePlaybackProgress(records),
      mergeSeasonRules: (rules) => storage.mergeSeasonRules(rules),
      mergeEntries: (entries) => userLibrary.mergeEntries(entries),
    });
    storage.flushHistory();
    userLibrary.flush();
    return { success: true, imported: counts.history + counts.seasonRules + counts.userLibrary, skipped: 0 };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error('Watchlist import failed:', error);
    return { success: false, error };
  }
}
