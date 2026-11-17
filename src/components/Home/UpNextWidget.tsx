import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Play, X } from 'lucide-react';
import { Episode, HeroBannerSources, PlaybackProgress, RemoteEpisodesResult } from '../../types';
import { formatTime, cleanSeriesTitle, cleanEpisodeTitle, resolveEpisodeBadgeLabel, resolveResumeUnitLabel } from '../../utils/format';
import { buildHeroBannerCandidates, invalidateResolvedHeroBanner, useResolvedHeroBanner } from '../../utils/heroBanner';

export interface UpNextData {
  progress: PlaybackProgress;
  episode: Episode;
  seasonName: string;
  posterUrl?: string | null;
  bannerUrl?: string | null;
  anilistId?: number | null;
  isUpNext: boolean;
  isMovie?: boolean;
}

interface UpNextWidgetProps {
  data: UpNextData;
  onPlay: (episode: Episode, startAt?: number) => void;
  onOpenDetails?: () => void;
}

const hueByUrlCache = new Map<string, number | null>();

const UpNextWidgetImpl: React.FC<UpNextWidgetProps> = ({ data, onPlay, onOpenDetails }) => {
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

  const [remoteBannerArtwork, setRemoteBannerArtwork] = useState<{
    id: number | null;
    bannerUrl: string | null;
    fallbackBannerUrl: string | null;
    kitsuBannerUrl: string | null;
    tvdbSeasonBannerUrl: string | null;
    aniListBannerUrl: string | null;
  }>({ id: null, bannerUrl: null, fallbackBannerUrl: null, kitsuBannerUrl: null, tvdbSeasonBannerUrl: null, aniListBannerUrl: null });
  const [settledBannerAnimeId, setSettledBannerAnimeId] = useState<number | null>(null);
  const [bannerFailed, setBannerFailed] = useState(false);
  const [bannerLoaded, setBannerLoaded] = useState(false);
  const [artworkHue, setArtworkHue] = useState<number | null>(null);

  const activeArtwork = remoteBannerArtwork.id === (anilistId ?? null) ? remoteBannerArtwork : null;
  const heroSourcesSettled =
    anilistId == null ||
    typeof window === 'undefined' ||
    settledBannerAnimeId === anilistId ||
    (!window.electronAPI?.getFastHeroBannerSources && !window.electronAPI?.getRemoteEpisodes);

  const bannerCandidates = useMemo(
    () =>
      buildHeroBannerCandidates(
        [
          activeArtwork?.kitsuBannerUrl,
          activeArtwork?.tvdbSeasonBannerUrl,
          activeArtwork?.aniListBannerUrl,
          bannerUrl,
        ],
        [activeArtwork?.bannerUrl, activeArtwork?.fallbackBannerUrl],
      ),
    [activeArtwork, bannerUrl],
  );
  const { bannerUrl: resolvedBannerUrl } = useResolvedHeroBanner({
    anilistId,
    settled: heroSourcesSettled,
    candidates: bannerCandidates,
  });
  const activeBannerUrl = !bannerFailed ? resolvedBannerUrl : null;

  const mergeBannerArtwork = (targetId: number, artwork?: Partial<HeroBannerSources> | null) => {
    if (!artwork) return;
    setRemoteBannerArtwork((prev) => {
      const sameId = prev.id === targetId;
      const kitsuBannerUrl = artwork.kitsuBannerUrl ?? (sameId ? prev.kitsuBannerUrl : null);
      const tvdbSeasonBannerUrl = artwork.tvdbSeasonBannerUrl ?? (sameId ? prev.tvdbSeasonBannerUrl : null);
      const aniListBannerUrl = artwork.aniListBannerUrl ?? (sameId ? prev.aniListBannerUrl : null);
      const nextBannerUrl = artwork.bannerUrl ?? (sameId ? prev.bannerUrl : null);
      const fallbackBannerUrl = artwork.fallbackBannerUrl ?? (sameId ? prev.fallbackBannerUrl : null);
      if (
        sameId &&
        kitsuBannerUrl === prev.kitsuBannerUrl &&
        tvdbSeasonBannerUrl === prev.tvdbSeasonBannerUrl &&
        aniListBannerUrl === prev.aniListBannerUrl &&
        nextBannerUrl === prev.bannerUrl &&
        fallbackBannerUrl === prev.fallbackBannerUrl
      ) {
        return prev;
      }
      return {
        id: targetId,
        bannerUrl: nextBannerUrl,
        fallbackBannerUrl,
        kitsuBannerUrl,
        tvdbSeasonBannerUrl,
        aniListBannerUrl,
      };
    });
  };

  useEffect(() => {
    setBannerFailed(false);
    setBannerLoaded(false);
  }, [resolvedBannerUrl]);

  // Fast hero artwork resolution (<200 ms on cold titles, ~1 ms cached) — never
  // stalled behind remote episode list/pagination queues.
  useEffect(() => {
    if (!anilistId) return;
    const fastFetch = window.electronAPI?.getFastHeroBannerSources;
    if (!fastFetch) return;
    let cancelled = false;
    fastFetch(anilistId)
      .then((artwork) => {
        if (!cancelled) mergeBannerArtwork(anilistId, artwork);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSettledBannerAnimeId(anilistId);
      });
    return () => {
      cancelled = true;
    };
  }, [anilistId]);

  // Give the home hero the title's own color palette. Hosts that disallow
  // canvas reads simply keep the deterministic per-title fallback.
  const fallbackHue = useMemo(() => {
    const seed = `${anilistId ?? ''}:${seasonName}`;
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
    return (hash >>> 0) % 360;
  }, [anilistId, seasonName]);
  const [apiEpisodeTitle, setApiEpisodeTitle] = useState<string | null>(null);
  const [apiEpisodeSynopsis, setApiEpisodeSynopsis] = useState<string | null>(null);
  const [apiLogoUrls, setApiLogoUrls] = useState<string[]>([]);
  const [logoIdx, setLogoIdx] = useState(0);
  const [logoLoaded, setLogoLoaded] = useState(false);

  useEffect(() => {
    setApiEpisodeTitle(null);
    setApiEpisodeSynopsis(null);
    setApiLogoUrls([]);
    setLogoIdx(0);
    setLogoLoaded(false);
    if (!anilistId || !window.electronAPI?.getRemoteEpisodes) {
      return;
    }
    let cancelled = false;
    let lastLogosKey = '';
    const hasFastHeroApi = Boolean(window.electronAPI?.getFastHeroBannerSources);
    const parsedNumber = cleanEpisodeTitle(episode.fileName).episodeNumber;

    const applyRemoteResult = (result?: RemoteEpisodesResult | null) => {
      if (cancelled || !result) return;
      const match = (result.episodes ?? []).find((item) => item.number === parsedNumber);
      if (match?.title) setApiEpisodeTitle(match.title);
      if (match?.synopsis) setApiEpisodeSynopsis(match.synopsis);
      mergeBannerArtwork(anilistId, result);
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

    window.electronAPI.getRemoteEpisodes(anilistId)
      .then((result) => applyRemoteResult(result))
      .catch(() => {})
      .finally(() => {
        if (!cancelled && !hasFastHeroApi) setSettledBannerAnimeId(anilistId);
      });
    const unsubscribe = window.electronAPI?.onRemoteEpisodesUpdated?.((updatedId, result) => {
      if (updatedId === anilistId) applyRemoteResult(result);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [anilistId, episode.fileName]);

  // Episode synopsis takes priority over the series overview when available,
  // falling back to the AniList anime description (cached 24 h on main).
  // The Show more/less marker lives OUTSIDE the clamped paragraph — an inline
  // "…more" span sits past the clamp cut and would never be visible.
  const [animeDescription, setAnimeDescription] = useState<string | null>(null);
  const [apiFormat, setApiFormat] = useState<string | null>(null);
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);
  const [descriptionClamped, setDescriptionClamped] = useState(false);
  const [descriptionReaderOpen, setDescriptionReaderOpen] = useState(false);

  const description = useMemo(() => {
    const epRaw = apiEpisodeSynopsis || episode.kitsuSynopsis || null;
    if (epRaw) {
      const cleaned = epRaw
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s*\(Source:[^)]+\)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned) return cleaned;
    }
    return animeDescription;
  }, [apiEpisodeSynopsis, episode.kitsuSynopsis, animeDescription]);

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
    setAnimeDescription(null);
    setApiFormat(null);
    setDescriptionReaderOpen(false);
    if (!anilistId || !window.electronAPI?.getCatalogDetails) return;
    let cancelled = false;
    window.electronAPI.getCatalogDetails(anilistId)
      .then((details) => {
        if (cancelled || !details) return;
        if (details.format) setApiFormat(details.format);
        if (!details.description) return;
        const text = details.description
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) setAnimeDescription(text);
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
  // Read dominant theme hue safely on a separate CORS-enabled probe so
  // non-CORS image hosts never block rendering of the visible hero <img>.
  useEffect(() => {
    setArtworkHue(null);
    const source = activeBannerUrl || posterSrc;
    if (!source || typeof Image === 'undefined') return;
    if (hueByUrlCache.has(source)) {
      setArtworkHue(hueByUrlCache.get(source) ?? null);
      return;
    }
    let cancelled = false;
    const probe = new Image();
    probe.crossOrigin = 'anonymous';
    probe.onload = () => {
      if (!cancelled) updateArtworkHue(probe, source);
    };
    probe.onerror = () => {
      hueByUrlCache.set(source, null);
    };
    probe.src = source;
    return () => { cancelled = true; };
  }, [activeBannerUrl, posterSrc]);
  const updateArtworkHue = (image: HTMLImageElement, sourceUrl: string) => {
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
      const hue = strongest >= 0 && bins[strongest] > 0 ? strongest * 20 + 10 : null;
      hueByUrlCache.set(sourceUrl, hue);
      if (hue != null) setArtworkHue(hue);
    } catch {
      hueByUrlCache.set(sourceUrl, null);
    }
  };
  const remaining = Math.max(0, progress.duration - progress.currentTime);
  const isMovie = apiFormat ? apiFormat.toUpperCase() === 'MOVIE' : Boolean(data.isMovie);
  const badgeLabel = isMovie ? resolveEpisodeBadgeLabel(progress.episodeNumber, true) : progress.episodeNumber;
  const resumeTarget = resolveResumeUnitLabel(progress.episodeNumber, isMovie);
  const parsedEpisodeTitle = cleanEpisodeTitle(episode.fileName).displayTitle;
  const isReleaseText = (value: string | null | undefined) =>
    !value || /[\[\]]/.test(value) || /\b(?:2160p|1080p|720p|web[- ]?rip|web[- ]?dl|bluray|h\.?265|x265|hevc|e[- ]?ac[- ]?3|multi[- ]audio|dual[- ]audio|repack)\b/i.test(value);
  const episodeTitle = [apiEpisodeTitle, episode.kitsuTitle, episode.episodeTitle, parsedEpisodeTitle]
    .find((candidate) => !isReleaseText(candidate) && !/^episode\s*\d*$/i.test(candidate || ''))
    || (isMovie && badgeLabel === 'Movie' ? 'Movie' : `Episode ${progress.episodeNumber || episode.episodeNumber || ''}`.trim());
  const activeLogoUrl = apiLogoUrls[logoIdx] ?? null;
  const showLogo = Boolean(activeLogoUrl && logoLoaded);
  // Size the hero so it fills the top fold alongside Recently Watched while
  // keeping the Weekly Radar schedule comfortably below the initial scroll fold.
  const heroMinHeight = 'clamp(540px, calc(100vh - 275px), 1200px)';

  return (
    <>
    <motion.div
      data-backdrop-hero
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      style={{
        '--anime-hue': themeHue,
        minHeight: heroMinHeight,
        background: `radial-gradient(ellipse at 78% 24%, hsla(${themeHue}, 80%, 48%, .2), transparent 56%), #07060A`,
      } as React.CSSProperties}
      className="group relative mb-2 w-full overflow-hidden"
    >
      {/* Full-bleed banner art dissolved smoothly into --bg-void at the bottom. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {posterSrc && !(bannerLoaded && activeBannerUrl) && (
          <img
            src={posterSrc}
            alt=""
            aria-hidden
            loading="lazy"
            decoding="async"
            onError={() => setPosterIdx((i) => i + 1)}
            className="pointer-events-none absolute inset-0 h-full w-full scale-115 object-cover object-[center_24%] opacity-25 blur-2xl saturate-[1.2] transition-opacity duration-300 select-none transform-gpu"
          />
        )}
        {activeBannerUrl && (
          <img
            key={activeBannerUrl}
            src={activeBannerUrl}
            alt=""
            aria-hidden
            loading="eager"
            decoding="async"
            fetchPriority="high"
            onLoad={() => setBannerLoaded(true)}
            onError={() => {
              invalidateResolvedHeroBanner(anilistId, activeBannerUrl);
              setBannerFailed(true);
            }}
            className={`pointer-events-none absolute inset-0 h-full w-full object-cover object-[center_24%] saturate-[1.18] transition-[opacity,transform] duration-200 group-hover:scale-[1.02] select-none ${bannerLoaded ? 'opacity-90' : 'opacity-0'}`}
          />
        )}
      </div>
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(7,6,10,0.88)_0%,rgba(7,6,10,0.46)_34%,rgba(7,6,10,0.04)_68%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(7,6,10,0.46)_0%,rgba(7,6,10,0.0)_22%,rgba(7,6,10,0.18)_54%,rgba(7,6,10,0.78)_80%,rgba(7,6,10,0.96)_92%,#07060A_100%)]" />
      <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(ellipse 56% 78% at 10% 92%, rgba(7,6,10,0.82) 0%, rgba(7,6,10,0.38) 55%, transparent 100%)' }} />
      <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(ellipse at 80% 18%, hsla(${themeHue}, 90%, 58%, .2), transparent 58%)` }} />

      <div
        style={{ minHeight: heroMinHeight }}
        className="relative z-10 flex w-full flex-col justify-end px-6 pb-7 pt-28 md:pb-9 md:pt-32 2xl:px-8 2xl:pb-10"
      >
        <div className="flex max-w-3xl flex-col">
        <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
          <span className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.14em] shadow-[0_0_24px_rgba(244,63,94,0.12)]" style={{ borderColor: `hsla(${themeHue}, 78%, 70%, .38)`, backgroundColor: `hsla(${themeHue}, 78%, 55%, .17)`, color: `hsl(${themeHue} 85% 82%)` }}>
            <span className="h-2 w-2 rounded-full shadow-[0_0_8px_currentColor]" style={{ backgroundColor: `hsl(${themeHue} 88% 72%)` }} />{isUpNext ? 'Up next' : 'Continue playing'}
          </span>
          {isMovie && badgeLabel && <span className="rounded-md border border-white/15 bg-black/35 px-3 py-1.5 font-mono text-xs font-semibold text-zinc-200 backdrop-blur">{badgeLabel}</span>}
          <span className="rounded-md border border-white/15 bg-black/35 px-3 py-1.5 font-mono text-xs text-zinc-300 backdrop-blur">{formatTime(progress.currentTime)} / {formatTime(progress.duration)}</span>
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
                ? 'mb-1.5 max-h-24 w-auto max-w-[min(100%,420px)] self-start object-contain object-left drop-shadow-[0_10px_28px_rgba(0,0,0,0.85)] transition-opacity duration-300 select-none md:max-h-32 md:max-w-[520px] 2xl:max-h-36 2xl:max-w-[580px]'
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
        <p className="mt-2 text-lg font-bold text-zinc-100 [text-shadow:0_2px_10px_rgba(0,0,0,0.9)] md:text-xl 2xl:text-2xl">{episodeTitle}</p>
        {description && (
          <>
            <p
              ref={descriptionRef}
              onClick={() => { if (descriptionClamped) setDescriptionReaderOpen(true) }}
              title={descriptionClamped ? 'Show full description' : undefined}
              className={`mt-2.5 max-w-2xl text-sm leading-relaxed text-zinc-200/90 [text-shadow:0_2px_8px_rgba(0,0,0,0.95)] transition-colors md:text-[15px] 2xl:text-base line-clamp-2 ${
                descriptionClamped ? 'cursor-pointer hover:text-white' : ''
              }`}
            >
              {description}
            </p>
            {descriptionClamped && (
              <button
                type="button"
                onClick={() => setDescriptionReaderOpen(true)}
                className="mt-1 self-start text-xs font-semibold text-zinc-300 [text-shadow:0_1px_6px_rgba(0,0,0,0.95)] transition-colors hover:text-white"
              >
                Show more
              </button>
            )}
          </>
        )}

        <div className={`max-w-lg 2xl:max-w-xl ${description ? 'mt-4' : 'mt-5'}`}>
          <div className="mb-2 flex items-center justify-between font-mono text-xs text-zinc-200 [text-shadow:0_1px_6px_rgba(0,0,0,0.95)]">
            <span>{percent}% completed</span><span>{formatTime(remaining)} remaining</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full border border-white/10 bg-black/70 p-[2px]">
            <div className="h-full rounded-full transition-all" style={{ width: `${percent}%`, background: 'linear-gradient(90deg, #9E1148, #FF1E6D)', boxShadow: '0 0 16px rgba(255, 30, 109, 0.45)' }} />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3.5">
          <button onClick={() => onPlay(episode, startAt)} className="btn-hue inline-flex items-center gap-2.5 rounded-2xl px-7 py-4 text-[15px] font-extrabold text-white transition hover:-translate-y-0.5 active:translate-y-0" title={`Resume ${resumeTarget}`}>
            <Play className="h-[18px] w-[18px] fill-current" /> Resume {resumeTarget}
          </button>
          {onOpenDetails && <button onClick={onOpenDetails} className="inline-flex items-center gap-2 rounded-2xl border border-white/15 bg-white/[0.06] px-6 py-4 text-[15px] font-semibold text-zinc-100 backdrop-blur transition hover:bg-white/10">
            Anime overview <ArrowRight className="h-[18px] w-[18px]" />
          </button>}
        </div>
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

export const UpNextWidget = React.memo(UpNextWidgetImpl);
