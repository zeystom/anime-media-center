/**
 * Simplified BitTorrent download engine (Phase 5).
 *
 * Removed: VPN guard. The engine is a wrapper over webtorrent with:
 * - Queue management with concurrency limits
 * - Magnet and .torrent file support (fetched through electron.net.fetch so
 *   system proxy setups work)
 * - Selective per-episode download (webtorrent default-selects EVERYTHING, and
 *   torrent.done/progress count every file — so completion and progress are
 *   tracked over the SELECTED files instead, or deselected files would leave a
 *   job stuck at e.g. 11% "downloading" forever while occupying a queue slot)
 * - Persistence of unfinished jobs
 * - Seeding with a per-job deadline
 * - A stuck-connecting watchdog for magnets whose metadata never arrives
 */

import fs from 'fs'
import path from 'path'
import { parseReleaseCore } from '../src/lib/releaseParser/regexEngine.ts'
import type { AppSettings, TorrentJob, TorrentJobStatus, ReleaseSearchResult } from './types.ts'

const MAX_SEGMENT_LENGTH = 100

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
  bitfield?: { get: (index: number) => boolean }
  wires?: Array<{ peerPieces?: { get: (index: number) => boolean } }>
  pieceLength?: number
  critical?: (start: number, end: number) => void
  timeRemaining?: number
  pause: () => void
  resume: () => void
  destroy: (opts?: { destroyStore?: boolean } | null, cb?: () => void) => void
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
}

export interface TorrentFileLike {
  name: string
  /** Path relative to torrent root (provided by WebTorrent). */
  path?: string
  length?: number
  progress?: number
  /** webtorrent marks a file complete when every piece in its range is verified */
  done?: boolean
  /** WebTorrent's current file-to-piece range, used for live swarm diagnostics. */
  _startPiece?: number
  _endPiece?: number
  select?: () => void
  deselect?: () => void
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
}

interface InternalJob {
  infoHash: string
  title: string
  releaseTitle?: string
  anilistId: number | null
  episode: number | null
  targetFolder: string
  downloadDir: string
  magnetUri: string
  status: TorrentJobStatus
  addedAt: number
  completedAt: number | null
  error?: string
  torrent: TorrentLike | null
  /** WebTorrent creates this object before magnet metadata is available. */
  connectingTorrent?: TorrentLike | null
  seedingDeadline: number | null
  queueSeq: number
  /** Requested episode for selective download; null = whole season pack */
  requestedEpisode: number | null
  /** Requested episode set; null means select the whole season pack. */
  requestedEpisodes: number[] | null
  requestedSeason?: number | null
  /** Track if we've already attempted file selection */
  fileSelectionDone: boolean
  /** Per-file progress for UI */
  filesProgress: Array<{ name: string; progress: number; length: number }>
  /** Timestamp when job entered 'connecting' state */
  connectingSince?: number
  /** Monotonic progress sample used to distinguish a stalled swarm from metadata loading. */
  lastProgressBytes?: number
  lastProgressAt?: number
  missingPieces?: number
  availableMissingPieces?: number
  stallRecoveryCount?: number
  lastWarning?: string
  lastCriticalAt?: number
  recoveryInProgress?: boolean
  /** Seed count shown by the provider at search time (a potentially stale snapshot). */
  reportedSeeders?: number | null
  providerName?: string
  /** Files left selected by the selective-download pass; null = whole torrent kept (webtorrent default) */
  selectedFiles: TorrentFileLike[] | null
  /** How many of selectedFiles have completed */
  selectedDone: number
  /** Progress over the selected files only (0..1); null until the first progress tick */
  selectedProgress: number | null
  /** Sum of selectedFiles lengths, drives the UI byte counters for episode jobs */
  selectedTotalBytes: number
  /** Torrent stage directory is nested under the anime folder to keep files on one volume. */
  animeFolder: string
  /** Speed limit flags (legacy, kept for compatibility) */
  dlLimitedByCap?: boolean
  ulLimitedByCap?: boolean
}

const DOWNLOADS_FILE = 'downloads.json'

let deps: { getSettings: () => AppSettings; onState: (state: any) => void; persistDir: string; createClient?: () => TorrentClientLike } | null = null
let client: TorrentClientLike | null = null
let enabled = false
const jobs = new Map<string, InternalJob>()
const diagnosedTorrents = new WeakSet<TorrentLike>()
let seqCounter = 0

// ---- Utilities ---------------------------------------------------------------

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

function normHash(infoHash: unknown): string {
  return typeof infoHash === 'string' ? infoHash.trim().toLowerCase() : ''
}

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

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

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
  if (c === 0x69) {
    const end = buf.indexOf(0x65, pos);
    if (end === -1) throw new Error('unterminated integer')
    return { value: Number(buf.slice(pos + 1, end).toString('ascii')), end: end + 1 }
  }
  if (c === 0x6c) {
    const list: BencodeValue[] = []
    let p = pos + 1
    while (buf[p] !== 0x65) {
      const item = decodeBencode(buf, p)
      list.push(item.value)
      p = item.end
    }
    return { value: list, end: p + 1 }
  }
  if (c === 0x64) {
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
  const colon = buf.indexOf(0x3a, pos);
  if (colon === -1) throw new Error('unterminated string length')
  const len = Number(buf.slice(pos, colon).toString('ascii'))
  if (!Number.isFinite(len) || len < 0) throw new Error('invalid string length')
  const start = colon + 1
  return { value: buf.slice(start, start + len), end: start + len }
}

type BencodeValue = Buffer | number | BencodeValue[] | { [key: string]: BencodeValue }

interface TorrentMeta {
  infoHash: string
  name: string | null
  announceUrls: string[]
  magnetUri: string
}

function buildMagnetUri(meta: { infoHash: string; name: string | null; announceUrls: string[] }): string {
  let uri = `magnet:?xt=urn:btih:${meta.infoHash}`
  if (meta.name) uri += `&dn=${encodeURIComponent(meta.name)}`
  for (const tracker of meta.announceUrls.slice(0, 20)) {
    uri += `&tr=${encodeURIComponent(tracker)}`
  }
  return uri
}

export function extractTorrentMeta(buf: Buffer): TorrentMeta | null {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 8 || buf[0] !== 0x64) return null
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

import crypto from 'crypto'

const FALLBACK_TRACKERS = [
  // High-availability public UDP trackers
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.bitsearch.to:1337/announce',
  'udp://tracker.filemail.com:6969/announce',
  'udp://tracker.open-internet.nl:6969/announce',
  // HTTP/HTTPS fallbacks (vital when UDP is blocked by ISP/firewall/VPN)
  'http://tracker.opentrackr.org:1337/announce',
  'http://tracker.dler.org:6969/announce',
  'http://open.tracker.cl:1337/announce',
  'http://tracker.files.fm:6969/announce',
  'http://tracker.gbitt.info:80/announce',
  // WebTorrent WebSocket swarms
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
]

export function ensureMagnetTrackers(magnetUri: string): string {
  if (!magnetUri || !magnetUri.startsWith('magnet:')) return magnetUri

  // Extract all existing trackers in the magnet URI to prevent duplicates
  const normTracker = (t: string) => t.toLowerCase().replace(/\/+$/, '')
  const existingTrackers = new Set<string>()
  const trMatches = magnetUri.matchAll(/[?&]tr=([^&]+)/gi)
  for (const m of trMatches) {
    try {
      existingTrackers.add(normTracker(decodeURIComponent(m[1])))
    } catch {
      existingTrackers.add(normTracker(m[1]))
    }
  }

  const toAdd: string[] = []
  for (const tracker of FALLBACK_TRACKERS) {
    if (!existingTrackers.has(normTracker(tracker))) {
      toAdd.push(`tr=${encodeURIComponent(tracker)}`)
    }
  }

  if (toAdd.length === 0) return magnetUri
  const delimiter = magnetUri.includes('?') ? '&' : '?'
  return `${magnetUri}${delimiter}${toAdd.join('&')}`
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }>

/**
 * electron.net.fetch honors the system proxy; plain node fetch does not and
 * cannot reach most indexers on proxied machines. Only the electron
 * implementation is cached — caching globalThis.fetch would freeze test mocks
 * that reassign it between cases (documented trap).
 */
let electronNetFetch: FetchLike | undefined
async function resolveFetch(): Promise<FetchLike> {
  if (electronNetFetch !== undefined) return electronNetFetch
  try {
    const electron = (await import('electron')) as unknown as {
      net?: { fetch?: FetchLike }
    }
    if (electron && electron.net && typeof electron.net.fetch === 'function') {
      electronNetFetch = electron.net.fetch.bind(electron.net)
      return electronNetFetch
    }
  } catch {}
  // Plain node (tests): read globalThis.fetch at call time.
  return ((url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) =>
    globalThis.fetch(url, init as RequestInit)) as FetchLike
}

