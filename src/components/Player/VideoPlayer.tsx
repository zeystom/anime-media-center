import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import JASSUB from 'jassub';
import workerUrl from 'jassub/dist/worker/worker.js?worker&url';
import wasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url';
import modernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  FastForward,
  ArrowLeft,
  ListVideo,
  Subtitles,
  Sparkles,
  SkipForward,
  SlidersHorizontal,
  ChevronLeft,
  X,
  AlertCircle,
  Film,
} from 'lucide-react';
import { Episode, VideoMetadata, VideoChapter, SubtitleCue, SeasonPreference, AppSettings, AnimeFolder } from '../../types';
import { SubtitleOverlay } from './SubtitleOverlay';
import { TimelineScrubber } from './TimelineScrubber';
import { TrackControls } from './TrackControls';
import { EpisodeDrawer } from './EpisodeDrawer';
import { MagneticEpisodePeek } from './MagneticEpisodePeek';
import { RippleIndicator, RippleType } from './RippleIndicator';
import { formatTime, cleanEpisodeTitle, cleanSeriesTitle, formatEpisodeDisplayTitle } from '../../utils/format';
import { parseReleaseCore } from '../../lib/releaseParser/regexEngine';
import { PLACEHOLDER_EPISODE_IMAGE } from '../../utils/assets';

interface VideoPlayerProps {
  episode: Episode;
  seasonEpisodes: Episode[];
  folderPath: string;
  folder?: AnimeFolder | null;
  animeTitle?: string;
  initialTime?: number;
  settings: AppSettings;
  onUpdateSettings?: (updated: Partial<AppSettings>) => void;
  history: Record<string, any>;
  onClose: () => void;
  onEpisodeChange: (episode: Episode, startAt?: number) => void;
  onEpisodeCompleted?: (episode: Episode) => void;
}

function combineAss(ass1: string, ass2: string): string {
  if (!ass1) return ass2;
  if (!ass2) return ass1;

  const ass2StylesMatch = ass2.match(/\[V4\+ Styles\]([\s\S]*?)(\[Events\]|$)/i);
  const ass2EventsMatch = ass2.match(/\[Events\]([\s\S]*?)$/i);

  // Check PlayResY scale ratio if both headers define resolution
  const resY1 = parseInt(ass1.match(/PlayResY:\s*(\d+)/i)?.[1] || '0', 10);
  const resY2 = parseInt(ass2.match(/PlayResY:\s*(\d+)/i)?.[1] || '0', 10);
  const scale = resY1 > 0 && resY2 > 0 && resY1 !== resY2 ? resY1 / resY2 : 1;

  let combined = ass1;
  if (ass2StylesMatch && ass2StylesMatch[1]) {
    const rawStyles = ass2StylesMatch[1].split('\n').filter((l) => l.trim().startsWith('Style:'));
    const namespacedStyles: string[] = [];
    for (const styleLine of rawStyles) {
      const m = styleLine.match(/^Style:\s*([^,]+)(.*)$/i);
      if (m) {
        const styleName = m[1].trim();
        let rest = m[2];
        if (scale !== 1) {
          // Format: Name, Fontname, Fontsize, ...
          const parts = rest.split(',');
          if (parts.length >= 3) {
            const origSize = parseFloat(parts[2]) || 0;
            if (origSize > 0) parts[2] = Math.round(origSize * scale).toString();
            rest = parts.join(',');
          }
        }
        namespacedStyles.push(`Style: __s2_${styleName}${rest}`);
      } else {
        namespacedStyles.push(styleLine);
      }
    }
    if (namespacedStyles.length > 0) {
      combined = combined.replace(/\[Events\]/i, `${namespacedStyles.join('\n')}\n\n[Events]`);
    }
  }

  if (ass2EventsMatch && ass2EventsMatch[1]) {
    const rawLines = ass2EventsMatch[1].split('\n').filter((l) => /^(?:Dialogue|Comment):/i.test(l.trim()));
    const namespacedLines: string[] = [];
    for (const line of rawLines) {
      const dlgMatch = line.match(/^((?:Dialogue|Comment):\s*[^,]+,[^,]+,[^,]+,)([^,]+)(,.*)$/i);
      if (dlgMatch) {
        const head = dlgMatch[1];
        const style = dlgMatch[2].trim();
        const tail = dlgMatch[3];
        namespacedLines.push(`${head}__s2_${style}${tail}`);
      } else {
        namespacedLines.push(line);
      }
    }

    if (namespacedLines.length > 0) {
      combined = combined.trim() + '\n' + namespacedLines.join('\n');
    }
  }

  // Sort events chronologically to minimize libass frame-lookup overhead on weaker PCs
  const eventsSplit = combined.split(/\[Events\]/i);
  if (eventsSplit.length === 2) {
    const header = eventsSplit[0] + '[Events]\n';
    const eventLines = eventsSplit[1].split('\n');
    const formatLine = eventLines.find((l) => l.trim().startsWith('Format:')) || 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';
    const dialogueLines = eventLines.filter((l) => /^(?:Dialogue|Comment):/i.test(l.trim()));
    dialogueLines.sort((a, b) => {
      const mA = a.match(/^(?:Dialogue|Comment):\s*[^,]+,\s*([^,]+)/i);
      const mB = b.match(/^(?:Dialogue|Comment):\s*[^,]+,\s*([^,]+)/i);
      const tA = mA ? parseAssTimestamp(mA[1]) : 0;
      const tB = mB ? parseAssTimestamp(mB[1]) : 0;
      return tA - tB;
    });
    combined = header + formatLine + '\n' + dialogueLines.join('\n') + '\n';
  }

  return combined;
}

