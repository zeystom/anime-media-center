/**
 * Built-in BitTorrent download engine (Phase 5).
 *
 * Scope: this module drives the BUILT-IN webtorrent client only. The FS
 * heuristics for EXTERNAL torrent clients live in electron/torrents.ts and are
 * intentionally untouched by this engine — both detection paths coexist.
 *
 * Safety invariants (enforced at EVERY entry point, not just at startup):
 * - The engine never starts unless `settings.enableP2P === true` AND
 *   `settings.p2pConsentAcceptedAt` is set. Every public entry point re-reads
 *   settings and re-checks the gate, so a settings change takes effect on the
 *   very next call.
 * - `requireVpnForP2p && vpnBlockDownload` (both default ON) block
 *   `engineAddDownload` when `detectVpnStatus().active` is false. A failed VPN
 *   probe fails CLOSED (download refused).
 * - The engine NEVER deletes files on its own. Cancelling removes files only
 *   when the caller explicitly passes `removeFiles: true`; disabling the
 *   engine and seeding auto-stop keep every downloaded byte.
 *
 * Engineering notes:
 * - webtorrent is NEVER imported at module top level. `ensureClient()` loads
 *   it through a literal dynamic `import('webtorrent')` so offline node tests
 *   (which inject a fake client via the `createClient` dep) never pull it and
 *   the Electron main bundle marks it external.
 * - Downloads land on disk under `<targetFolder>/<sanitized title>/`. The
 *   sanitizer strips Windows-unsafe characters (`<>:"/\|?*`), control chars
 *   and trailing dots/spaces from each path segment.
 * - Speed limits are an APPROXIMATION: a 2s tick measures each active
 *   torrent's speed and pauses the newest active torrent(s) when the measured
 *   aggregate exceeds the cap, resuming them below 80% of the cap. Because
 *   measurement lags the tick, expect roughly ±10% overshoot around the cap
 *   users needing precise limits should use an external torrent client (the
 *   FS-heuristic fallback in torrents.ts keeps working independently).
 * - Persistence: `<persistDir>/downloads.json` holds queue markers for
 *   unfinished jobs only (atomic tmp+rename writes, debounced 2s, plus a
 *   synchronous write in `engineShutdown`). Markers are silently re-added as
 *   queued jobs on the next enable.
 *
 * The exported functions below are the IMMUTABLE CONTRACT for main.ts and the
 * UI — additive exports are allowed, signature changes are not.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { detectVpnStatus } from './vpnGuard.ts'
import { parseRelease } from '../src/lib/releaseParser/index.ts'
import type {
  AppSettings,
  P2pState,
  ReleaseSearchResult,
  TorrentJob,
  TorrentJobStatus,
  VpnStatus,
} from './types.ts'

// ---- Tunables -------------------------------------------------------------

/** Aggregate speed-limit enforcement cadence (see JSDoc: approximation). */
const SPEED_TICK_MS = 2_000
/** Progress broadcast cadence; state pushes are throttled to at most 1/s. */
const BROADCAST_TICK_MS = 1_000
/** Debounce window for downloads.json writes. */
const PERSIST_DEBOUNCE_MS = 2_000
/** Timeout for fetching remote .torrent files referenced by a release. */
const TORRENT_FETCH_TIMEOUT_MS = 20_000
/** How long a job may sit in 'connecting' (no metadata) before it fails loudly. */
const CONNECTING_TIMEOUT_MS = 120_000
/** Hard cap for client/torrent destroy callbacks so callers never hang. */
const DESTROY_GUARD_MS = 3_000
/** Longest window a completed torrent keeps seeding before auto-stop. */
const SEED_CHECK_MS = 1_000
/** Max chars kept for a single download path segment (Windows path safety). */
const MAX_SEGMENT_LENGTH = 100

/** Video extensions the selective-download filter treats as "the content". */
const TORRENT_VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg',
  '.mpeg', '.ts', '.m2ts', '.ogm', '.rmvb',
])

// ---- Contract shapes ------------------------------------------------------

/**
 * Loose structural subset of the webtorrent Client surface used by the
 * engine. Production passes nothing (the real client is loaded lazily)
 * tests inject a fake via the `createClient` init dep.
 */
export interface TorrentClientLike {
  add: (
    torrentId: string | Buffer,
    opts?: Record<string, unknown>,
    onTorrent?: (torrent: TorrentLike) => void
  ) => unknown
  torrents: unknown[]
  destroy: (cb?: (err?: Error | null) => void) => void
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
}

/** Loose structural subset of a webtorrent Torrent used by the engine. */
export interface TorrentLike {
  infoHash: string
  name?: string
  magnetURI?: string
  files?: TorrentFileLike[]
  paused?: boolean
  done?: boolean
  progress?: number
  downloaded?: number
  length?: number
  downloadSpeed?: number
  uploadSpeed?: number
  numPeers?: number
  timeRemaining?: number
  pause: () => void
  resume: () => void
  destroy: (opts?: { destroyStore?: boolean } | null, cb?: () => void) => void
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
}

export interface TorrentFileLike {
  name: string
  length?: number
  select?: () => void
  deselect: () => void
}

/**
 * Optional engine dependencies. Production only passes the first three
 * `createClient` and `detectVpn` exist so offline tests can inject fakes.
 */
export interface TorrentEngineDeps {
  getSettings: () => AppSettings
  onState: (state: P2pState) => void
  persistDir: string
  /** Test-only: fake client factory. Production omits it. */
  createClient?: () => TorrentClientLike
  /** Test-only: VPN probe override. Production omits it (uses vpnGuard). */
  detectVpn?: () => VpnStatus | Promise<VpnStatus>
}

export interface PersistedDownload {
  infoHash: string
  magnetUri: string
  title: string
  anilistId: number | null
  targetFolder: string
  episode: number | null
  addedAt: number
}

export interface PersistedDownloadsFile {
  version: 1
  savedAt: number
  jobs: PersistedDownload[]
}

export interface EngineOpResult {
  success: boolean
  infoHash?: string
  error?: string
}

