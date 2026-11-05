/**
 * Offline tests for the built-in torrent engine (electron/torrentEngine.ts).
 *
 * Runs under plain Node (v24, native TS type-stripping) with NO network and
 * NO real webtorrent: every case injects a FakeClient through the optional
 * `createClient` init dep and a stubbed VPN probe through `detectVpn`, so the
 * engine's lazy `import('webtorrent')` is never reached. The only real
 * dependency exercised is src/lib/releaseParser (regex engine, offline).
 *
 * Coverage: consent gate, enable/disable lifecycle, queueing over the
 * concurrency limit, selective episode download, magnet vs .torrent URL
 * (mocked global fetch), pause/resume/cancel (+ destroyStore), VPN block,
 * seeding auto-stop, aggregate speed-limit approximation, persistence
 * (debounced + shutdown writes) and silent resume of persisted jobs.
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
  sanitizePathSegment,
  extractInfoHashFromMagnet,
  extractTorrentMeta,
} = await import('./electron/torrentEngine.ts')

const HASH_A = 'a'.repeat(40)
const HASH_B = 'b'.repeat(40)
const HASH_C = 'c'.repeat(40)

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
    requireVpnForP2p: false,
    vpnBlockDownload: false,
    maxConcurrentDownloads: 2,
    downloadSpeedLimitMBps: 0,
    uploadSpeedLimitMBps: 0,
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
  const deselectCalls = spec.deselectCalls || []
  const torrent = {
    infoHash,
    name: spec.name || 'Fake Torrent',
    files: (spec.files || []).map((name) => ({
      name,
      length: 1,
      select() {},
      deselect() {
        deselectCalls.push(name)
      },
    })),
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
    pause() {
      torrent.paused = true
    },
    resume() {
      torrent.paused = false
    },
    destroy(opts, cb) {
      torrent.destroyArgs.push(opts || null)
      torrent.destroyed = true
      if (typeof opts === 'function') opts()
      else if (typeof cb === 'function') cb()
    },
    _listeners: {},
    on(event, listener) {
      (torrent._listeners[event] = torrent._listeners[event] || []).push(listener)
      return torrent
    },
    emit(event, ...args) {
      for (const listener of torrent._listeners[event] || []) listener(...args)
    },
  }
  return torrent
}

function createFakeClient() {
  const registry = new Map(); // infoHash or buffer-hex -> torrent spec
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
      let kind = 'magnet'
      let infoHash = 'unknown'
      if (typeof id === 'string') {
        const match = /urn:btih:([0-9a-z]{32,40})/i.exec(id)
        if (match) infoHash = match[1].toLowerCase()
        spec = registry.get(infoHash) || {}
        if (spec.infoHash) infoHash = spec.infoHash
      } else if (Buffer.isBuffer(id)) {
        kind = 'buffer'
        spec = registry.get(id.toString('hex')) || {}
        infoHash = spec.infoHash || 'unknown'
      }
      const torrent = createFakeTorrent(infoHash, spec)
      client.torrents.push(torrent)
      client.added.push({ kind, opts })
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
    detectVpn: () => ({ active: true, interfaces: ['tun0'], checkedAt: Date.now() }),
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
  const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // 32 valid chars -> 20 bytes
  const decoded = extractInfoHashFromMagnet(`magnet:?xt=urn:btih:${base32}&tr=udp://x`)
  assert.ok(decoded && /^[0-9a-f]{40}$/.test(decoded), `base32 decoded to hex: ${decoded}`)
  assert.strictEqual(extractInfoHashFromMagnet('magnet:?dn=only'), null)
})

await expectCase('extractTorrentMeta parses bencoded .torrent bytes', async () => {
  const infoBytes = Buffer.from('d4:name4:Testee'.slice(0, 14)); // d4:name4:Teste
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
    detectVpn: () => ({ active: true, interfaces: [], checkedAt: Date.now() }),
  })
  await new Promise((resolve) => setTimeout(resolve, 80)); // any bogus auto-start would fire here
  assert.strictEqual(factoryCalls, 0, 'auto-start must not create a client without consent')
  const res = await engineSetEnabled(true)
  assert.strictEqual(res.success, false, 'enable without consent must fail')
  assert.ok(res.error && /consent/i.test(res.error), `error mentions consent, got: ${res.error}`)
  assert.strictEqual(engineGetState().enabled, false)
  engineShutdown()
})

await expectCase('(2) enable with consent + enableP2P creates the client once', async () => {
  engineShutdown()
  const { fake, counters } = setupEngine({ maxConcurrentDownloads: 3, downloadSpeedLimitMBps: 5 })
  await until(() => engineGetState().enabled === true, 'auto-start after init')
  const res = await engineSetEnabled(true); // idempotent re-enable
  assert.strictEqual(res.success, true, `re-enable succeeds: ${res.error}`)
  assert.strictEqual(counters.factoryCalls, 1, 'client created exactly once')
  const state = engineGetState()
  assert.strictEqual(state.enabled, true)
  assert.strictEqual(state.consentAccepted, true)
  assert.deepStrictEqual(state.limits, {
    maxConcurrent: 3,
    downloadSpeedMBps: 5,
    uploadSpeedMBps: 0,
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
    detectVpn: () => ({ active: true, interfaces: [], checkedAt: Date.now() }),
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

await expectCase('(5) selective download deselects wrong episodes and non-video files', async () => {
  engineShutdown()
  const { fake } = setupEngine()
  const deselectCalls = []
  fake.registry.set(HASH_C, { files: ['Show - 01.mkv', 'Show - 02.mkv', 'sample.jpg'], deselectCalls })
  assert.strictEqual((await engineSetEnabled(true)).success, true)
  const res = await engineAddDownload({ item: magnetItem(HASH_C), title: 'Selective Show', episode: 2 })
  assert.strictEqual(res.success, true, `add succeeds: ${res.error}`)
  await until(() => deselectCalls.length >= 2, 'deselect calls happen')
  assert.ok(deselectCalls.includes('Show - 01.mkv'), 'episode 1 file deselected')
  assert.ok(deselectCalls.includes('sample.jpg'), 'non-video file deselected')
  assert.ok(!deselectCalls.includes('Show - 02.mkv'), 'target episode file NOT deselected')
  engineShutdown()
})

await expectCase('(6) magnet adds directly; http(s) .torrent is fetched first (and failures error)', async () => {
  engineShutdown()
  const infoBytes = Buffer.from('d4:name4:Teste')
  const torrentBytes = Buffer.concat([Buffer.from('d4:info'), infoBytes, Buffer.from('e')])
  const expectedHash = crypto
    .createHash('sha1')
    .update(torrentBytes.subarray(7, torrentBytes.length - 1))
    .digest('hex')
  const { fake } = setupEngine()
  fake.registry.set(torrentBytes.toString('hex'), { infoHash: expectedHash, files: ['Test.mkv'], name: 'Test' })
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        torrentBytes.buffer.slice(torrentBytes.byteOffset, torrentBytes.byteOffset + torrentBytes.byteLength),
    }
  }
  try {
    assert.strictEqual((await engineSetEnabled(true)).success, true)
    const res = await engineAddDownload({
      item: magnetItem(expectedHash, { downloadUrl: 'https://example.invalid/test.torrent' }),
      title: 'HTTP Test',
    })
    assert.strictEqual(res.success, true, `http add succeeds: ${res.error}`)
    assert.strictEqual(res.infoHash, expectedHash, 'infoHash computed from .torrent bytes')
    assert.strictEqual(fetchCalls, 1)
    await until(() => fake.added.some((a) => a.kind === 'buffer'), 'buffer handed to client')
    const addRecord = fake.added.find((a) => a.kind === 'buffer')
    assert.ok(addRecord.opts.path && addRecord.opts.path.includes('HTTP Test'), 'download dir passed via opts.path')
    await until(
      () => statusOf(expectedHash) === 'connecting' || statusOf(expectedHash) === 'downloading',
      'http job becomes active'
    )

    globalThis.fetch = async () => {
      fetchCalls += 1
      throw new Error('network down')
    }
    const resFail = await engineAddDownload({
      item: magnetItem(HASH_B, { downloadUrl: 'https://example.invalid/fail.torrent' }),
      title: 'HTTP Fail',
    })
    assert.strictEqual(resFail.success, false, 'fetch failure errors the add')
    assert.ok(/fetch|network/i.test(resFail.error), `failure message: ${resFail.error}`)

    const before = fetchCalls
    const resMagnet = await engineAddDownload({ item: magnetItem(HASH_A), title: 'Magnet Test' })
    assert.strictEqual(resMagnet.success, true, `magnet add succeeds: ${resMagnet.error}`)
    assert.strictEqual(fetchCalls, before, 'magnet path never fetches')
  } finally {
    globalThis.fetch = originalFetch
  }
  engineShutdown()
})

await expectCase('(7) pause/resume/cancel flows; removeFiles uses destroyStore', async () => {
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

  // Cancel WITH removeFiles -> destroyStore: true (webtorrent's only deletion path)
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

await expectCase('(8) VPN guard blocks downloads when requireVpnForP2p + vpnBlockDownload', async () => {
  engineShutdown()
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-torrent-vpn-'))
  const settings = makeSettings({
    enableP2P: true,
    p2pConsentAcceptedAt: Date.now(),
    requireVpnForP2p: true,
    vpnBlockDownload: true,
  })
  const fake = createFakeClient()
  let vpnActive = false
  let vpnThrows = false
  initTorrentEngine({
    getSettings: () => settings,
    onState: () => {},
    persistDir,
    createClient: () => fake,
    detectVpn: () => {
      if (vpnThrows) throw new Error('probe blew up')
      return { active: vpnActive, interfaces: vpnActive ? ['tun0'] : [], checkedAt: Date.now() }
    },
  })
  assert.strictEqual((await engineSetEnabled(true)).success, true, 'enable itself needs no VPN')

  const blocked = await engineAddDownload({ item: magnetItem(HASH_A), title: 'VPN Test' })
  assert.strictEqual(blocked.success, false, 'download blocked without VPN')
  assert.strictEqual(
    blocked.error,
    'VPN tunnel not detected — download blocked by your P2P safety settings'
  )
  assert.strictEqual(fake.added.length, 0, 'nothing reached the client')

  vpnActive = true
  const allowed = await engineAddDownload({ item: magnetItem(HASH_A), title: 'VPN Test' })
  assert.strictEqual(allowed.success, true, `download allowed with VPN: ${allowed.error}`)
  await until(() => fake.added.length === 1, 'torrent handed to client')

  vpnThrows = true
  vpnActive = false
  const probeFail = await engineAddDownload({ item: magnetItem(HASH_B), title: 'VPN Test 2' })
  assert.strictEqual(probeFail.success, false, 'failed VPN probe fails closed')
  assert.ok(/VPN check failed/.test(probeFail.error), `probe failure message: ${probeFail.error}`)
  engineShutdown()
})

await expectCase('(9a) seeding auto-stops immediately when seedMinutesAfterComplete is 0', async () => {
  engineShutdown()
  const { fake } = setupEngine({ seedMinutesAfterComplete: 0 })
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

await expectCase('(9b) seeding keeps the torrent for seedMinutesAfterComplete then removes the job', async () => {
  engineShutdown()
  const { fake } = setupEngine({ seedMinutesAfterComplete: 0.04 }); // ~2.4s window
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

await expectCase('(10) persistence: debounced atomic downloads.json + synchronous shutdown write', async () => {
  engineShutdown()
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-torrent-persist-'))
  const { settings } = setupEngine()
  initTorrentEngine({
    getSettings: () => settings,
    onState: () => {},
    persistDir,
    createClient: () => createFakeClient(),
    detectVpn: () => ({ active: true, interfaces: [], checkedAt: Date.now() }),
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
  await until(() => fs.existsSync(markerPath), 'debounced persistence write', 5000)
  const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
  const list = Array.isArray(data) ? data : data.jobs
  const entry = list.find((e) => e.infoHash === HASH_A)
  assert.ok(entry, 'marker entry for the running job')
  // The engine adopts the torrent's canonical magnetURI once metadata is
  // ready, so assert the btih rather than the exact original string.
  assert.ok(entry.magnetUri && entry.magnetUri.includes(`urn:btih:${HASH_A}`), 'marker keeps the btih')
  assert.strictEqual(entry.title, 'Persist Show')
  assert.strictEqual(entry.anilistId, 42)
  assert.strictEqual(entry.episode, 5)
  assert.strictEqual(entry.targetFolder, settings.downloadTargetFolder)
  assert.strictEqual(typeof entry.addedAt, 'number')
  assert.ok(!fs.existsSync(markerPath + '.tmp'), 'atomic rename leaves no tmp file')

  const resB = await engineAddDownload({ item: magnetItem(HASH_B), title: 'Persist Show B' })
  assert.strictEqual(resB.success, true)
  engineShutdown(); // synchronous persist on quit
  const data2 = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
  const list2 = Array.isArray(data2) ? data2 : data2.jobs
  assert.ok(list2.some((e) => e.infoHash === HASH_A), 'unfinished job A persisted')
  assert.ok(list2.some((e) => e.infoHash === HASH_B), 'job B persisted by shutdown')
})

await expectCase('(11) persisted unfinished jobs are silently re-added on enable', async () => {
  engineShutdown()
  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-torrent-resume-'))
  const settings = makeSettings({ enableP2P: true, p2pConsentAcceptedAt: Date.now() })
  const fake1 = createFakeClient()
  initTorrentEngine({
    getSettings: () => settings,
    onState: () => {},
    persistDir,
    createClient: () => fake1,
    detectVpn: () => ({ active: true, interfaces: [], checkedAt: Date.now() }),
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
    detectVpn: () => ({ active: true, interfaces: [], checkedAt: Date.now() }),
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

await expectCase('(12) aggregate speed caps pause the newest active torrent and resume it below 80%', async () => {
  engineShutdown()
  const MB = 1024 * 1024
  const { fake } = setupEngine({
    downloadSpeedLimitMBps: 15,
    uploadSpeedLimitMBps: 20,
    seedMinutesAfterComplete: 5,
  })
  fake.registry.set(HASH_A, { files: ['Cap A.mkv'] })
  fake.registry.set(HASH_B, { files: ['Cap B.mkv'] })
  assert.strictEqual((await engineSetEnabled(true)).success, true)
  assert.strictEqual((await engineAddDownload({ item: magnetItem(HASH_A), title: 'Cap A' })).success, true)
  assert.strictEqual((await engineAddDownload({ item: magnetItem(HASH_B), title: 'Cap B' })).success, true)
  await until(() => statusOf(HASH_A) === 'downloading' && statusOf(HASH_B) === 'downloading', 'both downloading')
  const torrentA = latestTorrentOf(fake, HASH_A)
  const torrentB = latestTorrentOf(fake, HASH_B)
  torrentA.downloadSpeed = 10 * MB
  torrentB.downloadSpeed = 10 * MB

  // total 20 MB/s > 15 cap -> newest (B) paused by the limiter
  await until(() => torrentB.paused === true, 'newest torrent throttled', 8000)
  assert.strictEqual(torrentA.paused, false, 'oldest torrent untouched')

  // total falls below 80% of cap -> B resumed
  torrentB.downloadSpeed = 1 * MB
  await until(() => torrentB.paused === false, 'throttled torrent resumed', 8000)

  // upload cap: A finishes -> seeding; 30 MB/s upload > 20 cap -> paused
  torrentA.done = true
  torrentA.emit('done')
  await until(() => statusOf(HASH_A) === 'seeding', 'A seeding')
  torrentA.uploadSpeed = 30 * MB
  await until(() => torrentA.paused === true, 'seeding torrent upload-throttled', 8000)

  // upload drops below 80% -> resumed
  torrentA.uploadSpeed = 1 * MB
  await until(() => torrentA.paused === false, 'seeding torrent upload-resumed', 8000)
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
