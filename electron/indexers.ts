/**
 * BYOC indexer client (RSS 2.0 / Torznab / Nyaa-style) for the P2P search flow.
 *
 * No indexer endpoints or feeds are bundled: every search endpoint comes from
 * user configuration (RssProvider.urlTemplate). The torrent engine may add a
 * separate public tracker fallback only to trackerless magnet links; see
 * ensureMagnetTrackers in torrentEngine.ts.
 *
 * Feed handling is deliberately tolerant:
 * - plain RSS 2.0 enclosures, Torznab's per-item `<attr name="..." value="..."/>`
 *   extras, and Nyaa-style namespaced extras (`<nyaa:infoHash>`, `<nyaa:seeders>`,
 *   `<nyaa:size>`, … — fast-xml-parser keeps them as literal keys with colons)
 *   are all normalized into ReleaseSearchResult;
 * - Nyaa-style feeds put a plain http(s) .torrent URL in `<link>` (NOT a magnet)
 *   and carry the swarm hash in `<nyaa:infoHash>`; preserve that .torrent URL
 *   so the embedded announce list is available to the torrent engine, while
 *   retaining the infohash separately for deduplication;
 * - searchProviders fans out with allSettled and returns per-provider reports so
 *   a single broken indexer (HTTP 403 / Cloudflare, timeout, bad XML) never
 *   sinks the whole search and never fails silently.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { RssProvider, ReleaseSearchResult, ProviderReport } from './types.ts';
import { parseReleaseSync } from '../src/lib/releaseParser/index.ts';
import { classifyRelease } from '../src/lib/releaseParser/releaseClassification.ts';
import { releaseDescriptionToText } from '../src/lib/releaseParser/releaseClassification.ts';

/** Per-request timeout for indexer feeds. */
const FETCH_TIMEOUT_MS = 12_000;
/** Upper bound of normalized items kept per provider feed. */
const MAX_ITEMS_PER_PROVIDER = 50;
const MAX_RELEASE_PAGE_BYTES = 512 * 1024;
const MAX_RELEASE_PAGE_REDIRECTS = 3;
/** Upper bound of providers accepted by importProvidersConfig. */
const MAX_PROVIDERS = 20;

/**
 * Browser-like request headers. Real indexer feeds sit behind Cloudflare and
 * routinely 403 non-browser User-Agents (e.g. "AnimeMediaCenter/1.0"), so the
 * request must look like an ordinary Chrome GET.
 */
const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: 'application/rss+xml, application/xml, text/xml, */*;q=0.8',
};

/** Search parameters shared by every query-building function. */
export interface ProviderSearchParams {
  query: string;
  season?: number | null;
  part?: number | null;
  episode?: number | null;
}

/**
 * Punctuation that release names use as separators (`:` in "Cyberpunk:
 * Edgerunners", `-` in "Re:Zero - Starting Life", underscores, brackets, …).
 * Sending these raw to an indexer's `q=` param degrades matching, so
 * sanitizeSearchQuery swaps them for spaces.
 */
