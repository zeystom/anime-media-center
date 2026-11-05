/**
 * Phase 4 offline test suite: Documents auto-backup + watchlist export/import.
 *
 * Covers (all offline, temp dirs only):
 *   - electron/watchlistIO.ts: status mapping (UserListStatus <-> MAL),
 *     buildMalXml (+ XML-escaping, idMal filtering), parseMalXml (realistic
 *     MAL export fixture, unmappable statuses, malformed input),
 *     buildWatchlistJson / applyWatchlistJson round-trip,
 *     buildMalImportRecord merge policy (incoming wins on higher progress or
 *     missing entry, synthetic anilistId for MAL-only entries).
 *   - electron/userDataBackup.ts: payload build, atomic writeBackup /
 *     readBackup round-trip + corrupt/missing/wrong-format rejection,
 *     getBackupFilePath path shape + AnimeCenter mkdir, and the sync
 *     wrappers (syncBackupNow / getBackupStatus / detectRestoreState /
 *     restoreFromBackup) plus exportWatchlist / importWatchlist against
 *     registered fake services (the real singletons require electron).
 *   - XML structure verification: buildMalXml output parses back through
 *     parseMalXml with identical fields.
 *
 * Run: node test-watchlist-io.js
 */
import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  MAL_ONLY_ANILIST_ID_BASE,
  applyWatchlistJson,
  buildMalImportRecord,
  buildMalXml,
  buildWatchlistJson,
  exportWatchlist,
  importWatchlist,
  mapStatusFromMal,
  mapStatusToMal,
  parseMalXml,
  parseMalXmlDetailed,
} from './electron/watchlistIO.ts'
import {
  buildBackupPayload,
  getBackupFilePath,
  readBackup,
  registerMainServices,
  syncBackupNow,
  getBackupStatus,
  detectRestoreState,
  restoreFromBackup,
  writeBackup,
} from './electron/userDataBackup.ts'

let passedTests = 0
let failedTests = 0

async function runTest(name, fn) {
  try {
    await fn()
    passedTests++
    console.log(`  [PASS] ${name}`)
  } catch (err) {
    failedTests++
    console.error(`  [FAIL] ${name}: ${err.message}`)
    process.exitCode = 1
  }
}

console.log('================================================================')
console.log('   PHASE 4 VERIFICATION: DOCUMENTS BACKUP + WATCHLIST I/O       ')
console.log('================================================================\n')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const NOW = 1700000000000

const progressA = {
  filePath: 'C:/anime/Show/S01E01.mkv',
  folderPath: 'C:/anime/Show',
  fileName: 'S01E01.mkv',
  episodeNumber: 'S01E01',
  currentTime: 300.5,
  duration: 1425,
  lastWatchedAt: 1700000000000,
  completed: false,
}

const ruleA = {
  preferredAudioLanguage: 'jpn',
  preferredAudioIndex: 1,
  mainSubtitleTrackId: 'ext-abc',
  topSubtitleTrackId: null,
  topSubEnabled: true,
  subSyncOffset: 0.5,
}

const entryWatch = {
  anilistId: 21,
  idMal: 21,
  titleSnapshot: 'One <Piece> & "Co"',
  status: 'watching',
  score: 9,
  progress: 12,
  updatedAt: NOW,
}

const entryNoMal = {
  anilistId: 100,
  idMal: null,
  titleSnapshot: 'No MAL Link',
  status: 'planning',
  score: null,
  progress: 0,
  updatedAt: NOW + 1000,
}

const MAL_EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<myanimelist>
  <myinfo><user_export_type>1</user_export_type><user_id>0</user_id><user_name>tester</user_name></myinfo>
  <anime>
    <series_animedb_id>1535</series_animedb_id>
    <series_title>Death Note</series_title>
    <series_type></series_type>
    <series_episodes>37</series_episodes>
    <my_id>0</my_id>
    <my_watched_episodes>37</my_watched_episodes>
    <my_start_date>0000-00-00</my_start_date>
    <my_finish_date>0000-00-00</my_finish_date>
    <my_rated></my_rated>
    <my_score>9</my_score>
    <my_storage></my_storage>
    <my_storage_value>0</my_storage_value>
    <my_comments><![CDATA[]]></my_comments>
    <my_times_watched>1</my_times_watched>
    <my_status>Completed</my_status>
    <my_rewatching>0</my_rewatching>
    <my_rewatching_ep>0</my_rewatching_ep>
    <my_tags></my_tags>
  </anime>
  <anime>
    <series_animedb_id>21</series_animedb_id>
    <series_title>ONE PIECE</series_title>
    <series_type></series_type>
    <series_episodes></series_episodes>
    <my_id>0</my_id>
    <my_watched_episodes>0</my_watched_episodes>
    <my_start_date>0000-00-00</my_start_date>
    <my_finish_date>0000-00-00</my_finish_date>
    <my_rated></my_rated>
    <my_score>0</my_score>
    <my_storage></my_storage>
    <my_storage_value>0</my_storage_value>
    <my_comments><![CDATA[]]></my_comments>
    <my_times_watched>0</my_times_watched>
    <my_status>Plan to Watch</my_status>
    <my_rewatching>0</my_rewatching>
    <my_rewatching_ep>0</my_rewatching_ep>
    <my_tags></my_tags>
  </anime>
  <anime>
    <series_animedb_id>11061</series_animedb_id>
    <series_title>Hunter x Hunter (2011)</series_title>
    <my_watched_episodes>10</my_watched_episodes>
    <my_score>10</my_score>
    <my_status>Bogus State</my_status>
  </anime>
  <anime>
    <series_animedb_id>16498</series_animedb_id>
    <series_title>Shingeki no Kyojin</series_title>
    <my_watched_episodes>1</my_watched_episodes>
    <my_score>8</my_score>
  </anime>
  <anime>
    <series_animedb_id>not-a-number</series_animedb_id>
    <series_title>Broken Id</series_title>
    <my_watched_episodes>2</my_watched_episodes>
    <my_status>Watching</my_status>
  </anime>