function persistFilePath(): string {
  return path.join(deps!.persistDir, DOWNLOADS_FILE)
}

interface PersistedDownload {
  infoHash: string
  magnetUri: string
  title: string
  releaseTitle?: string
  anilistId: number | null
  targetFolder: string
  /** New jobs persist the actual anime folder; targetFolder remains legacy base path. */
  animeFolder?: string
  episode: number | null
  episodes?: number[]
  season?: number | null
  addedAt: number
  reportedSeeders?: number | null
  providerName?: string
}

interface PersistedDownloadsFile {
  version: 1
  savedAt: number
  jobs: PersistedDownload[]
}

function writePersistFileNow(): void {
  if (!deps) return
  try {
    fs.mkdirSync(deps.persistDir, { recursive: true })
    const jobsList: PersistedDownload[] = []
    for (const [, job] of jobs) {
      if (job.magnetUri) {
        jobsList.push({
          infoHash: job.infoHash,
          magnetUri: job.magnetUri,
          title: job.title,
          releaseTitle: job.releaseTitle,
          anilistId: job.anilistId,
          targetFolder: path.dirname(job.animeFolder),
          animeFolder: job.animeFolder,
          episode: job.episode,
          episodes: job.requestedEpisodes ?? undefined,
          season: job.requestedSeason ?? null,
          addedAt: job.addedAt,
          reportedSeeders: job.reportedSeeders ?? null,
          providerName: job.providerName,
        })
      }
    }
    const payload: PersistedDownloadsFile = {
      version: 1,
      savedAt: Date.now(),
      jobs: jobsList,
    }
    const tmp = persistFilePath() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    fs.renameSync(tmp, persistFilePath())
  } catch (err) {
    warn('failed to persist downloads.json:', errMsg(err))
  }
}

export async function initTorrentEngine(incoming: { getSettings: () => AppSettings; onState: (state: any) => void; persistDir: string; createClient?: () => TorrentClientLike }): Promise<void> {
  if (!incoming || typeof incoming.getSettings !== 'function' || typeof incoming.onState !== 'function') {
    throw new Error('initTorrentEngine: getSettings and onState deps are required')
  }
  deps = incoming
  const s = incoming.getSettings()
  if (!client && s.enableP2P === true && s.p2pConsentAcceptedAt) {
    log('auto-starting: P2P enabled and consent accepted')
    await engineSetEnabled(true).catch((err) => warn('auto-start failed:', errMsg(err)))
  }
}

export async function engineSetEnabled(wantEnabled: boolean): Promise<{ success: boolean; error?: string }> {
  if (!deps) return { success: false, error: 'Torrent engine is not initialized' }
  const s = deps.getSettings()
  if (wantEnabled) {
    if (s.enableP2P !== true || !s.p2pConsentAcceptedAt) {
      return { success: false, error: 'P2P cannot start: enableP2P is off or the P2P consent has not been accepted in settings' }
    }
    if (!client) {
      if (deps.createClient) {
        client = deps.createClient()
      } else {
        // @ts-ignore -- untyped ESM-only dependency, loaded lazily on purpose
        const { default: Client } = await import('webtorrent')
        client = new Client({
          maxConns: 100,
          dht: {
            bootstrap: [
              'router.bittorrent.com:6881',
              'router.utorrent.com:6881',
              'dht.transmissionbt.com:6881',
              'dht.libtorrent.org:25401',
              'dht.aelitis.com:6881',
            ],
          },
          tracker: {
            announce: FALLBACK_TRACKERS,
          },
        }) as unknown as TorrentClientLike
      }
      attachClientHandlers(client)
    }
    enabled = true
    resumePersistedJobs()
    runScheduler()
    emitState()
    return { success: true }
  }
  writePersistFileNow()
  if (client) {
    client.destroy(() => {})
    client = null
  }
  enabled = false
  jobs.clear()
  log('engine disabled')
  emitState()
  return { success: true }
}

function getSettings(): AppSettings {
  return deps!.getSettings()
}

function isEngineAllowed(s: AppSettings): boolean {
  return s.enableP2P === true && !!s.p2pConsentAcceptedAt && enabled
}

function emitState(): void {
  if (!deps) return
  try {
    deps.onState(engineGetState())
  } catch (err) {
    warn('onState callback failed:', errMsg(err))
  }
}

export function engineGetState(): { enabled: boolean; consentAccepted: boolean; jobs: TorrentJob[]; limits: { maxConcurrent: number; seedMinutes: number } } {
  const s = getSettings()
  return {
    enabled,
    consentAccepted: !!s.p2pConsentAcceptedAt,
    jobs: [...jobs.values()].map(toTorrentJob),
    limits: {
      maxConcurrent: typeof s.maxConcurrentDownloads === 'number' ? Math.max(1, Math.floor(s.maxConcurrentDownloads)) : 2,
      seedMinutes: typeof s.seedMinutesAfterComplete === 'number' ? Math.max(0, s.seedMinutesAfterComplete) : 0,
    },
  }
}

function toTorrentJob(job: InternalJob): TorrentJob {
  const t = job.torrent || job.connectingTorrent || null
  // For selective jobs report progress over the selected files; torrent-level
  // numbers would pin the UI at e.g. 11% once the one episode is complete.
  const selective = job.selectedProgress != null
  const rawProgress = selective
    ? (job.selectedProgress as number)
    : t && typeof t.progress === 'number'
      ? t.progress
      : 0
  const progress = Math.max(0, Math.min(100, rawProgress * 100))
  const totalBytes = selective
    ? job.selectedTotalBytes
    : t && typeof t.length === 'number'
      ? t.length
      : 0
  const downloadedBytes = selective
    ? Math.round(rawProgress * job.selectedTotalBytes)
    : t && typeof t.downloaded === 'number'
      ? t.downloaded
      : 0
  return {
    infoHash: job.infoHash,
    name: (t && typeof t.name === 'string' && t.name) || sanitizePathSegment(job.title),
    title: job.title,
    releaseTitle: job.releaseTitle,
    selectedFiles: job.selectedFiles?.map((file) => file.path || file.name),
    anilistId: job.anilistId ?? null,
    targetFolder: job.targetFolder,
    magnetUri: job.magnetUri,
    status: job.status,
    progress: Math.round(progress * 100) / 100,
    downloadedBytes,
    totalBytes,
    downloadSpeed: t && typeof t.downloadSpeed === 'number' ? t.downloadSpeed : 0,
    uploadSpeed: t && typeof t.uploadSpeed === 'number' ? t.uploadSpeed : 0,
    peers: t && typeof t.numPeers === 'number' ? t.numPeers : 0,
    reportedSeeders: job.reportedSeeders ?? null,
    providerName: job.providerName,
    connectingSeconds: job.status === 'connecting' && job.connectingSince
      ? Math.max(0, Math.floor((Date.now() - job.connectingSince) / 1000))
      : undefined,
    noProgressSeconds: job.status === 'downloading' && job.lastProgressAt
      ? Math.max(0, Math.floor((Date.now() - job.lastProgressAt) / 1000))
      : undefined,
    missingPieces: job.missingPieces,
    availableMissingPieces: job.availableMissingPieces,
    stallRecoveryCount: job.stallRecoveryCount || 0,
    torrentWarning: job.lastWarning,
    episode: job.episode ?? null,
    episodes: job.requestedEpisodes ?? undefined,
    season: job.requestedSeason ?? null,
    error: job.error,
    addedAt: job.addedAt,
    completedAt: job.completedAt ?? null,
    filesProgress: job.filesProgress || [],
  }
}

function attachClientHandlers(c: TorrentClientLike): void {
  startTicker()
  if (typeof c.on !== 'function') return
  c.on('error', (...args: unknown[]) => {
    const err = args[0] as (Error & { infoHash?: string }) | undefined
    warn('client error:', errMsg(err))
    const hash = normHash(err && err.infoHash)
    if (!hash) return
    const job = jobs.get(hash)
    if (!job || job.status === 'error') return
    job.status = 'error'
    job.error = errMsg(err)
    emitState()
    writePersistFileNow()
  })
  c.on('torrent', (...args: unknown[]) => {
    const torrent = args[0] as TorrentLike | undefined
    if (torrent) handleTorrentReady(torrent)
  })
}

