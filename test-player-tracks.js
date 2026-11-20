/**
 * Unit tests for player track selection, default audio/subtitle language &
 * subtitle-type persistence, per-season index recovery, external subtitle
 * language detection, and notification action routing.
 *
 * Run: node test-player-tracks.js
 */
import assert from 'node:assert/strict';
import {
  buildDefaultSettingsFromSelection,
  canonicalizeTrackLanguage,
  classifySubtitleTrackType,
  resolveEffectivePlaybackPreferences,
  selectInitialTracks,
  selectSubtitleOnAudioSwitch,
} from './src/utils/playerTrackSelection.ts';
import { findExternalSubtitles } from './electron/subtitles.ts';
import { isAllowedSignsLanguage, isTopSignsCandidate } from './electron/assSignsExtractor.ts';
import { resolveNotificationActionMeta } from './src/types/notifications.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('================================================================');
console.log('  PLAYER TRACK DEFAULTS & NOTIFICATION ACTION ROUTING TESTS     ');
console.log('================================================================');

const makeSampleMeta = () => ({
  audioTracks: [
    { index: 1, audioIndex: 0, language: 'jpn', languageName: 'Japanese', codec: 'flac', title: 'Japanese Original', isDefault: true },
    { index: 2, audioIndex: 1, language: 'eng', languageName: 'English', codec: 'aac', title: 'English Dub', isDefault: false },
    { index: 3, audioIndex: 2, language: 'rus', languageName: 'Russian', codec: 'aac', title: 'Russian (AniLibria)', isDefault: false },
  ],
  subtitleTracks: [
    { id: 'emb-4', index: 4, type: 'embedded', language: 'eng', languageName: 'English', codec: 'ass', title: 'English Full Dialogue', isForced: false, isDefault: true, isSigns: false, isDubtitle: false },
    { id: 'emb-5', index: 5, type: 'embedded', language: 'eng', languageName: 'English', codec: 'ass', title: 'English [SDH / Dubtitles]', isForced: false, isDefault: false, isSigns: false, isDubtitle: true },
    { id: 'emb-6', index: 6, type: 'embedded', language: 'eng', languageName: 'English', codec: 'ass', title: 'English Signs & Songs', isForced: true, isDefault: false, isSigns: true, isDubtitle: false },
    { id: 'emb-7', index: 7, type: 'embedded', language: 'rus', languageName: 'Russian', codec: 'ass', title: 'Russian Dialogue', isForced: false, isDefault: false, isSigns: false, isDubtitle: false },
    { id: 'emb-8', index: 8, type: 'embedded', language: 'rus', languageName: 'Russian', codec: 'ass', title: 'Russian SDH', isForced: false, isDefault: false, isSigns: false, isDubtitle: true },
    { id: 'emb-9', index: 9, type: 'embedded', language: 'rus', languageName: 'Russian', codec: 'ass', title: 'Russian Signs & Songs', isForced: true, isDefault: false, isSigns: true, isDubtitle: false },
  ],
});

test('1.1 canonicalizeTrackLanguage normalizes ISO codes, regions, titles, and filenames', () => {
  assert.equal(canonicalizeTrackLanguage('eng'), 'en');
  assert.equal(canonicalizeTrackLanguage('en-US'), 'en');
  assert.equal(canonicalizeTrackLanguage('jpn'), 'ja');
  assert.equal(canonicalizeTrackLanguage('rus'), 'ru');
  assert.equal(canonicalizeTrackLanguage('ru-RU'), 'ru');
  assert.equal(canonicalizeTrackLanguage('ger'), 'de');
  assert.equal(canonicalizeTrackLanguage('deu'), 'de');
  assert.equal(canonicalizeTrackLanguage('fre'), 'fr');
  assert.equal(canonicalizeTrackLanguage('zho'), 'zh');
  assert.equal(canonicalizeTrackLanguage('und', 'Russian Dub'), 'ru');
  assert.equal(canonicalizeTrackLanguage('und', 'Deutsch'), 'de');
  assert.equal(canonicalizeTrackLanguage('und', 'External', 'Show - 01.rus.signs.ass'), 'ru');
  assert.equal(canonicalizeTrackLanguage('zxx', 'Signs & Songs'), null);
});

