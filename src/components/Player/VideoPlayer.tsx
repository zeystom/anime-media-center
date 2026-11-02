import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  FastForward,
  Rewind,
  ArrowLeft,
  ListVideo,
  Subtitles,
  Sparkles,
  Type,
} from 'lucide-react';
import { Episode, VideoMetadata, SubtitleCue, SeasonPreference, AppSettings } from '../../types';
import { SubtitleOverlay } from './SubtitleOverlay';
import { TimelineScrubber } from './TimelineScrubber';
import { TrackControls } from './TrackControls';
import { EpisodeDrawer } from './EpisodeDrawer';
import { RippleIndicator } from './RippleIndicator';
import { formatTime } from '../../utils/format';

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

  // Parsed Subtitle Cues
  const [mainCues, setMainCues] = useState<SubtitleCue[]>([]);
  const [topCues, setTopCues] = useState<SubtitleCue[]>([]);

  // UI Drawer / Modals
  const [isTrackControlsOpen, setIsTrackControlsOpen] = useState<boolean>(false);
  const [isEpisodeDrawerOpen, setIsEpisodeDrawerOpen] = useState<boolean>(false);
  const [autoPlayNext, setAutoPlayNext] = useState<boolean>(settings.autoPlayNext);

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
        if (seasonPref?.preferredAudioIndex !== undefined) {
          defaultAudioIdx = seasonPref.preferredAudioIndex;
        } else {
          const engTrack = meta.audioTracks.find(
            (t) => t.language === 'eng' || t.language === 'en' || /english/i.test(t.title)
          );
          if (engTrack) {
            defaultAudioIdx = engTrack.audioIndex;
          }
        }
        setSelectedAudioIndex(defaultAudioIdx);

        // Determine Default Main Subtitle:
        // Prioritize: 1) External .srt (Whisper) -> 2) Embedded English [Dubtitle] -> 3) Embedded English
        let mainSubId: string | null = null;
        if (seasonPref?.mainSubtitleTrackId !== undefined) {
          mainSubId = seasonPref.mainSubtitleTrackId;
        } else {
          const extSub = meta.subtitleTracks.find((s) => s.type === 'external');
          const engDubtitle = meta.subtitleTracks.find(
            (s) =>
              (s.language === 'eng' || s.language === 'en') &&
              (s.isDubtitle || /dubtitle|amzn/i.test(s.title)) &&
              !s.isSigns
          );
          const engDialogue = meta.subtitleTracks.find(
            (s) => (s.language === 'eng' || s.language === 'en') && !s.isSigns
          );

          if (extSub) {
            mainSubId = extSub.id;
          } else if (engDubtitle) {
            mainSubId = engDubtitle.id;
          } else if (engDialogue) {
            mainSubId = engDialogue.id;
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
          const engSigns = meta.subtitleTracks.find(
            (s) =>
              (s.language === 'eng' || s.language === 'en') &&
              (s.isSigns || s.isForced || /sign|song|forced/i.test(s.title)) &&
              s.id !== mainSubId
          );
          if (engSigns) {
            topSubId = engSigns.id;
            topEnabled = true;
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

  // 2. Subtitle Extraction when Main Sub changes
  useEffect(() => {
    if (!metadata || !selectedMainSubId) {
      setMainCues([]);
      return;
    }

    const track = metadata.subtitleTracks.find((s) => s.id === selectedMainSubId);
    if (!track) {
      setMainCues([]);
      return;
    }

    window.electronAPI
      .extractSubtitleTrack(
        metadata.filePath,
        track.id,
        track.index,
        track.type === 'external',
        track.filePath
      )
      .then((cues) => {
        setMainCues(cues);
      })
      .catch((err) => {
        console.error('Failed to extract main subtitles:', err);
      });
  }, [metadata, selectedMainSubId]);

  // 3. Subtitle Extraction when Top Sub changes
  useEffect(() => {
    if (!metadata || !selectedTopSubId || !topSubEnabled) {
      setTopCues([]);
      return;
    }

    const track = metadata.subtitleTracks.find((s) => s.id === selectedTopSubId);
    if (!track) {
      setTopCues([]);
      return;
    }

    window.electronAPI
      .extractSubtitleTrack(
        metadata.filePath,
        track.id,
        track.index,
        track.type === 'external',
        track.filePath
      )
      .then((cues) => {
        setTopCues(cues);
      })
      .catch((err) => {
        console.error('Failed to extract top subtitles:', err);
      });
  }, [metadata, selectedTopSubId, topSubEnabled]);

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

    // 2. Pause existing decoder context before changing source to prevent hardware decoder deadlock
    try {
      video.pause();
    } catch {}

    // 3. Clear existing source & play new stream seamlessly
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

  // Auto-play Next Episode on end
  const handleEnded = useCallback(() => {
    // Only auto-play next if we actually reached near the end of the full duration (>95%)
    if (duration > 0 && timeRef.current / duration > 0.95) {
      if (autoPlayNext) {
        const curIndex = seasonEpisodes.findIndex((e) => e.filePath === episode.filePath);
        if (curIndex !== -1 && curIndex < seasonEpisodes.length - 1) {
          const nextEp = seasonEpisodes[curIndex + 1];
          onEpisodeChange(nextEp);
        }
      }
    }
  }, [autoPlayNext, episode.filePath, seasonEpisodes, onEpisodeChange, duration]);

  // Audio track switch
  const handleSelectAudio = useCallback(
    async (audioIdx: number) => {
      setSelectedAudioIndex(audioIdx);
      persistSeasonRule(audioIdx, selectedMainSubId, selectedTopSubId, topSubEnabled, syncOffset);

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
    onClose,
  ]);

  // Controls are visible when mouse moves, or if video is paused, or while loading
  const areControlsVisible = showControls || !isPlaying || loading;

  return (
    <div
      ref={containerRef}
      onMouseMove={resetControlsTimer}
      className="relative w-screen h-screen bg-black overflow-hidden flex items-center justify-center select-none"
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
        onError={(e) => {
          console.warn('[VideoPlayer] Video element reported error:', e);
        }}
        className="w-full h-full object-contain pointer-events-none"
      />

      {/* Instant Single-Click Play/Pause Surface */}
      {/* Clicking anywhere immediately pauses/plays with ZERO delay */}
      <div
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        className="absolute inset-0 cursor-pointer z-10"
      />

      {/* Dual Subtitles Overlay (Top Signs & Bottom Dialogue) */}
      <SubtitleOverlay
        currentTime={currentAbsoluteTime}
        mainCues={mainCues}
        topCues={topCues}
        topSubEnabled={topSubEnabled}
        syncOffset={syncOffset}
        fontSize={fontSize}
        hasOutline={settings.subtitlesOutline}
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
            title="Back to Library [Esc]"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div>
            <div className="flex items-center space-x-2">
              <span className="px-2 py-0.5 rounded text-xs font-bold bg-red-600 text-white">
                {episode.episodeNumber}
              </span>
              <h1 className="text-sm md:text-base font-bold text-white tracking-tight truncate max-w-md md:max-w-2xl">
                {episode.fileName}
              </h1>
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-2.5">
          {/* Top Subtitle Quick 1-Click Toggle Button on the bar */}
          <button
            onClick={handleToggleTopSub}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${
              topSubEnabled
                ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40 shadow-sm shadow-yellow-500/20'
                : 'bg-black/60 text-zinc-400 border-white/10 hover:text-zinc-200'
            }`}
            title="Toggle 2nd Top Subtitle / Signs (English forced only)"
          >
            <Sparkles className={`w-3.5 h-3.5 ${topSubEnabled ? 'text-yellow-400' : 'text-zinc-400'}`} />
            <span>Top Sub: {topSubEnabled ? 'ON' : 'OFF'}</span>
          </button>

          {/* Audio & Subtitles Menu */}
          <button
            onClick={() => setIsTrackControlsOpen(true)}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-black/60 hover:bg-black/80 text-zinc-200 hover:text-white border border-white/10 text-xs font-medium transition-all"
            title="Configure Audio Tracks & Dual Subtitles"
          >
            <Subtitles className="w-4 h-4 text-emerald-400" />
            <span>Tracks</span>
          </button>

          {/* Episode Drawer Button */}
          <button
            onClick={() => setIsEpisodeDrawerOpen(true)}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-black/60 hover:bg-black/80 text-zinc-200 hover:text-white border border-white/10 text-xs font-medium transition-all"
            title="Switch Episodes"
          >
            <ListVideo className="w-4 h-4 text-red-500" />
            <span>Episodes</span>
          </button>
        </div>
      </div>

      {/* Bottom Player Controls Bar (Auto-hiding) */}
      <div
        className={`absolute bottom-0 left-0 right-0 pt-16 pb-6 px-6 bg-gradient-to-t from-black/90 via-black/60 to-transparent flex flex-col space-y-3 z-40 transition-opacity duration-300 ${
          areControlsVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Seekbar Scrubber with Hover Thumbnail Previews */}
        <TimelineScrubber
          currentTime={currentAbsoluteTime}
          duration={duration}
          filePath={episode.filePath}
          onSeek={handleSeek}
        />

        {/* Action Controls Toolbar */}
        <div className="flex items-center justify-between">
          {/* Left: Play/Pause, Rewind, Fast Forward, Volume, Time */}
          <div className="flex items-center space-x-4">
            <button
              onClick={togglePlay}
              className="p-2 rounded-xl text-white hover:text-red-500 transition-colors"
              title={isPlaying ? 'Pause [Space]' : 'Play [Space]'}
            >
              {isPlaying ? <Pause className="w-6 h-6 fill-white" /> : <Play className="w-6 h-6 fill-white" />}
            </button>

            <button
              onClick={() => handleSkip(-5, '-5s')}
              className="p-1.5 rounded-lg text-zinc-300 hover:text-white transition-colors"
              title="Seek -5s [Left Arrow]"
            >
              <Rewind className="w-5 h-5" />
            </button>

            <button
              onClick={() => handleSkip(5, '+5s')}
              className="p-1.5 rounded-lg text-zinc-300 hover:text-white transition-colors"
              title="Seek +5s [Right Arrow]"
            >
              <FastForward className="w-5 h-5" />
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
                title="Mute [M]"
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

          {/* Right: Subtitle Font Size Controls, Skip Intro (+85s) Button, Fullscreen */}
          <div className="flex items-center space-x-3">
            {/* Quick In-Player Subtitle Font Size Changer */}
            <div className="flex items-center space-x-1 px-2.5 py-1.5 rounded-xl bg-black/70 hover:bg-black/90 border border-white/10 text-xs text-zinc-300">
              <Type className="w-3.5 h-3.5 text-zinc-400 mr-0.5" />
              <button
                onClick={() => handleUpdateFontSize(fontSize - 2)}
                disabled={fontSize <= 14}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/20 active:bg-white/30 text-white font-bold disabled:opacity-30 transition-colors"
                title="Decrease Subtitle Size [-]"
              >
                -
              </button>
              <span className="text-[11px] font-mono font-bold text-white min-w-[28px] text-center select-none">
                {fontSize}px
              </span>
              <button
                onClick={() => handleUpdateFontSize(fontSize + 2)}
                disabled={fontSize >= 60}
                className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/20 active:bg-white/30 text-white font-bold disabled:opacity-30 transition-colors"
                title="Increase Subtitle Size [+]"
              >
                +
              </button>
            </div>

            {/* Skip Intro (+85s) Dedicated Button */}
            <button
              onClick={() => handleSkip(85, 'Intro Skipped (+85s)')}
              className="flex items-center space-x-2 px-3.5 py-1.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 text-white font-bold text-xs border border-white/20 shadow-lg transition-all hover:scale-105 active:scale-95"
              title="Skip Opening Intro Theme (+85 seconds)"
            >
              <FastForward className="w-4 h-4 text-red-500 fill-red-500" />
              <span>Skip Intro (+85s)</span>
            </button>

            {/* Fullscreen Button */}
            <button
              onClick={toggleFullscreen}
              className="p-2 rounded-xl text-zinc-300 hover:text-white transition-colors"
              title={isFullscreen ? 'Exit Fullscreen [F]' : 'Fullscreen [F]'}
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

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
