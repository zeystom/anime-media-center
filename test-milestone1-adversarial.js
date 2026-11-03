import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import esbuild from 'esbuild';

console.log('================================================================');
console.log('   EMPIRICAL CHALLENGER: MILESTONE 1 ADVERSARIAL STRESS SUITE   ');
console.log('================================================================\n');

// ---------------------------------------------------------------------------
// 0. DYNAMIC BUNDLE LOADER: Load real implementation code from electron/
// ---------------------------------------------------------------------------
const bundleResult = await esbuild.build({
  stdin: {
    contents: `
      export { readMkvDuration, readMkvEmbeddedTitle } from './electron/ffmpeg.ts';
      export { renameSyncWithRetry, saveJsonSync } from './electron/storage.ts';
      export { findExternalSubtitles, findSubtitlesForEpisode } from './electron/subtitles.ts';
      export { checkEpisodeDownloading, checkTorrentProgress } from './electron/torrents.ts';
    `,
    resolveDir: process.cwd(),
    sourcefile: 'test-adversarial-entry.ts',
  },
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
  external: ['fs', 'path', 'child_process', 'crypto', 'http', 'url', 'os', 'events'],
  plugins: [
    {
      name: 'mock-electron',
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'mock-electron',
        }));
        build.onLoad({ filter: /.*/, namespace: 'mock-electron' }, () => ({
          contents: 'export const app = undefined; export default {};',
          loader: 'js',
        }));
      },
    },
  ],
});

const encodedUri = 'data:text/javascript;base64,' + Buffer.from(bundleResult.outputFiles[0].text).toString('base64');
const {
  readMkvDuration,
  readMkvEmbeddedTitle,
  renameSyncWithRetry,
  saveJsonSync,
  findExternalSubtitles,
  findSubtitlesForEpisode,
  checkEpisodeDownloading,
  checkTorrentProgress,
} = await import(encodedUri);

// Also extract exact getEffectiveAnimeFolderName from electron/main.ts
const mainTsContent = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf-8');
const folderFuncMatch = mainTsContent.match(/function getEffectiveAnimeFolderName\([\s\S]*?\n\}/);
if (!folderFuncMatch) {
  throw new Error('Could not find getEffectiveAnimeFolderName in electron/main.ts');
}
const jsFuncCode = esbuild.transformSync(folderFuncMatch[0], { loader: 'ts' }).code;
const getEffectiveAnimeFolderName = new Function('path', `
  return ${jsFuncCode}
`)(path);

// Setup temporary test scratchpad
const TEST_DIR = path.join(process.cwd(), '.adversarial_test_tmp');
fs.mkdirSync(TEST_DIR, { recursive: true });

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         Error: ${err.message}`);
    throw err;
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         Error: ${err.message}`);
    throw err;
  }
}

