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

const bundleDir = path.join(__dirname, 'temp-subtitle-signs-bundle');

let extractor;
let helpers;
let TrackControls;
let ffmpegMod;
try {
  await build({
    entryPoints: [
      './electron/assSignsExtractor.ts',
      './electron/subtitleSearchHelpers.ts',
      './electron/ffmpeg.ts',
      './src/components/Player/TrackControls.tsx',
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: bundleDir,
    external: ['react', 'react-dom', 'react/jsx-runtime', 'lucide-react'],
    plugins: [
      {
        name: 'mock-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock-electron' }));
          b.onLoad({ filter: /.*/, namespace: 'mock-electron' }, () => ({
            contents: 'export const app = { getPath: () => "./userData" }; export default { app };',
            loader: 'js',
          }));
        },
      },
    ],
  });

  extractor = await import(`file://${path.join(bundleDir, 'electron/assSignsExtractor.js').replace(/\\/g, '/')}`);
  helpers = await import(`file://${path.join(bundleDir, 'electron/subtitleSearchHelpers.js').replace(/\\/g, '/')}`);
  ffmpegMod = await import(`file://${path.join(bundleDir, 'electron/ffmpeg.js').replace(/\\/g, '/')}`);
  ({ TrackControls } = await import(
    `file://${path.join(bundleDir, 'src/components/Player/TrackControls.js').replace(/\\/g, '/')}`
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

console.log('================================================================');
console.log('   ASS SIGNS EXTRACTOR & SUBTITLE SEARCH VERIFICATION SUITE     ');
console.log('================================================================');

runTest('1.1 Tsundere-style ASS keeps TS/*, TSEPT, K4Notes, OP/ED and drops K1Norma/K2Overl/K3Thoug/K5Narra', () => {
  const sample = `[Script Info]
Title: K1Norma Aegisub file
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: K1Norma,Trebuchet MS,44,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,18,1
Style: K2Overl,Trebuchet MS,44,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,8,10,10,18,1
Style: K3Thoug,Trebuchet MS,44,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,-1,0,0,100,100,0,0,1,2,1,2,10,10,18,1
Style: K4Notes,Trebuchet MS,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,8,10,10,18,1
Style: K5Narra,Trebuchet MS,44,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,18,1
Style: op eng,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,8,10,10,18,1
Style: ed jap,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,18,1
Style: TSEPT,Impact,52,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,5,10,10,18,1
Style: TS/Paper,HandFont,40,&H00000000,&H000000FF,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,10,10,18,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:31.32,0:00:33.97,K1Norma,ui,0,0,0,,Onee-chan, you better get up.
Dialogue: 0,0:00:34.00,0:00:35.00,K2Overl,yui,0,0,0,,Five more minutes!
Dialogue: 0,0:00:36.00,0:00:38.00,K3Thoug,yui,0,0,0,,I am so sleepy...
Dialogue: 0,0:00:39.00,0:00:41.00,K5Narra,,0,0,0,,And so high school began.
Dialogue: 0,0:01:05.00,0:01:09.00,op eng,,0,0,0,,Cagayake! Girls!
Dialogue: 0,0:02:10.00,0:02:14.00,TSEPT,,0,0,0,,Disband the Club!
Dialogue: 0,0:03:00.00,0:03:04.00,TS/Paper,,0,0,0,,Light Music Club Application
Dialogue: 0,0:04:00.00,0:04:03.00,K4Notes,,0,0,0,,TL Note: Keion means Light Music
Dialogue: 0,0:22:10.00,0:22:14.00,ed jap,,0,0,0,,Don't say lazy
Dialogue: 0,0:23:40.00,0:23:42.00,K1Norma,preview,0,0,0,,Next time, our first live!
`;
  const res = extractor.extractSignsFromAss(sample);
  assert.strictEqual(res.totalCount, 10);
  assert.strictEqual(res.keptCount, 5);
  assert(!res.assContent.includes('Onee-chan'), 'K1Norma dropped');
  assert(!res.assContent.includes('Next time, our first live!'), 'Spoken preview dialogue dropped');
  assert(!res.assContent.includes('Five more minutes'), 'K2Overl dropped');
  assert(!res.assContent.includes('so sleepy'), 'K3Thoug dropped');
  assert(!res.assContent.includes('high school began'), 'K5Narra dropped');
  assert(res.assContent.includes('Cagayake! Girls!'), 'op eng kept');
  assert(res.assContent.includes('Disband the Club!'), 'TSEPT kept');
  assert(res.assContent.includes('Light Music Club Application'), 'TS/Paper kept');
  assert(res.assContent.includes('TL Note'), 'K4Notes kept');
  assert(res.assContent.includes("Don't say lazy"), 'ed jap kept');
});

runTest('1.2 Crunchyroll-style ASS keeps top Title/Text/credits and drops top overlap dialogue', () => {
  const sample = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Trebuchet MS,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,18,1
Style: top,Trebuchet MS,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,8,10,10,18,0
Style: Italics - Isekai,Trebuchet MS,24,&H00FFFFFF,&H000000FF,&H00505050,&H00161617,0,-1,0,0,100,100,0,0,1,2,1,2,10,10,18,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:01:00.00,0:01:02.00,Default,Noriko,0,0,0,,Hello there!
Dialogue: 0,0:02:00.00,0:02:03.00,Italics - Isekai,Izark,0,0,0,,Speak to me!
Dialogue: 0,0:03:15.09,0:03:21.22,top,Title,0,0,0,,FROM FAR AWAY
Dialogue: 0,0:04:38.38,0:04:42.71,top,Text,0,0,0,,EPISODE 7:\\NSEVENTEEN AGAINST ONE
Dialogue: 0,0:16:17.78,0:16:18.66,top,Zago Soldier 2,0,0,0,,What's going on?!
Dialogue: 0,0:22:09.99,0:22:13.41,top,credits,0,0,0,,Translator: Angela
`;
  const res = extractor.extractSignsFromAss(sample);
  assert.strictEqual(res.keptCount, 3);
  assert(res.assContent.includes('FROM FAR AWAY'));
  assert(res.assContent.includes('SEVENTEEN AGAINST ONE'));
  assert(res.assContent.includes('Translator: Angela'));
  assert(!res.assContent.includes("What's going on?!"), 'Overlap dialogue on top style dropped');
  assert(!res.assContent.includes('Hello there!'));
  assert(!res.assContent.includes('Speak to me!'));
});

runTest('1.3 Default-style ASS keeps inline typesetting (pos/move/k/p1/styled an8) and drops bare an8 overlap', () => {
  const sample = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1

[Events]
Format: Start, End, Style, Name, Text
Dialogue: 0:00:01.00,0:00:03.00,Default,,Regular spoken line.
Dialogue: 0:00:04.00,0:00:06.00,Default,,{\\an8}Hey, wait for me!
Dialogue: 0:00:07.00,0:00:10.00,Default,,{\\pos(640,180)}School Gate
Dialogue: 0:00:11.00,0:00:14.00,Default,,{\\an8\\fnImpact\\c&H00FFFF&}WARNING: RESTRICTED
Dialogue: 0:00:15.00,0:00:18.00,Default,,{\\k30}La {\\k40}la {\\k50}la
Dialogue: 0:00:19.00,0:00:20.00,Default,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}

[Fonts]
fontname: test.ttf
`;
  const res = extractor.extractSignsFromAss(sample);
  assert.strictEqual(res.keptCount, 4);
  assert(!res.assContent.includes('Regular spoken line.'));
  assert(!res.assContent.includes('Hey, wait for me!'), 'Bare {\\an8} overlap dropped');
  assert(res.assContent.includes('School Gate'));
  assert(res.assContent.includes('WARNING: RESTRICTED'));
  assert(res.assContent.includes('La {\\k40}la'));
  assert(res.assContent.includes('{\\p1}'));
  assert(res.assContent.includes('[Fonts]'), 'Preserves trailing [Fonts] section');
});

runTest('1.4 Dialogue-only ASS returns keptCount=0 and empty assContent', () => {
  const sample = `[Script Info]
ScriptType: v4.00+
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Line one
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\i1}Line two{\\i0}
`;
  const res = extractor.extractSignsFromAss(sample);
  assert.strictEqual(res.keptCount, 0);
  assert.strictEqual(res.totalCount, 2);
  assert.strictEqual(res.assContent, '');
});

runTest('2.1 isTopSignsCandidate supports eng/en/zxx/und/enm Signs and rejects foreign Signs tracks', () => {
  assert.strictEqual(
    extractor.isTopSignsCandidate({ id: '1', language: 'zxx', title: 'Signs and Songs [FBI]', isSigns: true }, 'main'),
    true
  );
  assert.strictEqual(
    extractor.isTopSignsCandidate({ id: '2', language: 'und', title: 'Signs & Songs', isSigns: true }, 'main'),
    true
  );
  assert.strictEqual(
    extractor.isTopSignsCandidate({ id: '3', language: 'eng', title: 'English — Signs / Forced', isSigns: true }, 'main'),
    true
  );
  assert.strictEqual(
    extractor.isTopSignsCandidate({ id: '4', language: 'rus', title: 'Russian Signs', isSigns: true }, 'main'),
    false
  );
  assert.strictEqual(
    extractor.isTopSignsCandidate({ id: '5', language: 'zxx', title: 'Main Dialogue', isSigns: false }, 'main'),
    false
  );
  assert.strictEqual(
    extractor.isTopSignsCandidate({ id: 'main', language: 'eng', title: 'Signs', isSigns: true }, 'main'),
    false
  );
});

runTest('3.1 Security & target path helpers block escaping library roots and never collide with .whisper.srt', () => {
  const roots = ['E:\\Anime'];
  assert.strictEqual(helpers.isAllowedLibraryVideoPath('E:\\Anime\\K-On\\ep01.mkv', roots), true);
  assert.strictEqual(helpers.isAllowedLibraryVideoPath('E:\\Anime2\\K-On\\ep01.mkv', roots), false);
  assert.strictEqual(helpers.isAllowedLibraryVideoPath('E:\\Anime\\..\\Secret\\ep01.mkv', roots), false);
  assert.strictEqual(helpers.isAllowedLibraryVideoPath('E:\\Anime\\K-On\\ep01.mkv', []), false);

  const signsPath = helpers.buildTargetSubtitlePath('E:\\Anime\\K-On\\ep01.mkv', 'signs', 'ass');
  assert.strictEqual(path.basename(signsPath), 'ep01.en.signs.ass');
  const mainPath = helpers.buildTargetSubtitlePath('E:\\Anime\\K-On\\ep01.mkv', 'main', 'srt');
  assert.strictEqual(path.basename(mainPath), 'ep01.en.srt');
  assert(!mainPath.endsWith('.whisper.srt'));
});

runTest('3.2 Batch torrent file matcher distinguishes Season 1 vs Season 2 vs Movie vs NCOP', () => {
  const files = [
    { id: 1, filename: '[Anime Time] K-On!/NC/NCOP.mkv', attachments: [{ id: 10, type: 1, info: { codec: 'ASS', lang: 'en', name: 'OP' } }] },
    { id: 2, filename: '[Anime Time] K-On!/[Anime Time] K-On! - 01.mkv', attachments: [{ id: 11, type: 1, info: { codec: 'ASS', lang: 'en', name: 'Signs & Songs', forced: 1 } }] },
    { id: 3, filename: '[Anime Time] K-On!! (Season 2)/[Anime Time] K-On!! - 01.mkv', attachments: [{ id: 12, type: 1, info: { codec: 'ASS', lang: 'en', name: 'Signs and Signals' } }] },
    { id: 4, filename: '[Anime Time] K-On! The Movie/[Anime Time] K-ON! The Movie.mkv', attachments: [{ id: 13, type: 1, info: { codec: 'ASS', lang: 'zxx', name: 'Signs and Songs [FBI]' } }] },
  ];

  const s1e1 = helpers.matchEpisodeFileInTsukiHimeFiles(files, 'K-On! S01E01.mkv', 1, 1);
  assert.strictEqual(s1e1?.id, 2);

  const s2e1 = helpers.matchEpisodeFileInTsukiHimeFiles(files, 'K-On!! S02E01.mkv', 1, 2);
  assert.strictEqual(s2e1?.id, 3);

  const movie = helpers.matchEpisodeFileInTsukiHimeFiles(files, 'K-On! The Movie.mkv', null, null);
  assert.strictEqual(movie?.id, 4);
});

runTest('3.3 Archive file picker selects correct episode and prefers .ass + signs in preferSigns mode', () => {
  const picked = helpers.pickBestSubtitleFileFromList(
    [
      '__MACOSX/._K-On.E01.ass',
      'K-On.E01.en.srt',
      'K-On.E01.en.signs.ass',
      'K-On.E02.en.signs.ass',
    ],
    1,
    true
  );
  assert.strictEqual(picked, 'K-On.E01.en.signs.ass');
});

runTest('3.4 Subtitle decoding handles UTF-8, UTF-8 BOM, UTF-16LE BOM, and UTF-16BE BOM', () => {
  assert.strictEqual(helpers.decodeSubtitleBuffer(Buffer.from('Hello', 'utf-8')), 'Hello');
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Signs', 'utf16le')]);
  assert.strictEqual(helpers.decodeSubtitleBuffer(le), 'Signs');
  const rawBe = Buffer.from('Signs', 'utf16le');
  for (let i = 0; i + 1 < rawBe.length; i += 2) {
    const tmp = rawBe[i];
    rawBe[i] = rawBe[i + 1];
    rawBe[i + 1] = tmp;
  }
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), rawBe]);
  assert.strictEqual(helpers.decodeSubtitleBuffer(be), 'Signs');
});