</myanimelist>`

// ---------------------------------------------------------------------------
// Shared temp dirs + fake main-process services for the wrapper tests
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amc-watchlist-test-'))
const tmpDocs = path.join(tmpRoot, 'Documents')
const tmpUserData = path.join(tmpRoot, 'userData')
fs.mkdirSync(tmpDocs, { recursive: true })
fs.mkdirSync(tmpUserData, { recursive: true })

const fakeSettings = {
  ffmpegPath: 'C:/bin/ffmpeg.exe',
  whisperPath: '',
  defaultLibraryRoot: 'C:/anime',
  libraryFolders: ['C:/anime'],
  autoPlayNext: true,
  subtitlesFontSize: 38,
}

const fakeStorage = {
  settings: null,
  history: null,
  rules: null,
  historyFile: path.join(tmpUserData, 'history.json'),
  getSettings() {
    return this.settings
  },
  getAllPlaybackProgress() {
    return this.history
  },
  getAllSeasonRules() {
    return this.rules
  },
  mergePlaybackProgress(records) {
    let n = 0
    for (const [key, incoming] of Object.entries(records || {})) {
      const existing = this.history[key]
      if (!existing || incoming.lastWatchedAt >= existing.lastWatchedAt) {
        this.history[key] = incoming
        n++
      }
    }
    return n
  },
  mergeSeasonRules(rules) {
    let n = 0
    for (const [key, pref] of Object.entries(rules || {})) {
      this.rules[key] = pref
      n++
    }
    return n
  },
  getHistoryFilePath() {
    return this.historyFile
  },
  flushHistory() {},
}

const fakeLibrary = {
  entries: null,
  getAll() {
    return this.entries
  },
  mergeEntries(incoming) {
    let n = 0
    for (const [key, entry] of Object.entries(incoming || {})) {
      const id = Math.trunc(Number(entry.anilistId ?? key))
      const existing = this.entries[id]
      if (!existing || entry.updatedAt > existing.updatedAt) {
        this.entries[id] = existing ? { ...existing, ...entry } : entry
        n++
      }
    }
    return n
  },
  flush() {},
}

registerMainServices({
  storage: fakeStorage,
  userLibrary: fakeLibrary,
  resolveDocumentsDir: () => tmpDocs,
})

function resetFakes() {
  fakeStorage.settings = JSON.parse(JSON.stringify(fakeSettings))
  fakeStorage.history = { [progressA.filePath]: { ...progressA } }
  fakeStorage.rules = { 'C:/anime/Show': { ...ruleA } }
  fakeLibrary.entries = {
    21: { ...entryWatch },
    100: { ...entryNoMal },
  }
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

// ---------------------------------------------------------------------------
// Group 1: status mapping
// ---------------------------------------------------------------------------
console.log('--- TEST GROUP 1: UserListStatus <-> MAL status mapping ---')

await runTest('1.1 mapStatusToMal maps all five statuses to MAL strings', () => {
  assert.strictEqual(mapStatusToMal('watching'), 'Watching')
  assert.strictEqual(mapStatusToMal('completed'), 'Completed')
  assert.strictEqual(mapStatusToMal('paused'), 'On-Hold')
  assert.strictEqual(mapStatusToMal('dropped'), 'Dropped')
  assert.strictEqual(mapStatusToMal('planning'), 'Plan to Watch')
})

await runTest('1.2 mapStatusToMal/mapStatusFromMal round-trips every status', () => {
  for (const status of ['watching', 'completed', 'planning', 'dropped', 'paused']) {
    assert.strictEqual(mapStatusFromMal(mapStatusToMal(status)), status, `round-trip failed for ${status}`)
  }
})

await runTest('1.3 mapStatusFromMal is tolerant of separators, case and whitespace', () => {
  assert.strictEqual(mapStatusFromMal('plan_to_watch'), 'planning')
  assert.strictEqual(mapStatusFromMal('Plan to Watch'), 'planning')
  assert.strictEqual(mapStatusFromMal('PLAN_TO_WATCH'), 'planning')
  assert.strictEqual(mapStatusFromMal('on_hold'), 'paused')
  assert.strictEqual(mapStatusFromMal('On-Hold'), 'paused')
  assert.strictEqual(mapStatusFromMal('  watching '), 'watching')
  assert.strictEqual(mapStatusFromMal('completed'), 'completed')
  assert.strictEqual(mapStatusFromMal('Dropped'), 'dropped')
})

await runTest('1.4 mapStatusFromMal returns null for garbage input', () => {
  assert.strictEqual(mapStatusFromMal('garbage'), null)
  assert.strictEqual(mapStatusFromMal('Currently Watching'), null)
  assert.strictEqual(mapStatusFromMal(''), null)
  assert.strictEqual(mapStatusFromMal(null), null)
  assert.strictEqual(mapStatusFromMal(undefined), null)
  assert.strictEqual(mapStatusFromMal(42), null)
})

// ---------------------------------------------------------------------------
// Group 2: buildMalXml
// ---------------------------------------------------------------------------
console.log('\n--- TEST GROUP 2: buildMalXml structure and escaping ---')

await runTest('2.1 Header, myinfo block and anime filtering (only idMal entries)', () => {
  const xml = buildMalXml([entryWatch, entryNoMal, entryPausedB()])
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><myanimelist><myinfo><user_export_type>1</user_export_type></myinfo>'), 'header mismatch')
  assert.ok(xml.endsWith('</myanimelist>'), 'must close myanimelist')
  assert.strictEqual(countOccurrences(xml, '<anime>'), 2, 'entries without idMal must be excluded')
  assert.ok(xml.includes('<series_animedb_id>21</series_animedb_id>'), 'idMal 21 missing')
  assert.ok(xml.includes('<series_animedb_id>5</series_animedb_id>'), 'idMal 5 missing')
  assert.ok(!xml.includes('No MAL Link'), 'entry without idMal must not appear')
})

await runTest('2.2 Titles are XML-escaped', () => {
  const xml = buildMalXml([entryWatch])
  assert.ok(xml.includes('<series_title>One &lt;Piece&gt; &amp; &quot;Co&quot;</series_title>'), 'title not escaped correctly')
  assert.ok(!xml.includes('<series_title>One <Piece>'), 'raw special characters leaked into XML')
})

await runTest('2.3 Status, score, progress and full element structure', () => {
  const xml = buildMalXml([entryWatch, entryPausedB()])
  assert.ok(xml.includes('<my_status>Watching</my_status>'), 'watching status not mapped')
  assert.ok(xml.includes('<my_status>On-Hold</my_status>'), 'paused status not mapped to On-Hold')
  assert.ok(xml.includes('<my_watched_episodes>12</my_watched_episodes>'), 'progress not written')
  assert.ok(xml.includes('<my_score>9</my_score>'), 'score not written')
  assert.ok(xml.includes('<my_score>0</my_score>'), 'null score must export as 0')
  for (const element of [
    '<series_type/>',
    '<series_episodes/>',
    '<my_id>0</my_id>',
    '<my_start_date>0000-00-00</my_start_date>',
    '<my_finish_date>0000-00-00</my_finish_date>',
    '<my_rated/>',
    '<my_storage/>',
    '<my_storage_value>0</my_storage_value>',
    '<my_comments><![CDATA[Exported by AnimeCenter]]></my_comments>',
    '<my_times_watched>0</my_times_watched>',
    '<my_rewatching>0</my_rewatching>',
    '<my_rewatching_ep>0</my_rewatching_ep>',
    '<my_tags></my_tags>',
  ]) {
    assert.ok(xml.includes(element), `missing required element: ${element}`)
  }
})

await runTest('2.4 Empty or absent entry list yields a valid (anime-less) document', () => {
  const empty = buildMalXml([])
  assert.ok(empty.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  assert.ok(empty.endsWith('</myanimelist>'))
  assert.ok(!empty.includes('<anime>'))
  assert.ok(!buildMalXml(undefined).includes('<anime>'), 'non-array input must not throw')
})

function entryPausedB() {
  return {
    anilistId: 5,
    idMal: 5,
    titleSnapshot: 'Paused Show',
    status: 'paused',
    score: null,
    progress: 3,
    updatedAt: NOW + 2000,
  }
}

// ---------------------------------------------------------------------------
// Group 3: parseMalXml
// ---------------------------------------------------------------------------
console.log('\n--- TEST GROUP 3: parseMalXml (realistic MAL export) ---')

await runTest('3.1 Parses a realistic MAL export with correct fields and types', () => {
  const entries = parseMalXml(MAL_EXPORT_XML)
  assert.strictEqual(entries.length, 2, `expected 2 mappable entries, got ${entries.length}`)
  assert.deepStrictEqual(entries[0], {
    idMal: 1535,
    title: 'Death Note',
    watchedEpisodes: 37,
    status: 'completed',
    score: 9,
  })
  assert.deepStrictEqual(entries[1], {
    idMal: 21,
    title: 'ONE PIECE',
    watchedEpisodes: 0,
    status: 'planning',
    score: 0,
  })
})

await runTest('3.2 Entries with invalid id or unmappable status are skipped and counted', () => {
  const { entries, skipped } = parseMalXmlDetailed(MAL_EXPORT_XML)
  assert.strictEqual(entries.length, 2)
  assert.strictEqual(skipped, 3, 'bogus status + missing status + non-numeric id must all be skipped')
})

await runTest('3.3 Malformed or empty XML degrades gracefully (no throw, empty result)', () => {
  assert.deepStrictEqual(parseMalXml('<myanimelist><anime><series_animedb_id>9</series_anime'), [])
  assert.deepStrictEqual(parseMalXml(''), [])
  assert.deepStrictEqual(parseMalXml('not xml at all'), [])
  assert.deepStrictEqual(parseMalXml(null), [])
})

// ---------------------------------------------------------------------------
// Group 4: XML round-trip (structure verification)
// ---------------------------------------------------------------------------
console.log('\n--- TEST GROUP 4: buildMalXml output parses back via parseMalXml ---')

await runTest('4.1 buildMalXml -> parseMalXml round-trip preserves fields', () => {
  const parsed = parseMalXml(buildMalXml([entryWatch, entryNoMal, entryPausedB()]))
  assert.strictEqual(parsed.length, 2, 'only idMal entries round-trip')
  assert.deepStrictEqual(parsed[0], {
    idMal: 21,
    title: 'One <Piece> & "Co"',
    watchedEpisodes: 12,
    status: 'watching',
    score: 9,
  })
  assert.deepStrictEqual(parsed[1], {
    idMal: 5,
    title: 'Paused Show',
    watchedEpisodes: 3,
    status: 'paused',
    score: 0,
  }, 'null score is exported as 0 (MAL unrated) so it parses back as 0')
})

// ---------------------------------------------------------------------------
// Group 5: buildWatchlistJson / applyWatchlistJson (pure, temp file payload)
// ---------------------------------------------------------------------------
console.log('\n--- TEST GROUP 5: AnimeCenter JSON watchlist payload build/apply ---')

await runTest('5.1 buildWatchlistJson produces a versioned payload without settings', () => {
  const payload = buildWatchlistJson({
    history: { [progressA.filePath]: progressA },
    seasonRules: { 'C:/anime/Show': ruleA },
    userLibrary: { 21: entryWatch },
  })
  assert.strictEqual(payload.format, 'animecenter-watchlist')
  assert.strictEqual(payload.version, 1)
  assert.strictEqual(typeof payload.exportedAt, 'number')
  assert.ok(payload.history && payload.seasonRules && payload.userLibrary)
  const empty = buildWatchlistJson({})
  assert.ok(!('history' in empty) && !('seasonRules' in empty) && !('userLibrary' in empty), 'empty deps must omit sections')
  assert.ok(!('settings' in payload) && !('settings' in empty), 'watchlist payload never carries settings')
})

await runTest('5.2 applyWatchlistJson round-trips a payload through a temp file', () => {
  const file = path.join(tmpRoot, 'payload-roundtrip.json')
  const payload = buildWatchlistJson({
    history: { [progressA.filePath]: progressA },
    seasonRules: { 'C:/anime/Show': ruleA },
    userLibrary: { 21: entryWatch },
  })
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8')
  const reloaded = JSON.parse(fs.readFileSync(file, 'utf-8'))

  const mergedHistory = {}
  const mergedRules = {}
  const mergedEntries = {}
  const counts = applyWatchlistJson(reloaded, {
    mergeHistory: (records) => {
      Object.assign(mergedHistory, records)
      return Object.keys(records).length
    },
    mergeSeasonRules: (rules) => {
      Object.assign(mergedRules, rules)
      return Object.keys(rules).length
    },
    mergeEntries: (entries) => {
      Object.assign(mergedEntries, entries)
      return Object.keys(entries).length
    },
  })

  assert.deepStrictEqual(counts, { history: 1, seasonRules: 1, userLibrary: 1 })
  assert.deepStrictEqual(mergedHistory[progressA.filePath], progressA)
  assert.deepStrictEqual(mergedRules['C:/anime/Show'], ruleA)
  assert.deepStrictEqual(mergedEntries['21'], entryWatch)
})

await runTest('5.3 applyWatchlistJson validates format and version strictly', () => {
  const deps = {
    mergeHistory: () => 1,
    mergeSeasonRules: () => 1,
    mergeEntries: () => 1,
  }
  assert.throws(() => applyWatchlistJson(null, deps), 'null payload must throw')
  assert.throws(() => applyWatchlistJson('nope', deps), 'string payload must throw')
  assert.throws(() => applyWatchlistJson({ format: 'other-thing', version: 1 }, deps), 'unknown format must throw')
  assert.throws(() => applyWatchlistJson({ format: 'animecenter-watchlist', version: 2 }, deps), 'unknown version must throw')
  assert.deepStrictEqual(
    applyWatchlistJson({ format: 'animecenter-watchlist', version: 1 }, deps),
    { history: 0, seasonRules: 0, userLibrary: 0 },
    'payload without sections applies nothing'
  )
  assert.deepStrictEqual(
    applyWatchlistJson(buildBackupPayload({ history: { a: progressA } }), deps),
    { history: 1, seasonRules: 0, userLibrary: 0 },
    'Documents backup payloads are accepted as an import source'
  )
})

// ---------------------------------------------------------------------------
// Group 6: buildMalImportRecord merge policy
// ---------------------------------------------------------------------------
console.log('\n--- TEST GROUP 6: buildMalImportRecord merge policy ---')

await runTest('6.1 Incoming wins when progress is higher (matched by idMal)', () => {
  const existing = {
    21: { ...entryWatch, progress: 3, score: null, status: 'watching', updatedAt: NOW - 5000 },
  }
  const record = buildMalImportRecord(
    [{ idMal: 21, title: 'Mal Title', watchedEpisodes: 12, status: 'completed', score: 9 }],
    existing,
    NOW
  )
  assert.deepStrictEqual(record[21], {
    anilistId: 21,
    idMal: 21,
    titleSnapshot: 'One <Piece> & "Co"',
    status: 'completed',
    score: 9,
    progress: 12,
    updatedAt: NOW,
  })
})

await runTest('6.2 Lower incoming progress keeps the local record but fills missing score', () => {
  const existing = {
    21: { ...entryWatch, progress: 12, score: null, status: 'completed', updatedAt: NOW },
  }
  const record = buildMalImportRecord(
    [{ idMal: 21, title: 'Ignored Title', watchedEpisodes: 1, status: 'watching', score: 0 }],
    existing,
    NOW
  )
  assert.deepStrictEqual(record, {}, 'no-change imports must not produce updates')

  const filled = buildMalImportRecord(
    [{ idMal: 21, title: 'Ignored Title', watchedEpisodes: 1, status: 'watching', score: 5 }],
    existing,
    NOW
  )
  assert.strictEqual(filled[21].progress, 12, 'progress must never regress')
  assert.strictEqual(filled[21].status, 'completed', 'status must stay when incoming progress is lower')
  assert.strictEqual(filled[21].titleSnapshot, 'One <Piece> & "Co"', 'local title wins for existing entries')
  assert.strictEqual(filled[21].score, 5, 'missing local score is filled from the MAL rating')
})

await runTest('6.3 Missing entries become MAL-only entries with a synthetic anilistId', () => {
  const record = buildMalImportRecord(
    [{ idMal: 1535, title: 'Death Note', watchedEpisodes: 37, status: 'completed', score: 9 }],
    {},
    NOW
  )
  const syntheticId = MAL_ONLY_ANILIST_ID_BASE + 1535
  assert.ok(record[syntheticId], `synthetic anilistId ${syntheticId} missing`)
  assert.deepStrictEqual(record[syntheticId], {
    anilistId: syntheticId,
    idMal: 1535,
    titleSnapshot: 'Death Note',
    status: 'completed',
    score: 9,
    progress: 37,
    updatedAt: NOW,
  })
  assert.strictEqual(record[syntheticId].anilistId - MAL_ONLY_ANILIST_ID_BASE, 1535)
})

await runTest('6.4 Existing entries match by idMal regardless of their anilistId key', () => {
  const existing = {
    77: { anilistId: 77, idMal: 21, titleSnapshot: 'AniList Title', status: 'watching', score: 8, progress: 3, updatedAt: NOW },
  }
  const record = buildMalImportRecord(
    [{ idMal: 21, title: 'Mal Title', watchedEpisodes: 6, status: 'watching', score: 0 }],
    existing,
    NOW
  )
  assert.ok(record[77], 'must merge into the AniList-keyed entry')
  assert.strictEqual(record[77].anilistId, 77)
  assert.strictEqual(record[77].progress, 6)
  assert.strictEqual(record[77].score, 8, 'incoming unrated (0) keeps the local score')
  assert.strictEqual(record[77].titleSnapshot, 'AniList Title')
})

// ---------------------------------------------------------------------------
// Group 7: backup pure helpers
// ---------------------------------------------------------------------------
console.log('\n--- TEST GROUP 7: Documents backup payload + file I/O ---')

await runTest('7.1 buildBackupPayload includes only provided sections', () => {
  const empty = buildBackupPayload({})
  assert.strictEqual(empty.format, 'animecenter-backup')
  assert.strictEqual(empty.version, 1)
  assert.strictEqual(typeof empty.exportedAt, 'number')
  assert.strictEqual(Object.keys(empty).length, 3, 'empty deps must produce format/version/exportedAt only')

  const full = buildBackupPayload({ settings: { a: 1 }, history: { x: 1 } })
  assert.ok('settings' in full && 'history' in full)
  assert.ok(!('seasonRules' in full) && !('userLibrary' in full))
})

await runTest('7.2 writeBackup/readBackup round-trip through a temp file', () => {
  const file = path.join(tmpRoot, 'backup-roundtrip.json')
  const payload = buildBackupPayload({
    settings: fakeSettings,
    history: { [progressA.filePath]: progressA },
    seasonRules: { 'C:/anime/Show': ruleA },
    userLibrary: { 21: entryWatch },
  })
  writeBackup(file, payload)
  const restored = readBackup(file)
  assert.ok(restored, 'backup must be readable')
  assert.deepStrictEqual(restored, payload)
  assert.ok(!fs.readdirSync(tmpRoot).some((f) => f.endsWith('.tmp')), 'no temp files may leak')
})

await runTest('7.3 readBackup returns null for missing, corrupt or foreign files', () => {
  assert.strictEqual(readBackup(path.join(tmpRoot, 'does-not-exist.json')), null)

  const corrupt = path.join(tmpRoot, 'corrupt.json')
  fs.writeFileSync(corrupt, '{ not json at all', 'utf-8')
  assert.strictEqual(readBackup(corrupt), null, 'corrupt JSON must yield null')

  const foreign = path.join(tmpRoot, 'foreign.json')
  fs.writeFileSync(foreign, JSON.stringify({ format: 'some-other-app', version: 1 }), 'utf-8')
  assert.strictEqual(readBackup(foreign), null, 'wrong format field must yield null')

  const future = path.join(tmpRoot, 'future.json')
  fs.writeFileSync(future, JSON.stringify({ format: 'animecenter-backup', version: 2 }), 'utf-8')
  assert.strictEqual(readBackup(future), null, 'unknown version must yield null')
})

await runTest('7.4 getBackupFilePath creates <dir>/AnimeCenter and returns the right shape', () => {
  const base = 'C:\\tmp\\whatever'
  const tmpExisted = fs.existsSync('C:\\tmp')
  const filePath = getBackupFilePath(base)
  try {
    assert.strictEqual(path.basename(filePath), 'user_library_backup.json')
    assert.strictEqual(path.basename(path.dirname(filePath)), 'AnimeCenter')
    assert.ok(filePath.startsWith(base + path.sep), 'backup must live inside the given documents dir')
    assert.ok(fs.existsSync(path.join(base, 'AnimeCenter')), 'AnimeCenter directory must be created (mkdir -p)')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
    if (!tmpExisted) {
      try {
        fs.rmSync('C:\\tmp', { recursive: true, force: true })
      } catch {}
    }
  }
})

// ---------------------------------------------------------------------------
// Group 8: main-process wrappers against registered fake services
// ---------------------------------------------------------------------------
console.log('\n--- TEST GROUP 8: syncBackupNow / status / detect / restore / export / import ---')

await runTest('8.1 syncBackupNow writes a complete backup under <documents>/AnimeCenter', async () => {
  resetFakes()
  const res = syncBackupNow()
  assert.strictEqual(res.success, true, `syncBackupNow failed: ${res.error}`)
  assert.ok(res.path.startsWith(tmpDocs + path.sep), 'backup must be written under the documents dir')
  assert.strictEqual(path.basename(path.dirname(res.path)), 'AnimeCenter')

  const backup = readBackup(res.path)
  assert.ok(backup, 'written backup must validate')
  assert.deepStrictEqual(backup.settings, fakeSettings)
  assert.deepStrictEqual(backup.history, { [progressA.filePath]: progressA })
  assert.deepStrictEqual(backup.seasonRules, { 'C:/anime/Show': ruleA })
  const libKeys = Object.keys(backup.userLibrary)
  assert.deepStrictEqual(libKeys, ['21', '100'], 'userLibrary keys serialize as strings')
  assert.deepStrictEqual(backup.userLibrary['21'], entryWatch)
  assert.deepStrictEqual(backup.userLibrary['100'], entryNoMal)
})

await runTest('8.2 getBackupStatus reports existence, lastSyncedAt and size', () => {
  resetFakes()
  const res = syncBackupNow()
  assert.strictEqual(res.success, true)

  const status = getBackupStatus()
  assert.strictEqual(status.exists, true)
  assert.strictEqual(status.path, res.path, 'status path must match the backup path')
  assert.strictEqual(typeof status.lastSyncedAt, 'number')
  assert.ok(status.lastSyncedAt > 0)
  assert.ok(status.sizeBytes > 0)
})

await runTest('8.3 detectRestoreState flags a fresh userData install (no history.json)', () => {
  try {
    fs.rmSync(fakeStorage.historyFile, { force: true })
  } catch {}
  const state = detectRestoreState()
  assert.strictEqual(state.available, true, 'a backup exists from 8.1/8.2')
  assert.strictEqual(state.userDataHistoryMissing, true, 'history.json absent')
  assert.strictEqual(typeof state.exportedAt, 'number')

  fs.writeFileSync(fakeStorage.historyFile, JSON.stringify({}), 'utf-8')
  const state2 = detectRestoreState()
  assert.strictEqual(state2.userDataHistoryMissing, false, 'history.json present')
})

await runTest('8.4 restoreFromBackup merges history, season rules and user library', () => {
  resetFakes()
  const backupRes = syncBackupNow()
  assert.ok(backupRes.success)
  const backup = readBackup(backupRes.path)

  // Simulate a stale/fresh local state, then restore.
  fakeStorage.history = {}
  fakeStorage.rules = {}
  fakeLibrary.entries = {}

  const res = restoreFromBackup()
  assert.strictEqual(res.success, true, `restore failed: ${res.error}`)
  assert.deepStrictEqual(res.restored, { history: 1, seasonRules: 1, userLibrary: 2 })

  const restoredProgress = fakeStorage.history[progressA.filePath]
  assert.ok(restoredProgress, 'history record restored')
  assert.strictEqual(restoredProgress.lastWatchedAt, backup.history[progressA.filePath].lastWatchedAt)
  assert.deepStrictEqual(fakeStorage.rules['C:/anime/Show'], ruleA)
  assert.deepStrictEqual(fakeLibrary.entries[21], entryWatch)
  assert.deepStrictEqual(fakeLibrary.entries[100], entryNoMal)
})

await runTest('8.5 restoreFromBackup fails cleanly without a valid backup', () => {
  const backupPath = getBackupStatus().path
  fs.rmSync(backupPath, { force: true })
  const res = restoreFromBackup()
  assert.strictEqual(res.success, false)
  assert.ok(res.error && res.error.length > 0, 'a clear error must be reported')
  assert.strictEqual(res.restored, undefined)
})

await runTest('8.6 exportWatchlist(json) writes the watchlist payload and reports the count', async () => {
  resetFakes()
  const file = path.join(tmpRoot, 'export.json')
  const res = await exportWatchlist('json', file)
  assert.strictEqual(res.success, true, `export failed: ${res.error}`)
  assert.strictEqual(res.count, 2, 'all user library entries counted')

  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
  assert.strictEqual(parsed.format, 'animecenter-watchlist')
  assert.strictEqual(parsed.version, 1)
  assert.deepStrictEqual(parsed.history, { [progressA.filePath]: progressA })
  assert.deepStrictEqual(parsed.seasonRules, { 'C:/anime/Show': ruleA })
  assert.deepStrictEqual(parsed.userLibrary['21'], entryWatch)
  assert.ok(!('settings' in parsed))
})

await runTest('8.7 importWatchlist(json) round-trips into the live stores', async () => {
  const file = path.join(tmpRoot, 'export.json')
  resetFakes()
  fakeStorage.history = {}
  fakeStorage.rules = {}
  fakeLibrary.entries = {}

  const res = await importWatchlist(file)
  assert.strictEqual(res.success, true, `import failed: ${res.error}`)
  assert.strictEqual(res.imported, 4, '1 history + 1 season rule + 2 library entries')
  assert.strictEqual(res.skipped, 0)

  assert.deepStrictEqual(fakeStorage.history[progressA.filePath], progressA)
  assert.deepStrictEqual(fakeStorage.rules['C:/anime/Show'], ruleA)
  assert.deepStrictEqual(fakeLibrary.entries[21], entryWatch)
  assert.deepStrictEqual(fakeLibrary.entries[100], entryNoMal)
})

await runTest('8.8 exportWatchlist(mal-xml) only exports idMal entries and reports their count', async () => {
  resetFakes()
  const file = path.join(tmpRoot, 'export.xml')
  const res = await exportWatchlist('mal-xml', file)
  assert.strictEqual(res.success, true, `export failed: ${res.error}`)
  assert.strictEqual(res.count, 1, 'only the entry with idMal is exported')

  const xml = fs.readFileSync(file, 'utf-8')
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  assert.ok(xml.includes('<series_animedb_id>21</series_animedb_id>'))
  assert.ok(!xml.includes('No MAL Link'))
})

await runTest('8.9 exportWatchlist rejects unknown formats', async () => {
  const res = await exportWatchlist('csv', path.join(tmpRoot, 'out.csv'))
  assert.strictEqual(res.success, false)
  assert.ok(res.error && /format/i.test(res.error))
})

await runTest('8.10 importWatchlist(mal-xml) upserts synthetic + matched entries and skips garbage', async () => {
  const file = path.join(tmpRoot, 'import-mal.xml')
  resetFakes()
  fakeLibrary.entries = {
    21: { anilistId: 21, idMal: 21, titleSnapshot: 'One Piece', status: 'watching', score: 8, progress: 3, updatedAt: NOW },
  }

  fs.writeFileSync(
    file,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<myanimelist>',
      '<myinfo><user_export_type>1</user_export_type></myinfo>',
      '<anime><series_animedb_id>1535</series_animedb_id><series_title>Death Note</series_title><my_watched_episodes>37</my_watched_episodes><my_score>9</my_score><my_status>Completed</my_status></anime>',
      '<anime><series_animedb_id>21</series_animedb_id><series_title>ONE PIECE</series_title><my_watched_episodes>5</my_watched_episodes><my_score>0</my_score><my_status>Watching</my_status></anime>',
      '<anime><series_animedb_id>11061</series_animedb_id><series_title>Hunter x Hunter</series_title><my_watched_episodes>10</my_watched_episodes><my_status>Bogus State</my_status></anime>',
      '</myanimelist>',
    ].join('\n'),
    'utf-8'
  )

  const res = await importWatchlist(file)
  assert.strictEqual(res.success, true, `import failed: ${res.error}`)
  assert.strictEqual(res.imported, 2, '1 synthetic + 1 matched update')
  assert.strictEqual(res.skipped, 1, 'Bogus State status is unmappable')

  const synthetic = fakeLibrary.entries[MAL_ONLY_ANILIST_ID_BASE + 1535]
  assert.ok(synthetic, 'Death Note must become a MAL-only entry')
  assert.strictEqual(synthetic.anilistId, MAL_ONLY_ANILIST_ID_BASE + 1535)
  assert.strictEqual(synthetic.idMal, 1535)
  assert.strictEqual(synthetic.titleSnapshot, 'Death Note')
  assert.strictEqual(synthetic.status, 'completed')
  assert.strictEqual(synthetic.score, 9)
  assert.strictEqual(synthetic.progress, 37)
  assert.strictEqual(typeof synthetic.updatedAt, 'number')

  const matched = fakeLibrary.entries[21]
  assert.strictEqual(matched.progress, 5, 'matched entry takes the higher MAL progress')
  assert.strictEqual(matched.status, 'watching')
  assert.strictEqual(matched.score, 8, 'unrated MAL score (0) keeps the local score')
  assert.strictEqual(matched.titleSnapshot, 'One Piece', 'local title wins for existing entries')
})

await runTest('8.11 importWatchlist accepts a Documents backup payload as JSON source', async () => {
  const file = path.join(tmpRoot, 'as-backup.json')
  resetFakes()
  fakeStorage.history = {}
  fakeStorage.rules = {}
  fakeLibrary.entries = {}
  const payload = buildBackupPayload({
    history: { [progressA.filePath]: progressA },
    seasonRules: { 'C:/anime/Show': ruleA },
    userLibrary: { 21: entryWatch },
  })
  writeBackup(file, payload)

  const res = await importWatchlist(file)
  assert.strictEqual(res.success, true, `import failed: ${res.error}`)
  assert.strictEqual(res.imported, 3)
  assert.deepStrictEqual(fakeStorage.history[progressA.filePath], progressA)
  assert.deepStrictEqual(fakeLibrary.entries[21], entryWatch)
})

await runTest('8.12 importWatchlist fails cleanly on garbage and unusable files', async () => {
  const badJson = path.join(tmpRoot, 'bad.json')
  fs.writeFileSync(badJson, '{oops', 'utf-8')
  const resJson = await importWatchlist(badJson)
  assert.strictEqual(resJson.success, false)
  assert.ok(resJson.error && resJson.error.length > 0)

  const garbageXml = path.join(tmpRoot, 'garbage.xml')
  fs.writeFileSync(garbageXml, '<definitely><not>a watchlist</not></definitely>', 'utf-8')
  const resXml = await importWatchlist(garbageXml)
  assert.strictEqual(resXml.success, false, 'XML without importable entries must not report success')

  const foreignJson = path.join(tmpRoot, 'foreign-import.json')
  fs.writeFileSync(foreignJson, JSON.stringify({ format: 'unknown-app', version: 1 }), 'utf-8')
  const resForeign = await importWatchlist(foreignJson)
  assert.strictEqual(resForeign.success, false)
})

// ---------------------------------------------------------------------------
// Cleanup + summary
// ---------------------------------------------------------------------------
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
} catch {}

console.log('\n================================================================')
console.log(`   PHASE 4 TESTS: ${passedTests} / ${passedTests + failedTests} PASSED`)
console.log('================================================================')

if (failedTests > 0) {
  process.exit(1)
}
