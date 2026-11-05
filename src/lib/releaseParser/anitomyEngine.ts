/**
 * Anitomy-based enrichment engine for anime release names.
 *
 * anitomyscript never becomes a static dependency of this module: it is
 * loaded via a computed dynamic import() so bundlers (vite/esbuild) never
 * pull it into the renderer graph. The regex engine (regexEngine.ts) stays
 * the authority for episode/season/label — anitomy only fills null/empty
 * additive fields on top of parseReleaseCore output.
 */

import { formatEpisodeNumberPart, parseReleaseCore } from './regexEngine.ts';
import type { ParsedRelease } from './types.ts';

type AnitomyValue = string | string[] | undefined;

/**
 * Shape of a single anitomyscript result (see node_modules/anitomyscript/index.d.ts).
 * Observed in practice: scalar elements are strings, multi-value elements
 * (audio_term, episode_number, release_information, anime_type, ...) can be
 * string arrays, and absent elements come back as undefined.
 */
interface AnitomyElements {
  anime_season?: AnitomyValue;
  anime_title?: AnitomyValue;
  anime_type?: AnitomyValue;
  anime_year?: AnitomyValue;
  audio_term?: AnitomyValue;
  episode_number?: AnitomyValue;
  episode_number_alt?: AnitomyValue;
  episode_title?: AnitomyValue;
  file_extension?: AnitomyValue;
  file_name?: AnitomyValue;
  other?: AnitomyValue;
  release_group?: AnitomyValue;
  release_information?: AnitomyValue;
  release_version?: AnitomyValue;
  source?: AnitomyValue;
  subtitles?: AnitomyValue;
  video_resolution?: AnitomyValue;
  video_term?: AnitomyValue;
  volume_number?: AnitomyValue;
}

type AnitomyParseFn = (input: string | string[]) => Promise<AnitomyElements>;

// Built via join() so the specifier is not a string literal: static bundlers
// (vite/esbuild) therefore never try to resolve or bundle anitomyscript.
const ANITOMY_MODULE_SPECIFIER = ['anitomyscript'].join('');

let anitomyLoadPromise: Promise<AnitomyParseFn | null> | null = null;

/**
 * Loads (and caches) the anitomyscript parse function, or null when the
 * module cannot be loaded in the current environment (e.g. the browser
 * renderer). The result is cached permanently, including failures, so the
 * fetch workaround below runs at most once per process.
 */
async function loadAnitomy(): Promise<AnitomyParseFn | null> {
  if (!anitomyLoadPromise) {
    anitomyLoadPromise = loadAnitomyModule();
  }
  return anitomyLoadPromise;
}

async function loadAnitomyModule(): Promise<AnitomyParseFn | null> {
  const fetchHolder = globalThis as unknown as { fetch?: unknown };
  const savedFetch = fetchHolder.fetch;
  try {
    // anitomyscript@2.0.4 ships a 2019-era emscripten glue that resolves its
    // .wasm file via fetch() even in Node, where the target is a raw
    // filesystem path (fetch fails with "unknown scheme" on Node >= 18, which
    // exposes a global fetch). Hiding fetch for the duration of module init
    // makes the glue fall back to its fs.readFileSync code path.
    fetchHolder.fetch = undefined;

    const mod = (await import(/* @vite-ignore */ ANITOMY_MODULE_SPECIFIER)) as {
      default?: AnitomyParseFn;
    };
    const parseFn = mod?.default;
    if (typeof parseFn !== 'function') {
      return null;
    }
    // The wasm init happens on the first parse call, so keep fetch hidden
    // until it completes. Later calls reuse the cached native module.
    await parseFn('probe');
    return parseFn;
  } catch {
    return null;
  } finally {
    fetchHolder.fetch = savedFetch;
  }
}