runTest('4.1 TrackControls renders Extract Signs & Search Signs Online when episodeFilePath & embedded ASS exist', () => {
  const html = renderToString(
    React.createElement(TrackControls, {
      isOpen: true,
      onClose: () => {},
      audioTracks: [
        { index: 1, audioIndex: 0, title: 'English', language: 'eng', languageName: 'English', codec: 'aac', isDefault: true },
      ],
      subtitleTracks: [
        { id: 'emb-2', index: 2, type: 'embedded', title: 'English [Tsundere]', language: 'eng', languageName: 'English', codec: 'ass', isForced: false, isDefault: true, isSigns: false, isDubtitle: false },
        { id: 'ext-w', index: null, type: 'external', title: 'AI (Whisper)', language: 'eng', languageName: 'English', codec: 'subrip', isForced: false, isDefault: false, isSigns: false, isDubtitle: true },
      ],
      selectedAudioIndex: 0,
      onSelectAudio: () => {},
      selectedMainSubId: 'ext-w',
      onSelectMainSub: () => {},
      selectedTopSubId: null,
      onSelectTopSub: () => {},
      topSubEnabled: false,
      onToggleTopSub: () => {},
      syncOffset: 0,
      onUpdateSyncOffset: () => {},
      onResetSyncOffset: () => {},
      fontSize: 38,
      onUpdateFontSize: () => {},
      episodeFilePath: 'E:\\Anime\\K-On\\ep01.mkv',
      animeTitle: 'K-On!',
    })
  );

  assert(html.includes('Extract Signs from Embedded ASS'), 'Shows Extract Signs button');
  assert(html.includes('Search Signs Online'), 'Shows Search Signs Online button');
  assert(html.includes('External .srt (Whisper)'), 'Preserves Whisper display label');
});