/** How long a 'connecting' job may wait for metadata before it is failed with an actionable error. */
const CONNECTING_WATCHDOG_MS = 180_000

/**
 * One module-wide 1s ticker drives per-file progress, the connecting watchdog
 * and the scheduler. attachClientHandlers runs on every client creation, so a
 * naive setInterval there would stack one more loop per enable/disable cycle.
 */
let tickerStarted = false
function startTicker(): void {
  if (tickerStarted) return
  tickerStarted = true
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [, job] of jobs) {
      if (job.status === 'connecting' && job.connectingSince && now - job.connectingSince > CONNECTING_WATCHDOG_MS) {
        job.status = 'error'
        const livePeers = job.connectingTorrent?.numPeers ?? 0
        const trackerDetail = job.lastWarning ? ` Last network warning: ${job.lastWarning}.` : ''
        const reported = job.reportedSeeders == null ? '' : ` The indexer reported ${job.reportedSeeders} seeders at search time; that count is not live.`
        job.error = `No torrent metadata after ${CONNECTING_WATCHDOG_MS / 1000}s. App connected to ${livePeers} peers.${reported}${trackerDetail} Check tracker/DHT access or try another release.`
        warn(`job ${job.infoHash}: `, job.error)
        try { job.connectingTorrent?.destroy(undefined, () => {}) } catch {}
        job.connectingTorrent = null
        emitState()
        continue
      }
      if (job.status === 'connecting') {
        const elapsed = job.connectingSince ? now - job.connectingSince : 0
        const connTorrent = job.connectingTorrent as any
        const disc = connTorrent?.discovery

        // Active peer discovery: periodically refresh tracker announce and actively query DHT lookup
        const numPeers = connTorrent?.numPeers ?? 0
        const pollInterval = numPeers === 0 ? 8 : 15
        if (elapsed > 0 && Math.floor(elapsed / 1000) % pollInterval === 0) {
          try { disc?.tracker?.update?.() } catch {}
          try { disc?.dht?.lookup?.(job.infoHash) } catch {}
          try { (client as any)?.dht?.lookup?.(job.infoHash) } catch {}
          try { disc?._dhtAnnounce?.() } catch {}
        }

        // Wire maintenance: cycle unproductive or stalled peers so WebTorrent connects to new discovered peers
        const wires = connTorrent?.wires
        if (Array.isArray(wires)) {
          for (const wire of wires) {
            if (!wire._connectedAt) wire._connectedAt = now
            const wireElapsed = now - wire._connectedAt
            // Allow at least 12 seconds for handshake and peer exchange (PEX)
            if (wireElapsed >= 12_000) {
              const handshake = wire?.peerExtendedHandshake
              const hasExtended = handshake && typeof handshake === 'object' && Object.keys(handshake).length > 0
              if (!hasExtended) {
                // Handshake never completed in 12s -> drop unresponsive wire
                try { wire.destroy() } catch {}
                continue
              }
              // If remote peer explicitly lacks metadata support or metadata size
              if (!handshake.m?.ut_metadata || !handshake.metadata_size || wire._noMetadata) {
                try { wire.destroy() } catch {}
                continue
              }
              // Count delivered metadata pieces via BitField buffer
              const bitfield = wire.ut_metadata?._bitfield
              let piecesCount = 0
              if (bitfield && bitfield.buffer) {
                for (let i = 0; i < bitfield.buffer.length; i++) {
                  let b = bitfield.buffer[i]
                  while (b > 0) {
                    if (b & 1) piecesCount++
                    b >>= 1
                  }
                }
              }
              if (piecesCount > (wire._lastMetadataPieces || 0)) {
                wire._lastMetadataPieces = piecesCount
                wire._lastPieceAt = now
              }

              if (piecesCount === 0) {
                if (wireElapsed >= 30_000) {
                  // Stalled peer for >30s: delivered 0 pieces -> drop wire to cycle connection slot
                  try { wire.destroy() } catch {}
                } else if (wireElapsed >= 15_000 && wireElapsed % 5_000 < 1_000) {
                  // Re-request metadata pieces in case initial request was missed
                  try { wire.ut_metadata?.fetch?.() } catch {}
                }
              } else {
                // Peer has delivered pieces: allow time to finish, only drop if stalled for >35s with no new pieces
                const pieceStallTime = wire._lastPieceAt ? now - wire._lastPieceAt : 0
                if (pieceStallTime >= 35_000) {
                  try { wire.destroy() } catch {}
                } else if (pieceStallTime >= 15_000 && pieceStallTime % 5_000 < 1_000) {
                  try { wire.ut_metadata?.fetch?.() } catch {}
                }
              }
            }
          }
        }
        emitState()
        continue
      }
      if (job.torrent && job.torrent.files && job.status === 'downloading') {
        updateFilesProgress(job)
        reconcileSelectedDone(job)
        const noProgressSeconds = job.lastProgressAt ? Math.floor((now - job.lastProgressAt) / 1000) : 0
        if (noProgressSeconds >= 30 && (job.availableMissingPieces || 0) > 0 && job.torrent.critical && now - (job.lastCriticalAt || 0) >= 20_000) {
          const files = job.selectedFiles?.length ? job.selectedFiles : job.torrent.files
          const stats = getSelectedPieceAvailability(job.torrent, files)
          for (const piece of stats?.missingIndices || []) {
            if (job.torrent.wires?.some((wire) => wire.peerPieces?.get(piece))) job.torrent.critical(piece, piece)
          }
          job.lastCriticalAt = now
        }
        if (noProgressSeconds >= 75 && (job.availableMissingPieces || 0) > 0 && (job.stallRecoveryCount || 0) < 2) {
          restartStalledJob(job)
          continue
        }
        emitState()
      }
    }
    runScheduler()
  }, 1000)
  // Never hold the process open by this timer alone (Electron's lifetime is
  // governed by its windows; plain-node tests would otherwise hang at exit).
  timer.unref?.()
}

/**
 * Heal races around selective completion: a file's 'done' event can fire in
 * the window between attachSelectedCompletion reading file.done and attaching
 * its listener. Recount from the authoritative flags; cheap (files ≤ hundreds).
 */
function reconcileSelectedDone(job: InternalJob): void {
  if (!job.selectedFiles || job.selectedFiles.length === 0) return
  if (!job.torrent) return
  let done = 0
  for (const f of job.selectedFiles) {
    if (f.done) done += 1
  }
  job.selectedDone = done
  checkSelectedComplete(job, job.torrent)
}

function handleTorrentReady(torrent: TorrentLike): void {
  const infoHash = normHash(torrent.infoHash)
  const job = jobs.get(infoHash)
  if (!job) {
    // Already cancelled
    torrent.destroy(undefined, () => {})
    return
  }
  if (job.torrent) return
  // A job the watchdog already gave up on must not silently restart downloading.
  if (job.status === 'error') {
    torrent.destroy(undefined, () => {})
    return
  }
  job.torrent = torrent
  job.connectingTorrent = null
  if (typeof torrent.magnetURI === 'string' && torrent.magnetURI) job.magnetUri = torrent.magnetURI
  attachTorrentDiagnostics(job, torrent)
  if (job.status === 'paused') {
    // Pause was clicked while the metadata was still loading — honor it now.
    try {
      torrent.pause()
    } catch {}
  } else if (job.status === 'queued' || job.status === 'connecting') {
    job.status = 'downloading'
  }
  // Selective file download: choose episode file or all video files
  if (!job.fileSelectionDone && torrent.files && torrent.files.length > 0) {
    const selected = selectFilesForJob(job, torrent)
    job.fileSelectionDone = true
    if (selected.length === 0) return
    attachSelectedCompletion(job, torrent, selected)
  }
  // Listen for completion (fires only when EVERY file is done — the selected-files
  // path above is the authoritative completion for selective downloads).
  torrent.on('done', () => {
    onTorrentDone(job, torrent)
  })
  if (job.status === 'downloading') {
    emitState()
  }
}

/** Attach listeners as soon as WebTorrent returns its Torrent, before metadata arrives. */
function attachTorrentDiagnostics(job: InternalJob, torrent: TorrentLike): void {
  if (diagnosedTorrents.has(torrent)) return
  diagnosedTorrents.add(torrent)
  torrent.on('error', (err: unknown) => {
    if (jobs.get(job.infoHash) !== job || (job.torrent !== torrent && job.connectingTorrent !== torrent)) return
    const message = errMsg(err)
    warn(`torrent ${job.infoHash} failed:`, message)
    failJob(job, `Torrent client error: ${message}`)
  })
  torrent.on('warning', (err: unknown) => {
    if (jobs.get(job.infoHash) !== job || (job.torrent !== torrent && job.connectingTorrent !== torrent)) return
    job.lastWarning = errMsg(err)
    warn(`torrent ${job.infoHash} warning:`, job.lastWarning)
    emitState()
  })
  if (typeof torrent.on === 'function') {
    torrent.on('wire', (wire: any) => {
      if (wire) {
        wire._connectedAt = Date.now()
        wire.ut_metadata?.on?.('warning', () => {
          wire._noMetadata = true
        })
      }
    })
  }
}

