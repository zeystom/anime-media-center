/**
 * Minimal AniList GraphQL client for the catalog service.
 *
 * AniList allows roughly 30 requests per minute per IP, so every request flows
 * through a serialized queue that spaces requests ~1100ms apart. Individual
 * requests use an 8s timeout, honor 429 + Retry-After (capped at 10s, retried
 * once), and surface non-OK responses as thrown errors with the HTTP status.
 */

export interface AniListTitle {
  romaji: string | null;
  english: string | null;
  native: string | null;
}

export interface AniListTag {
  name: string;
  rank: number | null;
}

export interface AniListNextAiringEpisode {
  episode: number;
  airingAt: number;
  timeUntilAiring: number;
}

/** Raw AniList media object as returned by the MEDIA_FIELDS fragment below. */
export interface AniListMedia {
  id: number;
  idMal: number | null;
  title: AniListTitle | null;
  synonyms: string[] | null;
  coverImage: { extraLarge: string | null; large: string | null } | null;
  bannerImage: string | null;
  description: string | null;
  genres: string[] | null;
  tags: AniListTag[] | null;
  averageScore: number | null;
  episodes: number | null;
  duration: number | null;
  format: string | null;
  status: string | null;
  season: string | null;
  seasonYear: number | null;
  nextAiringEpisode: AniListNextAiringEpisode | null;
  studios: { nodes: { name: string }[] } | null;
}

/** Raw AniList airing schedule entry (media fragment included). */
export interface AniListAiringScheduleEntry {
  episode: number | null;
  airingAt: number;
  media: AniListMedia | null;
}

/** Raw AniList recommendation node (a Media pointing at the recommended Media). */
export interface AniListRecommendation {
  rating: number | null;
  mediaRecommendation: AniListMedia | null;
}

export type AniListSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message?: string }[] | null;
}

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
// AniList rate limit is ~30 req/min; 1100ms spacing keeps us just under it.
// Overridable via ANILIST_MIN_SPACING_MS (mainly for fast offline test runs).
const parsedSpacing = parseInt(process.env.ANILIST_MIN_SPACING_MS || '', 10);
const MIN_REQUEST_SPACING_MS = Number.isFinite(parsedSpacing) && parsedSpacing >= 0 ? parsedSpacing : 1100;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RETRY_AFTER_MS = 10000;
const DEFAULT_RETRY_AFTER_MS = 2000;
const MAX_PER_PAGE = 50; // AniList hard cap for Page.perPage
const MAX_AIRING_SCHEDULE_PAGES = 20; // safety cap for the pagination loop

const MEDIA_FIELDS_FRAGMENT = `
  fragment MediaFields on Media {
    id
    idMal
    title {
      romaji
      english
      native
    }
    synonyms
    coverImage {
      extraLarge
      large
    }
    bannerImage
    description
    genres
    tags {
      name
      rank
    }
    averageScore
    episodes
    duration
    format
    status
    season
    seasonYear
    nextAiringEpisode {
      episode
      airingAt
      timeUntilAiring
    }
    studios(isMain: true) {
      nodes {
        name
      }
    }
  }
`;

const TRENDING_QUERY = `
  query ($page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
        ...MediaFields
      }
    }
  }
  ${MEDIA_FIELDS_FRAGMENT}
`;

const POPULAR_SEASON_QUERY = `
  query ($season: MediaSeason, $seasonYear: Int, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
        ...MediaFields
      }
    }
  }
  ${MEDIA_FIELDS_FRAGMENT}
`;

const ALL_TIME_POPULAR_QUERY = `
  query ($page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
        ...MediaFields
      }
    }
  }
  ${MEDIA_FIELDS_FRAGMENT}
`;

const AIRING_SCHEDULE_QUERY = `
  query ($airingAt_greater: Int, $airingAt_lesser: Int, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      airingSchedules(airingAt_greater: $airingAt_greater, airingAt_lesser: $airingAt_lesser) {
        episode
        airingAt
        media {
          ...MediaFields
        }
      }
    }
  }
  ${MEDIA_FIELDS_FRAGMENT}
`;