runTest('5.1 parseFfmpegProbeOutput parses Metadata title (ignoring "Subtitle:") and detects Signs & Songs', () => {
  const sampleStderr = `
  Duration: 00:24:11.71, start: 0.000000, bitrate: 1770 kb/s
  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv), 1920x1080
  Stream #0:1(eng): Audio: aac (LC), 48000 Hz, stereo, fltp
    Metadata:
      title           : English
  Stream #0:3(eng): Subtitle: ass (ssa)
    Metadata:
      title           : (Tsundere) Full Subs
  Stream #0:4(eng): Subtitle: ass (ssa) (default)
    Metadata:
      title           : (Tsundere) Signs & Songs
  Stream #0:5: Attachment: ttf
    Metadata:
      filename        : font.ttf
`;
  const meta = ffmpegMod.parseFfmpegProbeOutput('D:\\Anime\\[Anime Time] K-On! - 02.mkv', sampleStderr);
  assert.strictEqual(meta.subtitleTracks.length, 2);
  assert.strictEqual(meta.subtitleTracks[0].title, '(Tsundere) Full Subs');
  assert.strictEqual(meta.subtitleTracks[0].isSigns, false);
  assert.strictEqual(meta.subtitleTracks[1].title, '(Tsundere) Signs & Songs');
  assert.strictEqual(meta.subtitleTracks[1].isSigns, true);
  assert.deepStrictEqual(ffmpegMod.buildSubtitleCodecArgs('ass'), ['-c:s', 'copy', '-f', 'ass']);
  assert.deepStrictEqual(ffmpegMod.buildSubtitleCodecArgs('srt'), ['-c:s', 'srt', '-f', 'srt']);
  assert.deepStrictEqual(ffmpegMod.buildSubtitleCodecArgs('sup'), ['-c:s', 'copy', '-f', 'sup']);
});

