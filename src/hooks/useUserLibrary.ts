import { useCallback, useEffect, useState } from 'react'
import type { UserLibraryEntry, UserListStatus } from '../types'

interface UserLibraryState {
  entries: Record<number, UserLibraryEntry>
  loading: boolean
  setStatus: (
    anilistId: number,
    idMal: number | null,
    titleSnapshot: string,
    status: UserListStatus,
    posterUrl?: string | null,
    totalEpisodes?: number | null
  ) => Promise<UserLibraryEntry | null>
  setScore: (anilistId: number, score: number | null) => Promise<UserLibraryEntry | null>
  remove: (anilistId: number) => Promise<boolean>
  refresh: () => void
}

/**
 * User library (AniList-style list statuses / scores) with optimistic local
 * updates: mutations are applied to local state immediately, then the IPC
 * call fires and the authoritative response entry (if any) replaces the
 * optimistic one. Load failures degrade to an empty library; mutations are
 * never re-rolled on IPC failure (the optimistic value stands, the error is
 * logged for diagnosis).
 */
export function useUserLibrary(): UserLibraryState {
  const [entries, setEntries] = useState<Record<number, UserLibraryEntry>>({})
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        if (!window.electronAPI) {
          if (!cancelled) {
            setEntries({})
            setLoading(false)
          }
          return
        }
        const data = await window.electronAPI.getUserLibrary()
        if (!cancelled) setEntries(data && typeof data === 'object' ? data : {})
      } catch (err) {
        console.error('useUserLibrary: failed to load user library:', err)
        if (!cancelled) setEntries({})
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [refreshTick])

  const setStatus = useCallback(
    async (
      anilistId: number,
      idMal: number | null,
      titleSnapshot: string,
      status: UserListStatus,
      posterUrl?: string | null,
      totalEpisodes?: number | null
    ): Promise<UserLibraryEntry | null> => {
      let optimisticEntry: UserLibraryEntry | null = null
      setEntries((prev) => {
        const existing = prev[anilistId]
        const entry: UserLibraryEntry = {
          anilistId,
          idMal: typeof idMal === 'number' ? idMal : existing?.idMal ?? null,
          titleSnapshot:
            typeof titleSnapshot === 'string' && titleSnapshot.trim()
              ? titleSnapshot.trim()
              : existing?.titleSnapshot ?? '',
          status,
          score: existing?.score ?? null,
          progress: existing?.progress ?? 0,
          updatedAt: Date.now(),
        }
        const finalPoster = typeof posterUrl === 'string' && posterUrl.trim() ? posterUrl.trim() : existing?.posterUrl
        if (finalPoster) entry.posterUrl = finalPoster
        const finalTotal = typeof totalEpisodes === 'number' && Number.isFinite(totalEpisodes) ? Math.max(0, Math.trunc(totalEpisodes)) : existing?.totalEpisodes
        if (typeof finalTotal === 'number') entry.totalEpisodes = finalTotal
        optimisticEntry = entry
        return {
          ...prev,
          [anilistId]: entry,
        }
      })

      if (!window.electronAPI) return optimisticEntry
      try {
        const updated = await window.electronAPI.setUserLibraryStatus(
          anilistId,
          idMal,
          titleSnapshot,
          status,
          posterUrl,
          totalEpisodes
        )
        if (updated) {
          setEntries((prev) => ({ ...prev, [updated.anilistId]: updated }))
          return updated
        }
      } catch (err) {
        console.error('useUserLibrary.setStatus failed:', err)
      }
      return optimisticEntry
    },
    []
  )

  const setScore = useCallback(async (anilistId: number, score: number | null): Promise<UserLibraryEntry | null> => {
    let resultEntry: UserLibraryEntry | null = null
    setEntries((prev) => {
      const existing = prev[anilistId]
      if (!existing) return prev
      resultEntry = { ...existing, score, updatedAt: Date.now() }
      return { ...prev, [anilistId]: resultEntry }
    })

    if (!window.electronAPI) return resultEntry
    try {
      const updated = await window.electronAPI.setUserLibraryScore(anilistId, score)
      if (updated) {
        setEntries((prev) => ({ ...prev, [updated.anilistId]: updated }))
        return updated
      }
    } catch (err) {
      console.error('useUserLibrary.setScore failed:', err)
    }
    return resultEntry
  }, [])

  const remove = useCallback(async (anilistId: number): Promise<boolean> => {
    setEntries((prev) => {
      const next = { ...prev }
      delete next[anilistId]
      return next
    })
    if (!window.electronAPI?.removeUserLibraryEntry) return true
    try {
      return await window.electronAPI.removeUserLibraryEntry(anilistId)
    } catch (err) {
      console.error('useUserLibrary.remove failed:', err)
      return false
    }
  }, [])

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), [])

  return { entries, loading, setStatus, setScore, remove, refresh }
}
