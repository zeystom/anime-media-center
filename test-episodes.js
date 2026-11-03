import assert from 'assert';
import { extractEpisodeNumber, parseEpisodeDetails } from './electron/episodes.ts';
import { cleanEpisodeTitle, cleanSeriesTitle } from './src/utils/format.ts';

const testCases = [
  // Original baseline tests:
  { input: '[Group] Steins;Gate 0 - 05 [BD 1080p].mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '[Group] Mob Psycho 100 - 05 [1080p].mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Love Live 2 - 05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show S02E03.mkv', expectedNum: 3, expectedLabel: 'S02E03' },
  { input: 'Frieren - 05 (1080p).mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '[SubsPlease] DanMachi S5 - 08 (1080p) [ABCD].mkv', expectedNum: 8, expectedLabel: 'E08' },
  { input: 'Bleach - 366v2.mkv', expectedNum: 366, expectedLabel: 'E366' },
  { input: 'Show - 05 - Title.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show.Name.05.1080p.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '[Group] Show S2 - 05v2 [1080p].mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Clevatess.2025.S02E01.REPACK2.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu.mkv', expectedNum: 1, expectedLabel: 'S02E01' },

  // Resolution dimensions vs episode numbers:
  { input: '[Erai-raws] Show 1920x1080.mkv', expectedNum: null, expectedLabel: 'EP' },
  { input: '[Erai-raws] Show - 04 [1920x1080].mkv', expectedNum: 4, expectedLabel: 'E04' },
  { input: 'Show.1280x720.05.mkv', expectedNum: 5, expectedLabel: 'E05' },

  // Audio codecs:
  { input: 'Show.E-AC-3.mkv', expectedNum: null, expectedLabel: 'EP' },
  { input: 'Show.DDP5.1.Atmos.mkv', expectedNum: null, expectedLabel: 'EP' },
  { input: 'Show - 03 [E-AC-3 1080p].mkv', expectedNum: 3, expectedLabel: 'E03' },
  { input: 'Show.S01E03.EAC3.1080p.mkv', expectedNum: 3, expectedLabel: 'S01E03' },

  // Shonen 1000+ episodes:
  { input: 'One.Piece.1085.1080p.mkv', expectedNum: 1085, expectedLabel: 'E1085' },
  { input: 'Detective.Conan.1102.1080p.mkv', expectedNum: 1102, expectedLabel: 'E1102' },
  { input: 'One Piece - 1085 [1080p].mkv', expectedNum: 1085, expectedLabel: 'E1085' },

  // Fractional episodes:
  { input: 'Show - 05.5 [1080p].mkv', expectedNum: 5.5, expectedLabel: 'E05.5' },
  { input: 'Show.S02E01.5.1080p.mkv', expectedNum: 1.5, expectedLabel: 'S02E01.5' },

  // Multi-episodes:
  { input: 'Show - S01E01-E02.mkv', expectedNum: 1, expectedLabel: 'S01E01-E02' },
  { input: 'Show - 01-02.mkv', expectedNum: 1, expectedLabel: 'E01-E02' },
  { input: 'Show - E03-E04.mkv', expectedNum: 3, expectedLabel: 'E03-E04' },

  // Specials, OVAs, NC Tracks:
  { input: 'Show - OVA 01.mkv', expectedNum: 1, expectedLabel: 'OVA01' },
  { input: 'Show - SP 02.mkv', expectedNum: 2, expectedLabel: 'SP02' },
  { input: 'Show - NCED1.mkv', expectedNum: 1, expectedLabel: 'NCED01' },
  { input: 'Show - NCOP 02.mkv', expectedNum: 2, expectedLabel: 'NCOP02' },

  // Anime titles with numbers in dot/scene notation:
  { input: 'Mob.Psycho.100.05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '86.Eighty.Six.S01E05.mkv', expectedNum: 5, expectedLabel: 'S01E05' },
  { input: 'Steins;Gate.0.05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Persona.4.05.1080p.mkv', expectedNum: 5, expectedLabel: 'E05' },

  // Unicode typography:
  { input: '[SubsPlease] Show – 05 (1080p).mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show — 05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show 〜 05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show ～ 05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show ― 05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show・05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show - ０５.mkv', expectedNum: 5, expectedLabel: 'E05' },

  // Scene dot notation with release year:
  { input: 'Frieren.2023.05.1080p.mkv', expectedNum: 5, expectedLabel: 'E05' },
];

console.log(`Running ${testCases.length} episode extraction test cases...`);
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
  // Additional cases for cleanEpisodeTitle:
  {
    input: 'Show - S01E01-E02 - Pilot Special.mkv',
    expectedSeries: 'Show',
    expectedEpisodeTitle: 'Pilot Special',
  },
  {
    input: 'Show - 05.5 - Recap Episode.mkv',
    expectedSeries: 'Show',
    expectedEpisodeTitle: 'Recap Episode',
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

const seriesCleanupTests = [
  { input: 'Clevatess.2025.S02.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu', expected: 'Clevatess 2025 (Season 2)' },
  { input: 'Jujutsu Kaisen Season 2', expected: 'Jujutsu Kaisen (Season 2)' },
  { input: 'Mob Psycho 100 2nd Season', expected: 'Mob Psycho 100 (Season 2)' },
  { input: 'DanMachi S05', expected: 'DanMachi (Season 5)' },
];

for (const sct of seriesCleanupTests) {
  const result = cleanSeriesTitle(sct.input);
  assert.strictEqual(result, sct.expected, `Failed cleanSeriesTitle for "${sct.input}": got "${result}", expected "${sct.expected}"`);
  console.log(`✓ Passed series title cleanup: "${sct.input}" -> "${result}"`);
}
