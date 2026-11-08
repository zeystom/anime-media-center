import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { storage } from './storage';
// Typography normalization is delegated to the shared parser core (wasm-free,
// safe to bundle in the main process).
// Source of truth: src/lib/releaseParser/regexEngine.ts
import { normalizeReleaseString } from '../src/lib/releaseParser/regexEngine.ts';
import { getFribbIndex, lookupAnilistIdByKitsu } from './fribb';

export interface KitsuEpisodeInfo {
  number: number;
  title: string | null;
  synopsis: string | null;
  thumbnailUrl: string | null;
}

export interface KitsuAnimeCache {
  animeId: string;
  malId?: number | null;
  anilistId?: number | null;
  canonicalTitle: string;
  posterUrl: string | null;
  bannerUrl?: string | null;
  synopsis?: string | null;
  genres?: string[];
  averageScore?: number | null;
  episodes: Record<number, KitsuEpisodeInfo>;
  fetchedAt: number;
}

const memoryCache = new Map<string, KitsuAnimeCache>();
const notFoundCache = new Map<string, number>(); // cacheKey -> expiresAt timestamp (1 hour TTL)
const inFlightRequests = new Map<string, Promise<KitsuAnimeCache | null>>();

export function isEnglishEpisodeTitle(title: unknown): title is string {
  return typeof title === 'string' && !!title.trim() && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(title);
}

function normalizeCachedEpisodeTitles(data: KitsuAnimeCache): KitsuAnimeCache {
  return {
    ...data,
    episodes: Object.fromEntries(
      Object.entries(data.episodes || {}).map(([number, episode]) => [number, {
        ...episode,
        title: isEnglishEpisodeTitle(episode.title) ? episode.title.trim() : null,
      }])
    ),
  };
}

export interface AnimeSearchQueries {
  primary: string;
  fallback: string | null;
  targetSeason: number | 'final' | null;
  targetPart: number | null;
}

function isSequelTitle(title: string): boolean {
  if (!title) return false;
  if (/\b(?:The\s+)?Final\s+Season\b/i.test(title)) return true;
  if (/\bSeason\s*0*([2-9]|\d{2,})\b/i.test(title)) return true;
  if (/\b([2-9]|\d{2,})(?:nd|rd|th)\s*Season\b/i.test(title)) return true;
  if (/\bSecond\s*Season\b/i.test(title)) return true;
  if (/\bThird\s*Season\b/i.test(title)) return true;
  if (/\bFourth\s*Season\b/i.test(title)) return true;
  if (/\b(?:II|III|IV|V|VI)\b/.test(title)) return true;
  return false;
}

/**
 * Smartly constructs prioritized search queries from folder or release names:
 * - Season 2 / Part 2 / Final Season -> searches specifically with season identifier first,
 *   falling back to base title if specific season query yields nothing.
 * - Season 1 / Single-season -> searches base title first (how 99% of entries are named on AniList/MAL).
 */
