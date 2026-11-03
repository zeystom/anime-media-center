import assert from 'assert';
import {
  cleanSeriesTitle,
  formatEpisodeDisplayTitle,
  isFolderMovie,
  getPathBasename,
  getPathDirname,
} from './src/utils/format.ts';

console.log('Running Milestone 2 Verification Suite...\n');

// ==========================================
// 1. cleanSeriesTitle & Parentheses Idempotency
// ==========================================
console.log('1. Testing cleanSeriesTitle parentheses handling & idempotency:');

const titleTests = [
  {
    input: 'Clevatess.2025.S02.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu',
    expected: 'Clevatess 2025 (Season 2)',
    desc: 'Scene release with S02',
  },
  {
    input: 'Jujutsu Kaisen Season 2',
    expected: 'Jujutsu Kaisen (Season 2)',
    desc: 'Standard Season 2 formatting',
  },
  {
    input: 'Mob Psycho 100 2nd Season',
    expected: 'Mob Psycho 100 (Season 2)',
    desc: 'Ordinal 2nd Season formatting',
  },
  {
    input: 'DanMachi S05',
    expected: 'DanMachi (Season 5)',
    desc: 'DanMachi S05 formatting',
  },
  {
    input: 'Show (Season 1)',
    expected: 'Show (Season 1)',
    desc: 'Preserves existing parenthesized Season 1',
  },
  {
    input: 'Show ( (Season 1 ))',
    expected: 'Show (Season 1)',
    desc: 'Repairs corrupted double parentheses without nesting',
  },
  {
    input: 'Show (Season 2 Part 2)',
    expected: 'Show (Season 2 Part 2)',
    desc: 'Preserves Season 2 with Part 2',
  },
  {
    input: 'Cowboy Bebop (1998)',
    expected: 'Cowboy Bebop (1998)',
    desc: 'Preserves 4-digit release year in parentheses',
  },
  {
    input: 'Show [1080p] [Fansub]',
    expected: 'Show',
    desc: 'Strips quality and group bracketed tags',
  },
  {
    input: 'Show (((Season 1)))',
    expected: 'Show (Season 1)',
    desc: 'Collapses triple nested parentheses cleanly',
  },
  {
    input: 'Show (Season 1) (Season 1)',
    expected: 'Show (Season 1)',
    desc: 'Deduplicates duplicate season mentions without unbalanced parens',
  },
  {
    input: 'Show Season 1 (2024)',
    expected: 'Show (Season 1) (2024)',
    desc: 'Preserves trailing metadata year with balanced parentheses',
  },
];

for (const t of titleTests) {
  const result = cleanSeriesTitle(t.input);
  assert.strictEqual(
    result,
    t.expected,
    `Failed ${t.desc}: expected "${t.expected}", got "${result}"`
  );
  // Idempotency check: running cleanSeriesTitle on the result must produce the same result
  const repeated = cleanSeriesTitle(result);
  assert.strictEqual(
    repeated,
    t.expected,
    `Idempotency failed for "${result}": running again produced "${repeated}"`
  );
  console.log(`  ✓ Passed: "${t.input}" -> "${result}" (Idempotent)`);
}

// ==========================================
// 2. formatEpisodeDisplayTitle & Dead Code Elimination
// ==========================================
console.log('\n2. Testing formatEpisodeDisplayTitle & dead code elimination:');

const epTitleTests = [
  {
    parsed: 'Episode 1',
    apiTitle: 'The Lord of Dark Beasts',
    expected: 'Episode 1 — The Lord of Dark Beasts',
    desc: 'Generic "Episode 1" combined with official API title',
  },
  {
    parsed: 'EP 05',
    apiTitle: 'Resonance',
    expected: 'EP 05 — Resonance',
    desc: 'Generic "EP 05" combined with official API title',
  },
  {
    parsed: 'The Lord of Dark Beasts',
    apiTitle: 'The Lord of Dark Beasts',
    expected: 'The Lord of Dark Beasts',
    desc: 'Identical parsed and API titles deduplicated',
  },
  {
    parsed: 'Episode 1 — The Lord of Dark Beasts',
    apiTitle: 'The Lord of Dark Beasts',
    expected: 'Episode 1 — The Lord of Dark Beasts',
    desc: 'Parsed title already containing API title deduplicated',
  },
  {
    parsed: '',
    apiTitle: 'The Lord of Dark Beasts',
    expected: 'The Lord of Dark Beasts',
    desc: 'Empty parsed title falls back cleanly to API title',
  },
  {
    parsed: 'Episode 1',
    apiTitle: '',
    expected: 'Episode 1',
    desc: 'Empty API title returns parsed title',
  },
  {
    parsed: {
      fileName: '[SubsPlease] Frieren - 01 (1080p).mkv',
      kitsuTitle: 'The Journey Begins',
    },
    apiTitle: null,
    expected: 'Episode 1 — The Journey Begins',
    desc: 'Episode object parsed correctly with kitsuTitle',
  },
  {
    parsed: '   Episode 1   ',
    apiTitle: '',
    expected: 'Episode 1',
    desc: 'Untrimmed parsed title is cleanly trimmed when API title is empty',
  },
];

