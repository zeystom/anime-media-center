/**
 * Unified anime release-name parser facade.
 *
 * Public API:
 * - parseReleaseSync / parseRelease — full ParsedRelease
 * - extractEpisodeNumber / parseEpisodeDetails — episode-focused parsing
 * - normalizeReleaseString / sanitizeMediaTags — string utilities
 *
 * The regex engine (regexEngine.ts) is the authority for episode, season and
 * label and is imported statically. anitomy (anitomyEngine.ts) is loaded via
 * a dynamic import() inside the async path only, so the renderer bundle never
 * statically pulls anitomyscript; when anitomy cannot load/parse, the regex
 * result is returned unchanged.
 */

import {
  extractEpisodeNumber,
  normalizeReleaseString,
  parseEpisodeDetails,
  parseReleaseCore,
  sanitizeMediaTags,
} from './regexEngine.ts';
import type { ParsedRelease } from './types.ts';

export type { ParsedRelease } from './types.ts';
export type { ParsedEpisodeResult } from './regexEngine.ts';
export { extractEpisodeNumber, normalizeReleaseString, parseEpisodeDetails, sanitizeMediaTags };

/**
 * Synchronous regex-only parse. The regex engine is authoritative for
 * episode, season and label fields.
 */
export function parseReleaseSync(fileName: string): ParsedRelease {
  return parseReleaseCore(fileName);
}

/**
 * Async parse that enriches the regex result with anitomy elements when the
 * anitomyscript module is available. anitomy fills only null/empty additive
 * fields (animeTitle, releaseGroup, resolution, videoTerm, audioTerm,
 * subtitlesTerm, releaseType when 'Unknown'). With opts.preferAnitomyEpisode
 * the anitomy-detected episode number wins over the regex one when present.
 * If anitomy fails to load or parse, the parseReleaseSync result is returned
 * unchanged.
 */
export async function parseRelease(
  fileName: string,
  opts?: { preferAnitomyEpisode?: boolean }
): Promise<ParsedRelease> {
  try {
    const { parseWithAnitomy } = await import('./anitomyEngine.ts');
    return await parseWithAnitomy(fileName, opts);
  } catch {
    return parseReleaseCore(fileName);
  }
}
