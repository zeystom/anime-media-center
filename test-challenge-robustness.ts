import assert from 'assert';
import fs from 'fs';
import path from 'path';
import http from 'http';
import net from 'net';
import crypto from 'crypto';
import { LocalStreamServer } from './electron/server.ts';
import { storage } from './electron/storage.ts';
import { getKitsuMetadata } from './electron/kitsu.ts';
import { checkEpisodeDownloading, checkTorrentProgress } from './electron/torrents.ts';

// Trap any uncaught exceptions or unhandled rejections during async torture
const uncaughtErrors: any[] = [];
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]:', err);
  uncaughtErrors.push(err);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]:', err);
  uncaughtErrors.push(err);
});

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runChallenges() {
  console.log('================================================================');
  console.log('Starting Empirical Challenger Test Suite (Milestone 1 Core)');
  console.log('================================================================\n');

  // ============================================================================
  // CHALLENGE 1: HTTP Server Resilience (Abrupt socket aborts during thumb streaming)
  // ============================================================================
  console.log('--- CHALLENGE 1: HTTP Server Resilience & Abrupt Socket Aborts ---');

  const testDir = path.join(process.cwd(), '.test_server_resilience_tmp');
  fs.mkdirSync(testDir, { recursive: true });

  const dummyVideo = path.join(testDir, 'test-episode-01.mkv');
  fs.writeFileSync(dummyVideo, Buffer.alloc(1024 * 1024, 0x55)); // 1MB dummy file

  const sidecarThumb = path.join(testDir, 'test-episode-01.jpg');
  // Write a 64KB dummy JPEG header/data
  const dummyJpgData = Buffer.alloc(64 * 1024, 0xaa);
  dummyJpgData[0] = 0xff; dummyJpgData[1] = 0xd8; dummyJpgData[dummyJpgData.length - 2] = 0xff; dummyJpgData[dummyJpgData.length - 1] = 0xd9;
  fs.writeFileSync(sidecarThumb, dummyJpgData);

  // Configure storage to allow testDir in libraryFolders
  const currentSettings = storage.getSettings();
  storage.updateSettings({
    libraryFolders: Array.from(new Set([...(currentSettings.libraryFolders || []), testDir])),
  });

  const server = new LocalStreamServer();
  const port = await server.start();
  assert(port > 0, `Server must start on valid port (got ${port})`);
  console.log(`✓ LocalStreamServer started on 127.0.0.1:${port}`);

  // Test 1A: Rapid socket abort immediately after sending HTTP request (50 concurrent)
  console.log('1A. Simulating 50 rapid socket aborts before headers...');
  const abortPromises: Promise<void>[] = [];
  for (let i = 0; i < 50; i++) {
    abortPromises.push(
      new Promise<void>((resolve) => {
        const client = net.connect(port, '127.0.0.1', () => {
          client.write(`GET /thumb?file=${encodeURIComponent(dummyVideo)}&type=card HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
          // Abruptly destroy socket immediately
          client.destroy();
          resolve();
        });
        client.on('error', () => resolve());
      })
    );
  }
  await Promise.all(abortPromises);
  await sleep(100);
  console.log('✓ 50 rapid socket aborts handled without server crash');

  // Test 1B: Staggered socket aborts mid-stream (50 concurrent with random delays 0-30ms)
  console.log('1B. Simulating 50 staggered socket aborts mid-stream...');
  const staggeredPromises: Promise<void>[] = [];
  for (let i = 0; i < 50; i++) {
    staggeredPromises.push(
      new Promise<void>((resolve) => {
        const delay = Math.floor(Math.random() * 30);
        const client = net.connect(port, '127.0.0.1', () => {
          client.write(`GET /thumb?file=${encodeURIComponent(dummyVideo)}&type=card HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
          setTimeout(() => {
            client.destroy();
            resolve();
          }, delay);
        });
        client.on('error', () => resolve());
      })
    );
  }
  await Promise.all(staggeredPromises);
  await sleep(100);
  console.log('✓ 50 staggered mid-stream aborts handled cleanly');

  // Test 1C: Server liveness verification after barrage
  console.log('1C. Verifying server remains fully operational after aborts...');
  const normalRes = await new Promise<{ statusCode: number; dataLength: number }>((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/thumb?file=${encodeURIComponent(dummyVideo)}&type=card`, (res) => {
      let len = 0;
      res.on('data', (chunk) => { len += chunk.length; });
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, dataLength: len }));
      res.on('error', reject);
    }).on('error', reject);
  });
  assert.strictEqual(normalRes.statusCode, 200, `Expected 200 OK after barrage, got ${normalRes.statusCode}`);
  assert.strictEqual(normalRes.dataLength, dummyJpgData.length, 'Must return full thumbnail data');
  console.log('✓ Server responded 200 OK with correct thumbnail content');

  // Test 1D: Path security rejection
  console.log('1D. Verifying security rejection on forbidden file paths...');
  const forbiddenRes = await new Promise<number>((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/thumb?file=C:\\Windows\\System32\\calc.exe&type=card`, (res) => {
      resolve(res.statusCode || 0);
    }).on('error', reject);
  });
  assert.strictEqual(forbiddenRes, 403, 'Must return 403 Forbidden for unauthorized paths');
  console.log('✓ Security checks return 403 Forbidden as expected');

  // Test 1E: Stream endpoint aborts
  console.log('1E. Verifying /stream endpoint handles abrupt client disconnects...');
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => {
      const client = net.connect(port, '127.0.0.1', () => {
        client.write(`GET /stream?file=${encodeURIComponent(dummyVideo)} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        setTimeout(() => {
          client.destroy();
          resolve();
        }, 10);
      });
      client.on('error', () => resolve());
    });
  }
  await sleep(150);
  console.log('✓ /stream endpoint handles abrupt client disconnects cleanly');

  server.stopActiveStreams();
  await sleep(200);

  // Clean up server temporary directory
  fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });


  // ============================================================================
  // CHALLENGE 2: Kitsu Pagination Logic
  // ============================================================================
  console.log('--- CHALLENGE 2: Kitsu Pagination Logic Stress Testing ---');

  const origFetch = global.fetch;

  function createMockEpisodeData(startNum: number, count: number) {
    return Array.from({ length: count }, (_, idx) => {
      const epNum = startNum + idx;
      return {
        id: `ep-${epNum}`,
        type: 'episodes',
        attributes: {
          number: epNum,
          canonicalTitle: `Episode ${epNum} Title`,
          synopsis: `Synopsis for episode ${epNum}`,
          thumbnail: {
            original: `https://media.kitsu.io/episodes/${epNum}.jpg`,
          },
        },
      };
    });
  }

  // Test 2A: Exactly 50 items, links.next absent -> terminates after 1 page (50 episodes)
  console.log('2A. Testing 50 items with links.next absent...');
  const showName2A = `Challenge Show 2A ${Date.now()}`;
  let fetchCount2A = 0;
  global.fetch = (async (input: any) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    if (urlStr.includes('graphql.anilist.co')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (urlStr.includes('filter[text]=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'anime-2a', attributes: { canonicalTitle: showName2A } }],
        }),
      };
    }
    if (urlStr.includes('/episodes?')) {
      fetchCount2A++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: createMockEpisodeData(1, 50),
          links: {}, // No next link
        }),
      };
    }
    return { ok: false, status: 404 };
  }) as any;

  const result2A = await getKitsuMetadata(showName2A);
  assert(result2A, 'Result 2A must exist');
  assert.strictEqual(fetchCount2A, 1, `Expected 1 episode fetch call, got ${fetchCount2A}`);
  assert.strictEqual(Object.keys(result2A.episodes).length, 50, 'Must have exactly 50 episodes');
  console.log('✓ 50 items with absent next link terminated after 1 page');

  // Test 2B: 100 items across 2 pages (page 1: 50 + next, page 2: 50 + no next)
  console.log('2B. Testing 100 items across 2 pages...');
  const showName2B = `Challenge Show 2B ${Date.now()}`;
  let fetchCount2B = 0;
  global.fetch = (async (input: any) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    if (urlStr.includes('graphql.anilist.co')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (urlStr.includes('filter[text]=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'anime-2b', attributes: { canonicalTitle: showName2B } }],
        }),
      };
    }
    if (urlStr.includes('/episodes?')) {
      fetchCount2B++;
      const isPage1 = urlStr.includes('page[offset]=0');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: isPage1 ? createMockEpisodeData(1, 50) : createMockEpisodeData(51, 50),
          links: isPage1 ? { next: 'https://kitsu.io/api/edge/anime/anime-2b/episodes?page[offset]=50' } : {},
        }),
      };
    }
    return { ok: false, status: 404 };
  }) as any;

  const result2B = await getKitsuMetadata(showName2B);
  assert(result2B, 'Result 2B must exist');
  assert.strictEqual(fetchCount2B, 2, `Expected 2 episode fetch calls, got ${fetchCount2B}`);
  assert.strictEqual(Object.keys(result2B.episodes).length, 100, 'Must have exactly 100 episodes');
  assert(result2B.episodes[1] && result2B.episodes[100], 'Must contain episode 1 and episode 100');
  console.log('✓ 100 items across 2 pages terminated cleanly after 2 pages');

  // Test 2C: 150 items across 3 pages (page 1: 50 + next, page 2: 50 + next, page 3: 50 + no next)
  console.log('2C. Testing 150 items across 3 pages...');
  const showName2C = `Challenge Show 2C ${Date.now()}`;
  let fetchCount2C = 0;
  global.fetch = (async (input: any) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    if (urlStr.includes('graphql.anilist.co')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (urlStr.includes('filter[text]=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'anime-2c', attributes: { canonicalTitle: showName2C } }],
        }),
      };
    }
    if (urlStr.includes('/episodes?')) {
      fetchCount2C++;
      let startEp = 1;
      let hasNext = true;
      if (urlStr.includes('page[offset]=0')) {
        startEp = 1;
      } else if (urlStr.includes('page[offset]=50')) {
        startEp = 51;
      } else if (urlStr.includes('page[offset]=100')) {
        startEp = 101;
        hasNext = false;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: createMockEpisodeData(startEp, 50),
          links: hasNext ? { next: `https://kitsu.io/api/edge/anime/anime-2c/episodes?page[offset]=${startEp + 49}` } : {},
        }),
      };
    }
    return { ok: false, status: 404 };
  }) as any;

  const result2C = await getKitsuMetadata(showName2C);
  assert(result2C, 'Result 2C must exist');
  assert.strictEqual(fetchCount2C, 3, `Expected 3 episode fetch calls, got ${fetchCount2C}`);
  assert.strictEqual(Object.keys(result2C.episodes).length, 150, 'Must have exactly 150 episodes');
  assert(result2C.episodes[1] && result2C.episodes[150], 'Must contain episode 1 and episode 150');
  console.log('✓ 150 items across 3 pages terminated cleanly after 3 pages');

  // Test 2D: Termination condition when data.length < limit (e.g. 50 + next, then 30 with next still present)
  console.log('2D. Testing termination when data.length < limit (even if next link is present)...');
  const showName2D = `Challenge Show 2D ${Date.now()}`;
  let fetchCount2D = 0;
  global.fetch = (async (input: any) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    if (urlStr.includes('graphql.anilist.co')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (urlStr.includes('filter[text]=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'anime-2d', attributes: { canonicalTitle: showName2D } }],
        }),
      };
    }
    if (urlStr.includes('/episodes?')) {
      fetchCount2D++;
      const isPage1 = urlStr.includes('page[offset]=0');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: isPage1 ? createMockEpisodeData(1, 50) : createMockEpisodeData(51, 30),
          // Notice links.next is maliciously present on page 2 even though count < 50
          links: { next: 'https://kitsu.io/api/edge/anime/anime-2d/episodes?page[offset]=80' },
        }),
      };
    }
    return { ok: false, status: 404 };
  }) as any;

  const result2D = await getKitsuMetadata(showName2D);
  assert(result2D, 'Result 2D must exist');
  assert.strictEqual(fetchCount2D, 2, `Expected termination after 2 pages, got ${fetchCount2D}`);
  assert.strictEqual(Object.keys(result2D.episodes).length, 80, 'Must have exactly 80 episodes');
  console.log('✓ Loop terminated immediately when data.length < limit (80 episodes)');

  // Test 2E: Safeguard cap at 1500 episodes
  console.log('2E. Testing 1500-episode safeguard limit...');
  const showName2E = `Challenge Show 2E ${Date.now()}`;
  let fetchCount2E = 0;
  global.fetch = (async (input: any) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    if (urlStr.includes('graphql.anilist.co')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (urlStr.includes('filter[text]=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'anime-2e', attributes: { canonicalTitle: showName2E } }],
        }),
      };
    }
    if (urlStr.includes('/episodes?')) {
      fetchCount2E++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: createMockEpisodeData(fetchCount2E * 50 - 49, 50),
          links: { next: 'https://kitsu.io/api/edge/anime/anime-2e/episodes?page[offset]=infinite' },
        }),
      };
    }
    return { ok: false, status: 404 };
  }) as any;

  const result2E = await getKitsuMetadata(showName2E);
  assert(result2E, 'Result 2E must exist');
  // 1500 / 50 = 30 pages
  assert.strictEqual(fetchCount2E, 30, `Expected exactly 30 pages for 1500 cap, got ${fetchCount2E}`);
  assert.strictEqual(Object.keys(result2E.episodes).length, 1500, 'Must cap at 1500 episodes');
  console.log('✓ 1500-episode safeguard cap halted loop as intended');

  // Restore fetch
  global.fetch = origFetch;
  console.log('✓ Kitsu pagination stress tests PASSED 100%!\n');


  // ============================================================================
  // CHALLENGE 3: Torrent Progress Detection with stat.blocks === undefined
  // ============================================================================
  console.log('--- CHALLENGE 3: Torrent Progress Detection (stat.blocks === undefined) ---');

  const torrentDir = path.join(process.cwd(), '.test_torrent_resilience_tmp');
  fs.mkdirSync(torrentDir, { recursive: true });

  // Test 3A: Companion .!qb file with partial logical size
  console.log('3A. Companion file (.!qb) with partial size (45MB out of 100MB)...');
  const ep3APath = path.join(torrentDir, 'Episode3A.mkv');
  const comp3APath = path.join(torrentDir, 'Episode3A.mkv.!qb');
  fs.writeFileSync(comp3APath, Buffer.alloc(450000, 0x11)); // scaled test size

  const filesInDir3A = new Set(['Episode3A.mkv.!qb'.toLowerCase()]);
  const stat3A = { size: 1000000, blocks: undefined, mtimeMs: Date.now() };
  const res3A = checkEpisodeDownloading(ep3APath, filesInDir3A, stat3A);
  assert.strictEqual(res3A.isDownloading, true, 'Must detect as downloading');
  assert(typeof res3A.downloadProgress === 'number', 'downloadProgress must be a number');
  assert.strictEqual(res3A.downloadProgress, 45, `Expected 45% progress, got ${res3A.downloadProgress}`);
  console.log(`✓ 3A verified: isDownloading=${res3A.isDownloading}, downloadProgress=${res3A.downloadProgress}%`);

  // Test 3B: Companion .!qb file pre-allocated with sparse zero checkpoints
  console.log('3B. Companion file pre-allocated with sparse zero checkpoints (4/10 non-zero)...');
  const ep3BPath = path.join(torrentDir, 'Episode3B.mkv');
  const comp3BPath = path.join(torrentDir, 'Episode3B.mkv.!qb');
  const size3B = 10 * 1024 * 1024; // 10MB
  const fd3B = fs.openSync(comp3BPath, 'w');
  // Allocate 10MB of zeroes
  const zeroChunk = Buffer.alloc(64 * 1024, 0);
  for (let b = 0; b < size3B; b += zeroChunk.length) {
    fs.writeSync(fd3B, zeroChunk);
  }
  // Fill checkpoints 0.05, 0.15, 0.25, 0.35 with non-zero bytes (4 of 10 checkpoints)
  const nonZeroBuf = Buffer.alloc(16384, 0x77);
  for (const frac of [0.05, 0.15, 0.25, 0.35]) {
    fs.writeSync(fd3B, nonZeroBuf, 0, nonZeroBuf.length, Math.floor(size3B * frac));
  }
  fs.closeSync(fd3B);

  const filesInDir3B = new Set(['Episode3B.mkv.!qb'.toLowerCase()]);
  const stat3B = { size: size3B, blocks: undefined, mtimeMs: Date.now() };
  const res3B = checkEpisodeDownloading(ep3BPath, filesInDir3B, stat3B);
  assert.strictEqual(res3B.isDownloading, true, 'Must detect as downloading');
  assert.strictEqual(res3B.downloadProgress, 40, `Expected 40% (4/10 non-zero), got ${res3B.downloadProgress}`);
  console.log(`✓ 3B verified: isDownloading=${res3B.isDownloading}, downloadProgress=${res3B.downloadProgress}%`);

  // Test 3C: Direct video file > 5MB, valid header, but tail 16KB is pure zero
  console.log('3C. Direct video file > 5MB with EBML header but zero tail...');
  const ep3CPath = path.join(torrentDir, 'Episode3C.mkv');
  const size3C = 8 * 1024 * 1024; // 8MB
  const fd3C = fs.openSync(ep3CPath, 'w');
  // Fill with non-zero pattern
  const dataPattern = Buffer.alloc(64 * 1024, 0x33);
  for (let b = 0; b < size3C; b += dataPattern.length) {
    fs.writeSync(fd3C, dataPattern);
  }
  // Set EBML header at byte 0
  const ebmlHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  fs.writeSync(fd3C, ebmlHeader, 0, 4, 0);
  // Set tail 16KB to all zeroes
  const zeroTail = Buffer.alloc(16384, 0);
  fs.writeSync(fd3C, zeroTail, 0, zeroTail.length, size3C - zeroTail.length);
  fs.closeSync(fd3C);

  const stat3C = { size: size3C, blocks: undefined, mtimeMs: Date.now() };
  const res3C = checkEpisodeDownloading(ep3CPath, new Set(['Episode3C.mkv']), stat3C);
  assert.strictEqual(res3C.isDownloading, true, 'Must detect incomplete download due to zero tail');
  assert(typeof res3C.downloadProgress === 'number', 'Must compute progress despite stat.blocks === undefined');
  assert(res3C.downloadProgress > 0 && res3C.downloadProgress <= 99, `Progress must be in 1-99 range, got ${res3C.downloadProgress}`);
  console.log(`✓ 3C verified: isDownloading=${res3C.isDownloading}, downloadProgress=${res3C.downloadProgress}%`);

  // Test 3D: Direct video file > 5MB, valid header, valid tail, but some internal checkpoints are zero
  console.log('3D. Direct video file with valid tail but 3 internal zero checkpoints...');
  const ep3DPath = path.join(torrentDir, 'Episode3D.mkv');
  const size3D = 8 * 1024 * 1024; // 8MB
  const fd3D = fs.openSync(ep3DPath, 'w');
  for (let b = 0; b < size3D; b += dataPattern.length) {
    fs.writeSync(fd3D, dataPattern);
  }
  fs.writeSync(fd3D, ebmlHeader, 0, 4, 0);
  // Zero out checkpoints at 0.30, 0.50, 0.70 (3 out of 11 checkpoints)
  const zeroBlock = Buffer.alloc(16384, 0);
  for (const frac of [0.30, 0.50, 0.70]) {
    fs.writeSync(fd3D, zeroBlock, 0, zeroBlock.length, Math.floor(size3D * frac));
  }
  fs.closeSync(fd3D);

  const stat3D = { size: size3D, blocks: undefined, mtimeMs: Date.now() };
  const res3D = checkEpisodeDownloading(ep3DPath, new Set(['Episode3D.mkv']), stat3D);
  assert.strictEqual(res3D.isDownloading, true, 'Must detect incomplete download due to internal zero checkpoints');
  assert(typeof res3D.downloadProgress === 'number', 'Must compute progress');
  assert(res3D.downloadProgress > 0 && res3D.downloadProgress <= 99, `Progress must be in 1-99 range, got ${res3D.downloadProgress}`);
  console.log(`✓ 3D verified: isDownloading=${res3D.isDownloading}, downloadProgress=${res3D.downloadProgress}%`);

  // Test 3E: Completed video file (valid header, valid non-zero tail, all non-zero checkpoints)
  console.log('3E. Completed video file (all checkpoints and tail populated)...');
  const ep3EPath = path.join(torrentDir, 'Episode3E.mkv');
  const size3E = 8 * 1024 * 1024; // 8MB
  const fd3E = fs.openSync(ep3EPath, 'w');
  for (let b = 0; b < size3E; b += dataPattern.length) {
    fs.writeSync(fd3E, dataPattern);
  }
  fs.writeSync(fd3E, ebmlHeader, 0, 4, 0);
  fs.closeSync(fd3E);

  const stat3E = { size: size3E, blocks: undefined, mtimeMs: Date.now() };
  const res3E = checkEpisodeDownloading(ep3EPath, new Set(['Episode3E.mkv']), stat3E);
  assert.strictEqual(res3E.isDownloading, false, 'Completed episode must NOT be marked as downloading');
  assert.strictEqual(res3E.downloadProgress, undefined, 'Completed episode downloadProgress should be undefined');
  console.log(`✓ 3E verified: isDownloading=${res3E.isDownloading}, downloadProgress=${res3E.downloadProgress}`);

  // Test 3F: 0-byte or stub file (< 512KB)
  console.log('3F. Stub file < 512KB...');
  const stat3F = { size: 128 * 1024, blocks: undefined, mtimeMs: Date.now() };
  const res3F = checkEpisodeDownloading('C:/dummy/stub.mkv', new Set(['stub.mkv']), stat3F);
  assert.strictEqual(res3F.isDownloading, true, 'Stub file must be flagged as downloading');
  assert.strictEqual(res3F.downloadProgress, 0, 'Stub file must have progress 0');
  console.log(`✓ 3F verified: isDownloading=${res3F.isDownloading}, downloadProgress=${res3F.downloadProgress}%`);

  // Clean up torrent temporary directory
  fs.rmSync(torrentDir, { recursive: true, force: true });
  console.log('✓ Torrent progress detection with stat.blocks === undefined PASSED 100%!\n');

  // Final sanity check
  assert.strictEqual(uncaughtErrors.length, 0, 'No uncaught exceptions occurred across entire challenge');
  console.log('================================================================');
  console.log('ALL EMPIRICAL CHALLENGES PASSED WITH ZERO CRASHES OR VIOLATIONS!');
  console.log('================================================================');
  process.exit(0);
}

runChallenges().catch((err) => {
  console.error('CHALLENGE FAILED WITH ERROR:', err);
  process.exit(1);
});