/**
 * Track completion over the files the user actually wants: webtorrent only
 * emits torrent 'done' when all files are downloaded, so a job with the rest of
 * a batch deselected would otherwise never complete. Files that are already
 * done (resumed data on disk) count immediately.
 */
function attachSelectedCompletion(job: InternalJob, torrent: TorrentLike, selected: TorrentFileLike[]): void {
  if (selected.length === 0) return
  job.selectedFiles = selected
  job.selectedDone = 0
  job.selectedTotalBytes = selected.reduce((sum, f) => sum + (f.length || 0), 0)
  job.lastProgressBytes = selected.reduce((sum, file) => sum + (file.progress || 0) * (file.length || 0), 0)
  job.lastProgressAt = Date.now()
  for (const file of selected) {
    if (file.done) {
      job.selectedDone += 1
    } else {
      file.on?.('done', () => {
        if (jobs.get(job.infoHash) !== job || job.torrent !== torrent) return
        reconcileSelectedDone(job)
      })
    }
  }
  checkSelectedComplete(job, torrent)
}

function checkSelectedComplete(job: InternalJob, torrent: TorrentLike): void {
  if (!job.selectedFiles || job.selectedFiles.length === 0) return
  if (job.selectedDone < job.selectedFiles.length) return
  if (job.status === 'completed' || job.status === 'seeding') return
  job.selectedProgress = 1
  onTorrentDone(job, torrent)
}

function resumePersistedJobs(): number {
  let entries: PersistedDownload[] = []
  try {
    const raw = fs.readFileSync(persistFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as PersistedDownloadsFile
    entries = parsed.jobs.filter(
      (e) => e && typeof e.infoHash === 'string' && typeof e.magnetUri === 'string' && e.magnetUri.length > 0
    )
  } catch {
    return 0
  }
  const s = getSettings()
  let added = 0
  for (const entry of entries) {
    const infoHash = normHash(entry.infoHash)
    if (!infoHash || jobs.has(infoHash)) continue
    const base = entry.targetFolder || s.downloadTargetFolder || (Array.isArray(s.libraryFolders) && s.libraryFolders.length > 0 ? s.libraryFolders[0] : undefined)
    if (!base) continue
    const animeFolder = typeof entry.animeFolder === 'string' && entry.animeFolder
      ? entry.animeFolder
      : path.join(base, sanitizePathSegment(entry.title || infoHash))
    jobs.set(infoHash, {
      infoHash,
      title: typeof entry.title === 'string' ? entry.title : infoHash,
      releaseTitle: typeof entry.releaseTitle === 'string' ? entry.releaseTitle : undefined,
      anilistId: typeof entry.anilistId === 'number' ? entry.anilistId : null,
      episode: typeof entry.episode === 'number' ? entry.episode : null,
      requestedSeason: typeof entry.season === 'number' ? entry.season : null,
      targetFolder: animeFolder,
      animeFolder,
      downloadDir: path.join(animeFolder, '.anime-center-staging', infoHash),
      magnetUri: entry.magnetUri,
      status: 'queued',
      addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : Date.now(),
      completedAt: null,
      torrent: null,
      seedingDeadline: null,
      queueSeq: seqCounter++,
      requestedEpisode: typeof entry.episode === 'number' ? entry.episode : null,
      requestedEpisodes: Array.isArray(entry.episodes)
        ? [...new Set(entry.episodes.filter((n) => Number.isInteger(n) && n > 0))]
        : typeof entry.episode === 'number' ? [entry.episode] : null,
      fileSelectionDone: false,
      filesProgress: [],
      selectedFiles: null,
      selectedDone: 0,
      selectedProgress: null,
      selectedTotalBytes: 0,
      reportedSeeders: typeof entry.reportedSeeders === 'number' ? entry.reportedSeeders : null,
      providerName: typeof entry.providerName === 'string' ? entry.providerName : undefined,
    })
    added += 1
  }
  if (added > 0) {
    log(`resumed ${added} persisted download(s)`)
    runScheduler()
  }
  return added
}

// ---- Queue scheduling ---------------------------------------------------------

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
  // Check seeding deadlines
  const now = Date.now()
  for (const [, job] of jobs) {
    if (job.status === 'seeding' && job.seedingDeadline && now >= job.seedingDeadline) {
      if (job.torrent) {
        job.torrent.destroy(undefined, () => cleanupStage(job))
      } else {
        cleanupStage(job)
      }
      jobs.delete(job.infoHash)
      writePersistFileNow()
    }
  }
}

async function activateJob(job: InternalJob): Promise<void> {
  const s = getSettings()
  if (!isEngineAllowed(s)) return
  setJobStatus(job, 'connecting')
  const c = await getClient()
  if (jobs.get(job.infoHash) !== job) return
  if (!c) {
    job.status = 'queued'
    return
  }
  try {
    fs.mkdirSync(job.downloadDir, { recursive: true })
    fs.mkdirSync(job.animeFolder, { recursive: true })
  } catch (err) {
    warn('could not create download dir:', errMsg(err))
  }
  const payload = ensureMagnetTrackers(job.magnetUri)
  job.connectingSince = Date.now()
  try {
    const opts: Record<string, unknown> = {
      path: job.downloadDir,
      announce: FALLBACK_TRACKERS,
    }
    // webtorrent's throttle groups are in BYTES per second.
    if (typeof s.downloadSpeedLimitMBps === 'number' && s.downloadSpeedLimitMBps > 0) {
      opts.downloadLimit = Math.floor(s.downloadSpeedLimitMBps * 1024 * 1024) // MB/s -> B/s
    }
    if (typeof s.uploadSpeedLimitMBps === 'number' && s.uploadSpeedLimitMBps > 0) {
      opts.uploadLimit = Math.floor(s.uploadSpeedLimitMBps * 1024 * 1024)
    }
    // Purge any lingering torrent in WebTorrent client before adding, eliminating "Cannot add duplicate torrent"
    if (c) {
      try {
        if (typeof (c as any).remove === 'function' && Array.isArray((c as any).torrents)) {
          const norm = (job.infoHash || '').toLowerCase().trim()
          for (let i = (c as any).torrents.length - 1; i >= 0; i--) {
            const t = (c as any).torrents[i]
            const tHash = (t?.infoHash || '').toLowerCase().trim()
            if (tHash === norm || t === job.torrent || t === job.connectingTorrent) {
              try { t.destroy?.(undefined, () => {}) } catch {}
              try { (c as any).torrents.splice(i, 1) } catch {}
            }
          }
        }
        const existing = (c as any).get?.(job.infoHash)
        if (existing) {
          try { existing.destroy(undefined, () => {}) } catch {}
          try { (c as any).remove?.(job.infoHash, undefined, () => {}) } catch {}
        }
      } catch {}
    }

    const connectingTorrent = c.add(payload, opts, undefined) as TorrentLike | undefined
    if (connectingTorrent && typeof connectingTorrent.on === 'function') {
      job.connectingTorrent = connectingTorrent
      attachTorrentDiagnostics(job, connectingTorrent)
    }
  } catch (err) {
    job.status = 'error'
    job.error = errMsg(err) || 'failed to add torrent to client'
    emitState()
    writePersistFileNow()
  }
}

function getClient(): TorrentClientLike | null {
  return client
}

