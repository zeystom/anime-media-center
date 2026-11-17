import { useEffect, useMemo, useRef, useState } from 'react'

export type BannerSourceScope = 'season' | 'series'

export interface HeroBannerCandidate {
  url: string
  scope: BannerSourceScope
  /** Relative priority within the same resolution/scope bucket (lower = earlier). */
  order: number
}

export interface BannerDimensions {
  w: number
  h: number
}

/** Vertical resolution & widescreen aspect floors separating true 16:9+ HD
 *  backdrops from boxy 4:3 illustrations and 1900x400 horizontal strips. */
export const MIN_HD_BANNER_HEIGHT = 680
export const MIN_HD_BANNER_WIDTH = 1200
export const MIN_WIDESCREEN_ASPECT = 1.6

const MIN_USABLE_WIDTH = 400
const MIN_USABLE_HEIGHT = 200
const PROBE_TIMEOUT_MS = 8000

const dimensionCache = new Map<string, BannerDimensions | null>()
const dimensionInFlight = new Map<string, Promise<{ dim: BannerDimensions | null; timedOut: boolean }>>()
const resolvedBannerByAnimeId = new Map<number, string>()
const liveBannerByAnimeId = new Map<number, string | null>()

let diskBootstrapStarted = false
let diskBootstrapDone = false
let cacheRevision = 0
const cacheListeners = new Set<() => void>()
const activeBannerSubscribers = new Set<() => void>()

function notifyActiveBannerSubscribers(): void {
  for (const listener of activeBannerSubscribers) listener()
}

function notifyBannerListeners(): void {
  cacheRevision++
  for (const listener of cacheListeners) listener()
  notifyActiveBannerSubscribers()
}

function ensureDiskBootstrap(): void {
  if (diskBootstrapStarted || typeof window === 'undefined') return
  const getter = window.electronAPI?.getCachedHeroBanners
  if (typeof getter !== 'function') {
    diskBootstrapDone = true
    return
  }
  diskBootstrapStarted = true
  void getter()
    .then((map) => {
      if (map && typeof map === 'object') {
        for (const [key, url] of Object.entries(map)) {
          const id = Number(key)
          if (Number.isInteger(id) && id > 0 && typeof url === 'string' && url.startsWith('http')) {
            if (!resolvedBannerByAnimeId.has(id)) {
              resolvedBannerByAnimeId.set(id, url)
            }
          }
        }
      }
    })
    .catch(() => {})
    .finally(() => {
      diskBootstrapDone = true
      notifyBannerListeners()
    })
}

/** Reset module caches (used by automated test suites). */
export function resetHeroBannerCaches(): void {
  dimensionCache.clear()
  dimensionInFlight.clear()
  resolvedBannerByAnimeId.clear()
  liveBannerByAnimeId.clear()
  diskBootstrapStarted = false
  diskBootstrapDone = false
  cacheRevision = 0
  cacheListeners.clear()
  activeBannerSubscribers.clear()
}

/** Invalidate a broken persisted banner URL (e.g. host 404 after disk cache)
 *  so the active hook immediately re-probes and persists a fallback winner. */
export function invalidateResolvedHeroBanner(anilistId: number | null | undefined, failedUrl?: string | null): void {
  let changed = false
  if (failedUrl && dimensionCache.get(failedUrl) !== null) {
    dimensionCache.set(failedUrl, null)
    changed = true
  }
  if (anilistId != null && (!failedUrl || resolvedBannerByAnimeId.get(anilistId) === failedUrl)) {
    if (resolvedBannerByAnimeId.delete(anilistId)) {
      changed = true
    }
  }
  if (anilistId != null && (!failedUrl || liveBannerByAnimeId.get(anilistId) === failedUrl)) {
    if (liveBannerByAnimeId.delete(anilistId)) {
      changed = true
    }
  }
  if (changed) notifyBannerListeners()
}

/** Read synchronously cached resolved banner for an anime ID if known. */
export function getCachedResolvedHeroBanner(anilistId?: number | null): string | undefined {
  if (anilistId == null) return undefined
  return resolvedBannerByAnimeId.get(anilistId)
}

/**
 * Reactive reader for consumers outside the hero card (such as the translucent
 * Navbar glass strip) so their backdrop always matches the resolved hero banner
 * cleanly instead of flashing a mismatched unprobed strip.
 */
export function useActiveHeroBannerUrl(anilistId?: number | null, fallbackUrl?: string | null): string | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    const notify = () => setTick((t) => t + 1)
    activeBannerSubscribers.add(notify)
    if (!diskBootstrapDone) ensureDiskBootstrap()
    return () => {
      activeBannerSubscribers.delete(notify)
    }
  }, [])
  if (anilistId == null) return fallbackUrl ?? null
  if (liveBannerByAnimeId.has(anilistId)) {
    return liveBannerByAnimeId.get(anilistId) ?? fallbackUrl ?? null
  }
  return resolvedBannerByAnimeId.get(anilistId) ?? null
}

