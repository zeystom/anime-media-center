import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Film,
  RotateCcw,
  Search,
  X,
} from 'lucide-react'
import type { AiringEntry } from '../../types'
import type { RailItem } from '../../hooks/useCatalog'
import { toRailItem, useAiringSchedule } from '../../hooks/useCatalog'
import type { LocalBadgeState, LocalStatusRef } from '../../hooks/useLocalStatus'
import type { FollowedAnime } from '../../types/notifications'
import { StatusBadges } from '../common/StatusBadges'

export interface ScheduleViewProps {
  onSelectItem: (item: RailItem) => void
  statusFor: (ref: LocalStatusRef) => LocalBadgeState | null
  followedAnime?: FollowedAnime[]
}

interface ScheduleEntry {
  entry: AiringEntry
  rail: RailItem
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const FULL_WEEKDAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000

const STEPPER_BTN =
  'flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-[#0F0B15]/85 text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.06] hover:text-white'

const PRESET_ACTIVE =
  'bg-[linear-gradient(135deg,#FF1E6D_0%,#A31246_100%)] text-white shadow-[0_4px_14px_rgba(255,30,109,0.35)]'

const PRESET_IDLE = 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-100'

/** Monday-start local calendar day (time zeroed). */
function startOfWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const daysSinceMonday = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - daysSinceMonday)
  return d
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** Local YYYY-MM-DD string suitable for `<input type="date">`. */
function toDateInputValue(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Parses YYYY-MM-DD in local time so timezone offsets never shift the day. */
function parseLocalDateInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(year, month - 1, day)
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null
  }
  return parsed
}

/** 'Nov 3' (optionally with year). */
function formatShortDate(date: Date, withYear = false): string {
  return date.toLocaleDateString(
    'en-US',
    withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }
  )
}

/** 'November 9, 2026' for the focused day header. */
function formatFullDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

/** Local HH:MM (24h) for a unix-seconds airing timestamp. */
function formatEntryTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** Builds a 6-week (42-day) Monday-first grid for the given month/year. */
function buildCalendarCells(viewDate: Date): Date[] {
  const firstOfMonth = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1)
  const gridStart = startOfWeek(firstOfMonth)
  return Array.from({ length: 42 }, (_, idx) => {
    const cell = new Date(gridStart)
    cell.setDate(gridStart.getDate() + idx)
    return cell
  })
}