function firstValue(value: AnitomyValue): string | null {
  if (Array.isArray(value)) {
    return value.length > 0 && value[0].trim() ? value[0].trim() : null;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
}

function joinedValue(value: AnitomyValue): string | null {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : null;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
}

/**
 * Parses anitomy's episode element (string like '05.5' or an array for
 * multi-episode files) into a start/end range.
 */
function anitomyEpisodeRange(values: AnitomyValue[]): { start: number; end: number | null } | null {
  const nums: number[] = [];
  for (const value of values) {
    if (!Array.isArray(value) && typeof value === 'string') {
      const n = parseFloat(value);
      if (!Number.isNaN(n)) {
        nums.push(n);
      }
    }
  }
  if (nums.length === 0) {
    return null;
  }
  return { start: nums[0], end: nums.length > 1 ? nums[nums.length - 1] : null };
}

function mapAnitomyReleaseType(animeType: string | null): ParsedRelease['releaseType'] | null {
  if (!animeType) return null;
  if (/movie|film|gekijouban/i.test(animeType)) return 'Movie';
  if (/ova/i.test(animeType)) return 'OVA';
  if (/oad/i.test(animeType)) return 'OAD';
  if (/special/i.test(animeType)) return 'SP';
  return null;
}

/**
 * Enriches the regex-authority parse with anitomy elements. anitomy fills
 * ONLY null/empty additive fields (animeTitle, releaseGroup, resolution,
 * videoTerm, audioTerm, subtitlesTerm, releaseType when 'Unknown') unless
 * opts.preferAnitomyEpisode is true, in which case an anitomy-detected
 * episode number wins over the regex one (regex values kept as fallback).
 * On any error the regex result is returned unchanged.
 */
export async function parseWithAnitomy(
  fileName: string,
  opts?: { preferAnitomyEpisode?: boolean }
): Promise<ParsedRelease> {
  const base = parseReleaseCore(fileName);
  try {
    const anitomy = await loadAnitomy();
    if (!anitomy) {
      return base;
    }
    const raw = await anitomy(fileName);

    const enriched: ParsedRelease = { ...base };

    if (!enriched.animeTitle) {
      const anitomyTitle = firstValue(raw.anime_title);
      if (anitomyTitle) {
        // Anitomy titles can end with leftovers like "- S01E05.5" it failed to split
        const cleanedTitle = anitomyTitle.replace(/[\s._-]+$/, '').trim();
        enriched.animeTitle = cleanedTitle || null;
      }
    }
    if (!enriched.releaseGroup) {
      enriched.releaseGroup = firstValue(raw.release_group);
    }
    if (!enriched.resolution) {
      enriched.resolution = firstValue(raw.video_resolution);
    }
    if (!enriched.videoTerm) {
      enriched.videoTerm = firstValue(raw.video_term);
    }
    if (!enriched.audioTerm) {
      enriched.audioTerm = joinedValue(raw.audio_term);
    }
    if (!enriched.subtitlesTerm) {
      enriched.subtitlesTerm = joinedValue(raw.subtitles);
    }
    if (enriched.releaseType === 'Unknown') {
      const mapped = mapAnitomyReleaseType(firstValue(raw.anime_type));
      if (mapped) {
        enriched.releaseType = mapped;
      }
    }

    if (opts?.preferAnitomyEpisode === true) {
      const range = anitomyEpisodeRange([raw.episode_number, raw.episode_number_alt]);
      if (range) {
        const seasonPrefix =
          enriched.season !== null ? `S${String(enriched.season).padStart(2, '0')}E` : 'E';
        if (range.end !== null && range.end !== range.start) {
          enriched.isMultiEpisode = true;
          enriched.episodeEnd = range.end;
          enriched.episodeNumbers = [range.start, range.end];
          enriched.label = `${seasonPrefix}${formatEpisodeNumberPart(range.start)}-E${formatEpisodeNumberPart(range.end)}`;
        } else {
          enriched.isMultiEpisode = false;
          enriched.episodeEnd = null;
          enriched.episodeNumbers = [range.start];
          enriched.label = `${seasonPrefix}${formatEpisodeNumberPart(range.start)}`;
        }
        enriched.episodeNumber = range.start;
      }
    }

    enriched.parsedBy = 'anitomy';
    enriched.enrichedBy = 'anitomy';
    return enriched;
  } catch {
    // Anitomy failed to load or parse: regex result unchanged.
    return base;
  }
}