export interface TorrentMeta {
  infoHash: string
  name: string | null
  announceUrls: string[]
  magnetUri: string
}

// ---- Internal state -------------------------------------------------------

interface InternalJob {
  infoHash: string
  title: string
  anilistId: number | null
  episode: number | null
  /** Resolved base folder (param override → settings target → first library). */
  targetFolder: string
  /** Absolute download dir: `<targetFolder>/<sanitized title>`. */
  downloadDir: string
  magnetUri: string
  /** Raw .torrent bytes when the release pointed at an http(s) file. */
  sourceBuffer: Buffer | null
  status: TorrentJobStatus
  addedAt: number
  completedAt: number | null
  error?: string
  /** Set when the job enters 'connecting'; drives the stuck-connecting watchdog. */
  connectingSince?: number | null
  torrent: TorrentLike | null
  /** Timestamp after which a seeding torrent is destroyed and the job removed. */
  seedingDeadline: number | null
  /** Monotonic insertion order; the speed limiter pauses the newest first. */
  queueSeq: number
  /** Set while the aggregate download cap holds this torrent paused. */
  dlLimitedByCap: boolean
  /** Set while the aggregate upload cap holds this torrent paused. */
  ulLimitedByCap: boolean
}

type BencodeValue = Buffer | number | BencodeValue[] | { [key: string]: BencodeValue }

const DOWNLOADS_FILE = 'downloads.json'

let deps: TorrentEngineDeps | null = null
let client: TorrentClientLike | null = null
let enabled = false
const jobs = new Map<string, InternalJob>()
let seqCounter = 0
let broadcastTimer: ReturnType<typeof setInterval> | null = null
let persistTimer: ReturnType<typeof setTimeout> | null = null
let lastBroadcastAt = 0
let broadcastTickCount = 0
let persistDirty = false

// ---- Small utilities ------------------------------------------------------

function log(...args: unknown[]): void {
  console.log('[torrentEngine]', ...args)
}