try {
  // =========================================================================
  // TEST SUITE 1: readMkvDuration Adversarial Stress Testing
  // =========================================================================
  console.log('--- TEST SUITE 1: readMkvDuration Adversarial Stress Testing ---');

  runTest('1.1 Empty file (0 bytes) returns null without exception', () => {
    const emptyFile = path.join(TEST_DIR, 'empty.mkv');
    fs.writeFileSync(emptyFile, Buffer.alloc(0));
    const result = readMkvDuration(emptyFile);
    assert.strictEqual(result, null, 'Must return null for 0-byte file');
  });

  runTest('1.2 Truncated files (1, 2, 3 bytes) return null cleanly', () => {
    for (let len = 1; len <= 3; len++) {
      const truncFile = path.join(TEST_DIR, `trunc_${len}.mkv`);
      fs.writeFileSync(truncFile, Buffer.from([0x1a, 0x45, 0xdf].slice(0, len)));
      const result = readMkvDuration(truncFile);
      assert.strictEqual(result, null, `Must return null for ${len}-byte file`);
    }
  });

  runTest('1.3 Non-existent file path returns null (ENOENT handled)', () => {
    const missingFile = path.join(TEST_DIR, 'non_existent_file.mkv');
    const result = readMkvDuration(missingFile);
    assert.strictEqual(result, null, 'Must return null on ENOENT');
  });

  runTest('1.4 Directory path passed as file returns null (EISDIR handled)', () => {
    const result = readMkvDuration(TEST_DIR);
    assert.strictEqual(result, null, 'Must return null on EISDIR');
  });

  runTest('1.5 MKV with 0x4489 at offset > 64KB boundary returns null without crashing', () => {
    const largeFile = path.join(TEST_DIR, 'over_64k.mkv');
    const buf = Buffer.alloc(70000, 0);
    // Write MKV EBML ID at start
    buf[0] = 0x1a; buf[1] = 0x45; buf[2] = 0xdf; buf[3] = 0xa3;
    // Write Duration element at offset 66000 (beyond 64KB read limit)
    buf[66000] = 0x44; buf[66001] = 0x89;
    buf[66002] = 0x84; // 4 bytes
    buf.writeFloatBE(1200.0, 66003);
    fs.writeFileSync(largeFile, buf);

    const result = readMkvDuration(largeFile);
    assert.strictEqual(result, null, 'Elements beyond 64KB window must return null');
  });

  runTest('1.6 MKV with 0x4489 right at the 64KB read buffer boundary', () => {
    const edgeFile = path.join(TEST_DIR, 'edge_64k.mkv');
    const buf = Buffer.alloc(65536, 0);
    // Put Duration ID at byte 65534 (only 2 bytes left, no length byte)
    buf[65534] = 0x44; buf[65535] = 0x89;
    fs.writeFileSync(edgeFile, buf);

    const result = readMkvDuration(edgeFile);
    assert.strictEqual(result, null, 'Duration ID right at buffer edge must return null without index error');
  });

  runTest('1.7 MKV with zero duration (0.0 float) returns null', () => {
    const zeroDurFile = path.join(TEST_DIR, 'zero_dur.mkv');
    const buf = Buffer.alloc(128, 0);
    buf[0] = 0x1a; buf[1] = 0x45; buf[2] = 0xdf; buf[3] = 0xa3;
    buf[10] = 0x44; buf[11] = 0x89;
    buf[12] = 0x84; // 4 bytes
    buf.writeFloatBE(0.0, 13);
    fs.writeFileSync(zeroDurFile, buf);

    const result = readMkvDuration(zeroDurFile);
    assert.strictEqual(result, null, 'Duration of 0.0 must return null');
  });

  runTest('1.8 MKV with negative duration (-100.0 float) returns null', () => {
    const negDurFile = path.join(TEST_DIR, 'neg_dur.mkv');
    const buf = Buffer.alloc(128, 0);
    buf[0] = 0x1a; buf[1] = 0x45; buf[2] = 0xdf; buf[3] = 0xa3;
    buf[10] = 0x44; buf[11] = 0x89;
    buf[12] = 0x84; // 4 bytes
    buf.writeFloatBE(-100.0, 13);
    fs.writeFileSync(negDurFile, buf);

    const result = readMkvDuration(negDurFile);
    assert.strictEqual(result, null, 'Negative duration must return null');
  });

  runTest('1.9 MKV with NaN duration returns null', () => {
    const nanDurFile = path.join(TEST_DIR, 'nan_dur.mkv');
    const buf = Buffer.alloc(128, 0);
    buf[0] = 0x1a; buf[1] = 0x45; buf[2] = 0xdf; buf[3] = 0xa3;
    buf[10] = 0x44; buf[11] = 0x89;
    buf[12] = 0x84; // 4 bytes
    buf.writeFloatBE(NaN, 13);
    fs.writeFileSync(nanDurFile, buf);

    const result = readMkvDuration(nanDurFile);
    assert.strictEqual(result, null, 'NaN duration must return null');
  });

  runTest('1.10 MKV with 8-byte Double precision duration parses correctly', () => {
    const doubleDurFile = path.join(TEST_DIR, 'double_dur.mkv');
    const buf = Buffer.alloc(128, 0);
    buf[0] = 0x1a; buf[1] = 0x45; buf[2] = 0xdf; buf[3] = 0xa3;
    buf[10] = 0x44; buf[11] = 0x89;
    buf[12] = 0x88; // 8 bytes (0x80 | 8)
    buf.writeDoubleBE(1420500.0, 13); // in ms (1,420,500 ms = 1420.5 s)
    fs.writeFileSync(doubleDurFile, buf);

    const result = readMkvDuration(doubleDurFile);
    assert(result !== null, 'Must extract double precision duration');
    assert(Math.abs(result - 1420.5) < 0.01, `Expected 1420.5s, got ${result}`);
  });

  runTest('1.11 MKV with custom TimecodeScale (500,000 ns) calculates duration correctly', () => {
    const tcScaleFile = path.join(TEST_DIR, 'tc_scale.mkv');
    const buf = Buffer.alloc(128, 0);
    buf[0] = 0x1a; buf[1] = 0x45; buf[2] = 0xdf; buf[3] = 0xa3;
    // TimecodeScale: 0x2AD7B1, length 3 bytes (0x80 | 3 = 0x83), value = 500,000 (0x07A120)
    buf[10] = 0x2a; buf[11] = 0xd7; buf[12] = 0xb1;
    buf[13] = 0x83; // 3 bytes
    buf[14] = 0x07; buf[15] = 0xa1; buf[16] = 0x20; // 500,000
    // Duration: 0x4489, 4 bytes, raw value = 2,000,000
    // Result should be: (2,000,000 * 500,000) / 1e9 = 1000.0 seconds
    buf[20] = 0x44; buf[21] = 0x89;
    buf[22] = 0x84; // 4 bytes
    buf.writeFloatBE(2000000.0, 23);
    fs.writeFileSync(tcScaleFile, buf);

    const result = readMkvDuration(tcScaleFile);
    assert(result !== null, 'Must calculate custom TimecodeScale');
    assert(Math.abs(result - 1000.0) < 0.01, `Expected 1000.0s, got ${result}`);
  });

  runTest('1.12 Stress: 5,000 rapid calls on varied malformed buffers (no FD leaks, no memory crash)', () => {
    const testFiles = [
      path.join(TEST_DIR, 'empty.mkv'),
      path.join(TEST_DIR, 'trunc_1.mkv'),
      path.join(TEST_DIR, 'zero_dur.mkv'),
      path.join(TEST_DIR, 'double_dur.mkv'),
    ];
    for (let i = 0; i < 5000; i++) {
      const file = testFiles[i % testFiles.length];
      const res = readMkvDuration(file);
      if (file.includes('double_dur')) {
        assert(res !== null);
      }
    }
  });

  // =========================================================================
  // TEST SUITE 2: renameSyncWithRetry & Atomic Persistence Stress Testing
  // =========================================================================
  console.log('\n--- TEST SUITE 2: renameSyncWithRetry & Atomic Persistence ---');

  runTest('2.1 Standard atomic rename succeeds and overwrites destination', () => {
    const src = path.join(TEST_DIR, 'atomic_src.json');
    const dest = path.join(TEST_DIR, 'atomic_dest.json');
    fs.writeFileSync(src, JSON.stringify({ version: 1 }));
    fs.writeFileSync(dest, JSON.stringify({ version: 0 }));

    renameSyncWithRetry(src, dest, 5);
    assert.strictEqual(fs.existsSync(src), false, 'Source must no longer exist');
    assert.strictEqual(fs.existsSync(dest), true, 'Destination must exist');
    const content = JSON.parse(fs.readFileSync(dest, 'utf-8'));
    assert.strictEqual(content.version, 1, 'Destination must have updated content');
  });

  runTest('2.2 Non-existent source throws ENOENT without retry delay', () => {
    const src = path.join(TEST_DIR, 'non_existent_src.tmp');
    const dest = path.join(TEST_DIR, 'atomic_dest.json');
    let threw = false;
    const start = Date.now();
    try {
      renameSyncWithRetry(src, dest, 5);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.code, 'ENOENT', 'Must throw ENOENT');
    }
    const elapsed = Date.now() - start;
    assert.strictEqual(threw, true, 'Must throw error');
    assert(elapsed < 200, `ENOENT must fail immediately without spin-delay (took ${elapsed}ms)`);
  });

  await runAsyncTest('2.3 Simulated Transient File Lock: Destination locked for 60ms by worker thread', async () => {
    const src = path.join(TEST_DIR, 'locked_src.json');
    const dest = path.join(TEST_DIR, 'locked_dest.json');
    fs.writeFileSync(src, JSON.stringify({ updated: true }));
    fs.writeFileSync(dest, JSON.stringify({ updated: false }));

    const workerScript = `
      import { parentPort, workerData } from 'worker_threads';
      import fs from 'fs';
      const fd = fs.openSync(workerData, 'r+');
      parentPort.postMessage('locked');
      setTimeout(() => {
        try { fs.closeSync(fd); } catch {}
        parentPort.postMessage('unlocked');
      }, 70);
    `;

    const { Worker } = await import('worker_threads');
    const worker = new Worker(workerScript, { eval: true, workerData: dest });

    await new Promise((resolve) => {
      worker.on('message', (msg) => {
        if (msg === 'locked') resolve();
      });
    });

    // Destination is now 100% confirmed locked. Call renameSyncWithRetry.
    // The retry loop will catch EPERM and retry while worker releases after 70ms.
    renameSyncWithRetry(src, dest, 10);

    const content = JSON.parse(fs.readFileSync(dest, 'utf-8'));
    assert.strictEqual(content.updated, true, 'Must successfully update after transient lock releases');
    await worker.terminate();
  });

  await runAsyncTest('2.4a Fallback Resilience: Dest held open causes renameSync EPERM, fallback copyFileSync saves data', async () => {
    const src = path.join(TEST_DIR, 'fallback_src.json');
    const dest = path.join(TEST_DIR, 'fallback_dest.json');
    fs.writeFileSync(src, JSON.stringify({ savedViaFallback: true }));
    fs.writeFileSync(dest, JSON.stringify({ savedViaFallback: false }));

    const workerScript = `
      import { parentPort, workerData } from 'worker_threads';
      import fs from 'fs';
      const fd = fs.openSync(workerData, 'r+');
      parentPort.postMessage('locked');
      setInterval(() => {}, 1000);
    `;

    const { Worker } = await import('worker_threads');
    const worker = new Worker(workerScript, { eval: true, workerData: dest });

    await new Promise((resolve) => {
      worker.on('message', (msg) => {
        if (msg === 'locked') resolve();
      });
    });

    try {
      // In this state, renameSync fails on Windows with EPERM, but copyFileSync fallback succeeds!
      renameSyncWithRetry(src, dest, 3);
      const content = JSON.parse(fs.readFileSync(dest, 'utf-8'));
      assert.strictEqual(content.savedViaFallback, true, 'copyFileSync fallback must save data even when renameSync gets EPERM');
    } finally {
      await worker.terminate();
    }
  });

  runTest('2.4b Permanent Lockout: Read-only dest causes both rename and copy fallback to fail cleanly with EPERM', () => {
    const src = path.join(TEST_DIR, 'ro_src.json');
    const dest = path.join(TEST_DIR, 'ro_dest.json');
    fs.writeFileSync(src, JSON.stringify({ ro: 1 }));
    fs.writeFileSync(dest, JSON.stringify({ ro: 0 }));
    fs.chmodSync(dest, 0o444); // Make read-only

    let threw = false;
    try {
      renameSyncWithRetry(src, dest, 2);
    } catch (err) {
      threw = true;
      assert(['EPERM', 'EBUSY', 'EACCES'].includes(err.code), `Expected file lock code, got ${err.code}`);
    } finally {
      try { fs.chmodSync(dest, 0o666); } catch {}
    }
    assert.strictEqual(threw, true, 'Read-only lockout must throw error cleanly');
  });

  runTest('2.5 saveJsonSync cleans up temp files even when JSON serialization fails', () => {
    const target = path.join(TEST_DIR, 'circular.json');
    const circularObj = {};
    circularObj.self = circularObj;

    const originalError = console.error;
    console.error = () => {}; // suppress expected log
    let threw = false;
    try {
      saveJsonSync(target, circularObj);
    } catch {
      threw = true;
    } finally {
      console.error = originalError;
    }
    assert.strictEqual(threw, true, 'Circular JSON must throw error');

    // Verify no stray .tmp files left in TEST_DIR
    const strayTmp = fs.readdirSync(TEST_DIR).filter((f) => f.includes('circular.json') && f.endsWith('.tmp'));
    assert.strictEqual(strayTmp.length, 0, 'No temporary files should linger after error');
  });

  // =========================================================================
  // TEST SUITE 3: getEffectiveAnimeFolderName Adversarial Challenge
  // =========================================================================
  console.log('\n--- TEST SUITE 3: getEffectiveAnimeFolderName Adversarial Inputs ---');

  const root = 'C:\\AnimeLibrary';

  runTest('3.1 Canonical generic season folders combine with parent', () => {
    const cases = [
      ['C:\\AnimeLibrary\\Frieren\\Season 1', 'Frieren Season 1'],
      ['C:\\AnimeLibrary\\Attack on Titan\\Season 02', 'Attack on Titan Season 02'],
      ['C:\\AnimeLibrary\\Bleach\\S01', 'Bleach S01'],
      ['C:\\AnimeLibrary\\Naruto\\Part 3', 'Naruto Part 3'],
      ['C:\\AnimeLibrary\\Spy x Family\\Cour 2', 'Spy x Family Cour 2'],
      ['C:\\AnimeLibrary\\Jujutsu Kaisen\\Movie', 'Jujutsu Kaisen Movie'],
      ['C:\\AnimeLibrary\\Demon Slayer\\Movies', 'Demon Slayer Movies'],
      ['C:\\AnimeLibrary\\One Piece\\Specials', 'One Piece Specials'],
      ['C:\\AnimeLibrary\\Gintama\\OVA', 'Gintama OVA'],
      ['C:\\AnimeLibrary\\Hunter x Hunter\\Bonus', 'Hunter x Hunter Bonus'],
    ];

    for (const [folder, expected] of cases) {
      const actual = getEffectiveAnimeFolderName(folder, root);
      assert.strictEqual(actual, expected, `For ${folder}: expected "${expected}", got "${actual}"`);
    }
  });

  runTest('3.2 Folders placed directly under root are NOT prefixed with root folder name', () => {
    const res = getEffectiveAnimeFolderName('C:\\AnimeLibrary\\Season 1', root);
    assert.strictEqual(res, 'Season 1', 'Direct child of root must not prefix root name "AnimeLibrary"');
  });

  runTest('3.3 Standalone anime shows retain their own names untouched', () => {
    const res1 = getEffectiveAnimeFolderName('C:\\AnimeLibrary\\Cowboy Bebop', root);
    assert.strictEqual(res1, 'Cowboy Bebop');
    const res2 = getEffectiveAnimeFolderName('C:\\AnimeLibrary\\Studio Ghibli\\Spirited Away', root);
    assert.strictEqual(res2, 'Spirited Away');
  });

  runTest('3.4 Edge-case / Non-matching folder names inspection ("Extra Special", "Extras")', () => {
    // "Extra Special" has two tokens; regex tests strictly ^...$ so it does not match
    const extraSpecial = getEffectiveAnimeFolderName('C:\\AnimeLibrary\\Naruto\\Extra Special', root);
    // Documenting empirical behavior:
    console.log(`       -> Note: "Naruto/Extra Special" resolves to: "${extraSpecial}"`);

    // "Extras" has trailing 's' while regex specifies "extra":
    const extras = getEffectiveAnimeFolderName('C:\\AnimeLibrary\\Naruto\\Extras', root);
    console.log(`       -> Note: "Naruto/Extras" resolves to: "${extras}"`);

    // Neither causes crash or undefined
    assert(typeof extraSpecial === 'string' && extraSpecial.length > 0);
    assert(typeof extras === 'string' && extras.length > 0);
  });

  // =========================================================================
  // TEST SUITE 4: Thumbnail Seek Clamping Logic Stress Testing
  // =========================================================================
  console.log('\n--- TEST SUITE 4: Thumbnail Seek Clamping Stress Testing ---');

  // Exact reproduction of clamping logic from electron/server.ts:460-472
  function clampThumbSeek(rawTargetTime, duration, isCard) {
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

  runTest('4.1 5-second video card thumbnail seek clamping', () => {
    // Default card seek is 280s. For 5s video: 5 * 0.2 = 1.0s.
    const seek = clampThumbSeek(280, 5, true);
    assert.strictEqual(seek, 1, 'Card thumbnail for 5s video must clamp to 1s');
  });

  runTest('4.2 5-second video scrubber seek past EOF', () => {
    // User requests scrubber thumbnail at 10s on a 5s video: duration - 1 = 4s
    const seek = clampThumbSeek(10, 5, false);
    assert.strictEqual(seek, 4, 'Scrubber thumbnail requesting 10s on 5s video must clamp to duration-1 (4s)');
  });

  runTest('4.3 0-second video clamping behavior (empty / zero duration video)', () => {
    const cardSeek = clampThumbSeek(280, 0, true);
    // When duration is 0, duration > 0 is false, so rawTargetTime is returned
    assert.strictEqual(cardSeek, 280, '0s duration leaves raw target time untouched');
    const scrubSeek = clampThumbSeek(15, 0, false);
    assert.strictEqual(scrubSeek, 15, '0s duration leaves scrubber raw target time untouched');
  });

  runTest('4.4 1-second video clamping behavior', () => {
    const cardSeek = clampThumbSeek(280, 1, true);
    // 1 * 0.2 = 0.2 -> Math.max(1, 0.2) = 1
    assert.strictEqual(cardSeek, 1, 'Card seek on 1s video clamps to 1s');
    const scrubSeek = clampThumbSeek(5, 1, false);
    // Math.max(0, 1 - 1) = 0
    assert.strictEqual(scrubSeek, 0, 'Scrubber seek on 1s video clamps to 0s');
  });

  runTest('4.5 Long episode (1440s / 24 min) card seek retains 280s', () => {
    const seek = clampThumbSeek(280, 1440, true);
    // 1440 * 0.2 = 288s; Math.min(280, 288) = 280s
    assert.strictEqual(seek, 280, 'Standard 24-min episode card seek must be 280s');
  });

  // =========================================================================
  // TEST SUITE 5: Subtitles & Torrents Edge Cases
  // =========================================================================
  console.log('\n--- TEST SUITE 5: Subtitles & Torrents Edge Cases ---');

  runTest('5.1 findSubtitlesForEpisode handles complex filenames with multiple dots', () => {
    const videoFile = path.join(TEST_DIR, '[SubGroup].Show.Title.S01E01.1080p.mkv');
    fs.writeFileSync(videoFile, 'dummy video');
    fs.writeFileSync(path.join(TEST_DIR, '[SubGroup].Show.Title.S01E01.1080p.ja.ass'), 'ass');
    fs.writeFileSync(path.join(TEST_DIR, '[SubGroup].Show.Title.S01E01.1080p.whisper.srt'), 'whisper');
    fs.writeFileSync(path.join(TEST_DIR, '[SubGroup].Show.Title.S01E01.1080p.srt'), 'srt');
    // Different episode that must NOT match
    fs.writeFileSync(path.join(TEST_DIR, '[SubGroup].Show.Title.S01E02.1080p.ass'), 'other ep');

    const subs = findSubtitlesForEpisode(videoFile);
    assert.strictEqual(subs.length, 3, `Expected 3 matches, got ${subs.length}`);
    assert(subs[0].isWhisper, 'Whisper subtitle must come first');
  });

  runTest('5.2 checkEpisodeDownloading with undefined blocks and active .!qb companion', () => {
    const videoFile = 'C:\\Torrents\\Attack.on.Titan.S04E01.mkv';
    const allFilesLower = new Set([
      'attack.on.titan.s04e01.mkv',
      'attack.on.titan.s04e01.mkv.!qb',
    ]);
    const mockStat = {
      size: 1024 * 1024 * 500, // 500MB
      blocks: undefined,        // Windows NTFS
      mtimeMs: Date.now() - 5000,
    };

    const status = checkEpisodeDownloading(videoFile, allFilesLower, mockStat);
    assert.strictEqual(status.isDownloading, true, 'Active .!qb companion must flag downloading');
  });

  console.log('\n================================================================');
  console.log(`ALL ADVERSARIAL CHALLENGES COMPLETED: ${passedTests} / ${totalTests} PASSED (100%)`);
  console.log('================================================================\n');

} finally {
  // Clean up scratchpad
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