runTest('5.2 extractSignsFromAss allows en-US/eng-US, preserves kfx styles, and skips empty lines', () => {
  assert.strictEqual(extractor.isAllowedSignsLanguage('en-US'), true);
  assert.strictEqual(extractor.isAllowedSignsLanguage('eng-US'), true);
  assert.strictEqual(extractor.isAllowedSignsLanguage('jpn'), false);

  const sample = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,44,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,18,1
Style: op-kfx,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,8,10,10,18,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Spoken line should be dropped
Dialogue: 0,0:00:04.00,0:00:06.00,op-kfx,,0,0,0,,   
Dialogue: 0,0:00:07.00,0:00:10.00,op-kfx,,0,0,0,,{\\pos(640,100)}Opening Lyric
`;

  const res = extractor.extractSignsFromAss(sample);
  assert.strictEqual(res.keptCount, 1);
  assert(res.assContent.includes('Opening Lyric'));
  assert(!res.assContent.includes('Spoken line'));
});

runTest('5.3 Batch file matcher prefers Season 1 when targetSeason is null and picks 2nd Season when targetSeason is 2', () => {
  const files = [
    { id: 10, filename: '[MTBB] K-On! 2nd Season - 02.mkv', attachments: [{ id: 101, type: 1 }] },
    { id: 11, filename: '[MTBB] K-On! - 02.mkv', attachments: [{ id: 102, type: 1 }] },
  ];

  const pickedNullSeason = helpers.matchEpisodeFileInTsukiHimeFiles(files, 'K-On! - 02.mkv', 2, null);
  assert.strictEqual(pickedNullSeason?.id, 11);

  const pickedS1 = helpers.matchEpisodeFileInTsukiHimeFiles(files, 'K-On! - 02.mkv', 2, 1);
  assert.strictEqual(pickedS1?.id, 11);

  const pickedS2 = helpers.matchEpisodeFileInTsukiHimeFiles(files, 'K-On! 2nd Season - 02.mkv', 2, 2);
  assert.strictEqual(pickedS2?.id, 10);
});

runTest('5.4 filterFontsForAss pads unmatched obfuscated TTFs up to 24 and drops .ttc / arialunicodems', () => {
  const styleLines = Array.from({ length: 12 }, (_, idx) =>
    `Style: SignStyle${idx},ObscureFont${idx},40,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,5,10,10,18,1`
  ).join('\n');
  const ass = `[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\n${styleLines}\n[Events]\n`;

  const urls = [
    'http://127.0.0.1:99/GOODDP.ttf',
    ...Array.from({ length: 26 }, (_, idx) => `http://127.0.0.1:99/obf_${idx}.ttf`),
    'http://127.0.0.1:99/fallback.ttc',
    'http://127.0.0.1:99/ArialUnicodeMS.ttf',
  ];

  const filtered = ffmpegMod.filterFontsForAss(ass, urls);
  assert.strictEqual(filtered.length, 24);
  assert(filtered.includes('http://127.0.0.1:99/GOODDP.ttf'), 'Must include abbreviated TTF filename GOODDP.ttf');
  assert(!filtered.some((u) => u.endsWith('.ttc')), 'Must exclude .ttc font collections');
  assert(!filtered.some((u) => u.toLowerCase().includes('arialunicodems')), 'Must exclude unreferenced ArialUnicodeMS.ttf');
});

