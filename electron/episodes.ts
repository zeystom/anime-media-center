/**
 * Advanced episode number & title parser for anime release naming conventions.
 * Standalone module with zero Electron dependencies so it can be tested directly in Node.js.
 */

export interface ParsedEpisodeResult {
  episodeNum: number | null;
  label: string;
  seasonNum: number | null;
  isSpecial?: boolean;
  isMultiEpisode?: boolean;
  specialType?: 'OVA' | 'OAD' | 'SP' | 'NCED' | 'NCOP' | 'Movie' | null;
}

function formatEpisodeNumberPart(n: number): string {
  if (Number.isInteger(n)) {
    return String(n).padStart(2, '0');
  }
  const parts = String(n).split('.');
  const intPart = parts[0].padStart(2, '0');
  return `${intPart}.${parts[1]}`;
}

/**
 * Normalizes Unicode typography characters (Japanese dashes, wave dashes,
 * full-width numbers/spaces, en/em dashes) into standard ASCII equivalents.
 */
export function normalizeReleaseString(raw: string): string {
  if (!raw) return '';
  return raw
    // Full-width numbers ０-９ -> 0-9
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // Unicode dashes: En-dash (–), Em-dash (—), Horizontal bar (―), Minus (−) -> -
    .replace(/[\u2013\u2014\u2015\u2212]/g, '-')
    // Japanese wave dashes: 〜 (\u301C), ～ (\uFF5E) -> -
    .replace(/[\u301C\uFF5E]/g, '-')
    // Full-width space (\u3000) -> standard space
    .replace(/\u3000/g, ' ')
    // Interpuncts / middle dots (・, ·) -> space
    .replace(/[\u30FB\u00B7]/g, ' ')
    // Normalize repeated whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strips technical release tags, audio codecs, and resolution dimensions
 * that might otherwise produce false-positive episode numbers (e.g. 1920x1080, E-AC-3, DDP5.1).
 */
export function sanitizeMediaTags(str: string): string {
  let res = str;

  // 1. Strip CRC32/MD5 hashes like [B6543D71] or [1234ABCD]
  res = res.replace(/\[[0-9a-fA-F]{8}\]/g, ' ');

  // 2. Strip video dimensions: e.g. 1920x1080, 1280x720, 3840x2160, 704x480, 640x480, etc.
  res = res.replace(/\b\d{3,4}x\d{3,4}\b/gi, ' ');

  // 3. Strip audio codecs with numbers to prevent false 'E' / 'EP' / 'Nx' matches:
  // e-ac-3, eac3, ddp 5.1, truehd 7.1, flac 2.0, 2xopus, aac 2.0
  res = res.replace(/\b(?:e-?ac-?3|ddp\s*\d*(?:\.\d+)?|truehd(?:\s*atmos)?(?:\s*\d+\.\d+)?|flac\s*\d+\.\d+|aac\s*\d+\.\d+|opus|\d+xopus|dts(?:-hd)?)\b/gi, ' ');

  // 4. Strip standard video formats, bit depths, and scene release tokens
  res = res.replace(/\b(?:\d{3,4}p|4k|2160p|1080p|720p|576p|480p|x26[45]|h\.?26[45]|hevc|avc|10-?bit|8-?bit|hi10p|bluray|bdrip|remux|web-?dl|web-?rip|dvdrip|dvd|repack\d*|proper)\b/gi, ' ');

  // 5. Strip trailing scene release group e.g. -CRUCiBLE, -EMBER, -AnoZu, -FLUX
  // Must NOT match numeric episode numbers like "- 05" or "- 5"
  res = res.replace(/(?<=\S)-[A-Za-z][A-Za-z0-9_]*$/, ' ');

  return res.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts episode number and standardized display label from an anime release filename.
 */
export function extractEpisodeNumber(fileName: string): { episodeNum: number | null; label: string } {
  const parsed = parseEpisodeDetails(fileName);
  return {
    episodeNum: parsed.episodeNum,
    label: parsed.label,
  };
}

/**
 * Comprehensive parser extracting episode number, label, season number,
 * special status, and multi-episode range from an anime release filename.
 */
export function parseEpisodeDetails(fileName: string): ParsedEpisodeResult {
  if (!fileName) {
    return { episodeNum: null, label: 'EP', seasonNum: null };
  }

  const withoutExt = fileName.replace(/\.[a-zA-Z0-9]+$/, '');
  const normalized = normalizeReleaseString(withoutExt);

  // Remove bracketed metadata blocks and parenthesized blocks except 4-digit years like (2024)
  const cleaned = normalized
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?!\d{4}\b)[^)]*\)/g, ' ')
    .trim();

  // 1. Check for Multi-Episode SxxExx e.g. S01E01-E02, S01E01-02, S01E01~E04
  const multiSeMatch = cleaned.match(/\bs(\d{1,2})e(\d{1,4})[-_~–—]e?(\d{1,4})\b/i);
  if (multiSeMatch) {
    const s = parseInt(multiSeMatch[1], 10);
    const startEp = parseInt(multiSeMatch[2], 10);
    const endEp = parseInt(multiSeMatch[3], 10);
    return {
      episodeNum: startEp,
      seasonNum: s,
      label: `S${String(s).padStart(2, '0')}E${String(startEp).padStart(2, '0')}-E${String(endEp).padStart(2, '0')}`,
      isMultiEpisode: true,
    };
  }

  // 2. Check for Single SxxExx e.g. S01E05, S02E01.5
  const sxxExxMatch = cleaned.match(/\bs(\d{1,2})e(\d{1,4}(?:\.5|\.1)?)\b/i);
  if (sxxExxMatch) {
    const s = parseInt(sxxExxMatch[1], 10);
    const n = parseFloat(sxxExxMatch[2]);
    const numPart = formatEpisodeNumberPart(n);
    return {
      episodeNum: n,
      seasonNum: s,
      label: `S${String(s).padStart(2, '0')}E${numPart}`,
    };
  }

  // 3. Check for Specials, OVAs, OADs, NC Tracks, Movies
  const specialOvaMatch = cleaned.match(/\b(?:ova|oad)[_.\s-]*(\d{1,3})\b/i);
  if (specialOvaMatch) {
    const n = parseInt(specialOvaMatch[1], 10);
    return {
      episodeNum: n,
      seasonNum: null,
      label: `OVA${String(n).padStart(2, '0')}`,
      isSpecial: true,
      specialType: 'OVA',
    };
  }

  const specialSpMatch = cleaned.match(/\b(?:sp|special)[_.\s-]*(\d{1,3})\b/i);
  if (specialSpMatch) {
    const n = parseInt(specialSpMatch[1], 10);
    return {
      episodeNum: n,
      seasonNum: null,
      label: `SP${String(n).padStart(2, '0')}`,
      isSpecial: true,
      specialType: 'SP',
    };
  }

  const ncMatch = cleaned.match(/\b(ncop|nced)[_.\s-]*(\d{1,3})?\b/i);
  if (ncMatch) {
    const type = ncMatch[1].toUpperCase() as 'NCOP' | 'NCED';
    const n = ncMatch[2] ? parseInt(ncMatch[2], 10) : 1;
    return {
      episodeNum: n,
      seasonNum: null,
      label: `${type}${String(n).padStart(2, '0')}`,
      isSpecial: true,
      specialType: type,
    };
  }

  // 4. Multi-episode formats without season prefix e.g. "E01-E02", "01-02", "Show - 01-02"
  const multiEpMatch = cleaned.match(/\b(?:ep|episode|e)[_.\s-]*(\d{1,4})[-_~–—]e?(\d{1,4})\b/i);
  if (multiEpMatch) {
    const startEp = parseInt(multiEpMatch[1], 10);
    const endEp = parseInt(multiEpMatch[2], 10);
    return {
      episodeNum: startEp,
      seasonNum: null,
      label: `E${String(startEp).padStart(2, '0')}-E${String(endEp).padStart(2, '0')}`,
      isMultiEpisode: true,
    };
  }

  const multiDashMatch = cleaned.match(/\s-\s(\d{1,4})[-_~–—](\d{1,4})\b/i);
  if (multiDashMatch) {
    const startEp = parseInt(multiDashMatch[1], 10);
    const endEp = parseInt(multiDashMatch[2], 10);
    return {
      episodeNum: startEp,
      seasonNum: null,
      label: `E${String(startEp).padStart(2, '0')}-E${String(endEp).padStart(2, '0')}`,
      isMultiEpisode: true,
    };
  }

  // Sanitize media/audio/resolution tags to avoid false positives in subsequent checks
  const sanitized = sanitizeMediaTags(cleaned);

  // 5. NxNN e.g. 1x05, 2x12
  // Guarded to prevent video resolution dimensions (e.g. 1920x1080) by requiring Season to be 1 or 2 digits
  // and no leading/trailing resolution digits.
  const nxMatch = sanitized.match(/(?<!\d)\b([1-9]\d?)x(\d{1,4}(?:\.5)?)\b(?!\d)/i);
  if (nxMatch) {
    const s = parseInt(nxMatch[1], 10);
    const n = parseFloat(nxMatch[2]);
    const numPart = formatEpisodeNumberPart(n);
    return {
      episodeNum: n,
      seasonNum: s,
      label: `E${numPart}`,
    };
  }

  // 6. Explicit episode word prefix: \b(?:ep|episode)[_.\s-]*(\d{1,4}(?:\.5)?)\b
  const epWordMatch = sanitized.match(/\b(?:ep|episode)[_.\s-]*(\d{1,4}(?:\.5)?)\b/i);
  if (epWordMatch) {
    const n = parseFloat(epWordMatch[1]);
    const numPart = formatEpisodeNumberPart(n);
    return {
      episodeNum: n,
      seasonNum: null,
      label: `E${numPart}`,
    };
  }

  // 7. 'E' prefix with 2 to 4 digits: \bE(\d{2,4}(?:\.5)?)\b
  // Requires at least 2 digits so standalone 'E' with audio/version tags isn't misidentified
  const ePrefixMatch = sanitized.match(/\bE(\d{2,4}(?:\.5)?)\b/i);
  if (ePrefixMatch) {
    const n = parseFloat(ePrefixMatch[1]);
    const numPart = formatEpisodeNumberPart(n);
    return {
      episodeNum: n,
      seasonNum: null,
      label: `E${numPart}`,
    };
  }

  // 8. Number after ' - ' with optional version: \s-\s(\d{1,4}(?:\.5)?)(?:v\d+)?\b
  // Handles fractional episodes like "Show - 05.5.mkv" and up to 4-digit shonen numbers like "1085"
  const dashMatch = sanitized.match(/\s-\s(\d{1,4}(?:\.5)?)(?:v\d+)?(?=\s|$|[-_.\s])/i);
  if (dashMatch) {
    const n = parseFloat(dashMatch[1]);
    const numPart = formatEpisodeNumberPart(n);
    return {
      episodeNum: n,
      seasonNum: null,
      label: `E${numPart}`,
    };
  }

  // 9. Fallback: number bounded by separator (e.g. "Show.Name.05.1080p")
  // Filter out 4-digit release years (1950 - 2040)
  const numbersWithSeparators = Array.from(
    sanitized.matchAll(/(?:^|[-_.\s])(\d{1,4}(?:\.5)?)(?:v\d+)?(?=[-_.\s]|$)/g)
  );

  if (numbersWithSeparators.length > 0) {
    // If there are multiple candidate numbers (e.g. "Mob.Psycho.100.05"),
    // candidate numbers that are part of the title appear earlier; the episode number appears last.
    const validCandidates = numbersWithSeparators
      .map((m) => parseFloat(m[1]))
      .filter((num) => {
        // Exclude release years (e.g. 1980..2040)
        if (num >= 1950 && num <= 2040 && Number.isInteger(num)) {
          return false;
        }
        return true;
      });

    if (validCandidates.length > 0) {
      // Pick the last valid candidate (closest to the end of the filename)
      const n = validCandidates[validCandidates.length - 1];
      const numPart = formatEpisodeNumberPart(n);
      return {
        episodeNum: n,
        seasonNum: null,
        label: `E${numPart}`,
      };
    }
  }

  return { episodeNum: null, label: 'EP', seasonNum: null };
}