function warn(...args: unknown[]): void {
  console.warn('[torrentEngine]', ...args)
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

function unref(timer: { unref?: () => void } | null): void {
  if (timer && typeof timer.unref === 'function') timer.unref()
}

function normHash(infoHash: unknown): string {
  return typeof infoHash === 'string' ? infoHash.trim().toLowerCase() : ''
}

/**
 * Sanitize one path segment for Windows: drop `<>:"/\|?*`, control chars and
 * trailing dots/spaces, cap the length. Returns 'download' when nothing sane
 * remains.
 */
export function sanitizePathSegment(raw: string): string {
  const trimmed = (typeof raw === 'string' ? raw : '').replace(
    /[\u0000-\u001f<>:"/\\|?*]/g,
    ''
  )
  let cleaned = trimmed.replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')
  if (!cleaned) return 'download'
  if (cleaned.length > MAX_SEGMENT_LENGTH) {
    cleaned = cleaned.slice(0, MAX_SEGMENT_LENGTH).replace(/[. ]+$/g, '')
  }
  return cleaned || 'download'
}

function isVideoFileName(name: string): boolean {
  const ext = path.extname(name || '').toLowerCase()
  return TORRENT_VIDEO_EXTENSIONS.has(ext)
}

function getSettings(): AppSettings {
  return deps ? deps.getSettings() : ({} as AppSettings)
}

/**
 * The master safety gate: the engine may only ever run when the user enabled
 * P2P AND accepted the consent prompt. Re-read live from settings so a flip
 * in the settings UI is honored by the very next entry-point call.
 */
function isEngineAllowed(s: AppSettings): boolean {
  return s.enableP2P === true && !!s.p2pConsentAcceptedAt
}

/** Both VPN settings default to ON when unset — fail-safe by default. */
function requiresVpnForAdd(s: AppSettings): boolean {
  return s.requireVpnForP2p !== false && s.vpnBlockDownload !== false
}

// ---- Magnet / .torrent helpers -------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode a 32-char base32 btih (BitTorrent v1) into 40 lowercase hex chars. */
function base32ToHex(input: string): string | null {
  let value = 0
  let bits = 0
  const bytes: number[] = []
  for (const char of input.toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(char)
    if (idx === -1) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Extract the v1 info hash from a magnet URI (hex or base32 xt).
 * Returns null when the magnet carries no usable btih.
 */
export function extractInfoHashFromMagnet(magnetUri: string): string | null {
  const hex = /urn:btih:([0-9a-fA-F]{40})/i.exec(magnetUri || '')
  if (hex) return hex[1].toLowerCase()
  const base32 = /urn:btih:([A-Za-z2-7]{32})(?![A-Za-z0-9])/i.exec(magnetUri || '')
  if (base32) {
    const decoded = base32ToHex(base32[1])
    if (decoded && decoded.length === 40) return decoded
  }
  return null
}

function decodeBencode(buf: Buffer, pos: number): { value: BencodeValue; end: number } {
  const c = buf[pos]
  if (c === 0x69 /* i */) {
    const end = buf.indexOf(0x65, pos); // 'e'
    if (end === -1) throw new Error('unterminated integer')
    return { value: Number(buf.slice(pos + 1, end).toString('ascii')), end: end + 1 }
  }
  if (c === 0x6c /* l */) {
    const list: BencodeValue[] = []
    let p = pos + 1
    while (buf[p] !== 0x65) {
      const item = decodeBencode(buf, p)
      list.push(item.value)
      p = item.end
    }
    return { value: list, end: p + 1 }
  }
  if (c === 0x64 /* d */) {
    const dict: { [key: string]: BencodeValue } = {}
    let p = pos + 1
    while (buf[p] !== 0x65) {
      const keyRes = decodeBencode(buf, p)
      const key = (keyRes.value as Buffer).toString('utf-8')
      const valueRes = decodeBencode(buf, keyRes.end)
      dict[key] = valueRes.value
      p = valueRes.end
    }
    return { value: dict, end: p + 1 }
  }
  // string: <len ascii digits> ':' <bytes>
  const colon = buf.indexOf(0x3a, pos); // ':'
  if (colon === -1) throw new Error('unterminated string length')
  const len = Number(buf.slice(pos, colon).toString('ascii'))
  if (!Number.isFinite(len) || len < 0) throw new Error('invalid string length')
  const start = colon + 1
  return { value: buf.slice(start, start + len), end: start + len }
}

function buildMagnetUri(meta: {
  infoHash: string
  name: string | null
  announceUrls: string[]
}): string {
  let uri = `magnet:?xt=urn:btih:${meta.infoHash}`
  if (meta.name) uri += `&dn=${encodeURIComponent(meta.name)}`
  // Keep a bounded tracker list; magnets stay usable without growing huge.
  for (const tracker of meta.announceUrls.slice(0, 20)) {
    uri += `&tr=${encodeURIComponent(tracker)}`
  }
  return uri
}

/**
 * Parse a bencoded .torrent file: compute the v1 info hash (sha1 over the raw
 * `info` dict bytes), pull the display name and tracker URLs, and pre-build a
 * magnet URI so http(s) sources persist like magnet sources. Returns null for
 * anything that is not a valid torrent (fail-closed).
 */
export function extractTorrentMeta(buf: Buffer): TorrentMeta | null {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 8 || buf[0] !== 0x64 /* d */) return null
    let p = 1
    let infoStart = -1
    let infoEnd = -1
    let infoDict: { [key: string]: BencodeValue } | null = null
    const announceUrls: string[] = []
    while (p < buf.length && buf[p] !== 0x65) {
      const keyRes = decodeBencode(buf, p)
      const key = (keyRes.value as Buffer).toString('utf-8')
      const vStart = keyRes.end
      if (key === 'info') {
        const valueRes = decodeBencode(buf, vStart)
        infoStart = vStart
        infoEnd = valueRes.end
        infoDict = valueRes.value as { [key: string]: BencodeValue }
        p = infoEnd
      } else if (key === 'announce') {
        const valueRes = decodeBencode(buf, vStart)
        if (Buffer.isBuffer(valueRes.value)) announceUrls.push(valueRes.value.toString('utf-8'))
        p = valueRes.end
      } else if (key === 'announce-list') {
        const valueRes = decodeBencode(buf, vStart)
        if (Array.isArray(valueRes.value)) {
          for (const tier of valueRes.value) {
            if (!Array.isArray(tier)) continue
            for (const url of tier) {
              if (Buffer.isBuffer(url)) announceUrls.push(url.toString('utf-8'))
            }
          }
        }
        p = valueRes.end
      } else {
        p = decodeBencode(buf, vStart).end
      }
    }
    if (infoStart < 0 || infoEnd <= infoStart) return null
    const infoHash = crypto
      .createHash('sha1')
      .update(buf.subarray(infoStart, infoEnd))
      .digest('hex')
    const nameBuf = infoDict && Buffer.isBuffer(infoDict['name']) ? (infoDict['name'] as Buffer) : null
    const meta: TorrentMeta = {
      infoHash,
      name: nameBuf ? nameBuf.toString('utf-8') : null,
      announceUrls: [...new Set(announceUrls)].filter((u) => /^https?:\/\//i.test(u) || /^udp:\/\//i.test(u) || /^ws(s)?:\/\//i.test(u)),
      magnetUri: '',
    }
    meta.magnetUri = buildMagnetUri(meta)
    return meta
  } catch {
    return null
  }
}

/**
 * Browser-like User-Agent for outbound .torrent fetches — many indexers
 * (nyaa.si included) answer bare Node fetches with 403/Cloudflare pages.
 */
const TORRENT_FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

let cachedNetFetch: typeof fetch | null = null
/**
 * electron.net.fetch goes through Chromium networking (system proxy/VPN aware).
 * ONLY the electron implementation is cached — globalThis.fetch is re-resolved
 * on every call so tests may swap their fetch mocks between cases.
 */
async function resolveFetch(): Promise<typeof fetch> {
  if (cachedNetFetch) return cachedNetFetch
  try {
    const mod: any = await import('electron')
    if (mod && mod.net && typeof mod.net.fetch === 'function') {
      cachedNetFetch = (mod.net.fetch.bind(mod.net) as unknown) as typeof fetch
      return cachedNetFetch
    }
  } catch {
    /* plain Node (tests) → fall through to global fetch */
  }
  const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof globalFetch === 'function') return globalFetch
  throw new Error('no fetch implementation available')
}

/** Fetch a remote .torrent file with a hard 20s timeout. */
async function fetchTorrentBytes(url: string): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TORRENT_FETCH_TIMEOUT_MS)
  unref(timer)
  try {
    const doFetch = await resolveFetch()
    const res = await doFetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': TORRENT_FETCH_UA, Accept: 'application/x-bittorrent, */*' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim())
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0) throw new Error('empty response body')
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Stable public trackers appended to trackerless magnets. DHT alone often
 * strands on a cold routing table (metadata never arrives even for releases
 * with 1000+ seeders), while a single tracker announce fixes peer discovery
 * instantly. These are generic public infrastructure, not indexers — the BYOC
 * rule (no bundled tracker/indexer SITES) still holds.
 */
const FALLBACK_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.open-internet.nl:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
]

/** Append fallback trackers to a magnet URI that carries none. */
export function ensureMagnetTrackers(magnetUri: string): string {
  if (!magnetUri || !magnetUri.startsWith('magnet:')) return magnetUri
  if (/[?&]tr=/i.test(magnetUri)) return magnetUri
  const encoded = FALLBACK_TRACKERS.map((t) => `tr=${encodeURIComponent(t)}`).join('&')
  return `${magnetUri}&${encoded}`
}

// ---- Persistence ------------------------------------------------------------

function persistFilePath(): string {
  return path.join(deps ? deps.persistDir : '.', DOWNLOADS_FILE)
}

/** Statuses worth a queue marker: everything except terminal/steady states. */
function isPersistedStatus(status: TorrentJobStatus): boolean {
  return status === 'queued' || status === 'connecting' || status === 'downloading' || status === 'paused'
}

function persistedJobs(): PersistedDownload[] {
  return [...jobs.values()]
    .filter((job) => isPersistedStatus(job.status) && job.magnetUri)
    .map((job) => ({
      infoHash: job.infoHash,
      magnetUri: job.magnetUri,
      title: job.title,
      anilistId: job.anilistId,
      targetFolder: job.targetFolder,
      episode: job.episode,
      addedAt: job.addedAt,
    }))
}

/** Atomic write: tmp file + rename. Never leaves a half-written marker file. */
function writePersistFileNow(): void {
  if (!deps) return
  persistDirty = false
  try {
    fs.mkdirSync(deps.persistDir, { recursive: true })
    const payload: PersistedDownloadsFile = {
      version: 1,
      savedAt: Date.now(),
      jobs: persistedJobs(),
    }
    const tmp = persistFilePath() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    fs.renameSync(tmp, persistFilePath())
  } catch (err) {
    warn('failed to persist downloads.json:', errMsg(err))
  }
}

/** Debounced (2s) persistence on every job state change. */
function schedulePersist(): void {
  persistDirty = true
  if (persistTimer || !deps) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (persistDirty) writePersistFileNow()
  }, PERSIST_DEBOUNCE_MS)
  unref(persistTimer)
}

