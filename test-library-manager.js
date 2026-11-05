import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeDiskUsage, computeStorageOverview, deleteAnime, deleteEpisodes } from './electron/libraryManager.ts';

console.log('Testing libraryManager disk usage + explicit deletion (offline sandbox)...');

// Fixed byte sizes so every usage assertion is exact.
const SIZES = {
  showEp1: 1234,
  showEp2: 5678,
  showSrt: 50,
  showNotes: 100,
  showOva: 999,
  genericEp: 4321,
  movieEp: 5000,
  onlySubs: 77,
  ignoredNm: 111,
  ignoredGit: 222,
  deep4: 333,
  deep5: 444,
  outsideEp: 400
};

const results = { pass: 0, fail: 0 };

async function check(name, fn) {
  try {
    await fn();
    results.pass++;
    console.log(`✓ PASS: ${name}`);
  } catch (err) {
    results.fail++;
    console.log(`✗ FAIL: ${name} — ${err?.message || err}`);
  }
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFileBytes(filePath, size) {
  fs.writeFileSync(filePath, Buffer.alloc(size, 0x61));
}

function totalsOf(overview) {
  return overview.titles.map((t) => `${t.folderName}=${t.totalBytes}`);
}

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'amc-libmgr-')));
const root = path.join(sandbox, 'Library');
const outside = path.join(sandbox, 'Outside');