/**
 * Deduplicate raw candidate lists while preserving their semantic scope and
 * relative order. Notice if the same URL appears as both season and series,
 * the earlier entry keeps precedence.
 */
export function buildHeroBannerCandidates(
  seasonUrls: (string | null | undefined)[],
  seriesUrls: (string | null | undefined)[],
): HeroBannerCandidate[] {
  const seen = new Set<string>()
  const result: HeroBannerCandidate[] = []
  let order = 0

  for (const raw of seasonUrls) {
    const url = typeof raw === 'string' ? raw.trim() : ''
    if (!url || seen.has(url)) continue
    seen.add(url)
    result.push({ url, scope: 'season', order: order++ })
  }
  for (const raw of seriesUrls) {
    const url = typeof raw === 'string' ? raw.trim() : ''
    if (!url || seen.has(url)) continue
    seen.add(url)
    result.push({ url, scope: 'series', order: order++ })
  }
  return result
}

function isWidescreenHd(dim: BannerDimensions): boolean {
  return (
    dim.h >= MIN_HD_BANNER_HEIGHT &&
    dim.w >= MIN_HD_BANNER_WIDTH &&
    dim.w / dim.h >= MIN_WIDESCREEN_ASPECT
  )
}

/**
 * Unified banner selector used by both Home and AnimeDetailView:
 *   1. True widescreen HD (>=680px tall, >=1200px wide, aspect >= 1.6)
 *      per-season artwork (e.g. Kitsu 1080p/3K/4K seasonal coverImage or HD
 *      AniList movie/season banner). Excludes boxy 4:3 illustrations.
 *   2. True widescreen HD franchise backdrop (Metahub 1080p/4K or TVDB Fanart)
 *      so tall heroes never upscale 400px thin strips or crop 4:3 posters.
 *   3. Widescreen fallback (>=1.5 ratio), then any valid landscape candidate.
 */
export function selectBestHeroBanner(
  candidates: HeroBannerCandidate[],
  dimensionsByUrl: Map<string, BannerDimensions | null>,
): string | null {
  const valid = candidates
    .map((candidate) => ({ candidate, dim: dimensionsByUrl.get(candidate.url) ?? null }))
    .filter((entry): entry is { candidate: HeroBannerCandidate; dim: BannerDimensions } => {
      if (!entry.dim) return false
      return (
        entry.dim.w >= MIN_USABLE_WIDTH &&
        entry.dim.h >= MIN_USABLE_HEIGHT &&
        entry.dim.w >= entry.dim.h
      )
    })

  if (valid.length === 0) return null

  const seasonHd = valid
    .filter(({ candidate, dim }) => candidate.scope === 'season' && isWidescreenHd(dim))
    .sort((a, b) => a.candidate.order - b.candidate.order)
  if (seasonHd.length > 0) return seasonHd[0].candidate.url

  const seriesHd = valid
    .filter(({ candidate, dim }) => candidate.scope === 'series' && isWidescreenHd(dim))
    .sort((a, b) => a.candidate.order - b.candidate.order)
  if (seriesHd.length > 0) return seriesHd[0].candidate.url

  // Fallback: prefer true wide crops (ratio >= 1.5) over boxy 4:3 covers, then taller height.
  valid.sort((a, b) => {
    const aWide = a.dim.w / a.dim.h >= 1.5 ? 1 : 0
    const bWide = b.dim.w / b.dim.h >= 1.5 ? 1 : 0
    if (aWide !== bWide) return bWide - aWide
    const heightDiff = b.dim.h - a.dim.h
    if (Math.abs(heightDiff) >= 80) return heightDiff
    if (a.candidate.scope !== b.candidate.scope) {
      return a.candidate.scope === 'season' ? -1 : 1
    }
    return a.candidate.order - b.candidate.order
  })
  return valid[0].candidate.url
}

function probeBrowserImage(url: string): Promise<{ dim: BannerDimensions | null; timedOut: boolean }> {
  if (dimensionCache.has(url)) {
    return Promise.resolve({ dim: dimensionCache.get(url) ?? null, timedOut: false })
  }
  const existing = dimensionInFlight.get(url)
  if (existing) return existing

  const promise = new Promise<{ dim: BannerDimensions | null; timedOut: boolean }>((resolve) => {
    if (typeof Image === 'undefined') {
      resolve({ dim: null, timedOut: false })
      return
    }
    let done = false
    const img = new Image()
    const finish = (dim: BannerDimensions | null, timedOut: boolean) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      dimensionInFlight.delete(url)
      // Only cache definitive results (loaded or explicit 404); transient
      // startup timeouts must never blacklist a good HD host for the session.
      if (!timedOut) {
        dimensionCache.set(url, dim)
      }
      resolve({ dim, timedOut })
    }
    const timer = window.setTimeout(() => finish(null, true), PROBE_TIMEOUT_MS)
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      finish(w > 0 && h > 0 ? { w, h } : null, false)
    }
    img.onerror = () => finish(null, false)
    img.src = url
  })

  dimensionInFlight.set(url, promise)
  return promise
}

interface UseResolvedHeroBannerParams {
  anilistId?: number | null
  settled: boolean
  candidates: HeroBannerCandidate[]
}

