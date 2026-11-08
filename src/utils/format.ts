// Season/episode/series extraction is delegated to the shared parser core.
// Source of truth: src/lib/releaseParser/regexEngine.ts (pure, wasm-free — safe
// for both the renderer bundle and the esbuild data-URI test graph).
import { normalizeReleaseString, parseReleaseCore } from '../lib/releaseParser/regexEngine.ts';

export function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const minStr = mins.toString().padStart(2, '0');
  const secStr = secs.toString().padStart(2, '0');

  if (hrs > 0) {
    return `${hrs}:${minStr}:${secStr}`;
  }
  return `${minStr}:${secStr}`;
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export function formatDurationFriendly(seconds?: number): string {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) {
    return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  }
  return `${mins}m`;
}

export interface RelativeAirDate {
  /** "in 6 days" / "23 hours ago" */
  label: string;
  /** True when the air time is still in the future. */
  future: boolean;
}

/**
 * Human-relative airing time for ongoing shows: "23 hours ago" for aired
 * episodes, "in 6 days" for upcoming ones (like AniList's episode list).
 * Returns null when the date is missing or unparseable.
 */
export function formatRelativeAirDate(airDate: string | null | undefined, now = Date.now()): RelativeAirDate | null {
  if (!airDate) return null;
  const time = Date.parse(airDate);
  if (!Number.isFinite(time)) return null;
  const diff = time - now;
  const abs = Math.abs(diff);
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const span = (value: number, unit: string) => `${value} ${unit}${value === 1 ? '' : 's'}`;
  let label: string;
  if (abs < HOUR) {
    label = span(Math.max(1, Math.round(abs / MINUTE)), 'minute');
  } else if (abs < DAY) {
    label = span(Math.round(abs / HOUR), 'hour');
  } else if (abs < WEEK) {
    label = span(Math.round(abs / DAY), 'day');
  } else if (abs < MONTH) {
    label = span(Math.round(abs / WEEK), 'week');
  } else {
    label = span(Math.round(abs / MONTH), 'month');
  }
  return diff >= 0 ? { label: `in ${label}`, future: true } : { label: `${label} ago`, future: false };
}

/**
 * Cross-platform path basename extraction (supports both Windows '\' and POSIX '/').
 */
export function getPathBasename(p: string): string {
  if (!p) return '';
  const normalized = p.replace(/[/\\]+$/, '');
  const parts = normalized.split(/[/\\]/);
  return parts.pop() || normalized;
}

/**
 * Cross-platform path dirname extraction (supports both Windows '\' and POSIX '/').
 */
export function getPathDirname(p: string): string {
  if (!p) return '';
  const normalized = p.replace(/[/\\]+$/, '');
  const lastIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (lastIndex === -1) return '';
  return normalized.substring(0, lastIndex).replace(/[/\\]+$/, '');
}

/**
 * Determines whether an anime folder represents a standalone feature film (movie / special)
 * rather than a multi-episode TV series.
 */
export function isFolderMovie(folder: {
  folderName: string;
  episodes: Array<{ fileName: string; duration?: number; episodeNumber?: string }>;
  canonicalTitle?: string | null;
}): boolean {
  if (!folder || !folder.episodes || folder.episodes.length !== 1) {
    return false;
  }
  const ep = folder.episodes[0];
  const combined = `${folder.folderName} ${ep.fileName || ''} ${folder.canonicalTitle || ''}`.toLowerCase();

  // 1. Explicit keyword check for films and standalone specials
  if (/\b(movie|film|gekijouban|theatrical)\b/i.test(combined)) {
    return true;
  }

  // 2. Duration check: feature films are typically 45+ minutes (2700s)
  if (ep.duration && ep.duration > 0) {
    if (ep.duration >= 2700) {
      return true;
    }
    // Probed duration under 40 minutes (2400s) is standard TV length or short, not a standalone movie
    if (ep.duration < 2400) {
      return false;
    }
  }

  // 3. If file or episodeNumber has an explicit seasonal pattern or episode numbering,
  // it is likely an incomplete/single episode of a TV series
  const baseNameWithoutExt = (ep.fileName || '').replace(/\.[^.]+$/, '');
  if (
    /\bs\d{1,2}e\d{1,4}\b/i.test(ep.fileName || '') ||
    /\bs\d{1,2}e\d{1,4}\b/i.test(ep.episodeNumber || '') ||
    /\b(?:ep|episode|e)\s*\d+\b/i.test(ep.fileName || '') ||
    /\b(?:ep|episode|e)\s*\d+\b/i.test(ep.episodeNumber || '') ||
    /\s+-\s+\d{1,4}(?:\s+-\s*|[\s.]|$)/i.test(ep.fileName || '') ||
    /\s+-\s+\d{1,4}\b/i.test(baseNameWithoutExt)
  ) {
    return false;
  }

  // 4. Standalone file without seasonal episode numbering
  return true;
}