const QUERY_PUNCTUATION_RE = /[:/\\!?()[\]{}<>"'`,;._\-–—*|&+]/g;

/**
 * Normalize a raw search string into an indexer-friendly query: punctuation is
 * replaced with spaces, whitespace collapsed, result trimmed. Word characters
 * (including unicode titles like 鬼滅の刃) survive untouched. A punctuation-only
 * input sanitizes to ''.
 */
export function sanitizeSearchQuery(raw: string): string {
  const text = typeof raw === 'string' ? raw : '';
  return text.replace(QUERY_PUNCTUATION_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** A BitTorrent info hash is 40 hex chars (v1) or 32 base32 chars (v2). */
const INFO_HASH_RE = /^(?:[0-9a-f]{40}|[a-z2-7]{32})$/;

/** True when the (already lowercased) string is a valid 40-hex or 32-base32 hash. */
function isValidInfoHash(candidate: string): boolean {
  return INFO_HASH_RE.test(candidate);
}

function toInfoHashOrNull(value: unknown): string | null {
  const candidate = (typeof value === 'string' ? value : '').trim().toLowerCase();
  return isValidInfoHash(candidate) ? candidate : null;
}

/**
 * Extract the BitTorrent info hash from a magnet URI:
 * `magnet:?xt=urn:btih:<40-hex or 32-base32>` → lowercase hash, else null.
 * Non-magnet URLs (e.g. .torrent links) always yield null.
 */
export function extractInfoHash(url: string): string | null {
  const text = typeof url === 'string' ? url : '';
  if (!/^magnet:/i.test(text)) return null;
  const match = /xt=urn:btih:([0-9a-z]+)/i.exec(text);
  return match ? toInfoHashOrNull(match[1]) : null;
}

/**
 * Fetch implementation used for indexer feeds. Prefers Electron's `net.fetch`
 * (bound to `net` so requests ride the Electron session: system proxy and
 * VPN-aware) and falls back to `globalThis.fetch` under plain Node (unit
 * tests) or when Electron is unavailable. The dynamic import of the electron
 * module is cached module-level; globalThis.fetch is deliberately resolved at
 * call time so test/overrides of the global keep working.
 */
type FetchImpl = typeof fetch;
let cachedElectronNetFetch: FetchImpl | null | undefined;

async function resolveFetch(): Promise<FetchImpl> {
  if (cachedElectronNetFetch === undefined) {
    cachedElectronNetFetch = null;
    try {
      const electronModule = (await import('electron')) as unknown as { net?: { fetch?: unknown } };
      const net = electronModule?.net;
      if (net && typeof net.fetch === 'function') {
        cachedElectronNetFetch = (net.fetch as FetchImpl).bind(net);
      }
    } catch {
      // Plain Node (offline unit tests) — keep the global fallback.
    }
  }
  return cachedElectronNetFetch ?? globalThis.fetch;
}

/**
 * Substitute `{query}` (sanitized via sanitizeSearchQuery — release-title
 * punctuation like the `:` in "Frieren: Beyond" must not hit the wire raw —
 * then URL-encoded), `{season}` and `{episode}` placeholders into a
 * user-supplied URL template. Season/episode placeholders are only replaced
 * when a value is provided; otherwise they are left untouched. Returns null
 * when the template is not http(s) or has no `{query}` slot.
 */
export function buildQueryUrl(template: string, params: ProviderSearchParams): string | null {
  let trimmed = typeof template === 'string' ? template.trim() : '';
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (!trimmed.includes('{query}')) return null;
  // If the template is missing a slash between host and query placeholder (e.g. "http://rutor.info{query}"),
  // insert a slash so it forms a valid URL instead of corrupting the hostname.
  if (/^https?:\/\/[^/{]+\{query\}/i.test(trimmed)) {
    trimmed = trimmed.replace(/^https?:\/\/[^/{]+/i, '$&/');
  }
  const query = sanitizeSearchQuery(typeof params?.query === 'string' ? params.query : '');
  let url = trimmed.replace('{query}', encodeURIComponent(query));
  if (params?.season !== null && params?.season !== undefined) {
    url = url.replace('{season}', String(params.season));
  }
  if (params?.episode !== null && params?.episode !== undefined) {
    url = url.replace('{episode}', String(params.episode));
  }
  return url;
}

/** Human-readable, non-ok HTTP detail (Cloudflare hint for 403/503). */
function describeHttpError(status: number): string {
  if (status === 403 || status === 503) return `HTTP ${status} (possibly Cloudflare or bot protection)`;
  return `HTTP ${status}`;
}

/** Human-readable detail for a thrown fetch attempt (timeout vs network). */
function describeFetchError(error: unknown): string {
  const name = typeof error === 'object' && error !== null ? String((error as { name?: unknown }).name ?? '') : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError' || name === 'AbortError' || /abort/i.test(message)) {
    return `request timed out after ${FETCH_TIMEOUT_MS}ms`;
  }
  return message || 'request failed';
}

/**
 * Fetch one provider's feed for the given search and normalize up to
 * MAX_ITEMS_PER_PROVIDER items. Throws on invalid templates, non-OK HTTP,
 * timeouts, and malformed XML — searchProviders catches per provider and
 * turns every failure into a ProviderReport.
 */
export async function fetchProviderFeed(provider: RssProvider, params: ProviderSearchParams): Promise<ReleaseSearchResult[]> {
  const url = buildQueryUrl(provider?.urlTemplate ?? '', params ?? { query: '' });
  if (!url) throw new Error(`provider "${provider?.name ?? 'unknown'}" has an invalid URL template`);
  const providerName = provider?.name ?? 'unknown';
  console.log(`[Indexers] GET ${url} (provider "${providerName}")`);
  const fetchImpl = await resolveFetch();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: REQUEST_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`provider "${providerName}" ${describeFetchError(error)}`);
  }
  if (!response.ok) {
    throw new Error(`provider "${providerName}" returned ${describeHttpError(response.status)}`);
  }
  const body = await response.text();
  const items = parseFeedItems(body);
  const normalized: ReleaseSearchResult[] = [];
  for (const item of items.slice(0, MAX_ITEMS_PER_PROVIDER)) {
    const result = normalizeFeedItem(item, provider);
    if (result) normalized.push(result);
  }
  console.log(
    `[Indexers] <- HTTP ${response.status}, items: ${items.length}, parsed: ${normalized.length}, provider "${providerName}"`
  );
  return normalized;
}

/**
 * Query every enabled provider in parallel (allSettled), merge the feeds and
 * dedupe by info hash (extractInfoHash of the downloadUrl) with a fallback to
 * normalized title + sizeBytes for magnet-less results. Every attempted
 * provider yields a ProviderReport — {ok: true, itemCount} or {ok: false,
 * error with the HTTP status / timeout detail} — so the UI can explain a
 * zero-result search instead of showing an opaque empty list. Results are
 * returned unranked — call rankReleasesForEpisode for ordering.
 */
export async function searchProviders(
  providers: RssProvider[],
  params: ProviderSearchParams
): Promise<{ results: ReleaseSearchResult[]; reports: ProviderReport[] }> {
  if (!Array.isArray(providers)) return { results: [], reports: [] };
  const enabled = providers.filter((p) => !!p && p.enabled === true && typeof p.urlTemplate === 'string');
  const settled = await Promise.allSettled(enabled.map((p) => fetchProviderFeed(p, params)));
  const merged: ReleaseSearchResult[] = [];
  const reports: ProviderReport[] = [];
  const seen = new Set<string>();
  settled.forEach((outcome, index) => {
    const provider = enabled[index];
    const providerId = provider?.id ?? `provider-${index + 1}`;
    const providerName = provider?.name ?? 'unknown';
    if (outcome.status === 'rejected') {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      console.warn(`[Indexers] provider "${providerName}" failed: ${reason}`);
      reports.push({ providerId, providerName, ok: false, itemCount: 0, error: reason });
      return;
    }
    for (const result of outcome.value) {
      const key = result.infoHash ?? extractInfoHash(result.downloadUrl) ?? dedupeKey(result);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(result);
    }
    reports.push({ providerId, providerName, ok: true, itemCount: outcome.value.length });
  });
  return { results: merged, reports };
}

/** Titles signaling a multi-episode batch / season-pack release. */
const BATCH_TITLE_RE = /batch|season\s*(pack|1[- ]?\d+)|complete/i;

/**
 * Rank releases best-first for a specific episode. Scoring uses the shared
 * release-name parser on each result title:
 * - (a) title: normalized equality +60, containment +40, else token-overlap
 *   (Jaccard over 3+ char tokens) ratio x30;
 * - (b) season: known on both sides → equal +15, mismatch -40;
 * - (c) episode: parsed numbers include the reference → +25, mismatch -15;
 * - (d) season-download bonus: when ref.episode is null, titles matching
 *   /batch|season pack|complete/ or multi-episode parses get +20 so batches
 *   float up for whole-season downloads.
 * Results first sort by explicit audio/subtitle confidence. Inside each group,
 * relevance is scored first and ties break by seeders desc, then input order.
 * The input
 * array is NEVER filtered or mutated — every input element is returned, just
 * reordered; a new array is returned. Language priority still applies when
 * the anime title is empty.
 */
export function rankReleasesForEpisode(
  results: ReleaseSearchResult[],
  ref: { animeTitle: string; season?: number | null; part?: number | null; episode?: number | null }
): ReleaseSearchResult[] {
  if (!Array.isArray(results)) return [];
  const refNorm = normalizeMatch(typeof ref?.animeTitle === 'string' ? ref.animeTitle : '');
  const isSeasonSearch = ref?.episode === null || ref?.episode === undefined;
  const scored = results.map((result) => {
    const classification = classifyRelease(result.title, result.description);
    const isBatch = ['season-pack', 'episode-range'].includes(classification.kind);
    return {
      result,
      relevance: computeTitleRelevance(result.title, [typeof ref?.animeTitle === 'string' ? ref.animeTitle : '']),
      rank: classification.rank,
      score: scoreRelease(result, ref, refNorm),
      quality: qualityRank(result),
      isBatch,
    };
  });

  scored.sort((a, b) => {
    // 1. Title relevance: exact / prefix match outranks related / none
    const relDiff = TITLE_RELEVANCE_RANK[b.relevance] - TITLE_RELEVANCE_RANK[a.relevance];
    if (relDiff !== 0) return relDiff;

    // 2. Whole-season downloads: batches/season-packs must strictly outrank single individual episodes
    if (isSeasonSearch && a.isBatch !== b.isBatch) {
      return a.isBatch ? -1 : 1;
    }

    // 3. Substantial score differences (e.g. wrong season penalty or major mismatch >= 30 points)
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) >= 30) return scoreDiff;

    // 4. Language classification rank (Dub+Subs -> Dub -> Japanese -> Other -> Unknown)
    if (a.rank !== b.rank) return a.rank - b.rank;

    // 5. Remaining score difference (bonus points, seeds, etc.)
    if (scoreDiff !== 0) return scoreDiff;

    // 6. Quality rank (2160p -> 1080p -> 720p)
    if (b.quality !== a.quality) return b.quality - a.quality;

    // 7. Seeders
    return (b.result.seeders ?? -1) - (a.result.seeders ?? -1);
  });

  return scored.map((entry) => entry.result);
}