// NOTE: recommendations is a connection; `nodes { rating mediaRecommendation }` is
// the verified live shape (verified against graphql.anilist.co, mediaRecommendation
// is not queryable directly on the connection).
const RECOMMENDATIONS_QUERY = `
  query ($ids: [Int], $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(id_in: $ids, type: ANIME) {
        recommendations {
          nodes {
            rating
            mediaRecommendation {
              ...MediaFields
            }
          }
        }
      }
    }
  }
  ${MEDIA_FIELDS_FRAGMENT}
`;

const SEARCH_QUERY = `
  query ($search: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
        ...MediaFields
      }
    }
  }
  ${MEDIA_FIELDS_FRAGMENT}
`;

const DETAILS_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      ...MediaFields
    }
  }
  ${MEDIA_FIELDS_FRAGMENT}
`;

// --- Serialized request queue ----------------------------------------------

let queueTail: Promise<unknown> = Promise.resolve();
let lastRequestStartedAt = 0;

/**
 * Runs `task` in a serialized queue, waiting until at least
 * MIN_REQUEST_SPACING_MS elapsed since the previous request started. Queue
 * chain errors are swallowed so one failing request cannot stall later ones.
 */
function enqueueRequest<T>(task: () => Promise<T>): Promise<T> {
  const result = queueTail.then(async () => {
    const waitMs = lastRequestStartedAt + MIN_REQUEST_SPACING_MS - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastRequestStartedAt = Date.now();
    return task();
  });
  queueTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Performs a single (or retried) POST against the AniList GraphQL endpoint.
 * Throws Error with the HTTP status on non-OK responses.
 */
async function performAniListRequest<T>(query: string, variables: Record<string, unknown>, allowRetry: boolean): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ANILIST_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'AnimeMediaCenter/1.0',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new Error(`AniList request failed: ${err?.message || err}`);
  }

  if (res.status === 429) {
    if (!allowRetry) {
      throw new Error('AniList rate limited (429)');
    }
    // Honor Retry-After (capped) and retry once, mirroring kitsu.ts behavior.
    const retryAfter = res.headers.get('Retry-After');
    const parsed = parseInt(retryAfter || '', 10);
    const delayMs = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed * 1000, MAX_RETRY_AFTER_MS) : DEFAULT_RETRY_AFTER_MS;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return performAniListRequest<T>(query, variables, false);
  }

  if (!res.ok) {
    throw new Error(`AniList returned HTTP ${res.status}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new Error(`AniList GraphQL error: ${json.errors[0]?.message || 'unknown error'}`);
  }
  if (!json.data) {
    throw new Error('AniList returned no data');
  }
  return json.data;
}

/**
 * Runs an AniList GraphQL query and resolves with the `data` payload.
 * Requests are queued (min ~1100ms spacing) and 429s retried once.
 */
export async function runAniListQuery<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  return enqueueRequest(() => performAniListRequest<T>(query, variables, true));
}

// --- Typed query helpers ----------------------------------------------------

function clampPerPage(perPage: number, fallback: number): number {
  const n = Math.floor(Number(perPage));
  if (!Number.isFinite(n) || n <= 0) {
    return Math.min(fallback, MAX_PER_PAGE);
  }
  return Math.min(n, MAX_PER_PAGE);
}

interface PageMediaResult {
  Page?: { media?: (AniListMedia | null)[] | null } | null;
}

/**
 * Fetches currently trending anime sorted by TRENDING_DESC.
 */
export async function queryTrending(perPage = 24): Promise<AniListMedia[]> {
  const data = await runAniListQuery<PageMediaResult>(TRENDING_QUERY, {
    page: 1,
    perPage: clampPerPage(perPage, 24),
  });
  return (data.Page?.media ?? []).filter((m): m is AniListMedia => !!m);
}

/**
 * Fetches the most popular anime of a given season/year (POPULARITY_DESC).
 */