function updateFilesProgress(job: InternalJob): void {
  const t = job.torrent
  if (!t || !t.files) return
  job.filesProgress = t.files
    .filter((f) => f.length && f.length > 0)
    .map((f) => ({
      // Keep the torrent-relative path so UI consumers can disambiguate
      // same-numbered episodes in nested season folders.
      name: f.path || f.name,
      progress: typeof f.progress === 'number' ? Math.round(f.progress * 10000) / 100 : 0,
      length: f.length || 0,
    }))
  // Torrent-level progress counts every piece of the whole batch; for a
  // selective job the honest number is the weighted progress of the selected files.
  if (job.selectedFiles && job.selectedFiles.length > 0) {
    let done = 0
    let total = 0
    for (const f of job.selectedFiles) {
      const len = f.length || 0
      total += len
      done += (typeof f.progress === 'number' ? f.progress : 0) * len
    }
    job.selectedProgress = total > 0 ? done / total : 0
  }
  const pieceStats = getSelectedPieceAvailability(t, job.selectedFiles?.length ? job.selectedFiles : t.files)
  job.missingPieces = pieceStats?.missing ?? undefined
  job.availableMissingPieces = pieceStats?.available ?? undefined
  const observedBytes = job.selectedFiles?.length
    ? (job.selectedProgress || 0) * job.selectedTotalBytes
    : (typeof t.downloaded === 'number' ? t.downloaded : 0)
  if (job.lastProgressBytes == null || observedBytes > job.lastProgressBytes + 16 * 1024) {
    job.lastProgressBytes = observedBytes
    job.lastProgressAt = Date.now()
    job.lastWarning = undefined
    job.stallRecoveryCount = 0
  } else if (!job.lastProgressAt) {
    job.lastProgressAt = Date.now()
  }
}

/** Count missing selected pieces and how many are advertised by connected peers. */
function getSelectedPieceAvailability(
  torrent: TorrentLike,
  files: TorrentFileLike[]
): { missing: number; available: number; missingIndices: number[] } | null {
  if (!torrent.bitfield || !Array.isArray(torrent.wires)) return null
  const missingPieces = new Set<number>()
  for (const file of files) {
    if (!Number.isInteger(file._startPiece) || !Number.isInteger(file._endPiece)) return null
    for (let piece = file._startPiece!; piece <= file._endPiece!; piece += 1) {
      if (!torrent.bitfield.get(piece)) missingPieces.add(piece)
    }
  }
  let available = 0
  for (const piece of missingPieces) {
    if (torrent.wires.some((wire) => wire.peerPieces?.get(piece))) available += 1
  }
  return { missing: missingPieces.size, available, missingIndices: [...missingPieces] }
}

/** Restart peer discovery after a long stall without deleting the partial chunk store. */
function restartStalledJob(job: InternalJob): void {
  const torrent = job.torrent
  if (!torrent || job.status !== 'downloading') return
  job.stallRecoveryCount = (job.stallRecoveryCount || 0) + 1
  job.status = 'connecting'
  job.connectingSince = Date.now()
  job.torrent = null
  job.recoveryInProgress = true
  job.lastWarning = undefined
  emitState()

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    if (jobs.get(job.infoHash) !== job) return
    const paused = job.status === 'paused'
    job.recoveryInProgress = false
    job.fileSelectionDone = false
    job.selectedFiles = null
    job.selectedDone = 0
    job.selectedProgress = null
    job.selectedTotalBytes = 0
    job.lastProgressBytes = undefined
    job.lastProgressAt = undefined
    job.missingPieces = undefined
    job.availableMissingPieces = undefined
    job.lastCriticalAt = undefined
    job.connectingSince = undefined
    job.status = paused ? 'paused' : 'queued'
    emitState()
    if (!paused) runScheduler()
  }

  try {
    torrent.destroy(undefined, () => {
      finish()
    })
  } catch {
    if (jobs.get(job.infoHash) === job) failJob(job, 'Could not safely reopen this torrent store after a stall. Cancel and re-add the release to retry.')
  }
}

const VIDEO_FILE_EXTENSIONS = ['.mkv', '.mp4', '.avi', '.mov', '.m4v', '.ts', '.webm']

function isVideoFile(name: string): boolean {
  const lower = name.toLowerCase()
  return VIDEO_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function getFileEpisodeNumbers(filePath: string): number[] {
  const normalized = filePath.replace(/\\/g, '/')
  const baseName = path.posix.basename(normalized)
  for (const candidate of [baseName, normalized]) {
    try {
      const parsed = parseReleaseCore(candidate)
      if (parsed.releaseType === 'NCOP' || parsed.releaseType === 'NCED') continue
      const numbers = new Set(parsed.episodeNumbers || [])
      if (typeof parsed.episodeNumber === 'number' && typeof parsed.episodeEnd === 'number' && parsed.episodeEnd >= parsed.episodeNumber && parsed.episodeEnd - parsed.episodeNumber <= 200) {
        for (let number = parsed.episodeNumber; number <= parsed.episodeEnd; number += 1) numbers.add(number)
      }
      if (numbers.size > 0) return [...numbers]
    } catch {}
  }
  const stem = path.posix.parse(baseName).name.trim()
  const numericName = /^(?:ep(?:isode)?[ ._-]*)?0*(\d{1,3})(?:[ ._-].*)?$/i.exec(stem)
  if (!numericName) return []
  const episode = Number(numericName[1])
  return episode > 0 && episode < 200 ? [episode] : []
}

function isNonEpisodeVideo(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  const parsed = parseReleaseCore(path.posix.basename(normalized))
  if (parsed.releaseType === 'NCOP' || parsed.releaseType === 'NCED') return true
  return /(?:^|[\\/ ._()[\]-])(?:creditless|ncop|nced|opening|ending|trailer|preview|teaser|promo|pv|cm)(?:$|[\\/ ._()[\]-])/i.test(normalized)
}

/** Movie/OVA/special/creditless files inside a legitimate season pack — their
 *  embedded numbers ("M13", "NCOP 01", "Movie 01") must never satisfy a
 *  regular episode request. */
function isSpecialOrExtraVideo(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  const segments = normalized.split('/')
  const name = segments[segments.length - 1] || ''
  const parentDirs = segments.slice(0, -1).join(' / ')
  const specialsDirRe = /(?:^|[\/ ])(?:movies?|extras?|specials?|ovas?|oads?|menus?|creditless)(?:$|[\/ ])/i;
  const specialsNameRe = /(?:^|[\\/ ._()[\]-])(?:m\d{1,3}|movies?|ova|oad|ncop|nced|creditless|sp\d{1,3}|special|pv|menu|preview|trailer)(?:$|[\\/ ._()[\]-])/i;
  return specialsDirRe.test(parentDirs) || specialsNameRe.test(name);
}

function getSeasonNumberFromLabel(label: string): number | null {
  const parsed = parseReleaseCore(path.posix.basename(label.replace(/\\/g, '/')))
  if (parsed.season != null) return parsed.season
  const seasonWord = /\bseason[ ._-]*0*(\d{1,2})\b/i.exec(label)
  if (seasonWord) return Number(seasonWord[1])
  const ordinalSeason = /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i.exec(label)
  if (ordinalSeason) return Number(ordinalSeason[1])
  const shortSeason = /(?:^|[ ._-])s0*(\d{1,2})(?=$|[ ._\-[\]()])/i.exec(label)
  return shortSeason ? Number(shortSeason[1]) : null
}

function getFileSeasonNumber(filePath: string): number | null {
  const normalized = filePath.replace(/\\/g, '/')
  const seasonFromName = getSeasonNumberFromLabel(path.posix.basename(normalized))
  if (seasonFromName != null) return seasonFromName
  for (const part of normalized.split('/').slice(0, -1).reverse()) {
    const match = /^(?:season|s)[ ._-]*0*(\d{1,2})$/i.exec(part.trim())
    if (match) return Number(match[1])
  }
  return null
}

function collectAnimeFiles(folder: string): Array<{ name: string; episodeNumbers: number[] }> {
  const result: Array<{ name: string; episodeNumbers: number[] }> = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() !== '.anime-center-staging') walk(path.join(dir, entry.name))
      } else if (entry.isFile() && isVideoFile(entry.name)) {
        result.push({ name: entry.name.toLowerCase(), episodeNumbers: getFileEpisodeNumbers(entry.name) })
      }
    }
  }
  walk(folder)
  return result
}

