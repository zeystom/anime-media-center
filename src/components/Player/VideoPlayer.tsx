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
} from 'lucide-react';
import { Episode, VideoMetadata, SubtitleCue, SeasonPreference, AppSettings } from '../../types';
import { SubtitleOverlay } from './SubtitleOverlay';
import { TimelineScrubber } from './TimelineScrubber';
import { TrackControls } from './TrackControls';
import { EpisodeDrawer } from './EpisodeDrawer';
import { RippleIndicator } from './RippleIndicator';
import { formatTime, cleanEpisodeTitle, formatEpisodeDisplayTitle } from '../../utils/format';

interface VideoPlayerProps {
  episode: Episode;
  seasonEpisodes: Episode[];
  folderPath: string;
  initialTime?: number;
  settings: AppSettings;
  history: Record<string, any>;
  onClose: () => void;
  onEpisodeChange: (episode: Episode) => void;
}

function combineAss(ass1: string, ass2: string): string {
  if (!ass1) return ass2;
  if (!ass2) return ass1;

  const ass2Styles = ass2.match(/\[V4\+ Styles\]([\s\S]*?)(\[Events\]|$)/i);
  const ass2Events = ass2.match(/\[Events\]([\s\S]*?)$/i);

  let combined = ass1;
  if (ass2Styles && ass2Styles[1]) {
    const styles = ass2Styles[1].split('\n').filter((l) => l.trim().startsWith('Style:'));
    if (styles.length > 0) {
      combined = combined.replace(/\[Events\]/i, `${styles.join('\n')}\n\n[Events]`);
    }
  }
  if (ass2Events && ass2Events[1]) {
    const lines = ass2Events[1].split('\n').filter((l) => l.trim().startsWith('Dialogue:'));
    if (lines.length > 0) {
      combined = combined.trim() + '\n' + lines.join('\n');
    }
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

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  episode,
  seasonEpisodes,
  folderPath,
  initialTime = 0,
  settings,
  history,
  onClose,
  onEpisodeChange,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Clean parsed episode metadata
  const parsed = useMemo(() => cleanEpisodeTitle(episode.fileName), [episode.fileName]);

  // Video metadata
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [streamStartTime, setStreamStartTime] = useState<number>(initialTime);
  const [videoElementTime, setVideoElementTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);

  // Debounce ref for rapid seeking/skipping
  const seekDebounceRef = useRef<any>(null);

  // Absolute playback time = streamStartTime + videoElement.currentTime
  const currentAbsoluteTime = streamStartTime + videoElementTime;

  // Stable ref for timers and event listeners to avoid re-renders
  const timeRef = useRef(currentAbsoluteTime);
  timeRef.current = currentAbsoluteTime;

  // Track selection
  const [selectedAudioIndex, setSelectedAudioIndex] = useState<number>(0);
  const [selectedMainSubId, setSelectedMainSubId] = useState<string | null>(null);
  const [selectedTopSubId, setSelectedTopSubId] = useState<string | null>(null);
  const [topSubEnabled, setTopSubEnabled] = useState<boolean>(false);
  const [syncOffset, setSyncOffset] = useState<number>(0);
  const [fontSize, setFontSize] = useState<number>(settings.subtitlesFontSize || 28);
  const [subtitlesLoading, setSubtitlesLoading] = useState<boolean>(false);

  // Parsed Subtitle Cues
  const [mainCues, setMainCues] = useState<SubtitleCue[]>([]);
  const [topCues, setTopCues] = useState<SubtitleCue[]>([]);
  const [isMainAssActive, setIsMainAssActive] = useState<boolean>(false);
  const [isTopAssActive, setIsTopAssActive] = useState<boolean>(false);

  // JASSUB WebAssembly ASS Engine
  const jassubRef = useRef<JASSUB | null>(null);
  const serverPortRef = useRef<number>(0);
  const streamStartTimeRef = useRef<number>(0);
  streamStartTimeRef.current = streamStartTime;
  const syncOffsetRef = useRef<number>(0);
  syncOffsetRef.current = syncOffset;

  // UI Drawer / Modals
  const [isTrackControlsOpen, setIsTrackControlsOpen] = useState<boolean>(false);
  const [isEpisodeDrawerOpen, setIsEpisodeDrawerOpen] = useState<boolean>(false);
  const [autoPlayNext, setAutoPlayNext] = useState<boolean>(settings.autoPlayNext);

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

  const opChapter = useMemo(() => {
    if (!metadata?.chapters) return null;
    return metadata.chapters.find((c) => /op|opening|intro/i.test(c.title));
  }, [metadata?.chapters]);

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

  useEffect(() => {
    setIsEndingCardDismissed(false);
  }, [episode.filePath]);

  const isEndingActive =
    !isEndingCardDismissed &&
    nextEpisode !== null &&
    duration > 0 &&
    currentAbsoluteTime >= endingStartTime;

  const isIntroActive =
    currentAbsoluteTime < (opChapter ? opChapter.end + 5 : 210);

  // Ripple feedback
  const [ripple, setRipple] = useState<{ type: any; text?: string } | null>(null);
  const rippleTimerRef = useRef<any>(null);

  // Controls auto-hide
  const [showControls, setShowControls] = useState<boolean>(true);
  const hideControlsTimerRef = useRef<any>(null);

  const showRipple = (type: any, text?: string) => {
    if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current);
    setRipple({ type, text });
    rippleTimerRef.current = setTimeout(() => {
      setRipple(null);
    }, 600);
  };

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
        if (seasonPref?.mainSubtitleTrackId !== undefined) {
          mainSubId = seasonPref.mainSubtitleTrackId;
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
            // For English Dub:
            // 1) Embedded Dubtitle / SDH
            // 2) External Whisper SRT
            // 3) Default English Subtitle
            // 4) Other English Dialogue
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
            // For Japanese / other original languages:
            // 1) Default English translation
            // 2) External Whisper SRT
            // 3) Other English dialogue
            // 4) Embedded Dubtitle
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

        if (seasonPref?.topSubtitleTrackId !== undefined) {
          topSubId = seasonPref.topSubtitleTrackId;
          topEnabled = seasonPref.topSubEnabled;
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
        const { url: streamUrl, actualStartTime } = await window.electronAPI.getStreamUrl(
          episode.filePath,
          defaultAudioIdx,
          initialTime
        );

        if (!isMounted) return;
        applyStream(streamUrl, actualStartTime);
        setLoading(false);
      } catch (err) {
        console.error('Failed to probe or setup video:', err);
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
      if (!metadata) return;

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
              .slice(0, 16);

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
            });
            jassubRef.current = jassub;
            setIsMainAssActive(mainIsAss);
            setIsTopAssActive(topIsAss);

            jassub.ready.catch((err) => {
              console.warn('[VideoPlayer] JASSUB worker init failed, using HTML subtitle overlay fallback:', err);
              if (jassubRef.current === jassub) {
                try {
                  jassub.destroy();
                } catch {}
                jassubRef.current = null;
                setIsMainAssActive(false);
                setIsTopAssActive(false);
              }
            });
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
  }, [metadata, selectedMainSubId, selectedTopSubId, topSubEnabled]);

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

  // Keep the Chromium compositor awake during playback so video frames never freeze/blank
  // when mouse is idle, UI is hidden, and no subtitles are on screen
  useEffect(() => {
    if (!isPlaying) return;
    let animId: number;
    const pulse = () => {
      animId = requestAnimationFrame(pulse);
    };
    animId = requestAnimationFrame(pulse);
    return () => {
      if (animId) cancelAnimationFrame(animId);
    };
  }, [isPlaying]);

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
        mainSubtitleTrackId: mainSub || undefined,
        topSubtitleTrackId: topSub || undefined,
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
  const applyStream = useCallback((url: string, actualStartTime: number) => {
    const video = videoRef.current;
    if (!video) return;

    // 1. Immediately align state timestamps with the exact demuxed keyframe
    timeRef.current = actualStartTime;
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

    // 3. Set new source and play
    video.src = url;

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

      try {
        const { url, actualStartTime } = await window.electronAPI.getStreamUrl(
          episode.filePath,
          selectedAudioIndex,
          clamped
        );

        // If another seek was initiated in the meantime, discard
        if (seq !== seekSeqRef.current) return;

        applyStream(url, actualStartTime);
      } catch (err) {
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

  // Fullscreen Toggle
  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  }, []);

  // Smart Skip Delta (With 180ms debounce for rapid keystrokes like Arrow/J/L)
  const handleSkip = useCallback(
    (deltaSec: number, label: string) => {
      const nextTime = Math.max(0, Math.min(timeRef.current + deltaSec, duration));
      timeRef.current = nextTime;
      showRipple(deltaSec > 0 ? 'seek-forward' : 'seek-backward', label);

      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current);
      }

      seekDebounceRef.current = setTimeout(async () => {
        const seq = ++seekSeqRef.current;
        try {
          const { url, actualStartTime } = await window.electronAPI.getStreamUrl(
            episode.filePath,
            selectedAudioIndex,
            nextTime
          );

          if (seq !== seekSeqRef.current) return;
          applyStream(url, actualStartTime);
        } catch (err) {
          console.error('Failed to skip stream:', err);
        }
      }, 180);
    },
    [duration, episode.filePath, selectedAudioIndex, applyStream]
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
    }, 3000);

    return () => clearInterval(interval);
  }, [metadata, episode, folderPath, duration]);

  // Play Next Episode directly
  const handlePlayNextEpisode = useCallback(() => {
    if (!nextEpisode) return;
    showRipple('forward', `Next: ${formatEpisodeDisplayTitle(nextEpisode)}`);
    onEpisodeChange(nextEpisode);
  }, [nextEpisode, onEpisodeChange]);

  // Contextual Skip Intro (chapter-accurate or +85s fallback)
  const handleSkipIntro = useCallback(() => {
    if (opChapter && currentAbsoluteTime < opChapter.end) {
      handleSeek(opChapter.end);
      showRipple('forward', `Intro Skipped (${formatTime(opChapter.end)})`);
    } else {
      handleSkip(85, 'Intro Skipped (+85s)');
    }
  }, [opChapter, currentAbsoluteTime, handleSeek, handleSkip]);

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
        applyStream(url, actualStartTime);
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
      showRipple('sync', `Sub Sync: ${nextOffset > 0 ? `+${nextOffset}s` : `${nextOffset}s`}`);
      persistSeasonRule(selectedAudioIndex, selectedMainSubId, selectedTopSubId, topSubEnabled, nextOffset);
    },
    [syncOffset, selectedAudioIndex, selectedMainSubId, selectedTopSubId, topSubEnabled, persistSeasonRule]
  );

  // Subtitle Font Size Change (Live in-player & persisted)
  const handleUpdateFontSize = useCallback(
    (newSize: number) => {
      const clamped = Math.max(14, Math.min(newSize, 60));
      setFontSize(clamped);
      showRipple('sync', `Sub Size: ${clamped}px`);
      if (window.electronAPI) {
        window.electronAPI.updateSettings({ subtitlesFontSize: clamped }).catch(() => {});
      }
    },
    []
  );

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
          if (isFullscreen) {
            toggleFullscreen();
          } else if (isTrackControlsOpen) {
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
    onClose,
  ]);

  // Controls are visible when mouse moves, or if video is paused, or while loading, or if a modal/drawer is open
  const areControlsVisible = showControls || !isPlaying || loading || isTrackControlsOpen || isEpisodeDrawerOpen;

  const handleVideoError = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    const mediaError = video.error;
    console.warn('[VideoPlayer] Video element error:', mediaError?.code, mediaError?.message);
  }, []);

  const handleContainerMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      resetControlsTimer();
      // Right edge hover gesture:
      // Strictly disabled in the bottom controls zone (bottom 140px) and top navbar (top 80px),
      // so it never interferes with scrubbing the timeline or clicking Fullscreen / Audio & Subtitles!
      const isOutsideControls = e.clientY > 80 && e.clientY < window.innerHeight - 140;
      const isRightEdge = e.clientX >= window.innerWidth - 18;
      if (isRightEdge && isOutsideControls && !isEpisodeDrawerOpen && !isTrackControlsOpen) {
        setIsEpisodeDrawerOpen(true);
      }
    },
    [resetControlsTimer, isEpisodeDrawerOpen, isTrackControlsOpen]
  );

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
        playsInline
        onTimeUpdate={() => {
          if (videoRef.current) {
            setVideoElementTime(videoRef.current.currentTime);
          }
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={handleEnded}
        onError={handleVideoError}
        className="w-full h-full object-contain pointer-events-none bg-black"
        style={{
          transform: 'translateZ(0)',
          backfaceVisibility: 'hidden',
        }}
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
        hasOutline={settings.subtitlesOutline}
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
        <div className="flex items-center space-x-4">
          <button
            onClick={onClose}
            className="p-2 rounded-xl bg-black/60 hover:bg-black/80 text-zinc-200 hover:text-white border border-white/10 transition-all hover:scale-105"
            aria-label="Back to Library [Esc]"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className="min-w-0">
            <div className="flex items-center space-x-2.5">
              <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-600 text-white shrink-0">
                {parsed.episodeLabel || episode.episodeNumber}
              </span>
              <h1
                className="text-sm md:text-base font-bold text-white tracking-tight truncate max-w-md md:max-w-2xl"
                title={episode.fileName}
              >
                {parsed.seriesTitle
                  ? `${parsed.seriesTitle} — ${formatEpisodeDisplayTitle(
                      parsed.displayTitle,
                      episode.kitsuTitle || episode.episodeTitle
                    )}`
                  : formatEpisodeDisplayTitle(parsed.displayTitle, episode.kitsuTitle || episode.episodeTitle) ||
                    episode.fileName}
              </h1>
            </div>
          </div>
        </div>

        {/* Right side of top navbar: only subtle Subtitle Loading Spinner if active */}
        {subtitlesLoading && (
          <div className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-indigo-500/20 border border-indigo-500/40 text-xs text-indigo-300 backdrop-blur-md animate-pulse">
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

          {/* Right: Contextual Skip Intro, Audio & Subtitles, Fullscreen */}
          <div className="flex items-center space-x-3">
            {/* Skip Intro (visible during intro / OP chapter) */}
            {isIntroActive && (
              <button
                onClick={handleSkipIntro}
                className="flex items-center space-x-2 px-3.5 py-1.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 text-white font-bold text-xs border border-white/20 shadow-lg transition-all hover:scale-105 active:scale-95 animate-in fade-in duration-200"
                aria-label="Skip Opening Intro Theme"
              >
                <FastForward className="w-4 h-4 text-red-500 fill-red-500" />
                <span>Skip Intro {opChapter ? `(${formatTime(opChapter.end)})` : '(+85s)'}</span>
              </button>
            )}

            {/* Audio & Subtitles Menu (formerly in top bar) */}
            <button
              onClick={() => setIsTrackControlsOpen(true)}
              className="flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 text-zinc-200 hover:text-white border border-white/15 text-xs font-medium transition-all shadow-sm"
              aria-label="Configure Audio Tracks & Subtitles"
              title="Audio & Subtitles"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-400" />
              <span>Audio & Subtitles</span>
            </button>

            {/* Fullscreen Button */}
            <button
              onClick={toggleFullscreen}
              className="p-2 rounded-xl text-zinc-300 hover:text-white transition-colors"
              aria-label={isFullscreen ? 'Exit Fullscreen [F]' : 'Fullscreen [F]'}
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Floating Next Episode / Skip Ending Prompt Card */}
      {isEndingActive && nextEpisode && (
        <div className="absolute bottom-24 right-6 z-40 bg-zinc-950/95 backdrop-blur-2xl border border-white/15 p-3.5 rounded-2xl shadow-2xl flex items-center space-x-3.5 animate-in slide-in-from-bottom-4 duration-300">
          <div className="w-16 sm:w-20 aspect-video rounded-xl overflow-hidden shrink-0 bg-black border border-white/10 relative">
            <img
              src={nextEpisode.kitsuThumbnail || nextEpisode.thumbnailUrl}
              alt={nextEpisode.fileName}
              className="w-full h-full object-cover"
            />
          </div>

          <div className="min-w-0 pr-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-red-500">Next Episode</span>
            <p className="text-xs font-bold text-white max-w-[200px] truncate" title={formatEpisodeDisplayTitle(nextEpisode)}>
              {formatEpisodeDisplayTitle(nextEpisode)}
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
      )}

      {/* Right Edge "Episodes" Peek Tab (Click or hover to open drawer) */}
      {!isEpisodeDrawerOpen && (
        <div
          onMouseEnter={() => setIsEpisodeDrawerOpen(true)}
          onClick={() => setIsEpisodeDrawerOpen(true)}
          className={`fixed right-0 top-1/2 -translate-y-1/2 z-40 pr-1 pl-2.5 py-4 rounded-l-2xl bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 hover:text-white border-y border-l border-white/10 shadow-xl backdrop-blur-md cursor-pointer transition-all duration-300 group flex items-center space-x-1.5 ${
            areControlsVisible ? 'opacity-70 translate-x-0' : 'opacity-0 translate-x-2 pointer-events-none'
          }`}
          title="Episodes (or push cursor to right edge)"
        >
          <ChevronLeft className="w-4 h-4 text-zinc-400 group-hover:text-red-400 transition-colors" />
          <span className="text-[11px] font-semibold tracking-wider uppercase text-zinc-300 group-hover:text-white [writing-mode:vertical-lr] rotate-180">
            Episodes
          </span>
        </div>
      )}

      {/* Track Controls Popover (3 Columns: Audio, Main Sub, Top Sub) */}
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
      />

      {/* Episode Drawer (In-Player Switcher) */}
      <EpisodeDrawer
        isOpen={isEpisodeDrawerOpen}
        onClose={() => setIsEpisodeDrawerOpen(false)}
        episodes={seasonEpisodes}
        currentEpisode={episode}
        history={history}
        autoPlayNext={autoPlayNext}
        onToggleAutoPlayNext={() => setAutoPlayNext((prev) => !prev)}
        onSelectEpisode={(newEp) => {
          onEpisodeChange(newEp);
        }}
      />
    </div>
  );
};