for (const t of epTitleTests) {
  const result = formatEpisodeDisplayTitle(t.parsed, t.apiTitle);
  assert.strictEqual(
    result,
    t.expected,
    `Failed ${t.desc}: expected "${t.expected}", got "${result}"`
  );
  console.log(`  ✓ Passed: ${t.desc} -> "${result}"`);
}

// ==========================================
// 3. isFolderMovie with Duration & Pattern Check
// ==========================================
console.log('\n3. Testing isFolderMovie duration & pattern heuristics:');

// Feature film with probed duration 90 minutes (5400s)
const movieByDuration = isFolderMovie({
  folderName: 'Kimi no Na wa',
  episodes: [{ fileName: 'Kimi no Na wa.mkv', duration: 5400 }],
});
assert.strictEqual(movieByDuration, true, 'Expected 5400s file to be detected as Movie');
console.log('  ✓ Passed: 5400s standalone video classified as Movie');

// TV episode with probed duration 24 minutes (1440s)
const tvByDuration = isFolderMovie({
  folderName: 'Frieren',
  episodes: [{ fileName: 'Frieren - 01.mkv', duration: 1440 }],
});
assert.strictEqual(tvByDuration, false, 'Expected 1440s TV episode NOT to be detected as Movie');
console.log('  ✓ Passed: 1440s TV episode NOT classified as Movie');

// Short anime episode with probed duration 3 minutes (180s)
const shortTvEpisode = isFolderMovie({
  folderName: 'Teekyuu',
  episodes: [{ fileName: 'Teekyuu - 01.mkv', duration: 180 }],
});
assert.strictEqual(shortTvEpisode, false, 'Expected 180s short TV episode NOT to be detected as Movie');
console.log('  ✓ Passed: 180s short TV episode NOT classified as Movie');

// Explicit Movie keyword in folderName
const movieByKeyword = isFolderMovie({
  folderName: 'Demon Slayer Movie Mugen Train',
  episodes: [{ fileName: 'mugen_train.mkv', duration: 0 }],
});
assert.strictEqual(movieByKeyword, true, 'Expected Movie keyword to identify as Movie');
console.log('  ✓ Passed: Explicit "Movie" keyword classified as Movie');

// Single episode of TV series with S01E01 pattern (unknown duration)
const singleTvSeasonEpisode = isFolderMovie({
  folderName: 'Oshi no Ko',
  episodes: [{ fileName: 'Oshi no Ko S01E01.mkv' }],
});
assert.strictEqual(singleTvSeasonEpisode, false, 'Expected S01E01 NOT to be classified as Movie');
console.log('  ✓ Passed: S01E01 episode NOT classified as Movie');

// Single episode of TV series with " - 01" pattern (unknown duration)
const singleTvNumberedEpisode = isFolderMovie({
  folderName: 'Dandadan',
  episodes: [{ fileName: '[SubsPlease] Dandadan - 01 [1080p].mkv' }],
});
assert.strictEqual(singleTvNumberedEpisode, false, 'Expected "- 01" NOT to be classified as Movie');
console.log('  ✓ Passed: "- 01" episode NOT classified as Movie');

// Single episode of TV series with standard format ending directly in extension (e.g. Frieren - 01.mkv)
const singleTvStandardFilename = isFolderMovie({
  folderName: 'Frieren',
  episodes: [{ fileName: 'Frieren - 01.mkv' }],
});
assert.strictEqual(singleTvStandardFilename, false, 'Expected "Frieren - 01.mkv" NOT to be classified as Movie');
console.log('  ✓ Passed: "Frieren - 01.mkv" NOT classified as Movie');

const singleTvOshiNoKo = isFolderMovie({
  folderName: 'Oshi no Ko',
  episodes: [{ fileName: 'Oshi no Ko - 01.mkv' }],
});
assert.strictEqual(singleTvOshiNoKo, false, 'Expected "Oshi no Ko - 01.mkv" NOT to be classified as Movie');
console.log('  ✓ Passed: "Oshi no Ko - 01.mkv" NOT classified as Movie');