test('1.2 resolveEffectivePlaybackPreferences follows Downloads defaults when set to auto and supports overrides', () => {
  const autoFromRu = resolveEffectivePlaybackPreferences({
    preferredTorrentAudioLanguages: ['ru', 'ja'],
    preferredTorrentSubtitleLanguages: ['ru', 'en'],
    defaultAudioLanguage: 'auto',
    defaultSubtitleLanguage: 'auto',
    defaultSubtitleType: 'auto',
    defaultTopSubMode: 'auto',
  });
  assert.deepEqual(autoFromRu.audioLanguages, ['ru', 'ja']);
  assert.deepEqual(autoFromRu.subtitleLanguages, ['ru', 'en']);
  assert.equal(autoFromRu.preferOriginalAudio, false);
  assert.equal(autoFromRu.subtitlesOffByDefault, false);
  assert.ok(autoFromRu.signsAllowedLanguages.includes('rus'));
  assert.ok(autoFromRu.signsAllowedLanguages.includes('ru'));

  const originalOffSubs = resolveEffectivePlaybackPreferences({
    preferredTorrentAudioLanguages: ['en'],
    preferredTorrentSubtitleLanguages: ['en'],
    defaultAudioLanguage: 'original',
    defaultSubtitleLanguage: 'off',
    defaultSubtitleType: 'dialogue',
    defaultTopSubMode: 'off',
  });
  assert.equal(originalOffSubs.preferOriginalAudio, true);
  assert.deepEqual(originalOffSubs.audioLanguages, ['ja']);
  assert.equal(originalOffSubs.subtitlesOffByDefault, true);
  assert.deepEqual(originalOffSubs.subtitleLanguages, []);
  assert.equal(originalOffSubs.topSubMode, 'off');
  assert.ok(originalOffSubs.signsAllowedLanguages.includes('eng'));
});

test('1.3 selectInitialTracks picks Russian audio, Russian subtitles, and Russian signs when configured', () => {
  const meta = makeSampleMeta();
  const sel = selectInitialTracks(meta, null, {
    defaultAudioLanguage: 'ru',
    defaultSubtitleLanguage: 'ru',
    defaultSubtitleType: 'dialogue',
    defaultTopSubMode: 'always',
  });
  assert.equal(sel.audioIndex, 2);
  assert.equal(sel.mainSubtitleTrackId, 'emb-7');
  assert.equal(sel.topSubtitleTrackId, 'emb-9');
  assert.equal(sel.topSubEnabled, true);
  assert.equal(sel.explicitTopSubOff, false);
});

test('1.4 selectInitialTracks honors subtitleType = auto (dub -> dubtitles, JP -> dialogue) and explicit types', () => {
  const meta = makeSampleMeta();

  const dubAuto = selectInitialTracks(meta, null, {
    defaultAudioLanguage: 'en',
    defaultSubtitleLanguage: 'en',
    defaultSubtitleType: 'auto',
  });
  assert.equal(dubAuto.audioIndex, 1);
  assert.equal(dubAuto.mainSubtitleTrackId, 'emb-5');
  assert.equal(dubAuto.topSubtitleTrackId, 'emb-6');
  assert.equal(dubAuto.topSubEnabled, true);

  const jpAuto = selectInitialTracks(meta, null, {
    defaultAudioLanguage: 'original',
    defaultSubtitleLanguage: 'en',
    defaultSubtitleType: 'auto',
    defaultTopSubMode: 'auto',
  });
  assert.equal(jpAuto.audioIndex, 0);
  assert.equal(jpAuto.mainSubtitleTrackId, 'emb-4');
  // Main sub title has "Full Dialogue" so auto mode starts top signs muted unless mode === always
  assert.equal(jpAuto.topSubtitleTrackId, 'emb-6');
  assert.equal(jpAuto.topSubEnabled, false);

  const jpAlwaysTop = selectInitialTracks(meta, null, {
    defaultAudioLanguage: 'original',
    defaultSubtitleLanguage: 'en',
    defaultSubtitleType: 'auto',
    defaultTopSubMode: 'always',
  });
  assert.equal(jpAlwaysTop.topSubtitleTrackId, 'emb-6');
  assert.equal(jpAlwaysTop.topSubEnabled, true);

  const jpDubtitlesForced = selectInitialTracks(meta, null, {
    defaultAudioLanguage: 'original',
    defaultSubtitleLanguage: 'en',
    defaultSubtitleType: 'dubtitles',
  });
  assert.equal(jpDubtitlesForced.mainSubtitleTrackId, 'emb-5');

  const subsOffTopOff = selectInitialTracks(meta, null, {
    defaultAudioLanguage: 'en',
    defaultSubtitleLanguage: 'off',
    defaultSubtitleType: 'off',
    defaultTopSubMode: 'off',
  });
  assert.equal(subsOffTopOff.mainSubtitleTrackId, null);
  assert.equal(subsOffTopOff.topSubtitleTrackId, null);
  assert.equal(subsOffTopOff.topSubEnabled, false);
  assert.equal(subsOffTopOff.explicitTopSubOff, true);
});

