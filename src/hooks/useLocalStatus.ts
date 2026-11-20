import { useMemo } from 'react'
import type { AnimeFolder, PlaybackProgress, UserLibraryEntry } from '../types'
import { isFolderMovie } from '../utils/format'
import {
  findAllLocalFolders,
  getFolderAnilistId,
  mergeLocalFolders,
  normalizeMatchTitle,
} from '../utils/releaseSelection'

export { findAllLocalFolders, mergeLocalFolders, normalizeMatchTitle }

export interface LocalBadgeState {
  isOnPc: boolean
  downloadedEpisodes: number
  totalEpisodes: number
  isDownloading: boolean
  downloadProgress?: number
  isWatched: boolean
  releaseBadges: string[] // subset of ['Sub', 'Dub Sub', 'Ext Sub', 'Movie']
}

/** Lookup reference used to resolve a rail/card item against local data. */
export interface LocalStatusRef {
  anilistId?: number | null
  title?: string | null
  apiEpisodesCount?: number | null
}

interface LocalStatusResult {
  statusFor: (ref: LocalStatusRef) => LocalBadgeState | null
}

function normalizeRefAnilistId(anilistId?: number | null): number | null {
  if (typeof anilistId !== 'number' || !Number.isFinite(anilistId) || anilistId <= 0) return null
  return Math.trunc(anilistId)
}

/**
 * Resolves a local library folder for a catalog reference. Exact anilistId
 * match first (folders may carry exact AniList ids), normalized-title match
 * second (canonicalTitle, falling back to the raw folder name). Folders that
 * carry an exact id never fuzzy-match a different id: sibling entries of a
 * franchise share titles (Haruhi 2006 vs the 2009 rebroadcast), and a title
 * match would attach one folder to several entries.
 */
export function findLocalFolder(
  folders: AnimeFolder[],
  ref: { anilistId?: number | null; title?: string | null }
): AnimeFolder | null {
  return findAllLocalFolders(folders, ref)[0] ?? null
}

/**
 * Maps local library folders + playback history + user library entries onto
 * catalog items. Returns a `statusFor(ref)` resolver that yields null when
 * the title is neither on the PC nor in the user library (i.e. no badge
 * should be shown). The resolution is memoized over all three inputs.
 */
export function useLocalStatus(
  folders: AnimeFolder[],
  history: Record<string, PlaybackProgress>,
  userEntries: Record<number, UserLibraryEntry>
): LocalStatusResult {
  const indexes = useMemo(() => {
    const byAnilistGroups = new Map<number, AnimeFolder[]>()
    const byTitleGroups = new Map<string, AnimeFolder[]>()
    for (const folder of Array.isArray(folders) ? folders : []) {
      if (!folder) continue
      const id = getFolderAnilistId(folder)
      if (id !== null) {
        const list = byAnilistGroups.get(id)
        if (list) list.push(folder)
        else byAnilistGroups.set(id, [folder])
      }
      const titleKey = normalizeMatchTitle(folder.canonicalTitle || folder.folderName)
      if (titleKey) {
        const list = byTitleGroups.get(titleKey)
        if (list) list.push(folder)
        else byTitleGroups.set(titleKey, [folder])
      }
    }
    const byAnilist = new Map<number, AnimeFolder>()
    for (const [id, list] of byAnilistGroups) {
      const merged = mergeLocalFolders(list)
      if (merged) byAnilist.set(id, merged)
    }
    const byTitle = new Map<string, AnimeFolder>()
    for (const [key, list] of byTitleGroups) {
      const merged = mergeLocalFolders(list)
      if (merged) byTitle.set(key, merged)
    }
    return { byAnilist, byTitle }
  }, [folders])

  const statusFor = useMemo(() => {
    const progressMap: Record<string, PlaybackProgress> = history || {}
    const entryMap: Record<number, UserLibraryEntry> = userEntries || {}
    // Result cache: rails/grids call statusFor per card on every render, and
    // memoized AnimeCards need a stable badgeState identity to skip
    // reconciliation. The cache resets with the useMemo's inputs.
    const resultCache = new Map<string, LocalBadgeState | null>()

    return (ref: LocalStatusRef): LocalBadgeState | null => {
      const cacheKey = `${normalizeRefAnilistId(ref?.anilistId) ?? ''}|${ref?.title ?? ''}|${ref?.apiEpisodesCount ?? ''}`
      const cached = resultCache.get(cacheKey)
      if (cached !== undefined) return cached
      const resolved = resolveStatus(ref)
      if (resultCache.size > 600) resultCache.clear()
      resultCache.set(cacheKey, resolved)
      return resolved
    }

    function resolveStatus(ref: LocalStatusRef): LocalBadgeState | null {
      const refId = normalizeRefAnilistId(ref?.anilistId)

      // anilistId match first, normalized-title match second. Exact-id folders
      // are excluded from the fuzzy title pool so one folder cannot light up
      // sibling entries of the same franchise.
      let folder: AnimeFolder | null = refId !== null ? indexes.byAnilist.get(refId) ?? null : null
      if (!folder) {
        const titleKey = normalizeMatchTitle(ref?.title || '')
        if (titleKey) {
          const candidate = indexes.byTitle.get(titleKey) ?? null
          const candidateId = candidate ? getFolderAnilistId(candidate) : null
          if (candidate && !(refId !== null && candidateId !== null && candidateId !== refId)) {
            folder = candidate
          }
        }
      }

      const userEntry = refId !== null ? entryMap[refId] : undefined
      if (!folder) return null

      const downloadedEpisodes = folder.episodes.filter((ep) => !ep?.isDownloading).length
      const apiCount = typeof ref?.apiEpisodesCount === 'number' && Number.isFinite(ref.apiEpisodesCount)
        ? Math.trunc(ref.apiEpisodesCount)
        : 0
      const totalEpisodes = Math.max(folder.totalEpisodes ?? 0, apiCount)

      const userCompleted = userEntry?.status === 'completed'
      const allLocalWatched =
        folder.episodes.length > 0 &&
        folder.episodes.every((ep) => progressMap[ep.filePath]?.completed === true)

      const releaseBadges: string[] = []
      if ((folder.hasExtSubCount ?? 0) > 0) releaseBadges.push('Ext Sub')
      if ((folder.hasDubtitlesCount ?? 0) > 0 || folder.hasEmbeddedDubtitles) releaseBadges.push('Dub Sub')
      if (folder.hasEmbeddedSubtitles) releaseBadges.push('Sub')
      if (isFolderMovie(folder)) releaseBadges.push('Movie')

      // When completed in the user list, suppress "Watched" badge so it doesn't duplicate status.
      const isWatched = !userCompleted && allLocalWatched

      return {
        isOnPc: true,
        downloadedEpisodes,
        totalEpisodes,
        isDownloading: !!folder.isDownloading,
        downloadProgress: folder.downloadProgress,
        isWatched,
        releaseBadges,
      }
    }
  }, [indexes, history, userEntries])

  return { statusFor }
}