runTest('5.5 VideoPlayer autoAcquireTopSigns & explicit-OFF guards + dynamic User-Agent checks', () => {
  const playerSrc = fs.readFileSync(path.join(__dirname, 'src/components/Player/VideoPlayer.tsx'), 'utf-8');
  assert(playerSrc.includes('explicitTopSubOffRef'), 'VideoPlayer must track explicit Top Sub OFF choices');
  assert(playerSrc.includes('autoTriedSignsPathsRef'), 'VideoPlayer must avoid retrying auto-acquire repeatedly for the same file');
  assert(playerSrc.includes('activeMain.codec') && playerSrc.includes('\\.(ass|ssa)$/i'), 'Auto-acquire must skip when Main Sub is already ASS/SSA');
  assert(playerSrc.includes('r.matchScore >= 140'), 'Auto-acquire online download must require high-confidence ASS match');
  assert(playerSrc.includes('seasonPref.topSubtitleTrackId === null'), 'VideoPlayer must honor saved explicit null Top Sub preference');

  const searchSrc = fs.readFileSync(path.join(__dirname, 'electron/subtitleSearch.ts'), 'utf-8');
  assert(!searchSrc.includes('Kaiko/3.2.1'), 'subtitleSearch.ts must not hardcode Kaiko/3.2.1');
  assert(!searchSrc.includes('Kaiko v3.2.1'), 'subtitleSearch.ts must not hardcode Kaiko v3.2.1');
  assert(searchSrc.includes('getKaikoUserAgent'), 'subtitleSearch.ts must use dynamic getKaikoUserAgent()');
});

console.log(`\n================================================================`);
console.log(`TOTAL TESTS: ${total} | PASSED: ${passed} | FAILED: ${total - passed}`);
console.log(`================================================================`);