test('1.5 selectInitialTracks v2 SeasonPreference recovers shifted audio/subtitle indices across episodes', () => {
  // Episode 2 swaps Russian audio from index 2 -> 0 and shifts subtitle IDs
  const ep2Meta = {
    audioTracks: [
      { index: 1, audioIndex: 0, language: 'rus', languageName: 'Russian', codec: 'aac', title: 'Russian (AniLibria)', isDefault: false },
      { index: 2, audioIndex: 1, language: 'jpn', languageName: 'Japanese', codec: 'flac', title: 'Japanese Original', isDefault: true },
    ],
    subtitleTracks: [
      { id: 'emb-10', index: 10, type: 'embedded', language: 'eng', languageName: 'English', codec: 'ass', title: 'English Dialogue', isForced: false, isDefault: false, isSigns: false, isDubtitle: false },
      { id: 'emb-11', index: 11, type: 'embedded', language: 'rus', languageName: 'Russian', codec: 'ass', title: 'Russian SDH', isForced: false, isDefault: false, isSigns: false, isDubtitle: true },
      { id: 'emb-12', index: 12, type: 'embedded', language: 'rus', languageName: 'Russian', codec: 'ass', title: 'Russian Dialogue', isForced: false, isDefault: false, isSigns: false, isDubtitle: false },
      { id: 'emb-13', index: 13, type: 'embedded', language: 'rus', languageName: 'Russian', codec: 'ass', title: 'Russian Signs', isForced: true, isDefault: false, isSigns: true, isDubtitle: false },
    ],
  };

  const seasonPrefV2 = {
    schemaVersion: 2,
    preferredAudioLanguage: 'rus',
    preferredAudioIndex: 1, // shifted! index 1 in ep2 is Japanese, but saved language is 'rus'
    mainSubtitleTrackId: 'emb-8', // old ep1 track ID no longer exists in ep2
    mainSubtitleLanguage: 'rus',
    mainSubtitleType: 'dubtitles',
    topSubtitleTrackId: 'emb-9', // old signs ID
    topSubtitleLanguage: 'rus',
    topSubEnabled: true,
    subSyncOffset: 0,
  };

  const recovered = selectInitialTracks(ep2Meta, seasonPrefV2, {
    defaultAudioLanguage: 'en',
    defaultSubtitleLanguage: 'en',
  });
  assert.equal(recovered.audioIndex, 0, 'Recovers Russian audio despite track index shift');
  assert.equal(recovered.mainSubtitleTrackId, 'emb-11', 'Recovers Russian SDH dubtitle despite stream renumbering');
  assert.equal(recovered.topSubtitleTrackId, 'emb-13', 'Recovers Russian signs track');
  assert.equal(recovered.topSubEnabled, true);

  // Explicit null in SeasonPreference always stays null
  const explicitNullPref = {
    schemaVersion: 2,
    preferredAudioLanguage: 'eng',
    preferredAudioIndex: 1,
    mainSubtitleTrackId: null,
    mainSubtitleLanguage: null,
    mainSubtitleType: 'off',
    topSubtitleTrackId: null,
    topSubtitleLanguage: null,
    topSubEnabled: false,
    subSyncOffset: 0,
  };
  const keptOff = selectInitialTracks(ep2Meta, explicitNullPref, {
    defaultSubtitleLanguage: 'ru',
    defaultSubtitleType: 'dialogue',
    defaultTopSubMode: 'always',
  });
  assert.equal(keptOff.mainSubtitleTrackId, null);
  assert.equal(keptOff.topSubtitleTrackId, null);
  assert.equal(keptOff.explicitTopSubOff, true);
});

