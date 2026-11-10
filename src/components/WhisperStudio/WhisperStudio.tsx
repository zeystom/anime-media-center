import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  FolderOpen,
  Volume2,
  StopCircle,
  Play,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Terminal,
  CheckSquare,
  Square,
  Users,
  ExternalLink,
  Film,
  Search,
  ChevronLeft,
  ChevronRight,
  X,
  Check,
} from 'lucide-react';
import {
  AnimeFolder,
  Episode,
  AudioTrack,
  WhisperLogMessage,
  WhisperQueueItem,
  WhisperLiveCue,
  WhisperOptions,
  WhisperPreset,
} from '../../types';
import { cleanSeriesTitle, cleanEpisodeTitle } from '../../utils/format';
import { TerminalLog } from './TerminalLog';
import { LiveDialogueStream } from './LiveDialogueStream';
import { showGlobalToast } from '../Toast';

import type { AppSettings } from '../../types';

interface WhisperStudioProps {
  initialFolder?: AnimeFolder | null;
  whisperExists?: boolean;
  onRefreshLibrary: () => void;
  onOpenSettings?: () => void;
  settings?: AppSettings;
  onSaveSettings?: (newSettings: Partial<AppSettings>) => Promise<void> | void;
  isActiveTab?: boolean;
  folders?: AnimeFolder[];
}

const STORAGE_KEY_WHISPER_TUNING = 'kaiko_whisper_tuning_preset';