/**
 * Re-add persisted unfinished jobs as silent 'queued' entries. Completed and
 * errored jobs are never persisted, so every marker here is real work.
 */
function resumePersistedJobs(): number {
  let entries: PersistedDownload[] = []
  try {
    const raw = fs.readFileSync(persistFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as PersistedDownloadsFile | PersistedDownload[]
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.jobs) ? parsed.jobs : [])
    entries = list.filter(
      (e) => e && typeof e.infoHash === 'string' && typeof e.magnetUri === 'string' && e.magnetUri.length > 0
    )
  } catch {
    return 0; // missing or unreadable marker file → nothing to resume
  }
  const s = getSettings()
  let added = 0
  for (const entry of entries) {
    const infoHash = normHash(entry.infoHash)
    if (!infoHash || jobs.has(infoHash)) continue
    const base =
      entry.targetFolder ||
      s.downloadTargetFolder ||
      (Array.isArray(s.libraryFolders) && s.libraryFolders.length > 0 ? s.libraryFolders[0] : undefined)
    if (!base) continue
    jobs.set(infoHash, {
      infoHash,
      title: typeof entry.title === 'string' ? entry.title : infoHash,
      anilistId: typeof entry.anilistId === 'number' ? entry.anilistId : null,
      episode: typeof entry.episode === 'number' ? entry.episode : null,
      targetFolder: base,
      downloadDir: path.join(base, sanitizePathSegment(entry.title || infoHash)),
      magnetUri: entry.magnetUri,
      sourceBuffer: null,
      status: 'queued',
      addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : Date.now(),
      completedAt: null,
      torrent: null,
      seedingDeadline: null,
      queueSeq: seqCounter++,
      dlLimitedByCap: false,
      ulLimitedByCap: false,
    })
    added += 1
  }
  if (added > 0) {
    log(`resumed ${added} persisted download(s)`)
    schedulePersist()
  }
  return added
}

// ---- State broadcast --------------------------------------------------------

function toTorrentJob(job: InternalJob): TorrentJob {
  const t = job.torrent
  const progress = t && typeof t.progress === 'number' ? Math.max(0, Math.min(100, t.progress * 100)) : 0
  return {
    infoHash: job.infoHash,
    name: (t && typeof t.name === 'string' && t.name) || sanitizePathSegment(job.title),
    title: job.title,
    anilistId: job.anilistId ?? null,
    targetFolder: job.targetFolder,
    magnetUri: job.magnetUri,
    status: job.status,
    progress: Math.round(progress * 100) / 100,
    downloadedBytes: t && typeof t.downloaded === 'number' ? t.downloaded : 0,
    totalBytes: t && typeof t.length === 'number' ? t.length : 0,
    downloadSpeed: t && typeof t.downloadSpeed === 'number' ? t.downloadSpeed : 0,
    uploadSpeed: t && typeof t.uploadSpeed === 'number' ? t.uploadSpeed : 0,
    peers: t && typeof t.numPeers === 'number' ? t.numPeers : 0,
    episode: job.episode ?? null,
    error: job.error,
    addedAt: job.addedAt,
    completedAt: job.completedAt ?? null,
  }
}

/**
 * Full P2pState snapshot. Always returns a complete object — even before
 * init — so the UI can render disabled state without null checks.
 */
export function engineGetState(): P2pState {
  const s = getSettings()
  return {
    enabled,
    consentAccepted: !!s.p2pConsentAcceptedAt,
    jobs: [...jobs.values()].map(toTorrentJob),
    limits: {
      maxConcurrent: typeof s.maxConcurrentDownloads === 'number' ? s.maxConcurrentDownloads : 2,
      downloadSpeedMBps: typeof s.downloadSpeedLimitMBps === 'number' ? s.downloadSpeedLimitMBps : 0,
      uploadSpeedMBps: typeof s.uploadSpeedLimitMBps === 'number' ? s.uploadSpeedLimitMBps : 0,
      seedMinutes: typeof s.seedMinutesAfterComplete === 'number' ? s.seedMinutesAfterComplete : 0,
    },
  }
}

function emitState(): void {
  if (!deps) return
  try {
    deps.onState(engineGetState())
  } catch (err) {
    warn('onState callback failed:', errMsg(err))
  }
}

/** Immediate push for state-changing operations (add/pause/resume/cancel). */
function broadcastNow(): void {
  lastBroadcastAt = Date.now()
  emitState()
}

/** Periodic push while jobs exist, throttled to at most 1/s. */
function broadcastThrottled(): void {
  if (jobs.size === 0) return
  const now = Date.now()
  if (now - lastBroadcastAt < BROADCAST_TICK_MS) return
  lastBroadcastAt = now
  emitState()
}

// ---- Client lifecycle -------------------------------------------------------

