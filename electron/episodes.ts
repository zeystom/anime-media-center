/**
 * Advanced episode number & title parser for anime release naming conventions.
 * Standalone module with zero Electron dependencies so it can be tested directly in Node.js.
 *
 * The implementation now lives in src/lib/releaseParser (shared between the
 * Electron main process and the renderer); this module is a thin shim that
 * re-exports it so existing imports keep working.
 */

export type { ParsedEpisodeResult } from '../src/lib/releaseParser/regexEngine.ts';
export {
  extractEpisodeNumber,
  normalizeReleaseString,
  parseEpisodeDetails,
  sanitizeMediaTags,
} from '../src/lib/releaseParser/index.ts';
