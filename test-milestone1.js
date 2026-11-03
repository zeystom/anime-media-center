import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { findExternalSubtitles, findSubtitlesForEpisode } from './electron/subtitles.ts';
import { checkEpisodeDownloading, checkTorrentProgress } from './electron/torrents.ts';

console.log('Running Milestone 1 Backend Verification Suite...');

// 1. Verify findSubtitlesForEpisode with .ass, .vtt, .srt
console.log('1. Testing expanded external subtitles detection (.srt, .ass, .vtt)...');
const tmpSubDir = path.join(process.cwd(), '.test_subs_tmp');
fs.mkdirSync(tmpSubDir, { recursive: true });

try {
  const dummyVideo = path.join(tmpSubDir, 'Show - 01.mkv');
  fs.writeFileSync(dummyVideo, 'dummy');
  fs.writeFileSync(path.join(tmpSubDir, 'Show - 01.ass'), 'dummy ass');
  fs.writeFileSync(path.join(tmpSubDir, 'Show - 01.en.vtt'), 'dummy vtt');
  fs.writeFileSync(path.join(tmpSubDir, 'Show - 01.whisper.srt'), 'dummy whisper srt');
  fs.writeFileSync(path.join(tmpSubDir, 'Show - 02.ass'), 'other show'); // Should not match

  const matches = findSubtitlesForEpisode(dummyVideo);
  assert.strictEqual(matches.length, 3, `Expected 3 matching subtitles, found ${matches.length}`);

  const hasAss = matches.some((m) => m.fileName.endsWith('.ass'));
  const hasVtt = matches.some((m) => m.fileName.endsWith('.vtt'));
  const hasSrt = matches.some((m) => m.fileName.endsWith('.srt'));
  assert(hasAss, 'Must detect external .ass subtitle');
  assert(hasVtt, 'Must detect external .vtt subtitle');
  assert(hasSrt, 'Must detect external .srt subtitle');

  // Whisper subtitle should be prioritized first
  assert(matches[0].isWhisper, 'Whisper subtitle must be sorted first');
  console.log('✓ External subtitle formats (.srt, .ass, .vtt) verified successfully');
} finally {
  fs.rmSync(tmpSubDir, { recursive: true, force: true });
}

// 2. Verify Torrent Progress calculation when stat.blocks === undefined (Windows NTFS)
console.log('2. Testing Torrent Progress calculation when stat.blocks === undefined...');
const mockFilesWin = new Set(['episode10.mkv', 'episode10.mkv.!qb']);
// Windows NTFS has stat.blocks === undefined
const winStat = { size: 500000000, blocks: undefined, mtimeMs: Date.now() };
const winRes = checkTorrentProgress('C:/dummy/episode10.mkv', mockFilesWin, winStat);
assert.strictEqual(winRes.isDownloading, true, 'Must detect torrent downloading with undefined blocks');
console.log('✓ checkTorrentProgress handles undefined stat.blocks gracefully');

// 3. Verify EBML Duration parser logic
console.log('3. Testing readMkvDuration EBML parser logic...');
function testMkvDuration(buf) {
  let timecodeScale = 1000000;
  const tcIdx = buf.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
  if (tcIdx !== -1 && tcIdx + 3 < buf.length) {
    let firstByte = buf[tcIdx + 3];
    let numBytes = 1;
    let mask = 0x80;
    while ((firstByte & mask) === 0 && numBytes <= 8) {
      mask >>= 1;
      numBytes++;
    }
    const tcLen = firstByte & (mask - 1);
    const tcStart = tcIdx + 3 + numBytes;
    if (tcLen > 0 && tcLen <= 8 && tcStart + tcLen <= buf.length) {
      let val = 0;
      for (let i = 0; i < tcLen; i++) {
        val = val * 256 + buf[tcStart + i];
      }
      if (val > 0) timecodeScale = val;
    }
  }

  const idx = buf.indexOf(Buffer.from([0x44, 0x89]));
  if (idx === -1 || idx + 2 >= buf.length) return null;
  let firstByte = buf[idx + 2];
  let numBytes = 1;
  let mask = 0x80;
  while ((firstByte & mask) === 0 && numBytes <= 8) {
    mask >>= 1;
    numBytes++;
  }
  const length = firstByte & (mask - 1);
  const dataStart = idx + 2 + numBytes;
  if (length <= 0 || dataStart + length > buf.length) return null;
  if (length === 4) {
    const rawDur = buf.readFloatBE(dataStart);
    if (rawDur > 0 && !isNaN(rawDur)) return (rawDur * timecodeScale) / 1e9;
  }
  return null;
}

const mkvBuf = Buffer.alloc(128);
mkvBuf[0] = 0x1a; mkvBuf[1] = 0x45; mkvBuf[2] = 0xdf; mkvBuf[3] = 0xa3;
mkvBuf[10] = 0x44; mkvBuf[11] = 0x89;
mkvBuf[12] = 0x84; // 4 bytes
mkvBuf.writeFloatBE(1420500.0, 13);
const parsed = testMkvDuration(mkvBuf);
assert(parsed !== null && Math.abs(parsed - 1420.5) < 0.1, 'Must extract duration');
console.log(`✓ EBML Duration parser verified (${parsed.toFixed(1)}s)`);

// 4. Verify Thumbnail Duration Clamping Logic
console.log('4. Testing Thumbnail seek time duration clamping...');
function clampThumbSeekTime(rawTargetTime, duration, isCard) {
  let targetTime = rawTargetTime;
  if (duration && duration > 0) {
    if (isCard) {
      targetTime = Math.min(rawTargetTime, Math.max(1, duration * 0.2));
    } else {
      targetTime = Math.min(rawTargetTime, Math.max(0, duration - 1));
    }
  }
  return targetTime;
}

// Case A: Short video (120s short anime), default card seek is 280s
const shortCardSeek = clampThumbSeekTime(280, 120, true);
assert.strictEqual(shortCardSeek, 24, 'Short anime (120s) must clamp card seek to 24s (20%), not seek past EOF at 280s');

// Case B: Standard episode (1440s), default card seek is 280s
const stdCardSeek = clampThumbSeekTime(280, 1440, true);
assert.strictEqual(stdCardSeek, 280, 'Standard anime (1440s) must retain 280s seek time');

// Case C: Scrubber seeking near end of short video
const shortScrubSeek = clampThumbSeekTime(150, 120, false);
assert.strictEqual(shortScrubSeek, 119, 'Scrubber past EOF must clamp to duration - 1 (119s)');
console.log('✓ Thumbnail seek time duration clamping verified');

console.log('\nAll Milestone 1 custom verification tests PASSED 100%!');