function attachClientHandlers(c: TorrentClientLike): void {
  if (typeof c.on !== 'function') return
  c.on('error', (...args: unknown[]) => {
    const err = args[0] as (Error & { infoHash?: string }) | undefined
    warn('client error:', errMsg(err))
    // Map client-level errors onto their job when the hash is known.
    const hash = normHash(err && err.infoHash)
    if (!hash) return
    const job = jobs.get(hash)
    if (!job || job.status === 'error') return
    job.status = 'error'
    job.error = errMsg(err)
    broadcastNow()
    schedulePersist()
  })
  c.on('torrent', (...args: unknown[]) => {
    const torrent = args[0] as TorrentLike | undefined
    if (torrent) handleTorrentReady(torrent)
  })
}

/**
 * Load webtorrent lazily and create the client. NEVER called at module load —
 * offline tests inject `createClient` and never reach the dynamic import.
 * Returns null whenever the settings gate is closed.
 */
async function ensureClient(): Promise<TorrentClientLike | null> {
  const s = getSettings()
  if (!deps || !isEngineAllowed(s)) return null
  if (client) return client
  if (deps.createClient) {
    client = deps.createClient()
  } else {
    // webtorrent ships no type declarations and must stay out of the module
    // graph until P2P is actually used (test isolation + bundle external).
    // @ts-ignore -- untyped ESM-only dependency, loaded lazily on purpose
    const { default: Client } = await import('webtorrent')
    client = new Client() as unknown as TorrentClientLike
  }
  attachClientHandlers(client)
  startTimers()
  log('torrent client created')
  return client
}

async function destroyClientQuietly(c: TorrentClientLike): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const guard = setTimeout(finish, DESTROY_GUARD_MS)
    unref(guard)
    try {
      c.destroy(() => finish())
    } catch {
      finish(); // already destroyed or synchronous failure — either way we're done
    }
  })
}

// ---- Torrent lifecycle ------------------------------------------------------

function destroyTorrentQuietly(torrent: TorrentLike, removeStore: boolean): void {
  try {
    // webtorrent only deletes files when destroyStore is true; leaving the
    // store intact is the default and what every non-cancel path uses.
    torrent.destroy(removeStore ? { destroyStore: true } : undefined, () => {})
  } catch (err) {
    warn('torrent destroy failed:', errMsg(err))
  }
}

function setJobStatus(job: InternalJob, status: TorrentJobStatus): void {
  if (job.status === status) return
  job.status = status
  broadcastThrottled()
  schedulePersist()
}

function attachTorrentHandlers(job: InternalJob, torrent: TorrentLike): void {
  torrent.on('error', (...args: unknown[]) => {
    const err = args[0]
    if (jobs.get(job.infoHash) !== job || job.torrent !== torrent) return
    job.status = 'error'
    job.error = errMsg(err) || 'torrent error'
    job.seedingDeadline = null
    warn(`job ${job.infoHash} failed: ${job.error}`)
    broadcastNow()
    schedulePersist()
  })
  torrent.on('done', () => onTorrentDone(job, torrent))
  torrent.on('warning', () => {
    /* warnings are non-fatal (tracker timeouts etc.) — ignored */
  })
}

/**
 * Metadata for a torrent became available (client 'torrent' event). Registers
 * handlers, records the canonical magnet URI and applies selective download.
 */
function handleTorrentReady(torrent: TorrentLike): void {
  const infoHash = normHash(torrent.infoHash)
  const job = jobs.get(infoHash)
  if (!job) {
    // Cancel raced activation: the torrent was added but its job is already
    // gone from the queue — stop the swarm WITHOUT deleting files.
    destroyTorrentQuietly(torrent, false)
    return
  }
  if (job.torrent) return; // already handled (duplicate 'torrent' event)
  job.torrent = torrent
  if (typeof torrent.magnetURI === 'string' && torrent.magnetURI) job.magnetUri = torrent.magnetURI
  attachTorrentHandlers(job, torrent)
  void applySelectiveDownload(job, torrent)
  if (job.status === 'paused') {
    // User paused while metadata was still loading — keep it paused.
    try {
      torrent.pause()
    } catch {
      /* ignore */
    }
    return
  }
  if (job.status === 'queued' || job.status === 'connecting') setJobStatus(job, 'downloading')
  broadcastThrottled()
}

/**
 * Selective episode download. Runs once per torrent once metadata is ready
 * and only when the caller targeted a specific episode:
 * - non-video files (.nfo/.jpg/...) are always deselected
 * - video files whose parsed episode set does NOT contain the target are
 *   deselected
 * - when no file parses to any episode the torrent downloads as-is (all
 *   files) — we never guess and never leave the user with nothing.
 */
async function applySelectiveDownload(job: InternalJob, torrent: TorrentLike): Promise<void> {
  if (job.episode == null) return
  const files = Array.isArray(torrent.files) ? torrent.files : []
  if (files.length === 0) return
  let matchedAny = false
  let deselected = 0
  let selectedVideos = 0
  for (const file of files) {
    if (!file || typeof file.name !== 'string') continue
    if (!isVideoFileName(file.name)) {
      try {
        file.deselect()
        deselected += 1
      } catch {
        /* ignore */
      }
      continue
    }
    try {
      const parsed = await parseRelease(file.name, { preferAnitomyEpisode: true })
      const eps = Array.isArray(parsed?.episodeNumbers) ? parsed.episodeNumbers : []
      if (eps.length === 0) {
        selectedVideos += 1; // unparseable video → keep it selected
        continue
      }
      matchedAny = true
      if (!eps.includes(job.episode)) {
        try {
          file.deselect()
          deselected += 1
        } catch {
          /* ignore */
        }
      } else {
        selectedVideos += 1
      }
    } catch {
      selectedVideos += 1; // parse failure → keep the file selected (safe default)
    }
  }
  if (!matchedAny) {
    log(
      `no file in "${job.title}" parsed to an episode number — downloading ALL files`
    )
  } else if (selectedVideos === 0) {
    warn(
      `target episode ${job.episode} found in NO file of "${job.title}" — nothing selected, download will stall`
    )
  }
  if (deselected > 0) log(`selective download: deselected ${deselected} file(s) in "${job.title}"`)
}