export interface ParsedEpisode {
  seriesTitle: string;
  episodeNumber: number | null;
  seasonNumber: number | null;
  episodeLabel: string;
  displayTitle: string;
  tags: string[];
}

/**
 * Extracts release-level metadata tags (e.g. 1080p, BluRay, HEVC, Dual Audio)
 * to be displayed once at the season level.
 */
export function extractReleaseTags(raw: string): string[] {
  if (!raw) return [];
  const tags: string[] = [];
  const tagMatchers = [
    { label: '4K', regex: /\b(2160p|4k)\b/i },
    { label: '1080p', regex: /\b1080p\b/i },
    { label: '720p', regex: /\b720p\b/i },
    { label: '576p', regex: /\b576p\b/i },
    { label: '480p', regex: /\b480p\b/i },
    { label: 'BluRay', regex: /\b(bluray|bdrip|remux)\b/i },
    { label: 'DVD', regex: /\b(dvd|dvdrip)\b/i },
    { label: 'WEB-DL', regex: /\b(web-dl|webrip)\b/i },
    { label: 'HEVC', regex: /\b(hevc|x265|h\.?265)\b/i },
    { label: 'AVC', regex: /\b(x264|h\.?264|avc)\b/i },
    { label: '10-bit', regex: /\b(10-?bit|hi10p)\b/i },
    { label: 'Dual Audio', regex: /\b(dual-?audio|multi-?audio)\b/i },
  ];

  for (const t of tagMatchers) {
    if (t.regex.test(raw) && !tags.includes(t.label)) {
      tags.push(t.label);
    }
  }

  return tags;
}

/**
 * Cleans series or folder name by removing bracketed hashes, release groups, and tech specs.
 * Handles both standard anime releases ([Group] Title [Quality]) and scene dot-releases
 * (Title.S01.REPACK.1080p.BluRay.Remux.Dual-Audio...).
 */