export function buildAnimeSearchQueries(raw: string): AnimeSearchQueries {
  if (!raw) return { primary: '', fallback: null, targetSeason: null, targetPart: null };
  let str = raw;

  // 1. Remove bracketed groups [CRUCiBLE], [1080p], etc.
  str = str.replace(/\[[^\]]*\]/g, '');

  // 2. Remove parenthesized blocks
  str = str.replace(/\([^)]*\)/g, '');

  // 3. Remove scene release group suffix
  str = str.replace(/-\s*[A-Za-z0-9_]+$/, '');

  // 4. Cut off at standard scene junk tokens
  const junkPattern =
    /\b(2160p|4k|1080p|720p|576p|480p|bluray|bdrip|remux|web-dl|webrip|web|dvdrip|dvd|hevc|x265|x264|h264|h265|avc|repack|dual-?audio|multi-?audio|dolby|truehd|atmos|dts|ddp\d*|flac|aac|opus)\b/i;
  const match = str.match(junkPattern);
  if (match && match.index !== undefined) {
    str = str.substring(0, match.index);
  }

  // 5. Unicode typography via the shared core (wave dashes, full-width digits,
  // interpuncts), then replace dots, underscores and remaining dashes with spaces.
  // NOTE: sanitizeMediaTags()/parseReleaseCore() are intentionally NOT used here —
  // they replace junk tokens with spaces instead of cutting at the first junk
  // token and strip trailing years/season markers from titles, both of which
  // would change the AniList/Kitsu search queries and sequel matching.
  str = normalizeReleaseString(str)
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Detect season / cour / part tokens accurately
  const seasonMatch = str.match(/\b(?:S|Season\s*)0*(\d+)\b/i);
  const targetSeason = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
  const partMatch = str.match(/\b(Part|Cour)\s*0*(\d+)\b/i);
  const targetPart = partMatch ? parseInt(partMatch[2], 10) : null;
  const finalSeasonMatch = /\b(?:The\s+)?Final\s+Season\b/i.test(str);

  // Base title with all season/part tokens stripped
  const baseTitle = str
    .replace(/\bS\d{1,2}\b/gi, '')
    .replace(/\b(Season|Part|Cour)\s*\d+\b/gi, '')
    .replace(/\b(The\s+)?Final\s+Season\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // ONLY treat as higher season if targetSeason >= 2!
  if (targetSeason !== null && targetSeason >= 2) {
    const partSuffix = targetPart ? ` Part ${targetPart}` : '';
    const primary = `${baseTitle} Season ${targetSeason}${partSuffix}`.trim();
    return { primary, fallback: baseTitle || null, targetSeason, targetPart };
  }

  if (finalSeasonMatch) {
    const partSuffix = targetPart ? ` Part ${targetPart}` : '';
    const primary = `${baseTitle} The Final Season${partSuffix}`.trim();
    return { primary, fallback: baseTitle || null, targetSeason: 'final', targetPart };
  }

  if (targetPart !== null && (targetSeason === null || targetSeason === 1)) {
    const primary = `${baseTitle} Part ${targetPart}`.trim();
    return { primary, fallback: baseTitle || null, targetSeason: targetSeason || 1, targetPart };
  }

  // For Season 1 or unnumbered base series:
  // 99% of entries on MAL / AniList / Kitsu are named purely by their base title (e.g. "Clevatess", "Death Note")
  return {
    primary: baseTitle || str,
    fallback: null,
    targetSeason: targetSeason || 1,
    targetPart: null,
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
    if (!isNaN(num) && isEnglishEpisodeTitle(title)) {
      return { number: num, title };
    }
  }
  return null;
}

/**
 * Fetches official English episode titles and streaming thumbnails from AniList GraphQL API.
 */
async function fetchAniListMetadata(
  query: string,
  targetSeason: number | 'final' | null = null,
  expectedEpisodes: number | null = null
): Promise<{
  malId?: number | null;
  anilistId: number | null;
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
      Page(page: 1, perPage: 5) {
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          id
          idMal
          episodes
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
    }
  `;

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

  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After');
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
    await new Promise((r) => setTimeout(r, Math.min(delay, 5000)));
    throw new Error('AniList rate limited (429)');
  }

  if (!res.ok) {
    throw new Error(`AniList returned HTTP ${res.status}`);
  }

  const json = await res.json();
  let mediaList: any[] = json.data?.Page?.media;
  if (!Array.isArray(mediaList) || mediaList.length === 0) return null;

  // A folder holding more files than the top search hit is usually a
  // rebroadcast/extended edition sharing its title with a shorter original
  // (Haruhi 2006 14-ep vs the 28-ep 2009 rebroadcast). Prefer the smallest
  // candidate that can hold every scanned file, then apply the season rules.
  if (expectedEpisodes != null && expectedEpisodes >= 2) {
    const covered = mediaList
      .filter((m) => typeof m.episodes === 'number' && m.episodes >= expectedEpisodes)
      .sort((a, b) => a.episodes - b.episodes);
    if (covered.length > 0) mediaList = covered;
  }

  // Pick best matching media candidate according to target season
  let media = mediaList[0];
  if (mediaList.length > 1) {
    if (targetSeason === 1 || targetSeason === null) {
      const nonSequel = mediaList.find((m) => {
        const t = m.title?.english || m.title?.romaji || '';
        return !isSequelTitle(t);
      });
      if (nonSequel) media = nonSequel;
    } else if (typeof targetSeason === 'number' && targetSeason >= 2) {
      const matching = mediaList.find((m) => {
        const t = m.title?.english || m.title?.romaji || '';
        return (
          new RegExp(`\\b(?:Season\\s*0*${targetSeason}|${targetSeason}(?:nd|rd|th)\\s*Season)\\b`, 'i').test(t) ||
          (targetSeason === 2 && /\b(?:II|Second\s*Season)\b/i.test(t)) ||
          (targetSeason === 3 && /\b(?:III|Third\s*Season)\b/i.test(t)) ||
          (targetSeason === 4 && /\b(?:IV|Fourth\s*Season)\b/i.test(t))
        );
      });
      if (matching) media = matching;
    }
  }

  const malId = media.idMal || null;
  const anilistId = typeof media.id === 'number' ? media.id : null;
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
    anilistId,
    canonicalTitle,
    posterUrl,
    bannerUrl,
    synopsis,
    genres,
    averageScore,
    episodes,
  };
}

/** Direct AniList fetch by id — used by the Kitsu→AniList identity bridge,
 *  where the crosswalk already pinned the exact entry and a text search
 *  (which failed for this title in the first place) must not run again. */
async function fetchAniListMetadataById(
  anilistId: number,
  expectedEpisodes: number | null = null
): Promise<{
  malId?: number | null;
  anilistId: number | null;
  canonicalTitle: string;
  posterUrl: string | null;
  bannerUrl: string | null;
  synopsis: string | null;
  genres: string[];
  averageScore: number | null;
  episodes: Record<number, KitsuEpisodeInfo>;
} | null> {
  const gqlQuery = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        idMal
        episodes
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
    }`;

  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'AnimeMediaCenter/1.0',
    },
    body: JSON.stringify({ query: gqlQuery, variables: { id: anilistId } }),
    signal: AbortSignal.timeout(5000),
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After');
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
    await new Promise((r) => setTimeout(r, Math.min(delay, 5000)));
    throw new Error('AniList rate limited (429)');
  }

  if (!res.ok) {
    throw new Error(`AniList returned HTTP ${res.status}`);
  }

  const json = await res.json();
  const media = json.data?.Media;
  if (!media || typeof media.id !== 'number') return null;
  // Crosswalk sanity: a bridged entry must plausibly hold every scanned file.
  if (expectedEpisodes != null && typeof media.episodes === 'number' && media.episodes < expectedEpisodes) {
    return null;
  }

  const canonicalTitle = media.title?.english || media.title?.romaji || `AniList ${anilistId}`;
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
    malId: media.idMal || null,
    anilistId: media.id,
    canonicalTitle,
    posterUrl,
    bannerUrl,
    synopsis,
    genres,
    averageScore,
    episodes,
  };
}