function parseAssTimestamp(timeStr: string): number {
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const minutes = parseFloat(parts[1]) || 0;
    const seconds = parseFloat(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return 0;
}

function cleanAssText(raw: string): string {
  return raw
    .replace(/\{[^}]+\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\\N/gi, '\n')
    .replace(/\\h/gi, ' ')
    .trim();
}

function parseAssToCues(assContent: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const lines = assContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let id = 1;

  for (const line of lines) {
    if (!line.startsWith('Dialogue:')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const rest = line.slice(colonIdx + 1).trim();
    const parts = rest.split(',');
    if (parts.length < 10) continue;

    const start = parseAssTimestamp(parts[1]);
    const end = parseAssTimestamp(parts[2]);
    const rawText = parts.slice(9).join(',');
    const text = cleanAssText(rawText);

    if (text && end > start) {
      cues.push({ id: id++, start, end, text });
    }
  }

  return cues;
}

export interface DetectedOpening {
  start: number;
  end: number;
  source: 'chapter' | 'subtitle_tag' | 'subtitle_lyrics' | 'cues' | 'aniskip';
  title?: string;
}

function isOpeningChapterTitle(title?: string): boolean {
  const t = (title || '').trim().toLowerCase();
  if (!t) return false;
  // Exclude cold opens, endings, recaps, previews, dialogue parts
  if (/^(?:intro|prologue|pre-opening|cold\s*open|recap|preview|part\s*[ab12]|episode|ed|ending)/i.test(t)) {
    return false;
  }
  // Match OP patterns
  return (
    /^(?:op|opening|openning)(?:\b|\d|\s|:|-|$)/i.test(t) ||
    /(?:^|\b)(?:op|opening|openning)\s*(?:theme|\d+)?(?:\b|$)/i.test(t) ||
    /theme\s*song/i.test(t)
  );
}

function isOpStyleName(style?: string): boolean {
  const s = (style || '').trim().toLowerCase();
  if (!s) return false;
  // Exclude ED, ending, default dialogue styles, narration
  if (/ed|ending|option|opera|default|dialogue|narration|thought|italic|flashback/i.test(s)) return false;
  return (
    /^(?:op|opening)(?:_|-|$|\s)/i.test(s) ||
    /(?:_|-)(?:op|opening)(?:_|-|$|\s)/i.test(s) ||
    /(?:^|\b)op(?:tl|ro|kanji|lyrics|title)\b/i.test(s)
  );
}

function detectOpeningRange(
  chapters?: VideoChapter[],
  assContent?: string,
  cues?: SubtitleCue[]
): DetectedOpening | null {
  // 1. Check MKV Chapters
  if (chapters && chapters.length > 0) {
    const op = chapters.find((c) => {
      const isMatch = isOpeningChapterTitle(c.title);
      const duration = c.end - c.start;
      return isMatch && duration >= 40 && duration <= 130;
    });
    if (op) {
      return { start: op.start, end: op.end, source: 'chapter', title: op.title };
    }
  }

  // 2. Check ASS Subtitles (Tags & Lyric styles)
  if (assContent) {
    const lines = assContent.split(/\r?\n/);
    const opLines: { start: number; end: number; style: string }[] = [];
    let tagOpStart: number | null = null;
    let tagOpEnd: number | null = null;

    for (const line of lines) {
      if (!line.startsWith('Dialogue:')) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const parts = line.slice(colonIdx + 1).split(',');
      if (parts.length < 10) continue;

      const start = parseAssTimestamp(parts[1]);
      const end = parseAssTimestamp(parts[2]);
      const style = parts[3]?.trim() || '';
      const text = parts.slice(9).join(',');

      // Explicit section markers in subtitle cues: {OP}, [OP], {Opening}
      if (tagOpStart === null && /\{op\}|\[op\]|\{opening\}|\[opening\]/i.test(text)) {
        tagOpStart = start;
      } else if (tagOpStart !== null && tagOpEnd === null && start > tagOpStart) {
        if (/\{episode\}|\[episode\]|\{part\s*[ab12]\}|\[part\s*[ab12]\]|\{ed\}|\[ed\]|\{title\}/i.test(text)) {
          if (start - tagOpStart >= 40 && start - tagOpStart <= 130) {
            tagOpEnd = start;
          }
        }
      }

      // Opening lyric styles
      if (isOpStyleName(style)) {
        opLines.push({ start, end, style });
      }
    }

    if (tagOpStart !== null) {
      const finalEnd = tagOpEnd || tagOpStart + 90;
      return { start: tagOpStart, end: finalEnd, source: 'subtitle_tag' };
    }

    if (opLines.length >= 3) {
      const minStart = Math.min(...opLines.map((l) => l.start));
      const maxEnd = Math.max(...opLines.map((l) => l.end));
      if (maxEnd - minStart >= 40 && maxEnd - minStart <= 120) {
        return {
          start: Math.max(0, minStart - 2),
          end: Math.min(minStart + 92, maxEnd + 2),
          source: 'subtitle_lyrics',
        };
      }
    }
  }

  // 3. Check parsed subtitle cues (e.g. SRT with song tags)
  if (cues && cues.length > 0) {
    const opCue = cues.find((c) =>
      /\[(?:opening\s*theme|theme\s*song|op\s*theme|opening)\]|\((?:opening\s*theme|theme\s*song|opening)\)/i.test(
        c.text || ''
      )
    );
    if (opCue) {
      return { start: opCue.start, end: opCue.start + 90, source: 'cues' };
    }
  }

  // 4. Check Unnamed MKV Chapters (~85-93s duration in the first 6 minutes)
  // Many anime encodes have chapters titled "Chapter 01", "Chapter 02" without names.
  // In TV anime, a chapter of 85-93 seconds within the first 6 minutes is 99% the OP!
  if (chapters && chapters.length > 0) {
    const unnamedOp = chapters.find((c) => {
      const duration = c.end - c.start;
      const isIntroOrColdOpen = /intro|cold\s*open|prologue/i.test(c.title || '');
      const isEnding = /ed|ending|preview/i.test(c.title || '');
      return !isIntroOrColdOpen && !isEnding && c.start < 360 && duration >= 85 && duration <= 93;
    });
    if (unnamedOp) {
      return {
        start: unnamedOp.start,
        end: unnamedOp.end,
        source: 'chapter',
        title: unnamedOp.title || 'Opening',
      };
    }
  }

  return null;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  episode,
  seasonEpisodes,
  folderPath,
  folder,
  animeTitle,
  initialTime = 0,
  settings,
  onUpdateSettings,
  history,
  onClose,
  onEpisodeChange,
  onEpisodeCompleted,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekFrameRef = useRef<HTMLCanvasElement>(null);
  const [showSeekFrame, setShowSeekFrame] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // filePath already reported through onEpisodeCompleted (fires once per episode)
  const lastCompletedNotifiedRef = useRef<string | null>(null);

  // Clean parsed episode metadata
  const parsed = useMemo(() => cleanEpisodeTitle(episode.fileName), [episode.fileName]);

  // Effective anime title (canonicalTitle from API/cache first, then clean folder name, then parsed series title)
  const effectiveAnimeTitle = useMemo(() => {
    if (animeTitle && animeTitle.trim()) return animeTitle.trim();
    if (folder?.canonicalTitle && folder.canonicalTitle.trim()) return folder.canonicalTitle.trim();
    if (folder?.folderName) {
      const cleaned = cleanSeriesTitle(folder.folderName);
      if (cleaned && cleaned.trim()) return cleaned.trim();
      return folder.folderName.trim();
    }
    if (parsed.seriesTitle && parsed.seriesTitle.trim()) return parsed.seriesTitle.trim();
    const fromFolder = folderPath ? cleanSeriesTitle(folderPath.split(/[/\\]/).filter(Boolean).pop() || '') : '';
    return fromFolder || '';
  }, [animeTitle, folder, parsed.seriesTitle, folderPath]);

  // Full formatted episode title for top header and tooltip
  const fullPlayerTitle = useMemo(() => {
    const formattedEpTitle = formatEpisodeDisplayTitle(
      parsed.displayTitle,
      episode.kitsuTitle || episode.episodeTitle
    );
    const series = effectiveAnimeTitle || parsed.seriesTitle;
    if (series && formattedEpTitle) {
      return `${series} — ${formattedEpTitle}`;
    }
    return series || formattedEpTitle || episode.fileName;
  }, [
    effectiveAnimeTitle,
    parsed.seriesTitle,
    parsed.displayTitle,
    episode.kitsuTitle,
    episode.episodeTitle,
    episode.fileName,
  ]);

  // Remote episodes enrichment when anilistId is available
  const [remoteEpisodes, setRemoteEpisodes] = useState<Map<number, { title: string | null; thumbnailUrl: string | null }>>(new Map());
  const anilistId = folder?.anilistId;

  useEffect(() => {
    if (!anilistId) return;
    const api = window.electronAPI;
    if (!api?.getRemoteEpisodes) return;

    let cancelled = false;
    api.getRemoteEpisodes(anilistId).then((res) => {
      if (cancelled || !res?.episodes) return;
      const map = new Map<number, { title: string | null; thumbnailUrl: string | null }>();
      for (const ep of res.episodes) {
        if (typeof ep.number === 'number' && (ep.title || ep.thumbnailUrl)) {
          map.set(ep.number, { title: ep.title, thumbnailUrl: ep.thumbnailUrl });
        }
      }
      setRemoteEpisodes(map);
    }).catch(() => {});

    const unsub = api.onRemoteEpisodesUpdated?.((id, res) => {
      if (cancelled || id !== anilistId || !res?.episodes) return;
      const map = new Map<number, { title: string | null; thumbnailUrl: string | null }>();
      for (const ep of res.episodes) {
        if (typeof ep.number === 'number' && (ep.title || ep.thumbnailUrl)) {
          map.set(ep.number, { title: ep.title, thumbnailUrl: ep.thumbnailUrl });
        }
      }
      setRemoteEpisodes(map);
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [anilistId]);

  // Video metadata
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(true);

  // Sync with native Electron window fullscreen state
  useEffect(() => {
    if (!window.electronAPI) return;
    if (window.electronAPI.onFullScreenChange) {
      const unsub = window.electronAPI.onFullScreenChange((isFull) => {
        setIsFullscreen(isFull);
      });
      window.electronAPI.isFullScreen().then((isFull) => {
        setIsFullscreen(isFull);
      }).catch(() => {});
      return () => unsub();
    }
  }, []);

  const [streamStartTime, setStreamStartTime] = useState<number>(initialTime);
  const [videoElementTime, setVideoElementTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);

  // Debounce ref for rapid seeking/skipping
  const seekDebounceRef = useRef<any>(null);

  // Absolute playback time = streamStartTime + videoElement.currentTime
  const currentAbsoluteTime = streamStartTime + videoElementTime;

  // Stable ref for timers and event listeners to avoid re-renders
  const timeRef = useRef(currentAbsoluteTime);
  // While a seek is being debounced or its stream URL is being prepared, keep
  // the user's target time instead of replacing it with stale video events.
  const pendingSeekTargetRef = useRef<number | null>(null);

  // Track selection
  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number>(0);
  const [selectedMainSubId, setSelectedMainSubId] = useState<string | null>(null);
  const [selectedTopSubId, setSelectedTopSubId] = useState<string | null>(null);
  const [topSubEnabled, setTopSubEnabled] = useState<boolean>(false);
  const [syncOffset, setSyncOffset] = useState<number>(0);

  // Subtitle Appearance & Style (defaults to 38px, White, Sans, Outline always active)
  const [fontSize, setFontSize] = useState<number>(settings.subtitlesFontSize || 38);
  const [textColor, setTextColor] = useState<string>(settings.subtitlesTextColor || '#ffffff');
  const [fontFamily, setFontFamily] = useState<'sans' | 'trebuchet' | 'rounded' | 'serif' | 'mono'>(
    settings.subtitlesFontFamily || 'sans'
  );
  const [bgStyle, setBgStyle] = useState<'none' | 'translucent' | 'semi' | 'solid'>(
    settings.subtitlesBgStyle || 'none'
  );
  const [outlineWidth, setOutlineWidth] = useState<'thin' | 'medium' | 'thick' | 'heavy' | 'none'>(
    settings.subtitlesOutlineWidth || 'thick'
  );
  const [outlineColor, setOutlineColor] = useState<string>(
    settings.subtitlesOutlineColor || '#000000'
  );

  // Fetch freshest settings from disk on player mount to ensure zero resets
  useEffect(() => {
    if (window.electronAPI?.getSettings) {
      window.electronAPI.getSettings().then((s) => {
        if (s) {
          if (s.subtitlesFontSize) setFontSize(s.subtitlesFontSize);
          if (s.subtitlesTextColor) setTextColor(s.subtitlesTextColor);
          if (s.subtitlesFontFamily) setFontFamily(s.subtitlesFontFamily);
          if (s.subtitlesBgStyle) setBgStyle(s.subtitlesBgStyle);
          if (s.subtitlesOutlineWidth) setOutlineWidth(s.subtitlesOutlineWidth);
          if (s.subtitlesOutlineColor) setOutlineColor(s.subtitlesOutlineColor);
        }
      }).catch(() => {});
    }
  }, []);

  const [subtitlesLoading, setSubtitlesLoading] = useState<boolean>(false);

  // Parsed Subtitle Cues & Raw ASS for smart feature detection
  const [loadedAssContent, setLoadedAssContent] = useState<string>('');
  const [mainCues, setMainCues] = useState<SubtitleCue[]>([]);
  const [topCues, setTopCues] = useState<SubtitleCue[]>([]);
  const [isMainAssActive, setIsMainAssActive] = useState<boolean>(false);
  const [isTopAssActive, setIsTopAssActive] = useState<boolean>(false);
  const pendingSubtitleFileRef = useRef<string | null>(episode.filePath);
  const subtitleReadyFileRef = useRef<string | null>(null);
  const activeStreamFileRef = useRef<string | null>(null);

  // Hold playback at episode boundaries until that episode's selected subtitle
  // tracks are ready, so the opening seconds cannot run ahead without captions.
  useEffect(() => {
    pendingSubtitleFileRef.current = episode.filePath;
    subtitleReadyFileRef.current = null;
    setSubtitlesLoading(true);
    setMainCues([]);
    setTopCues([]);
    setLoadedAssContent('');
    setIsMainAssActive(false);
    setIsTopAssActive(false);
    videoRef.current?.pause();
  }, [episode.filePath]);

  // JASSUB WebAssembly ASS Engine
  const jassubRef = useRef<JASSUB | null>(null);
  const serverPortRef = useRef<number>(0);
  const streamStartTimeRef = useRef<number>(0);
  streamStartTimeRef.current = streamStartTime;
  const syncOffsetRef = useRef<number>(0);
  syncOffsetRef.current = syncOffset;

  // High-precision video frame synchronizer: updates absolute playback time on every presented frame,
  // completely eliminating the 250ms HTML5 onTimeUpdate lag for secondary subtitles and cues.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !('requestVideoFrameCallback' in video)) return;

    let callbackId: number | undefined;
    let isActive = true;

    const onFrame = (_now: DOMHighResTimeStamp, metadata?: any) => {
      if (!isActive) return;
      const mediaTime = typeof metadata?.mediaTime === 'number' ? metadata.mediaTime : video.currentTime;
      setVideoElementTime(mediaTime);
      if (pendingSeekTargetRef.current === null) {
        timeRef.current = streamStartTimeRef.current + mediaTime;
      }
      callbackId = (video as any).requestVideoFrameCallback(onFrame);
    };

    callbackId = (video as any).requestVideoFrameCallback(onFrame);

    return () => {
      isActive = false;
      if (callbackId && 'cancelVideoFrameCallback' in video) {
        (video as any).cancelVideoFrameCallback(callbackId);
      }
    };
  }, [episode.filePath]);

  // UI Drawer / Modals
  const [isTrackControlsOpen, setIsTrackControlsOpen] = useState<boolean>(false);
  const [isEpisodeDrawerOpen, setIsEpisodeDrawerOpen] = useState<boolean>(false);
  const [episodeDrawerOpenMode, setEpisodeDrawerOpenMode] = useState<'button' | 'edge'>('button');
  const [autoPlayNext, setAutoPlayNext] = useState<boolean>(settings.autoPlayNext);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  // Episode navigation & chapters
  const currentEpIndex = useMemo(() => {
    return seasonEpisodes.findIndex((e) => e.filePath === episode.filePath);
  }, [seasonEpisodes, episode.filePath]);

  const nextEpisode = useMemo(() => {
    if (currentEpIndex >= 0 && currentEpIndex < seasonEpisodes.length - 1) {
      return seasonEpisodes[currentEpIndex + 1];
    }
    return null;
  }, [seasonEpisodes, currentEpIndex]);

  // Detected Opening Range (from local MKV chapters, ASS subtitle tags, or karaoke lyrics)
  const localOpening = useMemo<DetectedOpening | null>(() => {
    return detectOpeningRange(metadata?.chapters, loadedAssContent, mainCues);
  }, [metadata?.chapters, loadedAssContent, mainCues]);

  // AniSkip Online Fallback (for bare releases without chapters or ASS styles)
  const [aniSkipOpening, setAniSkipOpening] = useState<DetectedOpening | null>(null);

  useEffect(() => {
    // If local detection already resolved the opening, do not query AniSkip
    if (localOpening || duration <= 0) return;

    let isCancelled = false;
    const epNum = parseInt(episode.episodeNumber.replace(/\D/g, ''), 10) || 1;
    const seriesName = effectiveAnimeTitle || parsed.seriesTitle || folderPath.split(/[/\\]/).pop() || '';

    if (window.electronAPI.getAniSkipTimes && seriesName && epNum > 0) {
      window.electronAPI
        .getAniSkipTimes(seriesName, epNum, duration)
        .then((res) => {
          if (isCancelled || !res?.op) return;
          setAniSkipOpening({
            start: res.op.start,
            end: res.op.end,
            source: 'aniskip',
            title: 'Opening (AniSkip)',
          });
        })
        .catch(() => {});
    }

    return () => {
      isCancelled = true;
    };
  }, [localOpening, duration, episode.episodeNumber, effectiveAnimeTitle, parsed.seriesTitle, folderPath]);

  // Effective opening: local detection first, AniSkip fallback second
  const detectedOpening = localOpening || aniSkipOpening;

  const edChapter = useMemo(() => {
    if (!metadata?.chapters || duration <= 0) return null;
    return metadata.chapters.find(
      (c) => /ed|ending|credits|preview/i.test(c.title) && c.start >= duration - 360
    );
  }, [metadata?.chapters, duration]);

  const endingStartTime = useMemo(() => {
    if (edChapter) return edChapter.start;
    return duration > 90 ? duration - 90 : Infinity;
  }, [edChapter, duration]);

  const [isEndingCardDismissed, setIsEndingCardDismissed] = useState<boolean>(false);
  const [isIntroDismissed, setIsIntroDismissed] = useState<boolean>(false);

  useEffect(() => {
    setIsEndingCardDismissed(false);
    setIsIntroDismissed(false);
    setLoadedAssContent('');
    setAniSkipOpening(null);
  }, [episode.filePath]);

  const isEndingActive =
    !isEndingCardDismissed &&
    nextEpisode !== null &&
    duration > 0 &&
    currentAbsoluteTime >= endingStartTime;

  // Opening prompt is active ONLY when an opening is genuinely playing right now!
  // 1) Must have a confirmed detected opening range.
  // 2) Current playback time is strictly within [start, end).
  // 3) Never show when no opening exists (e.g. Clevatess S01E01, Mushoku Tensei scenes),
  //    and never hang for arbitrary 4.5 minutes during dialogue!
  const isIntroActive =
    !isIntroDismissed &&
    detectedOpening !== null &&
    currentAbsoluteTime >= detectedOpening.start &&
    currentAbsoluteTime < detectedOpening.end;

  // Ripple feedback
  const [ripple, setRipple] = useState<{ type: RippleType; text?: string } | null>(null);
  const rippleTimerRef = useRef<any>(null);

  // Controls auto-hide
  const [showControls, setShowControls] = useState<boolean>(true);
  const hideControlsTimerRef = useRef<any>(null);

  const showRipple = useCallback((type: RippleType, text?: string) => {
    if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current);
    setRipple({ type, text });
    rippleTimerRef.current = setTimeout(() => {
      setRipple(null);
    }, 600);
  }, []);

  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => {
      setShowControls(false);
    }, 3500);
  }, []);

  // 1. Initial Load: Probe Video & Fetch Season Preferences
  useEffect(() => {
    let isMounted = true;
    setLoading(true);

    (async () => {
      try {
        const meta = await window.electronAPI.probeVideo(episode.filePath);
        if (!isMounted) return;

        setMetadata(meta);
        setDuration(meta.duration);

        // Fetch Season Preference
        const seasonPref = await window.electronAPI.getSeasonPreference(folderPath);

        // Determine Default Audio Track (Auto-select 'eng' by default)
        let defaultAudioIdx = 0;
        let selectedAudioTrack: any = null;
        if (seasonPref?.preferredAudioIndex !== undefined) {
          defaultAudioIdx = seasonPref.preferredAudioIndex;
          selectedAudioTrack = meta.audioTracks.find((t) => t.audioIndex === defaultAudioIdx);
        } else {
          const engTrack = meta.audioTracks.find(
            (t) => t.language === 'eng' || t.language === 'en' || /english/i.test(t.title)
          );
          if (engTrack) {
            defaultAudioIdx = engTrack.audioIndex;
            selectedAudioTrack = engTrack;
          } else {
            selectedAudioTrack = meta.audioTracks[0];
          }
        }
        setSelectedAudioIndex(defaultAudioIdx);

        // Determine Default Main Subtitle:
        // When English Audio (Dub) is playing: prioritize English Dubtitles (SDH) / External Whisper SRT!
        // When Japanese Audio is playing: prioritize English translation dialogue (CR / full ASS)!
        let mainSubId: string | null = null;
        if (seasonPref && 'mainSubtitleTrackId' in seasonPref && seasonPref.mainSubtitleTrackId !== undefined) {
          if (seasonPref.mainSubtitleTrackId === null) {
            // User explicitly chose OFF (No Subtitles) for this season
            mainSubId = null;
          } else {
            const targetId = seasonPref.mainSubtitleTrackId;
            const exactMatch = meta.subtitleTracks.find((s) => s.id === targetId);
            if (exactMatch) {
              mainSubId = exactMatch.id;
            } else if (targetId.startsWith('ext-')) {
              // External Whisper / SRT track: find any external track in current episode
              const ext = meta.subtitleTracks.find((s) => s.type === 'external');
              if (ext) mainSubId = ext.id;
            } else {
              // Embedded track: find track with matching language & dialogue type
              const matched = meta.subtitleTracks.find(
                (s) => !s.isSigns && (s.language === 'eng' || s.language === 'en')
              );
              if (matched) mainSubId = matched.id;
            }
          }
        } else {
          const isEngAudio =
            selectedAudioTrack &&
            (selectedAudioTrack.language === 'eng' ||
              selectedAudioTrack.language === 'en' ||
              /english|dub/i.test(selectedAudioTrack.title));

          const engDubtitle = meta.subtitleTracks.find(
            (s) =>
              (s.language === 'eng' || s.language === 'en') &&
              (s.isDubtitle || /sdh|dubtitle|hearing impaired/i.test(s.title)) &&
              !s.isSigns
          );
          const extSub = meta.subtitleTracks.find((s) => s.type === 'external');
          const defaultEngSub = meta.subtitleTracks.find(
            (s) => (s.language === 'eng' || s.language === 'en') && s.isDefault && !s.isSigns
          );
          const engDialogue = meta.subtitleTracks.find(
            (s) => (s.language === 'eng' || s.language === 'en') && !s.isSigns
          );

          if (isEngAudio) {
            if (engDubtitle) {
              mainSubId = engDubtitle.id;
            } else if (extSub) {
              mainSubId = extSub.id;
            } else if (defaultEngSub) {
              mainSubId = defaultEngSub.id;
            } else if (engDialogue) {
              mainSubId = engDialogue.id;
            }
          } else {
            if (defaultEngSub) {
              mainSubId = defaultEngSub.id;
            } else if (extSub) {
              mainSubId = extSub.id;
            } else if (engDialogue) {
              mainSubId = engDialogue.id;
            } else if (engDubtitle) {
              mainSubId = engDubtitle.id;
            }
          }
        }
        setSelectedMainSubId(mainSubId);

        // Determine Default Top Subtitle / Signs:
        // Strictly filter for English Forced/Signs tracks. NEVER auto-select foreign languages!
        let topSubId: string | null = null;
        let topEnabled = false;

        if (seasonPref && 'topSubtitleTrackId' in seasonPref && seasonPref.topSubtitleTrackId !== undefined) {
          if (seasonPref.topSubtitleTrackId === null) {
            topSubId = null;
            topEnabled = false;
          } else {
            const exactTop = meta.subtitleTracks.find((s) => s.id === seasonPref.topSubtitleTrackId);
            if (exactTop) {
              topSubId = exactTop.id;
              topEnabled = seasonPref.topSubEnabled;
            } else {
              const engSigns = meta.subtitleTracks.find(
                (s) =>
                  (s.language === 'eng' || s.language === 'en') &&
                  (s.isSigns || s.isForced || /sign|song|forced/i.test(s.title)) &&
                  s.id !== mainSubId
              );
              if (engSigns) {
                topSubId = engSigns.id;
                topEnabled = seasonPref.topSubEnabled;
              }
            }
          }
        } else {
          const selectedMain = meta.subtitleTracks.find((s) => s.id === mainSubId);
          const isMainFull = selectedMain && /full|all/i.test(selectedMain.title);

          const engSigns = meta.subtitleTracks.find(
            (s) =>
              (s.language === 'eng' || s.language === 'en') &&
              (s.isSigns || s.isForced || /sign|song|forced/i.test(s.title)) &&
              s.id !== mainSubId
          );
          if (engSigns) {
            topSubId = engSigns.id;
            topEnabled = !isMainFull;
          }
        }

        setSelectedTopSubId(topSubId);
        setTopSubEnabled(topEnabled);
        if (seasonPref?.subSyncOffset !== undefined) {
          setSyncOffset(seasonPref.subSyncOffset);
        }

        // Setup Stream URL
        const savedProgress = history[episode.filePath];
        const effectiveStartTime =
          typeof initialTime === 'number' && initialTime > 0
            ? initialTime
            : (savedProgress?.currentTime && !savedProgress.completed ? savedProgress.currentTime : 0);

        const { url: streamUrl, actualStartTime } = await window.electronAPI.getStreamUrl(
          episode.filePath,
          defaultAudioIdx,
          effectiveStartTime
        );

        if (!isMounted) return;
        applyStream(streamUrl, actualStartTime, episode.filePath);
        setLoading(false);
      } catch (err: any) {
        console.error('Failed to probe or setup video:', err);
        const errMsg = err?.message || '';
        if (!settings.ffmpegPath || errMsg.toLowerCase().includes('ffmpeg') || errMsg.toLowerCase().includes('enoent')) {
          setPlaybackError('FFmpeg binary not found or failed to launch. Please configure FFmpeg in Settings.');
        } else {
          setPlaybackError(`Failed to load video stream: ${errMsg || 'Unknown error'}`);
        }
        setLoading(false);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [episode.filePath, folderPath]);

  // 2. Subtitle Extraction & JASSUB Rendering
  useEffect(() => {
    let isCancelled = false;

    async function loadSubtitles() {
      // Do not leave the previous episode's cues visible while the next
      // episode's subtitle track is being extracted and parsed.
      setMainCues([]);
      setTopCues([]);
      setLoadedAssContent('');
      setIsMainAssActive(false);
      setIsTopAssActive(false);
      if (!metadata || metadata.filePath !== episode.filePath) {
        setSubtitlesLoading(true);
        return;
      }

      const video = videoRef.current;
      const port = serverPortRef.current;

      const mainTrack = metadata.subtitleTracks.find((s) => s.id === selectedMainSubId);
      const topTrack = topSubEnabled ? metadata.subtitleTracks.find((s) => s.id === selectedTopSubId) : null;

      setSubtitlesLoading(true);

      try {
        const [mainRes, topRes] = await Promise.all([
          mainTrack
            ? window.electronAPI.extractSubtitleTrack(
                metadata.filePath,
                mainTrack.id,
                mainTrack.index,
                mainTrack.type === 'external',
                mainTrack.filePath
              )
            : Promise.resolve(null),
          topTrack && topSubEnabled
            ? window.electronAPI.extractSubtitleTrack(
                metadata.filePath,
                topTrack.id,
                topTrack.index,
                topTrack.type === 'external',
                topTrack.filePath
              )
            : Promise.resolve(null),
        ]);

        if (isCancelled) return;

        let assContent = '';
        const assFonts: string[] = [];
        let newMainCues: SubtitleCue[] = [];
        let newTopCues: SubtitleCue[] = [];
        let mainIsAss = false;
        let topIsAss = false;

        // 1. Process Main Track
        if (mainRes) {
          if (mainRes.format === 'ass' && mainRes.content) {
            mainIsAss = true;
            assContent = mainRes.content;
            if (mainRes.fonts) assFonts.push(...mainRes.fonts);
            newMainCues = parseAssToCues(mainRes.content);
          } else if (mainRes.cues) {
            newMainCues = mainRes.cues;
          }
        }

        // 2. Process Top Track (Signs, Songs, 2nd Subtitles)
        if (topRes) {
          if (topRes.format === 'ass' && topRes.content) {
            topIsAss = true;
            assContent = assContent ? combineAss(assContent, topRes.content) : topRes.content;
            if (topRes.fonts) assFonts.push(...topRes.fonts);
            newTopCues = parseAssToCues(topRes.content);
          } else if (topRes.cues) {
            newTopCues = topRes.cues;
          }
        }

        setLoadedAssContent(assContent);
        setMainCues(newMainCues);
        setTopCues(newTopCues);
        setSubtitlesLoading(false);

        // Clean up previous JASSUB instance
        if (jassubRef.current) {
          try {
            await jassubRef.current.destroy();
          } catch {}
          jassubRef.current = null;
        }

        if (isCancelled) return;

        const effectivePort = mainRes?.port || topRes?.port || serverPortRef.current || port;
        if (effectivePort) serverPortRef.current = effectivePort;

        // If we have valid ASS content (main dialogue or top signs), initialize JASSUB with all fonts!
        const hasValidAss = Boolean(
          assContent &&
          assContent.trim().length > 50 &&
          /\[Events\]/i.test(assContent)
        );

        if (hasValidAss && video) {
          try {
            const uniqueFonts = [...new Set(assFonts)]
              .filter((f) => !f.toLowerCase().includes('arialunicodems') && !f.toLowerCase().endsWith('.ttc'))
              .slice(0, 32);

            console.log(
              `[VideoPlayer] Initializing JASSUB with ${uniqueFonts.length} fonts and combined ASS styles`
            );

            const jassub = new JASSUB({
              video,
              subContent: assContent, // CONTAINS BOTH MAIN AND 2ND SUBTITLES COMBINED!
              fonts: uniqueFonts,
              workerUrl,
              wasmUrl,
              modernWasmUrl,
              timeOffset: streamStartTimeRef.current + syncOffsetRef.current,
              debug: false,
              prescaleFactor: 1.0,
              maxRenderHeight: 1080,
              libassMemoryLimit: 128,
              libassGlyphLimit: 4096,
            });
            jassubRef.current = jassub;
            setIsMainAssActive(mainIsAss);
            setIsTopAssActive(topIsAss);

            // Ensure timeOffset is 100% synchronized to the actual stream keyframe
            jassub.timeOffset = streamStartTimeRef.current + syncOffsetRef.current;

            try {
              await jassub.ready;
            } catch (err) {
              console.warn('[VideoPlayer] JASSUB worker init failed, using HTML subtitle overlay fallback:', err);
              if (jassubRef.current === jassub) {
                try {
                  jassub.destroy();
                } catch {}
                jassubRef.current = null;
                setIsMainAssActive(false);
                setIsTopAssActive(false);
              }
            }
          } catch (err) {
            console.warn('[VideoPlayer] Error creating JASSUB instance, falling back to HTML overlay:', err);
            setIsMainAssActive(false);
            setIsTopAssActive(false);
          }
        } else {
          setIsMainAssActive(false);
          setIsTopAssActive(false);
        }
      } catch (err) {
        console.error('[VideoPlayer] Error loading subtitles:', err);
      } finally {
        if (!isCancelled) {
          setSubtitlesLoading(false);
          if (metadata?.filePath === episode.filePath) {
            subtitleReadyFileRef.current = episode.filePath;
            if (pendingSubtitleFileRef.current === episode.filePath && activeStreamFileRef.current === episode.filePath) {
              pendingSubtitleFileRef.current = null;
              videoRef.current?.play().catch(() => {});
            }
          }
        }
      }
    }

    loadSubtitles();

    return () => {
      isCancelled = true;
      if (jassubRef.current) {
        jassubRef.current.destroy().catch(() => {});
        jassubRef.current = null;
      }
    };
  }, [metadata, selectedMainSubId, selectedTopSubId, topSubEnabled, episode.filePath]);

  // Progressive Phase 2: Apply newly extracted fonts on-the-fly to the active JASSUB instance
  useEffect(() => {
    if (!window.electronAPI?.onSubtitleFontsReady) return;
    return window.electronAPI.onSubtitleFontsReady(({ filePath, fonts }) => {
      if (filePath !== episode.filePath || !jassubRef.current || !fonts || fonts.length === 0) return;
      const jassub = jassubRef.current;
      console.log(`[VideoPlayer] Progressive Phase 2: Injecting ${fonts.length} styled fonts into active JASSUB instance`);
      const renderer = (jassub as any).renderer;
      if (renderer?.addFonts) {
        renderer.addFonts(fonts).then(() => {
          (jassub as any)._demandRender?.(true) || jassub.resize(true);
        }).catch((err: any) => {
          console.warn('[VideoPlayer] Failed to add fonts progressively:', err);
        });
      }
    });
  }, [episode.filePath]);

  // Background prefetch next episode's subtitles & fonts during playback
  useEffect(() => {
    if (!isPlaying || !window.electronAPI?.warmSubtitles || seasonEpisodes.length <= 1) return;
    const currentIndex = seasonEpisodes.findIndex((e) => e.filePath === episode.filePath);
    if (currentIndex < 0 || currentIndex >= seasonEpisodes.length - 1) return;
    const nextEp = seasonEpisodes[currentIndex + 1];
    if (!nextEp?.filePath) return;

    // Small delay (2.5 seconds into playback) so it doesn't compete with initial stream start
    const timer = setTimeout(() => {
      window.electronAPI.warmSubtitles?.(nextEp.filePath).catch(() => {});
    }, 2500);

    return () => clearTimeout(timer);
  }, [episode.filePath, isPlaying, seasonEpisodes]);

  // Player Unmount Cleanup: Stop video, destroy JASSUB, and terminate all backend FFmpeg streams
  useEffect(() => {
    return () => {
      if (videoRef.current) {
        try {
          videoRef.current.pause();
          videoRef.current.removeAttribute('src');
          videoRef.current.load();
        } catch {}
      }
      if (jassubRef.current) {
        try {
          jassubRef.current.destroy().catch(() => {});
        } catch {}
        jassubRef.current = null;
      }
      if (window.electronAPI) {
        window.electronAPI.stopVideoStream().catch(() => {});
      }
    };
  }, []);

  // Synchronize JASSUB when paused or seeking while paused
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePauseOrSeek = () => {
      const jassub = jassubRef.current;
      if (!jassub || !(jassub as any).renderer) return;

      // Only manually render when paused (during playback, requestVideoFrameCallback handles rendering smoothly)
      if (video.paused) {
        try {
          jassub.manualRender(
            {
              expectedDisplayTime: performance.now(),
              width: video.videoWidth || 1920,
              height: video.videoHeight || 1080,
              mediaTime: video.currentTime,
            },
            true
          );
        } catch {}
      }
    };

    video.addEventListener('seeked', handlePauseOrSeek);
    video.addEventListener('pause', handlePauseOrSeek);

    return () => {
      video.removeEventListener('seeked', handlePauseOrSeek);
      video.removeEventListener('pause', handlePauseOrSeek);
    };
  }, []);

  // Save season preference whenever audio/sub selection changes
  const persistSeasonRule = useCallback(
    (
      audioIdx = selectedAudioIndex,
      mainSub = selectedMainSubId,
      topSub = selectedTopSubId,
      topEnabled = topSubEnabled,
      offset = syncOffset
    ) => {
      const pref: SeasonPreference = {
        preferredAudioLanguage: 'eng',
        preferredAudioIndex: audioIdx,
        mainSubtitleTrackId: mainSub,
        topSubtitleTrackId: topSub,
        topSubEnabled: topEnabled,
        subSyncOffset: offset,
      };
      window.electronAPI.saveSeasonPreference(folderPath, pref).catch(() => {});
    },
    [folderPath, selectedAudioIndex, selectedMainSubId, selectedTopSubId, topSubEnabled, syncOffset]
  );

  // Sequence counter to prevent stale async seek responses from overwriting newer seeks
  const seekSeqRef = useRef<number>(0);

  // Safely apply stream URL and update playback timestamps
  const applyStream = useCallback((url: string, actualStartTime: number, filePath: string) => {
    const video = videoRef.current;
    if (!video) return;

    // Keep the last decoded frame visible while FFmpeg starts the replacement
    // stream, avoiding the noticeable black flash on every seek.
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      const canvas = seekFrameRef.current;
      const context = canvas?.getContext('2d');
      if (canvas && context) {
        try {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          setShowSeekFrame(true);
        } catch {
          setShowSeekFrame(false);
        }
      }
    }

    // 1. Align state and refs with the requested stream start timestamp.
    timeRef.current = actualStartTime;
    pendingSeekTargetRef.current = null;
    streamStartTimeRef.current = actualStartTime;
    setStreamStartTime(actualStartTime);
    setVideoElementTime(0);

    const portMatch = url.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (portMatch) {
      serverPortRef.current = parseInt(portMatch[1], 10);
    }
    if (jassubRef.current && (jassubRef.current as any).renderer) {
      try {
        jassubRef.current.timeOffset = actualStartTime + syncOffsetRef.current;
        jassubRef.current.manualRender(
          {
            expectedDisplayTime: performance.now(),
            width: video.videoWidth || 1920,
            height: video.videoHeight || 1080,
            mediaTime: 0,
          },
          true
        );
      } catch {}
    }

    // 2. Pause existing decoder context before changing source to prevent hardware decoder deadlock
    try {
      video.pause();
    } catch {}

    // 3. Start the replacement stream unless the new episode is waiting for
    // its selected subtitles to finish loading.
    video.src = url;
    activeStreamFileRef.current = filePath;

    if (pendingSubtitleFileRef.current === filePath && subtitleReadyFileRef.current !== filePath) {
      video.pause();
      setIsPlaying(false);
      return;
    }
    if (pendingSubtitleFileRef.current === filePath) pendingSubtitleFileRef.current = null;

    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        // AbortError is normal when user seeks again rapidly
        if (err.name !== 'AbortError') {
          console.warn('[VideoPlayer] Play interrupted:', err);
        }
      });
    }
    setIsPlaying(true);
  }, []);

  // Instant Stream Seek function (aligned to exact keyframe with 0s audio latency)
  const handleSeek = useCallback(
    async (targetTime: number) => {
      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current);
        seekDebounceRef.current = null;
      }

      const seq = ++seekSeqRef.current;
      const clamped = Math.max(0, Math.min(targetTime, duration));
      timeRef.current = clamped;
      pendingSeekTargetRef.current = clamped;

      try {
        const { url, actualStartTime } = await window.electronAPI.getStreamUrl(
          episode.filePath,
          selectedAudioIndex,
          clamped
        );

        // If another seek was initiated in the meantime, discard
        if (seq !== seekSeqRef.current) return;

        applyStream(url, actualStartTime, episode.filePath);
      } catch (err) {
        if (seq === seekSeqRef.current) pendingSeekTargetRef.current = null;
        console.error('Failed to seek stream:', err);
      }
    },
    [duration, episode.filePath, selectedAudioIndex, applyStream]
  );

  // Play / Pause Toggle
  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;

    if (videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
      showRipple('play', 'Play');
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
      showRipple('pause', 'Pause');
    }
  }, []);

  // Fullscreen Toggle (Desktop-grade native window or DOM fallback)
  const toggleFullscreen = useCallback(() => {
    if (window.electronAPI?.setFullScreen) {
      window.electronAPI.setFullScreen(!isFullscreen).catch(() => {});
    } else if (containerRef.current) {
      if (!document.fullscreenElement) {
        containerRef.current.requestFullscreen().catch(() => {});
        setIsFullscreen(true);
      } else {
        document.exitFullscreen().catch(() => {});
        setIsFullscreen(false);
      }
    }
  }, [isFullscreen]);

  // Coalesce key repeats, but keep each delta based on the latest intended time.
  const handleSkip = useCallback(
    (deltaSec: number, label: string) => {
      const baseTime = pendingSeekTargetRef.current ?? timeRef.current;
      const nextTime = Math.max(0, Math.min(baseTime + deltaSec, duration));
      timeRef.current = nextTime;
      pendingSeekTargetRef.current = nextTime;
      showRipple(deltaSec > 0 ? 'seek-forward' : 'seek-backward', label);

      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current);
      }

      seekDebounceRef.current = setTimeout(() => {
        seekDebounceRef.current = null;
        void handleSeek(nextTime);
      }, 90);
    },
    [duration, handleSeek, showRipple]
  );

  // Periodic Save of Playback History (Every 3 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      if (!metadata || duration <= 0) return;
      const progress = {
        filePath: episode.filePath,
        folderPath,
        fileName: episode.fileName,
        episodeNumber: episode.episodeNumber,
        currentTime: timeRef.current,
        duration,
        lastWatchedAt: Date.now(),
        completed: timeRef.current / duration > 0.9,
      };
      window.electronAPI.savePlaybackProgress(progress).catch(() => {});

      // Notify the host once per episode when the completion threshold is crossed
      if (progress.completed && lastCompletedNotifiedRef.current !== episode.filePath) {
        lastCompletedNotifiedRef.current = episode.filePath;
        onEpisodeCompleted?.(episode);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [metadata, episode, folderPath, duration]);

  // Play Next Episode directly
  const handlePlayNextEpisode = useCallback(() => {
    if (!nextEpisode) return;
    showRipple('forward', `Next: ${formatEpisodeDisplayTitle(nextEpisode)}`);
    const saved = history[nextEpisode.filePath];
    const resumeTime = saved?.currentTime && !saved.completed ? saved.currentTime : 0;
    onEpisodeChange(nextEpisode, resumeTime);
  }, [nextEpisode, onEpisodeChange, history, showRipple]);

  // Contextual Skip Intro / Opening (accurate chapter/subtitle end or informative feedback)
  const handleSkipIntro = useCallback(() => {
    setIsIntroDismissed(true);
    // If inside or right before a detected opening range
    if (detectedOpening && currentAbsoluteTime < detectedOpening.end) {
      handleSeek(detectedOpening.end);
      showRipple('forward', `Opening Skipped (${formatTime(detectedOpening.end)})`);
    } else {
      showRipple('info', 'No opening detected');
    }
  }, [detectedOpening, currentAbsoluteTime, handleSeek, showRipple]);

  // Auto-play Next Episode on end
  const handleEnded = useCallback(() => {
    // Only auto-play next if we actually reached near the end of the full duration (>95%)
    if (duration > 0 && timeRef.current / duration > 0.95) {
      if (autoPlayNext && nextEpisode) {
        handlePlayNextEpisode();
      }
    }
  }, [autoPlayNext, nextEpisode, handlePlayNextEpisode, duration]);

  // Audio track switch
  const handleSelectAudio = useCallback(
    async (audioIdx: number) => {
      setSelectedAudioIndex(audioIdx);

      // Smartly adjust default subtitle when switching audio track language
      let newMainSubId = selectedMainSubId;
      if (metadata) {
        const newAudio = metadata.audioTracks.find((t) => t.audioIndex === audioIdx);
        const isEng =
          newAudio &&
          (newAudio.language === 'eng' ||
            newAudio.language === 'en' ||
            /english|dub/i.test(newAudio.title));

        if (isEng) {
          // Switch to English Dubtitles / SDH
          const dubTrack = metadata.subtitleTracks.find(
            (s) =>
              (s.language === 'eng' || s.language === 'en') &&
              (s.isDubtitle || /sdh|dubtitle|hearing impaired/i.test(s.title)) &&
              !s.isSigns
          );
          if (dubTrack) {
            newMainSubId = dubTrack.id;
            setSelectedMainSubId(newMainSubId);
          }
        } else {
          // Switch to Japanese: choose English translation
          const transTrack = metadata.subtitleTracks.find(
            (s) =>
              (s.language === 'eng' || s.language === 'en') &&
              !s.isDubtitle &&
              !/sdh|dubtitle/i.test(s.title) &&
              !s.isSigns
          );
          if (transTrack) {
            newMainSubId = transTrack.id;
            setSelectedMainSubId(newMainSubId);
          }
        }
      }

      persistSeasonRule(audioIdx, newMainSubId, selectedTopSubId, topSubEnabled, syncOffset);

      const seq = ++seekSeqRef.current;
      try {
        const { url, actualStartTime } = await window.electronAPI.getStreamUrl(
          episode.filePath,
          audioIdx,
          timeRef.current
        );

        if (seq !== seekSeqRef.current) return;
        applyStream(url, actualStartTime, episode.filePath);
      } catch (err) {
        console.error('Failed to switch audio track:', err);
      }
    },
    [
      episode.filePath,
      metadata,
      selectedMainSubId,
      selectedTopSubId,
      topSubEnabled,
      syncOffset,
      persistSeasonRule,
      applyStream,
    ]
  );

  // Main subtitle switch
  const handleSelectMainSub = useCallback(
    (trackId: string | null) => {
      setSelectedMainSubId(trackId);
      persistSeasonRule(selectedAudioIndex, trackId, selectedTopSubId, topSubEnabled, syncOffset);
    },
    [selectedAudioIndex, selectedTopSubId, topSubEnabled, syncOffset, persistSeasonRule]
  );

  // Top subtitle switch
  const handleSelectTopSub = useCallback(
    (trackId: string | null) => {
      setSelectedTopSubId(trackId);
      const enabled = trackId !== null;
      setTopSubEnabled(enabled);
      persistSeasonRule(selectedAudioIndex, selectedMainSubId, trackId, enabled, syncOffset);
    },
    [selectedAudioIndex, selectedMainSubId, syncOffset, persistSeasonRule]
  );

  // 1-Click Top Sub Toggle
  const handleToggleTopSub = useCallback(() => {
    const nextState = !topSubEnabled;
    setTopSubEnabled(nextState);
    showRipple('sync', nextState ? 'Top Sub: ON' : 'Top Sub: OFF');
    persistSeasonRule(selectedAudioIndex, selectedMainSubId, selectedTopSubId, nextState, syncOffset);
  }, [topSubEnabled, selectedAudioIndex, selectedMainSubId, selectedTopSubId, syncOffset, persistSeasonRule]);

  // Sync Offset Change
  const handleUpdateSyncOffset = useCallback(
    (delta: number) => {
      const nextOffset = Math.round((syncOffset + delta) * 10) / 10;
      setSyncOffset(nextOffset);
      if (jassubRef.current) {
        jassubRef.current.timeOffset = streamStartTimeRef.current + nextOffset;
      }
      const syncLabel =
        nextOffset > 0
          ? `Sub Sync: +${nextOffset.toFixed(1)}s (earlier)`
          : nextOffset < 0
          ? `Sub Sync: ${nextOffset.toFixed(1)}s (later)`
          : 'Sub Sync: 0s';
      showRipple('sync', syncLabel);
      persistSeasonRule(selectedAudioIndex, selectedMainSubId, selectedTopSubId, topSubEnabled, nextOffset);
    },
    [syncOffset, selectedAudioIndex, selectedMainSubId, selectedTopSubId, topSubEnabled, persistSeasonRule]
  );

  // Subtitle Font Size Change (Live in-player & persisted)
  const handleUpdateFontSize = useCallback(
    (newSize: number) => {
      const clamped = Math.max(14, Math.min(newSize, 64));
      setFontSize(clamped);
      showRipple('sync', `Sub Size: ${clamped}px`);
      if (window.electronAPI) {
        window.electronAPI.updateSettings({ subtitlesFontSize: clamped }).catch(() => {});
      }
      onUpdateSettings?.({ subtitlesFontSize: clamped });
    },
    [showRipple, onUpdateSettings]
  );

  // Subtitle Styling Change (Live in-player & persisted)
  const handleUpdateSubtitleStyle = useCallback(
    (updates: {
      fontSize?: number;
      textColor?: string;
      fontFamily?: 'sans' | 'trebuchet' | 'rounded' | 'serif' | 'mono';
      bgStyle?: 'none' | 'translucent' | 'semi' | 'solid';
      outlineWidth?: 'thin' | 'medium' | 'thick' | 'heavy' | 'none';
      outlineColor?: string;
    }) => {
      if (updates.fontSize !== undefined) setFontSize(updates.fontSize);
      if (updates.textColor !== undefined) setTextColor(updates.textColor);
      if (updates.fontFamily !== undefined) setFontFamily(updates.fontFamily);
      if (updates.bgStyle !== undefined) setBgStyle(updates.bgStyle);
      if (updates.outlineWidth !== undefined) setOutlineWidth(updates.outlineWidth);
      if (updates.outlineColor !== undefined) setOutlineColor(updates.outlineColor);

      const partial: Partial<AppSettings> = {
        ...(updates.fontSize !== undefined && { subtitlesFontSize: updates.fontSize }),
        ...(updates.textColor !== undefined && { subtitlesTextColor: updates.textColor }),
        ...(updates.fontFamily !== undefined && { subtitlesFontFamily: updates.fontFamily }),
        ...(updates.bgStyle !== undefined && { subtitlesBgStyle: updates.bgStyle }),
        ...(updates.outlineWidth !== undefined && { subtitlesOutlineWidth: updates.outlineWidth }),
        ...(updates.outlineColor !== undefined && { subtitlesOutlineColor: updates.outlineColor }),
      };

      if (window.electronAPI) {
        window.electronAPI.updateSettings(partial).catch(() => {});
      }
      onUpdateSettings?.(partial);
    },
    [onUpdateSettings]
  );

  const handleResetSubtitleStyle = useCallback(() => {
    handleUpdateSubtitleStyle({
      fontSize: 38,
      textColor: '#ffffff',
      fontFamily: 'sans',
      bgStyle: 'none',
      outlineWidth: 'thick',
      outlineColor: '#000000',
    });
    showRipple('sync', 'Sub Style: Defaults Restored');
  }, [handleUpdateSubtitleStyle, showRipple]);

  // Keyboard Shortcuts: YouTube & Desktop Grade
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;

      switch (e.code) {
        case 'Space':
        case 'KeyK':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleSkip(5, '+5s');
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handleSkip(-5, '-5s');
          break;
        case 'KeyL':
          e.preventDefault();
          handleSkip(10, '+10s');
          break;
        case 'KeyJ':
          e.preventDefault();
          handleSkip(-10, '-10s');
          break;
        case 'KeyN':
          if (nextEpisode) {
            e.preventDefault();
            handlePlayNextEpisode();
          }
          break;
        case 'KeyS':
          e.preventDefault();
          if (detectedOpening && currentAbsoluteTime < detectedOpening.end) {
            handleSkipIntro();
          } else {
            showRipple('info', 'No opening detected');
          }
          break;
        case 'KeyE':
          e.preventDefault();
          setIsEpisodeDrawerOpen((prev) => !prev);
          setEpisodeDrawerOpenMode('button');
          break;
        case 'KeyF':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'KeyM':
          e.preventDefault();
          setIsMuted((prev) => {
            const next = !prev;
            if (videoRef.current) videoRef.current.muted = next;
            showRipple(next ? 'mute' : 'volume', next ? 'Muted' : 'Unmuted');
            return next;
          });
          break;
        case 'BracketLeft': // [
          e.preventDefault();
          handleUpdateSyncOffset(-0.5);
          break;
        case 'BracketRight': // ]
          e.preventDefault();
          handleUpdateSyncOffset(0.5);
          break;
        case 'Minus': // - or Shift + -
          e.preventDefault();
          handleUpdateFontSize(fontSize - 2);
          break;
        case 'Equal': // + or Shift + =
          e.preventDefault();
          handleUpdateFontSize(fontSize + 2);
          break;
        case 'Escape':
          if (isTrackControlsOpen) {
            setIsTrackControlsOpen(false);
          } else if (isEpisodeDrawerOpen) {
            setIsEpisodeDrawerOpen(false);
          } else {
            onClose();
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    togglePlay,
    handleSkip,
    toggleFullscreen,
    handleUpdateSyncOffset,
    handleUpdateFontSize,
    fontSize,
    isFullscreen,
    isTrackControlsOpen,
    isEpisodeDrawerOpen,
    nextEpisode,
    handlePlayNextEpisode,
    isIntroActive,
    handleSkipIntro,
    onClose,
  ]);

  // Controls are visible when mouse moves, or if video is paused, or while loading, or if a modal/drawer is open
  const areControlsVisible = showControls || !isPlaying || loading || isTrackControlsOpen || isEpisodeDrawerOpen;

  const handleVideoError = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    const mediaError = video.error;
    console.warn('[VideoPlayer] Video element error:', mediaError?.code, mediaError?.message);
  }, []);

  const handleContainerMouseMove = useCallback(() => {
    resetControlsTimer();
  }, [resetControlsTimer]);

  return (
    <div
      ref={containerRef}
      onMouseMove={handleContainerMouseMove}
      className={`fixed inset-0 z-50 w-screen h-screen bg-black overflow-hidden flex items-center justify-center select-none ${
        !areControlsVisible ? 'hide-cursor cursor-none' : ''
      }`}
    >
      {/* Native Video Element */}
      <video
        ref={videoRef}
        crossOrigin="anonymous"
        playsInline
        onLoadedData={() => setShowSeekFrame(false)}
        onTimeUpdate={() => {
          if (videoRef.current) {
            const elementTime = videoRef.current.currentTime;
            setVideoElementTime(elementTime);
            if (pendingSeekTargetRef.current === null) {
              timeRef.current = streamStartTimeRef.current + elementTime;
            }
          }
        }}
        onPlay={() => {
          setIsPlaying(true);
          if (jassubRef.current) {
            jassubRef.current.timeOffset = streamStartTimeRef.current + syncOffsetRef.current;
          }
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={handleEnded}
        onError={(event) => {
          setShowSeekFrame(false);
          handleVideoError(event);
        }}
        className="w-full h-full object-contain pointer-events-none bg-black"
        style={{
          transform: 'translateZ(0)',
          backfaceVisibility: 'hidden',
        }}
      />
      <canvas
        ref={seekFrameRef}
        aria-hidden="true"
        className={`absolute inset-0 z-[1] h-full w-full object-contain pointer-events-none ${showSeekFrame ? 'block' : 'hidden'}`}
      />

      {/* GPU Compositor Keep-Alive: ensures Chromium presents video frames even when UI is hidden & mouse is still */}
      <div className="compositor-keep-alive" aria-hidden="true" />

      {/* Instant Single-Click Play/Pause Surface */}
      {/* Clicking anywhere immediately pauses/plays with ZERO delay */}
      <div
        onClick={() => {
          togglePlay();
          resetControlsTimer();
        }}
        onDoubleClick={toggleFullscreen}
        className={`absolute inset-0 z-10 ${
          areControlsVisible ? 'cursor-default' : 'cursor-none'
        }`}
      />

      {/* Dual Subtitles Overlay (Top Signs & Bottom Dialogue) */}
      <SubtitleOverlay
        currentTime={currentAbsoluteTime}
        mainCues={isMainAssActive && jassubRef.current ? [] : mainCues}
        topCues={isTopAssActive && jassubRef.current ? [] : topCues}
        topSubEnabled={topSubEnabled}
        syncOffset={syncOffset}
        fontSize={fontSize}
        textColor={textColor}
        fontFamily={fontFamily}
        bgStyle={bgStyle}
        outlineWidth={outlineWidth}
        outlineColor={outlineColor}
        hasOutline={true}
        controlsVisible={areControlsVisible}
      />

      {/* YouTube Style Animated Seeking Ripple */}
      <RippleIndicator type={ripple?.type} text={ripple?.text} />

      {/* Loading Spinner */}
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-30 pointer-events-none">
          <div className="w-12 h-12 rounded-full border-4 border-red-600/30 border-t-red-600 animate-spin mb-3" />
          <span className="text-xs font-semibold text-zinc-300 tracking-wide">
            Preparing 10-bit Video Stream...
          </span>
        </div>
      )}

      {/* Top Header Controls Bar (Auto-hiding) */}
      <div
        className={`absolute top-0 left-0 right-0 p-6 bg-gradient-to-b from-black/90 via-black/50 to-transparent flex items-center justify-between z-40 transition-opacity duration-300 ${
          areControlsVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-center space-x-4 flex-1 min-w-0 mr-4">
          <button
            onClick={onClose}
            className="p-2 rounded-xl bg-black/60 hover:bg-black/80 text-zinc-200 hover:text-white border border-white/10 transition-all hover:scale-105 shrink-0"
            aria-label="Back to Library [Esc]"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-start sm:items-center space-x-2.5 min-w-0">
              <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-600 text-white shrink-0 mt-0.5 sm:mt-0">
                {parsed.episodeLabel || episode.episodeNumber}
              </span>
              <h1
                className="text-sm md:text-base font-bold text-white tracking-tight line-clamp-2 flex-1 min-w-0 break-words leading-tight"
                title={fullPlayerTitle}
              >
                {fullPlayerTitle}
              </h1>
            </div>
          </div>
        </div>

        {/* Right side of top navbar: only subtle Subtitle Loading Spinner if active */}
        {subtitlesLoading && (
          <div className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-indigo-500/20 border border-indigo-500/40 text-xs text-indigo-300 backdrop-blur-md animate-pulse shrink-0">
            <div className="w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            <span>Loading Subtitles...</span>
          </div>
        )}
      </div>

      {/* Bottom Player Controls Bar (Auto-hiding) */}
      <div
        onMouseMove={(e) => {
          resetControlsTimer();
          e.stopPropagation();
        }}
        className={`absolute bottom-0 left-0 right-0 pt-16 pb-6 px-6 bg-gradient-to-t from-black/90 via-black/60 to-transparent flex flex-col space-y-3 z-40 transition-opacity duration-300 ${
          areControlsVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Seekbar Scrubber with Hover Thumbnail Previews */}
        <TimelineScrubber
          currentTime={currentAbsoluteTime}
          duration={duration}
          filePath={episode.filePath}
          serverPort={serverPortRef.current}
          onSeek={handleSeek}
          openingRange={detectedOpening}
        />

        {/* Action Controls Toolbar */}
        <div className="flex items-center justify-between">
          {/* Left: Play/Pause, Next Episode, Volume, Time */}
          <div className="flex items-center space-x-3 sm:space-x-4">
            <button
              onClick={togglePlay}
              className="p-2 rounded-xl text-white hover:text-red-500 transition-colors"
              aria-label={isPlaying ? 'Pause [Space]' : 'Play [Space]'}
            >
              {isPlaying ? <Pause className="w-6 h-6 fill-white" /> : <Play className="w-6 h-6 fill-white" />}
            </button>

            {/* Next Episode Button [N] */}
            <button
              onClick={handlePlayNextEpisode}
              disabled={!nextEpisode}
              className={`p-2 rounded-xl transition-all ${
                nextEpisode
                  ? 'text-zinc-300 hover:text-white hover:bg-white/10 active:scale-95 cursor-pointer'
                  : 'text-zinc-600 opacity-25 cursor-not-allowed'
              }`}
              title={
                nextEpisode
                  ? `Next Episode: ${formatEpisodeDisplayTitle(nextEpisode)} [N]`
                  : 'Last Episode of Season'
              }
              aria-label="Next Episode [N]"
            >
              <SkipForward className="w-5 h-5 fill-current" />
            </button>

            {/* Volume Control */}
            <div className="flex items-center space-x-2 group/vol">
              <button
                onClick={() => {
                  const nextMute = !isMuted;
                  setIsMuted(nextMute);
                  if (videoRef.current) videoRef.current.muted = nextMute;
                }}
                className="p-1.5 rounded-lg text-zinc-300 hover:text-white transition-colors"
                aria-label="Mute [M]"
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-5 h-5 text-red-400" />
                ) : (
                  <Volume2 className="w-5 h-5" />
                )}
              </button>

              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setVolume(val);
                  setIsMuted(false);
                  if (videoRef.current) {
                    videoRef.current.volume = val;
                    videoRef.current.muted = false;
                  }
                }}
                className="w-16 h-1 accent-red-600 bg-zinc-700 rounded-lg cursor-pointer opacity-75 group-hover/vol:opacity-100 transition-opacity"
              />
            </div>

            {/* Current / Total Duration */}
            <div className="text-xs font-mono font-medium text-zinc-300">
              <span>{formatTime(currentAbsoluteTime)}</span>
              <span className="text-zinc-500 mx-1.5">/</span>
              <span className="text-zinc-400">{formatTime(duration)}</span>
            </div>
          </div>

          {/* Right: Episodes, Audio & Subtitles, Fullscreen */}
          <div className="flex items-center space-x-3">
            {/* Episodes Drawer Toggle Button */}
            <button
              onClick={() => {
                setEpisodeDrawerOpenMode('button');
                setIsEpisodeDrawerOpen((prev) => !prev);
              }}
              className="flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200 hover:text-white border border-white/15 text-xs font-medium transition-all shadow-sm cursor-pointer"
              aria-label="Episodes (E)"
              title="Episodes (E)"
            >
              <ListVideo className="w-3.5 h-3.5 text-red-500" />
              <span>Episodes</span>
            </button>

            {/* Audio & Subtitles Menu (formerly in top bar) */}
            <button
              onClick={() => setIsTrackControlsOpen(true)}
              className="flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200 hover:text-white border border-white/15 text-xs font-medium transition-all shadow-sm cursor-pointer"
              aria-label="Configure Audio Tracks & Subtitles"
              title="Audio & Subtitles"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-400" />
              <span>Audio & Subtitles</span>
            </button>

            {/* Fullscreen Button */}
            <button
              onClick={toggleFullscreen}
              className="p-2 rounded-xl text-zinc-300 hover:text-white transition-colors cursor-pointer"
              aria-label={isFullscreen ? 'Exit Fullscreen [F]' : 'Fullscreen [F]'}
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Floating Skip Intro / Opening Prompt Card (Netflix / Crunchyroll style) */}
      {isIntroActive && detectedOpening && (
        <div
          className={`absolute left-6 z-40 transition-all duration-300 flex items-center select-none pointer-events-auto ${
            areControlsVisible ? 'bottom-32 opacity-100 translate-y-0' : 'bottom-16 opacity-90 hover:opacity-100 translate-y-0'
          }`}
        >
          <div className="bg-zinc-950/90 hover:bg-zinc-900/95 backdrop-blur-2xl border border-white/20 p-2 pl-3.5 pr-2.5 rounded-2xl shadow-2xl flex items-center space-x-2.5 transition-all group hover:border-red-500/50 hover:shadow-red-500/10">
            <button
              onClick={handleSkipIntro}
              className="flex items-center space-x-2 text-white font-bold text-xs group-hover:text-red-400 transition-colors"
              title="Skip Opening Theme [S]"
            >
              <FastForward className="w-4 h-4 text-red-500 fill-red-500 group-hover:scale-110 transition-transform" />
              <span>
                {`Skip Opening (${formatTime(detectedOpening.end)})`}
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-white/10 text-zinc-300 border border-white/10 font-mono">
                S
              </span>
            </button>
            <button
              onClick={() => setIsIntroDismissed(true)}
              className="p-1 rounded-lg text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Dismiss"
              aria-label="Dismiss Skip Opening"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Floating Next Episode / Skip Ending Prompt Card */}
      {isEndingActive && nextEpisode && (() => {
        const nextEpNum = (() => {
          const p = parseReleaseCore(nextEpisode.fileName);
          return p.episodeNumber ?? p.episodeNumbers[0] ?? (nextEpisode.episodeNumber ? parseInt(nextEpisode.episodeNumber.replace(/\D/g, ''), 10) : null);
        })();
        const nextRemote = nextEpNum !== null && Number.isFinite(nextEpNum) ? remoteEpisodes.get(nextEpNum) : undefined;
        const nextThumbnail = nextRemote?.thumbnailUrl || nextEpisode.kitsuThumbnail || nextEpisode.thumbnailUrl;
        const nextOfficialTitle = nextRemote?.title || nextEpisode.kitsuTitle || nextEpisode.episodeTitle;
        const nextTitle = formatEpisodeDisplayTitle(nextEpisode, nextOfficialTitle);

        return (
          <div
            className={`absolute right-6 z-40 bg-zinc-950/95 backdrop-blur-2xl border border-white/15 p-3.5 rounded-2xl shadow-2xl flex items-center space-x-3.5 animate-in slide-in-from-bottom-4 transition-all duration-300 ${
              areControlsVisible ? 'bottom-32' : 'bottom-16'
            }`}
          >
            <div className="w-16 sm:w-20 aspect-video rounded-xl overflow-hidden shrink-0 bg-black border border-white/10 relative">
              {nextThumbnail ? (
                <img
                  src={nextThumbnail}
                  alt={nextTitle}
                  className="w-full h-full object-cover"
                />
              ) : (
                <img
                  src={PLACEHOLDER_EPISODE_IMAGE}
                  alt={nextTitle}
                  className="w-full h-full object-cover"
                />
              )}
            </div>

            <div className="min-w-0 pr-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-red-500">Next Episode</span>
              <p className="text-xs font-bold text-white max-w-[200px] truncate" title={nextTitle}>
                {nextTitle}
              </p>
            </div>

            <button
              onClick={handlePlayNextEpisode}
              className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center space-x-1.5 shadow-lg shadow-red-600/30 transition-all hover:scale-105 active:scale-95 shrink-0"
            >
              <span>Play Next</span>
              <SkipForward className="w-3.5 h-3.5 fill-white" />
            </button>

            <button
              onClick={() => setIsEndingCardDismissed(true)}
              className="p-1 rounded-lg text-zinc-500 hover:text-zinc-300 transition-colors"
              aria-label="Dismiss Next Episode Prompt"
              title="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })()}

      {/* Right Edge Magnetic Peek Arc (Organic elastic curve following cursor & snapping open) */}
      <MagneticEpisodePeek
        isOpen={isEpisodeDrawerOpen}
        onOpen={() => {
          setEpisodeDrawerOpenMode('edge');
          setIsEpisodeDrawerOpen(true);
        }}
        areControlsVisible={areControlsVisible}
        episodeCount={seasonEpisodes.length}
        onActivity={resetControlsTimer}
      />

      {/* Track Controls Popover (Tracks & Audio + Modern Subtitle Styling Customizer) */}
      <TrackControls
        isOpen={isTrackControlsOpen}
        onClose={() => setIsTrackControlsOpen(false)}
        audioTracks={metadata?.audioTracks || []}
        subtitleTracks={metadata?.subtitleTracks || []}
        selectedAudioIndex={selectedAudioIndex}
        onSelectAudio={handleSelectAudio}
        selectedMainSubId={selectedMainSubId}
        onSelectMainSub={handleSelectMainSub}
        selectedTopSubId={selectedTopSubId}
        onSelectTopSub={handleSelectTopSub}
        topSubEnabled={topSubEnabled}
        onToggleTopSub={handleToggleTopSub}
        syncOffset={syncOffset}
        onUpdateSyncOffset={handleUpdateSyncOffset}
        onResetSyncOffset={() => handleUpdateSyncOffset(-syncOffset)}
        fontSize={fontSize}
        onUpdateFontSize={handleUpdateFontSize}
        textColor={textColor}
        onUpdateTextColor={(col) => handleUpdateSubtitleStyle({ textColor: col })}
        fontFamily={fontFamily}
        onUpdateFontFamily={(font) => handleUpdateSubtitleStyle({ fontFamily: font })}
        bgStyle={bgStyle}
        onUpdateBgStyle={(bg) => handleUpdateSubtitleStyle({ bgStyle: bg })}
        outlineWidth={outlineWidth}
        onUpdateOutlineWidth={(w) => handleUpdateSubtitleStyle({ outlineWidth: w })}
        outlineColor={outlineColor}
        onUpdateOutlineColor={(c) => handleUpdateSubtitleStyle({ outlineColor: c })}
        onResetSubtitleStyle={handleResetSubtitleStyle}
      />

      {/* Episode Drawer (In-Player Switcher) */}
      <EpisodeDrawer
        isOpen={isEpisodeDrawerOpen}
        onClose={() => setIsEpisodeDrawerOpen(false)}
        closeOnBackdrop={episodeDrawerOpenMode === 'button'}
        closeOnMouseLeave={episodeDrawerOpenMode === 'edge'}
        episodes={seasonEpisodes}
        currentEpisode={episode}
        history={history}
        autoPlayNext={autoPlayNext}
        onToggleAutoPlayNext={() => setAutoPlayNext((prev) => !prev)}
        onSelectEpisode={(newEp) => {
          const saved = history[newEp.filePath];
          const resumeTime = saved?.currentTime && !saved.completed ? saved.currentTime : 0;
          onEpisodeChange(newEp, resumeTime);
        }}
        animeTitle={effectiveAnimeTitle}
        folderPath={folderPath}
        anilistId={anilistId}
        remoteEpisodes={remoteEpisodes}
      />

      {/* Playback Error Overlay */}
      {playbackError && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 p-6 animate-in fade-in duration-150">
          <div className="max-w-md p-6 rounded-2xl bg-zinc-900 border border-zinc-800 text-center space-y-4 shadow-2xl">
            <AlertCircle className="w-10 h-10 text-amber-400 mx-auto" />
            <h3 className="text-base font-bold text-white">Playback Error</h3>
            <p className="text-xs text-zinc-300 leading-relaxed">{playbackError}</p>
            <div className="pt-2">
              <button
                onClick={onClose}
                className="px-5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-zinc-100 border border-white/10 transition-colors"
              >
                Back to Library
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
