import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Clock3 } from 'lucide-react'
import type { AnimeFolder, Episode, PlaybackProgress } from '../../types'
import { cleanEpisodeTitle, formatTime } from '../../utils/format'
import { parseReleaseCore } from '../../lib/releaseParser/regexEngine.ts'
import { HorizontalScroller } from '../common/HorizontalScroller'
import { PLACEHOLDER_EPISODE_IMAGE } from '../../utils/assets'

interface RecentEpisodesRailProps {
  folders: AnimeFolder[]
  history: Record<string, PlaybackProgress>
  onPlay: (episode: Episode, startAt?: number) => void
}

interface RecentEpisode {
  folder: AnimeFolder
  episode: Episode
  progress: PlaybackProgress
}

interface RemoteEpisodeMeta {
  title: string | null
  thumbnailUrl: string | null
}

function titleLooksLikeRelease(value: string): boolean {
  return /[\[\]]/.test(value) || /\b(?:2160p|1080p|720p|web[- ]?rip|web[- ]?dl|bluray|h\.?265|x265|hevc|e[- ]?ac[- ]?3|multi[- ]audio|dual[- ]audio|repack)\b/i.test(value)
}

export const RecentEpisodesRail: React.FC<RecentEpisodesRailProps> = ({ folders, history, onPlay }) => {
  const recent = useMemo(() => {
    const episodesByPath = new Map<string, { folder: AnimeFolder; episode: Episode }>()
    for (const folder of folders) {
      for (const episode of folder.episodes) {
        episodesByPath.set(episode.filePath.toLowerCase(), { folder, episode })
      }
    }

    const seen = new Set<string>()
    return Object.values(history)
      .filter((progress) => progress && !progress.completed && progress.currentTime > 0 && progress.lastWatchedAt > 0)
      .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt)
      .flatMap((progress): RecentEpisode[] => {
        const key = progress.filePath.toLowerCase()
        if (seen.has(key)) return []
        seen.add(key)
        const match = episodesByPath.get(key)
        if (!match || match.episode.isDownloading) return []
        return [{ ...match, progress }]
      })
      .slice(0, 12)
  }, [folders, history])

  // API enrichment: local titles/thumbnails are often missing (release-name
  // files, movies) — the remote episode list (cached pipeline) fills them.
  // Episode numbers are parsed from the file names ("S02E01" etc.) — the
  // stored episodeNumber field is a label, not always numeric.
  //
  // Cancellation is NOT used here: `history` identity churns on every
  // progress poll, which re-runs this effect — a cancelled-style restart
  // would cancel in-flight fetches before they ever complete (observed:
  // enrichment starved itself, tiles stuck on "Episode N"). Instead each id
  // is fetched once, results merge incrementally, and a content signature
  // skips no-op re-runs.
  const [remoteMeta, setRemoteMeta] = useState<Map<string, RemoteEpisodeMeta>>(new Map());
  const [enrichVersion, setEnrichVersion] = useState(0);
  const wantedRef = useRef<Map<number, Set<number>>>(new Map());
  const lastSignatureRef = useRef<string>('');
  const pendingIdsRef = useRef<Set<number>>(new Set());
  const enrichedIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const wanted = new Map<number, Set<number>>();
    for (const { folder, episode } of recent) {
      if (folder.anilistId == null) continue;
      const num = parseReleaseCore(episode.fileName).episodeNumbers[0];
      if (!Number.isInteger(num) || num <= 0) continue;
      const numbers = wanted.get(folder.anilistId) ?? new Set<number>();
      numbers.add(num);
      wanted.set(folder.anilistId, numbers);
    }
    wantedRef.current = wanted;
    const signature = [...wanted.entries()]
      .map(([id, numbers]) => `${id}:${[...numbers].sort((a, b) => a - b).join(',')}`)
      .sort()
      .join('|');
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;
    const api = window.electronAPI;
    if (!api?.getRemoteEpisodes || wanted.size === 0) return;
    for (const [anilistId, numbers] of wanted) {
      if (enrichedIdsRef.current.has(anilistId) || pendingIdsRef.current.has(anilistId)) continue;
      pendingIdsRef.current.add(anilistId);
      void api.getRemoteEpisodes(anilistId)
        .then((result) => {
          enrichedIdsRef.current.add(anilistId);
          const hits = new Map<string, RemoteEpisodeMeta>();
          for (const ep of result?.episodes ?? []) {
            if (!numbers.has(ep.number) || (!ep.title && !ep.thumbnailUrl)) continue;
            hits.set(`${anilistId}:${ep.number}`, { title: ep.title, thumbnailUrl: ep.thumbnailUrl });
          }
          if (hits.size > 0) {
            setRemoteMeta((prev) => {
              const merged = new Map(prev);
              for (const [key, value] of hits) merged.set(key, value);
              return merged;
            });
          }
        })
        .catch(() => {})
        .finally(() => {
          pendingIdsRef.current.delete(anilistId);
        });
    }
  }, [recent, enrichVersion]);
  // The episodes pipeline may answer the first request with a fast placeholder
  // (slow upstream) — when its background run lands, refetch that id.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onRemoteEpisodesUpdated) return;
    return api.onRemoteEpisodesUpdated((anilistId) => {
      if (!wantedRef.current.has(anilistId)) return;
      enrichedIdsRef.current.delete(anilistId);
      lastSignatureRef.current = '';
      setEnrichVersion((version) => version + 1);
    });
  }, [recent]);

  if (recent.length === 0) return null

  return (
    <section className="home-rail-section mb-9" aria-label="Recently watched episodes">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-rose-400 shadow-[0_0_12px_rgba(251,113,133,0.65)]" />
            <h2 className="text-lg font-black uppercase tracking-wide text-white">Recently watched</h2>
          </div>
          <p className="mt-1 text-xs text-zinc-500">Pick up where you left off across your anime</p>
        </div>
        <span className="font-mono text-[10px] text-zinc-500">{recent.length} episodes</span>
      </div>

      <HorizontalScroller label="Recently watched episodes" className="flex gap-4 overflow-x-auto pb-3">
        {recent.map(({ folder, episode, progress }) => {
          const episodeNum = parseReleaseCore(episode.fileName).episodeNumbers[0]
          const remote = folder.anilistId != null && Number.isInteger(episodeNum)
            ? remoteMeta.get(`${folder.anilistId}:${episodeNum}`)
            : undefined
          const rawTitle = episode.kitsuTitle || episode.episodeTitle || ''
          const parsedTitle = cleanEpisodeTitle(episode.fileName).displayTitle
          const episodeTitle = remote?.title && !titleLooksLikeRelease(remote.title)
            ? remote.title
            : rawTitle && !titleLooksLikeRelease(rawTitle)
              ? rawTitle
              : parsedTitle && !titleLooksLikeRelease(parsedTitle)
                ? parsedTitle
                : remote?.title || `Episode ${episode.episodeNumber || ''}`
          const duration = progress.duration || episode.duration || 0
          const percent = duration > 0 ? Math.min(100, Math.round((progress.currentTime / duration) * 100)) : 0
          const seriesTitle = folder.canonicalTitle || folder.folderName
          // Same order as the title page: the official API still wins over the
          // local scanner capture.
          // Keep Home completely off the video files: episode.thumbnailUrl is
          // a local FFmpeg endpoint and can seek/decode a multi-GB MKV just to
          // paint a card. Use hosted stills and series artwork only here.
          const image = remote?.thumbnailUrl || episode.kitsuThumbnail || folder.bannerUrl || folder.posterUrl || PLACEHOLDER_EPISODE_IMAGE

          return (
            <button key={episode.filePath} onClick={() => onPlay(episode, progress.currentTime)} className="group w-[250px] shrink-0 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#151720]/90 text-left shadow-lg shadow-black/20 transition hover:-translate-y-1 hover:border-rose-300/30 hover:shadow-rose-950/20">
              <div className="relative aspect-video overflow-hidden bg-zinc-950">
                {image && <img src={image} alt="" draggable={false} loading="lazy" decoding="async" fetchPriority="low" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />}
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/30">
                  <span className="flex h-11 w-11 scale-90 items-center justify-center rounded-full bg-rose-500 text-white opacity-0 shadow-[0_0_24px_rgba(244,63,94,0.45)] transition group-hover:scale-100 group-hover:opacity-100"><Play className="ml-0.5 h-4 w-4 fill-current" /></span>
                </div>
                <span className="absolute left-2.5 top-2.5 rounded-md border border-white/10 bg-black/85 px-2 py-1 font-mono text-[10px] font-bold text-white">{episode.episodeNumber || 'EP'}</span>
                <div className="absolute inset-x-0 bottom-0 h-1 bg-white/15"><div className="h-full bg-gradient-to-r from-rose-500 to-cyan-300" style={{ width: `${percent}%` }} /></div>
              </div>
              <div className="p-3.5">
                <p className="truncate text-xs font-bold text-zinc-100" title={seriesTitle}>{seriesTitle}</p>
                <p className="mt-1 truncate text-[11px] text-zinc-400" title={episodeTitle}>{episodeTitle}</p>
                <p className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-zinc-500"><Clock3 className="h-3 w-3" />{formatTime(progress.currentTime)}{duration > 0 ? ` / ${formatTime(duration)}` : ''}</p>
              </div>
            </button>
          )
        })}
      </HorizontalScroller>
    </section>
  )
}
