import assert from 'assert';
import { extractEpisodeNumber } from './electron/episodes.ts';
import { cleanEpisodeTitle, cleanSeriesTitle } from './src/utils/format.ts';

const testCases = [
  { input: '[Group] Steins;Gate 0 - 05 [BD 1080p].mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '[Group] Mob Psycho 100 - 05 [1080p].mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Love Live 2 - 05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show S02E03.mkv', expectedNum: 3, expectedLabel: 'S02E03' },
  { input: 'Frieren - 05 (1080p).mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '[SubsPlease] DanMachi S5 - 08 (1080p) [ABCD].mkv', expectedNum: 8, expectedLabel: 'E08' },
  { input: 'Bleach - 366v2.mkv', expectedNum: 366, expectedLabel: 'E366' },
  // Additional cases requested in Round 2:
  { input: 'Show - 05 - Title.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show.Name.05.1080p.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '[Group] Show S2 - 05v2 [1080p].mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Clevatess.2025.S02E01.REPACK2.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu.mkv', expectedNum: 1, expectedLabel: 'S02E01' },
];

for (const tc of testCases) {
  const result = extractEpisodeNumber(tc.input);
  assert.strictEqual(
    result.episodeNum,
    tc.expectedNum,
    `Failed episodeNum for "${tc.input}": got ${result.episodeNum}, expected ${tc.expectedNum}`
  );
  assert.strictEqual(
    result.label,
    tc.expectedLabel,
    `Failed label for "${tc.input}": got ${result.label}, expected ${tc.expectedLabel}`
  );
  console.log(`✓ Passed: "${tc.input}" -> num: ${result.episodeNum}, label: ${result.label}`);
}

console.log(`\nAll ${testCases.length} episode extraction tests passed successfully!`);

// Test cleanEpisodeTitle and cleanSeriesTitle on scene-style release names
const titleTests = [
  {
    input: 'Clevatess.2025.S02E01.REPACK2.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu.mkv',
    expectedSeries: 'Clevatess 2025',
    expectedEpisodeTitle: 'Episode 1',
  },
  {
    input: 'Clevatess.2025.S02E02.REPACK.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu.mkv',
    expectedSeries: 'Clevatess 2025',
    expectedEpisodeTitle: 'Episode 2',
  },
  {
    input: 'Some.Anime.S01E03.COMPLETELY.UNKNOWN.TAGS.AND.WORDS.mkv',
    expectedSeries: 'Some Anime',
    expectedEpisodeTitle: 'Episode 3',
  },
  {
    input: 'Another.Anime.2024.S03E15.AMZN.WEB-DL.DDP5.1.Atmos.DV.HDR10Plus.H.265-FLUX.mkv',
    expectedSeries: 'Another Anime 2024',
    expectedEpisodeTitle: 'Episode 15',
  },
  {
    input: '[SomeGroup] Cool Anime - S02E04 - The Real Episode Title (1080p).mkv',
    expectedSeries: 'Cool Anime',
    expectedEpisodeTitle: 'The Real Episode Title',
  },
];

for (const tt of titleTests) {
  const parsed = cleanEpisodeTitle(tt.input);
  assert.strictEqual(
    parsed.seriesTitle,
    tt.expectedSeries,
    `Failed seriesTitle for "${tt.input}": got "${parsed.seriesTitle}", expected "${tt.expectedSeries}"`
  );
  assert.strictEqual(
    parsed.displayTitle,
    tt.expectedEpisodeTitle,
    `Failed displayTitle for "${tt.input}": got "${parsed.displayTitle}", expected "${tt.expectedEpisodeTitle}"`
  );
  console.log(`✓ Passed title cleanup: "${tt.input}" -> series: "${parsed.seriesTitle}", displayTitle: "${parsed.displayTitle}"`);
}

const seriesCleanupTest = cleanSeriesTitle('Clevatess.2025.S02.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu');
assert.strictEqual(seriesCleanupTest, 'Clevatess 2025 (Season 2)');
console.log(`✓ Passed series title cleanup: "Clevatess.2025.S02..." -> "${seriesCleanupTest}"`);