/** Reject a release from a single-episode search when its title clearly names another episode. */
export function isExplicitEpisodeMismatch(result: ReleaseSearchResult, episode: number): boolean {
  if (!Number.isFinite(episode) || episode <= 0) return false
  const title = typeof result?.title === 'string' ? result.title : ''
  const hasExplicitEpisode =
    /\bS\d{1,2}E\d{1,4}(?:\.5)?\b/i.test(title) ||
    /\b\d{1,2}x\d{1,4}(?:\.5)?\b/i.test(title) ||
    /\b(?:EP|Episode|E)[ ._-]*0*\d{1,4}(?:\.5)?\b/i.test(title) ||
    /\s-\s0*\d{1,4}(?:\.5)?(?:\s*[-–~]\s*0*\d{1,4})?(?=\s|[([{]|$)/i.test(title)
  if (!hasExplicitEpisode) return false
  const parsed = parseReleaseSync(title)
  const numbers = parsed.episodeNumbers || []
  const containsEpisode = numbers.includes(episode) || (
    typeof parsed.episodeNumber === 'number' && typeof parsed.episodeEnd === 'number' &&
    episode >= parsed.episodeNumber && episode <= parsed.episodeEnd
  )
  return numbers.length > 0 && !containsEpisode
}

/** Reject a release when its title explicitly names a different season than requested. */
export function isExplicitSeasonMismatch(result: ReleaseSearchResult, requestedSeason: number | null | undefined): boolean {
  if (!Number.isInteger(requestedSeason) || Number(requestedSeason) <= 0) return false;
  const title = typeof result?.title === 'string' ? result.title : '';
  const parsed = parseReleaseSync(title);
  const relSeason = parsed.season ?? rawTitleSeason(title);
  return relSeason != null && relSeason !== Number(requestedSeason);
}

/** Returns the explicit cour/part marker in a title, if present. */
export function explicitReleasePart(title: string): number | null {
  const match = /\b(?:part|cour)\s*0*(\d{1,2})\b/i.exec(typeof title === 'string' ? title : '');
  const part = Number(match?.[1]);
  return Number.isInteger(part) && part > 0 ? part : null;
}

/** A title that explicitly advertises a different cour/part cannot match. */
export function isExplicitPartMismatch(result: ReleaseSearchResult, part: number | null | undefined): boolean {
  if (!Number.isInteger(part) || Number(part) <= 0) return false;
  const explicitPart = explicitReleasePart(result?.title || '');
  return explicitPart != null && explicitPart !== Number(part);
}

/** Resolution tie-breaker used after title/episode accuracy and language certainty. */
function qualityRank(result: ReleaseSearchResult): number {
  const parsed = parseReleaseSync(result.title)
  const resolution = (parsed.resolution || result.title).toLowerCase()
  if (/\b(?:4320p|8k)\b/.test(resolution)) return 5
  if (/\b(?:2160p|4k|uhd)\b/.test(resolution)) return 4
  if (/\b(?:1440p|2k)\b/.test(resolution)) return 3
  if (/\b1080p\b/.test(resolution)) return 2
  if (/\b720p\b/.test(resolution)) return 1
  return 0
}

/**
 * Flag implausibly small episode releases before automatic selection. The
 * expected size is duration × codec density: H.264 ≈ 4 MB/min, HEVC/AV1 ≈
 * 2.5 MB/min (Judas/PSA-style encodes on dialogue-heavy episodes land at
 * 60-90 MB for 24 minutes and are legitimate). Short-form shows (3-12 min)
 * are never blocked by an absolute floor when the runtime is known; the 80 MB
 * floor only applies when the duration is unknown. Multi-episode packs must
 * clear the floor for every episode they list. Manual selection remains
 * available so short-form titles and unusually compressed encodes are never
 * silently removed from the user's options.
 */
export function getEpisodeReleaseSizeWarning(
  sizeBytes: number | null,
  durationMinutes: number | null | undefined,
  title?: string,
): string | null {
  if (sizeBytes == null || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return 'The indexer did not report this release size. Automatic episode selection skipped it; review it manually.'
  }
  const rawTitle = typeof title === 'string' ? title : '';
  // HEVC/AV1 encodes run ~2.5 MB/min at 1080p on dialogue-heavy episodes.
  const perMinuteMb = /x26[5]|h\.?265|hevc|\bav1\b/i.test(rawTitle) ? 2.5 : 4;
  const duration = typeof durationMinutes === 'number' && Number.isFinite(durationMinutes) && durationMinutes > 0
    ? durationMinutes
    : null;
  const durationKnown = duration != null;
  let expectedMb = duration != null ? duration * perMinuteMb : 80;
  // A multi-episode pack must clear the floor for every episode it lists
  // (per-episode lists only; a range like "Eps 1-193" gives two endpoints, so
  // it is not multiplied — such packs are large anyway).
  const listedEpisodes = rawTitle ? parseReleaseSync(rawTitle).episodeNumbers.length : 0;
  if (duration != null && listedEpisodes > 2) expectedMb *= Math.min(listedEpisodes, 200);
  const minimumBytes = Math.max(expectedMb, 8) * 1024 ** 2;
  if (sizeBytes >= minimumBytes) return null
  return `This release is unusually small for the episode(s) it claims (under ${Math.ceil(minimumBytes / 1024 ** 2)} MiB). Review it before downloading.`
}

/**
 * Import a providers config exported by exportProvidersConfig (or any
 * tolerant subset): `{providers: [...]}` wrapper or a bare array. Each entry
 * is shape-validated; invalid ones are dropped (counted and warned). ids are
 * generated when missing; type defaults to 'rss'; enabled defaults to true.
 * At most MAX_PROVIDERS entries are kept. Returns null when the input is
 * garbage or nothing valid survived.
 */
export function importProvidersConfig(json: string): RssProvider[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const list = record && Array.isArray(record.providers) ? record.providers : Array.isArray(parsed) ? parsed : null;
  if (!list) return null;
  const imported: RssProvider[] = [];
  let dropped = 0;
  for (let index = 0; index < list.length; index++) {
    const provider = sanitizeProvider(list[index], index);
    if (provider && imported.length < MAX_PROVIDERS) {
      imported.push(provider);
    } else if (!provider) {
      dropped++;
    }
  }
  if (imported.length === 0) return null;
  if (dropped > 0) console.warn(`[indexers] import dropped ${dropped} invalid provider entr${dropped === 1 ? 'y' : 'ies'}`);
  return imported;
}

/** Pretty-print providers together with a format/version envelope. */
export function exportProvidersConfig(providers: RssProvider[]): string {
  return JSON.stringify({ format: 'animecenter-providers', version: 1, providers }, null, 2);
}

/**
 * Validate a raw config entry into an RssProvider. Requires a non-empty name
 * and an http(s) urlTemplate containing `{query}`; generates `provider-<n>`
 * ids, defaults type to 'rss' and enabled to true.
 */
function sanitizeProvider(entry: unknown, index: number): RssProvider | null {
  const record = asRecord(entry);
  if (!record) return null;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const urlTemplate = typeof record.urlTemplate === 'string' ? record.urlTemplate.trim() : '';
  if (!name) return null;
  if (!/^https?:\/\//i.test(urlTemplate) || !urlTemplate.includes('{query}')) return null;
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `provider-${index + 1}`;
  const type = record.type === 'torznab' ? 'torznab' : 'rss';
  const enabled = typeof record.enabled === 'boolean' ? record.enabled : true;
  return { id, name, urlTemplate, type, enabled };
}

/**
 * Validate + parse an RSS/Torznab document into raw item records. Throws on
 * XML that fails validation (fast-xml-parser itself is lenient and would
 * silently return partial data) or on documents without a recognizable
 * channel structure. A well-formed feed with zero items yields []. Namespaced
 * elements (nyaa:*, torznab:*) are kept verbatim as colon-prefixed keys —
 * fast-xml-parser does not strip prefixes by default.
 */
function parseFeedItems(xmlText: string): Record<string, unknown>[] {
  const validated = XMLValidator.validate(xmlText);
  if (validated !== true) {
    const detail = validated.err ? `${validated.err.code}: ${validated.err.msg}` : 'invalid XML';
    throw new Error(`feed XML is malformed (${detail})`);
  }
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(xmlText);
  const root = asRecord(parsed);
  if (!root) throw new Error('feed did not parse to an XML document');
  const rss = asRecord(root.rss);
  const channelRaw = rss ? rss.channel : root.channel;
  if (!channelRaw) throw new Error('feed has no <channel>');
  // channel/item may appear once or many times depending on the feed — normalize.
  const items: Record<string, unknown>[] = [];
  for (const channel of asArray(channelRaw)) {
    const record = asRecord(channel);
    if (!record) continue;
    for (const item of asArray(record.item)) {
      const itemRecord = asRecord(item);
      if (itemRecord) items.push(itemRecord);
    }
  }
  return items;
}

/**
 * Normalize one raw feed item into a ReleaseSearchResult, or null when the
 * item has no usable download source (skipped — the raw-vs-parsed feed log
 * counts it). downloadUrl resolution order:
 *   (a) direct .torrent enclosure/link → used as-is, preserving the tracker
 *       announce list embedded in the torrent file;
 *   (b) magnet: link/enclosure → passed through untouched;
 *   (c) nyaa:infoHash present without a .torrent URL → tracker-less magnet;
 *   (d) other http(s) link/enclosure → used as-is.
 * sizeBytes prefers the Torznab size attr, then nyaa:size ("1.4 GiB" →
 * bytes), then enclosure length/size. seeders/leechers come from Torznab
 * attrs with nyaa:* elements as fallback (null when absent). pubDate becomes
 * unix ms, null when unparseable.
 */
function normalizeFeedItem(item: Record<string, unknown>, provider: RssProvider): ReleaseSearchResult | null {
  const attrs = collectTorznabAttrs(item);
  const enclosure = asRecord(item.enclosure);
  const enclosureUrl = enclosure ? readXmlAttribute(enclosure, '@_url').trim() : '';
  const enclosureType = enclosure ? readXmlAttribute(enclosure, '@_type').trim().toLowerCase() : '';
  const link = readXmlText(item.link).trim();
  const title = readXmlText(item.title).trim();
  const description = (readXmlText(item.description) || readXmlText(item['content:encoded'])).slice(0, 20_000) || null;

  const nyaaInfoHash = toInfoHashOrNull(item['nyaa:infoHash']);
  const detailsUrl = extractDetailsUrl(item, link, nyaaInfoHash !== null);
  let downloadUrl: string | null = null;
  const isTorrentFileUrl = (value: string) => {
    if (!/^https?:\/\//i.test(value)) return false;
    try { return /\.torrent$/i.test(new URL(value).pathname); } catch { return false; }
  };
  const torrentEnclosure = /^https?:\/\//i.test(enclosureUrl) && (
    isTorrentFileUrl(enclosureUrl) || /bittorrent|x-torrent/i.test(enclosureType)
  );
  if (torrentEnclosure) {
    downloadUrl = enclosureUrl;
  } else if (isTorrentFileUrl(link)) {
    downloadUrl = link;
  } else if (enclosureUrl.toLowerCase().startsWith('magnet:') || link.toLowerCase().startsWith('magnet:')) {
    downloadUrl = enclosureUrl.toLowerCase().startsWith('magnet:') ? enclosureUrl : link;
  } else if (nyaaInfoHash) {
    downloadUrl = `magnet:?xt=urn:btih:${nyaaInfoHash}&dn=${encodeURIComponent(title)}`;
  } else if (/^https?:\/\//i.test(enclosureUrl)) {
    downloadUrl = enclosureUrl;
  } else if (/^https?:\/\//i.test(link)) {
    downloadUrl = link;
  }
  if (!downloadUrl) return null;

  const torznabSize = toIntOrNull(attrs.size);
  const nyaaSizeBytes = parseHumanSize(readXmlText(item['nyaa:size']).trim());
  const enclosureLength = enclosure ? toIntOrNull(readXmlAttribute(enclosure, '@_length')) : null;
  const enclosureSize = enclosure ? toIntOrNull(readXmlAttribute(enclosure, '@_size')) : null;
  const pubDateMs = Date.parse(readXmlText(item.pubDate).trim());
  return {
    providerId: provider.id,
    providerName: provider.name,
    title,
    downloadUrl,
    ...(nyaaInfoHash ? { infoHash: nyaaInfoHash } : {}),
    description,
    detailsUrl,
    sizeBytes: torznabSize ?? nyaaSizeBytes ?? enclosureLength ?? enclosureSize,
    seeders: toIntOrNull(attrs.seeders) ?? toIntOrNull(item['nyaa:seeders']),
    leechers: toIntOrNull(attrs.leechers) ?? toIntOrNull(item['nyaa:leechers']),
    pubDate: Number.isNaN(pubDateMs) ? null : pubDateMs,
  };
}

/** Find a human-readable release page without mistaking a .torrent URL for it. */
function extractDetailsUrl(item: Record<string, unknown>, link: string, hasNyaaHash: boolean): string | null {
  const guidNode = item.guid;
  const guidRecord = asRecord(guidNode);
  const guidIsPermalink = !guidRecord || String(guidRecord['@_isPermaLink'] ?? 'true').toLowerCase() !== 'false';
  const candidates = [
    ...(guidIsPermalink ? [readXmlText(guidNode).trim()] : []),
    ...(hasNyaaHash ? [link] : []),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      if (/\.(?:torrent|nzb)(?:$|[?#])/i.test(parsed.href)) continue;
      return parsed.toString();
    } catch {
      // Non-URL GUIDs are normal in RSS and are not release-page links.
    }
  }
  return null;
}

/**
 * Fetch one release detail page only after the user requests it. Requests are
 * restricted to the configured provider's origin and redirects cannot leave
 * that origin, preventing feed-supplied URLs from becoming arbitrary IPC fetches.
 */
export async function fetchReleaseDescription(
  providerId: string,
  rawUrl: string,
  providers: RssProvider[],
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string> {
  const provider = providers.find((entry) => entry.id === providerId && entry.enabled);
  if (!provider) throw new Error('Release source is no longer enabled.');
  let configuredOrigin: string;
  try {
    configuredOrigin = new URL(provider.urlTemplate.replace('{query}', 'query')).origin;
  } catch {
    throw new Error('Release source has an invalid URL.');
  }
  const assertAllowedUrl = (value: string): URL => {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error('Invalid release page URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== configuredOrigin) {
      throw new Error('Release page is outside the configured source.');
    }
    return parsed;
  };
  let pageUrl = assertAllowedUrl(rawUrl);
  const fetchImpl = await resolveFetch();
  let response: Response | null = null;
  for (let hop = 0; hop <= MAX_RELEASE_PAGE_REDIRECTS; hop++) {
    response = await fetchImpl(pageUrl.toString(), {
      headers: { ...REQUEST_HEADERS, Accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(Math.max(1_000, Math.min(FETCH_TIMEOUT_MS, timeoutMs))),
      redirect: 'manual',
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || hop === MAX_RELEASE_PAGE_REDIRECTS) throw new Error('Release page redirected too many times.');
    pageUrl = assertAllowedUrl(new URL(location, pageUrl).toString());
  }
  if (!response?.ok) throw new Error(`Release page returned HTTP ${response?.status ?? 'unknown'}.`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !/(?:html|xml|text|json)/i.test(contentType)) throw new Error('Release source did not return a text description.');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RELEASE_PAGE_BYTES) throw new Error('Release page is too large to inspect.');
  if (!response.body) return (await response.text()).slice(0, MAX_RELEASE_PAGE_BYTES);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_RELEASE_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = value.subarray(0, MAX_RELEASE_PAGE_BYTES - total);
    chunks.push(chunk);
    total += chunk.length;
    if (chunk.length < value.length) break;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

/**
 * Inspect detail pages for the best-matching search results before ranking and
 * automatic selection. RSS feeds often omit language tracks, so relying on
 * them alone can silently choose a release without English subtitles.
 */
export async function inspectReleaseResults(
  results: ReleaseSearchResult[],
  providers: RssProvider[],
  limit = 20,
): Promise<ReleaseSearchResult[]> {
  const output = [...results];
  const candidates = output
    .map((result, index) => ({ result, index, classification: classifyRelease(result.title, result.description) }))
    .filter(({ result, classification }) => !!result.detailsUrl && !(classification.languageGroup === 'eng-dub-dubtitles' || classification.languageGroup === 'eng-dub-subs'))
    .slice(0, Math.max(0, Math.min(40, Math.floor(limit))));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      try {
        const raw = await fetchReleaseDescription(candidate.result.providerId, candidate.result.detailsUrl!, providers, 5_500);
        const text = releaseDescriptionToText(raw);
        if (text) output[candidate.index] = { ...candidate.result, description: [candidate.result.description || '', text].filter(Boolean).join('\n').slice(0, 40_000) };
      } catch (error) {
        console.info(`[Indexers] Could not inspect release description (${candidate.result.providerName}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  await Promise.all(workers);
  return output;
}

/**
 * Collect Torznab per-item attributes (`<attr name="x" value="y"/>`), also
 * matching namespaced spellings such as `<torznab:attr .../>`. Keys may hold
 * a single object or an array; returns a name→value map.
 */
function collectTorznabAttrs(item: Record<string, unknown>): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key !== 'attr' && !key.endsWith(':attr')) continue;
    for (const entry of asArray(value)) {
      const record = asRecord(entry);
      if (!record) continue;
      const name = readXmlAttribute(record, '@_name');
      if (name) attrs[name] = readXmlAttribute(record, '@_value');
    }
  }
  return attrs;
}

/** Season number from markers the shared parser may leave on the floor: a
 *  bare "S2" in "[Group] Show S2 - 05" is stripped from animeTitle without
 *  populating parsed.season, but it must still count for season scoring. */
function rawTitleSeason(title: string): number | null {
  const patterns = [/\bS(\d{1,2})(?:E\d{1,4})?\b/i, /\bSeason\s*0*(\d{1,2})\b/i, /\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i];
  for (const pattern of patterns) {
    const match = pattern.exec(title);
    const n = Number(match?.[1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** Score one result against the episode reference (see rankReleasesForEpisode). */
function scoreRelease(
  result: ReleaseSearchResult,
  ref: { season?: number | null; part?: number | null; episode?: number | null },
  refNorm: string
): number {
  const parsed = parseReleaseSync(result.title);
  let score = 0;
  let parsedNorm = releaseShowName(result.title) || normalizeMatch(parsed.animeTitle ?? '');
  if (refNorm) {
    const parenMatches = result.title.matchAll(/\(([^)]+)\)|\[([^\]]+)\]/g);
    for (const m of parenMatches) {
      const inside = m[1] || m[2];
      if (inside) {
        for (const part of inside.split(/[,;/]+/)) {
          const rawPart = normalizeMatch(part);
          const strippedPart = stripTrailingDecorations(rawPart);
          if (rawPart === refNorm || strippedPart === refNorm) {
            parsedNorm = refNorm;
            break;
          }
        }
      }
    }
  }
  if (refNorm && parsedNorm) {
    if (parsedNorm === refNorm) {
      score += 60;
    } else if (titleRelevanceOf(parsedNorm, refNorm) === 'prefix') {
      // Same show with decorations ("Monster S2", "The Apothecary Diaries").
      score += 40;
    } else if (titleRelevanceOf(parsedNorm, refNorm) === 'related') {
      // Whole-word mention inside the title, not name-aligned.
      score += 25;
    } else {
      // No whole-word hit at all — a different show ("Pocket Monsters" for a
      // "Monster" search). Substring-inside-word matches score nothing.
      score += tokenOverlap(refNorm, parsedNorm) * 30;
    }
  }
  const season = parsed.season ?? rawTitleSeason(result.title);
  if (ref?.season !== null && ref?.season !== undefined && season !== null) {
    score += season === ref.season ? 15 : -40;
  }
  if (ref?.part != null) {
    const part = explicitReleasePart(result.title);
    if (part != null) score += part === ref.part ? 24 : -100;
    else score -= 8; // ambiguous full-season names stay available below exact cour matches
  }
  if (ref?.episode !== null && ref?.episode !== undefined && parsed.episodeNumbers.length > 0) {
    const isBatchTitle = BATCH_TITLE_RE.test(result.title);
    const matchesEpisode = parsed.episodeNumbers.includes(ref.episode) || (
      typeof parsed.episodeNumber === 'number' && typeof parsed.episodeEnd === 'number' &&
      ref.episode >= parsed.episodeNumber && ref.episode <= parsed.episodeEnd
    )
    if (isBatchTitle && !matchesEpisode) {
      // Batch titles carry volume/count hints, not episode listings — a batch
      // may still contain the episode, so never sink it for the numbers in
      // its title.
    } else {
      score += matchesEpisode ? 25 : -15;
    }
  }
  // A seasonless release for a season>1 request is season-ambiguous: the
  // episode number may belong to an earlier season. Marker-bearing releases
  // must win; when only ambiguous ones exist they stay available (relative
  // order among them is unchanged by a uniform penalty).
  if (ref?.season != null && ref.season > 1 && season == null) {
    score -= 10;
  }
  // Season-download helper: with no specific episode requested, batch /
  // season-pack / complete releases (or multi-episode parses) float up so
  // whole-season downloads surface before single episodes.
  if (ref?.episode === null || ref?.episode === undefined) {
    if (BATCH_TITLE_RE.test(result.title) || parsed.episodeNumbers.length > 1) score += 20;
  }
  return score;
}

/** Lowercase, strip non-alphanumeric characters, collapse to single spaces. */
function normalizeMatch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Title relevance of a release against the reference title(s), best across
 *  title + aliases. Whole-word only: a substring inside a longer word does
 *  not count, so "Monster" does not match "Pocket Monsters" (∋ "monster"
 *  inside "monsters"). 'prefix' — one normalized title starts with the other
 *  at a word boundary (release decorations follow the show name); 'related' —
 *  whole-word containment somewhere; 'none' — no whole-word hit. */
export type TitleRelevance = 'exact' | 'prefix' | 'related' | 'none';

const isAlnumChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
const wordBoundaryAfter = (haystack: string, end: number) => !isAlnumChar(haystack[end]);

function containsWholeWord(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if ((at === 0 || !isAlnumChar(haystack[at - 1])) && wordBoundaryAfter(haystack, at + needle.length)) return true;
    from = at + 1;
  }
}

const TITLE_RELEVANCE_RANK: Record<TitleRelevance, number> = { exact: 3, prefix: 2, related: 1, none: 0 };

/** Release-kind decorations ("Season Pack", "Batch", "Complete", bare season
 *  numbers) are stripped from the tail of a parsed show name before title
 *  matching — they describe the RELEASE, not the show, so "[Group] Show
 *  Season Pack" must title-match exactly like "[Group] Show - 05". */
const DECORATION_TOKEN_RE = /^(?:batch|complete|pack|season|part|(?:19|20)\d{2}|\d{1,4})$/i;

function stripTrailingDecorations(normalized: string): string {
  const tokens = normalized.split(' ').filter(Boolean);
  while (tokens.length > 0 && DECORATION_TOKEN_RE.test(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ').trim();
}

/** The show name a release title advertises: parser-extracted animeTitle with
 *  trailing release-kind decorations removed. */
function releaseShowName(resultTitle: string): string {
  const raw = typeof resultTitle === 'string' ? resultTitle : '';
  const parsed = parseReleaseSync(raw);
  return stripTrailingDecorations(normalizeMatch(parsed.animeTitle ?? ''));
}

/** The tail a release appends to the show name must be season/part/year/batch
 *  shaped — free-form words ("Monster Hunter", "Monster Musume") make it a
 *  different show, which must never count as a title prefix match. */
const SEASONISH_TOKEN_RE = /^(?:s\d{1,3}|season|part|cour|final|batch|complete|pack|(?:19|20)\d{2}|\d{1,4})$/i;
const ORDINAL_TOKEN_RE = /^\d{1,4}(?:st|nd|rd|th)$/i;
const TECHNICAL_TOKEN_RE = /^(?:s\d{1,3}|season|part|cour|final|batch|complete|pack|(?:19|20)\d{2}|\d{1,4}|\d{3,4}p|nf|cr|amzn|at-?x|tv|web|dl|web-?dl|webrip|bluray|bdrip|hdtv|dvd|remux|hevc|avc|x264|x265|h264|h265|10bit|8bit|hdr|hdr10|hdr10plus|dv|dovi|ddp|ddp\d(?:\.\d)?|aac|flac|eac3|ac3|dts|truehd|atmos|dual|multi|audio|subs?|subtitles?|eng|dub|ita|ger|fra|spa|rus|jpn|raws?|repack\d?|v\d)$/i;

function seasonishTail(tail: string): boolean {
  const tokens = tail.split(/[\s,.:()[\]_-]+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token, index) =>
    SEASONISH_TOKEN_RE.test(token) ||
    ORDINAL_TOKEN_RE.test(token) ||
    TECHNICAL_TOKEN_RE.test(token) ||
    (index === tokens.length - 1 && /^[a-z0-9]{2,8}$/i.test(token) && /-[a-zA-Z0-9]{2,8}/.test(tail))
  );
}

function titleRelevanceOf(candidate: string, ref: string): TitleRelevance {
  if (!candidate || !ref) return 'none';
  if (candidate === ref) return 'exact';
  // The release extends the show name — only with season/part/year markers.
  // "Monster S2" is a prefix; "Monster Hunter" is another show.
  if (candidate.startsWith(ref) && wordBoundaryAfter(candidate, ref.length) && seasonishTail(candidate.slice(ref.length))) {
    return 'prefix';
  }
  // The release lacks a tail the reference carries (a season marker etc.) —
  // season-ambiguous, so never 'prefix' (a wrong-season pack must not pass).
  if (containsWholeWord(candidate, ref) || containsWholeWord(ref, candidate)) return 'related';
  return 'none';
}

function bestTitleRelevance(candidates: string[], refs: string[]): TitleRelevance {
  let best: TitleRelevance = 'none';
  for (const ref of refs) {
    const normRef = normalizeMatch(ref);
    if (!normRef) continue;
    for (const candidate of candidates) {
      const relevance = titleRelevanceOf(candidate, normRef);
      if (TITLE_RELEVANCE_RANK[relevance] > TITLE_RELEVANCE_RANK[best]) {
        best = relevance;
        if (best === 'exact') return best;
      }
    }
  }
  return best;
}

/** Whole-word title relevance of a raw release title against the searched
 *  title/aliases — attached to search results so automatic selection can
 *  refuse releases that name a different show. The parsed show name (group
 *  tag and episode markers stripped) is the primary candidate; the raw
 *  normalized title backs it up. */
export function computeTitleRelevance(resultTitle: string, refs: string[]): TitleRelevance {
  const raw = typeof resultTitle === 'string' ? resultTitle : '';
  const rawNormTitle = normalizeMatch(raw);
  const candidates: string[] = [
    releaseShowName(raw),
    stripTrailingDecorations(rawNormTitle),
    rawNormTitle,
  ];
  // Extract sub-phrases inside parentheses or brackets which frequently house the canonical or alternate title
  const parenMatches = raw.matchAll(/\(([^)]+)\)|\[([^\]]+)\]/g);
  for (const m of parenMatches) {
    const inside = m[1] || m[2];
    if (inside) {
      const parts = inside.split(/[,;/]+/);
      for (const part of parts) {
        const rawPart = normalizeMatch(part);
        const strippedPart = stripTrailingDecorations(rawPart);
        if (rawPart && rawPart.length >= 3) candidates.push(rawPart);
        if (strippedPart && strippedPart.length >= 3 && strippedPart !== rawPart) candidates.push(strippedPart);
      }
    }
  }
  return bestTitleRelevance(
    candidates.filter((candidate) => !!candidate),
    refs,
  );
}

/** Jaccard overlap of 3+ character tokens between two normalized strings (0..1). */
function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(a.split(' ').filter((token) => token.length >= 3));
  const tokensB = new Set(b.split(' ').filter((token) => token.length >= 3));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared++;
  }
  const union = tokensA.size + tokensB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Dedupe identity for magnet-less results: lowercased title + sizeBytes. */
function dedupeKey(result: ReleaseSearchResult): string {
  const title = result.title.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${title}|${result.sizeBytes ?? ''}`;
}

/**
 * Parse a human size string ("1.4 GiB", "890 MiB", "700 MiB-1.1 GiB" → first
 * chunk only) into bytes. KiB/MiB/GiB/TiB use binary multipliers; the sloppy
 * KB/MB/GB/TB spellings indexer feeds sometimes emit are treated the same
 * way. Returns null when absent or unparseable.
 */
const HUMAN_SIZE_RE = /^\s*([\d.]+)\s*(b|kb|mb|gb|tb|kib|mib|gib|tib)\s*$/i;
const HUMAN_SIZE_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
};

function parseHumanSize(text: string): number | null {
  const match = HUMAN_SIZE_RE.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = match[2].toLowerCase().replace('ib', 'b');
  return Math.round(value * HUMAN_SIZE_MULTIPLIERS[unit]);
}

/** Narrow unknown → plain object (not array, not null). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Normalize an XML node that may be a single object or an array into an array. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Read an element's text; falls back to `#text` when the node carries attributes. */
function readXmlText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const record = asRecord(value);
  if (record && typeof record['#text'] === 'string') return record['#text'];
  return '';
}

/** Read an attribute (prefixed per attributeNamePrefix) as text. */
function readXmlAttribute(record: Record<string, unknown>, attribute: string): string {
  const value = record[attribute];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Parse an integer, returning null for empty/NaN input. */
function toIntOrNull(value: unknown): number | null {
  const text = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
