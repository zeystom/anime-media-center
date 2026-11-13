/**
 * Offline test battery for the Phase 2 catalog backend:
 *   electron/anilist.ts, electron/catalog.ts, electron/aniZip.ts, electron/userLibrary.ts
 *
 * No network dependency: global fetch is intercepted (graphql.anilist.co /
 * api.ani.zip) and answered with fixture JSON, and every network call is
 * counted so cache behavior (TTL, in-flight dedup, stale fallback) can be
 * asserted precisely.
 *
 * electron is shimmed through module customization hooks so the real
 * storage.ts chain (used by catalog/aniZip for the metadata cache dir) loads
 * under plain Node. A load hook transpiles .ts via the repo's typescript
 * package because storage.ts has type-only named imports that Node's native
 * type stripping does not elide.
 *
 * Run: node test-catalog-cache.js
 */
import { registerHooks } from 'node:module';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

let passedTests = 0;
let failedTests = 0;
async function runTest(name, fn) {
  try {
    await fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  [FAIL] ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Environment: fast-but-real AniList queue spacing (module reads this at load,
// must be set before any electron/* import).
// ---------------------------------------------------------------------------
process.env.ANILIST_MIN_SPACING_MS = '150';

const TEST_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-catalog-test-'));
const METADATA_CACHE_DIR = path.join(TEST_USER_DATA, 'metadata_cache');

// --- electron mock (temp module outside the repo, resolve hook points at it)
const electronMockFile = path.join(TEST_USER_DATA, 'electron-mock.mjs');
fs.writeFileSync(
  electronMockFile,
  `export const app = { getPath: (name) => ${JSON.stringify(TEST_USER_DATA)} };\nexport default { app };\n`,
  'utf-8'
);
const electronMockUrl = pathToFileURL(electronMockFile).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: electronMockUrl, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      // Extensionless relative imports inside the legacy TS graph (storage.ts)
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
  load(url, context, nextLoad) {
    const cleanPath = url.split('?')[0];
    if (cleanPath.endsWith('.ts')) {
      const filePath = fileURLToPath(cleanPath);
      const source = fs.readFileSync(filePath, 'utf-8');
      const out = ts.transpileModule(source, {
        fileName: filePath,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      });
      return { format: 'module', source: out.outputText, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------
const fetchCalls = [];
let fetchHandler = null;

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
  };
}

globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ url: String(url), init, at: Date.now() });
  if (typeof fetchHandler !== 'function') {
    return jsonResponse(500, { error: 'test fetch handler not configured' });
  }
  return fetchHandler(String(url), init);
};

function anilistCalls() {
  return fetchCalls.filter((c) => c.url.startsWith('https://graphql.anilist.co'));
}
function anizipCalls() {
  return fetchCalls.filter((c) => c.url.startsWith('https://api.ani.zip'));
}
function resetFetchCalls() {
  fetchCalls.length = 0;
}
function resetDiskCache() {
  fs.rmSync(METADATA_CACHE_DIR, { recursive: true, force: true });
}
function diskCacheFile(name) {
  return path.join(METADATA_CACHE_DIR, name);
}
let catalogInstanceId = 0;
async function freshCatalog() {
  catalogInstanceId++;
  return import(`./electron/catalog.ts?instance=${catalogInstanceId}`);
}
let anizipInstanceId = 0;
async function freshAniZip() {
  anizipInstanceId++;
  return import(`./electron/aniZip.ts?instance=${anizipInstanceId}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function rawMedia(id, overrides = {}) {
  return {
    id,
    idMal: 1000 + id,
    countryOfOrigin: 'JP',
    title: { romaji: `Romaji ${id}`, english: `English ${id}`, native: `Native ${id}` },
    synonyms: [`Alt ${id}`],
    coverImage: { extraLarge: `https://img/poster-${id}-xl.jpg`, large: `https://img/poster-${id}.jpg` },
    bannerImage: `https://img/banner-${id}.jpg`,
    description: `<p>Hello <b>world</b> ${id}!<br>Second line.</p>`,
    genres: ['Action', 'Comedy'],
    tags: [{ name: 'TagA', rank: 90 }, { name: 'TagB', rank: 40 }],
    averageScore: 85,
    episodes: 12,
    duration: 24,
    format: 'TV',
    status: 'RELEASING',
    season: 'FALL',
    seasonYear: 2026,
    nextAiringEpisode: { episode: 3, airingAt: 1799999999, timeUntilAiring: 123456 },
    studios: { nodes: [{ name: 'Studio X' }] },
    ...overrides,
  };
}

const TRENDING_FIXTURE = [rawMedia(11), rawMedia(12), rawMedia(13)];
const POPULAR_SEASON_FIXTURE = [rawMedia(21), rawMedia(22)];
const ALL_TIME_FIXTURE = [rawMedia(31), rawMedia(32)];
const SEARCH_FIXTURE = [rawMedia(41), rawMedia(42)];
const DETAILS_FIXTURE = rawMedia(154587);

let SCHEDULE_FIXTURE = [];
const REC_NODES = {
  101: [
    { rating: 100, mediaRecommendation: rawMedia(201, { averageScore: 88 }) },
    { rating: 10, mediaRecommendation: rawMedia(301, { averageScore: 76 }) },
  ],
  102: [
    { rating: 90, mediaRecommendation: rawMedia(201, { averageScore: 88 }) },
    { rating: 5, mediaRecommendation: rawMedia(401, { averageScore: 70 }) },
  ],
  103: [
    { rating: 70, mediaRecommendation: rawMedia(301, { averageScore: 76 }) },
    { rating: 3, mediaRecommendation: rawMedia(101, { averageScore: 99 }) },
  ],
};

function anilistHandler(url, init) {
  const body = JSON.parse(init.body || '{}');
  const query = body.query || '';
  const vars = body.variables || {};
  const page = vars.page || 1;
  const perPage = vars.perPage || 24;

  if (query.includes('airingSchedules')) {
    const from = vars.airingAt_greater ?? vars.from;
    const to = vars.airingAt_lesser ?? vars.to;
    const filtered = SCHEDULE_FIXTURE.filter((e) => e.airingAt > from && e.airingAt < to);
    const slice = filtered.slice((page - 1) * perPage, page * perPage);
    return jsonResponse(200, {
      data: {
        Page: {
          airingSchedules: slice.map((e) => ({ episode: e.episode, airingAt: e.airingAt, media: e.media })),
        },
      },
    });
  }
  if (query.includes('TRENDING_DESC')) {
    return jsonResponse(200, { data: { Page: { media: TRENDING_FIXTURE.slice((page - 1) * perPage, page * perPage) } } });
  }
  if (query.includes('POPULARITY_DESC') && vars.season) {
    return jsonResponse(200, { data: { Page: { media: POPULAR_SEASON_FIXTURE.slice((page - 1) * perPage, page * perPage) } } });
  }
  if (query.includes('POPULARITY_DESC')) {
    return jsonResponse(200, { data: { Page: { media: ALL_TIME_FIXTURE.slice((page - 1) * perPage, page * perPage) } } });
  }
  if (query.includes('mediaRecommendation')) {
    return jsonResponse(200, {
      data: {
        Page: {
          media: (vars.ids || []).map((id) => ({ id, recommendations: { nodes: REC_NODES[id] || [] } })),
        },
      },
    });
  }
  if (query.includes('relations') && query.includes('Media(id: $id')) {
    return jsonResponse(200, { data: { Media: {
      id: vars.id,
      relations: { edges: [
        { relationType: 'SEQUEL', node: { id: 201, type: 'ANIME', relations: { edges: [] } } },
        // Real AniList data labels every manga->anime edge ADAPTATION.
        { relationType: 'ADAPTATION', node: { id: 900, type: 'MANGA', relations: { edges: [
          { relationType: 'ADAPTATION', node: { id: 202, type: 'ANIME' } },
          { relationType: 'CHARACTER', node: { id: 999, type: 'ANIME' } },
        ] } } },
      ] },
    } } });
  }
  if (query.includes('id_in: $ids')) {
    return jsonResponse(200, { data: { Page: { media: (vars.ids || []).map((id) => rawMedia(id, { format: 'TV' })) } } });
  }
  if (query.includes('SEARCH_MATCH')) {
    return jsonResponse(200, { data: { Page: { media: SEARCH_FIXTURE.slice((page - 1) * perPage, page * perPage) } } });
  }
  if (query.includes('Media(id: $id')) {
    return jsonResponse(200, { data: { Media: vars.id === DETAILS_FIXTURE.id ? DETAILS_FIXTURE : null } });
  }
  return jsonResponse(400, { errors: [{ message: 'test handler: unrecognized query' }] });
}

{
  const catalog = await freshCatalog();
  fetchHandler = anilistHandler;
  resetFetchCalls();
  resetDiskCache();
  await runTest('getCatalogFranchise fetches anime relations via compact graph and excludes character links', async () => {
    const related = await catalog.getCatalogFranchise(100);
    assert.deepStrictEqual(related.map((item) => item.anilistId), [201, 202]);
    assert.strictEqual(related.find((item) => item.anilistId === 201)?.relationType, 'SEQUEL');
    // Manga-hop children keep the neutral RELATED label: real manga->anime
    // edges are always ADAPTATION, which is meaningless anime-to-anime.
    assert.strictEqual(related.find((item) => item.anilistId === 202)?.relationType, 'RELATED');
    assert.strictEqual(anilistCalls().length, 2, 'graph IDs and media details are fetched in two bounded requests');
  });
}

// ---------------------------------------------------------------------------
console.log('================================================================');
console.log('   CATALOG BACKEND TEST BATTERY (offline, mocked fetch)         ');
console.log('================================================================\n');

// --- GROUP 1: pure helpers ---------------------------------------------------
const catalog1 = await freshCatalog();
fetchHandler = anilistHandler;

await runTest('normalizeMedia strips HTML and maps fields', async () => {
  const item = catalog1.normalizeMedia(rawMedia(999));
  assert.strictEqual(item.anilistId, 999);
  assert.strictEqual(item.idMal, 1999);
  assert.strictEqual(item.title.english, 'English 999');
  assert.strictEqual(item.title.romaji, 'Romaji 999');
  assert.strictEqual(item.title.native, 'Native 999');
  assert.deepStrictEqual(item.synonyms, ['Alt 999']);
  assert.strictEqual(item.posterUrl, 'https://img/poster-999-xl.jpg');
  assert.strictEqual(item.bannerUrl, 'https://img/banner-999.jpg');
  assert.ok(!item.description.includes('<'), `description still has HTML: ${item.description}`);
  assert.ok(item.description.includes('Hello world 999!'), `description text missing: ${item.description}`);
  assert.ok(item.description.includes('Second line.'));
  assert.deepStrictEqual(item.genres, ['Action', 'Comedy']);
  assert.deepStrictEqual(item.tags, ['TagA', 'TagB']);
  assert.strictEqual(item.averageScore, 85);
  assert.strictEqual(item.episodesCount, 12);
  assert.strictEqual(item.durationMinutes, 24);
  assert.strictEqual(item.format, 'TV');
  assert.strictEqual(item.status, 'RELEASING');
  assert.strictEqual(item.season, 'FALL');
  assert.strictEqual(item.seasonYear, 2026);
  assert.deepStrictEqual(item.nextAiringEpisode, { episode: 3, airingAt: 1799999999, timeUntilAiring: 123456 });
  assert.deepStrictEqual(item.studios, ['Studio X']);
});

await runTest('normalizeMedia handles null description and missing fields', async () => {
  const item = catalog1.normalizeMedia(rawMedia(998, { description: '', coverImage: null, nextAiringEpisode: null, studios: null, tags: null }));
  assert.strictEqual(item.description, null);
  assert.strictEqual(item.posterUrl, null);
  assert.strictEqual(item.nextAiringEpisode, null);
  assert.deepStrictEqual(item.studios, []);
  assert.deepStrictEqual(item.tags, []);
});

await runTest('getCurrentAniListSeason follows AniList month conventions', async () => {
  assert.deepStrictEqual(catalog1.getCurrentAniListSeason(new Date(2026, 0, 15)), { season: 'WINTER', year: 2026 });
  assert.deepStrictEqual(catalog1.getCurrentAniListSeason(new Date(2026, 2, 31)), { season: 'WINTER', year: 2026 });
  assert.deepStrictEqual(catalog1.getCurrentAniListSeason(new Date(2026, 3, 1)), { season: 'SPRING', year: 2026 });
  assert.deepStrictEqual(catalog1.getCurrentAniListSeason(new Date(2026, 8, 30)), { season: 'SUMMER', year: 2026 });
  assert.deepStrictEqual(catalog1.getCurrentAniListSeason(new Date(2026, 9, 1)), { season: 'FALL', year: 2026 });
  // December counts toward Winter of the following year
  assert.deepStrictEqual(catalog1.getCurrentAniListSeason(new Date(2026, 11, 5)), { season: 'WINTER', year: 2027 });
});

await runTest('getAiringWeekRange math (Monday 00:00 local, 7 days, offset)', async () => {
  const r0 = catalog1.getAiringWeekRange(0);
  const r1 = catalog1.getAiringWeekRange(1);
  const rm1 = catalog1.getAiringWeekRange(-1);
  assert.strictEqual(r0.to - r0.from, 7 * 24 * 60 * 60);
  const start = new Date(r0.from * 1000);
  assert.strictEqual(start.getDay(), 1, 'week must start on Monday');
  assert.strictEqual(start.getHours(), 0);
  assert.strictEqual(start.getMinutes(), 0);
  assert.strictEqual(start.getSeconds(), 0);
  assert.strictEqual(r1.from, r0.from + 7 * 24 * 60 * 60);
  assert.strictEqual(rm1.from, r0.from - 7 * 24 * 60 * 60);
});

// --- GROUP 2: AniList request queue spacing ----------------------------------
{
  const catalog = await freshCatalog();
  fetchHandler = anilistHandler;
  resetFetchCalls();
  resetDiskCache();
  await runTest('serialized queue spaces requests (ANILIST_MIN_SPACING_MS honored)', async () => {
    await catalog.getPopularSeason();
    await catalog.getTrending();
    const calls = anilistCalls();
    assert.strictEqual(calls.length, 2, `expected 2 anilist calls, got ${calls.length}`);
    const delta = calls[1].at - calls[0].at;
    assert.ok(delta >= 140, `second request started only ${delta}ms after the first (want >= 140ms spacing)`);
    assert.ok(delta < 5000, `spacing suspiciously large: ${delta}ms`);
  });
}

// --- GROUP 3: TTL cache -------------------------------------------------------
{
  const catalog = await freshCatalog();
  fetchHandler = anilistHandler;
  resetFetchCalls();
  resetDiskCache();
  await runTest('getTrending caches: second call within TTL hits no network', async () => {
    const first = await catalog.getTrending();
    assert.strictEqual(first.length, TRENDING_FIXTURE.length);
    assert.strictEqual(first[0].anilistId, 11);
    assert.strictEqual(anilistCalls().length, 1);

    const second = await catalog.getTrending();
    assert.strictEqual(second.length, TRENDING_FIXTURE.length);
    assert.strictEqual(anilistCalls().length, 1, 'TTL cache must prevent the second network call');
    assert.deepStrictEqual(second, first);

    assert.ok(fs.existsSync(diskCacheFile('catalog_trending_jp.json')), 'disk cache file must be written');
    const raw = JSON.parse(fs.readFileSync(diskCacheFile('catalog_trending_jp.json'), 'utf-8'));
    assert.ok(typeof raw.fetchedAt === 'number');
    assert.ok(Array.isArray(raw.data) && raw.data[0].anilistId === 11);
  });
}

// --- GROUP 4: in-flight dedup --------------------------------------------------
{
  const catalog = await freshCatalog();
  fetchHandler = anilistHandler;
  resetFetchCalls();
  resetDiskCache();
  await runTest('in-flight dedup: two concurrent calls trigger 1 network call', async () => {
    const [a, b] = await Promise.all([catalog.getPopularSeason(), catalog.getPopularSeason()]);
    assert.strictEqual(anilistCalls().length, 1, `concurrent calls must dedup, got ${anilistCalls().length} calls`);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a[0].anilistId, 21);
  });
}