export function cleanSeriesTitle(raw: string): string {
  if (!raw) return '';
  let str = raw;

  // 1. Normalize Unicode dashes, Japanese wave dashes, and typography
  str = str
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u2013\u2014\u2015\u2212\u301C\uFF5E]/g, '-')
    .replace(/[\u30FB\u00B7]/g, ' ')
    .replace(/\s+/g, ' ');

  // 2. Remove bracketed blocks [FansubGroup], [1080p], [DVD-BD ...], etc.
  str = str.replace(/\[[^\]]*\]/g, '');

  // Normalize duplicate parentheses if already corrupted
  while (/\(\s*\(|\)\s*\)/.test(str)) {
    str = str.replace(/\(\s*\(/g, '(').replace(/\)\s*\)/g, ')');
  }

  // 3. Remove parenthesized blocks except 4-digit release years like (1998) or (2024),
  // and season identifiers like (Season 1) or (S1) or (2nd Season)
  str = str.replace(/\(\s*(?!(?:\d{4}|(?:s|season\s*)\d+|\d+(?:nd|rd|th)\s*season)\b)[^)]*\)/gi, '');

  // 4. Remove trailing release group: -CRUCiBLE, -EMBER, -VARYG, etc.
  str = str.replace(/(?<=\S)-[A-Za-z][A-Za-z0-9_]*$/, '');

  // 5. Handle dots inside codec/audio tags before dot-splitting and strip dimensions
  str = str
    .replace(/\b\d{3,4}x\d{3,4}\b/gi, ' ')
    .replace(/\b(h|x)\.26[45]\b/gi, 'codec')
    .replace(/\be-?ac-?3\b/gi, '')
    .replace(/\bflac\s*\d+\.\d+\b/gi, '')
    .replace(/\baac\s*\d+\.\d+\b/gi, '')
    .replace(/\bddp\s*\d+\.\d+\b/gi, '');

  // 6. If scene dot-spaced, replace dots with spaces
  const dotCount = (str.match(/\./g) || []).length;
  if (dotCount >= 2) {
    str = str.replace(/\./g, ' ');
  }

  // 7. Cut off at the first technical/scene junk token
  const junkPattern =
    /\b(2160p|4k|1080p|720p|576p|480p|bluray|bdrip|remux|web-?dl|web-?rip|web|dvdrip|dvd|hdtv|hevc|x265|x264|h264|h265|avc|codec|10-?bit|8-?bit|hi10p|dual(?:-?audio)?|multi-?audio|flac|aac|opus|2xopus|dts|ddp\d*|ac3|atmos|repack\d*|proper|netflix|crunchyroll|cr|funimation|dolby(?:-?truehd)?|truehd)\b/i;
  const match = str.match(junkPattern);
  if (match && match.index !== undefined) {
    str = str.substring(0, match.index);
  }

  // 8. Clean up whitespace and stray dashes/underscores
  str = str.replace(/\s+/g, ' ').trim();
  str = str.replace(/^[-_–—\s]+|[-_–—\s]+$/g, '');

  // 9. Beautify Season / Part tags
  // e.g. "Clevatess S01" -> "Clevatess (Season 1)"
  // e.g. "Jujutsu Kaisen Season 2" -> "Jujutsu Kaisen (Season 2)"
  // e.g. "Mob Psycho 100 2nd Season" -> "Mob Psycho 100 (Season 2)"
  const seasonPattern = /\b(?:S|Season\s*)0*(\d{1,2})\b|\b(\d{1,2})(?:nd|rd|th)\s*Season\b/i;
  const sMatch = str.match(seasonPattern);
  if (sMatch && sMatch.index !== undefined) {
    const sNum = parseInt(sMatch[1] || sMatch[2], 10);
    const rawBefore = str.substring(0, sMatch.index);
    const rawAfter = str.substring(sMatch.index + sMatch[0].length);

    // Strip trailing opening paren, dash, space, etc. from baseName
    const baseName = rawBefore.trim().replace(/^[-_–—\s(]+|[-_–—\s(]+$/g, '');

    // Clean after segment: remove duplicate mentions of the same season
    let after = rawAfter.replace(/\s*\(?\s*(?:S|Season\s*)0*(\d{1,2})\b\s*\)?/gi, (m, num) => {
      if (parseInt(num, 10) === sNum) return '';
      return m;
    }).trim();

    // If rawBefore was wrapped in an opening paren, strip matching closing paren from after
    if (rawBefore.trim().endsWith('(')) {
      after = after.replace(/^\s*\)/, '').trim();
    }

    // Separate trailing parenthesized metadata (like "(2024)")
    let meta = '';
    const metaMatch = after.match(/\s*(\(\s*\d{4}\s*\))\s*$/);
    if (metaMatch && metaMatch.index !== undefined) {
      meta = metaMatch[1];
      after = after.substring(0, metaMatch.index).trim();
    }

    after = after.replace(/^[-_–—\s)]+|[-_–—\s)]+$/g, '').trim();
    const seasonTag = after ? `(Season ${sNum} ${after})` : `(Season ${sNum})`;
    str = meta ? `${baseName} ${seasonTag} ${meta}` : `${baseName} ${seasonTag}`;
  }

  // Ensure balanced closing parentheses so trailing metadata doesn't leave unclosed parentheses
  let openCount = 0;
  let closeCount = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') openCount++;
    else if (str[i] === ')') closeCount++;
  }
  if (openCount > closeCount) {
    str += ')'.repeat(openCount - closeCount);
  } else if (closeCount > openCount) {
    while (closeCount > openCount && str.endsWith(')')) {
      str = str.slice(0, -1).trim();
      closeCount--;
    }
  }

  return str.trim() || raw;
}

/**
 * Parses raw anime release filenames (e.g. [hchcsen] Haruhi S01E01 [DVD 576p x265...].mkv,
 * Clevatess.S01E01.REPACK.1080p..., Cowboy Bebop - 01 - Asteroid Blues.mkv)
 * into a clean, aesthetic episode structure with extracted quality tags.
 *
 * Season/episode/series facts are delegated to the shared parser core
 * (source of truth: src/lib/releaseParser/regexEngine.ts). format.ts keeps the
 * display concerns: tag extraction, episode-title remainder slicing and the
 * legacy "EP 05"/"S02E03" label shape.
 */