try {
  // --- Build the fake library -------------------------------------------
  // Show A: top-level episodes + subtitle + extras subfolder + nested Season 1 release folder.
  mkdirp(path.join(root, 'Show A', 'extras'));
  mkdirp(path.join(root, 'Show A', 'Season 1'));
  writeFileBytes(path.join(root, 'Show A', 'Episode 01.mkv'), SIZES.showEp1);
  writeFileBytes(path.join(root, 'Show A', 'Episode 02.mkv'), SIZES.showEp2);
  writeFileBytes(path.join(root, 'Show A', 'Episode 01.srt'), SIZES.showSrt);
  writeFileBytes(path.join(root, 'Show A', 'extras', 'notes.txt'), SIZES.showNotes);
  writeFileBytes(path.join(root, 'Show A', 'Season 1', 'OVA 01.mkv'), SIZES.showOva);

  // Generic-name release folder two levels deep.
  mkdirp(path.join(root, 'Generic Show', 'Season 1'));
  writeFileBytes(path.join(root, 'Generic Show', 'Season 1', 'ep.mkv'), SIZES.genericEp);

  // Direct-child generic folder ('Movie' is a direct child of root -> keeps its base name).
  mkdirp(path.join(root, 'Movie'));
  writeFileBytes(path.join(root, 'Movie', 'movie.mkv'), SIZES.movieEp);

  // Folder without videos must not be a release folder.
  mkdirp(path.join(root, 'Only Subs'));
  writeFileBytes(path.join(root, 'Only Subs', 'notes.srt'), SIZES.onlySubs);

  // Ignored directories must be skipped entirely.
  mkdirp(path.join(root, 'node_modules'));
  writeFileBytes(path.join(root, 'node_modules', 'pkg.mkv'), SIZES.ignoredNm);
  mkdirp(path.join(root, '.git'));
  writeFileBytes(path.join(root, '.git', 'x.mkv'), SIZES.ignoredGit);

  // Depth limit: depth 4 included, depth 5 excluded.
  mkdirp(path.join(root, 'L1', 'L2', 'L3', 'L4', 'L5'));
  writeFileBytes(path.join(root, 'L1', 'L2', 'L3', 'L4', 'deep4.mkv'), SIZES.deep4);
  writeFileBytes(path.join(root, 'L1', 'L2', 'L3', 'L4', 'L5', 'deep5.mkv'), SIZES.deep5);

  // A folder OUTSIDE the allowed root for guard tests (reached via ../ traversal).
  mkdirp(path.join(outside, 'Secret'));
  writeFileBytes(path.join(outside, 'Secret', 'ep.mkv'), SIZES.outsideEp);

  // Expected math:
  // 'L4' is the deepest release folder; its disk usage is recursive, so the
  // too-deep L5/deep5.mkv bytes still count toward the L4 title (777 total),
  // but L5 never becomes a release folder/title of its own.
  const showATotal = SIZES.showEp1 + SIZES.showEp2 + SIZES.showSrt + SIZES.showNotes + SIZES.showOva; // 8061
  const l4Total = SIZES.deep4 + SIZES.deep5; // 777
  const grandTotal = showATotal + SIZES.showOva + SIZES.genericEp + SIZES.movieEp + l4Total; // 19158

  // --- computeDiskUsage --------------------------------------------------
  await check('computeDiskUsage sums all files recursively and counts video episodes', async () => {
    const usage = await computeDiskUsage(path.join(root, 'Show A'));
    assert.deepStrictEqual(usage, { totalBytes: showATotal, episodeCount: 3 });
  });

  await check('computeDiskUsage respects custom extensions option', async () => {
    const mkvOnly = await computeDiskUsage(path.join(root, 'Show A'), { extensions: ['.mkv'] });
    assert.strictEqual(mkvOnly.totalBytes, showATotal);
    assert.strictEqual(mkvOnly.episodeCount, 3);
    const mp4Only = await computeDiskUsage(path.join(root, 'Show A'), { extensions: ['.mp4'] });
    assert.strictEqual(mp4Only.totalBytes, showATotal);
    assert.strictEqual(mp4Only.episodeCount, 0);
  });

  await check('computeDiskUsage returns zeros for a nonexistent folder', async () => {
    const usage = await computeDiskUsage(path.join(root, 'Ghost Show'));
    assert.deepStrictEqual(usage, { totalBytes: 0, episodeCount: 0 });
  });

  // --- computeStorageOverview -------------------------------------------
  await check('computeStorageOverview lists all release folders with effective names', async () => {
    const overview = await computeStorageOverview([root]);
    assert.deepStrictEqual(
      overview.titles.map((t) => t.folderName),
      ['Show A', 'Movie', 'Generic Show Season 1', 'Show A Season 1', 'L4'],
      `got: ${totalsOf(overview).join(', ')}`
    );
    const showA = overview.titles[0];
    assert.strictEqual(showA.folderPath, path.join(root, 'Show A'));
    assert.strictEqual(showA.episodeCount, 3);
    assert.strictEqual(showA.totalBytes, showATotal);
  });

  await check('computeStorageOverview sorts titles by totalBytes descending', async () => {
    const overview = await computeStorageOverview([root]);
    const sizes = overview.titles.map((t) => t.totalBytes);
    const sorted = [...sizes].sort((a, b) => b - a);
    assert.deepStrictEqual(sizes, sorted, `got: ${totalsOf(overview).join(', ')}`);
  });

  await check('computeStorageOverview aggregates totalBytes over titles', async () => {
    const overview = await computeStorageOverview([root]);
    assert.strictEqual(overview.totalBytes, grandTotal, `got ${overview.totalBytes}, expected ${grandTotal}`);
  });

  await check('computeStorageOverview excludes non-release, ignored, and too-deep folders', async () => {
    const overview = await computeStorageOverview([root]);
    for (const t of overview.titles) {
      assert.ok(!t.folderPath.includes('node_modules'), 'node_modules must be ignored');
      assert.ok(!t.folderPath.includes(`${path.sep}.git`), '.git must be ignored');
      assert.ok(!t.folderPath.includes('Only Subs'), 'folder without videos must not be listed');
      assert.ok(!t.folderPath.includes(`${path.sep}L5`), 'depth 5 folders must not be listed');
    }
    // deep5.mkv is not a title of its own, but its bytes count toward the
    // L4 release folder's recursive disk usage — exactly grandTotal.
    assert.strictEqual(overview.totalBytes, grandTotal);
  });

  await check('computeStorageOverview reports freeBytes from the first existing root', async () => {
    const overview = await computeStorageOverview([root]);
    assert.strictEqual(typeof overview.freeBytes, 'number', 'freeBytes should be a number for an existing root');
    assert.ok(Number.isFinite(overview.freeBytes) && overview.freeBytes > 0, `freeBytes should be positive, got ${overview.freeBytes}`);
    const withMissingFirst = await computeStorageOverview([path.join(sandbox, 'Missing Root'), root]);
    assert.strictEqual(typeof withMissingFirst.freeBytes, 'number', 'statfs should fall through to the first existing root');
  });

  await check('computeStorageOverview returns freeBytes null when no root exists', async () => {
    const overview = await computeStorageOverview([path.join(sandbox, 'Missing Root')]);
    assert.strictEqual(overview.freeBytes, null);
    assert.deepStrictEqual(overview.titles, []);
    assert.strictEqual(overview.totalBytes, 0);
  });

  // --- deleteAnime guards ------------------------------------------------
  await check('deleteAnime refuses a folder outside the roots via ../ traversal', async () => {
    const traversalPath = `${root}${path.sep}..${path.sep}Outside${path.sep}Secret`;
    const res = deleteAnime(traversalPath, { allowedRoots: [root] });
    assert.strictEqual(res.success, false, 'traversal outside root must be refused');
    assert.ok(/outside/i.test(res.error || ''), `error should mention outside roots, got: ${res.error}`);
    assert.strictEqual(res.deletedBytes, undefined);
    assert.ok(fs.existsSync(path.join(outside, 'Secret', 'ep.mkv')), 'outside file must be untouched');
  });

  await check('deleteAnime refuses to delete a library root itself', async () => {
    const res = deleteAnime(root, { allowedRoots: [root] });
    assert.strictEqual(res.success, false, 'deleting the root itself must be refused');
    assert.ok(/root/i.test(res.error || ''), `error should mention the root, got: ${res.error}`);
    assert.ok(fs.existsSync(root), 'root must still exist');
  });

  await check('deleteAnime refuses a nonexistent folder with a not-found error', async () => {
    const res = deleteAnime(path.join(root, 'Ghost Show'), { allowedRoots: [root] });
    assert.strictEqual(res.success, false);
    assert.ok(/not found/i.test(res.error || ''), `error should say not found, got: ${res.error}`);
  });

  // --- deleteAnime success -----------------------------------------------
  await check('deleteAnime removes the folder and reports exact deletedBytes', async () => {
    const res = deleteAnime(path.join(root, 'Movie'), { allowedRoots: [root] });
    assert.strictEqual(res.success, true, `deletion should succeed, got: ${res.error}`);
    assert.strictEqual(res.deletedBytes, SIZES.movieEp);
    assert.strictEqual(fs.existsSync(path.join(root, 'Movie')), false, 'folder must be gone');
  });

  await check('deleteAnime on the same folder again fails with not found', async () => {
    const res = deleteAnime(path.join(root, 'Movie'), { allowedRoots: [root] });
    assert.strictEqual(res.success, false);
    assert.ok(/not found/i.test(res.error || ''), `error should say not found, got: ${res.error}`);
  });

  // --- deleteEpisodes ----------------------------------------------------
  await check('deleteEpisodes deletes files inside roots and sums deletedBytes', async () => {
    const files = [
      path.join(root, 'Show A', 'Season 1', 'OVA 01.mkv'),
      path.join(root, 'Generic Show', 'Season 1', 'ep.mkv')
    ];
    const res = deleteEpisodes(files, { allowedRoots: [root] });
    assert.strictEqual(res.success, true, `deletion should succeed, got: ${res.error}`);
    assert.strictEqual(res.deletedBytes, SIZES.showOva + SIZES.genericEp);
    for (const f of files) {
      assert.strictEqual(fs.existsSync(f), false, `${f} must be gone`);
    }
  });

  await check('deleteEpisodes reports partial failures with exact deletedBytes', async () => {
    const ep1 = path.join(root, 'Show A', 'Episode 01.mkv');
    const ep2 = path.join(root, 'Show A', 'Episode 02.mkv');
    const missing = path.join(root, 'Show A', 'Missing 03.mkv');
    const res = deleteEpisodes([ep1, ep2, missing], { allowedRoots: [root] });
    assert.strictEqual(res.success, false, 'partial failure must report success:false');
    assert.strictEqual(res.deletedBytes, SIZES.showEp1 + SIZES.showEp2, 'deletedBytes must count only removed files');
    assert.ok(/not found/i.test(res.error || ''), `error should mention the missing file, got: ${res.error}`);
    assert.ok(/Missing 03\.mkv/.test(res.error || ''), `error should name the failing file, got: ${res.error}`);
    assert.strictEqual(fs.existsSync(ep1), false, 'existing file 1 must be deleted');
    assert.strictEqual(fs.existsSync(ep2), false, 'existing file 2 must be deleted');
  });

  await check('deleteEpisodes never deletes a file outside the roots (../ traversal)', async () => {
    const outsideFile = path.join(outside, 'Secret', 'ep.mkv');
    const traversalPath = `${root}${path.sep}..${path.sep}Outside${path.sep}Secret${path.sep}ep.mkv`;
    const res = deleteEpisodes([traversalPath], { allowedRoots: [root] });
    assert.strictEqual(res.success, false, 'outside file must be refused');
    assert.strictEqual(res.deletedBytes, 0, 'no bytes may be reported for refused files');
    assert.ok(/outside/i.test(res.error || ''), `error should mention outside roots, got: ${res.error}`);
    assert.ok(fs.existsSync(outsideFile), 'outside file must be untouched');
  });

  await check('deleteEpisodes refuses directories and empty inputs', async () => {
    const dirRes = deleteEpisodes([path.join(root, 'Show A')], { allowedRoots: [root] });
    assert.strictEqual(dirRes.success, false);
    assert.ok(/not a regular file/i.test(dirRes.error || ''), `error should mention non-file, got: ${dirRes.error}`);
    assert.ok(fs.existsSync(path.join(root, 'Show A')), 'directory must be untouched');

    const emptyRes = deleteEpisodes([], { allowedRoots: [root] });
    assert.strictEqual(emptyRes.success, false);
    assert.ok(/no files/i.test(emptyRes.error || ''), `error should mention no files, got: ${emptyRes.error}`);

    const noRootsRes = deleteEpisodes([path.join(root, 'Show A', 'Episode 01.srt')], { allowedRoots: [] });
    assert.strictEqual(noRootsRes.success, false);
    assert.ok(/roots/i.test(noRootsRes.error || ''), `error should mention roots, got: ${noRootsRes.error}`);
    assert.ok(fs.existsSync(path.join(root, 'Show A', 'Episode 01.srt')), 'file must be untouched');
  });

  console.log(`\nResults: ${results.pass} passed, ${results.fail} failed`);
  if (results.fail > 0) {
    process.exitCode = 1;
  } else {
    console.log('All libraryManager tests passed!');
  }
} catch (err) {
  console.error('Test harness error:', err);
  results.fail++;
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {}
}
