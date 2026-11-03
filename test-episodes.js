import assert from 'assert';
import { extractEpisodeNumber } from './electron/episodes.ts';

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
