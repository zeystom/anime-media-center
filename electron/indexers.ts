/**
 * BYOC indexer client (RSS 2.0 / Torznab) for the P2P search flow.
 *
 * LEGAL/CLEANLINESS NOTE: this module ships ZERO tracker or indexer URLs.
 * Every endpoint comes exclusively from user configuration
 * (RssProvider.urlTemplate). Nothing is hardcoded, defaulted, or suggested.
 *
 * Feed handling is deliberately tolerant: both plain RSS 2.0 enclosures and
 * Torznab's per-item `<attr name="..." value="..."/>` extras are normalized
 * into ReleaseSearchResult, and searchProviders fans out with allSettled so a
 * single broken indexer never sinks the whole search.
 */

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { RssProvider, ReleaseSearchResult } from './types.ts';
import { parseReleaseSync } from '../src/lib/releaseParser/index.ts';

/** Per-request timeout for indexer feeds. */
const FETCH_TIMEOUT_MS = 12_000;
/** Upper bound of normalized items kept per provider feed. */
const MAX_ITEMS_PER_PROVIDER = 50;
/** Upper bound of providers accepted by importProvidersConfig. */
const MAX_PROVIDERS = 20;

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': 'AnimeMediaCenter/1.0',
  Accept: 'application/rss+xml, application/xml, text/xml',
};

/** Search parameters shared by every query-building function. */
export interface ProviderSearchParams {
  query: string;
  season?: number | null;
  episode?: number | null;
}

/**
 * Substitute `{query}` (URL-encoded), `{season}` and `{episode}` placeholders
 * into a user-supplied URL template. Season/episode placeholders are only
 * replaced when a value is provided; otherwise they are left untouched.
 * Returns null when the template is not http(s) or has no `{query}` slot.
 */
export function buildQueryUrl(template: string, params: ProviderSearchParams): string | null {
  const trimmed = typeof template === 'string' ? template.trim() : '';
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (!trimmed.includes('{query}')) return null;
  const query = typeof params?.query === 'string' ? params.query.trim() : '';
  let url = trimmed.replace('{query}', encodeURIComponent(query));
  if (params?.season !== null && params?.season !== undefined) {
    url = url.replace('{season}', String(params.season));
  }
  if (params?.episode !== null && params?.episode !== undefined) {
    url = url.replace('{episode}', String(params.episode));
  }
  return url;
}

/**
 * Fetch one provider's feed for the given search and normalize up to
 * MAX_ITEMS_PER_PROVIDER items. Throws on invalid templates, non-OK HTTP,
 * timeouts, and malformed XML — searchProviders catches per provider.
 */
export async function fetchProviderFeed(provider: RssProvider, params: ProviderSearchParams): Promise<ReleaseSearchResult[]> {
  const url = buildQueryUrl(provider?.urlTemplate ?? '', params ?? { query: '' });
  if (!url) throw new Error(`provider "${provider?.name ?? 'unknown'}" has an invalid URL template`);
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`provider "${provider.name}" returned HTTP ${response.status}`);
  const body = await response.text();
  const items = parseFeedItems(body);
  return items.slice(0, MAX_ITEMS_PER_PROVIDER).map((item) => normalizeFeedItem(item, provider));
}

/**
 * Query every enabled provider in parallel (allSettled), flatten fulfilled
 * feeds, warn on rejected ones, and dedupe by normalized title + sizeBytes.
 * Results are returned unranked — call rankReleasesForEpisode for ordering.
 */
export async function searchProviders(providers: RssProvider[], params: ProviderSearchParams): Promise<ReleaseSearchResult[]> {
  if (!Array.isArray(providers)) return [];
  const enabled = providers.filter((p) => !!p && p.enabled === true && typeof p.urlTemplate === 'string');
  const settled = await Promise.allSettled(enabled.map((p) => fetchProviderFeed(p, params)));
  const merged: ReleaseSearchResult[] = [];
  const seen = new Set<string>();
  settled.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      const provider = enabled[index];
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      console.warn(`[indexers] provider "${provider?.name ?? 'unknown'}" failed: ${reason}`);
      return;
    }
    for (const result of outcome.value) {
      const key = dedupeKey(result);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(result);
    }
  });
  return merged;
}

/**
 * Rank releases best-first for a specific episode. Scoring uses the shared
 * release-name parser on each result title:
 * - (a) title: normalized equality +60, containment +40, else token-overlap
 *   (Jaccard over 3+ char tokens) ratio x30;
 * - (b) season: known on both sides → equal +15, mismatch -40;
 * - (c) episode: parsed numbers include the reference → +25, mismatch -15;
 * - (d) seeders present +5.
 * Ties break by seeders desc, then keep input order (stable sort). The input
 * array is never mutated — a new array is returned. When ref.animeTitle is
 * empty the input order is returned unchanged.
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
 * channel structure. A well-formed feed with zero items yields [].
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
 * Normalize one raw feed item into a ReleaseSearchResult. downloadUrl prefers
 * the enclosure URL (usually a .torrent file) and falls back to <link>;
 * magnet: URIs pass through untouched either way. sizeBytes prefers the
 * Torznab size attr, then the enclosure length/size attributes. seeders and
 * leechers come from Torznab attrs (null when absent). pubDate becomes unix
 * ms, null when unparseable.
 */
function normalizeFeedItem(item: Record<string, unknown>, provider: RssProvider): ReleaseSearchResult {
  const attrs = collectTorznabAttrs(item);
  const enclosure = asRecord(item.enclosure);
  const enclosureUrl = enclosure ? readXmlAttribute(enclosure, '@_url').trim() : '';
  const link = readXmlText(item.link).trim();
  const downloadUrl = enclosureUrl || link;
  const torznabSize = toIntOrNull(attrs.size);
  const enclosureLength = enclosure ? toIntOrNull(readXmlAttribute(enclosure, '@_length')) : null;
  const enclosureSize = enclosure ? toIntOrNull(readXmlAttribute(enclosure, '@_size')) : null;
  const pubDateMs = Date.parse(readXmlText(item.pubDate).trim());
  return {
    providerId: provider.id,
    providerName: provider.name,
    title: readXmlText(item.title).trim(),
    downloadUrl,
    sizeBytes: torznabSize ?? enclosureLength ?? enclosureSize,
    seeders: toIntOrNull(attrs.seeders),
    leechers: toIntOrNull(attrs.leechers),
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

/** Dedupe identity: lowercased whitespace-normalized title + sizeBytes. */
function dedupeKey(result: ReleaseSearchResult): string {
  const title = result.title.toLowerCase().replace(/\s+/g, ' ').trim();
  return `${title}|${result.sizeBytes ?? ''}`;
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