export const WhisperStudio: React.FC<WhisperStudioProps> = ({
  initialFolder,
  whisperExists = true,
  onRefreshLibrary,
  onOpenSettings,
  settings,
  onSaveSettings,
  isActiveTab,
  folders,
}) => {
  const [libraryFolders, setLibraryFolders] = useState<AnimeFolder[]>(folders || []);
  const [showAnimePicker, setShowAnimePicker] = useState<boolean>(false);
  const [pickerSearch, setPickerSearch] = useState<string>('');
  const [pickerFilter, setPickerFilter] = useState<'all' | 'needs_subs' | 'has_subs'>('all');
  const [pickerPage, setPickerPage] = useState<number>(1);
  const ITEMS_PER_PAGE = 8;

  // Sync library folders from props or electron library cache
  useEffect(() => {
    if (folders && folders.length > 0) {
      setLibraryFolders(folders);
    } else if (window.electronAPI?.getLibraryCache) {
      window.electronAPI
        .getLibraryCache()
        .then((cached) => {
          if (cached && cached.length > 0) setLibraryFolders(cached);
        })
        .catch(() => {});
    }
  }, [folders]);

  const [selectedFolder, setSelectedFolder] = useState<string>(initialFolder?.folderPath || '');

  // Default to first folder if no folder is selected
  useEffect(() => {
    if (!selectedFolder) {
      if (initialFolder?.folderPath) {
        setSelectedFolder(initialFolder.folderPath);
      } else if (libraryFolders.length > 0) {
        setSelectedFolder(libraryFolders[0].folderPath);
      }
    }
  }, [libraryFolders, initialFolder, selectedFolder]);

  // Identify currently selected AnimeFolder object for rich card rendering
  const currentAnime = useMemo(() => {
    if (!selectedFolder) return null;
    const norm = selectedFolder.replace(/[/\\]+$/, '').toLowerCase();
    const found = libraryFolders.find(
      (f) => f.folderPath.replace(/[/\\]+$/, '').toLowerCase() === norm
    );
    if (found) return found;
    if (initialFolder && initialFolder.folderPath.replace(/[/\\]+$/, '').toLowerCase() === norm) {
      return initialFolder;
    }
    return null;
  }, [libraryFolders, selectedFolder, initialFolder]);

  // Helper to accurately evaluate subtitle status (whisper, dubtitles, external, embedded) for any folder
  const getFolderSubStats = useCallback((f: AnimeFolder) => {
    const total = f.totalEpisodes || f.episodes?.length || 0;
    let whisperCount = f.hasWhisperCount ?? 0;
    let dubtitlesCount = f.hasDubtitlesCount ?? (f.hasEmbeddedDubtitles ? total : 0);
    let extSubCount = f.hasExtSubCount ?? f.hasSubtitlesCount ?? 0;
    let hasEmbeddedSubs = Boolean(f.hasEmbeddedSubtitles);
    let anySubCount = 0;

    if (f.episodes && f.episodes.length > 0) {
      whisperCount = f.episodes.filter((e) => e.hasWhisperSrt).length;
      dubtitlesCount = f.episodes.filter((e) => e.hasEmbeddedDubtitles).length;
      extSubCount = f.episodes.filter((e) => e.hasExternalSrt && !e.hasWhisperSrt).length;
      hasEmbeddedSubs = f.episodes.some((e) => e.hasEmbeddedSubtitles);
      anySubCount = f.episodes.filter(
        (e) => e.hasWhisperSrt || e.hasEmbeddedDubtitles || e.hasExternalSrt || e.hasEmbeddedSubtitles
      ).length;
    } else {
      if (f.hasEmbeddedDubtitles || f.hasEmbeddedSubtitles) {
        anySubCount = total;
      } else {
        anySubCount = Math.min(total, whisperCount + extSubCount);
      }
    }

    const needsSubs = anySubCount < total;
    return {
      total,
      whisperCount,
      dubtitlesCount,
      extSubCount,
      hasEmbeddedSubs,
      anySubCount,
      needsSubs,
    };
  }, []);

  // Filtered & paginated folders for the Anime Picker modal
  const filteredFolders = useMemo(() => {
    return libraryFolders.filter((f) => {
      const title = (f.canonicalTitle || f.folderName || '').toLowerCase();
      const matchesSearch = !pickerSearch || title.includes(pickerSearch.toLowerCase().trim());
      if (!matchesSearch) return false;
      const stats = getFolderSubStats(f);
      if (pickerFilter === 'needs_subs') {
        return stats.needsSubs;
      }
      if (pickerFilter === 'has_subs') {
        return stats.anySubCount > 0;
      }
      return true;
    });
  }, [libraryFolders, pickerSearch, pickerFilter, getFolderSubStats]);

  const totalPages = Math.max(1, Math.ceil(filteredFolders.length / ITEMS_PER_PAGE));
  const currentPage = Math.min(pickerPage, totalPages);
  const paginatedFolders = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredFolders.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredFolders, currentPage]);

  useEffect(() => {
    setPickerPage(1);
  }, [pickerSearch, pickerFilter]);

  // Close Anime Picker Modal on Escape
  useEffect(() => {
    if (!showAnimePicker) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setShowAnimePicker(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showAnimePicker]);
  const [episodes, setEpisodes] = useState<Episode[]>(initialFolder?.episodes || []);
  const [sampleAudioTracks, setSampleAudioTracks] = useState<AudioTrack[]>([]);
  const [selectedAudioTrackNum, setSelectedAudioTrackNum] = useState<number>(1);
  const [isAudioTracksExpanded, setIsAudioTracksExpanded] = useState<boolean>(false);
  const [probing, setProbing] = useState<boolean>(false);

  // Episode selection & filter
  const [selectedEpisodePaths, setSelectedEpisodePaths] = useState<Set<string>>(new Set());
  const [episodeFilter, setEpisodeFilter] = useState<'all' | 'missing'>('missing');

  // Whisper Queue & Execution State
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  // Prevent opening or keep open anime picker while whisper generation is active
  useEffect(() => {
    if (isProcessing && showAnimePicker) {
      setShowAnimePicker(false);
    }
  }, [isProcessing, showAnimePicker]);
  const [currentFile, setCurrentFile] = useState<string>('');
  const [overallProgress, setOverallProgress] = useState<number>(0);
  const [currentSpeed, setCurrentSpeed] = useState<string>('');
  const [queue, setQueue] = useState<WhisperQueueItem[]>([]);
  const [logs, setLogs] = useState<WhisperLogMessage[]>([]);
  const [liveCues, setLiveCues] = useState<WhisperLiveCue[]>([]);

  // UI Drawer State
  const [showTerminal, setShowTerminal] = useState<boolean>(false);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [isEditingPrompt, setIsEditingPrompt] = useState<boolean>(false);

  // Auto-detected Character Names state
  const [detectedCharacters, setDetectedCharacters] = useState<string[]>([]);
  const [isDetectingCharacters, setIsDetectingCharacters] = useState<boolean>(false);
  const [detectedAnimeTitle, setDetectedAnimeTitle] = useState<string>('');
  const [userPromptOverride, setUserPromptOverride] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string>('large-v3-turbo');
  const [availableModels, setAvailableModels] = useState<string[]>(['large-v3-turbo']);
  const [downloadingModelName, setDownloadingModelName] = useState<string | null>(null);
  const [downloadingModelPercent, setDownloadingModelPercent] = useState<number | null>(null);

  // Load configured Whisper model and scan available models from application settings & binary check
  const refreshModels = React.useCallback(async () => {
    try {
      const s = await window.electronAPI?.getSettings?.();
      const status = await window.electronAPI?.checkBinaries?.();
      if (status?.isDownloadingModel && status?.downloadingModelName) {
        setDownloadingModelName(status.downloadingModelName);
      } else if (status && !status.isDownloadingModel) {
        setDownloadingModelName(null);
      }
      let currentModel = settings?.whisperModel || s?.whisperModel || 'large-v3-turbo';
      const customPath = settings?.customModelPath !== undefined ? settings.customModelPath : s?.customModelPath;
      if (customPath) {
        const customName = status?.customModelDetectedName || customPath.replace(/^.*[\\/]/, '');
        if (customName && (!currentModel || currentModel === 'large-v3-turbo')) {
          currentModel = customName;
        }
      }
      setActiveModel(currentModel);

      const list = ['large-v3-turbo'];
      if (status?.installedModels) {
        for (const m of status.installedModels) {
          if (!list.includes(m)) list.push(m);
        }
      }
      if (status?.detectedCustomModels) {
        for (const m of status.detectedCustomModels) {
          if (!list.includes(m)) list.push(m);
        }
      }
      if (customPath) {
        const customName = status?.customModelDetectedName || customPath.replace(/^.*[\\/]/, '');
        if (customName && !list.includes(customName)) list.push(customName);
      }
      setAvailableModels(list);
    } catch {}
  }, [settings?.whisperModel, settings?.customModelPath]);

  useEffect(() => {
    refreshModels();
  }, [refreshModels, isActiveTab]);

  // Quality & Tuning State (Human Friendly)
  // 'anime' = Normal dialogue, 'bgm' = Loud music / action, 'fast' = Quiet & fast, 'custom' = Custom
  const [qualityOption, setQualityOption] = useState<WhisperPreset>('anime');
  const [vadSensitivity, setVadSensitivity] = useState<'high' | 'balanced' | 'standard'>('balanced');
  const [antiStutter, setAntiStutter] = useState<boolean>(true);
  const [preventSingleWords, setPreventSingleWords] = useState<boolean>(true);
  const [channelMode, setChannelMode] = useState<'auto' | 'fc'>('auto');
  const [task, setTask] = useState<'transcribe' | 'translate'>('transcribe');
  const [language, setLanguage] = useState<string>('en');

  // Restore saved tuning preferences from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_WHISPER_TUNING);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.preset) setQualityOption(parsed.preset);
        if (parsed.vadSensitivity) setVadSensitivity(parsed.vadSensitivity);
        if (parsed.antiStutter !== undefined) setAntiStutter(parsed.antiStutter);
        if (parsed.preventSingleWords !== undefined) setPreventSingleWords(parsed.preventSingleWords);
        if (parsed.channelMode) setChannelMode(parsed.channelMode);
        if (parsed.task) setTask(parsed.task);
        if (parsed.language) setLanguage(parsed.language);
        if (parsed.userPromptOverride) setUserPromptOverride(parsed.userPromptOverride);
      }
    } catch {}
  }, []);

  // Save tuning preferences to localStorage when changed
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY_WHISPER_TUNING,
        JSON.stringify({
          preset: qualityOption,
          vadSensitivity,
          antiStutter,
          preventSingleWords,
          channelMode,
          task,
          language,
          userPromptOverride,
        })
      );
    } catch {}
  }, [qualityOption, vadSensitivity, antiStutter, preventSingleWords, channelMode, task, language, userPromptOverride]);

  // Synchronize initialFolder when user opens Whisper from library (unless job is running)
  useEffect(() => {
    if (initialFolder?.folderPath && !isProcessing) {
      setSelectedFolder(initialFolder.folderPath);
    }
  }, [initialFolder, isProcessing]);

  // Initial Status Recovery on Mount
  useEffect(() => {
    if (!window.electronAPI) return;

    (async () => {
      try {
        const status = await window.electronAPI.getWhisperStatus();
        if (status.isRunning) {
          setIsProcessing(true);
          setCurrentFile(status.currentFile);
          setOverallProgress(status.progress);
          setQueue(status.queue);
          if (status.speed) setCurrentSpeed(status.speed);
          if (status.liveCues && status.liveCues.length > 0) {
            setLiveCues(status.liveCues);
          }
          if (status.folderPath) {
            setSelectedFolder(status.folderPath);
          }
          if (status.logs && status.logs.length > 0) {
            setLogs(status.logs);
          }
        }
      } catch (err) {
        console.error('Failed to get whisper status on mount:', err);
      }
    })();
  }, []);

  // When selected folder changes, reload episodes and probe 1st file
  useEffect(() => {
    if (!selectedFolder) return;

    let isMounted = true;
    setProbing(true);

    (async () => {
      try {
        const eps = await window.electronAPI.getFolderEpisodes(selectedFolder);
        if (!isMounted) return;
        setEpisodes(eps);

        // Subtitle status check (whisper, dubtitles, external, or embedded subtitles)
        const missingSubs = eps.filter(
          (e) => !e.hasWhisperSrt && !e.hasEmbeddedDubtitles && !e.hasExternalSrt && !e.hasEmbeddedSubtitles
        );
        if (missingSubs.length > 0) {
          setSelectedEpisodePaths(new Set(missingSubs.map((e) => e.filePath)));
          setEpisodeFilter('missing');
        } else {
          // All episodes already have subtitles: show all episodes and avoid pre-selecting
          setSelectedEpisodePaths(new Set());
          setEpisodeFilter('all');
        }

        if (eps.length > 0) {
          const sampleFile = eps[0].filePath;
          const meta = await window.electronAPI.probeVideo(sampleFile);
          if (!isMounted) return;

          setSampleAudioTracks(meta.audioTracks);

          // Auto-detect English track for --ff_track (1-indexed track number)
          let engTrackNum = 1;
          let hasEng = false;
          for (let i = 0; i < meta.audioTracks.length; i++) {
            const t = meta.audioTracks[i];
            if (t.language === 'eng' || t.language === 'en' || /english/i.test(t.title)) {
              engTrackNum = i + 1;
              hasEng = true;
              break;
            }
          }
          setSelectedAudioTrackNum(engTrackNum);
          // If no English track auto-detected, expand list so user can choose
          setIsAudioTracksExpanded(!hasEng);
        } else {
          setSampleAudioTracks([]);
        }
      } catch (err) {
        console.error('Failed to probe folder for whisper:', err);
      } finally {
        if (isMounted) setProbing(false);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [selectedFolder]);

  // Auto-detect character names via AniList API when anime folder changes
  useEffect(() => {
    setDetectedCharacters([]);
    setDetectedAnimeTitle('');
    setUserPromptOverride(null);

    if (!selectedFolder || !window.electronAPI) {
      return;
    }

    const animeTitle = currentAnime?.canonicalTitle || cleanSeriesTitle(currentAnime?.folderName || selectedFolder);
    if (!animeTitle) return;

    let isMounted = true;
    setIsDetectingCharacters(true);

    (async () => {
      try {
        const targetAnilistId = currentAnime?.anilistId ?? undefined;
        const res = await window.electronAPI.getAnimeCharacters(animeTitle, targetAnilistId);
        if (!isMounted) return;
        if (res && res.characters && res.characters.length > 0) {
          setDetectedCharacters(res.characters);
          setDetectedAnimeTitle(res.title || animeTitle);
        } else {
          setDetectedCharacters([]);
        }
      } catch {
        if (isMounted) setDetectedCharacters([]);
      } finally {
        if (isMounted) setIsDetectingCharacters(false);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [selectedFolder, currentAnime?.anilistId, currentAnime?.canonicalTitle]);

  // Setup IPC log and progress listeners
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubLog = window.electronAPI.onWhisperLog((log) => {
      setLogs((prev) => {
        const updated = [...prev, log];
        return updated.length > 350 ? updated.slice(-350) : updated;
      });
    });

    const unsubProgress = window.electronAPI.onWhisperProgress((data) => {
      setCurrentFile(data.currentFile);
      setOverallProgress(data.progress);
      setQueue(data.queue);
      if (data.speed) setCurrentSpeed(data.speed);
      if (data.liveCues && data.liveCues.length > 0) {
        setLiveCues(data.liveCues);
      }
      setIsProcessing(true);
    });

    const unsubDone = window.electronAPI.onWhisperDone(() => {
      setIsProcessing(false);
      setCurrentFile('');
      onRefreshLibrary();
    });

    const unsubModelStatus = window.electronAPI?.onWhisperModelDownloadStatus?.((data) => {
      setDownloadingModelName(data.isDownloading ? data.modelName : null);
      if (!data.isDownloading) {
        setDownloadingModelPercent(null);
        refreshModels();
      }
    });

    const unsubModelProg = window.electronAPI?.onModelDownloadProgress?.((data) => {
      setDownloadingModelPercent(data.percent);
    });

    return () => {
      unsubLog();
      unsubProgress();
      unsubDone();
      if (unsubModelStatus) unsubModelStatus();
      if (unsubModelProg) unsubModelProg();
    };
  }, [onRefreshLibrary, refreshModels]);

  const handleBrowseFolder = async () => {
    if (isProcessing) return;
    const folder = await window.electronAPI.browseFolder(selectedFolder);
    if (folder) {
      setSelectedFolder(folder);
      setUserPromptOverride(null);
      setDetectedCharacters([]);
      setDetectedAnimeTitle('');
    }
  };

  const handleSelectQuality = (newPreset: 'anime' | 'bgm' | 'fast') => {
    setQualityOption(newPreset);
    if (newPreset === 'anime') {
      setVadSensitivity('balanced');
      setAntiStutter(true);
      setPreventSingleWords(true);
      setChannelMode('auto');
    } else if (newPreset === 'bgm') {
      setVadSensitivity('high');
      setAntiStutter(true);
      setPreventSingleWords(true);
      setChannelMode('auto');
    } else if (newPreset === 'fast') {
      setVadSensitivity('standard');
      setAntiStutter(true);
      setPreventSingleWords(true);
      setChannelMode('auto');
    }
  };

  // Computes active initial prompt automatically without user friction
  const activePrompt = useMemo(() => {
    if (userPromptOverride !== null) return userPromptOverride;
    const suffix =
      qualityOption === 'bgm'
        ? 'Anime dialogue, spoken conversation over music, no singing, no lyrics.'
        : qualityOption === 'fast'
        ? 'Clean dialogue and conversations.'
        : 'Anime dialogue, conversational speech, clean subtitles.';

    if (detectedCharacters.length > 0) {
      return `${detectedCharacters.join(', ')}. ${suffix}`;
    }
    return suffix;
  }, [userPromptOverride, qualityOption, detectedCharacters]);

  const isCustomQuality = useMemo(() => {
    if (qualityOption === 'custom') return true;
    if (qualityOption === 'anime') {
      return vadSensitivity !== 'balanced' || !antiStutter || !preventSingleWords || channelMode !== 'auto';
    }
    if (qualityOption === 'bgm') {
      return vadSensitivity !== 'high' || !antiStutter || !preventSingleWords || channelMode !== 'auto';
    }
    if (qualityOption === 'fast') {
      return vadSensitivity !== 'standard' || !antiStutter || !preventSingleWords || channelMode !== 'auto';
    }
    return false;
  }, [qualityOption, vadSensitivity, antiStutter, preventSingleWords, channelMode]);

  const buildWhisperOptions = (selectivePaths?: string[]): WhisperOptions => {
    return {
      preset: qualityOption,
      model: activeModel || 'large-v3-turbo',
      language,
      task,
      vadThreshold: vadSensitivity === 'high' ? 0.28 : vadSensitivity === 'balanced' ? 0.35 : 0.45,
      vadMinSpeechDurationMs: vadSensitivity === 'standard' ? 250 : 150,
      vadSpeechPadMs: vadSensitivity === 'high' ? 1000 : 900,
      conditionOnPreviousText: !antiStutter,
      compressionRatioThreshold: antiStutter ? 2.8 : 2.4,
      noSpeechThreshold: vadSensitivity === 'high' ? 0.7 : 0.6,
      initialPrompt: activePrompt,
      maxLineWidth: 46,
      maxLineCount: 2,
      maxCommaCent: preventSingleWords ? 100 : 70,
      minDistToEnd: 8,
      sentence: true,
      channelMode,
      speechNorm: qualityOption === 'bgm',
      selectedFilePaths: selectivePaths || (selectedEpisodePaths.size > 0 ? Array.from(selectedEpisodePaths) : undefined),
    };
  };

  const handleStartSeason = async () => {
    if (!selectedFolder) return;
    if (downloadingModelName) {
      showGlobalToast(`Cannot start generation: model "${downloadingModelName}" is currently downloading.`, 'warning');
      return;
    }
    if (!whisperExists) {
      if (onOpenSettings) onOpenSettings();
      return;
    }
    setIsProcessing(true);
    setLiveCues([]);
    setLogs((prev) => [
      ...prev,
      {
        type: 'info',
        text: `Starting Whisper generation for folder: ${selectedFolder} (Audio Track: ${selectedAudioTrackNum}, Quality: ${qualityOption})`,
        timestamp: Date.now(),
      },
    ]);

    const options = buildWhisperOptions();
    const res = await window.electronAPI.startWhisperSeason(
      selectedFolder,
      selectedAudioTrackNum,
      false, // Explicit user-selected set is already filtered in selectedFilePaths
      options
    );

    if (!res.success) {
      setIsProcessing(false);
      setLogs((prev) => [
        ...prev,
        {
          type: 'error',
          text: `Whisper error: ${res.error}`,
          timestamp: Date.now(),
        },
      ]);
    }
  };

  const handleStartSingleEpisode = async (ep: Episode) => {
    if (!selectedFolder || !whisperExists) return;
    if (downloadingModelName) {
      showGlobalToast(`Cannot start generation: model "${downloadingModelName}" is currently downloading.`, 'warning');
      return;
    }
    setIsProcessing(true);
    setLiveCues([]);
    setLogs((prev) => [
      ...prev,
      {
        type: 'info',
        text: `Starting single episode subtitle generation: ${ep.fileName}`,
        timestamp: Date.now(),
      },
    ]);

    const options = buildWhisperOptions([ep.filePath]);
    const res = await window.electronAPI.startWhisperSeason(
      selectedFolder,
      selectedAudioTrackNum,
      false,
      options
    );

    if (!res.success) {
      setIsProcessing(false);
      setLogs((prev) => [
        ...prev,
        {
          type: 'error',
          text: `Whisper error: ${res.error}`,
          timestamp: Date.now(),
        },
      ]);
    }
  };

  const handleCancel = async () => {
    await window.electronAPI.cancelWhisper();
    setIsProcessing(false);
    setLogs((prev) => [
      ...prev,
      {
        type: 'info',
        text: 'Whisper execution cancelled by user.',
        timestamp: Date.now(),
      },
    ]);
  };

  // Batch toggle handlers
  const handleToggleSelectAll = () => {
    const targetEpisodes = episodeFilter === 'missing'
      ? episodes.filter((e) => !e.hasWhisperSrt)
      : episodes;

    const allTargetSelected = targetEpisodes.every((e) => selectedEpisodePaths.has(e.filePath));
    setSelectedEpisodePaths((prev) => {
      const next = new Set(prev);
      if (allTargetSelected) {
        for (const ep of targetEpisodes) {
          next.delete(ep.filePath);
        }
      } else {
        for (const ep of targetEpisodes) {
          next.add(ep.filePath);
        }
      }
      return next;
    });
  };

  const toggleEpisodePath = (path: string) => {
    setSelectedEpisodePaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const hasSubtitles = (e: (typeof episodes)[0]) =>
    Boolean(e.hasWhisperSrt || e.hasEmbeddedDubtitles || e.hasExternalSrt || e.hasEmbeddedSubtitles);

  const existingWhisperCount = episodes.filter((e) => e.hasWhisperSrt).length;
  const existingAnySubCount = episodes.filter(hasSubtitles).length;
  const missingAnySubCount = episodes.length - existingAnySubCount;
  const missingWhisperCount = episodes.length - existingWhisperCount;

  const filteredEpisodes =
    episodeFilter === 'missing'
      ? episodes.filter((e) => (existingWhisperCount > 0 ? !e.hasWhisperSrt : !hasSubtitles(e)))
      : episodes;

  const engTrackIndex = sampleAudioTracks.findIndex(
    (t) => t.language === 'eng' || t.language === 'en' || /english/i.test(t.title)
  );
  const isEngAutoDetected = engTrackIndex !== -1 && selectedAudioTrackNum === engTrackIndex + 1;
  const selectedTrack = sampleAudioTracks[selectedAudioTrackNum - 1];

  // Active generation queue index
  const currentQueueIndex = queue.findIndex((q) => q.status === 'processing');
  const activeProcessingEpisode = currentFile ? cleanEpisodeTitle(currentFile) : null;

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden bg-[#0f0f12] p-6 space-y-5">
      {/* Top Banner / Heading */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-2 border-b border-zinc-800 shrink-0">
        <div>
          <div className="flex items-center space-x-2.5">
            <h1 className="text-xl font-bold text-white tracking-tight">Whisper Studio</h1>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Batch-generate synchronized English SRT subtitles for local MKV anime seasons using faster-whisper-xxl.
          </p>
        </div>

        {/* Global Action Button */}
        <div className="flex items-center space-x-3">
          {isProcessing ? (
            <button
              onClick={handleCancel}
              className="flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow-lg shadow-red-600/30 transition-all active:scale-95"
            >
              <StopCircle className="w-4 h-4" />
              <span>Cancel Queue</span>
            </button>
          ) : (
            <button
              onClick={handleStartSeason}
              disabled={!selectedFolder || episodes.length === 0 || probing || !whisperExists || selectedEpisodePaths.size === 0 || Boolean(downloadingModelName)}
              title={downloadingModelName ? `Cannot start generation: model "${downloadingModelName}" is downloading` : undefined}
              className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-indigo-600 hover:from-red-500 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-indigo-600/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="w-4 h-4 fill-white" />
              <span>
                {downloadingModelName
                  ? `Model "${downloadingModelName}" downloading...`
                  : selectedEpisodePaths.size === 0
                  ? 'Select episodes to generate'
                  : `Generate subtitles for ${selectedEpisodePaths.size} episode${selectedEpisodePaths.size === 1 ? '' : 's'}`}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Missing Whisper Binary Alert & Setup Guidance */}
      {!whisperExists && (
        <div className="p-4 rounded-2xl bg-gradient-to-r from-amber-500/15 via-zinc-900 to-indigo-500/10 border border-amber-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-amber-200 shadow-md shrink-0">
          <div className="flex items-start space-x-3">
            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-semibold text-white text-sm">
                Faster-Whisper Engine Not Configured
              </div>
              <p className="text-[11px] text-zinc-300 leading-relaxed">
                Faster-Whisper-XXL is required to generate AI speech-to-text subtitles. Video playback works out-of-the-box with built-in FFmpeg. Download the standalone release from GitHub or Subtitle Edit, and select its location in Settings.
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2 shrink-0 self-end sm:self-center">
            <button
              type="button"
              onClick={() => window.electronAPI?.openExternalUrl?.('https://github.com/Purfview/whisper-standalone-win/releases')}
              className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 font-medium transition-colors text-xs flex items-center space-x-1.5"
            >
              <span>GitHub Releases</span>
              <ExternalLink className="w-3 h-3 text-zinc-400" />
            </button>
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="px-3.5 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 font-semibold transition-colors text-xs shadow-sm"
              >
                Open Settings
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Grid: Left Steps (5/12) & Right Queue (7/12) */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0">
        {/* Left Column: 3 Compact Steps */}
        <div className="lg:col-span-5 flex flex-col space-y-4 overflow-y-auto pr-1 scrollbar-thin">
          {/* Step 1: Anime Selection */}
          <div className="rounded-2xl bg-[#141418] border border-white/10 space-y-3 shadow-md p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                1. Anime
              </span>

              <div className="flex items-center space-x-2">
                {libraryFolders.length > 0 && (
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() => setShowAnimePicker(true)}
                    className="flex items-center space-x-1.5 px-2.5 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    <Film className="w-3.5 h-3.5" />
                    <span>Change Anime</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={handleBrowseFolder}
                  title="Browse custom folder on disk"
                  className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white border border-white/10 text-xs transition-colors disabled:opacity-50"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {selectedFolder ? (
              <div className="flex items-start space-x-3 p-3 rounded-xl bg-zinc-900/80 border border-white/5">
                {currentAnime?.posterUrl ? (
                  <img
                    src={currentAnime.posterUrl}
                    alt={currentAnime.canonicalTitle || currentAnime.folderName}
                    className="w-14 h-20 rounded-lg object-cover border border-white/10 shrink-0 shadow-sm"
                  />
                ) : (
                  <div className="w-14 h-20 rounded-lg bg-zinc-800 border border-white/10 flex items-center justify-center shrink-0 text-zinc-500">
                    <Film className="w-6 h-6" />
                  </div>
                )}
                <div className="flex-1 min-w-0 space-y-1.5">
                  <h3
                    className="text-sm font-bold text-white truncate"
                    title={currentAnime?.canonicalTitle || currentAnime?.folderName || cleanSeriesTitle(selectedFolder)}
                  >
                    {cleanSeriesTitle(currentAnime?.canonicalTitle || currentAnime?.folderName || selectedFolder)}
                  </h3>
                  <div className="flex items-center space-x-2 flex-wrap gap-y-1 text-[11px]">
                    <span className="text-zinc-400 font-medium">
                      {episodes.length} episode{episodes.length === 1 ? '' : 's'}
                    </span>
                    {existingWhisperCount > 0 && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        {existingWhisperCount} AI Sub{existingWhisperCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {episodes.filter((e) => e.hasEmbeddedDubtitles).length > 0 && (
                      <span
                        className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-purple-500/15 text-purple-300 border border-purple-500/30"
                        title="Embedded English Dubtitles (SDH)"
                      >
                        {episodes.filter((e) => e.hasEmbeddedDubtitles).length} Dubtitles
                      </span>
                    )}
                    {episodes.filter((e) => !e.hasWhisperSrt && !e.hasEmbeddedDubtitles && e.hasExternalSrt).length > 0 && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-blue-500/15 text-blue-300 border border-blue-500/30">
                        {episodes.filter((e) => !e.hasWhisperSrt && !e.hasEmbeddedDubtitles && e.hasExternalSrt).length} Ext Subs
                      </span>
                    )}
                    {episodes.filter((e) => !e.hasWhisperSrt && !e.hasEmbeddedDubtitles && !e.hasExternalSrt && e.hasEmbeddedSubtitles).length > 0 && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        {episodes.filter((e) => !e.hasWhisperSrt && !e.hasEmbeddedDubtitles && !e.hasExternalSrt && e.hasEmbeddedSubtitles).length} Subtitles
                      </span>
                    )}
                    {missingAnySubCount > 0 && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        {missingAnySubCount} need subs
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] font-mono text-zinc-500 truncate" title={selectedFolder}>
                    {selectedFolder}
                  </p>
                </div>
              </div>
            ) : (
              <div
                onClick={() => {
                  if (!isProcessing) setShowAnimePicker(true);
                }}
                className={`p-5 rounded-xl border border-dashed border-white/10 text-center transition-all space-y-1.5 ${
                  isProcessing
                    ? 'opacity-50 cursor-not-allowed bg-zinc-900/20'
                    : 'hover:border-indigo-500/50 bg-zinc-900/40 hover:bg-zinc-900/70 cursor-pointer'
                }`}
              >
                <Film className="w-6 h-6 mx-auto text-zinc-400" />
                <p className="text-xs font-medium text-zinc-200">Select an anime from library</p>
                <p className="text-[11px] text-zinc-500">Choose a downloaded anime to generate subtitles</p>
              </div>
            )}
          </div>

          {/* Step 2: Audio Stream Selection */}
          <div className="rounded-2xl bg-[#141418] border border-white/10 space-y-3 shadow-md p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 block">
                2. Audio
              </span>
              {probing && <span className="text-[11px] text-zinc-500 animate-pulse">Scanning audio...</span>}
            </div>

            {/* If English is auto-detected and not expanded, show clean compact row with "Change" button */}
            {isEngAutoDetected && !isAudioTracksExpanded ? (
              <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/60 border border-zinc-800/80 text-xs text-zinc-300">
                <div className="flex items-center space-x-2.5 truncate mr-2">
                  <Volume2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="truncate">
                    Audio: <strong className="text-white font-semibold">{selectedTrack?.title || 'English'}</strong>{' '}
                    <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 font-semibold ml-1">
                      auto-detected
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => setIsAudioTracksExpanded(true)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold underline shrink-0 disabled:opacity-50"
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {!isEngAutoDetected && sampleAudioTracks.length > 0 && (
                  <p className="text-[11px] text-amber-300/90 leading-tight">
                    English audio track not detected automatically. Please pick the speech track below:
                  </p>
                )}

                {sampleAudioTracks.length > 0 ? (
                  sampleAudioTracks.map((track, idx) => {
                    const trackNum = idx + 1;
                    const isSelected = selectedAudioTrackNum === trackNum;
                    const isEng = track.language === 'eng' || track.language === 'en' || /english/i.test(track.title);

                    return (
                      <button
                        key={track.audioIndex}
                        disabled={isProcessing}
                        onClick={() => {
                          setSelectedAudioTrackNum(trackNum);
                          if (isEngAutoDetected) setIsAudioTracksExpanded(false);
                        }}
                        className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left transition-all border ${
                          isSelected
                            ? 'bg-indigo-600/20 border-indigo-500 text-white shadow-sm'
                            : 'bg-zinc-900/60 border-zinc-800/80 text-zinc-300 hover:bg-zinc-800/60 disabled:opacity-50'
                        }`}
                      >
                        <div className="truncate mr-2">
                          <div className="flex items-center space-x-2">
                            <span className="text-xs font-bold font-mono text-zinc-400">
                              Track #{trackNum}
                            </span>
                            <span className="text-xs font-semibold text-zinc-100 truncate">
                              {track.title || track.languageName || 'Audio'}
                            </span>
                            {isEng && (
                              <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                                ENG
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-zinc-500 mt-0.5">
                            {track.languageName} • {track.codec.toUpperCase()}
                          </div>
                        </div>
                        {isSelected && <span className="text-xs font-bold text-indigo-400 shrink-0">Selected</span>}
                      </button>
                    );
                  })
                ) : (
                  <div className="p-3 text-center rounded-xl bg-zinc-900/40 border border-dashed border-zinc-800 text-zinc-500 text-xs">
                    {probing ? 'Scanning audio tracks...' : 'No audio streams loaded yet.'}
                  </div>
                )}

                {isAudioTracksExpanded && isEngAutoDetected && (
                  <div className="text-right pt-1">
                    <button
                      type="button"
                      onClick={() => setIsAudioTracksExpanded(false)}
                      className="text-xs text-zinc-400 hover:text-white underline"
                    >
                      Done
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 3: Quality & Settings */}
          <div className="rounded-2xl bg-[#141418] border border-white/10 space-y-3 shadow-md p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 block">
                3. Quality
              </span>
              {isCustomQuality && (
                <span className="text-[10px] font-mono text-purple-300 bg-purple-500/20 px-2 py-0.5 rounded border border-purple-500/30">
                  Custom
                </span>
              )}
            </div>

            {/* Segmented 3-option control */}
            <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-zinc-900/90 border border-zinc-800">
              <button
                type="button"
                disabled={isProcessing}
                onClick={() => handleSelectQuality('anime')}
                className={`py-2 px-1.5 rounded-lg text-xs font-semibold text-center transition-all ${
                  qualityOption === 'anime' && !isCustomQuality
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800/60'
                }`}
              >
                Normal dialogue
              </button>
              <button
                type="button"
                disabled={isProcessing}
                onClick={() => handleSelectQuality('bgm')}
                className={`py-2 px-1.5 rounded-lg text-xs font-semibold text-center transition-all ${
                  qualityOption === 'bgm' && !isCustomQuality
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800/60'
                }`}
              >
                Loud music / action
              </button>
              <button
                type="button"
                disabled={isProcessing}
                onClick={() => handleSelectQuality('fast')}
                className={`py-2 px-1.5 rounded-lg text-xs font-semibold text-center transition-all ${
                  qualityOption === 'fast' && !isCustomQuality
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800/60'
                }`}
              >
                Quiet & fast
              </button>
            </div>

            {/* Plain-language explanation line */}
            <p className="text-[11px] text-zinc-400 leading-normal pt-0.5">
              {qualityOption === 'bgm'
                ? 'Boosts quiet speech under loud soundtrack, battle sound effects, and phone calls.'
                : qualityOption === 'fast'
                ? 'High-speed recognition for quiet conversational episodes without loud background music.'
                : 'Recommended for most anime. Protects fast speech, high voices, and stuttering.'}
            </p>

            {/* Active AI Model Selector */}
            <div className="pt-2.5 border-t border-zinc-800/60 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-1.5">
                  <span className="font-semibold text-zinc-300">AI Subtitle Model</span>
                </div>
                {onOpenSettings && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="text-[11px] text-indigo-400 hover:text-indigo-300 underline font-medium transition-colors"
                  >
                    Manage in Settings
                  </button>
                )}
              </div>

              {/* Model Selection Buttons / Pills */}
              <div className="flex flex-wrap gap-1.5">
                {availableModels.map((m) => {
                  const isSelected = activeModel === m;
                  const isDownloading = downloadingModelName === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={isProcessing || isDownloading}
                      onClick={async () => {
                        if (isDownloading) return;
                        setActiveModel(m);
                        try {
                          await onSaveSettings?.({ whisperModel: m });
                          await window.electronAPI?.updateSettings?.({ whisperModel: m });
                        } catch {}
                      }}
                      className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-mono font-medium border transition-all ${
                        isDownloading
                          ? 'bg-amber-500/15 text-amber-300 border-amber-500/30 cursor-wait animate-pulse'
                          : isSelected
                          ? 'bg-indigo-600/30 text-indigo-200 border-indigo-500/60 shadow-sm ring-1 ring-indigo-500/40'
                          : 'bg-zinc-900/80 text-zinc-400 border-white/5 hover:border-zinc-700 hover:text-zinc-200'
                      }`}
                    >
                      <span>{m}</span>
                      {isDownloading ? (
                        <span className="text-amber-400 font-sans text-[10px] font-bold">
                          {downloadingModelPercent !== null ? `(${downloadingModelPercent}%)` : '(downloading...)'}
                        </span>
                      ) : isSelected ? (
                        <span className="text-indigo-300 font-sans text-[10px]">✓</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Character Names (AniList Auto-Search) */}
            <div className="pt-2 border-t border-zinc-800/60 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center space-x-1.5 text-zinc-300 truncate mr-2">
                  <Users className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  {isDetectingCharacters ? (
                    <span className="text-zinc-500 animate-pulse text-[11px]">Finding character names...</span>
                  ) : detectedCharacters.length > 0 ? (
                    <span className="text-[11px] truncate">
                      Character names: <strong className="text-emerald-400 font-semibold">{detectedCharacters.length} found ✓</strong>
                    </span>
                  ) : (
                    <span className="text-zinc-500 text-[11px]">Names not found, you can add them manually</span>
                  )}
                </div>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => setIsEditingPrompt((prev) => !prev)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold underline shrink-0 disabled:opacity-50"
                >
                  {isEditingPrompt ? 'Close' : detectedCharacters.length > 0 ? 'Edit' : 'Add'}
                </button>
              </div>

              {/* Expandable Character Names & Prompt Editor */}
              {isEditingPrompt && (
                <div className="p-3 rounded-xl bg-zinc-900/90 border border-zinc-800 space-y-2.5">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>Initial dialogue prompt:</span>
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => setUserPromptOverride(null)}
                      className="text-[10px] text-zinc-400 hover:text-white underline disabled:opacity-50"
                    >
                      Reset to default
                    </button>
                  </div>

                  <input
                    type="text"
                    disabled={isProcessing}
                    value={activePrompt}
                    onChange={(e) => setUserPromptOverride(e.target.value)}
                    placeholder="Character names, anime dialogue context..."
                    className="w-full px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500 font-sans"
                  />

                  {detectedCharacters.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <span className="text-[10px] text-zinc-500 block">
                        Toggle names for {detectedAnimeTitle || 'this series'}:
                      </span>
                      <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto scrollbar-thin pr-1">
                        {detectedCharacters.map((char) => {
                          const isInPrompt = activePrompt.toLowerCase().includes(char.toLowerCase());
                          return (
                            <button
                              key={char}
                              type="button"
                              disabled={isProcessing}
                              onClick={() => {
                                const tokens = activePrompt.split(',').map((t) => t.trim()).filter(Boolean);
                                const idx = tokens.findIndex((t) => t.toLowerCase() === char.toLowerCase());
                                if (idx !== -1) {
                                  tokens.splice(idx, 1);
                                } else {
                                  tokens.unshift(char);
                                }
                                setUserPromptOverride(tokens.join(', '));
                              }}
                              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                                isInPrompt
                                  ? 'bg-indigo-600/30 text-indigo-200 border-indigo-500/60'
                                  : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-white'
                              }`}
                            >
                              {isInPrompt ? `✓ ${char}` : `+ ${char}`}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Advanced Settings Link (Collapsed by Default) */}
            <div className="pt-2 border-t border-zinc-800/60">
              <button
                type="button"
                onClick={() => setShowAdvanced((prev) => !prev)}
                className="flex items-center space-x-1.5 text-xs text-zinc-400 hover:text-white transition-colors"
              >
                <span>Advanced settings</span>
                {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {showAdvanced && (
                <div className="pt-3 pb-1 space-y-3.5 border-t border-zinc-800/80 mt-2.5">
                  {/* Voice Sensitivity */}
                  <div>
                    <label className="text-[11px] font-bold text-zinc-300 block mb-1">
                      Speech recognition sensitivity
                    </label>
                    <div className="grid grid-cols-3 gap-1.5 text-xs">
                      {(['high', 'balanced', 'standard'] as const).map((level) => (
                        <button
                          key={level}
                          type="button"
                          disabled={isProcessing}
                          onClick={() => {
                            setVadSensitivity(level);
                            setQualityOption('custom');
                          }}
                          className={`py-1.5 px-2 rounded-lg border font-medium text-center transition-all ${
                            vadSensitivity === level
                              ? 'bg-indigo-600/25 border-indigo-500 text-white'
                              : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-800'
                          }`}
                        >
                          {level === 'high' ? 'High' : level === 'balanced' ? 'Balanced' : 'Standard'}
                        </button>
                      ))}
                    </div>
                    <span className="text-[10px] text-zinc-500 block mt-1">
                      Higher sensitivity prevents skipping quiet phrases and whispery speech.
                    </span>
                  </div>

                  {/* Anti-stutter Protection */}
                  <label className="flex items-start space-x-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={isProcessing}
                      checked={antiStutter}
                      onChange={(e) => {
                        setAntiStutter(e.target.checked);
                        setQualityOption('custom');
                      }}
                      className="w-4 h-4 mt-0.5 rounded bg-zinc-900 border-zinc-700 text-indigo-600 focus:ring-0 cursor-pointer disabled:opacity-50"
                    />
                    <div>
                      <span className="text-xs font-medium text-zinc-200 block">
                        Stutter & high-pitch loop protection
                      </span>
                      <span className="text-[10px] text-zinc-500 block leading-tight">
                        Prevents repetition loops when characters stutter, squeak, or speak rapidly.
                      </span>
                    </div>
                  </label>

                  {/* Merge Single Words */}
                  <label className="flex items-start space-x-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={isProcessing}
                      checked={preventSingleWords}
                      onChange={(e) => {
                        setPreventSingleWords(e.target.checked);
                        setQualityOption('custom');
                      }}
                      className="w-4 h-4 mt-0.5 rounded bg-zinc-900 border-zinc-700 text-indigo-600 focus:ring-0 cursor-pointer disabled:opacity-50"
                    />
                    <div>
                      <span className="text-xs font-medium text-zinc-200 block">
                        Merge isolated single words
                      </span>
                      <span className="text-[10px] text-zinc-500 block leading-tight">
                        Keeps whole phrases intact so single words do not fly out onto their own subtitle lines.
                      </span>
                    </div>
                  </label>
                </div>
              )}
            </div>

            {/* Subtle Milestone 4 Summary Line */}
            <div className="pt-2 text-[11px] text-zinc-500 flex items-center space-x-1.5 flex-wrap">
              <span>Accurate Timestamps</span>
              <span>·</span>
              <span>English Dialogue</span>
              <span>·</span>
              <span>Standard 2-Line</span>
            </div>
          </div>
        </div>

        {/* Right Column: Live Stream & Interactive Season Queue */}
        <div className="lg:col-span-7 flex flex-col h-full min-h-0 space-y-4">
          {/* Active Generation Banner (Visible only when running) */}
          {isProcessing && currentFile && (
            <div className="p-3.5 rounded-2xl bg-zinc-900/95 border border-indigo-500/40 flex flex-col space-y-2 shadow-lg shrink-0">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center space-x-2 truncate max-w-md">
                  <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-ping" />
                  <span className="font-semibold text-zinc-200 truncate">
                    {currentQueueIndex >= 0 ? `Episode ${currentQueueIndex + 1} of ${queue.length}: ` : 'Transcribing: '}
                    <span className="text-indigo-400 font-bold">
                      {activeProcessingEpisode?.displayTitle || currentFile}
                    </span>
                  </span>
                </div>
                <div className="flex items-center space-x-2 shrink-0">
                  {currentSpeed && (
                    <span className="font-mono text-zinc-400 text-xs">{currentSpeed}</span>
                  )}
                  <span className="font-mono font-bold text-indigo-400 text-sm">
                    {overallProgress}%
                  </span>
                </div>
              </div>
              <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-red-500 rounded-full transition-all duration-300"
                  style={{ width: `${overallProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Live Dialogue Stream Card: Shown during run or when cues exist */}
          {isProcessing || liveCues.length > 0 ? (
            <LiveDialogueStream
              cues={liveCues}
              isProcessing={isProcessing}
              currentFile={currentFile}
              speed={currentSpeed}
              progress={overallProgress}
            />
          ) : null}

          {/* Interactive Season Queue & Episode Selector */}
          <div className="flex-1 rounded-2xl bg-[#141418] border border-white/10 flex flex-col min-h-[220px] overflow-hidden shadow-md">
            {/* Queue Header & Filters */}
            <div className="flex items-center justify-between px-4 py-3 bg-zinc-900/80 border-b border-zinc-800/80 shrink-0">
              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={handleToggleSelectAll}
                  className="text-zinc-400 hover:text-white transition-colors disabled:opacity-50 flex items-center space-x-1.5"
                  title="Select all / none"
                >
                  {filteredEpisodes.length > 0 && filteredEpisodes.every((e) => selectedEpisodePaths.has(e.filePath)) ? (
                    <CheckSquare className="w-4 h-4 text-indigo-400" />
                  ) : (
                    <Square className="w-4 h-4" />
                  )}
                  <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">
                    Episodes ({selectedEpisodePaths.size} selected)
                  </span>
                </button>
              </div>

              {/* Filter: All | Without Subtitles */}
              <div className="flex items-center space-x-1 bg-zinc-950 p-0.5 rounded-lg border border-zinc-800 text-xs">
                <button
                  type="button"
                  onClick={() => setEpisodeFilter('missing')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    episodeFilter === 'missing'
                      ? 'bg-zinc-800 text-white font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {existingWhisperCount > 0
                    ? `Without AI subtitles (${missingWhisperCount})`
                    : `Without subtitles (${missingAnySubCount})`}
                </button>
                <button
                  type="button"
                  onClick={() => setEpisodeFilter('all')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    episodeFilter === 'all'
                      ? 'bg-zinc-800 text-white font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  All ({episodes.length})
                </button>
              </div>
            </div>

            {/* Episode Rows List */}
            <div className="flex-1 p-3 overflow-y-auto space-y-2 scrollbar-thin">
              {episodes.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-zinc-500 text-xs p-6 text-center">
                  <span>No episodes loaded. Select an anime folder to view episodes.</span>
                </div>
              ) : filteredEpisodes.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-zinc-500 text-xs p-6 text-center">
                  <span>All episodes already have subtitles! Switch filter to "All" to re-generate.</span>
                </div>
              ) : (
                filteredEpisodes.map((ep) => {
                  const parsed = cleanEpisodeTitle(ep.fileName);
                  const isSelected = selectedEpisodePaths.has(ep.filePath);
                  const isCurrent = currentFile && ep.fileName === currentFile;
                  const queueMatch = queue.find((q) => q.filePath === ep.filePath || q.fileName === ep.fileName);

                  return (
                    <div
                      key={ep.filePath}
                      className={`p-2.5 rounded-xl border flex items-center justify-between space-x-3 transition-all ${
                        isCurrent
                          ? 'bg-indigo-600/15 border-indigo-500/60 shadow-sm'
                          : isSelected
                          ? 'bg-zinc-900/70 border-zinc-800 text-zinc-200'
                          : ep.hasWhisperSrt
                          ? 'bg-zinc-900/20 border-zinc-800/30 text-zinc-500 opacity-50'
                          : 'bg-zinc-900/30 border-zinc-800/40 text-zinc-400 opacity-70'
                      }`}
                    >
                      {/* Checkbox & Title */}
                      <div className="flex items-center space-x-2.5 truncate mr-2">
                        <input
                          type="checkbox"
                          disabled={isProcessing}
                          checked={isSelected}
                          onChange={() => toggleEpisodePath(ep.filePath)}
                          className="w-4 h-4 rounded bg-zinc-800 border-zinc-700 text-indigo-600 focus:ring-0 cursor-pointer disabled:opacity-50 shrink-0"
                        />

                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                            isCurrent
                              ? 'bg-indigo-600 text-white'
                              : ep.hasWhisperSrt
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {parsed.episodeLabel}
                        </span>

                        <span
                          className={`text-xs truncate font-medium ${
                            isCurrent ? 'text-indigo-300 font-bold' : ep.hasWhisperSrt ? 'text-zinc-400' : 'text-zinc-200'
                          }`}
                          title={ep.fileName}
                        >
                          {parsed.displayTitle}
                        </span>
                      </div>

                      {/* Status Badges & Quick Action */}
                      <div className="flex items-center space-x-2 shrink-0">
                        {isCurrent ? (
                          <span className="text-indigo-400 font-bold text-[11px] font-mono animate-pulse flex items-center space-x-1">
                            <span>{overallProgress}%</span>
                            {currentSpeed && <span className="text-[10px] text-zinc-400">({currentSpeed})</span>}
                          </span>
                        ) : isProcessing && queueMatch ? (
                          queueMatch.status === 'completed' ? (
                            <span className="flex items-center space-x-1 text-emerald-400 text-[11px] font-semibold bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Done</span>
                            </span>
                          ) : queueMatch.status === 'processing' ? (
                            <span className="text-indigo-400 font-bold text-[11px] font-mono animate-pulse">Running</span>
                          ) : queueMatch.status === 'failed' ? (
                            <span className="text-red-400 text-[11px]">Failed</span>
                          ) : (
                            <span className="text-zinc-500 text-[11px]">Queued</span>
                          )
                        ) : ep.hasWhisperSrt ? (
                          <span className="flex items-center space-x-1 text-emerald-400 text-[11px] font-semibold bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20" title="Whisper AI subtitle ready (.whisper.srt)">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Done</span>
                          </span>
                        ) : ep.hasEmbeddedDubtitles ? (
                          <span className="text-purple-300 text-[10px] font-semibold bg-purple-500/15 px-1.5 py-0.5 rounded border border-purple-500/30" title="Embedded English Dubtitles (SDH)">
                            Dub Sub
                          </span>
                        ) : ep.hasExternalSrt ? (
                          <span className="text-blue-300 text-[10px] font-semibold bg-blue-500/15 px-1.5 py-0.5 rounded border border-blue-500/30" title="External Subtitle ready (.srt)">
                            Ext Sub
                          </span>
                        ) : ep.hasEmbeddedSubtitles ? (
                          <span className="text-emerald-300 text-[10px] font-semibold bg-emerald-500/15 px-1.5 py-0.5 rounded border border-emerald-500/30" title="Embedded Subtitles">
                            Sub
                          </span>
                        ) : (
                          <span className="text-zinc-500 text-[11px]">No subtitles</span>
                        )}

                        {/* Quick Transcribe Single Episode Button */}
                        {!isProcessing && !downloadingModelName && (
                          <button
                            type="button"
                            onClick={() => handleStartSingleEpisode(ep)}
                            title="Generate this episode"
                            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                          >
                            <Play className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Developer Logs Drawer (Collapsed by Default) */}
          <div className="rounded-2xl bg-[#0c0c0e] border border-zinc-800/80 overflow-hidden shadow-lg shrink-0">
            <button
              type="button"
              onClick={() => setShowTerminal((prev) => !prev)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-[#141418] hover:bg-zinc-800/60 text-zinc-300 transition-colors"
            >
              <div className="flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-indigo-400" />
                <span className="text-xs font-mono font-semibold text-zinc-300">
                  Developer & Engine Logs ({logs.length} events)
                </span>
              </div>
              <div className="flex items-center space-x-2">
                <span className="text-[11px] font-mono text-zinc-500">
                  {showTerminal ? 'Hide Console' : 'Show Console'}
                </span>
                {showTerminal ? (
                  <ChevronDown className="w-4 h-4 text-zinc-400" />
                ) : (
                  <ChevronUp className="w-4 h-4 text-zinc-400" />
                )}
              </div>
            </button>

            {showTerminal && (
              <div className="h-64 border-t border-zinc-800/80">
                <TerminalLog logs={logs} onClear={() => setLogs([])} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Anime Selection Modal */}
      {showAnimePicker && (
        <div
          role="dialog"
          aria-modal="true"
          data-modal="true"
          onClick={() => setShowAnimePicker(false)}
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-3xl rounded-2xl bg-[#141418] border border-white/10 shadow-2xl flex flex-col max-h-[85vh] overflow-hidden"
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-zinc-800 shrink-0">
              <div className="flex items-center space-x-2">
                <Film className="w-5 h-5 text-indigo-400" />
                <h2 className="text-base font-bold text-white">Select Anime from Library</h2>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 border border-white/5">
                  {filteredFolders.length}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowAnimePicker(false)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                title="Close (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Search & Filter Bar */}
            <div className="p-4 border-b border-zinc-800/80 bg-zinc-900/50 space-y-3 shrink-0">
              <div className="relative">
                <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  autoFocus
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  placeholder="Search downloaded anime by title..."
                  className="w-full pl-9 pr-8 py-2 rounded-xl bg-zinc-900 border border-zinc-700/80 text-white text-xs placeholder-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
                {pickerSearch && (
                  <button
                    type="button"
                    onClick={() => setPickerSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div className="flex items-center space-x-2 text-xs flex-wrap gap-y-1">
                <button
                  type="button"
                  onClick={() => setPickerFilter('all')}
                  className={`px-3 py-1 rounded-lg font-medium transition-colors ${
                    pickerFilter === 'all'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-zinc-800/80 text-zinc-400 hover:text-white hover:bg-zinc-800'
                  }`}
                >
                  All ({libraryFolders.length})
                </button>
                <button
                  type="button"
                  onClick={() => setPickerFilter('needs_subs')}
                  className={`px-3 py-1 rounded-lg font-medium transition-colors ${
                    pickerFilter === 'needs_subs'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-zinc-800/80 text-zinc-400 hover:text-white hover:bg-zinc-800'
                  }`}
                >
                  Needs Subtitles ({libraryFolders.filter((f) => getFolderSubStats(f).needsSubs).length})
                </button>
                <button
                  type="button"
                  onClick={() => setPickerFilter('has_subs')}
                  className={`px-3 py-1 rounded-lg font-medium transition-colors ${
                    pickerFilter === 'has_subs'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-zinc-800/80 text-zinc-400 hover:text-white hover:bg-zinc-800'
                  }`}
                >
                  Has Subtitles ({libraryFolders.filter((f) => getFolderSubStats(f).anySubCount > 0).length})
                </button>
              </div>
            </div>

            {/* Anime Cards Grid */}
            <div className="flex-1 overflow-y-auto p-4 min-h-[320px]">
              {paginatedFolders.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-56 text-center space-y-2">
                  <Film className="w-10 h-10 text-zinc-600" />
                  <p className="text-sm font-semibold text-zinc-300">No downloaded anime found</p>
                  <p className="text-xs text-zinc-500 max-w-sm">
                    {pickerSearch
                      ? 'Try searching with a different keyword or clear your filter.'
                      : 'Add anime media folders in Settings to see your downloaded anime library here.'}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {paginatedFolders.map((folder) => {
                    const isSelected =
                      selectedFolder &&
                      selectedFolder.replace(/[/\\]+$/, '').toLowerCase() ===
                        folder.folderPath.replace(/[/\\]+$/, '').toLowerCase();
                    const title = folder.canonicalTitle || folder.folderName || cleanSeriesTitle(folder.folderPath);
                    const stats = getFolderSubStats(folder);
                    return (
                      <div
                        key={folder.folderPath}
                        onClick={() => {
                          if (isProcessing) return;
                          setSelectedFolder(folder.folderPath);
                          setUserPromptOverride(null);
                          setDetectedCharacters([]);
                          setDetectedAnimeTitle('');
                          setShowAnimePicker(false);
                        }}
                        className={`group relative flex flex-col rounded-xl overflow-hidden border transition-all ${
                          isProcessing
                            ? 'opacity-60 cursor-not-allowed'
                            : 'cursor-pointer hover:scale-[1.02]'
                        } ${
                          isSelected
                            ? 'bg-indigo-950/40 border-indigo-500 ring-2 ring-indigo-500/50 shadow-lg shadow-indigo-500/10'
                            : 'bg-zinc-900/70 border-white/5 hover:border-zinc-700 hover:bg-zinc-800/60'
                        }`}
                      >
                        {/* Poster with aspect ratio */}
                        <div className="relative aspect-[3/4] w-full bg-zinc-800/80 overflow-hidden">
                          {folder.posterUrl ? (
                            <img
                              src={folder.posterUrl}
                              alt={title}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center p-3 text-zinc-500">
                              <Film className="w-8 h-8 mb-1" />
                              <span className="text-[10px] text-center line-clamp-2 font-medium">{title}</span>
                            </div>
                          )}

                          {/* Top Badges */}
                          <div className="absolute top-2 left-2 flex flex-col gap-1">
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-black/75 text-zinc-200 backdrop-blur-sm shadow">
                              {stats.total} ep{stats.total === 1 ? '' : 's'}
                            </span>
                          </div>

                          <div className="absolute top-2 right-2 flex flex-col gap-1 items-end">
                            {stats.whisperCount > 0 ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/90 text-white backdrop-blur-sm shadow">
                                AI Subbed
                              </span>
                            ) : stats.dubtitlesCount > 0 ? (
                              <span
                                className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-500/90 text-white backdrop-blur-sm shadow"
                                title="English Dubtitles (SDH)"
                              >
                                Dub Sub
                              </span>
                            ) : stats.extSubCount > 0 ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/90 text-white backdrop-blur-sm shadow">
                                Ext Sub
                              </span>
                            ) : stats.hasEmbeddedSubs ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-600/90 text-white backdrop-blur-sm shadow">
                                Sub
                              </span>
                            ) : null}
                            {isSelected && (
                              <span className="p-1 rounded-full bg-indigo-600 text-white shadow ring-2 ring-white/20">
                                <Check className="w-3 h-3 stroke-[3]" />
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Card Info */}
                        <div className="p-2.5 space-y-1">
                          <h4 className="text-xs font-bold text-white truncate" title={title}>
                            {cleanSeriesTitle(title)}
                          </h4>
                          <div className="flex items-center justify-between text-[10px] text-zinc-400">
                            {stats.whisperCount > 0 ? (
                              <span className="text-emerald-400 font-medium">
                                {stats.whisperCount}/{stats.total} AI Subs
                              </span>
                            ) : stats.dubtitlesCount > 0 ? (
                              <span className="text-purple-400 font-medium">
                                {stats.dubtitlesCount} dubtitles (SDH)
                              </span>
                            ) : stats.extSubCount > 0 ? (
                              <span className="text-blue-400 font-medium">
                                {stats.extSubCount} external subs
                              </span>
                            ) : stats.hasEmbeddedSubs ? (
                              <span className="text-emerald-400 font-medium">
                                Embedded subtitles
                              </span>
                            ) : stats.needsSubs ? (
                              <span className="text-amber-400/90">
                                {stats.total - stats.anySubCount} need subs
                              </span>
                            ) : (
                              <span className="text-zinc-400">Subtitles ready</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Modal Footer with Pagination and Browse custom */}
            <div className="p-3.5 border-t border-zinc-800 bg-zinc-900/80 flex items-center justify-between gap-3 shrink-0">
              <button
                type="button"
                disabled={isProcessing}
                onClick={async () => {
                  if (isProcessing) return;
                  const folder = await window.electronAPI.browseFolder(selectedFolder);
                  if (folder) {
                    setSelectedFolder(folder);
                    setUserPromptOverride(null);
                    setDetectedCharacters([]);
                    setDetectedAnimeTitle('');
                    setShowAnimePicker(false);
                  }
                }}
                className="flex items-center space-x-1.5 text-xs text-zinc-400 hover:text-white transition-colors py-1.5 px-2.5 rounded-lg hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Browse folder on disk...</span>
              </button>

              {totalPages > 1 && (
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setPickerPage((p) => Math.max(1, p - 1))}
                    className="p-1 rounded-lg border border-white/5 bg-zinc-800 text-zinc-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Previous page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-xs text-zinc-400 font-medium">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    onClick={() => setPickerPage((p) => Math.min(totalPages, p + 1))}
                    className="p-1 rounded-lg border border-white/5 bg-zinc-800 text-zinc-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Next page"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowAnimePicker(false)}
                className="px-4 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold border border-white/10 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
