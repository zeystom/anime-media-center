/**
 * BYOC indexer client (RSS 2.0 / Torznab / Nyaa-style) for the P2P search flow.
 *
 * LEGAL/CLEANLINESS NOTE: this module ships ZERO tracker or indexer URLs.
 * Every endpoint comes exclusively from user configuration
 * (RssProvider.urlTemplate). Nothing is hardcoded, defaulted, or suggested.
 *
 * Feed handling is deliberately tolerant:
 * - plain RSS 2.0 enclosures, Torznab's per-item `<attr name="..." value="..."/>`
 *   extras, and Nyaa-style namespaced extras (`<nyaa:infoHash>`, `<nyaa:seeders>`,
 *   `<nyaa:size>`, … — fast-xml-parser keeps them as literal keys with colons)
 *   are all normalized into ReleaseSearchResult;
 * - Nyaa-style feeds put a plain http(s) .torrent URL in `<link>` (NOT a magnet)
 *   and carry the swarm hash in `<nyaa:infoHash>`, so an item without a magnet:
 *   link must never be dropped — the hash is turned into a tracker-less magnet
 *   (DHT discovers peers) and .torrent URLs are passed through as-is;
 * - searchProviders fans out with allSettled and returns per-provider reports so
 *   a single broken indexer (HTTP 403 / Cloudflare, timeout, bad XML) never
 *   sinks the whole search and never fails silently.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { RssProvider, ReleaseSearchResult, ProviderReport } from './types.ts';
import { parseReleaseSync } from '../src/lib/releaseParser/index.ts';

/** Per-request timeout for indexer feeds. */
const FETCH_TIMEOUT_MS = 12_000;
/** Upper bound of normalized items kept per provider feed. */
const MAX_ITEMS_PER_PROVIDER = 50;
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
  const trimmed = typeof template === 'string' ? template.trim() : '';
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (!trimmed.includes('{query}')) return null;
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
      const key = extractInfoHash(result.downloadUrl) ?? dedupeKey(result);
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
 * - (d) seeders present +5;
 * - (e) season-download bonus: when ref.episode is null, titles matching
 *   /batch|season pack|complete/ or multi-episode parses get +20 so batches
 *   float up for whole-season downloads.
 * Ties break by seeders desc, then keep input order (stable sort). The input
 * array is NEVER filtered or mutated — every input element is returned, just
 * reordered; a new array is returned. When ref.animeTitle is empty the input
 * order is returned unchanged.
 */
export function rankReleasesForEpisode(
  results: ReleaseSearchResult[],
  ref: { animeTitle: string; season?: number | null; episode?: number | null }
): ReleaseSearchResult[] {
  if (!Array.isArray(results)) return [];
  const refNorm = normalizeMatch(typeof ref?.animeTitle === 'string' ? ref.animeTitle : '');
  if (!refNorm) return [...results];
  const scored = results.map((result) => ({ result, score: scoreRelease(result, ref, refNorm) }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.result.seeders ?? -1) - (a.result.seeders ?? -1)
  );
  return scored.map((entry) => entry.result);
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
 *   (a) nyaa:infoHash present → tracker-less magnet built from it (DHT
 *       discovers peers; no announce URLs are ever hardcoded);
 *   (b) magnet: link/enclosure → passed through untouched;
 *   (c) http(s) link/enclosure (.torrent file) → used as-is. Nyaa-style feeds
 *       put the .torrent URL in <link>, so a magnet-less item is kept.
 * sizeBytes prefers the Torznab size attr, then nyaa:size ("1.4 GiB" →
 * bytes), then enclosure length/size. seeders/leechers come from Torznab
 * attrs with nyaa:* elements as fallback (null when absent). pubDate becomes
 * unix ms, null when unparseable.
 */
function normalizeFeedItem(item: Record<string, unknown>, provider: RssProvider): ReleaseSearchResult | null {
  const attrs = collectTorznabAttrs(item);
  const enclosure = asRecord(item.enclosure);
  const enclosureUrl = enclosure ? readXmlAttribute(enclosure, '@_url').trim() : '';
  const link = readXmlText(item.link).trim();
  const title = readXmlText(item.title).trim();

  const nyaaInfoHash = toInfoHashOrNull(item['nyaa:infoHash']);
  let downloadUrl: string | null = null;
  if (nyaaInfoHash) {
    downloadUrl = `magnet:?xt=urn:btih:${nyaaInfoHash}&dn=${encodeURIComponent(title)}`;
  } else if (enclosureUrl.toLowerCase().startsWith('magnet:') || link.toLowerCase().startsWith('magnet:')) {
    downloadUrl = enclosureUrl.toLowerCase().startsWith('magnet:') ? enclosureUrl : link;
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
    sizeBytes: torznabSize ?? nyaaSizeBytes ?? enclosureLength ?? enclosureSize,
    seeders: toIntOrNull(attrs.seeders) ?? toIntOrNull(item['nyaa:seeders']),
    leechers: toIntOrNull(attrs.leechers) ?? toIntOrNull(item['nyaa:leechers']),
    pubDate: Number.isNaN(pubDateMs) ? null : pubDateMs,
  };
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

/** Score one result against the episode reference (see rankReleasesForEpisode). */
function scoreRelease(
  result: ReleaseSearchResult,
  ref: { season?: number | null; episode?: number | null },
  refNorm: string
): number {
  const parsed = parseReleaseSync(result.title);
  let score = 0;
  const parsedNorm = normalizeMatch(parsed.animeTitle ?? '');
  if (refNorm && parsedNorm) {
    if (parsedNorm === refNorm) {
      score += 60;
    } else if (parsedNorm.includes(refNorm) || refNorm.includes(parsedNorm)) {
      score += 40;
    } else {
      score += tokenOverlap(refNorm, parsedNorm) * 30;
    }
  }
  if (ref?.season !== null && ref?.season !== undefined && parsed.season !== null) {
    score += parsed.season === ref.season ? 15 : -40;
  }
  if (ref?.episode !== null && ref?.episode !== undefined && parsed.episodeNumbers.length > 0) {
    score += parsed.episodeNumbers.includes(ref.episode) ? 25 : -15;
  }
  if (result.seeders !== null && result.seeders !== undefined) score += 5;
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