export async function queryPopularSeason(season: AniListSeason, seasonYear: number, perPage = 24): Promise<AniListMedia[]> {
  const data = await runAniListQuery<PageMediaResult>(POPULAR_SEASON_QUERY, {
    season,
    seasonYear,
    page: 1,
    perPage: clampPerPage(perPage, 24),
  });
  return (data.Page?.media ?? []).filter((m): m is AniListMedia => !!m);
}

/**
 * Fetches all-time popular anime (POPULARITY_DESC, no season filter).
 */
export async function queryAllTimePopular(perPage = 24): Promise<AniListMedia[]> {
  const data = await runAniListQuery<PageMediaResult>(ALL_TIME_POPULAR_QUERY, {
    page: 1,
    perPage: clampPerPage(perPage, 24),
  });
  return (data.Page?.media ?? []).filter((m): m is AniListMedia => !!m);
}

/**
 * Fetches airing schedule entries in the [fromUnix, toUnix] window (seconds),
 * paginating automatically (50/page, up to 20 pages / 1000 entries) since a
 * full week of airings routinely exceeds a single page.
 */
export async function queryAiringSchedule(fromUnix: number, toUnix: number, perPage = 50): Promise<AniListAiringScheduleEntry[]> {
  const pageSize = clampPerPage(perPage, 50);
  const all: AniListAiringScheduleEntry[] = [];
  for (let page = 1; page <= MAX_AIRING_SCHEDULE_PAGES; page++) {
    const data = await runAniListQuery<{ Page?: { airingSchedules?: (AniListAiringScheduleEntry | null)[] | null } | null }>(
      AIRING_SCHEDULE_QUERY,
      { airingAt_greater: Math.floor(fromUnix), airingAt_lesser: Math.ceil(toUnix), page, perPage: pageSize }
    );
    const entries = data.Page?.airingSchedules ?? [];
    for (const entry of entries) {
      if (entry && entry.media) all.push(entry);
    }
    if (entries.length < pageSize) break;
  }
  return all;
}

/**
 * Fetches media recommended for the given seed AniList IDs (flattened across
 * all seeds; seeds are chunked in groups of 50 because of the perPage cap).
 */
export async function queryRecommendations(seedAnilistIds: number[]): Promise<AniListMedia[]> {
  const ids = (Array.isArray(seedAnilistIds) ? seedAnilistIds : []).filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return [];

  const results: AniListMedia[] = [];
  for (let offset = 0; offset < ids.length; offset += MAX_PER_PAGE) {
    const chunk = ids.slice(offset, offset + MAX_PER_PAGE);
    const data = await runAniListQuery<{
      Page?: { media?: { recommendations?: { nodes?: (AniListRecommendation | null)[] | null } | null }[] | null } | null;
    }>(RECOMMENDATIONS_QUERY, {
      ids: chunk,
      page: 1,
      perPage: clampPerPage(chunk.length, 24),
    });
    const media = data.Page?.media ?? [];
    for (const m of media) {
      const nodes = m?.recommendations?.nodes ?? [];
      for (const node of nodes) {
        const rec = node?.mediaRecommendation;
        if (rec && rec.id) {
          results.push(rec);
        }
      }
    }
  }
  return results;
}

/**
 * Searches AniList for anime matching `search` (SEARCH_MATCH sort).
 */
export async function querySearch(search: string, perPage = 24): Promise<AniListMedia[]> {
  const data = await runAniListQuery<PageMediaResult>(SEARCH_QUERY, {
    search,
    page: 1,
    perPage: clampPerPage(perPage, 24),
  });
  return (data.Page?.media ?? []).filter((m): m is AniListMedia => !!m);
}

/**
 * Fetches a single anime's full details by AniList ID (null if not found).
 */
export async function queryDetails(id: number): Promise<AniListMedia | null> {
  const data = await runAniListQuery<{ Media?: AniListMedia | null } | null>(DETAILS_QUERY, { id });
  return data?.Media ?? null;
}
