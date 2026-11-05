import assert from 'assert';
import {
  extractEpisodeNumber,
  normalizeReleaseString,
  parseEpisodeDetails,
  parseRelease,
  parseReleaseSync,
  sanitizeMediaTags,
} from './src/lib/releaseParser/index.ts';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ Passed: ${name}`);
  } catch (err) {
    failed++;
    console.log(`✗ Failed: ${name}\n    ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ Passed: ${name}`);
  } catch (err) {
    failed++;
    console.log(`✗ Failed: ${name}\n    ${err.message}`);
  }
}

console.log('Running release parser tests...\n');

// ---------------------------------------------------------------------------
// (a) Compat: representative subset of the test-episodes.js corpus via
//     extractEpisodeNumber imported from the new shared module.
// ---------------------------------------------------------------------------

const compatCases = [
  { input: '[Group] Steins;Gate 0 - 05 [BD 1080p].mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '[Group] Mob Psycho 100 - 05 [1080p].mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Love Live 2 - 05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show S02E03.mkv', expectedNum: 3, expectedLabel: 'S02E03' },
  { input: '[SubsPlease] DanMachi S5 - 08 (1080p) [ABCD].mkv', expectedNum: 8, expectedLabel: 'E08' },
  { input: 'Bleach - 366v2.mkv', expectedNum: 366, expectedLabel: 'E366' },
  { input: 'Show.Name.05.1080p.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '[Group] Show S2 - 05v2 [1080p].mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Clevatess.2025.S02E01.REPACK2.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu.mkv', expectedNum: 1, expectedLabel: 'S02E01' },
  { input: '[Erai-raws] Show 1920x1080.mkv', expectedNum: null, expectedLabel: 'EP' },
  { input: '[Erai-raws] Show - 04 [1920x1080].mkv', expectedNum: 4, expectedLabel: 'E04' },
  { input: 'Show.1280x720.05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show.E-AC-3.mkv', expectedNum: null, expectedLabel: 'EP' },
  { input: 'Show.DDP5.1.Atmos.mkv', expectedNum: null, expectedLabel: 'EP' },
  { input: 'Show.S01E03.EAC3.1080p.mkv', expectedNum: 3, expectedLabel: 'S01E03' },
  { input: 'One.Piece.1085.1080p.mkv', expectedNum: 1085, expectedLabel: 'E1085' },
  { input: 'One Piece - 1085 [1080p].mkv', expectedNum: 1085, expectedLabel: 'E1085' },
  { input: 'Show - 05.5 [1080p].mkv', expectedNum: 5.5, expectedLabel: 'E05.5' },
  { input: 'Show.S02E01.5.1080p.mkv', expectedNum: 1.5, expectedLabel: 'S02E01.5' },
  { input: 'Show - S01E01-E02.mkv', expectedNum: 1, expectedLabel: 'S01E01-E02' },
  { input: 'Show - 01-02.mkv', expectedNum: 1, expectedLabel: 'E01-E02' },
  { input: 'Show - E03-E04.mkv', expectedNum: 3, expectedLabel: 'E03-E04' },
  { input: 'Show - OVA 01.mkv', expectedNum: 1, expectedLabel: 'OVA01' },
  { input: 'Show - SP 02.mkv', expectedNum: 2, expectedLabel: 'SP02' },
  { input: 'Show - NCED1.mkv', expectedNum: 1, expectedLabel: 'NCED01' },
  { input: 'Show - NCOP 02.mkv', expectedNum: 2, expectedLabel: 'NCOP02' },
  { input: 'Mob.Psycho.100.05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '86.Eighty.Six.S01E05.mkv', expectedNum: 5, expectedLabel: 'S01E05' },
  { input: 'Steins;Gate.0.05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Persona.4.05.1080p.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: '[SubsPlease] Show – 05 (1080p).mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show — 05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show 〜 05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show・05.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Show - ０５.mkv', expectedNum: 5, expectedLabel: 'E05' },
  { input: 'Frieren.2023.05.1080p.mkv', expectedNum: 5, expectedLabel: 'E05' },
];

console.log(`[compat] ${compatCases.length} extractEpisodeNumber cases`);
for (const tc of compatCases) {
  check(`extractEpisodeNumber "${tc.input}"`, () => {
    const result = extractEpisodeNumber(tc.input);
    assert.strictEqual(result.episodeNum, tc.expectedNum, `episodeNum ${result.episodeNum} != ${tc.expectedNum}`);
    assert.strictEqual(result.label, tc.expectedLabel, `label ${result.label} != ${tc.expectedLabel}`);
  });
}

// ---------------------------------------------------------------------------
// (b) Rich fields via parseReleaseSync (regex engine is authority).
// ---------------------------------------------------------------------------

const frierenName = '[SubsPlease] Frieren - S01E05.5 [1080p][HEVC][10-bit][Dual Audio][FLAC].mkv';
const sceneName = 'Show.Name.S02E01.REPACK2.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-AnoZu.mkv';
const batchName = '[HorribleSubs] Show Complete Batch [720p][AAC].mkv';
const movieName = 'Show Movie [1080p].mkv';
const ovaName = 'Show - OVA 01.mkv';
const ncedName = 'Show - NCED1.mkv';
const multiName = 'Show - S01E01-E02.mkv';
const mp4Name = 'Anime - 01 [1080p].mp4';
const unicodeName = 'Show ― 05 [1080p].mkv';
const unknownName = 'Reading Notes [720p].mkv';
const preferName = 'Show [Episode 07].mkv';

console.log('\n[rich] parseReleaseSync field assertions');
check(`rich fields: ${frierenName}`, () => {
  const r = parseReleaseSync(frierenName);
  assert.strictEqual(r.episodeNumber, 5.5);
  assert.strictEqual(r.season, 1);
  assert.strictEqual(r.label, 'S01E05.5');
  assert.strictEqual(r.releaseGroup, 'SubsPlease');
  assert.strictEqual(r.resolution, '1080p');
  assert.ok(r.videoTerm === 'HEVC' || r.videoTerm === '10-bit', `videoTerm ${r.videoTerm}`);
  assert.ok(r.audioTerm === 'Dual Audio' || r.audioTerm === 'FLAC', `audioTerm ${r.audioTerm}`);
  assert.strictEqual(r.animeTitle, 'Frieren');
  assert.strictEqual(r.releaseType, 'TV');
  assert.strictEqual(r.isSpecial, false);
  assert.deepStrictEqual(r.episodeNumbers, [5.5]);
  assert.strictEqual(r.episodeEnd, null);
  assert.strictEqual(r.parsedBy, 'regex');
  assert.strictEqual(r.enrichedBy, undefined);
});

check(`rich fields: ${sceneName}`, () => {
  const r = parseReleaseSync(sceneName);
  assert.strictEqual(r.episodeNumber, 1);
  assert.strictEqual(r.season, 2);
  assert.strictEqual(r.label, 'S02E01');
  assert.strictEqual(r.releaseGroup, 'AnoZu');
  assert.strictEqual(r.resolution, '1080p');
  assert.strictEqual(r.videoTerm, 'H.264');
  assert.ok(r.audioTerm !== null && /DDP|DUAL/i.test(r.audioTerm), `audioTerm ${r.audioTerm}`);
  assert.strictEqual(r.animeTitle, 'Show Name');
  assert.strictEqual(r.releaseType, 'TV');
  assert.deepStrictEqual(r.episodeNumbers, [1]);
});

check(`rich fields: ${batchName}`, () => {
  const r = parseReleaseSync(batchName);
  assert.strictEqual(r.releaseType, 'Batch');
  assert.strictEqual(r.releaseGroup, 'HorribleSubs');
  assert.strictEqual(r.resolution, '720p');
  assert.strictEqual(r.audioTerm, 'AAC');
  assert.strictEqual(r.animeTitle, 'Show');
  assert.strictEqual(r.episodeNumber, null);
  assert.strictEqual(r.label, 'EP');
});

check(`rich fields: ${movieName}`, () => {
  const r = parseReleaseSync(movieName);
  assert.strictEqual(r.releaseType, 'Movie');
  assert.strictEqual(r.episodeNumber, null);
  assert.strictEqual(r.label, 'EP');
  assert.strictEqual(r.resolution, '1080p');
  assert.strictEqual(r.animeTitle, 'Show Movie');
  assert.deepStrictEqual(r.episodeNumbers, []);
});

check(`rich fields: ${ovaName}`, () => {
  const r = parseReleaseSync(ovaName);
  assert.strictEqual(r.releaseType, 'OVA');
  assert.strictEqual(r.isSpecial, true);
  assert.strictEqual(r.specialType, 'OVA');
  assert.strictEqual(r.episodeNumber, 1);
  assert.strictEqual(r.label, 'OVA01');
  assert.strictEqual(r.animeTitle, 'Show');
});

check(`rich fields: ${ncedName}`, () => {
  const r = parseReleaseSync(ncedName);
  assert.strictEqual(r.releaseType, 'NCED');
  assert.strictEqual(r.isSpecial, true);
  assert.strictEqual(r.specialType, 'NCED');
  assert.strictEqual(r.episodeNumber, 1);
  assert.strictEqual(r.label, 'NCED01');
});

check(`rich fields: ${multiName}`, () => {
  const r = parseReleaseSync(multiName);
  assert.strictEqual(r.isMultiEpisode, true);
  assert.strictEqual(r.episodeNumber, 1);
  assert.strictEqual(r.episodeEnd, 2);
  assert.deepStrictEqual(r.episodeNumbers, [1, 2]);
  assert.strictEqual(r.label, 'S01E01-E02');
  assert.strictEqual(r.season, 1);
  assert.strictEqual(r.releaseType, 'TV');
});

check(`rich fields: ${mp4Name}`, () => {
  const r = parseReleaseSync(mp4Name);
  assert.strictEqual(r.episodeNumber, 1);
  assert.strictEqual(r.label, 'E01');
  assert.strictEqual(r.resolution, '1080p');
  assert.strictEqual(r.animeTitle, 'Anime');
  assert.strictEqual(r.releaseType, 'TV');
});

check(`rich fields: ${unicodeName}`, () => {
  const r = parseReleaseSync(unicodeName);
  assert.strictEqual(r.episodeNumber, 5);
  assert.strictEqual(r.label, 'E05');
  assert.strictEqual(r.animeTitle, 'Show');
  assert.strictEqual(r.resolution, '1080p');
});

check(`rich fields: ${unknownName}`, () => {
  const r = parseReleaseSync(unknownName);
  assert.strictEqual(r.releaseType, 'Unknown');
  assert.strictEqual(r.episodeNumber, null);
  assert.strictEqual(r.label, 'EP');
  assert.strictEqual(r.resolution, '720p');
  assert.strictEqual(r.animeTitle, 'Reading Notes');
});

check(`rich fields: ${preferName} (regex finds nothing, episode stays authority)`, () => {
  const r = parseReleaseSync(preferName);
  assert.strictEqual(r.episodeNumber, null);
  assert.strictEqual(r.label, 'EP');
  assert.strictEqual(r.releaseType, 'Unknown');
});

// ---------------------------------------------------------------------------
// (c) normalizeReleaseString / sanitizeMediaTags / parseEpisodeDetails spot checks.
// ---------------------------------------------------------------------------

console.log('\n[utils] normalizeReleaseString / sanitizeMediaTags / parseEpisodeDetails');
check('normalizeReleaseString unicode mapping', () => {
  assert.strictEqual(normalizeReleaseString(''), '');
  assert.strictEqual(normalizeReleaseString('Show ― ０５'), 'Show - 05');
  assert.strictEqual(normalizeReleaseString('Show・05'), 'Show 05');
  assert.strictEqual(normalizeReleaseString('Show ～ 05'), 'Show - 05');
});

check('sanitizeMediaTags strips tech tags', () => {
  assert.strictEqual(sanitizeMediaTags('Show [B6543D71] 1080p'), 'Show');
  assert.strictEqual(sanitizeMediaTags('Show 1920x1080 E-AC-3 DDP5.1'), 'Show');
  assert.strictEqual(sanitizeMediaTags('Show.Name.S01E01.WEB-DL'), 'Show.Name.S01E01.');
});

check('parseEpisodeDetails flags', () => {
  const multi = parseEpisodeDetails('Show - S01E01-E02.mkv');
  assert.strictEqual(multi.isMultiEpisode, true);
  const ova = parseEpisodeDetails('Show - OVA 02.mkv');
  assert.strictEqual(ova.isSpecial, true);
  assert.strictEqual(ova.specialType, 'OVA');
  const plain = parseEpisodeDetails('Show - 05.mkv');
  assert.strictEqual(plain.isSpecial, undefined);
  assert.strictEqual(plain.isMultiEpisode, undefined);
  const empty = parseEpisodeDetails('');
  assert.strictEqual(empty.episodeNum, null);
  assert.strictEqual(empty.label, 'EP');
});

// ---------------------------------------------------------------------------
// (d) Async path: parseRelease enriches, regex stays authority; sync and
//     async agree on episodeNumber/label.
// ---------------------------------------------------------------------------

const agreementNames = compatCases.map((tc) => tc.input).concat([
  frierenName, sceneName, batchName, movieName, ovaName, ncedName, multiName,
  mp4Name, unicodeName, unknownName, preferName,
]);

console.log(`\n[async] sync/async agreement on ${agreementNames.length} names`);
for (const name of agreementNames) {
  await checkAsync(`agreement: ${name}`, async () => {
    const sync = parseReleaseSync(name);
    const asyncResult = await parseRelease(name);
    assert.strictEqual(asyncResult.episodeNumber, sync.episodeNumber, `episode ${asyncResult.episodeNumber} != ${sync.episodeNumber}`);
    assert.strictEqual(asyncResult.label, sync.label, `label ${asyncResult.label} != ${sync.label}`);
    assert.strictEqual(asyncResult.season, sync.season);
  });
}

await checkAsync('async parse marks anitomy enrichment', async () => {
  const r = await parseRelease(frierenName);
  assert.strictEqual(r.parsedBy, 'anitomy');
  assert.strictEqual(r.enrichedBy, 'anitomy');
  // anitomy only fills null/empty fields: regex-captured values must survive
  assert.strictEqual(r.releaseGroup, 'SubsPlease');
  assert.strictEqual(r.resolution, '1080p');
  assert.strictEqual(r.label, 'S01E05.5');
});

await checkAsync('async parse fills missing fields from anitomy', async () => {
  const r = await parseRelease(preferName);
  assert.strictEqual(r.parsedBy, 'anitomy');
  assert.strictEqual(r.enrichedBy, 'anitomy');
  // Episode stays null without the opt-in (regex is authority)
  assert.strictEqual(r.episodeNumber, null);
  assert.strictEqual(r.label, 'EP');
});

await checkAsync('preferAnitomyEpisode lets anitomy win when regex failed', async () => {
  const r = await parseRelease(preferName, { preferAnitomyEpisode: true });
  assert.strictEqual(r.episodeNumber, 7);
  assert.strictEqual(r.label, 'E07');
  assert.deepStrictEqual(r.episodeNumbers, [7]);
  assert.strictEqual(r.episodeEnd, null);
  assert.strictEqual(r.isMultiEpisode, false);
});

await checkAsync('preferAnitomyEpisode keeps regex fallback agreement', async () => {
  const sync = parseReleaseSync(sceneName);
  const r = await parseRelease(sceneName, { preferAnitomyEpisode: true });
  assert.strictEqual(r.episodeNumber, sync.episodeNumber);
  assert.strictEqual(r.label, sync.label);
  assert.strictEqual(r.season, sync.season);
});

await checkAsync('parseRelease handles batch + movie through anitomy path', async () => {
  const batch = await parseRelease(batchName);
  assert.strictEqual(batch.releaseType, 'Batch');
  const movie = await parseRelease(movieName);
  assert.strictEqual(movie.releaseType, 'Movie');
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  process.exitCode = 1;
  console.log('RELEASE PARSER TESTS FAILED');
} else {
  console.log('All release parser tests passed successfully!');
}
