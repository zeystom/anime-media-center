import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Play, X } from 'lucide-react';
import { Episode, PlaybackProgress, RemoteEpisodesResult } from '../../types';
import { formatTime, cleanSeriesTitle, cleanEpisodeTitle } from '../../utils/format';

export interface UpNextData {
  progress: PlaybackProgress;
  episode: Episode;
  seasonName: string;
  posterUrl?: string | null;
  bannerUrl?: string | null;
  anilistId?: number | null;
  isUpNext: boolean;
}

interface UpNextWidgetProps {
  data: UpNextData;
  onPlay: (episode: Episode, startAt?: number) => void;
  onOpenDetails?: () => void;
}

export const UpNextWidget: React.FC<UpNextWidgetProps> = ({ data, onPlay, onOpenDetails }) => {
  const { progress, episode, seasonName, posterUrl, bannerUrl, anilistId, isUpNext } = data;

  // Use hosted artwork only. The local thumbnail endpoint may need to seek and
  // decode the full episode file, which is too expensive for the Home banner.
  const posterCandidates = useMemo(
    () => [posterUrl, episode.kitsuThumbnail].filter(
      (src): src is string => Boolean(src)
    ),
    [posterUrl, episode.kitsuThumbnail]
  );
  const [posterIdx, setPosterIdx] = useState(0);

  useEffect(() => {
    setPosterIdx(0);
  }, [posterCandidates]);

  const [bannerFailed, setBannerFailed] = useState(false);
  const [bannerLoaded, setBannerLoaded] = useState(false);
  const [artworkHue, setArtworkHue] = useState<number | null>(null);
  useEffect(() => {
    setBannerFailed(false);
    setBannerLoaded(false);
  }, [bannerUrl]);

  // Give the home hero the title's own color palette. Hosts that disallow
  // canvas reads simply keep the deterministic per-title fallback.
  const fallbackHue = useMemo(() => {
    const seed = `${anilistId ?? ''}:${seasonName}`;
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
    return (hash >>> 0) % 360;
  }, [anilistId, seasonName]);
  const [apiEpisodeTitle, setApiEpisodeTitle] = useState<string | null>(null);
  const [apiLogoUrls, setApiLogoUrls] = useState<string[]>([]);
  const [logoIdx, setLogoIdx] = useState(0);
  const [logoLoaded, setLogoLoaded] = useState(false);

  useEffect(() => {
    setApiEpisodeTitle(null);
    setApiLogoUrls([]);
    setLogoIdx(0);
    setLogoLoaded(false);
    if (!anilistId) return;
    let cancelled = false;
    let lastLogosKey = '';
    const parsedNumber = cleanEpisodeTitle(episode.fileName).episodeNumber;

    const applyRemoteResult = (result?: RemoteEpisodesResult | null) => {
      if (cancelled || !result) return;
      const match = (result.episodes ?? []).find((item) => item.number === parsedNumber);
      if (match?.title) setApiEpisodeTitle(match.title);
      const nextLogos = Array.from(
        new Set(
          [result.logoUrl, result.fallbackLogoUrl].filter(
            (url): url is string => typeof url === 'string' && url.length > 0
          )
        )
      );
      const nextKey = nextLogos.join('|');
      if (nextLogos.length > 0 && nextKey !== lastLogosKey) {
        lastLogosKey = nextKey;
        setApiLogoUrls(nextLogos);
        setLogoIdx(0);
        setLogoLoaded(false);
      }
    };

    if (window.electronAPI?.getRemoteEpisodes) {
      window.electronAPI.getRemoteEpisodes(anilistId)
        .then((result) => applyRemoteResult(result))
        .catch(() => {});
    }
    const unsubscribe = window.electronAPI?.onRemoteEpisodesUpdated?.((updatedId, result) => {
      if (updatedId === anilistId) applyRemoteResult(result);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [anilistId, episode.fileName]);

  // Anime description for the banner (AniList, cached 24 h on the main side).
  // The Show more/less marker lives OUTSIDE the clamped paragraph — an inline
  // "…more" span sits past the clamp cut and would never be visible.
  const [description, setDescription] = useState<string | null>(null);
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);
  const [descriptionClamped, setDescriptionClamped] = useState(false);
  const [descriptionReaderOpen, setDescriptionReaderOpen] = useState(false);

  // Full-description reader modal (mirrors the anime overview reader) — the
  // banner no longer reflows to fit the whole text.
  useEffect(() => {
    if (!descriptionReaderOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setDescriptionReaderOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [descriptionReaderOpen]);

  useEffect(() => {
    setDescription(null);
    setDescriptionReaderOpen(false);
    if (!anilistId || !window.electronAPI?.getCatalogDetails) return;
    let cancelled = false;
    window.electronAPI.getCatalogDetails(anilistId)
      .then((details) => {
        if (cancelled || !details?.description) return;
        const text = details.description
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) setDescription(text);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [anilistId]);
  useEffect(() => {
    const el = descriptionRef.current;
    setDescriptionClamped(!!el && el.scrollHeight > el.clientHeight + 1);
  }, [description]);

  const displayTitle = useMemo(() => cleanSeriesTitle(seasonName) || seasonName, [seasonName]);

  const percent = progress.duration > 0
    ? Math.min(100, Math.round((progress.currentTime / progress.duration) * 100))
    : 0;
  const startAt = !progress.completed ? progress.currentTime || 0 : 0;
  const posterSrc = posterCandidates[posterIdx] || null;
  const themeHue = artworkHue ?? fallbackHue;
  useEffect(() => setArtworkHue(null), [bannerUrl, posterSrc]);
  // Read colors from the image already displayed in the hero instead of
  // creating a second Image request/decode for the same large banner.
  const updateArtworkHue = (image: HTMLImageElement) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 24;
      canvas.height = 24;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      context.drawImage(image, 0, 0, 24, 24);
      const pixels = context.getImageData(0, 0, 24, 24).data;
      const bins = Array.from({ length: 18 }, () => 0);
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
        const light = (max + min) / 2;
        if (delta < 0.08 || light < 0.14 || light > 0.9) continue;
        let hue = 0;
        if (max === r) hue = ((g - b) / delta) % 6;
        else if (max === g) hue = (b - r) / delta + 2;
        else hue = (r - g) / delta + 4;
        hue = (hue * 60 + 360) % 360;
        const saturation = delta / (1 - Math.abs(2 * light - 1));
        bins[Math.floor(hue / 20) % bins.length] += saturation * (1 - Math.abs(light - 0.5));
      }
      const strongest = bins.indexOf(Math.max(...bins));
      if (strongest >= 0 && bins[strongest] > 0) setArtworkHue(strongest * 20 + 10);
    } catch {
      // Cross-origin image hosts may deny pixel access; keep the fallback.
    }
  };
  const remaining = Math.max(0, progress.duration - progress.currentTime);
  const parsedEpisodeTitle = cleanEpisodeTitle(episode.fileName).displayTitle;
  const isReleaseText = (value: string | null | undefined) =>
    !value || /[\[\]]/.test(value) || /\b(?:2160p|1080p|720p|web[- ]?rip|web[- ]?dl|bluray|h\.?265|x265|hevc|e[- ]?ac[- ]?3|multi[- ]audio|dual[- ]audio|repack)\b/i.test(value);
  const episodeTitle = [apiEpisodeTitle, episode.kitsuTitle, episode.episodeTitle, parsedEpisodeTitle]
    .find((candidate) => !isReleaseText(candidate) && !/^episode\s*\d*$/i.test(candidate || ''))
    || `Episode ${progress.episodeNumber || episode.episodeNumber || ''}`.trim();
  const activeLogoUrl = apiLogoUrls[logoIdx] ?? null;
  const showLogo = Boolean(activeLogoUrl && logoLoaded);

  return (
    <>
    <motion.div
      data-backdrop-hero
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      style={{
        '--anime-hue': themeHue,
        background: `radial-gradient(ellipse at 78% 20%, hsla(${themeHue}, 80%, 48%, .2), transparent 52%), #07060A`,
        borderColor: `hsla(${themeHue}, 65%, 68%, .24)`,
        boxShadow: `0 28px 90px rgba(0,0,0,.45), 0 0 58px hsla(${themeHue}, 78%, 48%, .16)`,
      } as React.CSSProperties}
      className="group relative mb-10 min-h-[360px] overflow-hidden rounded-3xl border shadow-[0_28px_90px_rgba(0,0,0,0.45)] md:min-h-[440px] 2xl:min-h-[500px]"
    >
      {/* Full-bleed banner art with a deep cinematic fade for readable text. */}
      {posterSrc && (
        <img
          crossOrigin="anonymous"
          src={posterSrc}
          alt=""
          aria-hidden
          loading="eager"
          decoding="async"
          fetchPriority="high"
          onLoad={(event) => updateArtworkHue(event.currentTarget)}
          onError={() => setPosterIdx((i) => i + 1)}
          className={`pointer-events-none absolute inset-0 h-full w-full object-cover object-[center_30%] saturate-[1.12] transition-[opacity,transform] duration-500 group-hover:scale-[1.025] select-none ${bannerLoaded && !bannerFailed ? 'opacity-0' : 'opacity-90'}`}
        />
      )}
      {bannerUrl && !bannerFailed && (
        <img
          crossOrigin="anonymous"
          src={bannerUrl}
          alt=""
          aria-hidden
          loading="eager"
          decoding="async"
          fetchPriority="low"
          onLoad={(event) => { setBannerLoaded(true); updateArtworkHue(event.currentTarget); }}
          onError={() => setBannerFailed(true)}
          className={`pointer-events-none absolute inset-0 h-full w-full object-cover object-[center_30%] saturate-[1.18] transition-[opacity,transform] duration-700 group-hover:scale-[1.025] select-none ${bannerLoaded ? 'opacity-90' : 'opacity-0'}`}
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(7,8,12,0.88)_0%,rgba(7,8,12,0.62)_42%,rgba(7,8,12,0.06)_100%)]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#07060A]/90 via-transparent to-[#07060A]/10" />
      <div className="pointer-events-none absolute inset-0 mix-blend-screen" style={{ background: `radial-gradient(ellipse at 80% 18%, hsla(${themeHue}, 90%, 58%, .18), transparent 58%)` }} />

      <div className="relative z-10 flex min-h-[360px] max-w-3xl flex-col justify-end p-7 md:min-h-[440px] md:p-10 2xl:min-h-[500px] 2xl:p-14">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-extrabold uppercase tracking-[0.14em] shadow-[0_0_24px_rgba(244,63,94,0.12)]" style={{ borderColor: `hsla(${themeHue}, 78%, 70%, .38)`, backgroundColor: `hsla(${themeHue}, 78%, 55%, .17)`, color: `hsl(${themeHue} 85% 82%)` }}>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ backgroundColor: `hsl(${themeHue} 88% 72%)` }} />{isUpNext ? 'Up next' : 'Continue playing'}
          </span>
          {progress.episodeNumber && <span className="rounded-md border border-white/15 bg-black/35 px-2.5 py-1 font-mono text-[11px] font-semibold text-zinc-200 backdrop-blur">{progress.episodeNumber}</span>}
          <span className="rounded-md border border-white/15 bg-black/35 px-2.5 py-1 font-mono text-[11px] text-zinc-300 backdrop-blur">{formatTime(progress.currentTime)} / {formatTime(progress.duration)}</span>
        </div>

        {activeLogoUrl && (
          <img
            key={activeLogoUrl}
            src={activeLogoUrl}
            alt={displayTitle}
            title={displayTitle}
            decoding="async"
            onLoad={(event) => {
              const img = event.currentTarget;
              if (img.naturalHeight > 0 && img.naturalWidth / img.naturalHeight < 1.25) {
                setLogoLoaded(false);
                setLogoIdx((i) => i + 1);
                return;
              }
              setLogoLoaded(true);
            }}
            onError={() => {
              setLogoLoaded(false);
              setLogoIdx((i) => i + 1);
            }}
            className={
              showLogo
                ? 'mb-1 max-h-20 w-auto max-w-[min(100%,380px)] self-start object-contain object-left drop-shadow-[0_10px_28px_rgba(0,0,0,0.85)] transition-opacity duration-300 select-none md:max-h-28 md:max-w-[460px] 2xl:max-h-32 2xl:max-w-[520px]'
                : 'pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0'
            }
          />
        )}
        <h2
          className={
            showLogo
              ? 'sr-only'
              : 'max-w-3xl text-4xl font-black leading-[1.03] tracking-tight text-white drop-shadow-lg md:text-6xl 2xl:text-7xl'
          }
          title={displayTitle}
        >
          {displayTitle}
        </h2>
        <p className="mt-2 text-lg font-semibold text-zinc-200 md:text-xl">{episodeTitle}</p>
        {description && (
          <>
            <p
              ref={descriptionRef}
              onClick={() => { if (descriptionClamped) setDescriptionReaderOpen(true) }}
              title={descriptionClamped ? 'Show full description' : undefined}
              className={`mt-3 max-w-2xl text-[13px] leading-relaxed text-zinc-300/85 drop-shadow-md transition-colors md:text-sm line-clamp-3 ${
                descriptionClamped ? 'cursor-pointer hover:text-zinc-200' : ''
              }`}
            >
              {description}
            </p>
            {descriptionClamped && (
              <button
                type="button"
                onClick={() => setDescriptionReaderOpen(true)}
                className="self-start text-[11px] font-semibold text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Show more
              </button>
            )}
          </>
        )}

        <div className={`max-w-xl ${description ? 'mt-4' : 'mt-5'}`}>
          <div className="mb-2 flex items-center justify-between font-mono text-[11px] text-zinc-300">
            <span>{percent}% completed</span><span>{formatTime(remaining)} remaining</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full border border-white/10 bg-black/45 p-[2px] backdrop-blur">
            <div className="h-full rounded-full transition-all" style={{ width: `${percent}%`, background: 'linear-gradient(90deg, #9E1148, #FF1E6D)', boxShadow: '0 0 16px rgba(255, 30, 109, 0.45)' }} />
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button onClick={() => onPlay(episode, startAt)} className="btn-hue inline-flex items-center gap-2.5 rounded-2xl px-6 py-3.5 text-sm font-extrabold text-white transition hover:-translate-y-0.5 active:translate-y-0" title={`Resume ${progress.episodeNumber || 'episode'}`}>
            <Play className="h-4 w-4 fill-current" /> Resume {progress.episodeNumber || 'episode'}
          </button>
          {onOpenDetails && <button onClick={onOpenDetails} className="inline-flex items-center gap-2 rounded-2xl border border-white/15 bg-white/[0.06] px-5 py-3.5 text-sm font-semibold text-zinc-100 backdrop-blur transition hover:bg-white/10">
            Anime overview <ArrowRight className="h-4 w-4" />
          </button>}
        </div>
      </div>
    </motion.div>

    {/* Full-description reader — separate window like the anime overview,
        so the banner never reflows to fit long text. */}
    {descriptionReaderOpen && description && (
      <div
        className="fixed inset-0 z-[80] flex items-center justify-center modal-dimmer p-4 animate-in fade-in duration-150"
        onClick={() => setDescriptionReaderOpen(false)}
      >
        <section
          role="dialog"
          aria-modal="true"
          data-modal="true"
          aria-labelledby="upnext-description-title"
          className="modal-glass flex max-h-[min(78vh,760px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl animate-in zoom-in-95 duration-150"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-rose-300">Synopsis</p>
              <h2 id="upnext-description-title" className="mt-1 line-clamp-2 text-base font-bold text-white sm:text-lg">{displayTitle}</h2>
              <p className="mt-0.5 truncate text-[11px] text-zinc-500">{episodeTitle}</p>
            </div>
            <button
              type="button"
              autoFocus
              aria-label="Close full description"
              onClick={() => setDescriptionReaderOpen(false)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 text-zinc-400 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/30"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-5 text-sm leading-7 text-zinc-200 sm:px-6 sm:py-6">
            {description}
          </div>
          <footer className="flex justify-end border-t border-white/[0.07] px-5 py-3 sm:px-6">
            <button
              type="button"
              onClick={() => setDescriptionReaderOpen(false)}
              className="rounded-lg px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
            >
              Close
            </button>
          </footer>
        </section>
      </div>
    )}
    </>
  );
};