function selectFilesForJob(job: InternalJob, torrent: TorrentLike): TorrentFileLike[] {
  if (!torrent.files || torrent.files.length === 0) return []
  // WebTorrent selects everything by default. Deselect before any validation
  // so a failed single-episode match can never silently download the whole pack.
  for (const file of torrent.files) file.deselect?.()

  const videoFiles = torrent.files.filter((f) => isVideoFile(f.name))

  if (videoFiles.length === 0) {
    failJob(job, 'No video files were found in this release.')
    return []
  }

  const existing = collectAnimeFiles(job.animeFolder)
  const existingEpisodes = new Set(existing.flatMap((file) => file.episodeNumbers))
  const existingNames = new Set(existing.map((file) => file.name))
  const reservedEpisodes = new Set<number>()
  for (const other of jobs.values()) {
    if (other === job || path.resolve(other.animeFolder) !== path.resolve(job.animeFolder)) continue
    for (const number of other.requestedEpisodes || []) reservedEpisodes.add(number)
    for (const selectedFile of other.selectedFiles || []) {
      try {
        for (const number of getFileEpisodeNumbers(selectedFile.path || selectedFile.name)) reservedEpisodes.add(number)
      } catch {}
    }
  }
  for (const number of reservedEpisodes) existingEpisodes.add(number)
  let chosen: TorrentFileLike[]

  // Select every explicitly queued episode from the same batch torrent.
  if (job.requestedEpisodes != null) {
    chosen = []
    for (const epNum of job.requestedEpisodes) {
      if (existingEpisodes.has(epNum)) {
        if (reservedEpisodes.has(epNum)) continue
        // Files already on disk satisfy the request and must not be re-downloaded.
        continue
      }
      const candidates = videoFiles.flatMap((file) => {
        try {
          const filePath = file.path || file.name
          if (isNonEpisodeVideo(filePath) || isSpecialOrExtraVideo(filePath)) return []
          const episodeNumbers = getFileEpisodeNumbers(filePath)
          return episodeNumbers.includes(epNum)
            ? [{ file, count: episodeNumbers.length, season: getFileSeasonNumber(filePath) }]
            : []
        } catch { return [] }
      }).sort((a, b) => a.count - b.count)
      const explicitSeasonCandidates = job.requestedSeason == null ? [] : candidates.filter((candidate) => candidate.season === job.requestedSeason)
      const seasonlessCandidates = candidates.filter((candidate) => candidate.season == null)
      const seasonMatchedCandidates = job.requestedSeason == null ? candidates : explicitSeasonCandidates.length > 0 ? explicitSeasonCandidates : seasonlessCandidates
      if (job.requestedSeason != null && candidates.length > 0 && seasonMatchedCandidates.length === 0) {
        failJob(job, `Episode ${epNum} was found, but not in season ${job.requestedSeason}. Choose a release for the correct season.`)
        return []
      }
      const distinctSeasons = new Set(seasonMatchedCandidates.map((candidate) => candidate.season).filter((season): season is number => season != null))
      if (job.requestedSeason == null && distinctSeasons.size > 1) {
        const examples = seasonMatchedCandidates.slice(0, 5).map((candidate) => candidate.file.path || candidate.file.name).join(', ')
        failJob(job, `Episode ${epNum} exists in multiple seasons in this release (${examples}). Choose the correct season release.`)
        return []
      }
      const match = seasonMatchedCandidates[0]
      if (match && match.count > 1) {
        failJob(job, `Episode ${epNum} is inside a combined video file (${match.file.name}). Torrent file selection cannot extract one episode from a video.`)
        return []
      }
      let matchedFile = match?.file || null
      if (!matchedFile) {
        const releaseTitle = job.releaseTitle || torrent.name || ''
        const releaseNumbers = getFileEpisodeNumbers(releaseTitle)
        const hasEpisodeMarker = /\bS\d{1,2}E\d{1,3}\b|\b(?:EP|Episode|E)[ ._-]*0*\d{1,3}\b|\s-\s0*\d{1,3}\b/i.test(releaseTitle)
        const releaseSeason = getFileSeasonNumber(releaseTitle)
        const onlyVideo = videoFiles.length === 1 && !isNonEpisodeVideo(videoFiles[0].path || videoFiles[0].name)
          && !isSpecialOrExtraVideo(videoFiles[0].path || videoFiles[0].name)
        if (onlyVideo && hasEpisodeMarker && releaseNumbers.length === 1 && releaseNumbers[0] === epNum &&
            (job.requestedSeason == null || releaseSeason == null || job.requestedSeason === releaseSeason)) matchedFile = videoFiles[0]
      }
      if (!matchedFile) {
        const examples = videoFiles.slice(0, 6).map((file) => file.path || file.name).join(', ')
        failJob(job, `Could not identify episode ${epNum} from the video filenames. Bonus videos are excluded; no file was selected. Files found: ${examples || 'none'}. Choose a release with clearly numbered episode files.`)
        return []
      }
      log(`Selecting episode file: ${matchedFile.name} for EP ${epNum}`)
      if (!chosen.some((file) => (file.path || file.name) === (matchedFile!.path || matchedFile!.name))) chosen.push(matchedFile)
    }
    if (chosen.length === 0) {
      failJob(job, 'All requested episodes are already downloaded or queued elsewhere.')
      return []
    }
  } else {
    const eligibleVideos = videoFiles.filter((file) => !isNonEpisodeVideo(file.path || file.name))
    const fileSeasons = new Set(eligibleVideos
      .map((file) => getFileSeasonNumber(file.path || file.name))
      .filter((season): season is number => season != null))
    const releaseSeason = getSeasonNumberFromLabel(job.releaseTitle || torrent.name || '')
    if (job.requestedSeason != null && fileSeasons.size > 0 && !fileSeasons.has(job.requestedSeason)) {
      failJob(job, `This release contains season ${[...fileSeasons].sort((a, b) => a - b).join(', ')}, not season ${job.requestedSeason}. Choose a pack for the requested season.`)
      return []
    }
    if (job.requestedSeason != null && fileSeasons.size > 0) {
      const matchingSeasonFiles = eligibleVideos.filter((file) => getFileSeasonNumber(file.path || file.name) === job.requestedSeason)
      chosen = matchingSeasonFiles
    } else if (job.requestedSeason != null && releaseSeason === job.requestedSeason) {
      // File names in season-specific packs often contain only E01/E02; the
      // release title itself identifies their season.
      chosen = eligibleVideos
    } else if (job.requestedSeason != null && fileSeasons.size > 1) {
      failJob(job, `This release contains multiple seasons (${[...fileSeasons].sort((a, b) => a - b).join(', ')}), but the selected season could not be isolated.`)
      return []
    } else if (job.requestedSeason == null && fileSeasons.size > 1) {
      failJob(job, `This release contains multiple seasons (${[...fileSeasons].sort((a, b) => a - b).join(', ')}). Choose a single-season pack.`)
      return []
    } else {
      chosen = eligibleVideos
    }
    // A season pack should only add files that aren't already in this anime folder.
    chosen = chosen.filter((file) => {
      const name = file.name.toLowerCase()
      if (existingNames.has(name)) return false
      let numbers: number[] = []
      numbers = getFileEpisodeNumbers(file.path || file.name)
      return numbers.length === 0 || !numbers.some((number) => existingEpisodes.has(number))
    })
    if (chosen.length === 0) {
      const overlaps = videoFiles.some((file) => {
        try {
          const numbers = getFileEpisodeNumbers(file.path || file.name)
          return numbers.length > 1 && numbers.some((number) => existingEpisodes.has(number)) && numbers.some((number) => !existingEpisodes.has(number))
        } catch { return false }
      })
      failJob(job, overlaps
        ? 'A multi-episode file overlaps with an episode already downloaded. Choose a release with separate files to avoid duplicates.'
        : 'All identifiable episodes in this release are already in the anime folder.')
      return []
    }
  }

  const chosenSet = new Set(chosen)
  for (const file of torrent.files) {
    if (chosenSet.has(file)) {
      file.select?.()
    } else {
      file.deselect?.()
    }
  }
  return chosen
}

function failJob(job: InternalJob, message: string): void {
  job.status = 'error'
  job.error = message
  job.selectedFiles = []
  job.selectedProgress = null
  emitState()
  writePersistFileNow()
}

function setJobStatus(job: InternalJob, status: TorrentJobStatus): void {
  if (job.status === status) return
  job.status = status
  emitState()
}

// ---- Torrent completed / seeding --------------------------------------------

function onTorrentDone(job: InternalJob, torrent: TorrentLike): void {
  if (jobs.get(job.infoHash) !== job || job.torrent !== torrent) return
  // Completion can arrive twice — once per selected file set, once from the
  // torrent-level 'done' event. The first one wins.
  if (job.status === 'seeding' || job.status === 'completed' || job.status === 'error') return
  try {
    exposeSelectedFiles(job)
  } catch (err) {
    failJob(job, `Could not move the downloaded episodes into the anime folder: ${errMsg(err)}`)
    return
  }
  const s = getSettings()
  const seedMinutes = Math.max(0, typeof s.seedMinutesAfterComplete === 'number' ? s.seedMinutesAfterComplete : 0)
  console.log('[torrentEngine] torrent done, seedMinutes:', seedMinutes)
  job.completedAt = Date.now()
  if (seedMinutes <= 0) {
    setJobStatus(job, 'completed')
    // A selected file emits `done` from inside WebTorrent's `_checkDone()`.
    // Destroying the torrent synchronously from that event re-enters its
    // completion loop; WebTorrent may null `torrent.client` before the loop's
    // next `_debug()` call, which becomes an uncaught main-process exception
    // even though all bytes were downloaded. Let the completion stack unwind.
    setImmediate(() => {
      if (job.torrent !== torrent) return // it was cancelled or replaced meanwhile
      torrent.destroy(undefined, () => {
        cleanupStage(job)
        if (jobs.get(job.infoHash) === job) jobs.delete(job.infoHash)
        writePersistFileNow()
        runScheduler()
      })
    })
    return
  }
  setJobStatus(job, 'seeding')
  job.seedingDeadline = Date.now() + seedMinutes * 60_000
}

