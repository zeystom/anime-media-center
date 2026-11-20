/**
 * Regression tests for ongoing anime release selection, download planning,
 * multi-drive folder merging, and catalog alias generation.
 *
 * Run: node test-ongoing-logic.js
 */
import assert from 'node:assert/strict';
import {
  buildCatalogSearchAliases,
  computeOngoingDownloadPlan,
  findAllLocalFolders,
  inferReleasePreferenceFromEpisodes,
  mergeLocalFolders,
  parseNumericEpisodeNumber,
  pickAutomaticEpisodeRelease,
  pickAutomaticSeasonRelease,
  readAnimeReleasePreference,
  recordPickedReleasePreference,
} from './src/utils/releaseSelection.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${name}: ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

function makeFolder(overrides = {}) {
  return {
    folderPath: 'D:\\Anime\\Test Show',
    folderName: 'Test Show',
    canonicalTitle: 'Test Show',
    posterUrl: null,
    bannerUrl: null,
    synopsis: null,
    genres: [],
    averageScore: null,
    episodes: [],
    anilistId: 101,
    totalEpisodes: 12,
    hasSubtitlesCount: 0,
    hasWhisperCount: 0,
    hasExtSubCount: 0,
    hasDubtitlesCount: 0,
    hasEmbeddedDubtitles: false,
    hasEmbeddedSubtitles: false,
    ...overrides,
  };
}

function makeEpisode(fileName, episodeNumber, extra = {}) {
  return {
    filePath: `D:\\Anime\\Test Show\\${fileName}`,
    fileName,
    episodeTitle: fileName,
    episodeNumber,
    size: 500_000_000,
    ...extra,
  };
}

console.log('Running ongoing logic test suite...');

test('pickAutomaticEpisodeRelease: prefers remembered release group (SubsPlease > Erai-raws)', () => {
  const erai = {
    title: '[Erai-raws] Cool Show - 05 [1080p][Dual Audio][Eng-Subs].mkv',
    seeders: 120,
    titleRelevance: 'exact',
  };
  const subsPlease = {
    title: '[SubsPlease] Cool Show - 05 [1080p][Dual Audio][Eng-Subs].mkv',
    seeders: 45,
    titleRelevance: 'exact',
  };

  const withoutPref = pickAutomaticEpisodeRelease([erai, subsPlease], {
    audioPreferences: ['en'],
    subtitlePreferences: ['en'],
  });
  assert.equal(withoutPref.best?.title, erai.title);

  const withPref = pickAutomaticEpisodeRelease([erai, subsPlease], {
    audioPreferences: ['en'],
    subtitlePreferences: ['en'],
    animePref: { preferredGroup: 'SubsPlease' },
  });
  assert.equal(withPref.best?.title, subsPlease.title);
  assert.equal(withPref.usedEnglishDubFallback, false);
});

test('pickAutomaticEpisodeRelease: audioMode=sub allows JP+EngSub even when global pref is English dub', () => {
  const judasDub = {
    title: '[Judas] Cool Show - 06 [1080p][Dual Audio][Eng-Subs].mkv',
    seeders: 80,
    titleRelevance: 'exact',
  };
  const subsPleaseSub = {
    title: '[SubsPlease] Cool Show - 06 (1080p) [Eng-Subs].mkv',
    seeders: 60,
    titleRelevance: 'exact',
  };

  const picked = pickAutomaticEpisodeRelease([judasDub, subsPleaseSub], {
    audioPreferences: ['en'],
    subtitlePreferences: ['en'],
    animePref: { audioMode: 'sub', preferredGroup: 'SubsPlease' },
  });
  assert.equal(picked.best?.title, subsPleaseSub.title);
  assert.equal(picked.usedEnglishDubFallback, false);
  assert.equal(picked.hasJapaneseSubAlternative, false);
});