/**
 * Fetches community stills and episode metadata from Kitsu API.
 */
async function fetchKitsuMetadata(
  query: string,
  targetSeason: number | 'final' | null = null
): Promise<{
  animeId: string;
  canonicalTitle: string;
  posterUrl: string | null;
  synopsis: string | null;
  episodes: Record<number, KitsuEpisodeInfo>;
} | null> {
  const searchUrl = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=5`;
  const searchRes = await fetch(searchUrl, {
    headers: {
      Accept: 'application/vnd.api+json',
      'User-Agent': 'AnimeMediaCenter/1.0',
    },
    signal: AbortSignal.timeout(5000),
  });

  if (searchRes.status === 429) {
    const retryAfter = searchRes.headers.get('Retry-After');
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
    await new Promise((r) => setTimeout(r, Math.min(delay, 5000)));
    throw new Error('Kitsu rate limited (429)');
  }

  if (!searchRes.ok) {
    throw new Error(`Kitsu returned HTTP ${searchRes.status}`);
  }

  const searchJson = await searchRes.json();
  if (!searchJson.data || searchJson.data.length === 0) return null;

  let animeItem = searchJson.data[0];
  if (searchJson.data.length > 1) {
    if (targetSeason === 1 || targetSeason === null) {
      const nonSequel = searchJson.data.find((item: any) => {
        const t =
          item.attributes?.titles?.en ||
          item.attributes?.titles?.en_jp ||
          item.attributes?.canonicalTitle ||
          '';
        return !isSequelTitle(t);
      });
      if (nonSequel) animeItem = nonSequel;
    } else if (typeof targetSeason === 'number' && targetSeason >= 2) {
      const matching = searchJson.data.find((item: any) => {
        const t =
          item.attributes?.titles?.en ||
          item.attributes?.titles?.en_jp ||
          item.attributes?.canonicalTitle ||
          '';
        return (
          new RegExp(`\\b(?:Season\\s*0*${targetSeason}|${targetSeason}(?:nd|rd|th)\\s*Season)\\b`, 'i').test(t) ||
          (targetSeason === 2 && /\b(?:II|Second\s*Season)\b/i.test(t)) ||
          (targetSeason === 3 && /\b(?:III|Third\s*Season)\b/i.test(t)) ||
          (targetSeason === 4 && /\b(?:IV|Fourth\s*Season)\b/i.test(t))
        );
      });
      if (matching) animeItem = matching;
    }
  }

  const animeId = animeItem.id;
  const canonicalTitle =
    animeItem.attributes?.titles?.en ||
    animeItem.attributes?.canonicalTitle ||
    animeItem.attributes?.titles?.en_jp ||
    query;
  const synopsis = typeof animeItem.attributes?.synopsis === 'string'
    ? animeItem.attributes.synopsis.replace(/<[^>]+>/g, '').trim() || null
    : null;

  const posterUrl =
    animeItem.attributes?.posterImage?.large ||
    animeItem.attributes?.posterImage?.original ||
    null;

  // Fetch episodes from Kitsu with pagination loop (so series with >50 episodes get complete metadata)
  const episodes: Record<number, KitsuEpisodeInfo> = {};
  let offset = 0;
  const limit = 50;
  const maxEpisodes = 1500;

  while (offset < maxEpisodes) {
    try {
      const epUrl = `https://kitsu.io/api/edge/anime/${animeId}/episodes?page[limit]=${limit}&page[offset]=${offset}&sort=number`;
      const epRes = await fetch(epUrl, {
        headers: {
          Accept: 'application/vnd.api+json',
          'User-Agent': 'AnimeMediaCenter/1.0',
        },
        signal: AbortSignal.timeout(6000),
      });

      if (!epRes.ok) break;
      const epJson = await epRes.json();
      if (!Array.isArray(epJson.data) || epJson.data.length === 0) break;

      for (const item of epJson.data) {
        const attrs = item.attributes;
        const num = attrs.number;
        if (num) {
          episodes[num] = {
            number: num,
            title: [attrs.titles?.en, attrs.titles?.en_us, attrs.canonicalTitle]
              .find(isEnglishEpisodeTitle)?.trim() || null,
            synopsis: attrs.synopsis || null,
            thumbnailUrl: attrs.thumbnail?.original || attrs.thumbnail?.large || null,
          };
        }
      }

      if (epJson.data.length < limit || !epJson.links?.next) {
        break;
      }
      offset += limit;
    } catch {
      break;
    }
  }

  return {
    animeId,
    canonicalTitle,
    posterUrl,
    synopsis,
    episodes,
  };
}