const singleTvEpisodeNumberOnly = isFolderMovie({
  folderName: 'DanMachi',
  episodes: [{ fileName: 'DanMachi.mkv', episodeNumber: 'E01' }],
});
assert.strictEqual(singleTvEpisodeNumberOnly, false, 'Expected episodeNumber E01 NOT to be classified as Movie');
console.log('  ✓ Passed: episodeNumber "E01" NOT classified as Movie');

// Multi-episode series folder
const multiEpisodeFolder = isFolderMovie({
  folderName: 'Steins;Gate',
  episodes: [
    { fileName: 'Steins;Gate - 01.mkv', duration: 1440 },
    { fileName: 'Steins;Gate - 02.mkv', duration: 1440 },
  ],
});
assert.strictEqual(multiEpisodeFolder, false, 'Expected multi-episode folder NOT to be Movie');
console.log('  ✓ Passed: Multi-episode folder NOT classified as Movie');

// ==========================================
// 4. Cross-Platform Path Helpers
// ==========================================
console.log('\n4. Testing cross-platform getPathBasename and getPathDirname:');

const pathTests = [
  {
    path: 'C:\\Anime\\Frieren\\Season 1\\Episode 01.mkv',
    expectedBasename: 'Episode 01.mkv',
    expectedDirname: 'C:\\Anime\\Frieren\\Season 1',
  },
  {
    path: 'D:\\Media\\Movies\\Your Name.mkv',
    expectedBasename: 'Your Name.mkv',
    expectedDirname: 'D:\\Media\\Movies',
  },
  {
    path: '/home/user/anime/cowboy_bebop/ep01.mkv',
    expectedBasename: 'ep01.mkv',
    expectedDirname: '/home/user/anime/cowboy_bebop',
  },
  {
    path: 'C:\\Anime\\Frieren\\',
    expectedBasename: 'Frieren',
    expectedDirname: 'C:\\Anime',
  },
  {
    path: '/mnt/media/anime/',
    expectedBasename: 'anime',
    expectedDirname: '/mnt/media',
  },
  {
    path: 'C:\\Anime\\Folder\\\\ep01.mkv',
    expectedBasename: 'ep01.mkv',
    expectedDirname: 'C:\\Anime\\Folder',
  },
];

for (const pt of pathTests) {
  const b = getPathBasename(pt.path);
  const d = getPathDirname(pt.path);
  assert.strictEqual(b, pt.expectedBasename, `Basename mismatch for ${pt.path}`);
  assert.strictEqual(d, pt.expectedDirname, `Dirname mismatch for ${pt.path}`);
  console.log(`  ✓ Passed: "${pt.path}" -> base: "${b}", dir: "${d}"`);
}

// ==========================================
// 5. Fallback AnimeFolder Construction Validation (BUG-01 Fix)
// ==========================================
console.log('\n5. Testing Fallback AnimeFolder Construction logic for BUG-01:');

const orphanedEpisode = {
  filePath: 'E:\\Anime\\Steins Gate\\Steins;Gate - 01 [BD 1080p].mkv',
  fileName: 'Steins;Gate - 01 [BD 1080p].mkv',
  episodeNumber: 'E01',
  title: 'Turning Point',
  size: 1420556000,
  hasExternalSrt: false,
  hasEmbeddedSubtitles: true,
};

const folderPath = getPathDirname(orphanedEpisode.filePath);
const folderName = getPathBasename(folderPath) || orphanedEpisode.title || 'Playing Media';
const fallbackFolder = {
  folderPath,
  folderName,
  canonicalTitle: orphanedEpisode.title || folderName,
  episodes: [orphanedEpisode],
  totalEpisodes: 1,
  hasSubtitlesCount:
    orphanedEpisode.hasExternalSrt ||
    orphanedEpisode.hasEmbeddedSubtitles ||
    orphanedEpisode.hasEmbeddedDubtitles ||
    orphanedEpisode.hasWhisperSrt
      ? 1
      : 0,
  isDownloading: false,
};

assert.strictEqual(fallbackFolder.folderPath, 'E:\\Anime\\Steins Gate');
assert.strictEqual(fallbackFolder.folderName, 'Steins Gate');
assert.strictEqual(fallbackFolder.episodes.length, 1);
assert.strictEqual(fallbackFolder.totalEpisodes, 1);
assert.strictEqual(fallbackFolder.hasSubtitlesCount, 1);
assert.strictEqual(fallbackFolder.isDownloading, false);

console.log('  ✓ Passed: Fallback AnimeFolder constructs robust folder metadata cleanly');

console.log('\nAll Milestone 2 verification tests PASSED 100%!');
