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
  type?: string;
  idMal: number | null;
  countryOfOrigin: string | null;
  title: AniListTitle | null;
  synonyms: string[] | null;
  coverImage: { extraLarge: string | null; large: string | null } | null;
  bannerImage: string | null;
  description: string | null;
  genres: string[] | null;
  tags: AniListTag[] | null;
  averageScore: number | null;
  popularity: number | null;
  trending: number | null;
  episodes: number | null;
  duration: number | null;
  format: string | null;
  status: string | null;
  isAdult?: boolean;
  season: string | null;
  seasonYear: number | null;
  startDate: AniListDate | null;
  nextAiringEpisode: AniListNextAiringEpisode | null;
  studios: { nodes: { name: string }[] } | null;
  relations?: { edges: { relationType: string; node: AniListMedia | null }[] } | null;
}

/** Raw AniList FuzzyDateInt triple (year/month/day may be individually null). */
export interface AniListDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

export interface AniListFranchiseNode {
  id: number;
  type?: string;
  relations?: { edges: { relationType: string; node: AniListFranchiseNode | null }[] } | null;
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
    countryOfOrigin
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
    popularity
    trending
    episodes
    duration
    format
    status
    isAdult
    season
    startDate {
      year
      month
      day
    }
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
  query ($page: Int, $perPage: Int, $countryOfOrigin: CountryCode) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, sort: TRENDING_DESC, isAdult: false, countryOfOrigin: $countryOfOrigin) {
        ...MediaFields
      }
    }
  }
  ${MEDIA_FIELDS_FRAGMENT}
`;

const POPULAR_SEASON_QUERY = `
  query ($season: MediaSeason, $seasonYear: Int, $page: Int, $perPage: Int, $countryOfOrigin: CountryCode) {
    Page(page: $page, perPage: $perPage) {
      media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC, isAdult: false, countryOfOrigin: $countryOfOrigin) {
        ...MediaFields
      }
    }
  }
  ${MEDIA_FIELDS_FRAGMENT}
`;

const ALL_TIME_POPULAR_QUERY = `
  query ($page: Int, $perPage: Int, $countryOfOrigin: CountryCode) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, sort: POPULARITY_DESC, isAdult: false, countryOfOrigin: $countryOfOrigin) {
        ...MediaFields
      }
    }
  }
  ${MEDIA_FIELDS_FRAGMENT}
`;

const DISCOVER_QUERY = `
  query (
    $page: Int, $perPage: Int, $search: String, $season: MediaSeason,
    $seasonYear: Int, $genreIn: [String], $tagIn: [String], $formatIn: [MediaFormat],
    $status: MediaStatus, $minScore: Int, $sort: [MediaSort],
    $countryOfOrigin: CountryCode, $isAdult: Boolean,
    $genreNotIn: [String], $tagNotIn: [String]
  ) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage }
      media(
        type: ANIME, search: $search, season: $season, seasonYear: $seasonYear,
        genre_in: $genreIn, tag_in: $tagIn, format_in: $formatIn, status: $status,
        averageScore_greater: $minScore, sort: $sort, isAdult: $isAdult,
        genre_not_in: $genreNotIn, tag_not_in: $tagNotIn,
        countryOfOrigin: $countryOfOrigin
      ) {
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
      media(id_in: $ids, type: ANIME, isAdult: false) {
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

// Fetch only graph IDs/types here. Requesting full media objects recursively
// made AniList's response enormous and could fail/timeout before related anime
// were returned. Catalog fields are fetched once in a compact second request.
const FRANCHISE_GRAPH_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      relations {
        edges { relationType node { id type relations { edges { relationType node { id type } } } } }
      }
    }
  }