test('1.6 selectInitialTracks preserves legacy v1 SeasonPreference index lookup', () => {
  const meta = makeSampleMeta();
  const legacyPref = {
    preferredAudioLanguage: 'eng', // v1 hardcoded field
    preferredAudioIndex: 2, // user had chosen track 2 (Russian)
    mainSubtitleTrackId: 'emb-7',
    topSubtitleTrackId: null,
    topSubEnabled: false,
    subSyncOffset: 0,
  };
  const sel = selectInitialTracks(meta, legacyPref, { defaultAudioLanguage: 'en' });
  assert.equal(sel.audioIndex, 2);
  assert.equal(sel.mainSubtitleTrackId, 'emb-7');
  assert.equal(sel.explicitTopSubOff, true);
});

test('1.7 selectSubtitleOnAudioSwitch adapts subtitles cleanly for non-English & respects Off', () => {
  const meta = makeSampleMeta();
  const jpAudio = meta.audioTracks[0];
  const ruAudio = meta.audioTracks[2];

  assert.equal(
    selectSubtitleOnAudioSwitch(ruAudio, meta.subtitleTracks, 'emb-7', {
      defaultSubtitleLanguage: 'ru',
      defaultSubtitleType: 'auto',
    }),
    'emb-8',
    'Switching to Russian dub in auto mode picks Russian SDH'
  );

  assert.equal(
    selectSubtitleOnAudioSwitch(jpAudio, meta.subtitleTracks, 'emb-8', {
      defaultSubtitleLanguage: 'ru',
      defaultSubtitleType: 'auto',
    }),
    'emb-7',
    'Switching to Japanese original in auto mode picks Russian Full Dialogue'
  );

  assert.equal(
    selectSubtitleOnAudioSwitch(ruAudio, meta.subtitleTracks, 'emb-7', {
      defaultSubtitleLanguage: 'ru',
      defaultSubtitleType: 'dialogue',
    }),
    'emb-7',
    'Explicit dialogue mode stays on Full Dialogue even on dub audio'
  );

  assert.equal(
    selectSubtitleOnAudioSwitch(jpAudio, meta.subtitleTracks, null, {
      defaultSubtitleLanguage: 'off',
      defaultSubtitleType: 'off',
    }),
    null,
    'Off preference keeps subtitles null on audio switch'
  );
});

test('1.8 buildDefaultSettingsFromSelection captures active tracks accurately', () => {
  const meta = makeSampleMeta();
  const patch1 = buildDefaultSettingsFromSelection(meta.audioTracks[0], meta.subtitleTracks[3], 'emb-9', true, false);
  assert.deepEqual(patch1, {
    defaultAudioLanguage: 'original',
    defaultSubtitleLanguage: 'ru',
    defaultSubtitleType: 'dialogue',
    defaultTopSubMode: 'always',
  });

  const patch2 = buildDefaultSettingsFromSelection(meta.audioTracks[2], null, null, false, true);
  assert.deepEqual(patch2, {
    defaultAudioLanguage: 'ru',
    defaultSubtitleLanguage: 'off',
    defaultSubtitleType: 'off',
    defaultTopSubMode: 'off',
  });

  assert.equal(classifySubtitleTrackType(meta.subtitleTracks[1]), 'dubtitles');
});

