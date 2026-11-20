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
import { formatTime, cleanEpisodeTitle, cleanSeriesTitle, formatEpisodeDisplayTitle, isFolderMovie } from '../../utils/format';
import { parseReleaseCore } from '../../lib/releaseParser/regexEngine';
import { PLACEHOLDER_EPISODE_IMAGE } from '../../utils/assets';
import { isSyntheticMouseMove, markSyntheticMouseMove } from '../../utils/cursorSync';
import { isTopSignsCandidate, isAllowedSignsLanguage } from '../../../electron/assSignsExtractor';

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

  const episodeHeading = useMemo(
    () => formatEpisodeDisplayTitle(parsed.displayTitle, episode.kitsuTitle || episode.episodeTitle),
    [parsed.displayTitle, episode.kitsuTitle, episode.episodeTitle]
  );

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
  const explicitTopSubOffRef = useRef<boolean>(false);
  const autoTriedSignsPathsRef = useRef<Set<string>>(new Set());
  const activeEpisodePathRef = useRef<string>(episode.filePath);
  activeEpisodePathRef.current = episode.filePath;

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
  const partialWindowRef = useRef<{
    main?: { fromMs: number; toMs: number };
    top?: { fromMs: number; toMs: number };
  }>({});
  const seekWindowHandlerRef = useRef<((seekSec: number) => void) | null>(null);

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
  const [isTimelinePreviewVisible, setIsTimelinePreviewVisible] = useState<boolean>(false);
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

  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    };
  }, [resetControlsTimer]);

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
              // External Whisper / dialogue SRT track: prefer dubtitle, never auto-pick signs-only tracks
              const ext =
                meta.subtitleTracks.find((s) => s.type === 'external' && s.isDubtitle && !s.isSigns) ||
                meta.subtitleTracks.find((s) => s.type === 'external' && !s.isSigns && !s.isForced);
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
          const extSub = meta.subtitleTracks.find((s) => s.type === 'external' && !s.isSigns && !s.isForced);
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
        // Strictly filter for English/non-verbal Forced/Signs tracks. NEVER auto-select foreign languages!
        let topSubId: string | null = null;
        let topEnabled = false;

        if (seasonPref && 'topSubtitleTrackId' in seasonPref && seasonPref.topSubtitleTrackId !== undefined) {
          if (seasonPref.topSubtitleTrackId === null) {
            explicitTopSubOffRef.current = true;
            topSubId = null;
            topEnabled = false;
          } else {
            explicitTopSubOffRef.current = false;
            const exactTop = meta.subtitleTracks.find((s) => s.id === seasonPref.topSubtitleTrackId);
            if (exactTop) {
              topSubId = exactTop.id;
              topEnabled = seasonPref.topSubEnabled;
            } else if (seasonPref.topSubtitleTrackId.startsWith('ext-')) {
              const extSigns =
                meta.subtitleTracks.find((s) => s.type === 'external' && isTopSignsCandidate(s, mainSubId)) ||
                meta.subtitleTracks.find((s) => isTopSignsCandidate(s, mainSubId));
              if (extSigns) {
                topSubId = extSigns.id;
                topEnabled = seasonPref.topSubEnabled;
              }
            } else {
              const engSigns = meta.subtitleTracks.find((s) => isTopSignsCandidate(s, mainSubId));
              if (engSigns) {
                topSubId = engSigns.id;
                topEnabled = seasonPref.topSubEnabled;
              }
            }
          }
        } else {
          explicitTopSubOffRef.current = false;
          const selectedMain = meta.subtitleTracks.find((s) => s.id === mainSubId);
          const isMainFull = selectedMain && /full|all/i.test(selectedMain.title);

          const engSigns = meta.subtitleTracks.find((s) => isTopSignsCandidate(s, mainSubId));
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
    let refreshTimerId: number | null = null;
    let windowSeekSeq = 0;

    const getAbsolutePositionSec = () => {
      const video = videoRef.current;
      const fromTimeRef = Number.isFinite(timeRef.current) ? timeRef.current : -1;
      if (fromTimeRef >= 0) return Math.floor(fromTimeRef);
      return Math.max(0, Math.floor(streamStartTimeRef.current + (video?.currentTime || 0)));
    };

    const applyExtractedSubtitles = async (
      mainRes: Awaited<ReturnType<typeof window.electronAPI.extractSubtitleTrack>> | null,
      topRes: Awaited<ReturnType<typeof window.electronAPI.extractSubtitleTrack>> | null,
      isFullResult: boolean
    ) => {
      if (isCancelled || !metadata) return;

      const video = videoRef.current;
      const port = serverPortRef.current;

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

      partialWindowRef.current = isFullResult
        ? {}
        : {
            ...(mainRes?.partial ? { main: mainRes.partial } : {}),
            ...(topRes?.partial ? { top: topRes.partial } : {}),
          };

      setLoadedAssContent(assContent);
      setMainCues(newMainCues);
      setTopCues(newTopCues);
      setSubtitlesLoading(false);

      const effectivePort = mainRes?.port || topRes?.port || serverPortRef.current || port;
      if (effectivePort) serverPortRef.current = effectivePort;

      // Skip recreating JASSUB if only plain text / PGS bitmap cues are active
      const hasValidAss = Boolean(
        assContent &&
        assContent.trim().length > 50 &&
        /\[Events\]/i.test(assContent)
      );

      if (jassubRef.current) {
        try {
          await jassubRef.current.destroy();
        } catch {}
        jassubRef.current = null;
      }

      if (isCancelled) return;

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
    };

    async function loadSubtitles(isRefresh = false, overridePosSec?: number) {
      // Do not leave the previous episode's cues visible while the next
      // episode's subtitle track is being extracted and parsed. A refresh
      // (swapping a partial window for the full track) keeps the current
      // cues on screen to avoid a subtitle flicker mid-playback.
      if (!isRefresh && overridePosSec === undefined) {
        setMainCues([]);
        setTopCues([]);
        setLoadedAssContent('');
        setIsMainAssActive(false);
        setIsTopAssActive(false);
        partialWindowRef.current = {};
      }
      if (!metadata || metadata.filePath !== episode.filePath) {
        setSubtitlesLoading(true);
        return;
      }

      const mainTrack = metadata.subtitleTracks.find((s) => s.id === selectedMainSubId);
      const topTrack = topSubEnabled ? metadata.subtitleTracks.find((s) => s.id === selectedTopSubId) : null;

      if (!isRefresh && overridePosSec === undefined) setSubtitlesLoading(true);

      // The first (cold) extraction of an embedded track streams the whole
      // MKV through ffmpeg — 15-40s on a large file on an HDD. Passing the
      // playback position makes the main process extract a ~2-minute window
      // around it first (0.2-2s) and keeps building the full track in the
      // background; the follow-up forceFull request swaps in the complete set.
      const posSec = overridePosSec ?? getAbsolutePositionSec();
      const mySeq = ++windowSeekSeq;

      try {
        const [mainRes, topRes] = await Promise.all([
          mainTrack
            ? window.electronAPI.extractSubtitleTrack(
                metadata.filePath,
                mainTrack.id,
                mainTrack.index,
                mainTrack.type === 'external',
                mainTrack.filePath,
                isRefresh ? undefined : posSec,
                isRefresh
              )
            : Promise.resolve(null),
          topTrack && topSubEnabled
            ? window.electronAPI.extractSubtitleTrack(
                metadata.filePath,
                topTrack.id,
                topTrack.index,
                topTrack.type === 'external',
                topTrack.filePath,
                isRefresh ? undefined : posSec,
                isRefresh
              )
            : Promise.resolve(null),
        ]);

        if (isCancelled) return;

        // If a seek-window fetch finishes AFTER full extraction already landed,
        // do not downgrade full tracks back to a partial window.
        if (overridePosSec !== undefined && !partialWindowRef.current.main && !partialWindowRef.current.top) {
          return;
        }
        if (overridePosSec !== undefined && mySeq !== windowSeekSeq) {
          return;
        }

        const hasPartial = Boolean(mainRes?.partial || topRes?.partial);
        await applyExtractedSubtitles(mainRes, topRes, isRefresh || !hasPartial);

        if (isCancelled) return;

        // Schedule full background extraction once after the initial window
        if (hasPartial && !isRefresh && overridePosSec === undefined) {
          refreshTimerId = window.setTimeout(() => {
            if (!isCancelled) void loadSubtitles(true);
          }, 1200);
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

    seekWindowHandlerRef.current = (seekSec: number) => {
      if (isCancelled) return;
      const bounds = partialWindowRef.current;
      if (!bounds.main && !bounds.top) return;
      const seekMs = seekSec * 1000;
      const outsideMain = bounds.main && (seekMs < bounds.main.fromMs || seekMs > bounds.main.toMs);
      const outsideTop = bounds.top && (seekMs < bounds.top.fromMs || seekMs > bounds.top.toMs);
      if (outsideMain || outsideTop) {
        void loadSubtitles(false, Math.max(0, Math.floor(seekSec)));
      }
    };

    void loadSubtitles();

    return () => {
      isCancelled = true;
      seekWindowHandlerRef.current = null;
      partialWindowRef.current = {};
      if (refreshTimerId !== null) {
        clearTimeout(refreshTimerId);
        refreshTimerId = null;
      }
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
      const effectiveTopSub =
        topSub === null && !explicitTopSubOffRef.current ? undefined : topSub;
      const pref: SeasonPreference = {
        preferredAudioLanguage: 'eng',
        preferredAudioIndex: audioIdx,
        mainSubtitleTrackId: mainSub,
        ...(effectiveTopSub !== undefined ? { topSubtitleTrackId: effectiveTopSub } : {}),
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
      seekWindowHandlerRef.current?.(clamped);

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
    showRipple('forward');
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
      showRipple('forward', 'Skipped');
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
      explicitTopSubOffRef.current = trackId === null;
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
    explicitTopSubOffRef.current = !nextState;
    setTopSubEnabled(nextState);
    showRipple('sync', nextState ? 'Top Sub: ON' : 'Top Sub: OFF');
    persistSeasonRule(selectedAudioIndex, selectedMainSubId, selectedTopSubId, nextState, syncOffset);
  }, [topSubEnabled, selectedAudioIndex, selectedMainSubId, selectedTopSubId, syncOffset, persistSeasonRule]);

  // Callback when a new external Signs or Main subtitle track is extracted/downloaded
  const handleSubtitleTrackAdded = useCallback(
    (updatedMeta: VideoMetadata, trackId: string, targetMode: 'signs' | 'main', statusMsg?: string) => {
      setMetadata(updatedMeta);
      if (targetMode === 'signs') {
        explicitTopSubOffRef.current = false;
        setSelectedTopSubId(trackId);
        setTopSubEnabled(true);
        persistSeasonRule(selectedAudioIndex, selectedMainSubId, trackId, true, syncOffset);
      } else {
        setSelectedMainSubId(trackId);
        persistSeasonRule(selectedAudioIndex, trackId, selectedTopSubId, topSubEnabled, syncOffset);
      }
      showRipple('sync', statusMsg || 'Subtitles Updated');
    },
    [selectedAudioIndex, selectedMainSubId, selectedTopSubId, topSubEnabled, syncOffset, persistSeasonRule, showRipple]
  );

  const handleSubtitleTrackAddedRef = useRef(handleSubtitleTrackAdded);
  handleSubtitleTrackAddedRef.current = handleSubtitleTrackAdded;

  // Automatic background Signs & Songs acquisition:
  // When no dedicated Signs/Forced track exists and the active Main Subtitle
  // is not already ASS/SSA (e.g., English Dub + Whisper SRT or no dialogue subs),
  // automatically extract Signs from an eligible embedded ASS track or fetch
  // high-confidence online Signs/ASS subtitles without interrupting playback.
  useEffect(() => {
    if (loading) return;
    if (!metadata || metadata.filePath !== episode.filePath) return;
    if (selectedTopSubId !== null) return;
    if (explicitTopSubOffRef.current) return;

    const activeMain = selectedMainSubId
      ? metadata.subtitleTracks.find((s) => s.id === selectedMainSubId) || null
      : null;
    if (
      activeMain &&
      (/^(ass|ssa)$/i.test((activeMain.codec || '').trim()) ||
        (activeMain.filePath && /\.(ass|ssa)$/i.test(activeMain.filePath)))
    ) {
      return;
    }

    const hasExistingSigns = metadata.subtitleTracks.some((s) =>
      isTopSignsCandidate(s, selectedMainSubId)
    );
    if (hasExistingSigns) return;

    if (autoTriedSignsPathsRef.current.has(episode.filePath)) return;

    const api = window.electronAPI;
    const extractSignsFn = api?.extractSignsFromEmbeddedSub;
    const searchOnlineFn = api?.searchOnlineSubtitles;
    const downloadOnlineFn = api?.downloadOnlineSubtitle;
    if (!extractSignsFn || !searchOnlineFn || !downloadOnlineFn) {
      return;
    }

    autoTriedSignsPathsRef.current.add(episode.filePath);
    let cancelled = false;
    const targetFile = episode.filePath;

    (async () => {
      try {
        // 1. Try local zero-latency Signs & Songs extraction from an embedded ASS/SSA track
        const embeddedAss =
          metadata.subtitleTracks.find(
            (s) =>
              s.type === 'embedded' &&
              s.index !== null &&
              /ass|ssa/i.test(s.codec || '') &&
              (s.language === 'eng' || s.language === 'en' || s.language === 'enm') &&
              !/commentary|notes/i.test(s.title || '')
          ) ||
          metadata.subtitleTracks.find(
            (s) =>
              s.type === 'embedded' &&
              s.index !== null &&
              /ass|ssa/i.test(s.codec || '') &&
              isAllowedSignsLanguage(s.language)
          );

        if (embeddedAss && embeddedAss.index !== null) {
          const extractRes = await extractSignsFn({
            filePath: targetFile,
            trackIndex: embeddedAss.index,
          });
          if (
            cancelled ||
            explicitTopSubOffRef.current ||
            activeEpisodePathRef.current !== targetFile
          ) {
            return;
          }
          if (extractRes?.success && extractRes.metadata && extractRes.trackId) {
            handleSubtitleTrackAddedRef.current(
              extractRes.metadata,
              extractRes.trackId,
              'signs',
              typeof extractRes.keptCuesCount === 'number'
                ? `Signs Auto-Extracted (${extractRes.keptCuesCount})`
                : 'Signs & Songs Auto-Extracted'
            );
            return;
          }
        }

        // 2. Fallback to high-confidence online Signs / ASS match (TsukiHime + optional keys)
        const searchRes = await searchOnlineFn({
          filePath: targetFile,
          folderPath,
          animeTitle: effectiveAnimeTitle || undefined,
          anilistId: anilistId ?? folder?.anilistId ?? null,
          mode: 'signs',
        });
        if (
          cancelled ||
          explicitTopSubOffRef.current ||
          activeEpisodePathRef.current !== targetFile
        ) {
          return;
        }

        const bestOnline = (searchRes?.results || []).find(
          (r) => (r.format === 'ass' || r.format === 'ssa') && r.matchScore >= 140
        );
        if (!bestOnline) return;

        const dlRes = await downloadOnlineFn({
          filePath: targetFile,
          result: bestOnline,
          targetMode: 'signs',
          extractSignsOnly: !bestOnline.isSignsOnly,
        });
        if (
          cancelled ||
          explicitTopSubOffRef.current ||
          activeEpisodePathRef.current !== targetFile
        ) {
          return;
        }

        if (dlRes?.success && dlRes.metadata && dlRes.trackId) {
          handleSubtitleTrackAddedRef.current(
            dlRes.metadata,
            dlRes.trackId,
            'signs',
            `Signs Auto-Loaded (${bestOnline.providerLabel})`
          );
        }
      } catch {
        // Auto-acquisition must fail silently so playback is never interrupted
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    loading,
    metadata,
    episode.filePath,
    folderPath,
    effectiveAnimeTitle,
    anilistId,
    folder?.anilistId,
    selectedTopSubId,
    selectedMainSubId,
  ]);

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
  const areBottomControlsVisible = areControlsVisible && !isEpisodeDrawerOpen;
  const shouldYieldFloatingPrompts = isTimelinePreviewVisible && areBottomControlsVisible;
  const areControlsVisibleRef = useRef(areControlsVisible);
  areControlsVisibleRef.current = areControlsVisible;
  const prevControlsVisibleRef = useRef(areControlsVisible);
  const cursorRefreshTimersRef = useRef<number[]>([]);
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);

  const clearScheduledCursorRefresh = useCallback(() => {
    for (const id of cursorRefreshTimersRef.current) {
      window.clearTimeout(id);
    }
    cursorRefreshTimersRef.current = [];
    if (containerRef.current) {
      delete containerRef.current.dataset.cursorRefresh;
    }
  }, []);

  const refreshHiddenCursor = useCallback(() => {
    if (areControlsVisibleRef.current) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const container = containerRef.current;
    if (!container) return;

    // Cycle cursor default -> none + synthetic hit-test so Chromium/Windows drops
    // stale arrow cursors after Alt-Tab or minimize/restore without mouse movement.
    container.dataset.cursorRefresh = 'true';
    markSyntheticMouseMove(160);
    window.electronAPI?.syncPlayerCursor?.();

    const restoreTimer = window.setTimeout(() => {
      const el = containerRef.current;
      if (!el) return;
      delete el.dataset.cursorRefresh;
      if (!areControlsVisibleRef.current && document.visibilityState === 'visible' && document.hasFocus()) {
        markSyntheticMouseMove(160);
        window.electronAPI?.syncPlayerCursor?.();
      }
    }, 16);
    cursorRefreshTimersRef.current.push(restoreTimer);
  }, []);

  const scheduleHiddenCursorSync = useCallback(() => {
    clearScheduledCursorRefresh();
    if (areControlsVisibleRef.current) return;
    refreshHiddenCursor();
    cursorRefreshTimersRef.current.push(
      window.setTimeout(refreshHiddenCursor, 60),
      window.setTimeout(refreshHiddenCursor, 180),
    );
  }, [clearScheduledCursorRefresh, refreshHiddenCursor]);

  useEffect(() => {
    const wasVisible = prevControlsVisibleRef.current;
    prevControlsVisibleRef.current = areControlsVisible;
    if (wasVisible && !areControlsVisible) {
      scheduleHiddenCursorSync();
    } else if (areControlsVisible) {
      clearScheduledCursorRefresh();
    }
  }, [areControlsVisible, scheduleHiddenCursorSync, clearScheduledCursorRefresh]);

  useEffect(() => {
    const handleRestore = () => {
      if (!areControlsVisibleRef.current) {
        scheduleHiddenCursorSync();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !areControlsVisibleRef.current) {
        scheduleHiddenCursorSync();
      }
    };

    window.addEventListener('focus', handleRestore);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const unsubRestore = window.electronAPI?.onWindowFocusRestored?.(handleRestore);

    return () => {
      window.removeEventListener('focus', handleRestore);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubRestore?.();
      clearScheduledCursorRefresh();
    };
  }, [scheduleHiddenCursorSync, clearScheduledCursorRefresh]);

  const handleVideoError = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    const mediaError = video.error;
    console.warn('[VideoPlayer] Video element error:', mediaError?.code, mediaError?.message);
  }, []);

  const handleContainerMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (isSyntheticMouseMove()) {
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };
      return;
    }
    const prev = lastMousePosRef.current;
    if (prev && prev.x === e.clientX && prev.y === e.clientY) {
      return;
    }
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
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

      {/* Loading State: blurred thumbnail backdrop, episode title and a
          crimson-magenta pulsing loader (replaces the plain black screen). */}
      {loading && (
        <div className="absolute inset-0 z-30 overflow-hidden pointer-events-none flex flex-col items-center justify-center">
          <img
            src={episode.kitsuThumbnail || episode.thumbnailUrl || PLACEHOLDER_EPISODE_IMAGE}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full scale-110 object-cover opacity-30 blur-3xl saturate-150"
          />
          <div className="absolute inset-0 bg-black/45" />
          <div className="relative flex flex-col items-center px-6 text-center">
            <div className="relative mb-4 h-14 w-14">
              <span className="loader-pulse absolute inset-0 rounded-full border-2 border-rose-500/25" />
              <span className="loader-pulse absolute inset-0 rounded-full border-2 border-transparent border-t-rose-500 border-r-rose-400/70" style={{ animationDelay: '150ms' }} />
              <span className="loader-pulse absolute inset-[10px] rounded-full bg-rose-500/20" style={{ animationDelay: '300ms' }} />
            </div>
            <p className="text-sm font-semibold text-white tracking-tight" title={fullPlayerTitle}>
              {episodeHeading || fullPlayerTitle}
            </p>
          </div>
        </div>
      )}

      {/* Top Header Controls Bar (Auto-hiding) */}
      <div
        className={`absolute top-0 left-0 right-0 px-6 pt-5 pb-6 bg-gradient-to-b from-black/45 via-black/15 to-transparent flex items-center justify-between z-40 transition-opacity duration-300 ${
          !isFullscreen ? '[-webkit-app-region:drag]' : ''
        } ${
          areControlsVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-center space-x-3 flex-1 min-w-0 mr-4">
          <button
            onClick={onClose}
            className="h-9 w-9 rounded-full bg-[#0b0912]/60 hover:bg-[#0b0912]/80 backdrop-blur-md border border-white/[0.12] hover:border-white/[0.22] flex items-center justify-center text-zinc-200 hover:text-white transition-all duration-200 shadow-[0_8px_24px_rgba(0,0,0,0.45)] shrink-0 [-webkit-app-region:no-drag]"
            aria-label="Back to Library [Esc]"
          >
            <ArrowLeft className="w-[18px] h-[18px]" />
          </button>

          <div className="inline-flex flex-col justify-center rounded-2xl bg-[#0b0912]/60 backdrop-blur-md border border-white/[0.1] px-4 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.45)] max-w-[min(72vw,680px)] min-w-0">
            {effectiveAnimeTitle && (
              <p className="text-[11px] font-medium text-white/60 tracking-wide truncate">
                {effectiveAnimeTitle}
              </p>
            )}
            <h1
              className="text-sm sm:text-[15px] font-semibold text-white/95 tracking-tight truncate drop-shadow-sm"
              title={fullPlayerTitle}
            >
              {episodeHeading || fullPlayerTitle}
            </h1>
          </div>
        </div>

        {/* Right side of top navbar: subtle Subtitle Loading Pill if active */}
        {subtitlesLoading && (
          <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-[#0b0912]/60 border border-white/[0.1] text-[11px] font-medium text-zinc-200 backdrop-blur-md shadow-[0_8px_24px_rgba(0,0,0,0.45)] shrink-0">
            <div className="w-3 h-3 border-2 border-rose-400 border-t-transparent rounded-full animate-spin" />
            <span>Subtitles</span>
          </div>
        )}
      </div>

      {/* Bottom HUD (Auto-hiding). Individual frosted-glass pills over a light gradient. */}
      <div
        onMouseMove={(e) => {
          if (isSyntheticMouseMove()) return;
          resetControlsTimer();
          e.stopPropagation();
        }}
        className={`absolute bottom-0 left-0 right-0 z-40 px-6 pb-5 pt-8 bg-gradient-to-t from-black/60 via-black/15 to-transparent transition-all duration-300 ease-fluid ${
          areControlsVisible && !isEpisodeDrawerOpen ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-3 pointer-events-none'
        }`}
      >
        <div className="flex flex-col space-y-2.5">
        {/* Seekbar Scrubber with Hover Thumbnail Previews */}
        <TimelineScrubber
          currentTime={currentAbsoluteTime}
          duration={duration}
          filePath={episode.filePath}
          serverPort={serverPortRef.current}
          onSeek={handleSeek}
          openingRange={detectedOpening}
          controlsVisible={areBottomControlsVisible}
          onPreviewVisibilityChange={setIsTimelinePreviewVisible}
        />

        {/* Action Controls Toolbar */}
        <div className="flex items-center justify-between">
          {/* Left: Playback, Volume & Time frosted pill */}
          <div className="inline-flex items-center space-x-1.5 sm:space-x-2 rounded-full border border-white/[0.1] bg-[#0b0912]/60 px-2.5 py-1 backdrop-blur-md shadow-[0_8px_28px_rgba(0,0,0,0.5)]">
            <button
              onClick={togglePlay}
              className="h-8 w-8 rounded-full flex items-center justify-center text-white hover:bg-white/[0.1] active:scale-95 transition-all"
              aria-label={isPlaying ? 'Pause [Space]' : 'Play [Space]'}
            >
              {isPlaying ? <Pause className="w-[18px] h-[18px] fill-white" /> : <Play className="w-[18px] h-[18px] fill-white" />}
            </button>

            {/* Next Episode Button [N] */}
            <button
              onClick={handlePlayNextEpisode}
              disabled={!nextEpisode}
              className={`h-8 w-8 rounded-full flex items-center justify-center transition-all ${
                nextEpisode
                  ? 'text-zinc-300 hover:text-white hover:bg-white/[0.1] active:scale-95 cursor-pointer'
                  : 'text-zinc-600 opacity-25 cursor-not-allowed'
              }`}
              title={
                nextEpisode
                  ? `Next Episode: ${formatEpisodeDisplayTitle(nextEpisode)} [N]`
                  : 'Last Episode of Season'
              }
              aria-label="Next Episode [N]"
            >
              <SkipForward className="w-[17px] h-[17px] fill-current" />
            </button>

            {/* Volume Control */}
            <div className="flex items-center space-x-1.5 group/vol">
              <button
                onClick={() => {
                  const nextMute = !isMuted;
                  setIsMuted(nextMute);
                  if (videoRef.current) videoRef.current.muted = nextMute;
                }}
                className="h-8 w-8 rounded-full flex items-center justify-center text-zinc-300 hover:bg-white/[0.1] hover:text-white transition-colors"
                aria-label="Mute [M]"
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="w-[17px] h-[17px] text-rose-400" />
                ) : (
                  <Volume2 className="w-[17px] h-[17px]" />
                )}
              </button>

              <div className="relative w-[72px] h-6 flex items-center">
                <div className="w-full h-1 group-hover/vol:h-1.5 bg-white/[0.16] rounded-full overflow-hidden transition-all">
                  <div
                    className="h-full bg-white/90 group-hover/vol:bg-rose-400 rounded-full transition-colors"
                    style={{ width: `${(isMuted ? 0 : volume) * 100}%` }}
                  />
                </div>
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
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  aria-label="Volume"
                />
              </div>
            </div>

            <div className="h-3.5 w-px bg-white/[0.12] mx-0.5" />

            {/* Current / Total Duration */}
            <div className="text-xs font-mono tabular-nums font-medium text-white/90 px-1.5">
              <span>{formatTime(currentAbsoluteTime)}</span>
              <span className="text-white/25 mx-1.5">/</span>
              <span className="text-white/45">{formatTime(duration)}</span>
            </div>
          </div>

          {/* Right: Episodes, Subtitles, Fullscreen individual pills */}
          <div className="flex items-center space-x-2">
            {/* Episodes Drawer Toggle Button */}
            <button
              onClick={() => {
                setEpisodeDrawerOpenMode('button');
                setIsEpisodeDrawerOpen((prev) => !prev);
              }}
              className="flex items-center space-x-2 rounded-full border border-white/[0.1] bg-[#0b0912]/60 px-3.5 py-2 text-xs font-medium text-zinc-100 backdrop-blur-md shadow-[0_8px_28px_rgba(0,0,0,0.5)] transition-all cursor-pointer hover:border-white/[0.22] hover:bg-[#0b0912]/80 hover:text-white"
              aria-label="Episodes (E)"
              title="Episodes (E)"
            >
              <ListVideo className="w-3.5 h-3.5 text-red-500" />
              <span>Episodes</span>
            </button>

            {/* Audio & Subtitles Menu */}
            <button
              onClick={() => setIsTrackControlsOpen(true)}
              className="flex items-center space-x-2 rounded-full border border-white/[0.1] bg-[#0b0912]/60 px-3.5 py-2 text-xs font-medium text-zinc-100 backdrop-blur-md shadow-[0_8px_28px_rgba(0,0,0,0.5)] transition-all cursor-pointer hover:border-white/[0.22] hover:bg-[#0b0912]/80 hover:text-white"
              aria-label="Configure Audio Tracks & Subtitles"
              title="Audio & Subtitles"
            >
              <Subtitles className="w-3.5 h-3.5 text-rose-400" />
              <span>Subtitles</span>
            </button>

            {/* Fullscreen Button */}
            <button
              onClick={toggleFullscreen}
              className="h-9 w-9 rounded-full border border-white/[0.1] bg-[#0b0912]/60 flex items-center justify-center text-zinc-200 backdrop-blur-md shadow-[0_8px_28px_rgba(0,0,0,0.5)] transition-all cursor-pointer hover:border-white/[0.22] hover:bg-[#0b0912]/80 hover:text-white"
              aria-label={isFullscreen ? 'Exit Fullscreen [F]' : 'Fullscreen [F]'}
            >
              {isFullscreen ? <Minimize className="w-[18px] h-[18px]" /> : <Maximize className="w-[18px] h-[18px]" />}
            </button>
          </div>
        </div>
        </div>
      </div>

      {/* Floating Skip Intro / Opening Prompt Card */}
      {isIntroActive && detectedOpening && (
        <div
          aria-hidden={shouldYieldFloatingPrompts || undefined}
          className={`absolute left-6 transition-all flex items-center select-none animate-in fade-in slide-in-from-bottom-3 ${
            shouldYieldFloatingPrompts
              ? 'z-[35] bottom-28 opacity-0 translate-y-2 scale-[0.97] pointer-events-none duration-150'
              : `z-40 pointer-events-auto duration-300 ${
                  areBottomControlsVisible ? 'bottom-28 opacity-100 translate-y-0 scale-100' : 'bottom-10 opacity-90 hover:opacity-100 translate-y-0 scale-100'
                }`
          }`}
        >
          <div className="rounded-full border border-white/[0.12] bg-[#0b0912]/65 backdrop-blur-xl pl-4 pr-2 py-1.5 shadow-2xl flex items-center space-x-2 hover:border-rose-400/45 hover:bg-[#140e1f]/80 transition-all group">
            <button
              onClick={handleSkipIntro}
              className="flex items-center space-x-2 text-white font-semibold text-xs group-hover:text-rose-300 transition-colors"
              title="Skip Opening Theme [S]"
            >
              <FastForward className="w-3.5 h-3.5 text-rose-400 fill-rose-400 group-hover:scale-110 transition-transform" />
              <span>Skip Opening</span>
            </button>
            <button
              onClick={() => setIsIntroDismissed(true)}
              className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
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
            aria-hidden={shouldYieldFloatingPrompts || undefined}
            className={`absolute right-6 rounded-2xl border border-white/[0.1] bg-[#0b0912]/70 backdrop-blur-xl p-2.5 pr-3 shadow-2xl flex items-center space-x-3 animate-in fade-in slide-in-from-bottom-4 transition-all ${
              shouldYieldFloatingPrompts
                ? 'z-[35] bottom-28 opacity-0 translate-y-2 scale-[0.97] pointer-events-none duration-150'
                : `z-40 pointer-events-auto duration-300 opacity-100 translate-y-0 scale-100 ${
                    areBottomControlsVisible ? 'bottom-28' : 'bottom-10'
                  }`
            }`}
          >
            <div className="w-16 aspect-video rounded-lg overflow-hidden shrink-0 bg-black border border-white/10 relative">
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
              <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-400">Next</span>
              <p className="text-xs font-semibold text-white max-w-[180px] truncate" title={nextTitle}>
                {nextTitle}
              </p>
            </div>

            <button
              onClick={handlePlayNextEpisode}
              className="px-3.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center space-x-1.5 transition-all active:scale-95 shrink-0"
            >
              <span>Play Next</span>
              <SkipForward className="w-3.5 h-3.5 fill-white" />
            </button>

            <button
              onClick={() => setIsEndingCardDismissed(true)}
              className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
              aria-label="Dismiss Next Episode Prompt"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
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
        episodeFilePath={episode.filePath}
        folderPath={folderPath}
        animeTitle={effectiveAnimeTitle}
        anilistId={anilistId}
        settings={settings}
        onUpdateSettings={onUpdateSettings}
        onSubtitleTrackAdded={handleSubtitleTrackAdded}
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
        isMovie={Boolean(folder && isFolderMovie(folder))}
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
