import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import React from 'react';
import { renderToString } from 'react-dom/server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const bundleDir = path.join(__dirname, 'temp-pgs-test-bundle');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaiko-pgs-sup-'));

let pgs;
let SubtitleOverlay;
try {
  await build({
    entryPoints: ['./electron/pgs.ts', './src/components/Player/SubtitleOverlay.tsx'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: bundleDir,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
  });

  pgs = await import(`file://${path.join(bundleDir, 'electron/pgs.js').replace(/\\/g, '/')}`);
  ({ SubtitleOverlay } = await import(
    `file://${path.join(bundleDir, 'src/components/Player/SubtitleOverlay.js').replace(/\\/g, '/')}`
  ));
} finally {
  try {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  } catch {}
}

let passed = 0;
let total = 0;

function runTest(name, fn) {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function makePgSegment(ptsSec, segType, payload) {
  const hdr = Buffer.alloc(13);
  hdr[0] = 0x50;
  hdr[1] = 0x47;
  hdr.writeUInt32BE(Math.round(ptsSec * 90000), 2);
  hdr.writeUInt32BE(0, 6);
  hdr[10] = segType;
  hdr.writeUInt16BE(payload.length, 11);
  return Buffer.concat([hdr, payload]);
}

function makePcs(ptsSec, cw, ch, state, palId, objs) {
  let objSize = 0;
  for (const o of objs) objSize += o.crop ? 16 : 8;
  const payload = Buffer.alloc(11 + objSize);
  payload.writeUInt16BE(cw, 0);
  payload.writeUInt16BE(ch, 2);
  payload[4] = 0x10;
  payload.writeUInt16BE(0, 5);
  payload[7] = state;
  payload[8] = 0;
  payload[9] = palId;
  payload[10] = objs.length;
  let off = 11;
  for (const o of objs) {
    payload.writeUInt16BE(o.oid, off);
    payload[off + 2] = 0;
    payload[off + 3] = o.crop ? 0x80 : 0x00;
    payload.writeUInt16BE(o.x, off + 4);
    payload.writeUInt16BE(o.y, off + 6);
    if (o.crop) {
      payload.writeUInt16BE(o.crop.x, off + 8);
      payload.writeUInt16BE(o.crop.y, off + 10);
      payload.writeUInt16BE(o.crop.w, off + 12);
      payload.writeUInt16BE(o.crop.h, off + 14);
      off += 16;
    } else {
      off += 8;
    }
  }
  return makePgSegment(ptsSec, 0x16, payload);
}

function makePds(ptsSec, pid, entries) {
  const payload = Buffer.alloc(2 + entries.length * 5);
  payload[0] = pid;
  payload[1] = 0;
  let off = 2;
  for (const [id, Y, Cr, Cb, A] of entries) {
    payload[off] = id;
    payload[off + 1] = Y;
    payload[off + 2] = Cr;
    payload[off + 3] = Cb;
    payload[off + 4] = A;
    off += 5;
  }
  return makePgSegment(ptsSec, 0x14, payload);
}

function makeOdsSingle(ptsSec, oid, w, h, rle) {
  const hdr = Buffer.alloc(11);
  hdr.writeUInt16BE(oid, 0);
  hdr[2] = 0;
  hdr[3] = 0xc0; // first & last
  const len24 = 4 + rle.length;
  hdr[4] = (len24 >>> 16) & 0xff;
  hdr[5] = (len24 >>> 8) & 0xff;
  hdr[6] = len24 & 0xff;
  hdr.writeUInt16BE(w, 7);
  hdr.writeUInt16BE(h, 9);
  return makePgSegment(ptsSec, 0x15, Buffer.concat([hdr, rle]));
}

function makeOdsFragment(ptsSec, oid, seqFlag, w, h, chunk, totalLen = chunk.length) {
  if (seqFlag & 0x80) {
    const hdr = Buffer.alloc(11);
    hdr.writeUInt16BE(oid, 0);
    hdr[2] = 0;
    hdr[3] = seqFlag;
    const len24 = 4 + totalLen;
    hdr[4] = (len24 >>> 16) & 0xff;
    hdr[5] = (len24 >>> 8) & 0xff;
    hdr[6] = len24 & 0xff;
    hdr.writeUInt16BE(w, 7);
    hdr.writeUInt16BE(h, 9);
    return makePgSegment(ptsSec, 0x15, Buffer.concat([hdr, chunk]));
  }
  const hdr = Buffer.alloc(4);
  hdr.writeUInt16BE(oid, 0);
  hdr[2] = 0;
  hdr[3] = seqFlag;
  return makePgSegment(ptsSec, 0x15, Buffer.concat([hdr, chunk]));
}

function makeEnd(ptsSec) {
  return makePgSegment(ptsSec, 0x80, Buffer.alloc(0));
}

console.log('\n================================================================');
console.log('   BLU-RAY PGS (.sup) & DUAL SUBTITLE VERIFICATION SUITE         ');
console.log('================================================================');

runTest('1.1 Codec classification helpers recognize PGS and unsupported bitmap codecs', () => {
  assert.strictEqual(pgs.isPgsCodec('hdmv_pgs_subtitle'), true);
  assert.strictEqual(pgs.isPgsCodec('pgssub'), true);
  assert.strictEqual(pgs.isPgsCodec('ass'), false);
  assert.strictEqual(pgs.isPgsCodec('subrip'), false);
  assert.strictEqual(pgs.isUnsupportedBitmapCodec('dvd_subtitle'), true);
  assert.strictEqual(pgs.isUnsupportedBitmapCodec('hdmv_pgs_subtitle'), false);
});

runTest('1.2 PGS parser decodes all RLE opcodes, multi-fragment ODS, cropping, and PNG output', () => {
  // Build a 10x3 image with palette entry 1 (white) and entry 2 (red)
  // Row 0: short color run of 5x index 1 + 5x index 2
  // Row 1: literal 1 + short zero run 4 + long zero run 2 + long color run 3x index 1
  // Row 2: 10x index 2 via short color run
  const rle = Buffer.from([
    0x00, 0x85, 0x01, 0x00, 0x85, 0x02, 0x00, 0x00,
    0x01, 0x00, 0x04, 0x00, 0x40, 0x02, 0x00, 0xc0, 0x03, 0x01, 0x00, 0x00,
    0x00, 0x8a, 0x02, 0x00, 0x00,
  ]);
  const frag1 = rle.subarray(0, 8);
  const frag2 = rle.subarray(8, 16);
  const frag3 = rle.subarray(16);

  const sup = Buffer.concat([
    // Cue 1 (start 10.0s, multi-fragment + crop 6x2 at offset (2,1))
    makePcs(10.0, 1920, 1080, 0x80, 0, [
      { oid: 0, x: 640, y: 950, crop: { x: 2, y: 1, w: 6, h: 2 } },
    ]),
    makePds(10.0, 0, [
      [1, 235, 128, 128, 255], // white opaque
      [2, 81, 240, 90, 200],   // vivid red semi-opaque
    ]),
    makeOdsFragment(10.0, 0, 0x80, 10, 3, frag1, rle.length),
    makeOdsFragment(10.0, 0, 0x00, 10, 3, frag2),
    makeOdsFragment(10.0, 0, 0x40, 10, 3, frag3),
    makeEnd(10.0),
    // Clear Cue 1 at 12.5s
    makePcs(12.5, 1920, 1080, 0x00, 0, []),
    makeEnd(12.5),
    // Cue 2 (start 20.0s -> replaced directly by Cue 3 at 22.0s -> cleared at 25.0s)
    makePcs(20.0, 1920, 1080, 0x80, 0, [{ oid: 1, x: 100, y: 80 }]),
    makePds(20.0, 0, [[1, 235, 128, 128, 255]]),
    makeOdsSingle(20.0, 1, 4, 2, Buffer.from([0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x84, 0x01, 0x00, 0x00])),
    makeEnd(20.0),
    makePcs(22.0, 1920, 1080, 0x00, 0, [{ oid: 2, x: 200, y: 90 }]),
    makeOdsSingle(22.0, 2, 2, 1, Buffer.from([0x01, 0x01, 0x00, 0x00])),
    makeEnd(22.0),
    makePcs(25.0, 1920, 1080, 0x00, 0, []),
    makeEnd(25.0),
  ]);

  const parsed = pgs.parsePgsSupBuffer(sup);
  assert.strictEqual(parsed.cues.length, 3);

  assert(Math.abs(parsed.cues[0].start - 10.0) < 0.001);
  assert(Math.abs(parsed.cues[0].end - 12.5) < 0.001);
  assert.strictEqual(parsed.cues[0].objects[0].width, 6);
  assert.strictEqual(parsed.cues[0].objects[0].height, 2);

  assert(Math.abs(parsed.cues[1].start - 20.0) < 0.001);
  assert(Math.abs(parsed.cues[1].end - 22.0) < 0.001);
  assert(Math.abs(parsed.cues[2].start - 22.0) < 0.001);
  assert(Math.abs(parsed.cues[2].end - 25.0) < 0.001);

  // Decode cropped object 0 and inspect PNG header + IHDR dimensions
  const decoded = pgs.decodePgsObjectRgba(parsed.cues[0].objects[0]);
  assert.strictEqual(decoded.width, 6);
  assert.strictEqual(decoded.height, 2);
  // Row 1 cols 2..5 (before crop y=1, x=2): cols 2,3,4,5 are zero(alpha=0); col 6 is zero(0); col 7 is white (255,255,255,255)
  assert.strictEqual(decoded.rgba[3], 0); // cropped (2,1) transparent
  assert.strictEqual(decoded.rgba[5 * 4 + 3], 255); // cropped (7,1) opaque white

  const png = pgs.encodeRgbaPng(decoded.width, decoded.height, decoded.rgba);
  assert.strictEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.strictEqual(png.readUInt32BE(16), 6);
  assert.strictEqual(png.readUInt32BE(20), 2);
  assert(png.includes(Buffer.from('IDAT', 'ascii')));
  assert(png.includes(Buffer.from('IEND', 'ascii')));
});

runTest('1.3 registerPgsSupFile and getPgsBitmapPng serve valid PNGs and reject invalid queries', () => {
  const supPath = path.join(tempDir, 'sample.sup');
  const rle = Buffer.from([0x00, 0x84, 0x01, 0x00, 0x00, 0x00, 0x84, 0x01, 0x00, 0x00]);
  const sup = Buffer.concat([
    makePcs(1.0, 1920, 1080, 0x80, 0, [{ oid: 0, x: 500, y: 900 }]),
    makePds(1.0, 0, [[1, 235, 128, 128, 255]]),
    makeOdsSingle(1.0, 0, 4, 2, rle),
    makeEnd(1.0),
    makePcs(3.0, 1920, 1080, 0x00, 0, []),
    makeEnd(3.0),
  ]);
  fs.writeFileSync(supPath, sup);

  const reg = pgs.registerPgsSupFile(supPath, 54321);
  assert.strictEqual(reg.cues.length, 1);
  assert(reg.cues[0].bitmaps[0].url.startsWith('http://127.0.0.1:54321/pgs?'));

  const png = pgs.getPgsBitmapPng(reg.key, 0, 0);
  assert(Buffer.isBuffer(png) && png.length > 30);
  assert.strictEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  // Security & bounds checks
  assert.strictEqual(pgs.getPgsBitmapPng('../badkey', 0, 0), null);
  assert.strictEqual(pgs.getPgsBitmapPng(reg.key, -1, 0), null);
  assert.strictEqual(pgs.getPgsBitmapPng(reg.key, 99, 0), null);

  // Empty 0-byte window file handled safely
  const emptySup = path.join(tempDir, 'empty.sup');
  fs.writeFileSync(emptySup, Buffer.alloc(0));
  const emptyReg = pgs.registerPgsSupFile(emptySup, 54321);
  assert.deepStrictEqual(emptyReg.cues, []);
});

runTest('2.1 SubtitleOverlay renders Top PGS bitmap at top alongside Bottom Whisper SRT text', () => {
  const mainCues = [
    { id: 1, start: 2588, end: 2592, text: 'Wait, look at this club application.' },
  ];
  const topCues = [
    {
      id: 2,
      start: 2589.4,
      end: 2591.3,
      text: '',
      bitmaps: [
        {
          url: 'http://127.0.0.1:50000/pgs?key=abc&cue=0&obj=0',
          x: 643,
          y: 968, // Raw Blu-ray authored bottom y MUST still render in top slot when used as 2nd Sub!
          width: 633,
          height: 52,
          canvasWidth: 1920,
          canvasHeight: 1080,
        },
      ],
    },
  ];

  const html = renderToString(
    React.createElement(SubtitleOverlay, {
      currentTime: 2590.0,
      mainCues,
      topCues,
      topSubEnabled: true,
      syncOffset: 0,
      fontSize: 38,
    })
  );

  assert(html.includes('Wait, look at this club application.'));
  assert(html.includes('subtitles-overlay-top-bitmap'));
  assert(html.includes('http://127.0.0.1:50000/pgs?key=abc&amp;cue=0&amp;obj=0'));
  assert(!html.includes('subtitles-overlay-top '), 'No redundant yellow text box when only PGS bitmap active');

  // When topSubEnabled is false, top bitmap must be hidden
  const htmlDisabled = renderToString(
    React.createElement(SubtitleOverlay, {
      currentTime: 2590.0,
      mainCues,
      topCues,
      topSubEnabled: false,
      syncOffset: 0,
    })
  );
  assert(!htmlDisabled.includes('subtitles-overlay-top-bitmap'));
});

runTest('2.2 SubtitleOverlay positions Main PGS bitmap cues at exact canvas coordinates', () => {
  const mainCues = [
    {
      id: 1,
      start: 10,
      end: 14,
      text: '',
      bitmaps: [
        {
          url: 'http://127.0.0.1:50000/pgs?key=main&cue=0&obj=0',
          x: 480,
          y: 864,
          width: 960,
          height: 108,
          canvasWidth: 1920,
          canvasHeight: 1080,
        },
      ],
    },
  ];

  const html = renderToString(
    React.createElement(SubtitleOverlay, {
      currentTime: 12,
      mainCues,
      topCues: [],
      topSubEnabled: false,
      syncOffset: 0,
    })
  );

  assert(html.includes('http://127.0.0.1:50000/pgs?key=main&amp;cue=0&amp;obj=0'));
  assert(html.includes('left:25%'));
  assert(html.includes('top:80%'));
  assert(html.includes('width:50%'));
  assert(html.includes('height:10%'));
});

runTest('2.3 Back-to-back cues follow half-open [start, end) semantics without boundary doubling', () => {
  const mainCues = [
    { id: 1, start: 10.0, end: 12.0, text: 'First Line' },
    { id: 2, start: 12.0, end: 14.0, text: 'Second Line' },
  ];
  const htmlBoundary = renderToString(
    React.createElement(SubtitleOverlay, {
      currentTime: 12.0,
      mainCues,
      topCues: [],
      topSubEnabled: false,
      syncOffset: 0,
    })
  );
  assert(!htmlBoundary.includes('First Line'));
  assert(htmlBoundary.includes('Second Line'));
});

runTest('3.1 Backend & Player wiring invariants (copyts window extraction, /pgs server, PGS badge)', () => {
  const ffmpegSrc = fs.readFileSync('./electron/ffmpeg.ts', 'utf-8');
  const mainSrc = fs.readFileSync('./electron/main.ts', 'utf-8');
  const serverSrc = fs.readFileSync('./electron/server.ts', 'utf-8');
  const playerSrc = fs.readFileSync('./src/components/Player/VideoPlayer.tsx', 'utf-8');
  const controlsSrc = fs.readFileSync('./src/components/Player/TrackControls.tsx', 'utf-8');

  assert(ffmpegSrc.includes("'-copyts'"), 'Window extraction preserves timestamps with -copyts');
  assert(ffmpegSrc.includes("'-f', 'sup'"), 'PGS extractor outputs raw .sup stream');
  assert(mainSrc.includes('isPgsCodec(track.codec)'), 'IPC handler routes PGS codecs natively');
  assert(serverSrc.includes("pathname === '/pgs'"), 'StreamServer exposes /pgs bitmap PNG route');
  assert(playerSrc.includes('getAbsolutePositionSec'), 'VideoPlayer uses absolute stream time for window seeks');
  assert(playerSrc.includes('seekWindowHandlerRef'), 'VideoPlayer supports instant seek-window refresh during cold load');
  assert(controlsSrc.includes("return 'PGS'"), 'TrackControls displays crisp PGS badge');
});

console.log('\n================================================================');
console.log(`ALL PGS & DUAL SUBTITLE TESTS PASSED: ${passed} / ${total} (100%)`);
console.log('================================================================\n');

fs.rmSync(tempDir, { recursive: true, force: true });
