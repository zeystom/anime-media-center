import React, { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Film, RotateCcw } from 'lucide-react'
import type { AiringEntry } from '../../types'
import type { RailItem } from '../../hooks/useCatalog'
import { toRailItem, useAiringSchedule } from '../../hooks/useCatalog'
import type { LocalBadgeState, LocalStatusRef } from '../../hooks/useLocalStatus'
import { StatusBadges } from '../common/StatusBadges'

export interface ScheduleViewProps {
  onSelectItem: (item: RailItem) => void
  statusFor: (ref: LocalStatusRef) => LocalBadgeState | null
}

interface ScheduleEntry {
  entry: AiringEntry
  rail: RailItem
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const NAV_BTN =
  'flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-800/80 text-zinc-300 transition-colors hover:bg-zinc-700/80'

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

/** 'Nov 3' (optionally with year), matching the 'Nov 3 – Nov 9' range label. */
function formatShortDate(date: Date, withYear = false): string {
  return date.toLocaleDateString(
    'en-US',
    withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }
  )
}

/** Local HH:MM (24h) for a unix-seconds airing timestamp. */
function formatEntryTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * One airing entry inside a day card: 40px poster, EP chip + local time,
 * clamped title and local-status badges. Clicking selects the title.
 */
const ScheduleEntryRow: React.FC<{
  item: ScheduleEntry
  statusFor: (ref: LocalStatusRef) => LocalBadgeState | null
  onSelect: (item: RailItem) => void
}> = ({ item, statusFor, onSelect }) => {
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
      className="flex cursor-pointer items-center gap-2.5 rounded-lg p-1.5 transition-colors hover:bg-zinc-800/60"
    >
      <div className="aspect-[2/3] w-10 shrink-0 overflow-hidden rounded bg-zinc-950">
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
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold text-zinc-300">
            EP {item.entry.episode ?? '?'}
          </span>
          <span className="font-mono text-[11px] text-zinc-400">{formatEntryTime(item.entry.airingAt)}</span>
        </div>
        <p className="mt-0.5 truncate text-xs font-medium text-zinc-200" title={item.rail.title}>
          {item.rail.title}
        </p>
        {badges && <StatusBadges state={badges} size="sm" className="mt-1" />}
      </div>
    </div>
  )
}

/**
 * Weekly airing-schedule calendar: Mon..Sun day cards grouped by the LOCAL
 * weekday of each entry's airing time, with week navigation (ChevronLeft /
 * ChevronRight), a 'This week' / date-range label and a reset button. Entries
 * are resolved through statusFor for local badges and handed to onSelectItem
 * (as RailItems) on click.
 */
export const ScheduleView: React.FC<ScheduleViewProps> = ({ onSelectItem, statusFor }) => {
  const [weekOffset, setWeekOffset] = useState(0)
  const { entries, loading, error, refresh } = useAiringSchedule(weekOffset)

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

  const sameYear = weekStart.getFullYear() === weekEnd.getFullYear()
  const rangeLabel = `${formatShortDate(weekStart, !sameYear)} – ${formatShortDate(weekEnd, !sameYear)}`
  const todayKey = dayKey(new Date())

  // Group the week's entries into Mon..Sun buckets by LOCAL weekday of the
  // airing timestamp, sorted by airing time within each day.
  const days = useMemo(() => {
    const buckets: ScheduleEntry[][] = [[], [], [], [], [], [], []]
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry.airingAt !== 'number' || !Number.isFinite(entry.airingAt)) continue
      const index = (new Date(entry.airingAt * 1000).getDay() + 6) % 7
      buckets[index].push({ entry, rail: toRailItem(entry) })
    }
    for (const bucket of buckets) bucket.sort((a, b) => a.entry.airingAt - b.entry.airingAt)
    return buckets
  }, [entries])

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-6">
      {/* Header: title + week navigation */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-black text-white">Airing Schedule</h1>
          <p className="mt-0.5 text-xs text-zinc-500">Weekly episode calendar in your local timezone</p>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setWeekOffset((w) => w - 1)} title="Previous week" className={NAV_BTN}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[130px] text-center text-sm font-bold text-zinc-200">
            {weekOffset === 0 ? 'This week' : rangeLabel}
          </span>
          <button type="button" onClick={() => setWeekOffset((w) => w + 1)} title="Next week" className={NAV_BTN}>
            <ChevronRight className="h-4 w-4" />
          </button>
          {weekOffset !== 0 && (
            <button
              type="button"
              onClick={() => setWeekOffset(0)}
              title="Back to the current week"
              className="ml-1 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-700/80"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Today</span>
            </button>
          )}
        </div>
      </div>

      {loading ? (
        // Skeleton day cards while the schedule loads
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="animate-pulse rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3">
              <div className="mb-3 h-3 w-16 rounded bg-zinc-800" />
              <div className="flex flex-col gap-2">
                <div className="h-12 rounded-lg bg-zinc-800/70" />
                <div className="h-12 rounded-lg bg-zinc-800/70" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-8 text-center">
          <CalendarDays className="mx-auto mb-2 h-6 w-6 text-red-400" />
          <p className="text-sm font-semibold text-red-300">Failed to load the airing schedule</p>
          <p className="mt-1 text-xs text-zinc-400">{error}</p>
          <button
            type="button"
            onClick={refresh}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/15 px-3 py-1.5 text-xs font-bold text-red-200 transition-colors hover:bg-red-500/25"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Try again</span>
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 py-16 text-center">
          <CalendarDays className="mx-auto mb-2 h-6 w-6 text-zinc-600" />
          <p className="text-sm text-zinc-500">No episodes scheduled this week</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {WEEKDAY_LABELS.map((label, i) => {
            const isToday = dayKey(dayDates[i]) === todayKey
            return (
              <div
                key={label}
                className={`rounded-xl border p-3 transition-colors ${
                  isToday ? 'border-red-500/40 bg-red-500/5' : 'border-zinc-800/80 bg-zinc-900/40'
                }`}
              >
                <div className="mb-2 flex items-baseline justify-between">
                  <span
                    className={`text-xs font-bold uppercase tracking-wider ${isToday ? 'text-red-400' : 'text-zinc-400'}`}
                  >
                    {label}
                    {isToday ? ' · Today' : ''}
                  </span>
                  <span className="text-[11px] font-semibold text-zinc-500">{formatShortDate(dayDates[i])}</span>
                </div>

                {days[i].length === 0 ? (
                  <p className="py-3 text-center text-[11px] text-zinc-600">No episodes</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {days[i].map((item) => (
                      <ScheduleEntryRow
                        key={`${item.entry.anilistId}-${item.entry.airingAt}`}
                        item={item}
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