const titleKey = (value: string): string =>
  value.toLocaleLowerCase().replace(/\b(season|s)\s*\d+\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * One airing entry inside a day card: 40px poster, EP chip + local time,
 * clamped title and local-status badges. Clicking selects the title.
 * Followed titles are emphasized with a crimson outline, bell badge and rose styling.
 */
const ScheduleEntryRow: React.FC<{
  item: ScheduleEntry
  isFollowed?: boolean
  statusFor: (ref: LocalStatusRef) => LocalBadgeState | null
  onSelect: (item: RailItem) => void
}> = ({ item, isFollowed = false, statusFor, onSelect }) => {
  const [imgError, setImgError] = useState(false)

  useEffect(() => {
    setImgError(false)
  }, [item.rail.posterUrl])

  const badges = statusFor({
    anilistId: item.rail.anilistId,
    title: item.rail.title,
    apiEpisodesCount: item.rail.episodesCount ?? null,
  })
  const showPoster = !!item.rail.posterUrl && !imgError

  return (
    <div
      onClick={() => onSelect(item.rail)}
      className={`group relative flex cursor-pointer items-center gap-2.5 rounded-xl p-2 transition-all ${
        isFollowed
          ? 'border border-rose-500/40 bg-gradient-to-r from-rose-500/15 via-rose-500/[0.05] to-transparent shadow-sm shadow-rose-950/30 hover:border-rose-400/60 hover:bg-rose-500/20'
          : 'border border-white/[0.04] bg-black/20 hover:border-white/[0.1] hover:bg-white/[0.05]'
      }`}
    >
      <div
        className={`relative aspect-[2/3] w-10 shrink-0 overflow-hidden rounded-md bg-zinc-950 ${
          isFollowed ? 'ring-1 ring-rose-500/40' : ''
        }`}
      >
        {showPoster ? (
          <img
            src={item.rail.posterUrl || ''}
            alt=""
            loading="lazy"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Film className="h-4 w-4 text-zinc-700" />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
              isFollowed ? 'bg-rose-500/25 text-rose-200' : 'bg-zinc-800 text-zinc-300'
            }`}
          >
            EP {item.entry.episode ?? '?'}
          </span>
          <span className={`font-mono text-[11px] ${isFollowed ? 'font-medium text-rose-200/90' : 'text-zinc-400'}`}>
            {formatEntryTime(item.entry.airingAt)}
          </span>
          {isFollowed && (
            <span
              title="Followed series"
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-rose-500/30 bg-rose-500/20 px-1.5 py-0.5 text-[9px] font-bold text-rose-300 shadow-xs"
            >
              <Bell className="h-2.5 w-2.5 fill-rose-300 text-rose-300" />
              <span>Followed</span>
            </span>
          )}
        </div>
        <p
          className={`mt-0.5 truncate text-xs font-medium transition-colors ${
            isFollowed ? 'font-semibold text-white group-hover:text-rose-200' : 'text-zinc-200'
          }`}
          title={item.rail.title}
        >
          {item.rail.title}
        </p>
        {badges && <StatusBadges state={badges} size="sm" className="mt-1" />}
      </div>
    </div>
  )
}

/**
 * Weekly airing-schedule calendar with quick week/day presets, interactive
 * date-picker popover, 7-day strip, title search, and a "Followed only" filter.
 */
export const ScheduleView: React.FC<ScheduleViewProps> = ({ onSelectItem, statusFor, followedAnime }) => {
  const [weekOffset, setWeekOffset] = useState(0)
  const [selectedDayIndex, setSelectedDayIndex] = useState<number | null>(null)
  const [onlyFollowed, setOnlyFollowed] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isCalendarOpen, setIsCalendarOpen] = useState(false)
  const [calendarViewDate, setCalendarViewDate] = useState<Date>(() => new Date())
  const calendarPopoverRef = useRef<HTMLDivElement | null>(null)

  const { entries, loading, error, refresh } = useAiringSchedule(weekOffset)

  const today = useMemo(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  }, [])
  const todayKey = dayKey(today)
  const todayDayIndex = (today.getDay() + 6) % 7

  const weekStart = useMemo(() => {
    const start = startOfWeek(new Date())
    start.setDate(start.getDate() + weekOffset * 7)
    return start
  }, [weekOffset])

  const weekEnd = useMemo(() => {
    const end = new Date(weekStart)
    end.setDate(end.getDate() + 6)
    return end
  }, [weekStart])

  const dayDates = useMemo(
    () =>
      WEEKDAY_LABELS.map((_, i) => {
        const d = new Date(weekStart)
        d.setDate(d.getDate() + i)
        return d
      }),
    [weekStart]
  )

  const activeAnchorDate = selectedDayIndex !== null ? dayDates[selectedDayIndex] : weekStart

  // Sync the calendar month view when opening the popover.
  useEffect(() => {
    if (!isCalendarOpen) return
    setCalendarViewDate(new Date(activeAnchorDate.getFullYear(), activeAnchorDate.getMonth(), 1))
  }, [isCalendarOpen, activeAnchorDate])

  // Close the calendar popover on outside click or Escape.
  useEffect(() => {
    if (!isCalendarOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (calendarPopoverRef.current && !calendarPopoverRef.current.contains(event.target as Node)) {
        setIsCalendarOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsCalendarOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isCalendarOpen])

  const rangeLabel = useMemo(() => {
    const sameYear = weekStart.getFullYear() === weekEnd.getFullYear()
    return sameYear
      ? `${formatShortDate(weekStart)} – ${formatShortDate(weekEnd, true)}`
      : `${formatShortDate(weekStart, true)} – ${formatShortDate(weekEnd, true)}`
  }, [weekStart, weekEnd])

  const jumpToDate = useCallback((targetDate: Date, focusDay = true) => {
    const currentMonday = startOfWeek(new Date())
    const targetMonday = startOfWeek(targetDate)
    const offset = Math.round((targetMonday.getTime() - currentMonday.getTime()) / MS_PER_WEEK)
    const dayIdx = (targetDate.getDay() + 6) % 7
    setWeekOffset(offset)
    setSelectedDayIndex(focusDay ? dayIdx : null)
  }, [])

  const stepFocusedDay = useCallback(
    (delta: -1 | 1) => {
      if (selectedDayIndex === null) return
      const next = selectedDayIndex + delta
      if (next < 0) {
        setWeekOffset((w) => w - 1)
        setSelectedDayIndex(6)
      } else if (next > 6) {
        setWeekOffset((w) => w + 1)
        setSelectedDayIndex(0)
      } else {
        setSelectedDayIndex(next)
      }
    },
    [selectedDayIndex]
  )

  const followedSet = useMemo(() => {
    if (!followedAnime || followedAnime.length === 0) return null
    const idSet = new Set<number>()
    const keySet = new Set<string>()
    for (const f of followedAnime) {
      if (f.anilistId) idSet.add(f.anilistId)
      if (f.title) {
        const key = titleKey(f.title)
        if (key) keySet.add(key)
      }
    }
    return { idSet, keySet }
  }, [followedAnime])

  const checkIsFollowed = useCallback(
    (item: ScheduleEntry): boolean => {
      if (!followedSet) return false
      const targetId = item.entry.anilistId || item.rail.anilistId
      if (targetId && followedSet.idSet.has(targetId)) return true
      const rawTitle = item.rail.title || item.entry.title || ''
      const key = titleKey(rawTitle)
      return !!(key && followedSet.keySet.has(key))
    },
    [followedSet]
  )

  // Group the week's entries into Mon..Sun buckets by LOCAL weekday of the
  // airing timestamp, prioritized with followed anime at the top of each day.
  const days = useMemo(() => {
    const buckets: ScheduleEntry[][] = [[], [], [], [], [], [], []]
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry.airingAt !== 'number' || !Number.isFinite(entry.airingAt)) continue
      const index = (new Date(entry.airingAt * 1000).getDay() + 6) % 7
      buckets[index].push({ entry, rail: toRailItem(entry) })
    }
    for (const bucket of buckets) {
      bucket.sort((a, b) => {
        const aFollowed = checkIsFollowed(a)
        const bFollowed = checkIsFollowed(b)
        if (aFollowed !== bFollowed) {
          return aFollowed ? -1 : 1
        }
        return a.entry.airingAt - b.entry.airingAt
      })
    }
    return buckets
  }, [entries, checkIsFollowed])

  const normalizedQuery = searchQuery.trim().toLowerCase()

  const filteredDays = useMemo(() => {
    return days.map((bucket) =>
      bucket.filter((item) => {
        if (onlyFollowed && !checkIsFollowed(item)) return false
        if (normalizedQuery) {
          const title = (item.rail.title || item.entry.title || '').toLowerCase()
          if (!title.includes(normalizedQuery)) return false
        }
        return true
      })
    )
  }, [days, onlyFollowed, checkIsFollowed, normalizedQuery])

  const followedCountsByDay = useMemo(
    () => days.map((bucket) => bucket.filter(checkIsFollowed).length),
    [days, checkIsFollowed]
  )
  const weeklyFollowedCount = useMemo(
    () => followedCountsByDay.reduce((sum, count) => sum + count, 0),
    [followedCountsByDay]
  )
  const totalFilteredCount = useMemo(
    () => filteredDays.reduce((sum, bucket) => sum + bucket.length, 0),
    [filteredDays]
  )

  const calendarCells = useMemo(() => buildCalendarCells(calendarViewDate), [calendarViewDate])
  const calendarMonthLabel = calendarViewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  const hasCustomState =
    weekOffset !== 0 || selectedDayIndex !== null || onlyFollowed || normalizedQuery.length > 0

  const resetAll = () => {
    setWeekOffset(0)
    setSelectedDayIndex(null)
    setOnlyFollowed(false)
    setSearchQuery('')
  }

  const weekStartMs = weekStart.getTime()
  const weekEndMs = weekEnd.getTime()
  const focusedDayKey = selectedDayIndex !== null ? dayKey(dayDates[selectedDayIndex]) : null

  return (
    <div className="mx-auto min-h-full w-full max-w-[1800px] px-6 py-7 2xl:px-12">
      {/* Symmetrical hero banner matching Discover and Library */}
      <section className="relative mb-6 flex h-[160px] flex-col justify-center overflow-hidden rounded-[26px] border border-white/[0.08] bg-[#0F0B15] px-6 shadow-2xl shadow-black/20 md:h-[168px] md:px-9">
        <div className="pointer-events-none absolute -right-20 -top-32 h-80 w-80 rounded-full bg-rose-500/[0.08] blur-3xl" />
        <div className="pointer-events-none absolute -bottom-36 left-1/3 h-72 w-72 rounded-full bg-violet-500/[0.07] blur-3xl" />
        <div className="relative">
          <div className="flex items-center gap-2 text-rose-300">
            <CalendarDays className="h-4 w-4" />
            <span className="text-[10px] font-bold uppercase tracking-[0.22em]">Kaiko / Schedule</span>
          </div>
          <h1 className="mt-2.5 text-3xl font-black leading-tight tracking-tight text-white md:text-4xl">Airing schedule</h1>
          <p className="mt-2 max-w-3xl truncate text-sm leading-normal text-zinc-400">
            Track weekly episode broadcasts, jump to any date, and follow airing anime in your local timezone.
          </p>
        </div>
      </section>

      {/* Schedule control panel: quick date presets, calendar popover, search, followed toggle & 7-day strip */}
      <section className="relative z-20 mb-6 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 shadow-xl shadow-black/10 md:p-5">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Left cluster: quick presets + week stepper & calendar date picker */}
            <div className="flex flex-wrap items-center gap-2.5">
              <div
                role="group"
                aria-label="Quick date presets"
                className="inline-flex flex-wrap items-center rounded-xl border border-white/[0.08] bg-[#0c0910] p-1"
              >
                <button
                  type="button"
                  onClick={() => {
                    setWeekOffset(-1)
                    setSelectedDayIndex(null)
                  }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                    weekOffset === -1 && selectedDayIndex === null ? PRESET_ACTIVE : PRESET_IDLE
                  }`}
                >
                  Last week
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWeekOffset(0)
                    setSelectedDayIndex(null)
                  }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                    weekOffset === 0 && selectedDayIndex === null ? PRESET_ACTIVE : PRESET_IDLE
                  }`}
                >
                  This week
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWeekOffset(0)
                    setSelectedDayIndex(todayDayIndex)
                  }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                    weekOffset === 0 && selectedDayIndex === todayDayIndex ? PRESET_ACTIVE : PRESET_IDLE
                  }`}
                >
                  Today
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWeekOffset(1)
                    setSelectedDayIndex(null)
                  }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                    weekOffset === 1 && selectedDayIndex === null ? PRESET_ACTIVE : PRESET_IDLE
                  }`}
                >
                  Next week
                </button>
              </div>

              {/* Week navigation + Calendar Popover */}
              <div className="relative flex items-center gap-1.5" ref={calendarPopoverRef}>
                <button
                  type="button"
                  onClick={() => setWeekOffset((w) => w - 1)}
                  title="Previous week"
                  aria-label="Previous week"
                  className={STEPPER_BTN}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  onClick={() => setIsCalendarOpen((open) => !open)}
                  aria-expanded={isCalendarOpen}
                  title="Open date picker"
                  className={`flex h-9 items-center gap-2 rounded-xl border px-3 text-xs font-bold transition ${
                    isCalendarOpen
                      ? 'border-rose-400/50 bg-[#1d1320] text-rose-200 ring-1 ring-rose-500/20'
                      : 'border-white/[0.08] bg-[#0F0B15]/85 text-zinc-200 hover:border-white/20 hover:text-white'
                  }`}
                >
                  <CalendarDays className="h-3.5 w-3.5 text-rose-300" />
                  <span>{rangeLabel}</span>
                  {weekOffset !== 0 && (
                    <span className="rounded-md bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-extrabold text-rose-200">
                      {weekOffset > 0 ? `+${weekOffset}w` : `${weekOffset}w`}
                    </span>
                  )}
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${
                      isCalendarOpen ? 'rotate-180 text-rose-300' : ''
                    }`}
                  />
                </button>

                <button
                  type="button"
                  onClick={() => setWeekOffset((w) => w + 1)}
                  title="Next week"
                  aria-label="Next week"
                  className={STEPPER_BTN}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>

                {hasCustomState && (
                  <button
                    type="button"
                    onClick={resetAll}
                    title="Reset schedule view and filters"
                    className="ml-0.5 inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/[0.08] bg-[#0F0B15]/85 px-3 text-xs font-semibold text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Reset</span>
                  </button>
                )}

                {/* Calendar Date Picker Popover */}
                {isCalendarOpen && (
                  <div className="glass-dropdown animate-pop-in absolute left-0 top-full z-50 mt-2 w-80 rounded-2xl p-4">
                    <div className="flex items-center justify-between pb-3">
                      <button
                        type="button"
                        onClick={() =>
                          setCalendarViewDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))
                        }
                        title="Previous month"
                        aria-label="Previous month"
                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-300 transition hover:bg-white/[0.1] hover:text-white"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <span className="text-xs font-extrabold uppercase tracking-wider text-white">
                        {calendarMonthLabel}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setCalendarViewDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))
                        }
                        title="Next month"
                        aria-label="Next month"
                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-300 transition hover:bg-white/[0.1] hover:text-white"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>

                    {/* Direct date input */}
                    <label className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-[#07060A]/80 px-3 py-2">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                        Go to date
                      </span>
                      <input
                        type="date"
                        value={toDateInputValue(activeAnchorDate)}
                        onChange={(e) => {
                          const parsed = parseLocalDateInput(e.target.value)
                          if (parsed) {
                            jumpToDate(parsed, true)
                            setCalendarViewDate(new Date(parsed.getFullYear(), parsed.getMonth(), 1))
                          }
                        }}
                        className="bg-transparent text-xs font-semibold text-zinc-100 outline-none [color-scheme:dark]"
                      />
                    </label>

                    {/* Weekday headers */}
                    <div className="mb-1.5 grid grid-cols-7 gap-1 text-center">
                      {WEEKDAY_LABELS.map((wd) => (
                        <span
                          key={wd}
                          className="text-[10px] font-bold uppercase tracking-wider text-zinc-500"
                        >
                          {wd}
                        </span>
                      ))}
                    </div>

                    {/* 42-cell month grid */}
                    <div className="grid grid-cols-7 gap-1">
                      {calendarCells.map((cell) => {
                        const cellMs = cell.getTime()
                        const inCurrentMonth =
                          cell.getMonth() === calendarViewDate.getMonth() &&
                          cell.getFullYear() === calendarViewDate.getFullYear()
                        const inSelectedWeek = cellMs >= weekStartMs && cellMs <= weekEndMs
                        const isCellToday = dayKey(cell) === todayKey
                        const isFocusedCell = focusedDayKey === dayKey(cell)

                        return (
                          <button
                            key={cell.toISOString()}
                            type="button"
                            onClick={() => {
                              jumpToDate(cell, true)
                              setIsCalendarOpen(false)
                            }}
                            className={`relative flex h-8 items-center justify-center rounded-lg text-xs font-semibold transition ${
                              isFocusedCell
                                ? 'bg-[linear-gradient(135deg,#FF1E6D_0%,#A31246_100%)] font-bold text-white shadow-[0_4px_12px_rgba(255,30,109,0.4)]'
                                : inSelectedWeek
                                  ? 'bg-rose-500/15 text-rose-100 hover:bg-rose-500/25'
                                  : inCurrentMonth
                                    ? 'text-zinc-200 hover:bg-white/[0.08] hover:text-white'
                                    : 'text-zinc-600 hover:bg-white/[0.05] hover:text-zinc-300'
                            } ${
                              isCellToday && !isFocusedCell
                                ? 'ring-1 ring-inset ring-rose-400/60'
                                : ''
                            }`}
                          >
                            <span>{cell.getDate()}</span>
                            {isCellToday && (
                              <span
                                className={`absolute bottom-1 h-1 w-1 rounded-full ${
                                  isFocusedCell ? 'bg-white' : 'bg-rose-400'
                                }`}
                              />
                            )}
                          </button>
                        )
                      })}
                    </div>

                    {/* Popover footer */}
                    <div className="mt-3 flex items-center justify-between border-t border-white/[0.08] pt-3">
                      <button
                        type="button"
                        onClick={() => {
                          jumpToDate(new Date(), true)
                          setIsCalendarOpen(false)
                        }}
                        className="rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-[11px] font-bold text-zinc-200 transition hover:bg-white/[0.12] hover:text-white"
                      >
                        Jump to Today
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedDayIndex(null)
                          setIsCalendarOpen(false)
                        }}
                        className="rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-rose-300 transition hover:bg-rose-500/15 hover:text-rose-200"
                      >
                        Show whole week
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right cluster: title search + Followed only checkbox */}
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="relative min-w-[220px] sm:w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search anime in schedule…"
                  className="h-9 w-full rounded-xl border border-white/[0.08] bg-[#07060A] pl-9 pr-8 text-xs text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-rose-400/50 focus:ring-2 focus:ring-rose-500/10"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear schedule search"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 transition hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <label
                className={`flex h-9 cursor-pointer select-none items-center gap-2 rounded-xl border px-3 text-xs font-bold transition ${
                  onlyFollowed
                    ? 'border-rose-400/50 bg-rose-500/15 text-rose-100 shadow-sm shadow-rose-950/30'
                    : 'border-white/[0.08] bg-[#0F0B15]/85 text-zinc-300 hover:border-white/20 hover:text-white'
                }`}
              >
                <input
                  type="checkbox"
                  checked={onlyFollowed}
                  onChange={(e) => setOnlyFollowed(e.target.checked)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 items-center justify-center rounded border transition ${
                    onlyFollowed
                      ? 'border-rose-400 bg-rose-500 text-white'
                      : 'border-white/20 bg-black/40 text-transparent'
                  }`}
                >
                  <Check className="h-3 w-3 stroke-[3]" />
                </span>
                <Bell className={`h-3.5 w-3.5 ${onlyFollowed ? 'fill-rose-300 text-rose-300' : 'text-zinc-400'}`} />
                <span>Followed only</span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold ${
                    onlyFollowed
                      ? 'bg-rose-500/30 text-rose-100'
                      : 'bg-white/[0.06] text-zinc-400'
                  }`}
                >
                  {weeklyFollowedCount}
                </span>
              </label>
            </div>
          </div>

          {/* Interactive 7-Day Date Strip */}
          <div className="grid grid-cols-2 gap-2 border-t border-white/[0.06] pt-3.5 sm:grid-cols-4 lg:grid-cols-8">
            <button
              type="button"
              onClick={() => setSelectedDayIndex(null)}
              className={`flex flex-col justify-between rounded-xl border px-3 py-2 text-left transition ${
                selectedDayIndex === null
                  ? 'border-rose-400/45 bg-[linear-gradient(135deg,rgba(255,30,109,0.22)_0%,rgba(163,18,70,0.12)_100%)] text-white shadow-sm'
                  : 'border-white/[0.06] bg-[#0F0B15]/60 text-zinc-400 hover:border-white/15 hover:bg-white/[0.04] hover:text-zinc-100'
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] font-extrabold uppercase tracking-wider">All 7 days</span>
                <span
                  className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                    selectedDayIndex === null ? 'bg-rose-500/30 text-rose-100' : 'bg-white/[0.06] text-zinc-400'
                  }`}
                >
                  {totalFilteredCount}
                </span>
              </div>
              <span className="mt-1 truncate text-[10px] text-zinc-400">Full week view</span>
            </button>

            {WEEKDAY_LABELS.map((label, i) => {
              const date = dayDates[i]
              const isToday = dayKey(date) === todayKey
              const isSelected = selectedDayIndex === i
              const dayCount = filteredDays[i].length
              const followedCount = followedCountsByDay[i]

              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => setSelectedDayIndex((prev) => (prev === i ? null : i))}
                  className={`flex flex-col justify-between rounded-xl border px-3 py-2 text-left transition ${
                    isSelected
                      ? 'border-rose-400/55 bg-[linear-gradient(135deg,rgba(255,30,109,0.25)_0%,rgba(163,18,70,0.14)_100%)] text-white shadow-sm'
                      : isToday
                        ? 'border-rose-500/30 bg-rose-500/[0.06] text-zinc-100 hover:border-rose-400/50 hover:bg-rose-500/10'
                        : 'border-white/[0.06] bg-[#0F0B15]/60 text-zinc-300 hover:border-white/15 hover:bg-white/[0.04] hover:text-white'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span
                      className={`flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wider ${
                        isSelected ? 'text-white' : isToday ? 'text-rose-300' : 'text-zinc-300'
                      }`}
                    >
                      <span>{label}</span>
                      {isToday && (
                        <span
                          title="Today"
                          className="inline-block h-1.5 w-1.5 rounded-full bg-rose-400"
                        />
                      )}
                    </span>
                    <div className="flex items-center gap-1">
                      {followedCount > 0 && (
                        <span
                          title={`${followedCount} followed airing`}
                          className="inline-flex items-center gap-0.5 rounded bg-rose-500/20 px-1 py-0.5 text-[9px] font-bold text-rose-300"
                        >
                          <Bell className="h-2.5 w-2.5 fill-current" />
                          <span>{followedCount}</span>
                        </span>
                      )}
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                          isSelected ? 'bg-rose-500/30 text-rose-100' : 'bg-white/[0.06] text-zinc-400'
                        }`}
                      >
                        {dayCount}
                      </span>
                    </div>
                  </div>
                  <span className="mt-1 truncate text-[10px] text-zinc-500">
                    {formatShortDate(date)}
                    {isToday ? ' · Today' : ''}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {/* Schedule Content */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: selectedDayIndex !== null ? 4 : 8 }, (_, i) => (
            <div key={i} className="animate-pulse rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3.5">
              <div className="mb-3 h-3 w-20 rounded bg-white/[0.06]" />
              <div className="flex flex-col gap-2">
                <div className="h-14 rounded-xl bg-white/[0.04]" />
                <div className="h-14 rounded-xl bg-white/[0.04]" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-8 text-center">
          <CalendarDays className="mx-auto mb-2 h-6 w-6 text-red-400" />
          <p className="text-sm font-semibold text-red-300">Failed to load the airing schedule</p>
          <p className="mt-1 text-xs text-zinc-400">{error}</p>
          <button
            type="button"
            onClick={refresh}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-red-500/40 bg-red-500/15 px-3.5 py-2 text-xs font-bold text-red-200 transition-colors hover:bg-red-500/25"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Try again</span>
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] py-16 text-center">
          <CalendarDays className="mx-auto mb-2.5 h-7 w-7 text-zinc-600" />
          <p className="text-sm font-semibold text-zinc-300">No episodes scheduled this week</p>
          <p className="mt-1 text-xs text-zinc-500">Try jumping to another week or date above.</p>
        </div>
      ) : totalFilteredCount === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-16 text-center">
          {onlyFollowed ? (
            <>
              <Bell className="mx-auto mb-2.5 h-7 w-7 text-rose-400/70" />
              <p className="text-sm font-semibold text-zinc-200">
                {!followedAnime || followedAnime.length === 0
                  ? 'You are not following any anime yet'
                  : 'No followed anime airing in this period'}
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs text-zinc-500">
                {!followedAnime || followedAnime.length === 0
                  ? 'Open any anime page and click Follow to track its weekly broadcast times here.'
                  : normalizedQuery
                    ? `No followed episodes match “${searchQuery.trim()}” during ${rangeLabel}.`
                    : `None of your followed anime have episodes scheduled during ${rangeLabel}.`}
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setOnlyFollowed(false)}
                  className="rounded-xl border border-rose-400/35 bg-rose-500/15 px-3.5 py-2 text-xs font-bold text-rose-200 transition hover:bg-rose-500/25"
                >
                  Show all airing anime
                </button>
                {normalizedQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="rounded-xl border border-white/10 bg-white/[0.05] px-3.5 py-2 text-xs font-bold text-zinc-200 transition hover:bg-white/[0.1]"
                  >
                    Clear search
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <Search className="mx-auto mb-2.5 h-7 w-7 text-zinc-600" />
              <p className="text-sm font-semibold text-zinc-200">
                No scheduled episodes matching “{searchQuery.trim()}”
              </p>
              <p className="mt-1 text-xs text-zinc-500">Try a different title or clear your active filters.</p>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('')
                  setOnlyFollowed(false)
                }}
                className="mt-4 rounded-xl border border-white/10 bg-white/[0.06] px-3.5 py-2 text-xs font-bold text-zinc-200 transition hover:bg-white/[0.12]"
              >
                Clear filters
              </button>
            </>
          )}
        </div>
      ) : selectedDayIndex !== null ? (
        /* Focused Single-Day View */
        (() => {
          const focusedDate = dayDates[selectedDayIndex]
          const isToday = dayKey(focusedDate) === todayKey
          const dayEntries = filteredDays[selectedDayIndex]
          const followedCount = dayEntries.filter(checkIsFollowed).length

          return (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.025] px-5 py-3.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h2 className="text-base font-black text-white">
                    {FULL_WEEKDAY_LABELS[selectedDayIndex]}, {formatFullDate(focusedDate)}
                  </h2>
                  {isToday && (
                    <span className="rounded-full border border-rose-400/40 bg-rose-500/20 px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-rose-200">
                      Today
                    </span>
                  )}
                  <span className="rounded-full border border-white/10 bg-black/30 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-300">
                    {dayEntries.length} {dayEntries.length === 1 ? 'episode' : 'episodes'}
                  </span>
                  {followedCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/35 bg-rose-500/20 px-2.5 py-0.5 text-[10px] font-extrabold text-rose-200">
                      <Bell className="h-3 w-3 fill-current" />
                      <span>{followedCount} followed</span>
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => stepFocusedDay(-1)}
                    className="inline-flex items-center gap-1 rounded-xl border border-white/[0.08] bg-[#0F0B15]/85 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:border-white/20 hover:text-white"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span>Prev day</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedDayIndex(null)}
                    className="rounded-xl border border-rose-400/30 bg-rose-500/15 px-3 py-1.5 text-xs font-bold text-rose-200 transition hover:bg-rose-500/25"
                  >
                    All 7 days
                  </button>
                  <button
                    type="button"
                    onClick={() => stepFocusedDay(1)}
                    className="inline-flex items-center gap-1 rounded-xl border border-white/[0.08] bg-[#0F0B15]/85 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:border-white/20 hover:text-white"
                  >
                    <span>Next day</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {dayEntries.length === 0 ? (
                <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-14 text-center">
                  <CalendarDays className="mx-auto mb-2.5 h-6 w-6 text-zinc-600" />
                  <p className="text-sm font-semibold text-zinc-300">
                    No {onlyFollowed ? 'followed ' : ''}episodes on {FULL_WEEKDAY_LABELS[selectedDayIndex]}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Other days in this week have {totalFilteredCount} scheduled{' '}
                    {totalFilteredCount === 1 ? 'episode' : 'episodes'}.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => setSelectedDayIndex(null)}
                      className="rounded-xl border border-rose-400/35 bg-rose-500/15 px-3.5 py-2 text-xs font-bold text-rose-200 transition hover:bg-rose-500/25"
                    >
                      View all 7 days
                    </button>
                    <button
                      type="button"
                      onClick={() => stepFocusedDay(-1)}
                      className="rounded-xl border border-white/10 bg-white/[0.05] px-3.5 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.1]"
                    >
                      Previous day
                    </button>
                    <button
                      type="button"
                      onClick={() => stepFocusedDay(1)}
                      className="rounded-xl border border-white/10 bg-white/[0.05] px-3.5 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.1]"
                    >
                      Next day
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {dayEntries.map((item) => (
                    <ScheduleEntryRow
                      key={`${item.entry.anilistId}-${item.entry.airingAt}`}
                      item={item}
                      isFollowed={checkIsFollowed(item)}
                      statusFor={statusFor}
                      onSelect={onSelectItem}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })()
      ) : (
        /* Full-Week 7-Day Grid */
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {WEEKDAY_LABELS.map((label, i) => {
            const isToday = dayKey(dayDates[i]) === todayKey
            const dayEntries = filteredDays[i]
            const followedCount = dayEntries.filter(checkIsFollowed).length
            return (
              <div
                key={label}
                className={`rounded-2xl border p-3.5 transition-colors ${
                  isToday ? 'border-rose-500/40 bg-rose-500/[0.05]' : 'border-white/[0.07] bg-white/[0.02]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedDayIndex(i)}
                  title={`Focus ${FULL_WEEKDAY_LABELS[i]}`}
                  className="mb-2.5 flex w-full items-baseline justify-between rounded-lg px-1 py-0.5 text-left transition hover:bg-white/[0.04]"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={`text-xs font-bold uppercase tracking-wider ${
                        isToday ? 'text-rose-400' : 'text-zinc-300'
                      }`}
                    >
                      {label}
                      {isToday ? ' · Today' : ''}
                    </span>
                    {followedCount > 0 && (
                      <span
                        title={`${followedCount} followed anime airing on this day`}
                        className="inline-flex items-center gap-0.5 rounded-full border border-rose-500/35 bg-rose-500/20 px-1.5 py-0.5 text-[9px] font-extrabold text-rose-300 shadow-xs"
                      >
                        <Bell className="h-2.5 w-2.5 fill-current" />
                        <span>{followedCount}</span>
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-[11px] font-semibold text-zinc-500">
                    {formatShortDate(dayDates[i])}
                  </span>
                </button>

                {dayEntries.length === 0 ? (
                  <p className="py-4 text-center text-[11px] text-zinc-600">
                    {onlyFollowed ? 'No followed episodes' : 'No episodes'}
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {dayEntries.map((item) => (
                      <ScheduleEntryRow
                        key={`${item.entry.anilistId}-${item.entry.airingAt}`}
                        item={item}
                        isFollowed={checkIsFollowed(item)}
                        statusFor={statusFor}
                        onSelect={onSelectItem}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