export async function engineAddDownload(params: { item: ReleaseSearchResult; title: string; anilistId?: number | null; episode?: number | null; season?: number | null; targetFolder?: string; downloadRoot?: string }): Promise<{ success: boolean; error?: string; infoHash?: string }> {
  if (!deps) return { success: false, error: 'Torrent engine is not initialized' }
  const s = getSettings()
  if (!isEngineAllowed(s)) {
    return { success: false, error: 'P2P is disabled — enable P2P and accept the consent prompt in settings before downloading' }
  }

  const downloadUrl = params?.item?.downloadUrl?.trim() || ''
  if (!downloadUrl) return { success: false, error: 'Release has no downloadUrl' }

  let magnetUri = ''
  let infoHash: string | null = null

  if (downloadUrl.startsWith('magnet:')) {
    magnetUri = downloadUrl
    infoHash = extractInfoHashFromMagnet(magnetUri)
    if (!infoHash) return { success: false, error: 'Magnet URI carries no usable btih hash' }
  } else if (/^https?:\/\//i.test(downloadUrl)) {
    // Remote .torrent file - fetch it first to get the info hash.
    // electron.net.fetch goes through the system proxy (WARP/Clash setups);
    // bare node fetch ignores it and cannot reach most trackers/indexers here.
    let buf: Buffer | null = null
    try {
      const doFetch = await resolveFetch()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60_000)
      let res: Awaited<ReturnType<FetchLike>>
      try {
        res = await doFetch(downloadUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) return { success: false, error: `Failed to fetch .torrent: HTTP ${res.status}` }
      const ab = await res.arrayBuffer()
      buf = Buffer.from(ab)
    } catch (err) {
      const timedOut = (err as { name?: string } | null)?.name === 'AbortError'
      return { success: false, error: `Failed to fetch .torrent: ${timedOut ? 'timed out after 60s' : errMsg(err)}` }
    }
    const meta = buf ? extractTorrentMeta(buf) : null
    if (!meta || !meta.infoHash) {
      return { success: false, error: 'Could not parse .torrent file' }
    }
    infoHash = meta.infoHash
    magnetUri = meta.magnetUri || downloadUrl
  } else {
    return { success: false, error: 'downloadUrl must be a magnet: URI or an http(s) .torrent link' }
  }

  if (!infoHash) return { success: false, error: 'Could not determine info hash for download' }

  const title = typeof params?.title === 'string' && params.title ? params.title : infoHash
  const existingJob = jobs.get(infoHash)
  if (existingJob) {
    const requestedFolder = params.targetFolder ? path.resolve(params.targetFolder) : null
    if (requestedFolder && path.resolve(existingJob.animeFolder) !== requestedFolder) {
      return { success: false, error: 'This release is already downloading to a different anime folder.' }
    }
    if (existingJob.status === 'error') {
      if (params.episode == null) {
        existingJob.requestedEpisode = null
        existingJob.requestedEpisodes = null
        existingJob.episode = null
      } else if (Number.isInteger(params.episode) && params.episode > 0) {
        existingJob.requestedEpisodes = [...new Set([...(existingJob.requestedEpisodes || []), params.episode])].sort((a, b) => a - b)
        existingJob.requestedEpisode = existingJob.requestedEpisodes[0] ?? null
        existingJob.episode = existingJob.requestedEpisode
      }
      const oldTorrent = existingJob.torrent || existingJob.connectingTorrent
      existingJob.torrent = null
      existingJob.connectingTorrent = null
      if (oldTorrent) {
        try { oldTorrent.destroy(null, () => {}) } catch {}
      }
      if (client) {
        if (typeof (client as any).remove === 'function' && Array.isArray((client as any).torrents)) {
          const norm = infoHash.toLowerCase().trim()
          for (let i = (client as any).torrents.length - 1; i >= 0; i--) {
            const t = (client as any).torrents[i]
            const tHash = (t?.infoHash || '').toLowerCase().trim()
            if (tHash === norm || t === oldTorrent) {
              try { t.destroy?.(undefined, () => {}) } catch {}
              try { (client as any).torrents.splice(i, 1) } catch {}
            }
          }
        }
        try { (client as any).get?.(infoHash)?.destroy?.(undefined, () => {}) } catch {}
        try { (client as any).remove?.(infoHash, undefined, () => {}) } catch {}
      }
      existingJob.status = 'queued'
      existingJob.error = undefined
      existingJob.connectingSince = undefined
      existingJob.fileSelectionDone = false
      existingJob.selectedFiles = null
      existingJob.selectedDone = 0
      existingJob.selectedProgress = null
      existingJob.selectedTotalBytes = 0
      existingJob.filesProgress = []
      existingJob.lastProgressAt = undefined
      existingJob.lastProgressBytes = undefined
      emitState()
      writePersistFileNow()
      runScheduler()
      return { success: true, infoHash }
    }
    if (existingJob.requestedEpisodes === null) return { success: true, infoHash }
    if (params.episode == null) {
      // Upgrade an in-progress single-episode selection to the full pack. The
      // current episode remains selected alongside every still-missing file.
      existingJob.requestedEpisode = null
      existingJob.requestedEpisodes = null
      existingJob.episode = null
      existingJob.error = undefined
      if (existingJob.torrent?.files?.length) {
        const selected = selectFilesForJob(existingJob, existingJob.torrent)
        existingJob.fileSelectionDone = true
        if (selected.length > 0 && (existingJob.status as TorrentJobStatus) !== 'error') {
          existingJob.status = 'downloading'
          attachSelectedCompletion(existingJob, existingJob.torrent, selected)
          emitState()
        }
      }
      writePersistFileNow()
      return (existingJob.status as TorrentJobStatus) === 'error'
        ? { success: false, error: existingJob.error || 'Could not update the episode selection.' }
        : { success: true, infoHash }
    }
    if (typeof params.episode !== 'number' || !Number.isInteger(params.episode) || params.episode <= 0) {
      return { success: false, error: 'Choose a valid episode number.' }
    }
    const currentEpisodes = existingJob.requestedEpisodes || []
    if (currentEpisodes.includes(params.episode)) return { success: true, infoHash }
    // Keep an already working episode alive if the user happens to reuse a
    // single-episode torrent for a different episode. The new selection may
    // fail validation; that must not deselect the files that were downloading.
    const previousSelection = {
      requestedEpisodes: existingJob.requestedEpisodes,
      requestedEpisode: existingJob.requestedEpisode,
      episode: existingJob.episode,
      error: existingJob.error,
      status: existingJob.status,
      selectedFiles: existingJob.selectedFiles,
      selectedProgress: existingJob.selectedProgress,
      selectedTotalBytes: existingJob.selectedTotalBytes,
      selectedDone: existingJob.selectedDone,
      fileSelectionDone: existingJob.fileSelectionDone,
    }
    existingJob.requestedEpisodes = [...currentEpisodes, params.episode].sort((a, b) => a - b)
    existingJob.requestedEpisode = existingJob.requestedEpisodes[0] ?? null
    existingJob.episode = existingJob.requestedEpisode
    existingJob.error = undefined
    if (existingJob.torrent?.files?.length) {
      const selected = selectFilesForJob(existingJob, existingJob.torrent)
      existingJob.fileSelectionDone = true
      if ((existingJob.status as TorrentJobStatus) === 'error') {
        for (const file of existingJob.torrent.files) file.deselect?.()
        for (const file of previousSelection.selectedFiles || []) file.select?.()
        Object.assign(existingJob, previousSelection)
        emitState()
        writePersistFileNow()
        return { success: false, error: `This torrent does not contain episode ${params.episode}; the existing download is still running.` }
      }
      if (selected.length > 0 && (existingJob.status as TorrentJobStatus) !== 'error') {
        existingJob.status = 'downloading'
        attachSelectedCompletion(existingJob, existingJob.torrent, selected)
        emitState()
      }
    }
    writePersistFileNow()
    return (existingJob.status as TorrentJobStatus) === 'error'
      ? { success: false, error: existingJob.error || 'Could not add the episode to this torrent.' }
      : { success: true, infoHash }
  }

  const base = s.downloadTargetFolder || (Array.isArray(s.libraryFolders) && s.libraryFolders.length > 0 ? s.libraryFolders[0] : undefined)
  const animeFolder = params.targetFolder || (params.downloadRoot || base
    ? path.join(params.downloadRoot || base!, sanitizePathSegment(title))
    : undefined)
  if (!animeFolder) return { success: false, error: 'No download folder configured — set downloadTargetFolder or a library folder in settings' }

  const job: InternalJob = {
    infoHash,
    title,
    releaseTitle: typeof params.item.title === 'string' ? params.item.title : undefined,
    anilistId: typeof params?.anilistId === 'number' ? params.anilistId : null,
    episode: typeof params?.episode === 'number' ? params.episode : null,
    targetFolder: animeFolder,
    animeFolder,
    downloadDir: path.join(animeFolder, '.anime-center-staging', infoHash),
    magnetUri,
    status: 'queued',
    addedAt: Date.now(),
    completedAt: null,
    torrent: null,
    seedingDeadline: null,
    queueSeq: seqCounter++,
    requestedEpisode: typeof params?.episode === 'number' ? params.episode : null,
    requestedEpisodes: typeof params?.episode === 'number' && Number.isInteger(params.episode) && params.episode > 0 ? [params.episode] : null,
    requestedSeason: typeof params?.season === 'number' ? params.season : null,
    fileSelectionDone: false,
    filesProgress: [],
    selectedFiles: null,
    selectedDone: 0,
    selectedProgress: null,
    selectedTotalBytes: 0,
    reportedSeeders: typeof params.item.seeders === 'number' ? params.item.seeders : null,
    providerName: params.item.providerName,
  }
  jobs.set(infoHash, job)
  writePersistFileNow()
  emitState()
  runScheduler()
  return { success: true, infoHash }
}

