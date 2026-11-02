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
  canonicalTitle: string;
  posterUrl: string | null;
  episodes: Record<number, KitsuEpisodeInfo>;
  fetchedAt: number;
}

const memoryCache = new Map<string, KitsuAnimeCache | null>();

/**
 * Normalizes an anime folder name or release title into a clean search query for Kitsu.
 * Strips release groups, quality brackets, S01/Season 1 indicators, etc.
 */
export function cleanKitsuQuery(raw: string): string {
  if (!raw) return '';
  let str = raw;

  // 1. Remove bracketed groups [CRUCiBLE], [1080p], etc.
  str = str.replace(/\[[^\]]*\]/g, '');

  // 2. Remove parenthesized blocks
  str = str.replace(/\([^)]*\)/g, '');

  // 3. Remove scene release group suffix
  str = str.replace(/-\s*[A-Za-z0-9_]+$/, '');

  // 4. Remove season / part tokens: S01, Season 1, Part 1, Cour 2...
  str = str.replace(/\bS\d{1,2}\b/gi, '');
  str = str.replace(/\b(Season|Part|Cour)\s*\d+\b/gi, '');

  // 5. Replace dots, underscores, dashes with spaces
  str = str.replace(/[-_–—.]+/g, ' ');

  // 6. Cut off at standard scene junk tokens
  const junkPattern =
    /\b(2160p|4k|1080p|720p|576p|480p|bluray|bdrip|remux|web-dl|webrip|web|dvdrip|dvd|hevc|x265|x264|h264|h265|avc|repack|dual-?audio)\b/i;
  const match = str.match(junkPattern);
  if (match && match.index !== undefined) {
    str = str.substring(0, match.index);
  }

  str = str.replace(/\s+/g, ' ').trim();
  return str.length >= 2 ? str : raw.trim();
}

/**
 * Searches Kitsu API for anime series metadata and episode stills.
 * Caches results locally on disk for 14 days.
 */
export async function getKitsuMetadata(rawSeriesName: string): Promise<KitsuAnimeCache | null> {
  const query = cleanKitsuQuery(rawSeriesName);
  if (!query) return null;

  const cacheKey = crypto.createHash('md5').update(query.toLowerCase()).digest('hex').slice(0, 16);

  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey) || null;
  }

  const cacheDir = storage.getMetadataCacheDir();
  const cacheFile = path.join(cacheDir, `kitsu_${cacheKey}.json`);

  // Check disk cache (valid for 14 days)
  if (fs.existsSync(cacheFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as KitsuAnimeCache;
      if (Date.now() - data.fetchedAt < 14 * 24 * 60 * 60 * 1000) {
        memoryCache.set(cacheKey, data);
        return data;
      }
    } catch {}
  }

  try {
    // 1. Search Anime ID by Query
    const searchUrl = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=1`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        'Accept': 'application/vnd.api+json',
        'User-Agent': 'AnimeMediaCenter/1.0',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!searchRes.ok) {
      memoryCache.set(cacheKey, null);
      return null;
    }

    const searchJson = await searchRes.json();
    if (!searchJson.data || searchJson.data.length === 0) {
      memoryCache.set(cacheKey, null);
      return null;
    }

    const animeItem = searchJson.data[0];
    const animeId = animeItem.id;
    const canonicalTitle = animeItem.attributes?.canonicalTitle || query;
    const posterUrl = animeItem.attributes?.posterImage?.original || null;

    // 2. Fetch Episodes for this Anime (first page up to 50)
    const episodes: Record<number, KitsuEpisodeInfo> = {};

    const epUrl1 = `https://kitsu.io/api/edge/episodes?filter[mediaId]=${animeId}&page[limit]=50&page[offset]=0&sort=number`;
    const epRes1 = await fetch(epUrl1, {
      headers: {
        'Accept': 'application/vnd.api+json',
        'User-Agent': 'AnimeMediaCenter/1.0',
      },
      signal: AbortSignal.timeout(6000),
    });

    if (epRes1.ok) {
      const epJson1 = await epRes1.json();
      if (epJson1.data) {
        for (const ep of epJson1.data) {
          const num = ep.attributes?.number;
          if (typeof num === 'number') {
            const thumb =
              ep.attributes?.thumbnail?.original ||
              ep.attributes?.thumbnail?.large ||
              ep.attributes?.thumbnail?.medium ||
              null;
            episodes[num] = {
              number: num,
              title:
                ep.attributes?.canonicalTitle ||
                ep.attributes?.titles?.en ||
                ep.attributes?.titles?.en_jp ||
                null,
              synopsis: ep.attributes?.synopsis || null,
              thumbnailUrl: thumb,
            };
          }
        }
      }

      // If more than 50 episodes, fetch page 2
      const totalCount = epJson1.meta?.count || 0;
      if (totalCount > 50) {
        try {
          const epUrl2 = `https://kitsu.io/api/edge/episodes?filter[mediaId]=${animeId}&page[limit]=50&page[offset]=50&sort=number`;
          const epRes2 = await fetch(epUrl2, {
            headers: {
              'Accept': 'application/vnd.api+json',
              'User-Agent': 'AnimeMediaCenter/1.0',
            },
            signal: AbortSignal.timeout(6000),
          });
          if (epRes2.ok) {
            const epJson2 = await epRes2.json();
            if (epJson2.data) {
              for (const ep of epJson2.data) {
                const num = ep.attributes?.number;
                if (typeof num === 'number') {
                  const thumb =
                    ep.attributes?.thumbnail?.original ||
                    ep.attributes?.thumbnail?.large ||
                    ep.attributes?.thumbnail?.medium ||
                    null;
                  episodes[num] = {
                    number: num,
                    title:
                      ep.attributes?.canonicalTitle ||
                      ep.attributes?.titles?.en ||
                      ep.attributes?.titles?.en_jp ||
                      null,
                    synopsis: ep.attributes?.synopsis || null,
                    thumbnailUrl: thumb,
                  };
                }
              }
            }
          }
        } catch {}
      }
    }

    const result: KitsuAnimeCache = {
      animeId,
      canonicalTitle,
      posterUrl,
      episodes,
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
