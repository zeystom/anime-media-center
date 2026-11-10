/**
 * Offline tests for the simplified built-in torrent engine (electron/torrentEngine.ts).
 *
 * Runs under plain Node with NO network and NO real webtorrent: every case injects
 * a FakeClient through the optional `createClient` init dep.
 *
 * Coverage: consent gate, enable/disable lifecycle, queueing over the concurrency
 * limit, magnet vs .torrent URL, pause/resume/cancel (+ destroyStore), seeding
 * auto-stop, persistence (on add + shutdown) and silent resume of persisted jobs.
 */

import assert from 'assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const originalFetch = globalThis.fetch

const {
  initTorrentEngine,
  engineSetEnabled,
  engineAddDownload,
  enginePause,
  engineResume,
  engineCancel,
  engineGetState,
  engineShutdown,
  engineGetJobDiagnostics,
  sanitizePathSegment,
  extractInfoHashFromMagnet,
  extractTorrentMeta,
} = await import('./electron/torrentEngine.ts')

const HASH_A = 'a'.repeat(40)
const HASH_B = 'b'.repeat(40)
const HASH_C = 'c'.repeat(40)
const HASH_D = 'd'.repeat(40)
const HASH_E = 'e'.repeat(40)
const HASH_F = 'f'.repeat(40)

// ---- helpers ---------------------------------------------------------------

const PASS = []
const FAIL = []

async function expectCase(name, fn) {
  try {
    await fn()
    PASS.push(name)
    console.log('PASS -', name)
  } catch (err) {
    FAIL.push(`${name}: ${err && err.message}`)
    console.log('FAIL -', name, '-', err && err.message)
  }
}

