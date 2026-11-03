// Test episode number extraction according to Group 3 requirements
import assert from 'assert';

function extractEpisodeNumber(fileName) {
  const withoutExt = fileName.replace(/\.[a-zA-Z0-9]+$/, '');
  const cleaned = withoutExt.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').trim();

  // 1. SxxExx e.g. S01E05
  const sxxExxMatch = cleaned.match(/\bs(\d+)e(\d+)\b/i);
  if (sxxExxMatch) {
    const n = parseInt(sxxExxMatch[2], 10);
    return {
      episodeNum: n,
      label: `S${sxxExxMatch[1].padStart(2, '0')}E${sxxExxMatch[2].padStart(2, '0')}`,
    };
  }

  // 2. \b(?:ep|episode|e)[_.\s-]*(\d+)\b with word boundary
  const epWordMatch = cleaned.match(/\b(?:ep|episode|e)[_.\s-]*(\d+)\b/i);
  if (epWordMatch) {
    const n = parseInt(epWordMatch[1], 10);
    return {
      episodeNum: n,
      label: `E${n.toString().padStart(2, '0')}`,
    };
  }

  // 3. NxNN e.g. 1x05
  const nxMatch = cleaned.match(/\b\d+x(\d+)\b/i);
  if (nxMatch) {
    const n = parseInt(nxMatch[1], 10);
    return {
      episodeNum: n,
      label: `E${n.toString().padStart(2, '0')}`,
    };
  }

  // 4. Number after ' - ' with optional version: \s-\s(\d{1,4})(?:v\d+)?\b
  const dashMatch = cleaned.match(/\s-\s(\d{1,4})(?:v\d+)?\b/i);
  if (dashMatch) {
    const n = parseInt(dashMatch[1], 10);
    return {
      episodeNum: n,
      label: `E${n.toString().padStart(2, '0')}`,
    };
  }

  // 5. Fallback: number bounded by separator
  const fallbackMatch = cleaned.match(/[-_.\s](\d{1,3})(?:v\d+)?\b/);
  if (fallbackMatch) {
    const n = parseInt(fallbackMatch[1], 10);
    return {
      episodeNum: n,
      label: `E${n.toString().padStart(2, '0')}`,
    };
  }

  return { episodeNum: null, label: 'EP' };
}

const testCases = [
  { input: '[Group] Steins;Gate 0 - 05 [BD 1080p].mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '[Group] Mob Psycho 100 - 05 [1080p].mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Love Live 2 - 05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show S02E03.mkv', expectedNum: 3, expectedLabel: 'S02E03' },
  { input: 'Frieren - 05 (1080p).mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '[SubsPlease] DanMachi S5 - 08 (1080p) [ABCD].mkv', expectedNum: 8, expectedLabel: 'E08' },
  { input: 'Bleach - 366v2.mkv', expectedNum: 366, expectedLabel: 'E366' },
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

console.log('\nAll episode extraction tests passed successfully!');
