import React, { useMemo } from 'react'
import { Bell, CalendarDays, ChevronRight, Clock3 } from 'lucide-react'
import { useAiringSchedule, toRailItem } from '../../hooks/useCatalog'
import type { RailItem } from '../../hooks/useCatalog'
import type { FollowedAnime } from '../../types/notifications'
import { buildFollowedScheduleLookup, isFollowedScheduleEntry } from '../../utils/schedule'

interface HomeSchedulePreviewProps {
  followedAnime?: FollowedAnime[]
  onSelect: (item: RailItem) => void
  onOpenSchedule: () => void
}

const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dayStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000
}

const HomeSchedulePreviewImpl: React.FC<HomeSchedulePreviewProps> = ({ followedAnime, onSelect, onOpenSchedule }) => {
  const { entries, loading } = useAiringSchedule(0)
  const followedLookup = useMemo(() => buildFollowedScheduleLookup(followedAnime), [followedAnime])
  const now = new Date()
  const days = useMemo(() => {
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
    const nextFour = Array.from({ length: 4 }, (_, index) => {
      const date = new Date(monday)
      date.setDate(date.getDate() + index)
      return date
    })
    return nextFour.map((date) => {
      const start = dayStart(date)
      const end = start + 24 * 60 * 60
      const sorted = entries
        .filter((entry) => entry.airingAt >= start && entry.airingAt < end)
        .map((entry) => {
          const item = toRailItem(entry)
          const followed = isFollowedScheduleEntry(
            followedLookup,
            entry.anilistId || item.anilistId,
            item.title,
            entry.title
          )
          return { entry, item, followed }
        })
        .sort((a, b) => {
          if (a.followed !== b.followed) return a.followed ? -1 : 1
          return a.entry.airingAt - b.entry.airingAt
        })
      const followedCount = sorted.reduce((acc, row) => acc + (row.followed ? 1 : 0), 0)
      // Always keep at least 3 rows, expanding up to 5 so multiple followed shows fit.
      const items = sorted.slice(0, Math.min(5, Math.max(3, followedCount)))
      return { date, items, followedCount }
    })
  }, [entries, followedLookup])

  return (
    <section className="home-rail-section mb-10" aria-label="Weekly airing radar">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-rose-400 shadow-[0_0_12px_rgba(251,113,133,0.75)]" />
            <h2 className="text-lg font-black uppercase tracking-wide text-white">Airing schedule &amp; weekly radar</h2>
          </div>
          <p className="mt-1 text-xs text-zinc-500">Upcoming episodes in your local timezone</p>
        </div>
        <button onClick={onOpenSchedule} className="inline-flex items-center gap-1 text-xs font-semibold text-cyan-300 transition hover:text-cyan-100">
          Full schedule <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {days.map(({ date }) => <div key={date.toISOString()} className="h-32 rounded-2xl border border-white/[0.07] bg-white/[0.025]" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {days.map(({ date, items, followedCount }) => {
            const today = date.toDateString() === now.toDateString()
            return (
              <div key={date.toISOString()} className={`min-h-36 rounded-2xl border p-3.5 ${today ? 'border-rose-400/30 bg-[#1B1019]/95' : 'border-white/[0.08] bg-[#120D1A]/90'}`}>
                <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-white/[0.06] pb-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={`text-xs font-bold uppercase tracking-wider ${today ? 'text-rose-300' : 'text-zinc-300'}`}>{dayLabels[date.getDay()]}{today ? ' · Today' : ''}</span>
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
                  <span className="shrink-0 font-mono text-[10px] text-zinc-500">{date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                </div>
                {items.length === 0 ? (
                  <div className="flex h-20 items-center justify-center gap-2 text-xs text-zinc-600"><CalendarDays className="h-4 w-4" />No episodes scheduled</div>
                ) : (
                  <div className="space-y-1.5">
                    {items.map(({ entry, item, followed }) => (
                      <button
                        key={`${entry.anilistId}-${entry.airingAt}`}
                        onClick={() => onSelect(item)}
                        className={`flex w-full items-center gap-2.5 rounded-xl p-2 text-left transition ${
                          followed
                            ? 'border border-rose-500/40 bg-gradient-to-r from-rose-500/15 via-rose-500/[0.05] to-transparent shadow-sm shadow-rose-950/30 hover:border-rose-400/60 hover:bg-rose-500/20'
                            : 'border border-transparent bg-black/20 hover:bg-white/[0.07]'
                        }`}
                      >
                        <div className={`h-12 w-9 shrink-0 overflow-hidden rounded-md bg-zinc-900 ${followed ? 'ring-1 ring-rose-500/40' : ''}`}>
                          {item.posterUrl && <img src={item.posterUrl} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />}
                        </div>
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate text-xs font-semibold ${followed ? 'text-white' : 'text-zinc-200'}`}>{item.title}</span>
                          <span className="mt-1 flex items-center gap-1.5 text-[10px] text-zinc-500">
                            <span className={followed ? 'font-bold text-rose-300' : 'text-violet-300'}>EP {entry.episode ?? '?'}</span>
                            <Clock3 className="h-3 w-3" />
                            <span className={followed ? 'text-rose-200/80' : undefined}>{new Date(entry.airingAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            {followed && (
                              <span
                                title="Followed series"
                                className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded border border-rose-500/30 bg-rose-500/20 px-1.5 py-0.5 text-[9px] font-bold text-rose-300"
                              >
                                <Bell className="h-2.5 w-2.5 fill-rose-300 text-rose-300" />
                                <span>Followed</span>
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

export const HomeSchedulePreview = React.memo(HomeSchedulePreviewImpl)
