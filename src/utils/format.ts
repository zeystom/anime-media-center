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

  // 1. Remove bracketed blocks [FansubGroup], [1080p], [DVD-BD ...], etc.
  str = str.replace(/\[[^\]]*\]/g, '');

  // 2. Remove parenthesized blocks except 4-digit release years like (1998) or (2024)
  str = str.replace(/\((?!\d{4}\b)[^)]*\)/g, '');

  // 3. Remove trailing release group: -CRUCiBLE, -EMBER, -VARYG, etc.
  str = str.replace(/-\s*[A-Za-z0-9_]+$/, '');

  // 4. Handle dots inside codec/audio tags before dot-splitting
  str = str
    .replace(/\b(h|x)\.26[45]\b/gi, 'codec')
    .replace(/\bflac\s*\d+\.\d+\b/gi, '')
    .replace(/\baac\s*\d+\.\d+\b/gi, '')
    .replace(/\bddp\s*\d+\.\d+\b/gi, '');

  // 5. If scene dot-spaced, replace dots with spaces
  const dotCount = (str.match(/\./g) || []).length;
  if (dotCount >= 2) {
    str = str.replace(/\./g, ' ');
  }

  // 6. Cut off at the first technical/scene junk token
  const junkPattern =
    /\b(2160p|4k|1080p|720p|576p|480p|bluray|bdrip|remux|web-dl|webrip|web|dvdrip|dvd|hdtv|hevc|x265|x264|h264|h265|avc|codec|10-?bit|8-?bit|hi10p|dual-?audio|multi-?audio|flac|aac|opus|2xopus|dts|ddp|ac3|atmos|repack|proper|netflix|crunchyroll|cr|funimation)\b/i;
  const match = str.match(junkPattern);
  if (match && match.index !== undefined) {
    str = str.substring(0, match.index);
  }

  // 7. Clean up whitespace and stray dashes/underscores
  str = str.replace(/\s+/g, ' ').trim();
  str = str.replace(/^[-_–—\s]+|[-_–—\s]+$/g, '');

  // 8. Beautify Season / Part tags
  // e.g. "Clevatess S01" -> "Clevatess (Season 1)"
  // e.g. "Jujutsu Kaisen S02" -> "Jujutsu Kaisen (Season 2)"
  const sMatch = str.match(/\bS(\d{1,2})\b/i);
  if (sMatch && sMatch.index !== undefined) {
    const sNum = parseInt(sMatch[1], 10);
    const baseName = str.substring(0, sMatch.index).trim().replace(/^[-_–—\s]+|[-_–—\s]+$/g, '');
    const after = str.substring(sMatch.index + sMatch[0].length).trim();
    if (after) {
      str = `${baseName} (Season ${sNum} ${after})`;
    } else {
      str = `${baseName} (Season ${sNum})`;
    }
  }

  return str.trim() || raw;
}