test('pickAutomaticEpisodeRelease: flags hasJapaneseSubAlternative when only sub releases exist under dub settings', () => {
  const subOnly = {
    title: '[SubsPlease] Cool Show - 06 (1080p) [Eng-Subs].mkv',
    seeders: 90,
    titleRelevance: 'exact',
  };
  const picked = pickAutomaticEpisodeRelease([subOnly], {
    audioPreferences: ['en'],
    subtitlePreferences: ['en'],
  });
  assert.equal(picked.best, null);
  assert.equal(picked.usedEnglishDubFallback, false);
  assert.equal(picked.hasJapaneseSubAlternative, true);
});

test('pickAutomaticEpisodeRelease & pickAutomaticSeasonRelease: prefer seeded releases and block unrelated titles', () => {
  const related = {
    title: '[Judas] Cool Show SpinOff - 01 [1080p][Dual Audio][Eng-Subs].mkv',
    seeders: 200,
    titleRelevance: 'related',
  };
  const zeroSeed = {
    title: '[Judas] Cool Show - 01 [1080p][Dual Audio][Eng-Subs].mkv',
    seeders: 0,
    titleRelevance: 'exact',
  };
  const seeded = {
    title: '[SubsPlease] Cool Show - 01 [1080p][Dual Audio][Eng-Subs].mkv',
    seeders: 14,
    titleRelevance: 'exact',
  };

  const epPicked = pickAutomaticEpisodeRelease([related, zeroSeed, seeded], {
    audioPreferences: ['en'],
    subtitlePreferences: ['en'],
  });
  assert.equal(epPicked.best?.title, seeded.title);

  const zeroPack = {
    title: '[Judas] Cool Show S01 [1080p][Dual Audio][Eng-Subs] Batch',
    seeders: 0,
    titleRelevance: 'exact',
  };
  const seededPack = {
    title: '[Erai-raws] Cool Show S01 (01-12) [1080p][Dual Audio][Eng-Subs] Batch',
    seeders: 18,
    titleRelevance: 'exact',
  };
  const seasonPicked = pickAutomaticSeasonRelease([zeroPack, seededPack], {
    isOvaTitle: false,
    audioPreferences: ['en'],
    subtitlePreferences: ['en'],
    animePref: { preferredGroup: 'Erai-raws' },
  });
  assert.equal(seasonPicked.best?.title, seededPack.title);
});