function onTorrentDone(job: InternalJob, torrent: TorrentLike): void {
  if (jobs.get(job.infoHash) !== job || job.torrent !== torrent) return
  const s = getSettings()
  const seedMinutes = Math.max(0, typeof s.seedMinutesAfterComplete === 'number' ? s.seedMinutesAfterComplete : 0)
  job.completedAt = Date.now()
  if (seedMinutes <= 0) {
    // Stop seeding IMMEDIATELY but keep every file: destroy() without
    // destroyStore only tears down the swarm connection and store handle.
    setJobStatus(job, 'completed')
    broadcastNow()
    destroyTorrentQuietly(torrent, false)
    jobs.delete(job.infoHash)
    schedulePersist()
    broadcastNow()
    runScheduler()
    return
  }
  setJobStatus(job, 'seeding')
  job.seedingDeadline = Date.now() + seedMinutes * 60_000
  broadcastNow()
}

// ---- Queue scheduling -------------------------------------------------------

/**
 * Promote queued jobs while free download slots exist. Concurrency is
 * re-read from settings on every pass so `maxConcurrentDownloads` changes
 * apply without a restart. Slots are held from 'connecting' until 'seeding'
 * user-paused and seeding jobs do not count against the limit.
 */
function runScheduler(): void {
  if (!client) return
  const s = getSettings()
  const max = Math.max(1, typeof s.maxConcurrentDownloads === 'number' ? Math.floor(s.maxConcurrentDownloads) : 2)
  let freeSlots = max - [...jobs.values()].filter((j) => j.status === 'connecting' || j.status === 'downloading').length
  if (freeSlots <= 0) return
  const queued = [...jobs.values()]
    .filter((j) => j.status === 'queued')
    .sort((a, b) => a.queueSeq - b.queueSeq)
  for (const job of queued) {
    if (freeSlots <= 0) break
    freeSlots -= 1
    void activateJob(job)
  }
}

/** Move a queued job into the client ('connecting'). Never throws. */
async function activateJob(job: InternalJob): Promise<void> {
  const s = getSettings()
  if (!isEngineAllowed(s)) return; // gate closed → stays queued until teardown
  // Claim the slot SYNCHRONOUSLY so concurrent scheduler passes can never
  // double-activate the same job while ensureClient() is awaiting.
  setJobStatus(job, 'connecting')
  const c = await ensureClient()
  if (jobs.get(job.infoHash) !== job) return; // cancelled mid-flight
  if (!c) {
    setJobStatus(job, 'queued'); // gate closed during activation — rejoin queue
    return
  }
  try {
    fs.mkdirSync(job.downloadDir, { recursive: true })
  } catch (err) {
    warn('could not create download dir:', errMsg(err))
  }
  const payload: string | Buffer = job.sourceBuffer ?? ensureMagnetTrackers(job.magnetUri)
  job.connectingSince = Date.now()
  try {
    c.add(payload, { path: job.downloadDir }, undefined)
  } catch (err) {
    job.status = 'error'
    job.error = errMsg(err) || 'failed to add torrent to client'
    broadcastNow()
    schedulePersist()
  }
}

// ---- Speed limits (documented approximation) --------------------------------

/**
 * Enforce the aggregate download/upload caps. APPROXIMATION by design: the
 * 2s tick measures each torrent's current speed, and while the measured
 * total exceeds the cap the NEWEST offending torrent is paused (one per
 * tick); once the total falls below 80% of the cap the OLDEST cap-paused
 * torrent is resumed. Measurement lag puts the equilibrium within roughly
 * ±10% of the configured cap — users needing precise limits should use an
 * external client instead (the FS heuristics in torrents.ts keep working).
 */
function enforceSpeedLimits(s: AppSettings): void {
  if (!client) return
  const dlCapBps = Math.max(0, s.downloadSpeedLimitMBps ?? 0) * 1024 * 1024
  const ulCapBps = Math.max(0, s.uploadSpeedLimitMBps ?? 0) * 1024 * 1024
  const live = [...jobs.values()].filter(
    (j) => j.torrent && (j.status === 'connecting' || j.status === 'downloading' || j.status === 'seeding')
  )
  if (live.length === 0) return

  const speedOf = (job: InternalJob, field: 'downloadSpeed' | 'uploadSpeed'): number => {
    const t = job.torrent as TorrentLike
    return typeof t[field] === 'number' && t[field] > 0 ? t[field] : 0
  }

  if (dlCapBps > 0) {
    const downloading = live.filter((j) => j.status === 'connecting' || j.status === 'downloading')
    const totalDl = downloading.reduce((sum, j) => sum + speedOf(j, 'downloadSpeed'), 0)
    if (totalDl > dlCapBps) {
      const victim = downloading
        .filter((j) => !j.dlLimitedByCap)
        .sort((a, b) => b.queueSeq - a.queueSeq)[0]; // newest first
      if (victim) {
        try {
          (victim.torrent as TorrentLike).pause()
        } catch {
          /* ignore */
        }
        victim.dlLimitedByCap = true
        log(`download cap: throttling newest torrent (${Math.round(totalDl / 1048576)} MB/s > cap)`)
      }
    } else if (totalDl < dlCapBps * 0.8) {
      const victim = downloading
        .filter((j) => j.dlLimitedByCap)
        .sort((a, b) => a.queueSeq - b.queueSeq)[0]; // oldest first
      if (victim) {
        try {
          (victim.torrent as TorrentLike).resume()
        } catch {
          /* ignore */
        }
        victim.dlLimitedByCap = false
      }
    }
  }

  if (ulCapBps > 0) {
    const uploading = live.filter((j) => j.status === 'seeding' || j.status === 'downloading')
    const totalUl = uploading.reduce((sum, j) => sum + speedOf(j, 'uploadSpeed'), 0)
    if (totalUl > ulCapBps) {
      // Upload throttling pauses seeding torrents first — downloading ones
      // keep their (user-priority) download share.
      const candidates = uploading
        .filter((j) => j.status === 'seeding' && !j.ulLimitedByCap)
        .sort((a, b) => b.queueSeq - a.queueSeq)
      const victim = candidates[0]
      if (victim) {
        try {
          (victim.torrent as TorrentLike).pause()
        } catch {
          /* ignore */
        }
        victim.ulLimitedByCap = true
      }
    } else if (totalUl < ulCapBps * 0.8) {
      const victim = uploading
        .filter((j) => j.ulLimitedByCap)
        .sort((a, b) => a.queueSeq - b.queueSeq)[0]
      if (victim) {
        try {
          (victim.torrent as TorrentLike).resume()
        } catch {
          /* ignore */
        }
        victim.ulLimitedByCap = false
      }
    }
  }
}

