import React, { useMemo } from 'react'
import { CalendarDays, ChevronRight, Clock3 } from 'lucide-react'
import { useAiringSchedule, toRailItem } from '../../hooks/useCatalog'
import type { RailItem } from '../../hooks/useCatalog'

interface HomeSchedulePreviewProps {
  onSelect: (item: RailItem) => void
  onOpenSchedule: () => void
}

const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dayStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000
}

export const HomeSchedulePreview: React.FC<HomeSchedulePreviewProps> = ({ onSelect, onOpenSchedule }) => {
  const { entries, loading } = useAiringSchedule(0)
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
      const items = entries
        .filter((entry) => entry.airingAt >= start && entry.airingAt < end)
        .sort((a, b) => a.airingAt - b.airingAt)
        .slice(0, 3)
      return { date, items }
    })
  }, [entries])

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
          {days.map(({ date, items }) => {
            const today = date.toDateString() === now.toDateString()
            return (
              <div key={date.toISOString()} className={`min-h-36 rounded-2xl border p-3.5 backdrop-blur-xl ${today ? 'border-rose-400/30 bg-rose-400/[0.055]' : 'border-white/[0.08] bg-white/[0.025]'}`}>
                <div className="mb-2.5 flex items-center justify-between border-b border-white/[0.06] pb-2">
                  <span className={`text-xs font-bold uppercase tracking-wider ${today ? 'text-rose-300' : 'text-zinc-300'}`}>{dayLabels[date.getDay()]}{today ? ' · Today' : ''}</span>
                  <span className="font-mono text-[10px] text-zinc-500">{date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                </div>
                {items.length === 0 ? (
                  <div className="flex h-20 items-center justify-center gap-2 text-xs text-zinc-600"><CalendarDays className="h-4 w-4" />No episodes scheduled</div>
                ) : (
                  <div className="space-y-1.5">
                    {items.map((entry) => {
                      const item = toRailItem(entry)
                      return (
                        <button key={`${entry.anilistId}-${entry.airingAt}`} onClick={() => onSelect(item)} className="flex w-full items-center gap-2.5 rounded-xl bg-black/20 p-2 text-left transition hover:bg-white/[0.07]">
                          <div className="h-12 w-9 shrink-0 overflow-hidden rounded-md bg-zinc-900">
                            {item.posterUrl && <img src={item.posterUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}
                          </div>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold text-zinc-200">{item.title}</span>
                            <span className="mt-1 flex items-center gap-1.5 text-[10px] text-zinc-500"><span className="text-violet-300">EP {entry.episode ?? '?'}</span><Clock3 className="h-3 w-3" />{new Date(entry.airingAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </span>
                        </button>
                      )
                    })}
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