test('computeOngoingDownloadPlan: mid-season, partial, up-to-date, active, and watched-and-deleted flows', () => {
  const freshPlan = computeOngoingDownloadPlan({
    status: 'RELEASING',
    isFeatureFilm: false,
    isSingleEpisodeEntry: false,
    releasedEpisodeCount: 7,
    episodeTotal: 12,
    downloadedEpisodeNums: [],
    activeEpisodeNums: [],
    watchedEpisodeNums: [],
    watchedMaxProgress: 0,
  });
  assert.equal(freshPlan.isOngoing, true);
  assert.equal(freshPlan.buttonLabel, 'Download aired (7)');
  assert.equal(freshPlan.buttonDisabled, false);
  assert.deepEqual(freshPlan.targetEpisodes, [1, 2, 3, 4, 5, 6, 7]);

  const partialPlan = computeOngoingDownloadPlan({
    status: 'RELEASING',
    isFeatureFilm: false,
    isSingleEpisodeEntry: false,
    releasedEpisodeCount: 7,
    episodeTotal: 12,
    downloadedEpisodeNums: [1, 2, 3],
    activeEpisodeNums: [],
    watchedEpisodeNums: [],
    watchedMaxProgress: 0,
  });
  assert.equal(partialPlan.buttonLabel, 'Download 4 missing');
  assert.equal(partialPlan.buttonDisabled, false);
  assert.deepEqual(partialPlan.targetEpisodes, [4, 5, 6, 7]);

  const upToDatePlan = computeOngoingDownloadPlan({
    status: 'RELEASING',
    isFeatureFilm: false,
    isSingleEpisodeEntry: false,
    releasedEpisodeCount: 7,
    episodeTotal: 12,
    downloadedEpisodeNums: [1, 2, 3, 4, 5, 6, 7],
    activeEpisodeNums: [],
    watchedEpisodeNums: [1, 2],
    watchedMaxProgress: 2,
  });
  assert.equal(upToDatePlan.allAiredDownloaded, true);
  assert.equal(upToDatePlan.buttonLabel, 'Up to date (7/12)');
  assert.equal(upToDatePlan.buttonDisabled, true);
  assert.deepEqual(upToDatePlan.targetEpisodes, []);

  const downloadingPlan = computeOngoingDownloadPlan({
    status: 'RELEASING',
    isFeatureFilm: false,
    isSingleEpisodeEntry: false,
    releasedEpisodeCount: 7,
    episodeTotal: 12,
    downloadedEpisodeNums: [1, 2, 3, 4, 5],
    activeEpisodeNums: [6, 7],
    watchedEpisodeNums: [],
    watchedMaxProgress: 0,
  });
  assert.equal(downloadingPlan.buttonLabel, 'Downloading (7/12)');
  assert.equal(downloadingPlan.buttonDisabled, true);
  assert.deepEqual(downloadingPlan.targetEpisodes, []);

  const watchedDeletedPlan = computeOngoingDownloadPlan({
    status: 'RELEASING',
    isFeatureFilm: false,
    isSingleEpisodeEntry: false,
    releasedEpisodeCount: 7,
    episodeTotal: 12,
    downloadedEpisodeNums: [],
    activeEpisodeNums: [],
    watchedEpisodeNums: [1, 2, 3, 4, 5],
    watchedMaxProgress: 5,
  });
  assert.equal(watchedDeletedPlan.allAiredWatchedAndCleared, false);
  assert.deepEqual(watchedDeletedPlan.targetEpisodes, [6, 7]);
  assert.equal(watchedDeletedPlan.buttonLabel, 'Download 2 new');

  const allWatchedDeletedPlan = computeOngoingDownloadPlan({
    status: 'RELEASING',
    isFeatureFilm: false,
    isSingleEpisodeEntry: false,
    releasedEpisodeCount: 7,
    episodeTotal: 12,
    downloadedEpisodeNums: [],
    activeEpisodeNums: [],
    watchedEpisodeNums: [1, 2, 3, 4, 5, 6, 7],
    watchedMaxProgress: 7,
  });
  assert.equal(allWatchedDeletedPlan.allAiredWatchedAndCleared, true);
  assert.deepEqual(allWatchedDeletedPlan.targetEpisodes, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(allWatchedDeletedPlan.buttonLabel, 'Download aired (7)');
});

test('findAllLocalFolders & mergeLocalFolders: merges drives D: and E: while isolating distinct AniList IDs', () => {
  const driveD = makeFolder({
    folderPath: 'D:\\films\\Frieren',
    folderName: 'Frieren',
    canonicalTitle: 'Frieren',
    anilistId: 154587,
    episodes: [1, 2, 3, 4, 5, 6].map((n) =>
      makeEpisode(`[SubsPlease] Frieren - 0${n} (1080p).mkv`, `S01E0${n}`, {
        filePath: `D:\\films\\Frieren\\[SubsPlease] Frieren - 0${n} (1080p).mkv`,
        hasEmbeddedSubtitles: true,
      }),
    ),
    hasEmbeddedSubtitles: true,
  });
  const driveE = makeFolder({
    folderPath: 'E:\\Anime\\Frieren',
    folderName: 'Frieren',
    canonicalTitle: 'Frieren',
    anilistId: 154587,
    episodes: [7, 8].map((n) =>
      makeEpisode(`[SubsPlease] Frieren - 0${n} (1080p).mkv`, `S01E0${n}`, {
        filePath: `E:\\Anime\\Frieren\\[SubsPlease] Frieren - 0${n} (1080p).mkv`,
        hasExternalSrt: n === 8,
      }),
    ),
    hasExtSubCount: 1,
  });
  const unrelatedOtherId = makeFolder({
    folderPath: 'D:\\films\\Frieren Other',
    folderName: 'Frieren',
    canonicalTitle: 'Frieren',
    anilistId: 999999,
  });

  const matched = findAllLocalFolders([driveD, driveE, unrelatedOtherId], {
    anilistId: 154587,
    title: 'Frieren',
  });
  assert.equal(matched.length, 2);

  const merged = mergeLocalFolders(matched);
  assert.ok(merged);
  assert.equal(merged.episodes.length, 8);
  assert.deepEqual(
    merged.episodes.map((ep) => parseNumericEpisodeNumber(ep.fileName, ep.episodeNumber)),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(merged.hasEmbeddedSubtitles, true);
  assert.equal(merged.hasExtSubCount, 1);

  // An unowned AniList ID must NOT borrow a folder tagged with a different AniList ID.
  const isolated = findAllLocalFolders([driveD, unrelatedOtherId], {
    anilistId: 777777,
    title: 'Frieren',
  });
  assert.equal(isolated.length, 0);

  // Untagged local folders (anilistId: null) may still match by title.
  const untagged = makeFolder({ anilistId: null, folderName: 'Frieren', canonicalTitle: 'Frieren' });
  const untaggedMatch = findAllLocalFolders([driveD, untagged], {
    anilistId: 777777,
    title: 'Frieren',
  });
  assert.equal(untaggedMatch.length, 1);
  assert.equal(untaggedMatch[0].folderPath, untagged.folderPath);
});

test('buildCatalogSearchAliases: handles OVA + TV_SHORT parent, parentDerivedAliases, and prefixSynonyms', () => {
  const aliases = buildCatalogSearchAliases(
    'Dating a Dark Summoner OVA',
    {
      format: 'OVA',
      title: {
        english: 'Dating a Dark Summoner OVA',
        romaji: 'Dark Summoner to Dekiteiru OVA',
      },
      synonyms: [
        'Dating a Dark Summoner',
        'ShortTag',
        '暗い召喚師',
        'Dark Summoner Spin-Off Related',
      ],
    },
    [
      {
        relationType: 'PARENT',
        format: 'TV_SHORT',
        title: {
          english: 'Dating a Dark Summoner',
          romaji: 'Dark Summoner to Dekiteiru',
        },
      },
      {
        relationType: 'SIDE_STORY',
        format: 'SPECIAL',
        title: {
          english: 'Dark Summoner Spin-Off Related',
          romaji: 'Dark Summoner Spin-Off Related',
        },
      },
    ],
  );

  assert.ok(aliases.includes('Dating a Dark Summoner'));
  assert.ok(aliases.includes('Dark Summoner to Dekiteiru OVA'));
  assert.ok(aliases.includes('Dark Summoner to Dekiteiru'));
  assert.equal(aliases.includes('ShortTag'), false);
  assert.equal(aliases.includes('暗い召喚師'), false);
  assert.equal(aliases.includes('Dark Summoner Spin-Off Related'), false);

  const sideStoryAliases = buildCatalogSearchAliases(
    'Slime Diaries: Extra Tales',
    {
      format: 'TV',
      title: {
        english: 'Slime Diaries: Extra Tales',
        romaji: 'Tensura Nikki: Bangaihen',
      },
      synonyms: [],
    },
    [
      {
        relationType: 'MAIN_STORY',
        format: 'TV',
        title: {
          english: 'Slime Diaries',
          romaji: 'Tensura Nikki',
        },
      },
    ],
  );
  assert.ok(sideStoryAliases.includes('Tensura Nikki Extra Tales'));
});

test('recordPickedReleasePreference & inferReleasePreferenceFromEpisodes persist per-anime release prefs', () => {
  const store = new Map();
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
  try {
    recordPickedReleasePreference(4242, {
      title: '[SubsPlease] Sample Show - 03 (1080p) [Eng-Subs].mkv',
      description: '',
    });
    const pref = readAnimeReleasePreference(4242);
    assert.equal(pref?.preferredGroup, 'SubsPlease');
    assert.equal(pref?.audioMode, 'sub');

    const inferred = inferReleasePreferenceFromEpisodes([
      { fileName: '[Erai-raws] Sample - 01 [1080p].mkv' },
      { fileName: '[SubsPlease] Sample - 02 (1080p).mkv' },
      { fileName: '[SubsPlease] Sample - 03 (1080p).mkv' },
    ]);
    assert.equal(inferred.preferredGroup, 'SubsPlease');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
