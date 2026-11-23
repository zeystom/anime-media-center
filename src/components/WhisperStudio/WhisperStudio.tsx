import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  Download,
  Sparkles,
  Music,
  HelpCircle,
} from 'lucide-react';
import {
  AnimeFolder,
  Episode,
  AudioTrack,
  WhisperLogMessage,
  WhisperQueueItem,
  WhisperLiveCue,
  WhisperOptions,
  SingingSuppressionMode,
  WhisperEngineDownloadProgress,
} from '../../types';
import { cleanSeriesTitle, cleanEpisodeTitle, formatFileSize } from '../../utils/format';
import { computeRangeDragSelection, resolveEpisodeCardIndexFromPoint } from '../../utils/episodeSelection';
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

const WhisperStudioImpl: React.FC<WhisperStudioProps> = ({
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
  const selectedFolderRef = useRef<string>(selectedFolder);
  selectedFolderRef.current = selectedFolder;

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
  const [loadingEpisodes, setLoadingEpisodes] = useState<boolean>(false);
  const loadedFolderRef = useRef<string>(
    initialFolder?.episodes?.length ? (initialFolder?.folderPath || '') : ''
  );
  const [sampleAudioTracks, setSampleAudioTracks] = useState<AudioTrack[]>([]);
  const [selectedAudioTrackNum, setSelectedAudioTrackNum] = useState<number>(1);
  const [isAudioTracksExpanded, setIsAudioTracksExpanded] = useState<boolean>(false);
  const [probing, setProbing] = useState<boolean>(false);

  // Episode selection & filter
  const [selectedEpisodePaths, setSelectedEpisodePaths] = useState<Set<string>>(new Set());
  const [episodeFilter, setEpisodeFilter] = useState<'all' | 'missing'>('all');

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
  const [isEditingPrompt, setIsEditingPrompt] = useState<boolean>(false);

  // Auto-detected Character Names state
  const [detectedCharacters, setDetectedCharacters] = useState<string[]>([]);
  const [detectedHotwords, setDetectedHotwords] = useState<string>('');
  const [detectedAllCharacterNames, setDetectedAllCharacterNames] = useState<string[]>([]);
  const [isDetectingCharacters, setIsDetectingCharacters] = useState<boolean>(false);
  const [detectedAnimeTitle, setDetectedAnimeTitle] = useState<string>('');
  const [userPromptOverride, setUserPromptOverride] = useState<string | null>(null);
  const [disabledCharacters, setDisabledCharacters] = useState<Set<string>>(() => new Set());
  const [activeModel, setActiveModel] = useState<string>('large-v3-turbo');
  const [availableModels, setAvailableModels] = useState<string[]>(['large-v3-turbo']);
  const [downloadingModelName, setDownloadingModelName] = useState<string | null>(null);
  const [downloadingModelPercent, setDownloadingModelPercent] = useState<number | null>(null);
  const [isDownloadingEngine, setIsDownloadingEngine] = useState<boolean>(false);
  const [engineDownloadProgress, setEngineDownloadProgress] = useState<WhisperEngineDownloadProgress | null>(null);

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
      if (status?.isDownloadingEngine && status?.engineDownloadProgress) {
        setIsDownloadingEngine(true);
        setEngineDownloadProgress(status.engineDownloadProgress);
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

  // Refresh models when the tab becomes active, but throttle the disk scans
  // behind it: rapid tab switches re-ran check-binaries (model directory
  // walks) on every entry and stuttered the transition.
  const lastModelsRefreshRef = useRef(0);
  useEffect(() => {
    if (!isActiveTab) return;
    const now = Date.now();
    if (now - lastModelsRefreshRef.current < 20_000) return;
    lastModelsRefreshRef.current = now;
    refreshModels();
  }, [refreshModels, isActiveTab]);

  // Subtitle Filter & Prompt Preferences
  const [skipOpEd, setSkipOpEd] = useState<boolean>(true);
  const [suppressSinging, setSuppressSinging] = useState<SingingSuppressionMode>('off');

  // Restore saved tuning preferences from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_WHISPER_TUNING);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.skipOpEd !== undefined) setSkipOpEd(Boolean(parsed.skipOpEd));
        if (parsed.suppressSinging !== undefined) {
          const val = parsed.suppressSinging;
          setSuppressSinging(
            val === 'balanced' || val === 'strict' || val === 'off'
              ? val
              : val === true
              ? 'strict'
              : 'off'
          );
        }
        if (typeof parsed.userPromptOverride === 'string') {
          const savedPrompt = parsed.userPromptOverride.trim();
          if (savedPrompt && !/^(?:Dialogue|Characters)\s+from\s+an\s+anime\s+episode\b/i.test(savedPrompt)) {
            setUserPromptOverride(parsed.userPromptOverride);
          }
        }
      }
    } catch {}
  }, []);

  // Save tuning preferences to localStorage when changed
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY_WHISPER_TUNING,
        JSON.stringify({
          skipOpEd,
          suppressSinging,
          userPromptOverride,
        })
      );
    } catch {}
  }, [skipOpEd, suppressSinging, userPromptOverride]);

  // Synchronize initialFolder when user opens Whisper from library (unless job is running)
  useEffect(() => {
    if (initialFolder?.folderPath && !isProcessing) {
      const nextNorm = initialFolder.folderPath.replace(/[/\\]+$/, '').toLowerCase();
      const prevNorm = selectedFolderRef.current.replace(/[/\\]+$/, '').toLowerCase();
      if (nextNorm !== prevNorm) {
        setLoadingEpisodes(true);
        setEpisodes([]);
        setSelectedEpisodePaths(new Set());
        setSampleAudioTracks([]);
      }
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
    setLoadingEpisodes(true);

    const normTarget = selectedFolder.replace(/[/\\]+$/, '').toLowerCase();
    const normLoaded = loadedFolderRef.current.replace(/[/\\]+$/, '').toLowerCase();
    if (normLoaded !== normTarget) {
      setEpisodes([]);
      setSelectedEpisodePaths(new Set());
      setSampleAudioTracks([]);
    }

    (async () => {
      try {
        const eps = await window.electronAPI.getFolderEpisodes(selectedFolder);
        if (!isMounted) return;
        loadedFolderRef.current = selectedFolder;
        setEpisodes(eps);
        setLoadingEpisodes(false);

        // Pre-select all episodes that do not have AI-generated subtitles (.whisper.srt) yet
        const episodesNeedingAiSubs = eps.filter((e) => !e.hasWhisperSrt);
        if (episodesNeedingAiSubs.length > 0) {
          setSelectedEpisodePaths(new Set(episodesNeedingAiSubs.map((e) => e.filePath)));
          setEpisodeFilter('all');
        } else {
          // All episodes already have AI subtitles: keep selection empty
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
        if (isMounted) {
          setLoadingEpisodes(false);
          setProbing(false);
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [selectedFolder]);

  // Auto-detect character names via AniList API when anime folder changes
  useEffect(() => {
    setDetectedCharacters([]);
    setDetectedHotwords('');
    setDetectedAllCharacterNames([]);
    setDetectedAnimeTitle('');
    setUserPromptOverride(null);
    setDisabledCharacters(new Set());

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
          if (res.hotwords) setDetectedHotwords(res.hotwords);
          if (res.allCharacterNames) setDetectedAllCharacterNames(res.allCharacterNames);
        } else {
          setDetectedCharacters([]);
          setDetectedHotwords('');
          setDetectedAllCharacterNames([]);
        }
      } catch {
        if (isMounted) {
          setDetectedCharacters([]);
          setDetectedHotwords('');
          setDetectedAllCharacterNames([]);
        }
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

    const unsubEpisodeDone = window.electronAPI?.onWhisperEpisodeDone?.((data) => {
      const targetName = (data.fileName || '').toLowerCase();
      const targetPath = (data.filePath || '').replace(/[/\\]+/g, '/').toLowerCase();

      const isMatch = (name?: string, path?: string) => {
        const n = (name || '').toLowerCase();
        const p = (path || '').replace(/[/\\]+/g, '/').toLowerCase();
        return n === targetName || p === targetPath || (targetName && p.endsWith('/' + targetName)) || (n && targetPath.endsWith('/' + n));
      };

      setEpisodes((prev) =>
        prev.map((e) => {
          if (isMatch(e.fileName, e.filePath)) {
            return { ...e, hasWhisperSrt: true, hasExternalSrt: true };
          }
          return e;
        })
      );

      // Deselect the completed episode from the selection set so it is not re-transcribed
      setSelectedEpisodePaths((prev) => {
        const next = new Set(prev);
        for (const p of next) {
          const normP = p.replace(/[/\\]+/g, '/').toLowerCase();
          if (normP === targetPath || (data.fileName && normP.endsWith(targetName))) {
            next.delete(p);
          }
        }
        return next;
      });

      // Update libraryFolders immediately so top banner stats update reactively
      setLibraryFolders((prev) =>
        prev.map((f) => {
          if (f.episodes && f.episodes.length > 0) {
            const hasMatch = f.episodes.some((e) => isMatch(e.fileName, e.filePath));
            if (hasMatch) {
              const updatedEpisodes = f.episodes.map((e) =>
                isMatch(e.fileName, e.filePath)
                  ? { ...e, hasWhisperSrt: true, hasExternalSrt: true }
                  : e
              );
              return {
                ...f,
                episodes: updatedEpisodes,
                hasWhisperCount: updatedEpisodes.filter((e) => e.hasWhisperSrt).length,
                hasSubtitlesCount: updatedEpisodes.filter((e) => e.hasExternalSrt).length,
              };
            }
          }
          return f;
        })
      );

      const folderToFetch = selectedFolderRef.current;
      if (folderToFetch) {
        window.electronAPI.getFolderEpisodes(folderToFetch).then((freshEps) => {
          if (freshEps && freshEps.length > 0) {
            setEpisodes(freshEps);
          }
        }).catch(() => {});
      }
      onRefreshLibrary();
    });

    const unsubDone = window.electronAPI.onWhisperDone(() => {
      setIsProcessing(false);
      setCurrentFile('');
      const folderToFetch = selectedFolderRef.current;
      if (folderToFetch) {
        window.electronAPI.getFolderEpisodes(folderToFetch).then((freshEps) => {
          if (freshEps && freshEps.length > 0) {
            setEpisodes(freshEps);
          }
        }).catch(() => {});
      }
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

    const unsubEngineStatus = window.electronAPI?.onWhisperEngineDownloadProgress?.((data) => {
      setEngineDownloadProgress(data);
      setIsDownloadingEngine(data.isDownloading);
      if (data.phase === 'completed') {
        refreshModels();
        onRefreshLibrary();
        showGlobalToast('Faster-Whisper-XXL engine installed and configured!', 'success');
      } else if (data.phase === 'error' && data.error) {
        showGlobalToast(data.error, 'error');
      }
    });

    return () => {
      unsubLog();
      unsubProgress();
      unsubDone();
      if (unsubEpisodeDone) unsubEpisodeDone();
      if (unsubModelStatus) unsubModelStatus();
      if (unsubModelProg) unsubModelProg();
      if (unsubEngineStatus) unsubEngineStatus();
    };
  }, [onRefreshLibrary, refreshModels]);

  const handleDownloadEngine = async () => {
    if (!window.electronAPI?.downloadWhisperEngine) return;
    setIsDownloadingEngine(true);
    try {
      const res = await window.electronAPI.downloadWhisperEngine();
      if (!res.success && res.error) {
        showGlobalToast(res.error, 'error');
      }
    } catch (err: any) {
      showGlobalToast(err?.message || 'Failed to start engine download', 'error');
    }
  };

  const handleCancelEngineDownload = async () => {
    if (!window.electronAPI?.cancelWhisperEngineDownload) return;
    try {
      await window.electronAPI.cancelWhisperEngineDownload();
      setIsDownloadingEngine(false);
      setEngineDownloadProgress(null);
      showGlobalToast('Engine download cancelled', 'info');
    } catch (err) {
      console.error(err);
    }
  };

  // Optional custom prompt (blank by default so Whisper's auto-prompting avoids leaks/skips)
  const customPrompt = (userPromptOverride || '').trim();

  const buildWhisperOptions = (selectivePaths?: string[]): WhisperOptions => {
    const rawCorrectionNames =
      detectedAllCharacterNames.length > 0
        ? detectedAllCharacterNames
        : detectedCharacters;
    const activeCorrectionNames = rawCorrectionNames.filter(
      (name) => !disabledCharacters.has(name.toLowerCase())
    );

    return {
      preset: 'anime',
      model: activeModel || 'large-v3-turbo',
      language: 'en',
      task: 'transcribe',
      vadMethod: 'pyannote_v3',
      vadThreshold: 0.28,
      vadMinSpeechDurationMs: 100,
      vadMinSilenceDurationMs: 800,
      vadSpeechPadMs: 350,
      vadMaxSpeechDurationS: 15,
      conditionOnPreviousText: false,
      reprompt: true,
      v3OffsetsOff: true,
      compressionRatioThreshold: 2.4,
      noSpeechThreshold: 0.7,
      hallucinationSilenceThreshold: 0,
      initialPrompt: customPrompt || undefined,
      hotwords: detectedHotwords || undefined,
      characterNamesForCorrection: activeCorrectionNames.length > 0 ? activeCorrectionNames : undefined,
      maxLineWidth: 46,
      maxLineCount: 2,
      maxCommaCent: 70,
      mergeSingleWords: true,
      minDistToEnd: 8,
      sentence: true,
      channelMode: 'auto',
      speechNorm: false,
      skipOpEd,
      suppressSinging,
      animeTitle: currentAnime?.canonicalTitle || cleanSeriesTitle(currentAnime?.folderName || selectedFolder) || undefined,
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
        text: `Starting Whisper generation for folder: ${selectedFolder} (Audio Track: ${selectedAudioTrackNum})`,
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

  const filteredEpisodes =
    episodeFilter === 'missing'
      ? episodes.filter((e) => !e.hasWhisperSrt)
      : episodes;

  // Phone-gallery style contiguous range drag selection: press card A to set
  // anchor + mode (select or deselect), then drag straight to card B across
  // rows — every episode between A and B updates live, and pulling back reverts.
  const episodeGridScrollRef = useRef<HTMLDivElement | null>(null);
  const lastEpisodeAnchorRef = useRef<number | null>(null);
  const dragPointerPosRef = useRef<{ x: number; y: number } | null>(null);
  const dragAutoScrollRafRef = useRef<number | null>(null);

  const episodeDragRef = useRef<{
    active: boolean;
    select: boolean;
    anchorIndex: number;
    lastTargetIndex: number;
    orderedPaths: string[];
    baseSelection: Set<string>;
  } | null>(null);

  const applyRangeTarget = useCallback((targetIndex: number) => {
    const drag = episodeDragRef.current;
    if (!drag?.active || targetIndex < 0 || targetIndex >= drag.orderedPaths.length) return;
    if (drag.lastTargetIndex === targetIndex) return;
    drag.lastTargetIndex = targetIndex;
    setSelectedEpisodePaths(
      computeRangeDragSelection({
        orderedPaths: drag.orderedPaths,
        baseSelection: drag.baseSelection,
        anchorIndex: drag.anchorIndex,
        targetIndex,
        select: drag.select,
      })
    );
  }, []);

  const stopDragAutoScroll = useCallback(() => {
    if (dragAutoScrollRafRef.current !== null) {
      cancelAnimationFrame(dragAutoScrollRafRef.current);
      dragAutoScrollRafRef.current = null;
    }
  }, []);

  const endEpisodeDrag = useCallback(() => {
    episodeDragRef.current = null;
    dragPointerPosRef.current = null;
    stopDragAutoScroll();
  }, [stopDragAutoScroll]);

  useEffect(() => {
    lastEpisodeAnchorRef.current = null;
    endEpisodeDrag();
  }, [selectedFolder, episodeFilter, endEpisodeDrag]);

  useEffect(() => {
    window.addEventListener('pointerup', endEpisodeDrag);
    window.addEventListener('pointercancel', endEpisodeDrag);
    return () => {
      window.removeEventListener('pointerup', endEpisodeDrag);
      window.removeEventListener('pointercancel', endEpisodeDrag);
      stopDragAutoScroll();
    };
  }, [endEpisodeDrag, stopDragAutoScroll]);

  const stepDragAutoScroll = useCallback(() => {
    const drag = episodeDragRef.current;
    const pos = dragPointerPosRef.current;
    const scrollEl = episodeGridScrollRef.current;
    if (!drag?.active || !pos || !scrollEl) {
      dragAutoScrollRafRef.current = null;
      return;
    }

    const rect = scrollEl.getBoundingClientRect();
    const edge = 32;
    let deltaY = 0;
    if (pos.y < rect.top + edge) {
      deltaY = -Math.max(4, Math.round(((rect.top + edge - pos.y) / edge) * 14));
    } else if (pos.y > rect.bottom - edge) {
      deltaY = Math.max(4, Math.round(((pos.y - (rect.bottom - edge)) / edge) * 14));
    }

    if (deltaY !== 0) {
      const prevTop = scrollEl.scrollTop;
      scrollEl.scrollTop += deltaY;
      if (scrollEl.scrollTop !== prevTop) {
        const targetIndex = resolveEpisodeCardIndexFromPoint(
          drag.orderedPaths,
          scrollEl,
          pos.x,
          pos.y
        );
        if (targetIndex !== -1) applyRangeTarget(targetIndex);
      }
      dragAutoScrollRafRef.current = requestAnimationFrame(stepDragAutoScroll);
    } else {
      dragAutoScrollRafRef.current = null;
    }
  }, [applyRangeTarget]);

  const beginEpisodeDrag = (ep: Episode, event: React.PointerEvent<HTMLDivElement>) => {
    if (isProcessing || event.button !== 0) return;
    const orderedPaths = filteredEpisodes.map((e) => e.filePath);
    const clickedIndex = orderedPaths.indexOf(ep.filePath);
    if (clickedIndex === -1) return;

    const baseSelection = new Set(selectedEpisodePaths);
    const hasPriorAnchor =
      event.shiftKey &&
      lastEpisodeAnchorRef.current !== null &&
      lastEpisodeAnchorRef.current >= 0 &&
      lastEpisodeAnchorRef.current < orderedPaths.length;

    const anchorIndex = hasPriorAnchor ? lastEpisodeAnchorRef.current! : clickedIndex;
    const anchorPath = orderedPaths[anchorIndex];
    const select = hasPriorAnchor
      ? baseSelection.has(anchorPath) || !baseSelection.has(ep.filePath)
      : !baseSelection.has(ep.filePath);

    if (!hasPriorAnchor) {
      lastEpisodeAnchorRef.current = clickedIndex;
    }

    episodeDragRef.current = {
      active: true,
      select,
      anchorIndex,
      lastTargetIndex: clickedIndex,
      orderedPaths,
      baseSelection,
    };
    dragPointerPosRef.current = { x: event.clientX, y: event.clientY };

    setSelectedEpisodePaths(
      computeRangeDragSelection({
        orderedPaths,
        baseSelection,
        anchorIndex,
        targetIndex: clickedIndex,
        select,
      })
    );

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
  };

  const handleEpisodeDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = episodeDragRef.current;
    if (!drag?.active) return;

    dragPointerPosRef.current = { x: event.clientX, y: event.clientY };
    const scrollEl = episodeGridScrollRef.current;
    const targetIndex = resolveEpisodeCardIndexFromPoint(
      drag.orderedPaths,
      scrollEl,
      event.clientX,
      event.clientY
    );
    if (targetIndex !== -1) {
      applyRangeTarget(targetIndex);
    }

    if (scrollEl && dragAutoScrollRafRef.current === null) {
      const rect = scrollEl.getBoundingClientRect();
      if (event.clientY < rect.top + 32 || event.clientY > rect.bottom - 32) {
        dragAutoScrollRafRef.current = requestAnimationFrame(stepDragAutoScroll);
      }
    }
  };

  const hasSubtitles = (e: (typeof episodes)[0]) =>
    Boolean(e.hasWhisperSrt || e.hasEmbeddedDubtitles || e.hasExternalSrt || e.hasEmbeddedSubtitles);

  const existingWhisperCount = episodes.filter((e) => e.hasWhisperSrt).length;
  const existingAnySubCount = episodes.filter(hasSubtitles).length;
  const missingAnySubCount = episodes.length - existingAnySubCount;
  const missingWhisperCount = episodes.length - existingWhisperCount;

  const engTrackIndex = sampleAudioTracks.findIndex(
    (t) => t.language === 'eng' || t.language === 'en' || /english/i.test(t.title)
  );
  const isEngAutoDetected = engTrackIndex !== -1 && selectedAudioTrackNum === engTrackIndex + 1;
  const selectedTrack = sampleAudioTracks[selectedAudioTrackNum - 1];

  // Active generation queue index
  const currentQueueIndex = queue.findIndex((q) => q.status === 'processing');
  const activeProcessingEpisode = currentFile ? cleanEpisodeTitle(currentFile) : null;

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden bg-[#07060A] p-6 space-y-5">
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
              className="btn-glass flex items-center space-x-2 px-5 py-2.5 rounded-xl text-rose-200 font-bold text-xs transition-all active:scale-95"
            >
              <StopCircle className="w-4 h-4" />
              <span>Cancel Queue</span>
            </button>
          ) : (
            <button
              onClick={handleStartSeason}
              disabled={!selectedFolder || episodes.length === 0 || probing || !whisperExists || selectedEpisodePaths.size === 0 || Boolean(downloadingModelName)}
              title={downloadingModelName ? `Cannot start generation: model "${downloadingModelName}" is downloading` : undefined}
              className="btn-primary flex items-center space-x-2 px-6 py-2.5 rounded-xl text-white font-bold text-xs transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
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

      {/* Missing Whisper Binary Alert & In-App Setup */}
      {!whisperExists && (
        <div className="p-4 rounded-2xl bg-gradient-to-r from-purple-950/40 via-zinc-900 to-indigo-950/30 border border-purple-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-zinc-200 shadow-md shrink-0">
          <div className="flex items-start space-x-3 min-w-0 flex-1">
            <AlertCircle className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0 flex-1">
              <div className="font-semibold text-white text-sm">
                Faster-Whisper Engine Not Installed
              </div>
              {isDownloadingEngine ? (
                <div className="space-y-1.5 pt-1 max-w-xl">
                  <div className="flex items-center justify-between text-xs text-zinc-300">
                    <span className="flex items-center space-x-1.5">
                      <Download className="w-3.5 h-3.5 text-purple-400 animate-bounce" />
                      <span className="font-medium text-white">
                        {engineDownloadProgress?.phase === 'extracting'
                          ? 'Extracting Faster-Whisper-XXL engine files...'
                          : `Downloading engine: ${engineDownloadProgress?.percent ?? 0}%`}
                      </span>
                    </span>
                    <span className="font-mono text-purple-300 text-[11px]">
                      {engineDownloadProgress?.phase === 'extracting'
                        ? 'Please wait...'
                        : `${formatFileSize(engineDownloadProgress?.transferred ?? 0)} / ${formatFileSize(engineDownloadProgress?.total ?? 0)}`}
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                    {engineDownloadProgress?.phase === 'extracting' ? (
                      <div className="h-full w-full bg-gradient-to-r from-purple-500 via-indigo-500 to-purple-500 animate-pulse" />
                    ) : (
                      <div
                        className="h-full bg-gradient-to-r from-purple-500 to-indigo-500 transition-[width] duration-150"
                        style={{ width: `${Math.max(2, Math.min(100, engineDownloadProgress?.percent ?? 0))}%` }}
                      />
                    )}
                  </div>
                  {engineDownloadProgress?.phase !== 'extracting' && engineDownloadProgress?.bytesPerSecond ? (
                    <div className="text-[10px] text-zinc-400 font-mono">
                      Speed: {formatFileSize(engineDownloadProgress.bytesPerSecond)}/s
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="text-[11px] text-zinc-300 leading-relaxed">
                  Faster-Whisper-XXL is required to generate AI speech-to-text subtitles. You can download and install it in one click directly inside Kaiko.
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center space-x-2 shrink-0 self-end sm:self-center">
            {isDownloadingEngine ? (
              <button
                type="button"
                onClick={handleCancelEngineDownload}
                className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 font-medium transition-colors text-xs"
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDownloadEngine}
                className="btn-primary px-3.5 py-1.5 rounded-xl text-white font-semibold transition-all text-xs flex items-center space-x-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Install Engine in Kaiko</span>
              </button>
            )}
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="px-3 py-1.5 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 border border-white/10 font-medium transition-colors text-xs"
              >
                Settings
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
          <div className="rounded-2xl glass-panel space-y-3 shadow-md p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                1. Anime
              </span>

              {/* Custom-folder browsing lives inside the anime picker's footer
                  ("Browse folder on disk..."), so no separate icon button here. */}
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
                    {loadingEpisodes ? (
                      <span className="inline-flex items-center space-x-1.5 text-indigo-300 font-medium animate-pulse">
                        <span className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
                        <span>Scanning episodes...</span>
                      </span>
                    ) : (
                      <>
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
                      </>
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
          <div className="rounded-2xl glass-panel space-y-3 shadow-md p-4">
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
                    Audio: <strong className="text-white font-semibold">{selectedTrack?.title || 'English'}</strong>
                  </span>
                </div>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => setIsAudioTracksExpanded(true)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold shrink-0 disabled:opacity-50"
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
                      className="text-xs text-zinc-400 hover:text-white"
                    >
                      Done
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 3: Subtitle Settings */}
          <div className="rounded-2xl glass-panel space-y-3 shadow-md p-4">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 block">
              3. Subtitles &amp; Filters
            </span>

            {/* Active AI Model Selector */}
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-1.5">
                  <span className="font-semibold text-zinc-300">AI Subtitle Model</span>
                </div>
                {onOpenSettings && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="text-[11px] text-indigo-400 hover:text-indigo-300 font-semibold transition-colors"
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
                  className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold shrink-0 disabled:opacity-50"
                >
                  {isEditingPrompt ? 'Close' : detectedCharacters.length > 0 ? 'Edit' : 'Add'}
                </button>
              </div>

              {/* Expandable Character Names & Prompt Editor */}
              {isEditingPrompt && (
                <div className="p-3 rounded-xl bg-zinc-900/90 border border-zinc-800 space-y-2.5">
                  <div className="flex items-center justify-between text-[11px] text-zinc-400">
                    <span>Custom Whisper prompt (optional — leave blank for best accuracy):</span>
                    <button
                      type="button"
                      disabled={isProcessing || !userPromptOverride}
                      onClick={() => setUserPromptOverride(null)}
                      className="text-[10px] text-zinc-400 hover:text-white disabled:opacity-50"
                    >
                      Clear
                    </button>
                  </div>

                  <input
                    type="text"
                    disabled={isProcessing}
                    value={userPromptOverride ?? ''}
                    onChange={(e) => setUserPromptOverride(e.target.value || null)}
                    placeholder="Leave blank so Whisper won't skip lines or leak text; character names auto-correct after generation."
                    className="w-full px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-xs text-zinc-100 focus:outline-none focus:border-indigo-500 font-sans"
                  />

                  {detectedCharacters.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <span className="text-[10px] text-zinc-500 block">
                        Toggle spelling auto-correction for {detectedAnimeTitle || 'this series'}:
                      </span>
                      <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto scrollbar-thin pr-1">
                        {detectedCharacters.map((char) => {
                          const key = char.toLowerCase();
                          const isEnabled = !disabledCharacters.has(key);
                          return (
                            <button
                              key={char}
                              type="button"
                              disabled={isProcessing}
                              onClick={() => {
                                setDisabledCharacters((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(key)) {
                                    next.delete(key);
                                  } else {
                                    next.add(key);
                                  }
                                  return next;
                                });
                              }}
                              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                                isEnabled
                                  ? 'bg-indigo-600/30 text-indigo-200 border-indigo-500/60'
                                  : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-white'
                              }`}
                            >
                              {isEnabled ? `✓ ${char}` : `+ ${char}`}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Opening & Music Filter (Always Visible) */}
            <div className="pt-2.5 border-t border-zinc-800/60 space-y-2">
              <div className="flex items-center space-x-1.5 text-xs text-zinc-300">
                <Music className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span className="font-semibold">Opening &amp; Music Filter</span>
              </div>

              <div className="space-y-1.5">
                <div
                  onClick={() => {
                    if (!isProcessing) setSkipOpEd((prev) => !prev);
                  }}
                  className={`flex items-center justify-between gap-3 p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80 transition-colors ${
                    isProcessing ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-zinc-700/80'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs font-medium text-zinc-200">
                      Skip Opening &amp; Ending (OP / ED)
                    </span>
                    <div className="relative group/help shrink-0">
                      <button
                        type="button"
                        aria-label="About Skip Opening and Ending"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-zinc-500 hover:text-rose-300 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:text-rose-300 transition-colors"
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                      </button>
                      <div
                        role="tooltip"
                        className="pointer-events-none opacity-0 translate-y-1 group-hover/help:opacity-100 group-hover/help:translate-y-0 group-focus-within/help:opacity-100 group-focus-within/help:translate-y-0 transition-all duration-150 absolute bottom-full left-0 mb-2 w-72 p-3 rounded-xl glass-dropdown z-50"
                      >
                        <p className="text-xs font-semibold text-zinc-100 mb-1">
                          Skip Opening &amp; Ending (OP / ED)
                        </p>
                        <p className="text-[11px] leading-relaxed text-zinc-300">
                          Ignores lyrics in detected OP/ED using MKV chapters &amp; AniSkip. Turn off if characters talk over credits.
                        </p>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={skipOpEd}
                    aria-label="Skip Opening and Ending"
                    disabled={isProcessing}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSkipOpEd((prev) => !prev);
                    }}
                    className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-200 shrink-0 disabled:opacity-50 ${
                      skipOpEd ? 'bg-indigo-600' : 'bg-zinc-700'
                    }`}
                  >
                    <div
                      className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                        skipOpEd ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                <div className="p-2.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-xs font-medium text-zinc-200">
                        Suppress singing &amp; music
                      </span>
                      <div className="relative group/help shrink-0">
                        <button
                          type="button"
                          aria-label="About Suppress singing and music"
                          className="inline-flex items-center justify-center w-4 h-4 rounded-full text-zinc-500 hover:text-rose-300 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:text-rose-300 transition-colors"
                        >
                          <HelpCircle className="w-3.5 h-3.5" />
                        </button>
                        <div
                          role="tooltip"
                          className="pointer-events-none opacity-0 translate-y-1 group-hover/help:opacity-100 group-hover/help:translate-y-0 group-focus-within/help:opacity-100 group-focus-within/help:translate-y-0 transition-all duration-150 absolute bottom-full left-0 mb-2 w-80 p-3 rounded-xl glass-dropdown z-50 space-y-1.5"
                        >
                          <p className="text-xs font-semibold text-zinc-100">
                            Suppress singing &amp; music
                          </p>
                          <ul className="space-y-1 text-[11px] leading-relaxed text-zinc-300">
                            <li className={suppressSinging === 'off' ? 'text-zinc-100' : 'text-zinc-400'}>
                              <span className={`font-semibold ${suppressSinging === 'off' ? 'text-rose-300' : 'text-zinc-200'}`}>Off</span>
                              <span className="ml-1.5 inline-flex items-center px-1.5 py-px rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[9px] font-semibold uppercase tracking-wide align-middle">
                                Recommended
                              </span>
                              <span className="font-semibold">:</span> Keeps audio untouched (OP/ED skip still works).
                            </li>
                            <li className={suppressSinging === 'balanced' ? 'text-zinc-100' : 'text-zinc-400'}>
                              <span className={`font-semibold ${suppressSinging === 'balanced' ? 'text-rose-300' : 'text-zinc-200'}`}>Balanced:</span> Dampens BGM &amp; singing (~60%) while keeping quiet or high-pitched voices intact.
                            </li>
                            <li className={suppressSinging === 'strict' ? 'text-zinc-100' : 'text-zinc-400'}>
                              <span className={`font-semibold ${suppressSinging === 'strict' ? 'text-rose-300' : 'text-zinc-200'}`}>Strict:</span> Heavy neural filter for insert songs; may drop 20–30% of quiet or high-pitched speech.
                            </li>
                          </ul>
                        </div>
                      </div>
                    </div>
                    <div
                      role="radiogroup"
                      aria-label="Suppress singing and music"
                      className="inline-flex items-center p-0.5 rounded-lg bg-zinc-950/80 border border-zinc-800 shrink-0"
                    >
                      {(
                        [
                          { id: 'off', label: 'Off' },
                          { id: 'balanced', label: 'Balanced' },
                          { id: 'strict', label: 'Strict' },
                        ] as const
                      ).map((opt) => {
                        const active = suppressSinging === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            disabled={isProcessing}
                            onClick={() => setSuppressSinging(opt.id)}
                            className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors disabled:opacity-50 ${
                              active
                                ? 'bg-indigo-600 text-white shadow-sm'
                                : 'text-zinc-400 hover:text-zinc-200'
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
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
                  {currentSpeed?.includes('Downloading model') ? (
                    <span className="inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse">
                      <span>Downloading AI Model...</span>
                    </span>
                  ) : (
                    <>
                      {currentSpeed && (
                        <span className="font-mono text-zinc-400 text-xs">{currentSpeed}</span>
                      )}
                      <span className="font-mono font-bold text-indigo-400 text-sm">
                        {overallProgress}%
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-rose-600 via-rose-500 to-rose-300 rounded-full transition-all duration-300"
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
          <div className="flex-1 rounded-2xl glass-panel flex flex-col min-h-[220px] overflow-hidden shadow-md">
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
                <span className="hidden xl:inline text-[10px] font-medium text-zinc-600">
                  Click to select · hold &amp; drag to sweep multiple
                </span>
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
                  Needs AI Subtitles ({missingWhisperCount})
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

            {/* Episode Cards Grid — click toggles; hold + drag selects contiguous ranges
                from start card to target card (phone-gallery style). */}
            <div
              ref={episodeGridScrollRef}
              className="flex-1 p-3 overflow-y-auto scrollbar-thin select-none"
              onPointerMove={handleEpisodeDragMove}
              onPointerUp={endEpisodeDrag}
              onPointerCancel={endEpisodeDrag}
            >
              {loadingEpisodes ? (
                <div className="space-y-3">
                  <div className="flex items-center space-x-2.5 px-1 py-1 text-xs text-zinc-400">
                    <div className="h-4 w-4 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin shrink-0" />
                    <span>Scanning episodes for selected anime...</span>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
                    {Array.from({ length: 8 }).map((_, idx) => (
                      <div
                        key={idx}
                        className="overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-900/40"
                      >
                        <div className="aspect-video bg-zinc-900/90 animate-pulse" />
                        <div className="p-2 space-y-2">
                          <div className="h-3 w-3/4 rounded bg-zinc-800/80 animate-pulse" />
                          <div className="h-2.5 w-1/2 rounded bg-zinc-800/50 animate-pulse" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : episodes.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-zinc-500 text-xs p-6 text-center">
                  <span>No episodes loaded. Select an anime folder to view episodes.</span>
                </div>
              ) : filteredEpisodes.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-zinc-500 text-xs p-6 text-center">
                  <span>All episodes already have subtitles! Switch filter to "All" to re-generate.</span>
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
                  {filteredEpisodes.map((ep) => {
                    const parsed = cleanEpisodeTitle(ep.fileName);
                    const isSelected = selectedEpisodePaths.has(ep.filePath);
                    const isCurrent = currentFile && ep.fileName === currentFile;
                    const queueMatch = queue.find((q) => q.filePath === ep.filePath || q.fileName === ep.fileName);
                    const thumb = ep.thumbnailUrl || ep.kitsuThumbnail || null;

                    let statusBadge: React.ReactNode;
                    if (isCurrent) {
                      statusBadge = currentSpeed?.includes('Downloading model') ? (
                        <span className="font-mono font-bold text-amber-400 animate-pulse">Downloading model…</span>
                      ) : (
                        <span className="flex items-center space-x-1 font-mono font-bold text-indigo-400 animate-pulse">
                          <span>{overallProgress}%</span>
                          {currentSpeed && <span className="text-zinc-400">({currentSpeed})</span>}
                        </span>
                      );
                    } else if (isProcessing && queueMatch) {
                      statusBadge = queueMatch.status === 'completed' ? (
                        <span className="inline-flex items-center space-x-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 font-semibold text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" />
                          <span>Done</span>
                        </span>
                      ) : queueMatch.status === 'processing' ? (
                        <span className="font-mono font-bold text-indigo-400 animate-pulse">Running</span>
                      ) : queueMatch.status === 'failed' ? (
                        <span className="font-semibold text-red-400">Failed</span>
                      ) : (
                        <span className="text-zinc-500">Queued</span>
                      );
                    } else if (ep.hasWhisperSrt) {
                      statusBadge = (
                        <span className="inline-flex items-center space-x-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 font-semibold text-emerald-400" title="Whisper AI subtitle ready (.whisper.srt)">
                          <CheckCircle2 className="h-3 w-3" />
                          <span>Done</span>
                        </span>
                      );
                    } else if (ep.hasEmbeddedDubtitles) {
                      statusBadge = <span className="rounded border border-purple-500/30 bg-purple-500/15 px-1.5 py-0.5 font-semibold text-purple-300" title="Embedded English Dubtitles (SDH)">Dub Sub</span>;
                    } else if (ep.hasExternalSrt) {
                      statusBadge = <span className="rounded border border-blue-500/30 bg-blue-500/15 px-1.5 py-0.5 font-semibold text-blue-300" title="External Subtitle ready (.srt)">Ext Sub</span>;
                    } else if (ep.hasEmbeddedSubtitles) {
                      statusBadge = <span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-semibold text-emerald-300" title="Embedded Subtitles">Sub</span>;
                    } else {
                      statusBadge = <span className="text-zinc-600">No subtitles</span>;
                    }

                    return (
                      <div
                        key={ep.filePath}
                        data-episode-card={ep.filePath}
                        onPointerDown={(event) => beginEpisodeDrag(ep, event)}
                        title={ep.fileName}
                        className={`group relative overflow-hidden rounded-xl border transition-all ${
                          isCurrent
                            ? 'border-indigo-500/70 bg-zinc-900/80 ring-2 ring-indigo-500/40'
                            : isSelected
                            ? 'border-indigo-400/60 bg-zinc-900/80 ring-1 ring-indigo-500/30'
                            : ep.hasWhisperSrt
                            ? 'border-zinc-800/50 bg-zinc-900/30 opacity-70 hover:opacity-100'
                            : 'border-zinc-800/60 bg-zinc-900/40 hover:border-zinc-700'
                        } ${isProcessing ? 'cursor-default' : 'cursor-pointer'}`}
                      >
                        <div className="relative aspect-video overflow-hidden bg-zinc-950">
                          {thumb ? (
                            <img src={thumb} alt="" draggable={false} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-zinc-700">
                              <Film className="h-6 w-6" />
                            </div>
                          )}
                          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/30" />

                          <span className={`absolute left-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold ${isCurrent ? 'bg-indigo-600 text-white' : 'bg-black/80 text-zinc-200'}`}>
                            {parsed.episodeLabel}
                          </span>

                          {isSelected && (
                            <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500 text-white shadow">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            </span>
                          )}

                          {!isProcessing && !downloadingModelName && (
                            <button
                              type="button"
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={() => handleStartSingleEpisode(ep)}
                              title="Generate this episode"
                              className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-rose-500 text-white opacity-0 shadow transition group-hover:opacity-100 hover:bg-rose-400"
                            >
                              <Play className="h-3 w-3 fill-current" />
                            </button>
                          )}
                        </div>

                        <div className="p-2">
                          <p className={`truncate text-[11px] font-semibold ${isCurrent ? 'text-indigo-300' : ep.hasWhisperSrt ? 'text-zinc-400' : 'text-zinc-200'}`} title={ep.fileName}>
                            {parsed.displayTitle}
                          </p>
                          <div className="mt-1 flex min-h-[18px] items-center text-[10px]">
                            {statusBadge}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Developer Logs Drawer (Collapsed by Default) */}
          <div className="rounded-2xl bg-[#0c0c0e] border border-zinc-800/80 overflow-hidden shadow-lg shrink-0">
            <button
              type="button"
              onClick={() => setShowTerminal((prev) => !prev)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-white/[0.03] hover:bg-zinc-800/60 text-zinc-300 transition-colors"
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
          className="fixed inset-0 z-50 modal-dimmer flex items-center justify-center p-4 animate-in fade-in duration-200"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="modal-glass relative w-full max-w-3xl rounded-2xl flex flex-col max-h-[85vh] overflow-hidden"
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-white/10 shrink-0">
              <div className="flex items-center space-x-2">
                <Film className="w-5 h-5 text-rose-400" />
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
                          const nextNorm = folder.folderPath.replace(/[/\\]+$/, '').toLowerCase();
                          const prevNorm = selectedFolder.replace(/[/\\]+$/, '').toLowerCase();
                          if (nextNorm !== prevNorm) {
                            setLoadingEpisodes(true);
                            setEpisodes([]);
                            setSelectedEpisodePaths(new Set());
                            setSampleAudioTracks([]);
                          }
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
                    const nextNorm = folder.replace(/[/\\]+$/, '').toLowerCase();
                    const prevNorm = selectedFolder.replace(/[/\\]+$/, '').toLowerCase();
                    if (nextNorm !== prevNorm) {
                      setLoadingEpisodes(true);
                      setEpisodes([]);
                      setSelectedEpisodePaths(new Set());
                      setSampleAudioTracks([]);
                    }
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

// Memoized: the studio stays mounted forever, so App-level re-renders (P2P
// bursts, notification churn) must not reconcile this 2000-line tree.
export const WhisperStudio = React.memo(WhisperStudioImpl);
