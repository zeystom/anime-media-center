import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { checkEpisodeDownloading, isFolderDownloading } from './electron/torrents.ts';

console.log('Testing torrent incomplete file detection...');

// 1. Haruhi Movie Test on disk (check whether it is currently downloading or completed)
const haruhiMoviePath = 'D:/films/[anime4life.] The Melancholy Of Haruhi Suzumiya + Movie Dolby TrueHD Dual Audio/[anime4life.] The Disappearance Of Haruhi Suzumiya Movie Dolby TrueHD Dual Audio/The Disappearance Of Haruhi Suzumiya Movie.mkv';

if (fs.existsSync(haruhiMoviePath)) {
  const stat = fs.statSync(haruhiMoviePath);
  const dirFiles = new Set(fs.readdirSync(path.dirname(haruhiMoviePath)).map((f) => f.toLowerCase()));
  const res = checkEpisodeDownloading(haruhiMoviePath, dirFiles, stat);

  console.log('Haruhi Movie Disk Check Result:', res);
  if (res.isDownloading) {
    assert(res.downloadProgress !== undefined, 'Download progress should be reported');
    assert(res.downloadProgress >= 10 && res.downloadProgress <= 100, `Download progress should be between 10% and 100%, got ${res.downloadProgress}%`);
    console.log(`✓ Haruhi movie is still downloading at ${res.downloadProgress}%`);
  } else {
    console.log('✓ Haruhi movie has finished downloading 100% on disk and is ready to play!');
  }
} else {
  console.log('Note: Haruhi movie not found at path; skipping disk test.');
}

// 2. Finished Episode Test (if file exists on disk)
const finishedEpPath = 'D:/films/The Melancholy of Haruhi Suzumiya [DVD-BD 576p-1080p x265 10-bit 2xOpus] [hchcsen]/[hchcsen] The Melancholy of Haruhi Suzumiya S01E01 [DVD 576p x265 10-bit 2xOpus].mkv';

if (fs.existsSync(finishedEpPath)) {
  const stat = fs.statSync(finishedEpPath);
  const dirFiles = new Set(fs.readdirSync(path.dirname(finishedEpPath)).map((f) => f.toLowerCase()));
  const res = checkEpisodeDownloading(finishedEpPath, dirFiles, stat);

  console.log('Finished Episode 1 Result:', res);
  assert.strictEqual(res.isDownloading, false, 'Finished episode 1 must NOT be marked as downloading!');
  console.log('✓ Successfully verified finished episode is NOT flagged as downloading');
}

// 3. Synthetic Unit Tests
// A. Companion extension
const mockFiles = new Set(['episode1.mkv', 'episode1.mkv.!qb']);
const mockStat = { size: 1000000000, blocks: 2000000, mtimeMs: Date.now() - 50000 };
const compRes = checkEpisodeDownloading('C:/dummy/episode1.mkv', mockFiles, mockStat);
assert.strictEqual(compRes.isDownloading, true, 'Companion .!qb must flag as downloading');
console.log('✓ Passed companion .!qb extension test');

// B. 0-byte file
const emptyStat = { size: 0, blocks: 0, mtimeMs: Date.now() };
const emptyRes = checkEpisodeDownloading('C:/dummy/episode2.mkv', new Set(['episode2.mkv']), emptyStat);
assert.strictEqual(emptyRes.isDownloading, true, '0-byte file must flag as downloading');
console.log('✓ Passed 0-byte file test');

// C. Sparse file (allocated < 99% of logical size)
const sparseStat = { size: 1000000000, blocks: 500000, mtimeMs: Date.now() }; // 256MB allocated of 1GB
const sparseRes = checkEpisodeDownloading('C:/dummy/episode3.mkv', new Set(['episode3.mkv']), sparseStat);
assert.strictEqual(sparseRes.isDownloading, true, 'Sparse file with missing clusters must flag as downloading');
assert.strictEqual(sparseRes.downloadProgress, 26, 'Should report ~26% progress');
console.log('✓ Passed sparse file cluster allocation test');

console.log('All torrent detection tests passed!');