test('2.1 findExternalSubtitles & isTopSignsCandidate detect non-English external/embedded subs while keeping default English strictness', () => {
  const found = findExternalSubtitles('C:\\Anime\\Frieren - 01.mkv', [
    'Frieren - 01.ru.srt',
    'Frieren - 01.rus.signs.ass',
    'Frieren - 01.de-DE.forced.srt',
    'Frieren - 01.whisper.srt',
  ]);
  const ruSrt = found.find((f) => f.fileName === 'Frieren - 01.ru.srt');
  const ruSigns = found.find((f) => f.fileName === 'Frieren - 01.rus.signs.ass');
  const deForced = found.find((f) => f.fileName === 'Frieren - 01.de-DE.forced.srt');
  assert.equal(ruSrt?.language, 'rus');
  assert.equal(ruSigns?.language, 'rus');
  assert.equal(ruSigns?.isSigns, true);
  assert.equal(deForced?.language, 'deu');
  assert.equal(deForced?.isForced, true);

  // Default 2-arg call keeps existing English-only behavior
  assert.equal(isAllowedSignsLanguage('rus'), false);
  assert.equal(isTopSignsCandidate({ id: '9', language: 'rus', title: 'Russian Signs', isSigns: true }, 'main'), false);

  // Explicit allowedLanguages enables preferred language signs while still rejecting unrelated tracks
  assert.equal(isAllowedSignsLanguage('rus', ['ru', 'rus']), true);
  assert.equal(isTopSignsCandidate({ id: '9', language: 'rus', title: 'Russian Signs', isSigns: true }, 'main', ['ru', 'rus']), true);
  assert.equal(isTopSignsCandidate({ id: '9', language: 'jpn', title: 'Japanese Signs', isSigns: true }, 'main', ['ru', 'rus']), false);
});

test('3.1 resolveNotificationActionMeta assigns click actions across all notification kinds and legacy shapes', () => {
  assert.deepEqual(
    resolveNotificationActionMeta({
      id: '1', kind: 'follow', title: 'Saved to Library · Following', message: 'msg', createdAt: 1, read: false, anilistId: 10,
    }),
    { actionType: 'open-library', actionLabel: 'View Following' }
  );

  assert.deepEqual(
    resolveNotificationActionMeta({
      id: '1b', kind: 'follow', title: 'Saved to Library · Favourites', message: 'msg', createdAt: 1, read: false, actionType: 'open-library', libraryFilter: 'favourites',
    }),
    { actionType: 'open-library', actionLabel: 'View Favourites' }
  );

  assert.deepEqual(
    resolveNotificationActionMeta({
      id: '2', kind: 'download', state: 'completed', title: 'Download complete', message: 'msg', createdAt: 1, read: false, anilistId: 10,
    }),
    { actionType: 'open-anime', actionLabel: 'Open Anime' }
  );

  assert.deepEqual(
    resolveNotificationActionMeta({
      id: '3', kind: 'download', state: 'downloading', title: 'Downloading', message: 'msg', createdAt: 1, read: false, anilistId: 10,
    }),
    { actionType: 'open-downloads', actionLabel: 'Downloads' }
  );

  assert.deepEqual(
    resolveNotificationActionMeta({
      id: '4', kind: 'download', state: 'error', title: 'Download failed', message: 'msg', createdAt: 1, read: false,
    }),
    { actionType: 'open-downloads', actionLabel: 'View Error' }
  );

  assert.deepEqual(
    resolveNotificationActionMeta({
      id: '5', kind: 'airing', title: "Auto-download couldn't find episode", message: 'msg', createdAt: 1, read: false, anilistId: 10, episode: 4,
    }),
    { actionType: 'manual-pick', actionLabel: 'Choose Release' }
  );

  assert.deepEqual(
    resolveNotificationActionMeta({
      id: '6', kind: 'airing', title: 'New episode aired', message: 'msg', createdAt: 1, read: false, anilistId: 10, episode: 5,
    }),
    { actionType: 'find-episode', actionLabel: 'Find EP 5' }
  );

  assert.deepEqual(
    resolveNotificationActionMeta({
      id: '7', kind: 'whisper', title: 'Episode Subtitles Ready', message: 'msg', createdAt: 1, read: false, filePath: 'D:\\Anime\\ep01.mkv',
    }),
    { actionType: 'play-episode', actionLabel: 'Watch' }
  );

  assert.deepEqual(
    resolveNotificationActionMeta({
      id: '8', kind: 'whisper', title: 'Whisper Batch Completed', message: 'msg', createdAt: 1, read: false,
    }),
    { actionType: 'open-whisper', actionLabel: 'Whisper Studio' }
  );
});

console.log('\n================================================================');
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log('================================================================');
