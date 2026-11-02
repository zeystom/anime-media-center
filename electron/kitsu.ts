import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { storage } from './storage';

export interface KitsuEpisodeInfo {
  number: number;
  title: string | null;
  synopsis: string | null;
  thumbnailUrl: string | null;
}

export interface KitsuAnimeCache {
  animeId: string;
  malId?: number | null;
  canonicalTitle: string;
  posterUrl: string | null;
  bannerUrl?: string | null;
  synopsis?: string | null;
  genres?: string[];
  averageScore?: number | null;
  episodes: Record<number, KitsuEpisodeInfo>;
  fetchedAt: number;
}

const memoryCache = new Map<string, KitsuAnimeCache | null>();

export interface AnimeSearchQueries {
  primary: string;
  fallback: string | null;
}

/**
 * Smartly constructs prioritized search queries from folder or release names:
 * - Season 2 / Part 2 / Final Season -> searches specifically with season identifier first,
 *   falling back to base title if specific season query yields nothing.
 * - Season 1 / Single-season -> searches base title first (how 99% of entries are named on AniList/MAL).
 */
export function buildAnimeSearchQueries(raw: string): AnimeSearchQueries {
  if (!raw) return { primary: '', fallback: null };
  let str = raw;

  // 1. Remove bracketed groups [CRUCiBLE], [1080p], etc.
  str = str.replace(/\[[^\]]*\]/g, '');

  // 2. Remove parenthesized blocks
  str = str.replace(/\([^)]*\)/g, '');

  // 3. Remove scene release group suffix
  str = str.replace(/-\s*[A-Za-z0-9_]+$/, '');

  // 4. Cut off at standard scene junk tokens
  const junkPattern =
    /\b(2160p|4k|1080p|720p|576p|480p|bluray|bdrip|remux|web-dl|webrip|web|dvdrip|dvd|hevc|x265|x264|h264|h265|avc|repack|dual-?audio)\b/i;
  const match = str.match(junkPattern);
  if (match && match.index !== undefined) {
    str = str.substring(0, match.index);
  }

  // 5. Replace dots, underscores, dashes with spaces
  str = str.replace(/[-_–—.]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Detect season / cour / part tokens
  const s2Match = str.match(/\bS0*([2-9]|\d{2,})\b/i) || str.match(/\bSeason\s*0*([2-9]|\d{2,})\b/i);
  const s1Match = str.match(/\bS0*1\b/i) || str.match(/\bSeason\s*0*1\b/i);
  const partMatch = str.match(/\b(Part|Cour)\s*0*(\d+)\b/i);
  const finalSeasonMatch = str.match(/\b(The\s+)?Final\s+Season\b/i);

  // Base title with all season/part tokens stripped
  const baseTitle = str
    .replace(/\bS\d{1,2}\b/gi, '')
    .replace(/\b(Season|Part|Cour)\s*\d+\b/gi, '')
    .replace(/\b(The\s+)?Final\s+Season\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (s2Match) {
    const sNum = parseInt(s2Match[1], 10);
    const partSuffix = partMatch ? ` Part ${partMatch[2]}` : '';
    const primary = `${baseTitle} Season ${sNum}${partSuffix}`.trim();
    return { primary, fallback: baseTitle || null };
  }

  if (finalSeasonMatch) {
    const partSuffix = partMatch ? ` Part ${partMatch[2]}` : '';
    const primary = `${baseTitle} The Final Season${partSuffix}`.trim();
    return { primary, fallback: baseTitle || null };
  }

  if (partMatch && !s1Match) {
    const primary = `${baseTitle} Part ${partMatch[2]}`.trim();
    return { primary, fallback: baseTitle || null };
  }

  return {
    primary: baseTitle || str,
    fallback: s1Match ? `${baseTitle} Season 1` : null,
  };
}

export function cleanKitsuQuery(raw: string): string {
  const { primary } = buildAnimeSearchQueries(raw);
  return primary || raw.trim();
}

/**
 * Parses AniList streaming episode title into episode number and English title.
 * Examples:
 *   "Episode 1 - The Lord of Dark Beasts" -> { number: 1, title: "The Lord of Dark Beasts" }
 *   "Episode 02 – The Beast Lord in Captivity" -> { number: 2, title: "The Beast Lord in Captivity" }
 *   "Ep 1: The Melancholy of Haruhi Suzumiya I" -> { number: 1, title: "The Melancholy of Haruhi Suzumiya I" }
 */
export function parseAniListEpisodeTitle(raw: string): { number: number; title: string } | null {
  if (!raw) return null;
  const match = raw.match(/^(?:Episode|Ep\.?|E)?\s*(\d+)\s*[-–—:.]\s*(.+)$/i);
  if (match) {
    const num = parseInt(match[1], 10);
    const title = match[2].trim();
    if (!isNaN(num) && title.length > 0) {
      return { number: num, title };
    }
  }
  return null;
}

/**
 * Fetches official English episode titles and streaming thumbnails from AniList GraphQL API.
 */
async function fetchAniListMetadata(query: string): Promise<{
  malId?: number | null;
  canonicalTitle: string;
  posterUrl: string | null;
  bannerUrl: string | null;
  synopsis: string | null;
  genres: string[];
  averageScore: number | null;
  episodes: Record<number, KitsuEpisodeInfo>;
} | null> {
  const gqlQuery = `
    query ($search: String) {
      Media(search: $search, type: ANIME) {
        id
        idMal
        title {
          romaji
          english
          native
        }
        bannerImage
        coverImage {
          extraLarge
          large
        }
        description
        genres
        averageScore
        streamingEpisodes {
          title
          thumbnail
        }
      }
    }
  `;

  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'AnimeMediaCenter/1.0',
      },
      body: JSON.stringify({
        query: gqlQuery,
        variables: { search: query },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;
    const json = await res.json();
    const media = json.data?.Media;
    if (!media) return null;

    const malId = media.idMal || null;
    const canonicalTitle = media.title?.english || media.title?.romaji || query;
    const posterUrl = media.coverImage?.extraLarge || media.coverImage?.large || null;
    const bannerUrl = media.bannerImage || null;
    const synopsis = media.description ? media.description.replace(/<[^>]+>/g, '').trim() : null;
    const genres = Array.isArray(media.genres) ? media.genres : [];
    const averageScore = typeof media.averageScore === 'number' ? media.averageScore : null;
    const episodes: Record<number, KitsuEpisodeInfo> = {};

    if (Array.isArray(media.streamingEpisodes)) {
      for (const ep of media.streamingEpisodes) {
        if (!ep.title) continue;
        const parsed = parseAniListEpisodeTitle(ep.title);
        if (parsed) {
          episodes[parsed.number] = {
            number: parsed.number,
            title: parsed.title,
            thumbnailUrl: ep.thumbnail || null,
            synopsis: null,
          };
        }
      }
    }

    return {
      malId,
      canonicalTitle,
      posterUrl,
      bannerUrl,
      synopsis,
      genres,
      averageScore,
      episodes,
    };
  } catch {
    return null;
  }
}

/**
 * Fetches community stills and episode metadata from Kitsu API.
 */
async function fetchKitsuMetadata(query: string): Promise<{
  animeId: string;
  canonicalTitle: string;
  posterUrl: string | null;
  episodes: Record<number, KitsuEpisodeInfo>;
} | null> {
  try {
    const searchUrl = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=1`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        Accept: 'application/vnd.api+json',
        'User-Agent': 'AnimeMediaCenter/1.0',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!searchRes.ok) return null;
    const searchJson = await searchRes.json();
    if (!searchJson.data || searchJson.data.length === 0) return null;

    const animeItem = searchJson.data[0];
    const animeId = String(animeItem.id);
    const canonicalTitle = animeItem.attributes?.canonicalTitle || query;
    const posterUrl = animeItem.attributes?.posterImage?.original || null;
    const episodes: Record<number, KitsuEpisodeInfo> = {};

    const epUrl1 = `https://kitsu.io/api/edge/episodes?filter[mediaId]=${animeId}&filter[mediaType]=Anime&page[limit]=50&page[offset]=0&sort=number`;
    const epRes1 = await fetch(epUrl1, {
      headers: {
        Accept: 'application/vnd.api+json',
        'User-Agent': 'AnimeMediaCenter/1.0',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (epRes1.ok) {
      const epJson1 = await epRes1.json();
      if (Array.isArray(epJson1.data)) {
        for (const ep of epJson1.data) {
          const num = ep.attributes?.number;
          if (typeof num === 'number') {
            const thumb =
              ep.attributes?.thumbnail?.original ||
              ep.attributes?.thumbnail?.large ||
              ep.attributes?.thumbnail?.medium ||
              null;
            const title =
              ep.attributes?.canonicalTitle ||
              ep.attributes?.titles?.en ||
              ep.attributes?.titles?.en_jp ||
              null;
            episodes[num] = {
              number: num,
              title: title && !/^(?:Episode|Ep)\s*\d+$/i.test(title) ? title : null,
              synopsis: ep.attributes?.synopsis || null,
              thumbnailUrl: thumb,
            };
          }
        }
      }
    }

    return {
      animeId,
      canonicalTitle,
      posterUrl,
      episodes,
    };
  } catch {
    return null;
  }
}

/**
 * Searches AniList & Kitsu for official English episode titles and high-res stills.
 * Caches results locally on disk for 14 days.
 */
export async function getKitsuMetadata(rawSeriesName: string): Promise<KitsuAnimeCache | null> {
  const { primary, fallback } = buildAnimeSearchQueries(rawSeriesName);
  if (!primary) return null;

  const cacheKey = crypto.createHash('md5').update(primary.toLowerCase()).digest('hex').slice(0, 16);

  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey) || null;
  }

  const cacheDir = storage.getMetadataCacheDir();
  const cacheFile = path.join(cacheDir, `kitsu_${cacheKey}.json`);

  // Check disk cache (valid for 14 days if it has non-empty episode data)
  if (fs.existsSync(cacheFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as KitsuAnimeCache;
      const hasEpisodeData = data.episodes && Object.keys(data.episodes).length > 0;
      if (hasEpisodeData && Date.now() - data.fetchedAt < 14 * 24 * 60 * 60 * 1000) {
        memoryCache.set(cacheKey, data);
        return data;
      }
    } catch {}
  }

  try {
    // 1. Try primary search query
    let [aniListResult, kitsuResult] = await Promise.allSettled([
      fetchAniListMetadata(primary),
      fetchKitsuMetadata(primary),
    ]);

    let aniList = aniListResult.status === 'fulfilled' ? aniListResult.value : null;
    let kitsu = kitsuResult.status === 'fulfilled' ? kitsuResult.value : null;

    // 2. If primary query found nothing and we have an alternative/fallback query, try fallback
    if (!aniList && !kitsu && fallback && fallback.toLowerCase() !== primary.toLowerCase()) {
      [aniListResult, kitsuResult] = await Promise.allSettled([
        fetchAniListMetadata(fallback),
        fetchKitsuMetadata(fallback),
      ]);
      aniList = aniListResult.status === 'fulfilled' ? aniListResult.value : null;
      kitsu = kitsuResult.status === 'fulfilled' ? kitsuResult.value : null;
    }

    if (!aniList && !kitsu) {
      memoryCache.set(cacheKey, null);
      return null;
    }

    const animeId = kitsu?.animeId || 'anilist';
    const canonicalTitle = aniList?.canonicalTitle || kitsu?.canonicalTitle || primary;
    const posterUrl = aniList?.posterUrl || kitsu?.posterUrl || null;

    // Merge episodes:
    // - Title: AniList English streaming title preferred, fallback to Kitsu title
    // - Thumbnail: Kitsu community still preferred (clean HD capture), fallback to AniList thumbnail
    const mergedEpisodes: Record<number, KitsuEpisodeInfo> = {};

    const allEpNumbers = new Set<number>([
      ...Object.keys(aniList?.episodes || {}).map(Number),
      ...Object.keys(kitsu?.episodes || {}).map(Number),
    ]);

    for (const epNum of allEpNumbers) {
      const aniEp = aniList?.episodes[epNum];
      const kitEp = kitsu?.episodes[epNum];

      const chosenTitle = aniEp?.title || kitEp?.title || null;
      const chosenThumb = kitEp?.thumbnailUrl || aniEp?.thumbnailUrl || null;
      const chosenSynopsis = kitEp?.synopsis || aniEp?.synopsis || null;

      mergedEpisodes[epNum] = {
        number: epNum,
        title: chosenTitle,
        thumbnailUrl: chosenThumb,
        synopsis: chosenSynopsis,
      };
    }

    const malId = aniList?.malId || null;
    const bannerUrl = aniList?.bannerUrl || null;
    const synopsis = aniList?.synopsis || null;
    const genres = aniList?.genres || [];
    const averageScore = aniList?.averageScore || null;

    const result: KitsuAnimeCache = {
      animeId,
      malId,
      canonicalTitle,
      posterUrl,
      bannerUrl,
      synopsis,
      genres,
      averageScore,
      episodes: mergedEpisodes,
      fetchedAt: Date.now(),
    };

    // Save to disk cache
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf-8');
    } catch {}

    memoryCache.set(cacheKey, result);
    return result;
  } catch (err) {
    // Network failure or timeout - silently return null for local fallback
    return null;
  }
}

/**
 * Fetches community opening and ending timestamps from AniSkip API (aniskip.com).
 * Uses MyAnimeList ID from AniList metadata.
 */
export async function fetchAniSkipTimes(
  rawSeriesName: string,
  episodeNum: number,
  episodeLength: number
): Promise<{ op?: { start: number; end: number }; ed?: { start: number; end: number } } | null> {
  try {
    const meta = await getKitsuMetadata(rawSeriesName);
    const malId = meta?.malId;
    if (!malId || episodeNum <= 0) return null;

    const lengthParam = episodeLength > 0 ? `&episodeLength=${Math.round(episodeLength)}` : '';
    const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episodeNum}?types=op&types=ed${lengthParam}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'AnimeMediaCenter/1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) return null;
    const json = await res.json();
    if (!json.found || !Array.isArray(json.results)) return null;

    const result: { op?: { start: number; end: number }; ed?: { start: number; end: number } } = {};
    for (const item of json.results) {
      if (item.skipType === 'op' && item.interval) {
        result.op = { start: item.interval.startTime, end: item.interval.endTime };
      } else if (item.skipType === 'ed' && item.interval) {
        result.ed = { start: item.interval.startTime, end: item.interval.endTime };
      }
    }
    return result;
  } catch {
    return null;
  }
}
