import { useCallback, useEffect, useState } from 'react'
import type { UserLibraryEntry, UserListStatus } from '../types'

interface UserLibraryState {
  entries: Record<number, UserLibraryEntry>
  loading: boolean
  setStatus: (anilistId: number, idMal: number | null, titleSnapshot: string, status: UserListStatus) => Promise<void>
  setScore: (anilistId: number, score: number | null) => Promise<void>
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
    async (anilistId: number, idMal: number | null, titleSnapshot: string, status: UserListStatus) => {
      // Optimistic update mirroring the main-process merge semantics: a null
      // idMal / empty titleSnapshot keeps the previously stored values.
      setEntries((prev) => ({
        ...prev,
        [anilistId]: {
          anilistId,
          idMal: typeof idMal === 'number' ? idMal : prev[anilistId]?.idMal ?? null,
          titleSnapshot:
            typeof titleSnapshot === 'string' && titleSnapshot.trim()
              ? titleSnapshot.trim()
              : prev[anilistId]?.titleSnapshot ?? '',
          status,
          score: prev[anilistId]?.score ?? null,
          progress: prev[anilistId]?.progress ?? 0,
          updatedAt: Date.now(),
        },
      }))

      if (!window.electronAPI) return
      try {
        const updated = await window.electronAPI.setUserLibraryStatus(anilistId, idMal, titleSnapshot, status)
        if (updated) {
          setEntries((prev) => ({ ...prev, [updated.anilistId]: updated }))
        }
      } catch (err) {
        console.error('useUserLibrary.setStatus failed:', err)
      }
    },
    []
  )

  const setScore = useCallback(async (anilistId: number, score: number | null) => {
    // The main process ignores scores for titles that are not in the library
    // yet, so the optimistic update mirrors that and keeps an absent entry
    // absent instead of creating a stub.
    setEntries((prev) => {
      const existing = prev[anilistId]
      if (!existing) return prev
      return { ...prev, [anilistId]: { ...existing, score, updatedAt: Date.now() } }
    })

    if (!window.electronAPI) return
    try {
      const updated = await window.electronAPI.setUserLibraryScore(anilistId, score)
      if (updated) {
        setEntries((prev) => ({ ...prev, [updated.anilistId]: updated }))
      }
    } catch (err) {
      console.error('useUserLibrary.setScore failed:', err)
    }
  }, [])

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), [])

  return { entries, loading, setStatus, setScore, refresh }
}