/**
 * Parses raw anime release filenames (e.g. [hchcsen] Haruhi S01E01 [DVD 576p x265...].mkv,
 * Clevatess.S01E01.REPACK.1080p..., Cowboy Bebop - 01 - Asteroid Blues.mkv)
 * into a clean, aesthetic episode structure with extracted quality tags.
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

  let name = filename.replace(/\.(mkv|mp4|avi|webm|ts)$/i, '');

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
  name = name.replace(/\[[0-9a-fA-F]{8}\]/g, '');

  // 3. Remove leading release group [Group] or (Group)
  name = name.replace(/^[\[\(][^\]\)]+[\]\)]\s*/, '');

  // 4. Remove trailing release group -GROUP or -CRUCiBLE
  name = name.replace(/-\s*[A-Za-z0-9_]+$/, '');

  // 5. Handle scene-style dot naming (e.g. Clevatess.S01E01.REPACK...)
  name = name
    .replace(/\b(h|x)\.26[45]\b/gi, 'codec')
    .replace(/\bflac\s*\d+\.\d+\b/gi, '')
    .replace(/\baac\s*\d+\.\d+\b/gi, '');

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
    /\b(2160p|4k|1080p|720p|576p|480p|bluray|bdrip|remux|web-dl|webrip|web|dvdrip|dvd|hdtv|hevc|x265|x264|h264|h265|avc|codec|10-?bit|8-?bit|hi10p|dual-?audio|multi-?audio|flac|aac|2xopus|opus|dts|ddp|ac3|repack|proper|cr|flac\d*|aac\d*|\d+ch|\d+\.\d+)\b/gi;
  name = name.replace(junkTokensRegex, '');

  // 8. Clean up whitespace and stray dashes
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^[-_–—\s]+|[-_–—\s]+$/g, '');

  // 9. Extract Season & Episode numbers
  let season: number | null = null;
  let episode: number | null = null;
  let episodeLabel = '';
  let series = '';
  let epTitle = '';

  const seMatch = name.match(/s(\d+)\s*e(\d+)/i);
  if (seMatch) {
    season = parseInt(seMatch[1], 10);
    episode = parseInt(seMatch[2], 10);
    episodeLabel = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    const idx = name.search(/s\d+\s*e\d+/i);
    series = name.substring(0, idx).trim().replace(/[-_–—\s]+$/, '');
    epTitle = name.substring(idx + seMatch[0].length).trim().replace(/^[-_–—\s]+/, '');
  } else {
    const dashMatch = name.match(/\s+-\s+(\d{1,4})(?:\s+-\s*|\s+|$)/);
    if (dashMatch) {
      episode = parseInt(dashMatch[1], 10);
      episodeLabel = `EP ${String(episode).padStart(2, '0')}`;
      const idx = name.indexOf(dashMatch[0]);
      series = name.substring(0, idx).trim();
      epTitle = name.substring(idx + dashMatch[0].length).trim().replace(/^[-_–—\s]+/, '');
    } else {
      const epMatch = name.match(/(?:ep|episode|e)\s*(\d+)/i);
      if (epMatch) {
        episode = parseInt(epMatch[1], 10);
        episodeLabel = `EP ${String(episode).padStart(2, '0')}`;
        const idx = name.search(/(?:ep|episode|e)\s*\d+/i);
        series = name.substring(0, idx).trim().replace(/[-_–—\s]+$/, '');
        epTitle = name.substring(idx + epMatch[0].length).trim().replace(/^[-_–—\s]+/, '');
      } else {
        series = name;
        episodeLabel = 'EP';
      }
    }
  }

  // 10. Secondary cleanup on epTitle
  epTitle = epTitle.replace(/^[-_–—\s:]+|[-_–—\s:]+$/g, '').trim();
  if (epTitle.length < 2 || /^(?:ep|e|s|part|\d+)$/i.test(epTitle)) {
    epTitle = '';
  }

  // 11. Format final clean display title
  let displayTitle = '';
  if (epTitle) {
    displayTitle = epTitle;
  } else if (episode !== null) {
    displayTitle = `Episode ${episode}`;
  } else {
    displayTitle = series || filename;
  }

  return {
    seriesTitle: series,
    episodeNumber: episode,
    seasonNumber: season,
    episodeLabel: episodeLabel || (episode !== null ? `EP ${String(episode).padStart(2, '0')}` : 'EP'),
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
  parsedDisplayTitle: string,
  apiTitle?: string | null
): string {
  if (!apiTitle || !apiTitle.trim()) {
    return parsedDisplayTitle;
  }
  const cleanApi = apiTitle.trim();
  const cleanParsed = (parsedDisplayTitle || '').trim();

  // If already identical or already contains the official title
  if (cleanParsed.toLowerCase() === cleanApi.toLowerCase()) {
    return cleanParsed;
  }
  if (cleanParsed.toLowerCase().includes(cleanApi.toLowerCase())) {
    return cleanParsed;
  }

  // If parsed title is generic "Episode X" or "EP X"
  if (/^(?:Episode|EP|E)\s*\d+/i.test(cleanParsed)) {
    return `${cleanParsed} — ${cleanApi}`;
  }

  return `${cleanParsed} — ${cleanApi}`;
}