export function cleanEpisodeTitle(filename: string): ParsedEpisode {
  if (!filename) {
    return {
      seriesTitle: '',
      episodeNumber: null,
      seasonNumber: null,
      episodeLabel: 'EP',
      displayTitle: '',
      tags: [],
    };
  }

  // Season / episode / multi-episode facts come from the shared regex core.
  const core = parseReleaseCore(filename);
  const season = core.season;
  const episode = core.episodeNumber;

  let name = filename.replace(/\.(mkv|mp4|avi|webm|ts)$/i, '');

  // 0. Normalize Unicode dashes, Japanese wave dashes, full-width numbers and
  // typography via the shared core (also collapses whitespace, which the
  // downstream junk-token cleanup did anyway).
  name = normalizeReleaseString(name);

  // 1. Extract quality, source, audio and release tags
  const tags: string[] = [];
  const tagMatchers = [
    { label: '4K', regex: /\b(2160p|4k)\b/i },
    { label: '1080p', regex: /\b1080p\b/i },
    { label: '720p', regex: /\b720p\b/i },
    { label: '576p', regex: /\b576p\b/i },
    { label: '480p', regex: /\b480p\b/i },
    { label: 'BluRay', regex: /\b(bluray|bdrip|remux)\b/i },
    { label: 'DVD', regex: /\b(dvd|dvdrip)\b/i },
    { label: 'WEB-DL', regex: /\b(web-dl|webrip)\b/i },
    { label: 'HEVC', regex: /\b(hevc|x265|h\.?265)\b/i },
    { label: 'AVC', regex: /\b(x264|h\.?264|avc)\b/i },
    { label: '10-bit', regex: /\b(10-?bit|hi10p)\b/i },
    { label: 'Dual-Audio', regex: /\b(dual-?audio|multi-?audio)\b/i },
    { label: 'FLAC', regex: /\bflac(?:\s*2\.0|\s*5\.1)?\b/i },
    { label: 'Opus', regex: /\b(?:2x)?opus\b/i },
    { label: 'AAC', regex: /\baac(?:\s*2\.0|\s*5\.1)?\b/i },
    { label: 'REPACK', regex: /\brepack\b/i },
  ];

  for (const t of tagMatchers) {
    if (t.regex.test(name) && !tags.includes(t.label)) {
      tags.push(t.label);
    }
  }

  // 2. Remove CRC32/MD5 hashes like [B6543D71]
  // NOTE: steps 2-8 stay local on purpose. The shared sanitizeMediaTags() is not
  // equivalent for the display path: it keeps quality bracket blocks and leading
  // groups intact and *replaces* junk tokens instead of deleting them, which
  // would leak "[Group]"/"(1080p)" remnants into the cleaned title this code
  // slices the episode title from.
  name = name.replace(/\[[0-9a-fA-F]{8}\]/g, '');

  // 3. Remove leading release group [Group] or (Group)
  name = name.replace(/^[\[\(][^\]\)]+[\]\)]\s*/, '');

  // 4. Remove trailing release group -GROUP or -CRUCiBLE (must not match numeric episode like - 05)
  name = name.replace(/(?<=\S)-[A-Za-z][A-Za-z0-9_]*$/, '');

  // 5. Handle scene-style dot naming (e.g. Clevatess.S01E01.REPACK...) and strip video dimensions/audio codecs
  name = name
    .replace(/\b\d{3,4}x\d{3,4}\b/gi, ' ')
    .replace(/\be-?ac-?3\b/gi, '')
    .replace(/\b(h|x)\.?26[45]\b/gi, '')
    .replace(/\bflac\s*\d+\.\d+\b/gi, '')
    .replace(/\baac\s*\d+\.\d+\b/gi, '')
    .replace(/\bddp\s*\d+\.\d+\b/gi, '')
    .replace(/\bddp\d*(?:\s*\d+)?\b/gi, '');

  const dotCount = (name.match(/\./g) || []).length;
  if (dotCount >= 2) {
    name = name.replace(/\./g, ' ');
  }

  // 6. Remove known quality brackets e.g. [DVD 576p x265 10-bit 2xOpus] or (1080p)
  name = name.replace(
    /\[[^\]]*(?:1080p|720p|576p|480p|x264|x265|hevc|dvd|bd|bluray|flac|opus|audio|subtitle|bit|remux)[^\]]*\]/gi,
    ''
  );
  name = name.replace(
    /\([^\)]*(?:1080p|720p|576p|480p|x264|x265|hevc|dvd|bd|bluray|flac|opus)[^\)]*\)/gi,
    ''
  );

  // 7. Strip known technical tokens
  const junkTokensRegex =
    /\b(2160p|4k|1080p|720p|576p|480p|bluray|bdrip|remux|web-?dl|web-?rip|web|dvdrip|dvd|hdtv|hevc|x265|x264|h264|h265|avc|codec|10-?bit|8-?bit|hi10p|dual(?:-?audio)?|multi-?audio|flac|aac|2xopus|opus|dts|ddp\d*(?:\s*\d+)?|ac3|atmos|repack\d*|proper|cr|crunchyroll|netflix|funimation|\d+ch|[1-7]\.[0-2])\b/gi;
  name = name.replace(junkTokensRegex, '');

  // 8. Clean up whitespace and stray dashes
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^[-_–—\s]+|[-_–—\s]+$/g, '');

  // 9. Locate the episode token so the text after it can be surfaced as the
  // episode title (a display concern kept in format.ts). The numeric facts
  // (season / episode / multi-episode) already came from parseReleaseCore
  // above; this scan only decides where the title remainder starts.
  let epTitle = '';
  let markerIndex = -1;
  let stripTrailingSeparators = false;

  const multiSeMatch = name.match(/s(\d{1,2})\s*e(\d{1,4})[-_~–—]e?(\d{1,4})/i);
  if (multiSeMatch) {
    markerIndex = name.search(/s\d+\s*e\d+/i);
    stripTrailingSeparators = true;
    const remainder = name.substring(markerIndex + multiSeMatch[0].length);
    const titleMatch = remainder.match(/^\s*[-_–—:]\s*(.+)/);
    if (titleMatch) {
      epTitle = titleMatch[1].trim();
    }
  } else {
    const seMatch = name.match(/s(\d+)\s*e(\d+(?:\.5)?)/i);
    if (seMatch) {
      markerIndex = name.search(/s\d+\s*e\d+/i);
      stripTrailingSeparators = true;
      const remainder = name.substring(markerIndex + seMatch[0].length);
      const titleMatch = remainder.match(/^\s*[-_–—:]\s*(.+)/);
      if (titleMatch) {
        epTitle = titleMatch[1].trim();
      }
    } else {
      const multiDashMatch = name.match(/\s+-\s+(\d{1,4})[-_~–—](\d{1,4})(?:\s+-\s*|\s+|$)/);
      if (multiDashMatch) {
        markerIndex = name.indexOf(multiDashMatch[0]);
        const remainder = name.substring(markerIndex + multiDashMatch[0].length);
        const titleMatch = remainder.match(/^\s*[-_–—:]\s*(.+)/);
        if (titleMatch) {
          epTitle = titleMatch[1].trim();
        }
      } else {
        const dashMatch = name.match(/\s+-\s+(\d{1,4}(?:\.5)?)(?:\s+-\s*|\s+|$)/);
        if (dashMatch) {
          markerIndex = name.indexOf(dashMatch[0]);
          const remainder = name.substring(markerIndex + dashMatch[0].length);
          if (dashMatch[0].trim().endsWith('-')) {
            epTitle = remainder.trim();
          } else {
            const titleMatch = remainder.match(/^\s*[-_–—:]\s*(.+)/);
            if (titleMatch) {
              epTitle = titleMatch[1].trim();
            }
          }
        } else {
          const epMatch = name.match(/(?:ep|episode|e)\s*(\d+(?:\.5)?)/i);
          if (epMatch) {
            markerIndex = name.search(/(?:ep|episode|e)\s*\d+/i);
            stripTrailingSeparators = true;
            const remainder = name.substring(markerIndex + epMatch[0].length);
            const titleMatch = remainder.match(/^\s*[-_–—:]\s*(.+)/);
            if (titleMatch) {
              epTitle = titleMatch[1].trim();
            }
          }
        }
      }
    }
  }

  // 10. Secondary cleanup on epTitle
  epTitle = epTitle
    .replace(junkTokensRegex, '')
    .replace(/\b(repack\d*|proper|dual|ddp\d*|web|dl|rip|anozu|subsplease|erai-raws|judas)\b/gi, '')
    .replace(/^[-_–—\s:]+|[-_–—\s:]+$/g, '')
    .trim();
  if (epTitle.length < 2 || /^(?:ep|e|s|part|\d+|dual|ddp|repack)$/i.test(epTitle) || !/[a-zA-Z]/.test(epTitle)) {
    epTitle = '';
  }

  // 11. Series title. When the legacy marker scan above matched, keep the exact
  // legacy extraction (text before the marker) — its output is pinned
  // ("Clevatess 2025", "Another Anime 2024") and differs from the shared core's
  // animeTitle, which additionally strips trailing years/season markers.
  // When the legacy scan found nothing, upgrade to the shared core's animeTitle
  // (source of truth: src/lib/releaseParser/regexEngine.ts) — but only when the
  // core actually detected an episode the legacy chain missed.
  let series: string;
  if (markerIndex >= 0) {
    series = stripTrailingSeparators
      ? name.substring(0, markerIndex).trim().replace(/[-_–—\s]+$/, '')
      : name.substring(0, markerIndex).trim();
  } else {
    series = core.episodeNumber !== null && core.animeTitle ? core.animeTitle : name;
  }

  // 12. Format final clean display title
  let displayTitle = '';
  if (epTitle) {
    displayTitle = epTitle;
  } else if (episode !== null) {
    displayTitle = `Episode ${episode}`;
  } else {
    displayTitle = series || filename;
  }

  // 13. Episode label composed in the legacy format.ts shape ("S02E03" /
  // "S01E01-E02" / "EP 01-E02" / "EP 05"). The shared core's compact labels
  // ("E05", "E01-E02") remain the source of truth for the facts; this is a
  // presentation-only mapping kept for UI compatibility.
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const fmtNum = (n: number) => (Number.isInteger(n) ? String(n).padStart(2, '0') : String(n));
  let episodeLabel = 'EP';
  if (core.isMultiEpisode && core.episodeNumbers.length > 1) {
    const first = core.episodeNumbers[0];
    const last = core.episodeNumbers[core.episodeNumbers.length - 1];
    episodeLabel =
      season !== null
        ? `S${pad2(season)}E${pad2(first)}-E${pad2(last)}`
        : `EP ${pad2(first)}-E${pad2(last)}`;
  } else if (season !== null && episode !== null) {
    episodeLabel = `S${pad2(season)}E${fmtNum(episode)}`;
  } else if (episode !== null) {
    episodeLabel = `EP ${fmtNum(episode)}`;
  }

  return {
    seriesTitle: series,
    episodeNumber: episode,
    seasonNumber: season,
    episodeLabel: episodeLabel || (episode !== null ? `EP ${fmtNum(episode)}` : 'EP'),
    displayTitle,
    tags,
  };
}