interface ResolvedHeroBannerResult {
  bannerUrl: string | null
  ready: boolean
}

/**
 * Shared hero banner hook used by Home (`UpNextWidget`) and Card (`AnimeDetailView`).
 * Reads from the disk-persisted `hero_banners_v1.json` cache at startup (~1 ms)
 * so cached banners appear immediately on every restart without probing or
 * flipping between sources. Cold visits probe once cleanly and persist the winner.
 */
export function useResolvedHeroBanner({
  anilistId,
  settled,
  candidates,
}: UseResolvedHeroBannerParams): ResolvedHeroBannerResult {
  const candidatesKey = useMemo(
    () => candidates.map((c) => `${c.scope}:${c.url}`).join('|'),
    [candidates],
  )
  const [cacheTick, setCacheTick] = useState(cacheRevision)

  useEffect(() => {
    const notify = () => setCacheTick(cacheRevision)
    cacheListeners.add(notify)
    if (!diskBootstrapDone) ensureDiskBootstrap()
    if (cacheRevision !== cacheTick) notify()
    return () => {
      cacheListeners.delete(notify)
    }
  }, [cacheTick])

  const cachedUrl = anilistId != null ? resolvedBannerByAnimeId.get(anilistId) : undefined

  const [resolvedState, setResolvedState] = useState<{
    anilistId: number | null | undefined
    key: string
    cacheTick: number
    url: string | null
  } | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    // Wait until disk cache is read (~1-2 ms) before running cold probes.
    if (!diskBootstrapDone && typeof window !== 'undefined' && typeof window.electronAPI?.getCachedHeroBanners === 'function') return
    // Already persisted on disk / resolved in RAM: reuse immediately without re-probing.
    if (anilistId != null && resolvedBannerByAnimeId.has(anilistId)) return
    if (!settled) return
    if (candidates.length === 0) {
      if (anilistId != null && (!liveBannerByAnimeId.has(anilistId) || liveBannerByAnimeId.get(anilistId) !== null)) {
        liveBannerByAnimeId.set(anilistId, null)
        notifyActiveBannerSubscribers()
      }
      setResolvedState({ anilistId, key: candidatesKey, cacheTick, url: null })
      return
    }

    let cancelled = false
    const snapshotCandidates = candidates
    const snapshotKey = candidatesKey
    const snapshotId = anilistId
    const snapshotTick = cacheTick

    void Promise.all(
      snapshotCandidates.map(async (c) => ({ url: c.url, ...(await probeBrowserImage(c.url)) })),
    ).then((entries) => {
      if (cancelled || !mountedRef.current) return
      const timedOutUrls = new Set(entries.filter((entry) => entry.timedOut).map((entry) => entry.url))
      const dimMap = new Map<string, BannerDimensions | null>(
        entries.map((entry) => [entry.url, entry.dim]),
      )
      const winner = selectBestHeroBanner(snapshotCandidates, dimMap)
      const winnerDim = winner ? dimMap.get(winner) ?? null : null
      const winnerCandidate = winner ? snapshotCandidates.find((c) => c.url === winner) ?? null : null
      const higherSeasonTimedOut = Boolean(
        winnerCandidate &&
          snapshotCandidates.some(
            (c) => timedOutUrls.has(c.url) && c.scope === 'season' && c.order < winnerCandidate.order,
          ),
      )
      // Persist on disk only when no higher-priority season candidate timed out
      // and the winner isn't a degraded fallback caused by a timeout.
      const winnerIsClean = Boolean(
        winner &&
          (timedOutUrls.size === 0 || (winnerDim && isWidescreenHd(winnerDim) && !higherSeasonTimedOut)),
      )
      if (snapshotId != null && winner && winnerIsClean) {
        resolvedBannerByAnimeId.set(snapshotId, winner)
        void window.electronAPI?.saveCachedHeroBanner?.(snapshotId, winner).catch(() => {})
      }
      if (snapshotId != null && (!liveBannerByAnimeId.has(snapshotId) || liveBannerByAnimeId.get(snapshotId) !== winner)) {
        liveBannerByAnimeId.set(snapshotId, winner)
        notifyActiveBannerSubscribers()
      }
      setResolvedState({ anilistId: snapshotId, key: snapshotKey, cacheTick: snapshotTick, url: winner })
    })

    return () => {
      cancelled = true
    }
  }, [anilistId, settled, candidatesKey, candidates, cachedUrl, cacheTick])

  if (typeof window === 'undefined') {
    return { bannerUrl: candidates[0]?.url ?? null, ready: Boolean(candidates[0]?.url) }
  }

  if (cachedUrl !== undefined) {
    return { bannerUrl: cachedUrl, ready: true }
  }

  if (
    resolvedState &&
    resolvedState.anilistId === anilistId &&
    resolvedState.key === candidatesKey &&
    resolvedState.cacheTick === cacheTick
  ) {
    return { bannerUrl: resolvedState.url, ready: true }
  }

  return { bannerUrl: null, ready: false }
}