/**
 * Searches AniList & Kitsu for official English episode titles and high-res stills.
 * Caches results locally on disk for 14 days (including movies/OVAs without episodes).
 * Deduplicates concurrent requests and manages negative cache (1 hour).
 */
export async function getKitsuMetadata(rawSeriesName: string, expectedEpisodes: number | null = null): Promise<KitsuAnimeCache | null> {
  const { primary, fallback, targetSeason } = buildAnimeSearchQueries(rawSeriesName);
  if (!primary) return null;

  // Expected episode count participates in the cache key: the same folder
  // name must resolve differently for a 14-file original and a 28-file
  // rebroadcast, so a cached entry produced without the hint must not be
  // served to a scan that knows better.
  const cacheKey = crypto
    .createHash('md5')
    .update(`${primary.toLowerCase()}|${expectedEpisodes ?? ''}`)
    .digest('hex')
    .slice(0, 16);

  // 1. In-memory positive cache
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey)!;
  }

  // 2. In-memory negative cache (1 hour TTL for verified 0-result)
  const notFoundExpires = notFoundCache.get(cacheKey);
  if (notFoundExpires && Date.now() < notFoundExpires) {
    return null;
  }

  // 3. Disk cache (valid for 14 days, including records without episode data such as movies and OVAs)
  const cacheDir = storage.getMetadataCacheDir();
  const cacheFile = path.join(cacheDir, `kitsu_${cacheKey}.json`);
  let staleCache: KitsuAnimeCache | null = null;

  if (fs.existsSync(cacheFile)) {
    try {
      const data = normalizeCachedEpisodeTitles(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as KitsuAnimeCache);
      if (data.fetchedAt && Date.now() - data.fetchedAt < 14 * 24 * 60 * 60 * 1000) {
        // Older partial cache records may have a poster but no overview or
        // AniList identity. Revalidate those so the library can repair itself.
        if (data.anilistId != null && data.synopsis?.trim()) {
          memoryCache.set(cacheKey, data);
          return data;
        }
        staleCache = data;
      }
    } catch {}
  }

  // 4. Request deduplication for concurrent lookups
  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey)!;
  }

  const fetchPromise = (async () => {
    try {
      let aniListSuccess = false;
      let kitsuSuccess = false;

      // Primary query
      const [aniListResult, kitsuResult] = await Promise.allSettled([
        fetchAniListMetadata(primary, targetSeason, expectedEpisodes),
        fetchKitsuMetadata(primary, targetSeason),
      ]);

      let aniList = null;
      let kitsu = null;

      if (aniListResult.status === 'fulfilled') {
        aniList = aniListResult.value;
        aniListSuccess = true;
      }
      if (kitsuResult.status === 'fulfilled') {
        kitsu = kitsuResult.value;
        kitsuSuccess = true;
      }

      // Fallback query if primary produced no matches
      if (!aniList && !kitsu && fallback && fallback.toLowerCase() !== primary.toLowerCase()) {
        const [aniListFb, kitsuFb] = await Promise.allSettled([
          fetchAniListMetadata(fallback, targetSeason, expectedEpisodes),
          fetchKitsuMetadata(fallback, targetSeason),
        ]);
        if (aniListFb.status === 'fulfilled') {
          aniList = aniListFb.value;
          aniListSuccess = true;
        }
        if (kitsuFb.status === 'fulfilled') {
          kitsu = kitsuFb.value;
          kitsuSuccess = true;
        }
      }

      // Kitsu identity bridge: Kitsu found the show but the AniList text
      // search came up empty. Long Crunchyroll-style folder names defeat
      // AniList's search index (observed live: "Clevatess: The King of Devil
      // Beasts Season 2" → 0 hits for every query variant, while the Kitsu
      // entry matched). Bridge the identity through the local Fribb
      // crosswalk (kitsu_id → anilist_id) and fetch the AniList entry
      // directly by id.
      if (!aniList && kitsu?.animeId) {
        const kitsuIdNum = Number(kitsu.animeId);
        if (Number.isInteger(kitsuIdNum) && kitsuIdNum > 0) {
          try {
            await getFribbIndex();
            const bridgedAnilistId = lookupAnilistIdByKitsu(kitsuIdNum);
            if (bridgedAnilistId != null) {
              const byId = await fetchAniListMetadataById(bridgedAnilistId, expectedEpisodes);
              if (byId) {
                aniList = byId;
                aniListSuccess = true;
                console.info(`[Kitsu] AniList identity bridged via Fribb: kitsu ${kitsuIdNum} → anilist ${bridgedAnilistId}`);
              }
            }
          } catch (err: any) {
            console.warn('[Kitsu] AniList bridge via Fribb failed:', err?.message || err);
          }
        }
      }

      // If both completed with 200 OK without errors but returned 0 results:
      if (!aniList && !kitsu) {
        if (aniListSuccess && kitsuSuccess) {
          notFoundCache.set(cacheKey, Date.now() + 60 * 60 * 1000); // 1 hour negative cache
        }
        return staleCache;
      }

      const animeId = kitsu?.animeId || 'anilist';
      const canonicalTitle = aniList?.canonicalTitle || kitsu?.canonicalTitle || primary;
      const posterUrl = aniList?.posterUrl || kitsu?.posterUrl || null;

      // Merge episodes
      const mergedEpisodes: Record<number, KitsuEpisodeInfo> = {};
      const allEpNumbers = new Set<number>([
        ...Object.keys(aniList?.episodes || {}).map(Number),
        ...Object.keys(kitsu?.episodes || {}).map(Number),
      ]);

      for (const epNum of allEpNumbers) {
        const aniEp = aniList?.episodes[epNum];
        const kitEp = kitsu?.episodes[epNum];

        mergedEpisodes[epNum] = {
          number: epNum,
          title: [aniEp?.title, kitEp?.title].find(isEnglishEpisodeTitle)?.trim() || null,
          thumbnailUrl: kitEp?.thumbnailUrl || aniEp?.thumbnailUrl || null,
          synopsis: kitEp?.synopsis || aniEp?.synopsis || null,
        };
      }

      const malId = aniList?.malId || null;
      const anilistId = aniList?.anilistId ?? null;
      const bannerUrl = aniList?.bannerUrl || null;
      const synopsis = aniList?.synopsis || kitsu?.synopsis || null;
      const genres = aniList?.genres || [];
      const averageScore = aniList?.averageScore || null;

      const result: KitsuAnimeCache = {
        animeId,
        malId,
        anilistId,
        canonicalTitle,
        posterUrl,
        bannerUrl,
        synopsis,
        genres,
        averageScore,
        episodes: mergedEpisodes,
        fetchedAt: Date.now(),
      };

      // Persist to disk cache
      try {
        fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf-8');
      } catch {}

      memoryCache.set(cacheKey, result);
      return result;
    } catch {
      // On network failure or abort, do not cache null
      return staleCache;
    }
  })();

  inFlightRequests.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightRequests.delete(cacheKey);
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