/** Destroy + remove seeding jobs whose seed window has elapsed (files kept). */
function expireSeedingJobs(): void {
  if (jobs.size === 0) return
  const now = Date.now()
  for (const job of [...jobs.values()]) {
    if (job.status !== 'seeding' || job.seedingDeadline == null) continue
    if (now < job.seedingDeadline) continue
    setJobStatus(job, 'completed')
    broadcastNow()
    if (job.torrent) destroyTorrentQuietly(job.torrent, false); // files kept
    jobs.delete(job.infoHash)
    schedulePersist()
    broadcastNow()
    runScheduler()
  }
}

/**
 * Kill switch for eternally-stuck 'connecting' jobs: when metadata never
 * arrives within the window, surface a clear, actionable error instead of
 * spinning forever (typically a dead/rare release or a hostile network).
 */
function expireStuckConnectingJobs(): void {
  if (jobs.size === 0) return
  const now = Date.now()
  for (const job of [...jobs.values()]) {
    if (job.status !== 'connecting' || !job.connectingSince) continue
    if (now - job.connectingSince < CONNECTING_TIMEOUT_MS) continue
    job.status = 'error'
    job.error = 'No peers or metadata received — the release looks dead or unreachable. Cancel it and pick a different release (more seeders = better).'
    job.connectingSince = null
    if (job.torrent) destroyTorrentQuietly(job.torrent, false)
    warn(`job ${job.infoHash} stuck connecting > ${CONNECTING_TIMEOUT_MS / 1000}s — marked as error`)
    broadcastNow()
    schedulePersist()
    runScheduler()
  }
}

function startTimers(): void {
  if (broadcastTimer) return
  broadcastTickCount = 0
  broadcastTimer = setInterval(() => {
    broadcastTickCount += 1
    const s = getSettings()
    if (!client) return
    if (broadcastTickCount % 2 === 0) enforceSpeedLimits(s); // 2s speed cadence
    expireSeedingJobs()
    expireStuckConnectingJobs()
    broadcastThrottled(); // ≤1/s while jobs exist
  }, BROADCAST_TICK_MS)
  unref(broadcastTimer)
}

function stopTimers(): void {
  if (broadcastTimer) {
    clearInterval(broadcastTimer)
    broadcastTimer = null
  }
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
}

// ---- Contract: init / enable / disable -------------------------------------

/**
 * Wire engine dependencies. Idempotent; the LAST call wins (deps are simply
 * replaced). When settings already allow P2P (enableP2P + consent present)
 * and no client exists yet, the engine auto-starts and silently resumes any
 * persisted unfinished jobs. It never auto-disables on re-init — disabling is
 * always an explicit engineSetEnabled(false).
 */
export function initTorrentEngine(incoming: TorrentEngineDeps): void {
  if (!incoming || typeof incoming.getSettings !== 'function' || typeof incoming.onState !== 'function') {
    throw new Error('initTorrentEngine: getSettings and onState deps are required')
  }
  if (!incoming.persistDir || typeof incoming.persistDir !== 'string') {
    throw new Error('initTorrentEngine: persistDir is required')
  }
  deps = incoming
  const s = getSettings()
  if (!client && isEngineAllowed(s)) {
    log('auto-starting: P2P enabled and consent accepted in settings')
    void engineSetEnabled(true).catch((err) => warn('auto-start failed:', errMsg(err)))
  }
}

/**
 * Enable or disable the engine.
 *
 * enable=true: re-checked consent gate → client created (lazily importing
 * webtorrent in production) → persisted unfinished jobs re-added → scheduler
 * runs. enable=false: unfinished queue markers are persisted FIRST, the
 * client is destroyed (files are ALWAYS kept), and in-memory jobs are cleared
 * entirely — the jobs list becomes empty, not 'completed'.
 */
export async function engineSetEnabled(wantEnabled: boolean): Promise<EngineOpResult> {
  if (!deps) return { success: false, error: 'Torrent engine is not initialized' }
  const s = getSettings()
  if (wantEnabled) {
    if (!isEngineAllowed(s)) {
      return {
        success: false,
        error: 'P2P cannot start: enableP2P is off or the P2P consent has not been accepted in settings',
      }
    }
    const c = await ensureClient()
    if (!c) {
      return { success: false, error: 'P2P was toggled off in settings while the engine was starting' }
    }
    enabled = true
    resumePersistedJobs()
    runScheduler()
    broadcastNow()
    return { success: true }
  }
  if (!enabled && !client) return { success: true }; // already disabled
  writePersistFileNow(); // queue markers BEFORE the memory wipe
  const c = client
  client = null
  enabled = false
  stopTimers()
  jobs.clear(); // jobs leave memory entirely — files on disk are untouched
  if (c) await destroyClientQuietly(c)
  log('engine disabled — downloaded files kept, unfinished jobs persisted')
  broadcastNow()
  return { success: true }
}

// ---- Contract: add / pause / resume / cancel --------------------------------