// --- GROUP 5: airing schedule window math -------------------------------------
{
  const catalog = await freshCatalog();
  fetchHandler = anilistHandler;
  resetFetchCalls();
  resetDiskCache();

  const r0 = catalog.getAiringWeekRange(0);
  const r1 = catalog.getAiringWeekRange(1);
  SCHEDULE_FIXTURE = [
    { episode: 1, airingAt: r0.from + 50, media: rawMedia(701) },
    { episode: 2, airingAt: r0.from + 200, media: rawMedia(702) },
    { episode: 3, airingAt: r0.to - 10, media: rawMedia(703, { title: { romaji: 'RomajiOnly 703', english: null, native: 'n' } }) },
    // Out of window for offset 0:
    { episode: 9, airingAt: r0.from, media: rawMedia(790) }, // exactly at from (excluded: strict >)
    { episode: 9, airingAt: r0.from - 100, media: rawMedia(791) },
    { episode: 9, airingAt: r0.to + 50, media: rawMedia(792) },
    // In window for offset 1 only:
    { episode: 4, airingAt: r1.from + 1000, media: rawMedia(711) },
  ];

  await runTest('getAiringSchedule buckets into the week window and sorts by airingAt', async () => {
    const items = await catalog.getAiringSchedule(0);
    assert.strictEqual(items.length, 3, `expected only in-window entries, got ${JSON.stringify(items.map((i) => i.airingAt))}`);
    const times = items.map((i) => i.airingAt);
    assert.deepStrictEqual(times, [...times].sort((a, b) => a - b), 'entries must be sorted by airingAt');
    assert.ok(times.every((t) => t > r0.from && t < r0.to));

    // Last network call must have used the computed window
    const lastBody = JSON.parse(anilistCalls().at(-1).init.body);
    assert.strictEqual(lastBody.variables.airingAt_greater, r0.from);
    assert.strictEqual(lastBody.variables.airingAt_lesser, r0.to);

    // AiringEntry mapping
    assert.strictEqual(items[0].anilistId, 701);
    assert.strictEqual(items[0].idMal, 1701);
    assert.strictEqual(items[0].title, 'English 701');
    assert.strictEqual(items[0].posterUrl, 'https://img/poster-701-xl.jpg');
    assert.strictEqual(items[0].episode, 1);
    assert.strictEqual(items[2].title, 'RomajiOnly 703', 'title must fall back to romaji when english is missing');
    assert.strictEqual(items[2].episode, 3);

    // Cached second call: no new network
    resetFetchCalls();
    const again = await catalog.getAiringSchedule(0);
    assert.strictEqual(anilistCalls().length, 0);
    assert.deepStrictEqual(again, items);
  });

  await runTest('getAiringSchedule(weekOffset=1) uses the shifted window', async () => {
    resetFetchCalls();
    const items = await catalog.getAiringSchedule(1);
    const lastBody = JSON.parse(anilistCalls().at(-1).init.body);
    assert.strictEqual(lastBody.variables.airingAt_greater, r1.from);
    assert.strictEqual(lastBody.variables.airingAt_lesser, r1.to);
    // r0.to + 50 === r1.from + 50 (in window for offset 1) and r1.from + 1000
    assert.strictEqual(items.length, 2);
    assert.deepStrictEqual(
      items.map((i) => i.anilistId),
      [792, 711],
      'offset-1 week must contain exactly its own entries, sorted by airingAt'
    );
    assert.strictEqual(items[1].airingAt, r1.from + 1000);
  });
}