`;

const FRANCHISE_MEDIA_QUERY = `
  query ($ids: [Int], $perPage: Int) {
    Page(page: 1, perPage: $perPage) {
      media(id_in: $ids, type: ANIME, isAdult: false) { ...MediaFields }
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

const OFFICIAL_GENRES_SET = new Set([
  'action', 'adventure', 'comedy', 'drama', 'ecchi', 'fantasy', 'horror',
  'mahou shoujo', 'mecha', 'music', 'mystery', 'psychological', 'romance',
  'sci-fi', 'slice of life', 'sports', 'supernatural', 'thriller'
]);

export async function queryDiscoverCatalog(params: {
  page: number;
  perPage: number;
  pageCount?: number;
  search?: string;
  season?: AniListSeason;
  seasonYear?: number;
  genre?: string;
  genres?: string[];
  tags?: string[];
  format?: string;
  status?: string;
  minScore?: number;
  sort: string;
  countryOfOrigin?: 'JP';
  isAdult?: boolean;
}): Promise<{ items: AniListMedia[]; hasNextPage: boolean }> {
  type DiscoverPageResult = {
    media?: (AniListMedia | null)[] | null;
    pageInfo?: { hasNextPage?: boolean | null } | null;
  } | null;
  const pageCount = Math.max(1, Math.min(5, Math.floor(Number(params.pageCount) || 1)));
  const firstPage = Math.max(1, Math.floor(params.page));
  const perPage = clampPerPage(params.perPage, 24);

  const rawGenres = Array.isArray(params.genres) && params.genres.length > 0
    ? params.genres
    : (params.genre ? [params.genre] : []);
  const genreIn = rawGenres.filter((g) => OFFICIAL_GENRES_SET.has(g.toLowerCase()));
  const tagsFromGenres = rawGenres.filter((g) => !OFFICIAL_GENRES_SET.has(g.toLowerCase()));
  const tagIn = Array.from(new Set([
    ...tagsFromGenres,
    ...(Array.isArray(params.tags) ? params.tags : [])
  ]));

  const isAdultQuery = params.isAdult === true;
  const commonVariables = {
    perPage,
    search: params.search?.trim() || undefined,
    season: params.season,
    seasonYear: params.seasonYear,
    genreIn: genreIn.length > 0 ? genreIn : undefined,
    tagIn: tagIn.length > 0 ? tagIn : undefined,
    formatIn: params.format ? [params.format] : undefined,
    status: params.status,
    // AniList exposes averageScore_greater (strictly greater); subtract one
    // so the UI's "70+" filter includes titles scored exactly 70.
    minScore: params.minScore && params.minScore > 0 ? Math.max(0, Math.min(100, Math.floor(params.minScore) - 1)) : undefined,
    sort: [params.sort],
    countryOfOrigin: params.countryOfOrigin,
    isAdult: isAdultQuery ? true : false,
    genreNotIn: isAdultQuery ? undefined : ['Hentai'],
    tagNotIn: isAdultQuery ? undefined : ['Hentai'],
  };
  let pages: DiscoverPageResult[];

  if (pageCount === 1) {
    const data = await runAniListQuery<{
      Page?: DiscoverPageResult;
    }>(DISCOVER_QUERY, { ...commonVariables, page: firstPage });
    pages = [data.Page ?? null];
  } else {
    // Fetch adjacent AniList pages as GraphQL aliases in one HTTP request.
    // The API limits requests per minute, so rating filters should not pay
    // one full rate-limit interval for every page just to find local matches.
    const pageVariables = Array.from({ length: pageCount }, (_, index) => `$page${index}: Int!`);
    const pageSelections = Array.from({ length: pageCount }, (_, index) => `
      page${index}: Page(page: $page${index}, perPage: $perPage) {
        pageInfo { hasNextPage }
        media(
          type: ANIME, search: $search, season: $season, seasonYear: $seasonYear,
          genre_in: $genreIn, tag_in: $tagIn, format_in: $formatIn, status: $status,
          averageScore_greater: $minScore, sort: $sort, isAdult: $isAdult,
          genre_not_in: $genreNotIn, tag_not_in: $tagNotIn,
          countryOfOrigin: $countryOfOrigin
        ) { ...MediaFields }
      }
    `).join('\n');
    const query = `query (${[
      ...pageVariables,
      '$perPage: Int!', '$search: String', '$season: MediaSeason', '$seasonYear: Int',
      '$genreIn: [String]', '$tagIn: [String]', '$formatIn: [MediaFormat]', '$status: MediaStatus',
      '$minScore: Int', '$sort: [MediaSort]', '$countryOfOrigin: CountryCode', '$isAdult: Boolean',
      '$genreNotIn: [String]', '$tagNotIn: [String]',
    ].join(', ')}) { ${pageSelections} } ${MEDIA_FIELDS_FRAGMENT}`;
    const data = await runAniListQuery<Record<string, DiscoverPageResult>>(query, {
      ...commonVariables,
      ...Object.fromEntries(Array.from({ length: pageCount }, (_, index) => [`page${index}`, firstPage + index])),
    });
    pages = Array.from({ length: pageCount }, (_, index) => data[`page${index}`] ?? null);
  }

  const isHentaiOrAdult = (media: AniListMedia) => {
    if (media.isAdult === true) return true;
    if (Array.isArray(media.genres) && media.genres.some((g) => g?.toLowerCase() === 'hentai')) return true;
    if (Array.isArray(media.tags) && media.tags.some((t) => t?.name?.toLowerCase().includes('hentai'))) return true;
    return false;
  };

  const unique = new Map<number, AniListMedia>();
  for (const page of pages) {
    for (const media of page?.media ?? []) {
      if (!media) continue;
      if (!isAdultQuery && isHentaiOrAdult(media)) continue;
      if (!unique.has(media.id)) unique.set(media.id, media);
    }
  }
  return {
    items: [...unique.values()],
    hasNextPage: pages[pages.length - 1]?.pageInfo?.hasNextPage === true,
  };
}

/**
 * Fetches randomized genre candidate pages with one AniList request. The page
 * for each genre is selected by the caller so the pool changes on refresh.
 */
export async function queryGenreCandidates(genres: { genre: string; page: number }[], perPage = 50): Promise<Record<string, AniListMedia[]>> {
  const selections = genres.map((_, index) => `
    genre${index}: Page(page: $page${index}, perPage: $perPage) {
      media(type: ANIME, genre_in: [$genre${index}], sort: POPULARITY_DESC, isAdult: false, countryOfOrigin: JP) {
        ...MediaFields
      }
    }
  `).join('\n');
  const variables = [
    ...genres.map((_, index) => `$page${index}: Int!`),
    ...genres.map((_, index) => `$genre${index}: String!`),
    '$perPage: Int!',
  ];
  const query = `query (${variables.join(', ')}) { ${selections} } ${MEDIA_FIELDS_FRAGMENT}`;
  const data = await runAniListQuery<Record<string, { media?: (AniListMedia | null)[] | null } | null>>(query, {
    perPage: clampPerPage(perPage, 50),
    ...Object.fromEntries(genres.flatMap((entry, index) => [[`page${index}`, entry.page], [`genre${index}`, entry.genre]])),
  });
  return Object.fromEntries(genres.map((entry, index) => [
    entry.genre,
    (data[`genre${index}`]?.media ?? []).filter((media): media is AniListMedia => !!media),
  ]));
}

/**
 * Fetches currently trending anime sorted by TRENDING_DESC.
 */
export async function queryTrending(perPage = 24): Promise<AniListMedia[]> {
  const data = await runAniListQuery<PageMediaResult>(TRENDING_QUERY, {
    page: 1,
    perPage: clampPerPage(perPage, 24),
    countryOfOrigin: 'JP',
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
    countryOfOrigin: 'JP',
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
    countryOfOrigin: 'JP',
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

export async function queryFranchise(id: number): Promise<AniListFranchiseNode | null> {
  const data = await runAniListQuery<{ Media?: AniListFranchiseNode | null } | null>(FRANCHISE_GRAPH_QUERY, { id });
  return data?.Media ?? null;
}

export async function queryFranchiseMedia(ids: number[]): Promise<AniListMedia[]> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 50);
  if (unique.length === 0) return [];
  const data = await runAniListQuery<{ Page?: { media?: (AniListMedia | null)[] | null } | null }>(FRANCHISE_MEDIA_QUERY, {
    ids: unique,
    perPage: unique.length,
  });
  return (data.Page?.media ?? []).filter((item): item is AniListMedia => !!item);
}

import {
  prioritizeCharacters,
  buildInitialPrompt,
  buildHotwords,
  buildFullCharacterNameList,
  RawCharacterEdge,
} from './whisperPrompt';

const CHARACTERS_QUERY = `
  query ($search: String, $id: Int) {
    Media(search: $search, id: $id, type: ANIME) {
      id
      title {
        romaji
        english
        native
      }
      characters(sort: [ROLE, RELEVANCE, ID], perPage: 25) {
        edges {
          role
          node {
            name {
              first
              middle
              last
              full
              native
              alternative
              userPreferred
            }
          }
        }
      }
    }
  }
`;

export interface CharacterQueryResult {
  id: number;
  title: string;
  characters: string[];
  initialPrompt?: string;
  hotwords?: string;
  allCharacterNames?: string[];
}

const charactersCache = new Map<string, CharacterQueryResult>();

/**
 * Automatically retrieves character names for an anime by title or AniList ID.
 * Results are normalized and cached in memory.
 */
export async function queryAnimeCharacters(
  searchOrId: string | number
): Promise<CharacterQueryResult | null> {
  const cacheKey = typeof searchOrId === 'number' ? `id:${searchOrId}` : `search:${searchOrId.toLowerCase().trim()}`;
  if (charactersCache.has(cacheKey)) {
    return charactersCache.get(cacheKey)!;
  }

  const variables = typeof searchOrId === 'number' && Number.isFinite(searchOrId) && searchOrId > 0
    ? { id: searchOrId }
    : { search: String(searchOrId).trim() };

  if (!variables.id && (!variables.search || variables.search.length === 0)) {
    return null;
  }

  try {
    const data = await runAniListQuery<{
      Media?: {
        id: number;
        title?: { romaji?: string | null; english?: string | null; native?: string | null };
        characters?: {
          edges?: RawCharacterEdge[];
        };
      } | null;
    }>(CHARACTERS_QUERY, variables);

    const media = data?.Media;
    if (!media || !media.id) return null;

    const rawEdges: RawCharacterEdge[] = media.characters?.edges || [];
    const prioritized = prioritizeCharacters(rawEdges, 20);

    const title = media.title?.english || media.title?.romaji || variables.search || '';
    const initialPrompt = buildInitialPrompt(prioritized);
    const hotwords = buildHotwords(prioritized, 14);
    const allCharacterNames = buildFullCharacterNameList(prioritized);

    // Display names for UI tags: top characters with spoken or full names
    const names = prioritized.map((c, idx) => (idx < 3 ? c.fullName : c.spokenName));

    const result: CharacterQueryResult = {
      id: media.id,
      title,
      characters: names,
      initialPrompt,
      hotwords,
      allCharacterNames,
    };

    charactersCache.set(cacheKey, result);
    charactersCache.set(`id:${media.id}`, result);
    return result;
  } catch {
    return null;
  }
}