function exposeSelectedFiles(job: InternalJob): void {
  const selected = job.selectedFiles || []
  if (selected.length === 0) throw new Error('No files were selected for saving.')
  fs.mkdirSync(job.animeFolder, { recursive: true })
  const existing = collectAnimeFiles(job.animeFolder)
  const existingEpisodes = new Set(existing.flatMap((file) => file.episodeNumbers))
  for (const file of selected) {
    // WebTorrent's `path` is relative to the torrent root and retains nested release folders.
    const relative = typeof file.path === 'string' && file.path ? file.path : file.name
    const source = path.resolve(job.downloadDir, relative)
    const stageRoot = path.resolve(job.downloadDir) + path.sep
    if (!source.startsWith(stageRoot) || !fs.existsSync(source)) {
      // Test doubles and incomplete metadata can lack file paths; real WebTorrent files always have one.
      if (typeof file.path !== 'string') continue
      throw new Error(`File not found: ${file.name}`)
    }
    let numbers: number[] = []
    numbers = getFileEpisodeNumbers(file.path || file.name)
    if (numbers.length > 0 && numbers.every((number) => existingEpisodes.has(number))) continue

    const baseName = path.basename(file.name)
    let destination = path.join(job.animeFolder, baseName)
    if (fs.existsSync(destination)) {
      // Don't overwrite a different file with an identical release filename.
      const stem = path.parse(baseName).name
      const ext = path.extname(baseName)
      let index = 2
      do { destination = path.join(job.animeFolder, `${stem} (${index++})${ext}`) } while (fs.existsSync(destination))
    }
    try {
      fs.linkSync(source, destination)
    } catch {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
    }
    for (const number of numbers) existingEpisodes.add(number)
    existing.push({ name: baseName.toLowerCase(), episodeNumbers: numbers })
  }
}

function cleanupStage(job: InternalJob): void {
  try { fs.rmSync(job.downloadDir, { recursive: true, force: true }) } catch (err) { warn('could not clean torrent stage:', errMsg(err)) }
  const parent = path.dirname(job.downloadDir)
  try { if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent) } catch {}
}

export function enginePause(infoHash: string): { success: boolean; error?: string } {
  const job = jobs.get(normHash(infoHash))
  if (!job) return { success: false, error: 'Unknown download' }
  if (job.status === 'paused') return { success: true }
  if (job.torrent) {
    try {
      job.torrent.pause()
    } catch (err) {
      return { success: false, error: errMsg(err) }
    }
  }
  setJobStatus(job, 'paused')
  runScheduler()
  return { success: true }
}

export function engineResume(infoHash: string): { success: boolean; error?: string } {
  const job = jobs.get(normHash(infoHash))
  if (!job) return { success: false, error: 'Unknown download' }
  if (job.status !== 'paused') return { success: true }
  if (job.torrent) {
    try {
      job.torrent.resume()
    } catch (err) {
      return { success: false, error: errMsg(err) }
    }
    setJobStatus(job, 'downloading')
  } else if (job.recoveryInProgress) {
    job.status = 'connecting'
    job.connectingSince = Date.now()
  } else {
    job.status = 'queued'
    runScheduler()
  }
  emitState()
  return { success: true }
}

export async function engineCancel(infoHash: string, removeFiles = false): Promise<{ success: boolean; error?: string }> {
  const key = normHash(infoHash)
  const job = jobs.get(key)
  if (!job) {
    if (client) {
      if (typeof (client as any).remove === 'function' && Array.isArray((client as any).torrents)) {
        for (let i = (client as any).torrents.length - 1; i >= 0; i--) {
          const t = (client as any).torrents[i]
          const tHash = (t?.infoHash || '').toLowerCase().trim()
          if (tHash === key || tHash === normHash(infoHash)) {
            try { t.destroy?.(removeFiles ? { destroyStore: true } : undefined, () => {}) } catch {}
            try { (client as any).torrents.splice(i, 1) } catch {}
          }
        }
      }
      try { (client as any).get?.(infoHash)?.destroy?.(removeFiles ? { destroyStore: true } : undefined, () => {}) } catch {}
      try { (client as any).get?.(key)?.destroy?.(removeFiles ? { destroyStore: true } : undefined, () => {}) } catch {}
      try { (client as any).remove?.(infoHash, removeFiles ? { destroyStore: true } : undefined, () => {}) } catch {}
      try { (client as any).remove?.(key, removeFiles ? { destroyStore: true } : undefined, () => {}) } catch {}
    }
    return { success: false, error: 'Unknown download' }
  }
  jobs.delete(key)
  const torrent = job.torrent || job.connectingTorrent
  job.torrent = null
  job.connectingTorrent = null
  if (torrent) {
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      setTimeout(finish, 3000)
      try {
        torrent.destroy(removeFiles ? { destroyStore: true } : undefined, () => finish())
      } catch {
        finish()
      }
    })
  }
  // Guarantee removal from WebTorrent client so it never throws "Cannot add duplicate torrent"
  if (client) {
    if (typeof (client as any).remove === 'function' && Array.isArray((client as any).torrents)) {
      for (let i = (client as any).torrents.length - 1; i >= 0; i--) {
        const t = (client as any).torrents[i]
        const tHash = (t?.infoHash || '').toLowerCase().trim()
        if (tHash === key || tHash === normHash(infoHash) || t === torrent) {
          try { t.destroy?.(removeFiles ? { destroyStore: true } : undefined, () => {}) } catch {}
          try { (client as any).torrents.splice(i, 1) } catch {}
        }
      }
    }
    try { (client as any).get?.(infoHash)?.destroy?.(removeFiles ? { destroyStore: true } : undefined, () => {}) } catch {}
    try { (client as any).get?.(key)?.destroy?.(removeFiles ? { destroyStore: true } : undefined, () => {}) } catch {}
    try { (client as any).remove?.(infoHash, removeFiles ? { destroyStore: true } : undefined, () => {}) } catch {}
    try { (client as any).remove?.(key, removeFiles ? { destroyStore: true } : undefined, () => {}) } catch {}
  }
  if (removeFiles) cleanupStage(job)
  writePersistFileNow()
  emitState()
  runScheduler()
  return { success: true }
}

export function engineShutdown(): void {
  writePersistFileNow()
  if (client) {
    try {
      client.destroy(() => {})
    } catch {
      /* already destroyed */
    }
    client = null
  }
  enabled = false
  jobs.clear()
  console.log('[torrentEngine] shutdown complete')
}