// --- GROUP 6: stale-cache fallback + graceful empty results --------------------
{
  const catalog = await freshCatalog();
  resetFetchCalls();
  resetDiskCache();

  // Seed a STALE disk cache entry (fetchedAt older than the 30min TTL)
  const staleItem = catalog.normalizeMedia(rawMedia(111));
  fs.mkdirSync(METADATA_CACHE_DIR, { recursive: true });
  fs.writeFileSync(
    diskCacheFile('catalog_trending_jp.json'),
    JSON.stringify({ data: [staleItem], fetchedAt: Date.now() - 31 * 60 * 1000 }),
    'utf-8'
  );

  await runTest('network failure serves stale disk cache instead of throwing', async () => {
    fetchHandler = () => {
      throw new Error('network down');
    };
    const items = await catalog.getTrending();
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].anilistId, 111);
  });

  await runTest('network failure with no cache returns empty/null, never throws', async () => {
    const search = await catalog.searchCatalog('query with no cache');
    assert.deepStrictEqual(search, []);
    const details = await catalog.getCatalogDetails(424242);
    assert.strictEqual(details, null);
  });
}

// --- GROUP 7: recommendations ---------------------------------------------------
{
  // Fresh instance so `limit` (applied at fetch time) is exercised separately
  const catalog = await freshCatalog();
  fetchHandler = anilistHandler;
  resetFetchCalls();
  resetDiskCache();
  await runTest('getRecommendations honors the limit parameter', async () => {
    const limited = await catalog.getRecommendations([101, 102, 103], 2);
    assert.deepStrictEqual(
      limited.map((r) => r.anilistId),
      [201, 301],
      'limit must keep the top-ranked items'
    );
  });
}
{
  const catalog = await freshCatalog();
  fetchHandler = anilistHandler;
  resetFetchCalls();
  resetDiskCache();
  await runTest('getRecommendations excludes seeds, ranks by seed count then score', async () => {
    const recs = await catalog.getRecommendations([101, 102, 103]);
    const ids = recs.map((r) => r.anilistId);
    assert.deepStrictEqual(ids, [201, 301, 401], `unexpected ranking: ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes(101), 'seed itself must be excluded');
    assert.ok(!ids.includes(102) && !ids.includes(103), 'seeds must be excluded');

    // second call within TTL: no new network
    const callsAfterFirst = anilistCalls().length;
    await catalog.getRecommendations([103, 102, 101]); // order must not matter (sorted hash key)
    assert.strictEqual(anilistCalls().length, callsAfterFirst, 'sorted-seed cache key must hit memory cache');
  });

  await runTest('getRecommendations with empty seeds returns [] without network', async () => {
    resetFetchCalls();
    const recs = await catalog.getRecommendations([], 24);
    assert.deepStrictEqual(recs, []);
    assert.strictEqual(anilistCalls().length, 0);
  });
}

// --- GROUP 8: search (memory only) + details -----------------------------------
{
  const catalog = await freshCatalog();
  fetchHandler = anilistHandler;
  resetFetchCalls();
  resetDiskCache();
  await runTest('searchCatalog caches in memory only (5 min TTL), no disk file', async () => {
    const first = await catalog.searchCatalog('Frieren Test');
    assert.strictEqual(first.length, SEARCH_FIXTURE.length);
    assert.strictEqual(anilistCalls().length, 1);

    const second = await catalog.searchCatalog('Frieren Test');
    assert.deepStrictEqual(second, first);
    assert.strictEqual(anilistCalls().length, 1, 'memory cache must prevent second network call');

    const files = fs.existsSync(METADATA_CACHE_DIR)
      ? fs.readdirSync(METADATA_CACHE_DIR).filter((f) => f.startsWith('catalog_search_'))
      : [];
    assert.strictEqual(files.length, 0, 'search must not write disk cache');
  });

  await runTest('getCatalogDetails caches with TTL and writes disk cache', async () => {
    resetFetchCalls();
    const details = await catalog.getCatalogDetails(154587);
    assert.strictEqual(details.anilistId, 154587);
    assert.strictEqual(details.title.english, 'English 154587');
    assert.strictEqual(anilistCalls().length, 1);

    await catalog.getCatalogDetails(154587);
    assert.strictEqual(anilistCalls().length, 1, 'details must be cached within TTL');
    assert.ok(fs.existsSync(diskCacheFile('catalog_details_154587.json')));
  });

  await runTest('searchCatalog with empty query returns [] without network', async () => {
    resetFetchCalls();
    assert.deepStrictEqual(await catalog.searchCatalog('   '), []);
    assert.strictEqual(anilistCalls().length, 0);
  });
}

// --- GROUP 9: ani.zip ------------------------------------------------------------
const FRIEREN_PAYLOAD = {
  titles: { en: 'Frieren: Beyond Journey`s End', ja: '葬送のフリーレン' },
  episodeCount: 28,
  specialCount: 25,
  episodes: {
    // Key order intentionally out of order to verify sorting
    '2': {
      episodeNumber: 2,
      episode: '2',
      title: { en: 'Ep Two', 'x-jat': 'Ep Two Jat', ja: '二人' },
      airdate: '2023-10-06',
      airDate: '2023-10-06',
      runtime: 26,
      image: 'https://img/ep2.jpg',
    },
    '1': {
      episodeNumber: 1,
      episode: '1',
      title: { en: 'The Journey`s End', 'x-jat': 'Bouken no Owari' },
      airDate: '2023-09-29',
      runtime: 26,
      image: 'https://img/ep1.jpg',
    },
    '3': {
      episode: '3',
      title: 'Plain String Title',
      airDateUtc: '2023-10-13T14:00:00Z',
      length: 30,
      image: 'https://img/ep3.jpg',
    },
  },
};

{
  const aniZip = await freshAniZip();
  fetchHandler = (url) => {
    if (url.startsWith('https://api.ani.zip/mappings?anilist_id=154587')) {
      return jsonResponse(200, FRIEREN_PAYLOAD);
    }
    return jsonResponse(404, {});
  };
  resetFetchCalls();
  resetDiskCache();

  await runTest('fetchAniZipMappings normalizes episodes map, sorted, locale titles', async () => {
    const eps = await aniZip.fetchAniZipMappings(154587);
    assert.strictEqual(eps.length, 3);
    assert.deepStrictEqual(eps.map((e) => e.number), [1, 2, 3], 'episodes must be sorted by number');
    assert.strictEqual(eps[0].title, 'The Journey`s End');
    assert.strictEqual(eps[0].airDate, '2023-09-29');
    assert.strictEqual(eps[0].runtime, 26);
    assert.strictEqual(eps[0].thumbnailUrl, 'https://img/ep1.jpg');
    assert.strictEqual(eps[2].title, 'Plain String Title', 'string titles must pass through');
    assert.strictEqual(eps[2].airDate, '2023-10-13T14:00:00Z', 'airDateUtc fallback');
    assert.strictEqual(eps[2].runtime, 30, 'length is a valid runtime fallback');

    assert.ok(fs.existsSync(diskCacheFile('anizip_154587.json')), 'ani.zip disk cache must be written');

    // TTL/memory: second call within TTL -> no network
    resetFetchCalls();
    const again = await aniZip.fetchAniZipMappings(154587);
    assert.strictEqual(anizipCalls().length, 0);
    assert.deepStrictEqual(again, eps);
  });
}

{
  const aniZip = await freshAniZip();

  await runTest('dropInterleavedShortRows drops ~3-min specials interleaved into main numbering', async () => {
    // Real-world poisoned snapshot (K-On! S1, ani.zip 2026-11): slots 2-7 held
    // ~3-minute chibi shorts with monthly air dates, real episodes kept runtime 25.
    const poisoned = [
      { number: 1, title: 'Disband the Club!', thumbnailUrl: 'i1', airDate: '2009-04-02', runtime: 25 },
      { number: 2, title: "Ricchan`s Kodak Moment Series: Mio / Yui", thumbnailUrl: 'i2', airDate: '2009-08-18', runtime: 3 },
      { number: 3, title: "Mio`s Panties: Stripe Sketch Show", thumbnailUrl: 'i3', airDate: '2009-09-15', runtime: 2 },
      { number: 4, title: 'Little Yui-chan: Christmas', thumbnailUrl: 'i4', airDate: '2009-10-20', runtime: 3 },
      { number: 5, title: 'Uninhabited Island Series', thumbnailUrl: 'i5', airDate: '2009-11-17', runtime: 3 },
      { number: 6, title: 'The Animal Series', thumbnailUrl: 'i6', airDate: '2009-12-15', runtime: 3 },
      { number: 7, title: 'Winter... Chapter', thumbnailUrl: 'i7', airDate: '2010-01-19', runtime: 3 },
      { number: 8, title: 'Freshman Reception!', thumbnailUrl: 'i8', airDate: '2009-05-21', runtime: 25 },
      { number: 9, title: 'New Club Member!', thumbnailUrl: 'i9', airDate: '2009-05-28', runtime: 25 },
      { number: 10, title: 'Training Camp Again!', thumbnailUrl: 'i10', airDate: '2009-06-04', runtime: 25 },
      { number: 11, title: 'Crisis!?', thumbnailUrl: 'i11', airDate: '2009-06-11', runtime: 25 },
      { number: 12, title: 'Light Music!', thumbnailUrl: 'i12', airDate: '2009-06-18', runtime: 25 },
      { number: 13, title: 'Winter Days!', thumbnailUrl: 'i13', airDate: '2009-06-25', runtime: 25 },
    ];
    const { kept, dropped } = aniZip.dropInterleavedShortRows(poisoned);
    assert.strictEqual(dropped, 6, 'all six interleaved shorts must be dropped');
    assert.deepStrictEqual(kept.map((e) => e.number), [1, 8, 9, 10, 11, 12, 13]);

    // The clean live payload must be untouched.
    const clean = poisoned.filter((e) => e.runtime === 25).map((e, i) => ({ ...e, number: i + 1 }));
    assert.strictEqual(aniZip.dropInterleavedShortRows(clean).dropped, 0);
  });

  await runTest('dropInterleavedShortRows keeps shorts-only shows and sparse runtime data', async () => {
    // A shorts-only series: the median itself is small -> nothing qualifies.
    const shortsOnly = Array.from({ length: 8 }, (_, i) => ({
      number: i + 1, title: `Short ${i + 1}`, thumbnailUrl: `s${i}`, airDate: null, runtime: 3,
    }));
    assert.strictEqual(aniZip.dropInterleavedShortRows(shortsOnly).dropped, 0);

    // Too few runtime-bearing rows to judge: never drop.
    const sparse = [
      { number: 1, title: 'A', thumbnailUrl: 'a', airDate: null, runtime: 25 },
      { number: 2, title: 'B', thumbnailUrl: 'b', airDate: null, runtime: 2 },
    ];
    assert.strictEqual(aniZip.dropInterleavedShortRows(sparse).dropped, 0);

    // No runtime data at all: never drop.
    const noRuntime = Array.from({ length: 5 }, (_, i) => ({
      number: i + 1, title: `Ep ${i + 1}`, thumbnailUrl: null, airDate: null, runtime: null,
    }));
    assert.strictEqual(aniZip.dropInterleavedShortRows(noRuntime).dropped, 0);
  });
}

{
  const aniZip = await freshAniZip();
  fetchHandler = (url) => {
    if (url.includes('anilist_id=206814')) {
      return jsonResponse(200, { episodes: {}, mappings: { anilist_id: 206814, kitsu_id: 50497 } });
    }
    if (url.startsWith('https://graphql.anilist.co')) {
      return jsonResponse(200, { data: { Media: {
        episodes: 2,
        title: { english: 'The God of Destruction', romaji: 'The God of Destruction', native: null },
        synonyms: [],
        streamingEpisodes: [],
      } } });
    }
    if (url.endsWith('/anime/50497')) {
      return jsonResponse(200, { data: { attributes: {
        canonicalTitle: 'The God of Destruction',
        titles: { en: 'The God of Destruction', en_jp: 'The God of Destruction' },
        abbreviatedTitles: [],
        episodeCount: 2,
      } } });
    }
    if (url.includes('/anime/50497/episodes')) {
      return jsonResponse(200, {
        data: [
          { attributes: { number: 1, titles: { en: 'The God Who Destroys' }, canonicalTitle: 'The God Who Destroys', airdate: '2026-10-11', length: 23, thumbnail: { large: 'https://img/kitsu-1.jpg' } } },
          { attributes: { number: 2, titles: { en: 'The God of Destruction Heads to the Planet of the Kai' }, airdate: '2026-10-18', length: 23, thumbnail: { large: 'https://img/kitsu-2.jpg' } } },
          { attributes: { number: 3, titles: {}, canonicalTitle: null, airdate: null, length: 23, thumbnail: null } },
        ],
        links: { next: null },
      });
    }
    return jsonResponse(404, {});
  };
  resetFetchCalls();
  resetDiskCache();

  await runTest('fetchRemoteEpisodes accepts only a verified Kitsu mapping and excludes out-of-range episodes', async () => {
    // The payload shape is { episodes, airedThrough, nextAiringAt, ... } — the
    // airing context rides along with the list (consumed by AnimeDetailView).
    const { episodes } = await aniZip.fetchRemoteEpisodes(206814);
    assert.deepStrictEqual(episodes.map((episode) => episode.number), [1, 2]);
    assert.strictEqual(episodes[0].title, 'The God Who Destroys');
    assert.strictEqual(episodes[0].thumbnailUrl, 'https://img/kitsu-1.jpg');
    assert.strictEqual(episodes[1].title, 'The God of Destruction Heads to the Planet of the Kai');
    assert.strictEqual(anizipCalls().length, 1);
    assert.strictEqual(fetchCalls.filter((call) => call.url.includes('kitsu.io/api/edge/anime/50497/episodes')).length, 1);
    assert.strictEqual(anilistCalls().length, 1, 'AniList identity/count is checked before using Kitsu metadata');
    const cached = JSON.parse(fs.readFileSync(diskCacheFile('anizip_206814.json'), 'utf-8'));
    assert.strictEqual(String(cached.kitsuId), '50497');
    assert.strictEqual(cached.episodes.length, 2);
  });
}

{
  const aniZip = await freshAniZip();
  fetchHandler = (url) => {
    if (url.includes('anilist_id=888002')) {
      return jsonResponse(200, { data: { episodes: { '1': { episode: '1', title: { en: 'Wrapped One' }, runtime: 24, image: 'https://img/w1.jpg', airdate: '2020-01-01' } } } });
    }
    return jsonResponse(500, {});
  };
  resetFetchCalls();
  resetDiskCache();
  await runTest('fetchAniZipMappings accepts the documented { data: { episodes } } wrapper', async () => {
    const eps = await aniZip.fetchAniZipMappings(888002);
    assert.strictEqual(eps.length, 1);
    assert.strictEqual(eps[0].number, 1);
    assert.strictEqual(eps[0].title, 'Wrapped One');
  });
}

{
  const aniZip = await freshAniZip();
  fetchHandler = () => {
    throw new Error('network down');
  };
  resetFetchCalls();
  resetDiskCache();
  fs.mkdirSync(METADATA_CACHE_DIR, { recursive: true });
  fs.writeFileSync(
    diskCacheFile('anizip_888003.json'),
    JSON.stringify({
      anilistId: 888003,
      fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days old, beyond the 7-day TTL
      episodes: [{ number: 1, title: 'Stale Episode', thumbnailUrl: null, airDate: null, runtime: null }],
    }),
    'utf-8'
  );

  await runTest('fetchAniZipMappings falls back to stale disk cache on failure', async () => {
    const eps = await aniZip.fetchAniZipMappings(888003);
    assert.strictEqual(eps.length, 1);
    assert.strictEqual(eps[0].title, 'Stale Episode');
  });

  await runTest('fetchAniZipMappings returns [] on failure with no cache (never throws)', async () => {
    assert.deepStrictEqual(await aniZip.fetchAniZipMappings(888004), []);
    assert.deepStrictEqual(await aniZip.fetchAniZipMappings(0), []);
    assert.deepStrictEqual(await aniZip.fetchAniZipMappings(-5), []);
  });
}

// --- GROUP 10: userLibrary ---------------------------------------------------------
{
  const { UserLibrary } = await import('./electron/userLibrary.ts');
  const libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-library-test-'));
  const libFile = path.join(libDir, 'user-library.json');

  await runTest('userLibrary setStatus/get + 7s debounce (no immediate write) + flush', async () => {
    const lib = new UserLibrary(libDir);
    assert.deepStrictEqual(lib.getAll(), {}, 'fresh library must start empty');

    const entry = lib.setStatus(101, 52991, 'Frieren: Beyond Journey`s End', 'watching');
    assert.strictEqual(entry.status, 'watching');
    assert.strictEqual(lib.get(101).titleSnapshot, 'Frieren: Beyond Journey`s End');
    assert.ok(!fs.existsSync(libFile), 'debounced flush must NOT write immediately');

    lib.flush();
    assert.ok(fs.existsSync(libFile), 'flush() must force the write');
    const persisted = JSON.parse(fs.readFileSync(libFile, 'utf-8'));
    assert.ok(persisted['101'], 'entries keyed by anilistId');
    assert.strictEqual(persisted['101'].status, 'watching');
    assert.strictEqual(persisted['101'].idMal, 52991);
  });

  await runTest('userLibrary setScore/setProgress + unknown-id no-ops', async () => {
    const lib = new UserLibrary(libDir);
    assert.strictEqual(lib.setScore(101, 9).score, 9);
    assert.strictEqual(lib.setProgress(101, 5).progress, 5);
    assert.strictEqual(lib.get(101).score, 9);
    assert.strictEqual(lib.get(101).progress, 5);

    // score: null clears the score; progress clamps negatives to 0
    assert.strictEqual(lib.setScore(101, null).score, null);
    assert.strictEqual(lib.setProgress(101, -3).progress, 0);

    // Unknown ids: no entry is fabricated
    assert.strictEqual(lib.setScore(555, 7), null);
    assert.strictEqual(lib.setProgress(555, 2), null);
    assert.strictEqual(lib.get(555), null);
    lib.flush();
  });

  await runTest('userLibrary reload round-trip + status change preserves score/progress', async () => {
    const reloaded = new UserLibrary(libDir);
    const all = reloaded.getAll();
    assert.strictEqual(Object.keys(all).length, 1);
    assert.strictEqual(all[101].anilistId, 101);
    assert.strictEqual(all[101].status, 'watching');
    assert.strictEqual(all[101].idMal, 52991);

    reloaded.setStatus(101, null, '', 'completed');
    const updated = reloaded.get(101);
    assert.strictEqual(updated.status, 'completed');
    assert.strictEqual(updated.idMal, 52991, 'null idMal param must keep stored value');
    assert.strictEqual(updated.titleSnapshot, 'Frieren: Beyond Journey`s End', 'empty snapshot param must keep stored value');
    reloaded.flush();
  });

  await runTest('userLibrary remove + invalid status throws', async () => {
    const lib = new UserLibrary(libDir);
    assert.strictEqual(lib.remove(101), true);
    assert.strictEqual(lib.get(101), null);
    assert.strictEqual(lib.remove(101), false, 'removing twice must report false');
    lib.flush();

    const reloaded = new UserLibrary(libDir);
    assert.deepStrictEqual(reloaded.getAll(), {}, 'removal must persist across instances');

    assert.throws(() => lib.setStatus(102, null, 'X', 'bing-watching'), /Invalid user list status/);
    assert.strictEqual(lib.get(102), null);
  });
}

// --- GROUP 11: network hygiene -------------------------------------------------------
await runTest('all network calls stayed on the mocked hosts', async () => {
  const foreign = fetchCalls.filter(
    (c) => !c.url.startsWith('https://graphql.anilist.co') && !c.url.startsWith('https://api.ani.zip')
  );
  assert.strictEqual(foreign.length, 0, `unexpected hosts contacted: ${foreign.map((c) => c.url).join(', ')}`);
});

// ---------------------------------------------------------------------------
console.log('\n----------------------------------------------------------------');
console.log(`Results: ${passedTests} passed, ${failedTests} failed`);
console.log(`Test metadata cache dir: ${METADATA_CACHE_DIR}`);
console.log('----------------------------------------------------------------');
if (failedTests > 0) {
  process.exitCode = 1;
} else {
  console.log('All catalog backend tests passed.');
}