/**
 * Smartly formats the final episode display title combining the local parsed title
 * (e.g. "Episode 1") with the official English episode title from AniList/Kitsu
 * (e.g. "The Lord of Dark Beasts") -> "Episode 1 — The Lord of Dark Beasts".
 * Gracefully avoids duplication if the filename already contained the title.
 */
export function formatEpisodeDisplayTitle(
  parsedOrEpisode: string | { fileName?: string; displayTitle?: string; kitsuTitle?: string | null; episodeTitle?: string | null; episodeNumber?: string },
  apiTitle?: string | null
): string {
  if (typeof parsedOrEpisode === 'object' && parsedOrEpisode !== null) {
    const ep = parsedOrEpisode;
    const parsed = cleanEpisodeTitle(ep.fileName || '');
    const official = ep.kitsuTitle || ep.episodeTitle || apiTitle;
    return formatEpisodeDisplayTitle(parsed.displayTitle || ep.episodeNumber || '', official);
  }
  const parsedDisplayTitle = (parsedOrEpisode || '').trim();
  if (!apiTitle || !apiTitle.trim()) {
    return parsedDisplayTitle;
  }
  const cleanApi = apiTitle.trim();
  const cleanParsed = (parsedDisplayTitle || '').trim();

  if (!cleanParsed) {
    return cleanApi;
  }

  // If already identical or already contains the official title
  if (cleanParsed.toLowerCase() === cleanApi.toLowerCase()) {
    return cleanParsed;
  }
  if (cleanParsed.toLowerCase().includes(cleanApi.toLowerCase())) {
    return cleanParsed;
  }
  if (cleanApi.toLowerCase().includes(cleanParsed.toLowerCase()) && !/^(?:Episode|EP|E)\s*\d+/i.test(cleanParsed)) {
    return cleanApi;
  }

  return `${cleanParsed} — ${cleanApi}`;
}