export async function engineAddDownload(params: {
  item: ReleaseSearchResult
  title: string
  anilistId?: number | null
  episode?: number | null
  targetFolder?: string
}): Promise<EngineOpResult> {
  if (!deps) return { success: false, error: 'Torrent engine is not initialized' }
  const s = getSettings()
  if (!isEngineAllowed(s)) {
    return {
      success: false,
      error: 'P2P is disabled — enable P2P and accept the consent prompt in settings before downloading',
    }
  }
  if (!enabled && !client) {
    return { success: false, error: 'Torrent engine is disabled — call engineSetEnabled(true) first' }
  }

  // VPN guard — both settings default ON; a failed probe fails CLOSED.
  if (requiresVpnForAdd(s)) {
    let vpn: VpnStatus | null = null
    try {
      const probe = deps.detectVpn ? deps.detectVpn() : detectVpnStatus()
      vpn = probe instanceof Promise ? await probe : probe
    } catch (err) {
      return { success: false, error: `VPN check failed — download refused: ${errMsg(err)}` }
    }
    if (!vpn || vpn.active !== true) {
      return {
        success: false,
        error: 'VPN tunnel not detected — download blocked by your P2P safety settings',
      }
    }
  }

  const item = params && params.item
  const downloadUrl = item && typeof item.downloadUrl === 'string' ? item.downloadUrl.trim() : ''
  if (!downloadUrl) return { success: false, error: 'Release has no downloadUrl' }

  let magnetUri = ''
  let sourceBuffer: Buffer | null = null
  let infoHash: string | null = null

  if (downloadUrl.startsWith('magnet:')) {
    magnetUri = downloadUrl
    infoHash = extractInfoHashFromMagnet(magnetUri)
    if (!infoHash) return { success: false, error: 'Magnet URI carries no usable btih hash' }
  } else if (/^https?:\/\//i.test(downloadUrl)) {
    // Remote .torrent: fetch first (20s timeout), then queue like a magnet.
    try {
      sourceBuffer = await fetchTorrentBytes(downloadUrl)
    } catch (err) {
      return { success: false, error: `Failed to fetch .torrent file: ${errMsg(err)}` }
    }
    const meta = extractTorrentMeta(sourceBuffer)
    if (!meta) return { success: false, error: 'Downloaded data is not a valid .torrent file' }
    infoHash = meta.infoHash
    magnetUri = meta.magnetUri
  } else {
    return { success: false, error: 'downloadUrl must be a magnet: URI or an http(s) .torrent link' }
  }

  if (jobs.has(infoHash)) return { success: false, error: 'This torrent is already in the download queue' }

  const base =
    (params && params.targetFolder) ||
    s.downloadTargetFolder ||
    (Array.isArray(s.libraryFolders) && s.libraryFolders.length > 0 ? s.libraryFolders[0] : undefined)
  if (!base) {
    return {
      success: false,
      error: 'No download folder configured — set downloadTargetFolder or a library folder in settings',
    }
  }

  const title = params && typeof params.title === 'string' && params.title ? params.title : infoHash
  const job: InternalJob = {
    infoHash,
    title,
    anilistId: params && typeof params.anilistId === 'number' ? params.anilistId : null,
    episode: params && typeof params.episode === 'number' ? params.episode : null,
    targetFolder: base,
    downloadDir: path.join(base, sanitizePathSegment(title)),
    magnetUri,
    sourceBuffer,
    status: 'queued',
    addedAt: Date.now(),
    completedAt: null,
    torrent: null,
    seedingDeadline: null,
    queueSeq: seqCounter++,
    dlLimitedByCap: false,
    ulLimitedByCap: false,
  }
  jobs.set(infoHash, job)
  schedulePersist()
  broadcastNow()
  runScheduler()
  return { success: true, infoHash }
}

export function enginePause(infoHash: string): EngineOpResult {
  const job = jobs.get(normHash(infoHash))
  if (!job) return { success: false, error: 'Unknown download' }
  if (job.status === 'paused') return { success: true }; // idempotent
  if (job.torrent) {
    try {
      job.torrent.pause()
    } catch (err) {
      return { success: false, error: errMsg(err) }
    }
  }
  // A user pause overrides any cap-based throttling state.
  job.dlLimitedByCap = false
  job.ulLimitedByCap = false
  setJobStatus(job, 'paused')
  broadcastNow()
  runScheduler(); // paused jobs hold no download slot → promote queued work
  return { success: true }
}

export function engineResume(infoHash: string): EngineOpResult {
  const job = jobs.get(normHash(infoHash))
  if (!job) return { success: false, error: 'Unknown download' }
  if (job.status !== 'paused') return { success: true }; // idempotent
  if (job.torrent) {
    try {
      job.torrent.resume()
    } catch (err) {
      return { success: false, error: errMsg(err) }
    }
    setJobStatus(job, 'downloading')
  } else {
    setJobStatus(job, 'queued'); // was paused before activation — rejoin the queue
    runScheduler()
  }
  broadcastNow()
  return { success: true }
}

/**
 * Cancel a job. Files are deleted ONLY when `removeFiles` is true (the
 * torrent is destroyed with destroyStore, which is webtorrent's only
 * deletion path). Otherwise files stay exactly as they are.
 */
export async function engineCancel(infoHash: string, removeFiles = false): Promise<EngineOpResult> {
  const key = normHash(infoHash)
  const job = jobs.get(key)
  if (!job) return { success: false, error: 'Unknown download' }
  jobs.delete(key)
  const torrent = job.torrent
  job.torrent = null
  if (torrent) {
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const guard = setTimeout(finish, DESTROY_GUARD_MS)
      unref(guard)
      try {
        torrent.destroy(removeFiles ? { destroyStore: true } : undefined, () => finish())
      } catch {
        finish()
      }
    })
  }
  schedulePersist(); // marker drops out of downloads.json
  broadcastNow()
  runScheduler(); // freed slot (if any) → promote queued jobs
  return { success: true }
}

// ---- Contract: shutdown ------------------------------------------------------

/**
 * before-quit hook: persist unfinished queue markers synchronously, stop all
 * timers and destroy the client fire-and-forget (files are always kept).
 * Safe to call multiple times; after shutdown the engine is inert until the
 * next initTorrentEngine.
 */
export function engineShutdown(): void {
  stopTimers()
  if (deps && persistDirty) writePersistFileNow()
  const c = client
  client = null
  enabled = false
  jobs.clear()
  if (c) {
    try {
      c.destroy(() => {})
    } catch {
      /* already destroyed */
    }
  }
  log('engine shutdown complete')
}