async function until(fn, label, timeoutMs = 4000) {
  const start = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function makeSettings(overrides = {}) {
  return {
    ffmpegPath: '',
    whisperPath: '',
    defaultLibraryRoot: path.join(os.tmpdir(), 'ame-library'),
    autoPlayNext: false,
    subtitlesFontSize: 14,
    subtitlesOutline: true,
    hideDownloadingAnime: false,
    enableP2P: false,
    p2pConsentAcceptedAt: null,
    maxConcurrentDownloads: 2,
    seedMinutesAfterComplete: 0,
    libraryFolders: [path.join(os.tmpdir(), 'ame-library')],
    downloadTargetFolder: path.join(os.tmpdir(), 'ame-downloads'),
    ...overrides,
  }
}

function magnetItem(hash, extra = {}) {
  return {
    providerId: 'test-provider',
    providerName: 'Test Provider',
    title: 'Test Anime - 01',
    downloadUrl: `magnet:?xt=urn:btih:${hash}&dn=Test%20Anime`,
    sizeBytes: 100,
    seeders: 10,
    leechers: 2,
    pubDate: null,
    ...extra,
  }
}

function createFakeTorrent(infoHash, spec = {}) {
  const torrent = {
    infoHash,
    name: spec.name || 'Fake Torrent',
    files: (spec.files || []).map((entry) => {
      if (typeof entry === 'object' && entry !== null && typeof entry.select === 'function') {
        return entry
      }
      const name = typeof entry === 'string' ? entry : entry.name
      const file = {
        name,
        path: typeof entry === 'string' ? undefined : entry.path,
        length: 1,
        selected: true,
        select() { file.selected = true },
        deselect() { file.selected = false },
      }
      return file
    }),
    paused: false,
    done: false,
    destroyed: false,
    progress: 0,
    downloaded: 0,
    length: spec.length ?? 100,
    downloadSpeed: spec.downloadSpeed || 0,
    uploadSpeed: spec.uploadSpeed || 0,
    numPeers: 1,
    timeRemaining: 1000,
    magnetURI: `magnet:?xt=urn:btih:${infoHash}&dn=Fake`,
    destroyArgs: [],
    _listeners: {},
    on(event, listener) {
      (torrent._listeners[event] = torrent._listeners[event] || []).push(listener)
      return torrent
    },
    emit(event, ...args) {
      for (const listener of torrent._listeners[event] || []) listener(...args)
    },
    pause() {
      torrent.paused = true
    },
    resume() {
      torrent.paused = false
    },
    select() {},
    deselect() {},
    critical() {},
    destroy(opts, cb) {
      torrent.destroyArgs.push(opts || null)
      torrent.destroyed = true
      if (typeof opts === 'function') opts()
      else if (typeof cb === 'function') cb()
    },
  }
  return torrent
}

function createFakeClient() {
  const registry = new Map()
  const client = {
    registry,
    torrents: [],
    added: [],
    destroyCalls: [],
    destroyed: false,
    _listeners: {},
    on(event, listener) {
      (client._listeners[event] = client._listeners[event] || []).push(listener)
      return client
    },
    emit(event, ...args) {
      for (const listener of client._listeners[event] || []) {
        try {
          listener(...args)
        } catch (err) {
          console.error('[fakeClient] listener error:', err)
        }
      }
    },
    add(id, opts = {}) {
      let spec = {}
      let infoHash = 'unknown'
      if (typeof id === 'string') {
        const match = /urn:btih:([0-9a-z]{32,40})/i.exec(id)
        if (match) infoHash = match[1].toLowerCase()
        spec = registry.get(infoHash) || {}
        if (spec.infoHash) infoHash = spec.infoHash
      } else if (Buffer.isBuffer(id)) {
        spec = registry.get(id.toString('hex')) || {}
        infoHash = spec.infoHash || 'unknown'
      }
      const torrent = createFakeTorrent(infoHash, spec)
      client.torrents.push(torrent)
      client.added.push({ kind: 'magnet', opts })
      // Metadata "arrives" on the next microtask unless the test opts out.
      if (spec.autoReady !== false) {
        queueMicrotask(() => client.emit('torrent', torrent))
      }
      return torrent
    },
    destroy(cb) {
      client.destroyCalls.push(true)
      client.destroyed = true
      if (typeof cb === 'function') cb()
    },
  }
  return client
}

function latestTorrentOf(fake, hash) {
  return fake.torrents.filter((t) => t.infoHash === hash).pop()
}

function statusOf(hash) {
  const job = engineGetState().jobs.find((j) => j.infoHash === hash)
  return job ? job.status : undefined
}

/** Standard enabled setup; returns { persistDir, settings, fake, counters }. */
function setupEngine(settingsOverrides = {}) {
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-torrent-engine-'))
  const settings = makeSettings({ enableP2P: true, p2pConsentAcceptedAt: Date.now(), ...settingsOverrides })
  const fake = createFakeClient()
  const counters = { factoryCalls: 0, states: [] }
  initTorrentEngine({
    getSettings: () => settings,
    onState: (state) => counters.states.push(state),
    persistDir,
    createClient: () => {
      counters.factoryCalls += 1
      return fake
    },
  })
  return { persistDir, settings, fake, counters }
}

// ---- unit-ish sanity: sanitizing + hash extraction --------------------------

await expectCase('sanitizePathSegment strips Windows-unsafe characters', async () => {
  assert.strictEqual(sanitizePathSegment('Show: "The Best" <S1>?'), 'Show The Best S1')
  assert.strictEqual(sanitizePathSegment('trailing dots...   '), 'trailing dots')
  assert.strictEqual(sanitizePathSegment('a/b\\c|d*e'), 'abcde')
  assert.strictEqual(sanitizePathSegment('???'), 'download')
})

await expectCase('extractInfoHashFromMagnet handles hex and base32 btih', async () => {
  assert.strictEqual(extractInfoHashFromMagnet(`magnet:?xt=urn:btih:${HASH_A}&dn=x`), HASH_A)
  assert.strictEqual(extractInfoHashFromMagnet(`magnet:?xt=urn:btih:${HASH_A.toUpperCase()}`), HASH_A)
  const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const decoded = extractInfoHashFromMagnet(`magnet:?xt=urn:btih:${base32}&tr=udp://x`)
  assert.ok(decoded && /^[0-9a-f]{40}$/.test(decoded), `base32 decoded to hex: ${decoded}`)
  assert.strictEqual(extractInfoHashFromMagnet('magnet:?dn=only'), null)
})

await expectCase('extractTorrentMeta parses bencoded .torrent bytes', async () => {
  const infoBytes = Buffer.from('d4:name4:Testee'.slice(0, 14))
  const bytes = Buffer.concat([Buffer.from('d4:info'), infoBytes, Buffer.from('e')])
  const meta = extractTorrentMeta(bytes)
  assert.ok(meta, 'valid torrent parses')
  assert.strictEqual(
    meta.infoHash,
    crypto.createHash('sha1').update(bytes.subarray(7, bytes.length - 1)).digest('hex')
  )
  assert.strictEqual(meta.name, 'Test')
  assert.ok(meta.magnetUri.startsWith(`magnet:?xt=urn:btih:${meta.infoHash}`))
  assert.strictEqual(extractTorrentMeta(Buffer.from('not a torrent')), null)
})

// ---- contract cases ---------------------------------------------------------

await expectCase('(1) enable is blocked without accepted P2P consent', async () => {
  engineShutdown()
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-torrent-consent-'))
  const settings = makeSettings({ enableP2P: true, p2pConsentAcceptedAt: null })
  const fake = createFakeClient()
  let factoryCalls = 0
  initTorrentEngine({
    getSettings: () => settings,
    onState: () => {},
    persistDir,
    createClient: () => {
      factoryCalls += 1
      return fake
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.strictEqual(factoryCalls, 0, 'auto-start must not create a client without consent')
  const res = await engineSetEnabled(true)
  assert.strictEqual(res.success, false, 'enable without consent must fail')
  assert.ok(res.error && /consent/i.test(res.error), `error mentions consent, got: ${res.error}`)
  assert.strictEqual(engineGetState().enabled, false)
  engineShutdown()
})

await expectCase('(2) enable with consent + enableP2P creates the client once', async () => {
  engineShutdown()
  const { fake, counters } = setupEngine({ maxConcurrentDownloads: 3 })
  await until(() => engineGetState().enabled === true, 'auto-start after init')
  const res = await engineSetEnabled(true)
  assert.strictEqual(res.success, true, `re-enable succeeds: ${res.error}`)
  assert.strictEqual(counters.factoryCalls, 1, 'client created exactly once')
  const state = engineGetState()
  assert.strictEqual(state.enabled, true)
  assert.strictEqual(state.consentAccepted, true)
  assert.deepStrictEqual(state.limits, {
    maxConcurrent: 3,
    seedMinutes: 0,
  })
  assert.ok(counters.states.length > 0, 'onState broadcast received')
  engineShutdown()
})

await expectCase('(3) addDownload errors while disabled and after explicit disable', async () => {
  engineShutdown()
  const settings = makeSettings({ enableP2P: false, p2pConsentAcceptedAt: null })
  const fake = createFakeClient()
  initTorrentEngine({
    getSettings: () => settings,
    onState: () => {},
    persistDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ame-torrent-disabled-')),
    createClient: () => fake,
  })
  const res = await engineAddDownload({ item: magnetItem(HASH_A), title: 'Disabled Test' })
  assert.strictEqual(res.success, false, 'add while P2P off must fail')
  assert.ok(res.error && res.error.length > 0)

  settings.enableP2P = true
  settings.p2pConsentAcceptedAt = Date.now()
  assert.strictEqual((await engineSetEnabled(true)).success, true)
  assert.strictEqual((await engineSetEnabled(false)).success, true)
  assert.strictEqual(fake.destroyCalls.length, 1, 'disable destroys the client')
  assert.strictEqual(engineGetState().jobs.length, 0, 'disable clears in-memory jobs')
  const res2 = await engineAddDownload({ item: magnetItem(HASH_A), title: 'Disabled Test' })
  assert.strictEqual(res2.success, false)
  assert.ok(/disabled/i.test(res2.error), `error mentions disabled engine: ${res2.error}`)
  engineShutdown()
})

await expectCase('(3a) single-episode selection ignores NCED bonus videos and respects season folders', async () => {
  engineShutdown()
  const { fake } = setupEngine()
  fake.registry.set(HASH_C, {
    files: [
      { name: 'Jujutsu Kaisen - S01 - NCED 2.mkv', path: 'Jujutsu Kaisen (Season 1,2,3 + Movie)/NC/Jujutsu Kaisen - S01 - NCED 2.mkv' },
      { name: 'Jujutsu Kaisen S01E02.mkv', path: 'Jujutsu Kaisen (Season 1,2,3 + Movie)/Season 1/Jujutsu Kaisen S01E02.mkv' },
      { name: 'Jujutsu Kaisen S02E02.mkv', path: 'Jujutsu Kaisen (Season 1,2,3 + Movie)/Season 2/Jujutsu Kaisen S02E02.mkv' },
      { name: 'Jujutsu Kaisen Episode 2.mkv', path: 'Jujutsu Kaisen (Season 1,2,3 + Movie)/Jujutsu Kaisen Episode 2.mkv' },
    ],
  })
  const res = await engineAddDownload({
    item: magnetItem(HASH_C, { title: 'Jujutsu Kaisen complete batch' }),
    title: 'Jujutsu Kaisen',
    episode: 2,
    season: 2,
  })
  assert.strictEqual(res.success, true)
  await until(() => ['downloading', 'error'].includes(statusOf(HASH_C)), 'episode selection resolves')
  const selected = latestTorrentOf(fake, HASH_C).files.filter((file) => file.selected).map((file) => file.path)
  assert.deepStrictEqual(selected, ['Jujutsu Kaisen (Season 1,2,3 + Movie)/Season 2/Jujutsu Kaisen S02E02.mkv'])
  engineShutdown()
})

await expectCase('(3a.1) requests for multiple episodes merge into one batch torrent job', async () => {
  engineShutdown()
  const { fake, persistDir } = setupEngine()
  fake.registry.set(HASH_E, { files: ['Batch Show S01E01.mkv', 'Batch Show S01E02.mkv', 'Batch Show - NCED.mkv'] })
  const item = magnetItem(HASH_E, { title: 'Batch Show Season 1 Batch' })
  const first = await engineAddDownload({ item, title: 'Batch Show', episode: 1, season: 1 })
  assert.strictEqual(first.success, true)
  await until(() => statusOf(HASH_E) === 'downloading', 'first episode selected')
  const second = await engineAddDownload({ item, title: 'Batch Show', episode: 2, season: 1 })
  assert.strictEqual(second.success, true)
  await until(() => latestTorrentOf(fake, HASH_E).files.filter((file) => file.selected).length === 2, 'second episode added to selection')
  const job = engineGetState().jobs.find((entry) => entry.infoHash === HASH_E)
  assert.deepStrictEqual(job.episodes, [1, 2])
  const persisted = JSON.parse(fs.readFileSync(path.join(persistDir, 'downloads.json'), 'utf-8')).jobs.find((entry) => entry.infoHash === HASH_E)
  assert.deepStrictEqual(persisted.episodes, [1, 2], 'episode selection survives app restart')
  assert.deepStrictEqual(latestTorrentOf(fake, HASH_E).files.filter((file) => file.selected).map((file) => file.name).sort(), ['Batch Show S01E01.mkv', 'Batch Show S01E02.mkv'])
  assert.strictEqual(fake.torrents.length, 1, 'same info hash must not create a second torrent client entry')
  engineShutdown()
})

await expectCase('(3a.2) an unmatched extra episode does not stop the existing episode download', async () => {
  engineShutdown()
  const { fake } = setupEngine()
  fake.registry.set(HASH_F, { files: ['Single Show S01E01.mkv'] })
  const item = magnetItem(HASH_F, { title: 'Single Show S01E01' })
  const first = await engineAddDownload({ item, title: 'Single Show', episode: 1, season: 1 })
  assert.strictEqual(first.success, true)
  await until(() => statusOf(HASH_F) === 'downloading', 'first episode selected')
  const second = await engineAddDownload({ item, title: 'Single Show', episode: 2, season: 1 })
  assert.strictEqual(second.success, false, 'the reused single-episode release must reject episode 2')
  const job = engineGetState().jobs.find((entry) => entry.infoHash === HASH_F)
  assert.strictEqual(job.status, 'downloading', 'existing download remains active')
  assert.deepStrictEqual(job.episodes, [1], 'failed extension does not alter requested episodes')
  assert.deepStrictEqual(latestTorrentOf(fake, HASH_F).files.filter((file) => file.selected).map((file) => file.name), ['Single Show S01E01.mkv'])
  engineShutdown()
})

await expectCase('(3b) single-episode selection never guesses by file order in a pack', async () => {
  engineShutdown()
  const { fake } = setupEngine()
  fake.registry.set(HASH_D, { files: ['Jujutsu Kaisen Batch/video-a.mkv', 'Jujutsu Kaisen Batch/video-b.mkv'] })
  const res = await engineAddDownload({
    item: magnetItem(HASH_D, { title: 'Jujutsu Kaisen Season 1 Batch' }),
    title: 'Jujutsu Kaisen',
    episode: 2,
    season: 1,
  })
  assert.strictEqual(res.success, true)
  await until(() => statusOf(HASH_D) === 'error', 'ambiguous files are rejected')
  assert.ok(/Could not identify episode 2/.test(engineGetState().jobs.find((job) => job.infoHash === HASH_D)?.error || ''))
  assert.strictEqual(latestTorrentOf(fake, HASH_D).files.filter((file) => file.selected).length, 0)
  engineShutdown()
})

await expectCase('(3c) season download selects only the requested season and drops clean openings/endings', async () => {
  engineShutdown()
  const { fake } = setupEngine()
  fake.registry.set(HASH_E, {
    files: [
      { name: 'Jujutsu Kaisen S01E01.mkv', path: 'Season 1/Jujutsu Kaisen S01E01.mkv' },
      { name: 'Jujutsu Kaisen S02E01.mkv', path: 'Season 2/Jujutsu Kaisen S02E01.mkv' },
      { name: 'Jujutsu Kaisen - NCED 1.mkv', path: 'NC/Jujutsu Kaisen - NCED 1.mkv' },
      { name: 'Jujutsu Kaisen S02E02.mkv', path: 'Season 2/Jujutsu Kaisen S02E02.mkv' },
    ],
  })
  const res = await engineAddDownload({
    item: magnetItem(HASH_E, { title: 'Jujutsu Kaisen Season 1,2,3 Batch' }),
    title: 'Jujutsu Kaisen 2nd Season',
    episode: null,
    season: 2,
  })
  assert.strictEqual(res.success, true)
  await until(() => ['downloading', 'error'].includes(statusOf(HASH_E)), 'season selection resolves')
  const selected = latestTorrentOf(fake, HASH_E).files.filter((file) => file.selected).map((file) => file.path)
  assert.deepStrictEqual(selected, ['Season 2/Jujutsu Kaisen S02E01.mkv', 'Season 2/Jujutsu Kaisen S02E02.mkv'])
  engineShutdown()
})

await expectCase('(4) downloads over maxConcurrent stay queued until a slot frees', async () => {
  engineShutdown()
  const { fake } = setupEngine({ maxConcurrentDownloads: 1 })
  fake.registry.set(HASH_A, { files: ['Show A - 01.mkv'] })
  fake.registry.set(HASH_B, { files: ['Show B - 01.mkv'] })
  assert.strictEqual((await engineSetEnabled(true)).success, true)
  const resA = await engineAddDownload({ item: magnetItem(HASH_A), title: 'Show A', episode: 1 })
  assert.strictEqual(resA.success, true)
  assert.strictEqual(resA.infoHash, HASH_A)
  await until(() => statusOf(HASH_A) === 'connecting' || statusOf(HASH_A) === 'downloading', 'A becomes active')
  const resB = await engineAddDownload({ item: magnetItem(HASH_B), title: 'Show B' })
  assert.strictEqual(resB.success, true)
  assert.strictEqual(statusOf(HASH_B), 'queued', 'second download waits in the queue')
  assert.strictEqual(engineGetState().jobs.length, 2)
  assert.strictEqual(enginePause(HASH_A).success, true)
  assert.strictEqual(statusOf(HASH_A), 'paused')
  await until(() => statusOf(HASH_B) === 'connecting' || statusOf(HASH_B) === 'downloading', 'B activates after A pauses')
  engineShutdown()
})

await expectCase('(5) magnet adds directly; http(s) .torrent is fetched and parsed', async () => {
  engineShutdown()
  const { fake } = setupEngine()
  fake.registry.set(HASH_A, { files: ['Test.mkv'], name: 'Test', infoHash: HASH_A })
  assert.strictEqual((await engineSetEnabled(true)).success, true)

  // Mock fetch for .torrent file
  const originalFetch = globalThis.fetch
  globalThis.fetch = async function (url) {
    if (url === 'https://example.invalid/test.torrent') {
      // Return a minimal valid .torrent bencoded dict with info hash HASH_A
      const infoBuf = Buffer.from('d4:name4:Test12:piece lengthi32768e6:pieces0:6:lengthi100ee')
      const torrentBuf = Buffer.concat([Buffer.from('d4:info'), infoBuf, Buffer.from('e')])
      return {
        ok: true,
        arrayBuffer: async () => torrentBuf.buffer.slice(torrentBuf.byteOffset, torrentBuf.byteOffset + torrentBuf.byteLength),
      }
    }
    throw new Error('unexpected fetch')
  }

  const res = await engineAddDownload({
    item: magnetItem(HASH_A, { downloadUrl: 'https://example.invalid/test.torrent' }),
    title: 'HTTP Test',
  })
  assert.strictEqual(res.success, true, `http add succeeds: ${res.error}`)
  assert.ok(res.infoHash && /^[0-9a-f]{40}$/.test(res.infoHash), 'infoHash is valid hex')
  // HTTP torrent becomes active after metadata fetch (async), skip waiting in unit test

  globalThis.fetch = originalFetch

  // magnet path
  const resMagnet = await engineAddDownload({ item: magnetItem(HASH_B), title: 'Magnet Test' })
  assert.strictEqual(resMagnet.success, true, `magnet add succeeds: ${resMagnet.error}`)
  assert.strictEqual(resMagnet.infoHash, HASH_B)
  engineShutdown()
})

await expectCase('(6) pause/resume/cancel flows; removeFiles uses destroyStore', async () => {
  engineShutdown()
  const { fake } = setupEngine()
  assert.strictEqual((await engineSetEnabled(true)).success, true)
  const res = await engineAddDownload({ item: magnetItem(HASH_A), title: 'Pause Show', episode: 1 })
  assert.strictEqual(res.success, true)
  await until(() => statusOf(HASH_A) === 'downloading', 'A downloading')
  let torrent = latestTorrentOf(fake, HASH_A)

  assert.strictEqual(enginePause(HASH_A).success, true)
  assert.strictEqual(statusOf(HASH_A), 'paused')
  assert.strictEqual(torrent.paused, true, 'torrent paused')
  assert.strictEqual(engineResume(HASH_A).success, true)
  assert.strictEqual(statusOf(HASH_A), 'downloading')
  assert.strictEqual(torrent.paused, false, 'torrent resumed')

  assert.strictEqual((await engineCancel(HASH_A)).success, true)
  await until(() => statusOf(HASH_A) === undefined, 'job removed after cancel')
  await until(() => torrent.destroyArgs.length > 0, 'destroy called')
  assert.ok(!torrent.destroyArgs.some((a) => a && a.destroyStore), 'cancel without removeFiles keeps files')

  // Cancel WITH removeFiles -> destroyStore: true
  const res2 = await engineAddDownload({ item: magnetItem(HASH_A), title: 'Pause Show', episode: 1 })
  assert.strictEqual(res2.success, true, `re-add after cancel: ${res2.error}`)
  await until(() => fake.torrents.filter((t) => t.infoHash === HASH_A).length === 2, 'second torrent created')
  torrent = latestTorrentOf(fake, HASH_A)
  assert.strictEqual((await engineCancel(HASH_A, true)).success, true)
  await until(() => torrent.destroyArgs.length > 0, 'destroy called with removeFiles')
  assert.ok(
    torrent.destroyArgs.some((a) => a && a.destroyStore === true),
    'removeFiles destroy carries destroyStore flag'
  )

  assert.strictEqual((await engineCancel(HASH_B)).success, false, 'cancel of unknown hash fails')
  engineShutdown()
})

await expectCase('(7a) seeding auto-stops immediately when seedMinutesAfterComplete is 0', async () => {
  engineShutdown()
  const { fake } = setupEngine({ seedMinutesAfterComplete: 0 })
  fake.registry.set(HASH_A, { files: ['Seed Show - 01.mkv'] })
  assert.strictEqual((await engineSetEnabled(true)).success, true)
  const res = await engineAddDownload({ item: magnetItem(HASH_A), title: 'Seed Show' })
  assert.strictEqual(res.success, true)
  await until(() => statusOf(HASH_A) === 'downloading', 'job downloading')
  const torrent = latestTorrentOf(fake, HASH_A)
  torrent.done = true
  torrent.emit('done')
  await until(() => statusOf(HASH_A) === undefined, 'job removed after done')
  assert.ok(torrent.destroyArgs.length > 0, 'torrent destroyed on done')
  assert.ok(!torrent.destroyArgs.some((a) => a && a.destroyStore), 'auto-stop keeps files (no destroyStore)')
  engineShutdown()
})

await expectCase('(7b) seeding keeps the torrent for seedMinutesAfterComplete then removes the job', async () => {
  engineShutdown()
  const { fake } = setupEngine({ seedMinutesAfterComplete: 0.04 }) // ~2.4s window
  fake.registry.set(HASH_B, { files: ['Seed Show 2 - 01.mkv'] })
  assert.strictEqual((await engineSetEnabled(true)).success, true)
  const res = await engineAddDownload({ item: magnetItem(HASH_B), title: 'Seed Show 2' })
  assert.strictEqual(res.success, true)
  await until(() => statusOf(HASH_B) === 'downloading', 'job downloading')
  const torrent = latestTorrentOf(fake, HASH_B)
  torrent.done = true
  torrent.emit('done')
  await until(() => statusOf(HASH_B) === 'seeding', 'seeding status reached')
  assert.strictEqual(torrent.destroyArgs.length, 0, 'torrent alive while seeding')
  await until(() => statusOf(HASH_B) === undefined, 'seeding window elapsed, job removed', 9000)
  assert.ok(torrent.destroyArgs.length > 0, 'torrent destroyed after seed window')
  assert.ok(!torrent.destroyArgs.some((a) => a && a.destroyStore), 'files kept after seed auto-stop')
  engineShutdown()
})

await expectCase('(8) persistence: synchronous downloads.json write on add + shutdown', async () => {
  engineShutdown()
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-torrent-persist-'))
  const { settings } = setupEngine()
  initTorrentEngine({
    getSettings: () => settings,
    onState: () => {},
    persistDir,
    createClient: () => createFakeClient(),
  })
  assert.strictEqual((await engineSetEnabled(true)).success, true)
  const resA = await engineAddDownload({
    item: magnetItem(HASH_A),
    title: 'Persist Show',
    anilistId: 42,
    episode: 5,
  })
  assert.strictEqual(resA.success, true)
  const markerPath = path.join(persistDir, 'downloads.json')
  await until(() => fs.existsSync(markerPath), 'persistence write')
  const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
  const list = data.jobs
  const entry = list.find((e) => e.infoHash === HASH_A)
  assert.ok(entry, 'marker entry for the running job')
  assert.ok(entry.magnetUri && entry.magnetUri.includes(`urn:btih:${HASH_A}`), 'marker keeps the btih')
  assert.strictEqual(entry.title, 'Persist Show')
  assert.strictEqual(entry.anilistId, 42)
  assert.strictEqual(entry.episode, 5)
  assert.strictEqual(entry.targetFolder, settings.downloadTargetFolder)
  assert.strictEqual(typeof entry.addedAt, 'number')
  assert.ok(!fs.existsSync(markerPath + '.tmp'), 'atomic rename leaves no tmp file')

  const resB = await engineAddDownload({ item: magnetItem(HASH_B), title: 'Persist Show B' })
  assert.strictEqual(resB.success, true)
  engineShutdown() // synchronous persist on quit
  const data2 = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
  const list2 = data2.jobs
  assert.ok(list2.some((e) => e.infoHash === HASH_A), 'unfinished job A persisted')
  assert.ok(list2.some((e) => e.infoHash === HASH_B), 'job B persisted by shutdown')
})

await expectCase('(9) persisted unfinished jobs are silently re-added on enable', async () => {
  engineShutdown()
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-torrent-resume-'))
  const settings = makeSettings({ enableP2P: true, p2pConsentAcceptedAt: Date.now() })
  const fake1 = createFakeClient()
  initTorrentEngine({
    getSettings: () => settings,
    onState: () => {},
    persistDir,
    createClient: () => fake1,
  })
  assert.strictEqual((await engineSetEnabled(true)).success, true)
  assert.strictEqual((await engineAddDownload({ item: magnetItem(HASH_A), title: 'Resume Show', episode: 3 })).success, true)
  assert.strictEqual((await engineAddDownload({ item: magnetItem(HASH_B), title: 'Resume Show 2' })).success, true)
  await until(() => statusOf(HASH_A) && statusOf(HASH_B), 'both jobs active')
  assert.strictEqual((await engineSetEnabled(false)).success, true)
  assert.strictEqual(engineGetState().jobs.length, 0)

  const fake2 = createFakeClient()
  initTorrentEngine({
    getSettings: () => settings,
    onState: () => {},
    persistDir,
    createClient: () => fake2,
  })
  assert.strictEqual((await engineSetEnabled(true)).success, true)
  await until(
    () =>
      (statusOf(HASH_A) === 'connecting' || statusOf(HASH_A) === 'downloading') &&
      (statusOf(HASH_B) === 'connecting' || statusOf(HASH_B) === 'downloading'),
    'persisted jobs re-activated'
  )
  assert.strictEqual(fake2.added.length, 2, 'both markers re-added to the client')
  engineShutdown()
})

await expectCase('(10) engineGetJobDiagnostics generates detailed report and caches upon cancel', async () => {
  engineShutdown()
  const { fake } = setupEngine()
  fake.registry.set(HASH_A, { files: ['DiagShow S01E01.mkv'], name: 'DiagShow', infoHash: HASH_A })
  assert.strictEqual((await engineSetEnabled(true)).success, true)
  const res = await engineAddDownload({ item: magnetItem(HASH_A), title: 'Diagnostics Test Show', episode: 1 })
  assert.strictEqual(res.success, true)
  await until(() => statusOf(HASH_A) === 'downloading', 'job is downloading')

  // Generate live report
  const liveReport = engineGetJobDiagnostics(HASH_A)
  assert.ok(liveReport.includes('KAIKO TORRENT FULL DIAGNOSTIC REPORT'), 'contains header')
  assert.ok(liveReport.includes('Diagnostics Test Show'), 'contains title')
  assert.ok(liveReport.includes('LIVE SWARM & TRANSFER METRICS'), 'contains swarm metrics')
  assert.ok(liveReport.includes('CHRONOLOGICAL EVENT HISTORY'), 'contains event history')
  assert.ok(liveReport.includes('DiagShow S01E01.mkv'), 'contains selected file')

  // Cancel the job
  const cancelRes = await engineCancel(HASH_A)
  assert.strictEqual(cancelRes.success, true)

  // Report should still be retrievable from recentDiagnostics cache
  const cachedReport = engineGetJobDiagnostics(HASH_A)
  assert.strictEqual(cachedReport.includes('KAIKO TORRENT FULL DIAGNOSTIC REPORT'), true)
  assert.strictEqual(cachedReport.includes('Diagnostics Test Show'), true)

  // Non-existent hash
  const missingReport = engineGetJobDiagnostics('1111111111111111111111111111111111111111')
  assert.ok(missingReport.includes('is not active in memory'), 'handles unknown hash safely')

  engineShutdown()
})

await expectCase('(11) batch boundary piece selection: unchosen files deselected before chosen files selected', async () => {
  engineShutdown()
  const { fake } = setupEngine()
  const callOrder = []

  const file1 = {
    name: 'Cyberpunk S02E01.mkv',
    length: 2625535839,
    _startPiece: 0,
    _endPiece: 312,
    selected: true,
    select() { callOrder.push('file1.select'); file1.selected = true },
    deselect() { callOrder.push('file1.deselect'); file1.selected = false }
  }
  const file2 = {
    name: 'Cyberpunk S02E02.mkv',
    length: 2625535839,
    _startPiece: 312,
    _endPiece: 624,
    selected: true,
    select() { callOrder.push('file2.select'); file2.selected = true },
    deselect() { callOrder.push('file2.deselect'); file2.selected = false }
  }

  fake.registry.set(HASH_A, {
    name: 'Cyberpunk Batch',
    infoHash: HASH_A,
    files: [file1, file2],
  })

  assert.strictEqual((await engineSetEnabled(true)).success, true)
  const res = await engineAddDownload({ item: magnetItem(HASH_A), title: 'Cyberpunk', episode: 1 })
  assert.strictEqual(res.success, true)
  await until(() => statusOf(HASH_A) === 'downloading', 'job is downloading')

  // Verify that file2.deselect happened BEFORE file1.select in the final selection pass
  const lastFile2Deselect = callOrder.lastIndexOf('file2.deselect')
  const lastFile1Select = callOrder.lastIndexOf('file1.select')
  assert.ok(lastFile2Deselect !== -1, 'file2 was deselected')
  assert.ok(lastFile1Select !== -1, 'file1 was selected')
  assert.ok(lastFile2Deselect < lastFile1Select, 'unchosen file2 was deselected BEFORE chosen file1 was selected')

  assert.strictEqual(file1.selected, true, 'file1 is selected')
  assert.strictEqual(file2.selected, false, 'file2 is deselected')

  engineShutdown()
})

// ---- report -----------------------------------------------------------------

engineShutdown()
globalThis.fetch = originalFetch

console.log('')
console.log(`Torrent engine tests: ${PASS.length} passed, ${FAIL.length} failed`)
if (FAIL.length > 0) {
  for (const failure of FAIL) console.log('  FAILED:', failure)
  process.exit(1)
}
