import React, { useState, useEffect } from 'react';
import {
  FolderOpen,
  Sparkles,
  Volume2,
  StopCircle,
  Play,
  CheckCircle2,
  Check,
} from 'lucide-react';
import { AnimeFolder, Episode, AudioTrack, WhisperLogMessage, WhisperQueueItem } from '../../types';
import { TerminalLog } from './TerminalLog';

interface WhisperStudioProps {
  initialFolder?: AnimeFolder | null;
  onRefreshLibrary: () => void;
}

export const WhisperStudio: React.FC<WhisperStudioProps> = ({
  initialFolder,
  onRefreshLibrary,
}) => {
  const [selectedFolder, setSelectedFolder] = useState<string>(initialFolder?.folderPath || '');
  const [episodes, setEpisodes] = useState<Episode[]>(initialFolder?.episodes || []);
  const [sampleAudioTracks, setSampleAudioTracks] = useState<AudioTrack[]>([]);
  const [selectedAudioTrackNum, setSelectedAudioTrackNum] = useState<number>(1);
  const [skipExistingSrt, setSkipExistingSrt] = useState<boolean>(true);
  const [probing, setProbing] = useState<boolean>(false);

  // Whisper Queue & Execution State
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [currentFile, setCurrentFile] = useState<string>('');
  const [overallProgress, setOverallProgress] = useState<number>(0);
  const [queue, setQueue] = useState<WhisperQueueItem[]>([]);
  const [logs, setLogs] = useState<WhisperLogMessage[]>([]);

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

        if (eps.length > 0) {
          const sampleFile = eps[0].filePath;
          const meta = await window.electronAPI.probeVideo(sampleFile);
          if (!isMounted) return;

          setSampleAudioTracks(meta.audioTracks);

          // Auto-detect English track for --ff_track (1-indexed track number)
          // 1st audio track is track 1, 2nd is track 2...
          let engTrackNum = 1;
          for (let i = 0; i < meta.audioTracks.length; i++) {
            const t = meta.audioTracks[i];
            if (t.language === 'eng' || t.language === 'en' || /english/i.test(t.title)) {
              engTrackNum = i + 1;
              break;
            }
          }
          setSelectedAudioTrackNum(engTrackNum);
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

  // Setup IPC log and progress listeners
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubLog = window.electronAPI.onWhisperLog((log) => {
      setLogs((prev) => [...prev, log]);
    });

    const unsubProgress = window.electronAPI.onWhisperProgress((data) => {
      setCurrentFile(data.currentFile);
      setOverallProgress(data.progress);
      setQueue(data.queue);
      setIsProcessing(true);
    });

    const unsubDone = window.electronAPI.onWhisperDone((_result) => {
      setIsProcessing(false);
      setCurrentFile('');
      onRefreshLibrary();
    });

    return () => {
      unsubLog();
      unsubProgress();
      unsubDone();
    };
  }, [onRefreshLibrary]);

  const handleBrowseFolder = async () => {
    const folder = await window.electronAPI.browseFolder(selectedFolder);
    if (folder) {
      setSelectedFolder(folder);
    }
  };

  const handleStartSeason = async () => {
    if (!selectedFolder) return;
    setIsProcessing(true);
    setLogs((prev) => [
      ...prev,
      {
        type: 'info',
        text: `Starting Whisper batch job for folder: ${selectedFolder} (Audio Track: ${selectedAudioTrackNum})`,
        timestamp: Date.now(),
      },
    ]);

    const res = await window.electronAPI.startWhisperSeason(
      selectedFolder,
      selectedAudioTrackNum,
      skipExistingSrt
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

  const existingSrtCount = episodes.filter((e) => e.hasExternalSrt).length;

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden bg-[#0f0f12] p-6 space-y-6">
      {/* Top Banner / Heading */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-2 border-b border-zinc-800">
        <div>
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
              <Sparkles className="w-4 h-4" />
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight">Whisper Studio</h1>
            <span className="px-2 py-0.5 rounded text-xs font-mono font-bold bg-zinc-800 text-indigo-300 border border-zinc-700">
              large-v3-turbo
            </span>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Batch-generate synchronized English SRT subtitles for local MKV anime seasons using faster-whisper-xxl.
          </p>
        </div>

        {/* Global Action Buttons */}
        <div className="flex items-center space-x-3">
          {isProcessing ? (
            <button
              onClick={handleCancel}
              className="flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow-lg shadow-red-600/30 transition-all"
            >
              <StopCircle className="w-4 h-4" />
              <span>Cancel Queue</span>
            </button>
          ) : (
            <button
              onClick={handleStartSeason}
              disabled={!selectedFolder || episodes.length === 0 || probing}
              className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-indigo-600 hover:from-red-500 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-indigo-600/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="w-4 h-4 fill-white" />
              <span>Generate Subtitles for Season</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Grid: Left Controls (1/3) & Right Live Terminal (2/3) */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0">
        {/* Left Column: Configuration & Audio Selector */}
        <div className="lg:col-span-5 flex flex-col space-y-4 overflow-y-auto pr-1">
          {/* 1. Folder Selection Card */}
          <div className="p-4 rounded-xl bg-[#141418] border border-zinc-800 space-y-3">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 block">
              1. Target Anime Season Folder
            </span>

            <div className="flex items-center space-x-2">
              <input
                type="text"
                readOnly
                value={selectedFolder}
                placeholder="Select an anime season directory..."
                className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700/80 text-xs font-mono text-zinc-200 truncate focus:outline-none"
              />
              <button
                onClick={handleBrowseFolder}
                className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 transition-colors shrink-0"
              >
                <FolderOpen className="w-4 h-4 text-zinc-400" />
                <span>Browse</span>
              </button>
            </div>

            {episodes.length > 0 && (
              <div className="flex items-center justify-between text-xs text-zinc-400 pt-1">
                <span>{episodes.length} MKV episodes detected</span>
                <span className="text-emerald-400 font-semibold">
                  {existingSrtCount} already have .srt
                </span>
              </div>
            )}
          </div>

          {/* 2. Audio Track Selection Card (Auto-highlights English) */}
          <div className="p-4 rounded-xl bg-[#141418] border border-zinc-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center space-x-1.5">
                <Volume2 className="w-4 h-4 text-indigo-400" />
                <span>2. Audio Stream to Transcribe</span>
              </span>
              {probing && <span className="text-[11px] text-zinc-500 animate-pulse">Probing tracks...</span>}
            </div>

            <div className="space-y-2">
              {sampleAudioTracks.length > 0 ? (
                sampleAudioTracks.map((track, idx) => {
                  const trackNum = idx + 1; // 1-indexed for --ff_track
                  const isSelected = selectedAudioTrackNum === trackNum;
                  const isEng = track.language === 'eng' || track.language === 'en';

                  return (
                    <button
                      key={track.audioIndex}
                      onClick={() => setSelectedAudioTrackNum(trackNum)}
                      className={`w-full flex items-center justify-between p-3 rounded-xl text-left transition-all border ${
                        isSelected
                          ? 'bg-indigo-600/20 border-indigo-500 text-white shadow-sm'
                          : 'bg-zinc-900/60 border-zinc-800/80 text-zinc-300 hover:bg-zinc-800/60'
                      }`}
                    >
                      <div className="truncate mr-2">
                        <div className="flex items-center space-x-2">
                          <span className="text-xs font-bold font-mono text-zinc-400">
                            Track #{trackNum}
                          </span>
                          <span className="text-xs font-semibold text-zinc-100 truncate">
                            {track.title}
                          </span>
                          {isEng && (
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                              AUTO-DETECTED ENG
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-zinc-500 mt-0.5">
                          {track.languageName} • {track.codec.toUpperCase()}
                        </div>
                      </div>
                      {isSelected && <Check className="w-4 h-4 text-indigo-400 shrink-0" />}
                    </button>
                  );
                })
              ) : (
                <div className="p-4 text-center rounded-xl bg-zinc-900/40 border border-dashed border-zinc-800 text-zinc-500 text-xs">
                  {probing ? 'Scanning audio tracks...' : 'No audio streams loaded yet.'}
                </div>
              )}
            </div>
          </div>

          {/* 3. Transcription Options */}
          <div className="p-4 rounded-xl bg-[#141418] border border-zinc-800 space-y-3">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 block">
              3. Processing Options
            </span>

            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={skipExistingSrt}
                onChange={(e) => setSkipExistingSrt(e.target.checked)}
                className="w-4 h-4 rounded bg-zinc-900 border-zinc-700 text-red-600 focus:ring-0 cursor-pointer"
              />
              <span className="text-xs font-medium text-zinc-200">
                Skip episodes that already have .srt files
              </span>
            </label>

            <div className="text-[11px] text-zinc-500 space-y-1 pt-1 font-mono">
              <div>• Model: large-v3-turbo (English)</div>
              <div>• Sentence alignment: --sentence --ff_sync</div>
              <div>• Max lines: 2 | Max width: 42 chars</div>
            </div>
          </div>

          {/* Queue Status List if active */}
          {queue.length > 0 && (
            <div className="p-4 rounded-xl bg-[#141418] border border-zinc-800 space-y-2 flex-1 min-h-[140px] overflow-y-auto">
              <div className="flex items-center justify-between text-xs font-bold uppercase text-zinc-400">
                <span>Season Queue ({queue.length})</span>
                <span className="text-indigo-400">
                  {queue.filter((q) => q.status === 'completed').length} / {queue.length} Done
                </span>
              </div>

              <div className="space-y-1.5 pt-1">
                {queue.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-2 rounded-lg bg-zinc-900/60 text-xs text-zinc-300 border border-zinc-800/60"
                  >
                    <span className="truncate max-w-[200px]" title={item.fileName}>
                      {item.fileName}
                    </span>

                    <span className="shrink-0 ml-2">
                      {item.status === 'completed' && (
                        <span className="flex items-center space-x-1 text-emerald-400 text-[11px] font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>Done</span>
                        </span>
                      )}
                      {item.status === 'skipped' && (
                        <span className="text-zinc-500 text-[11px]">Skipped</span>
                      )}
                      {item.status === 'processing' && (
                        <span className="text-indigo-400 font-bold text-[11px] animate-pulse">
                          {item.progress}% {item.speed || ''}
                        </span>
                      )}
                      {item.status === 'pending' && (
                        <span className="text-zinc-500 text-[11px]">Queued</span>
                      )}
                      {item.status === 'failed' && (
                        <span className="text-red-400 text-[11px]">Failed</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Live Terminal Output */}
        <div className="lg:col-span-7 flex flex-col h-full min-h-[400px] space-y-3">
          {/* Active Progress Bar Banner */}
          {isProcessing && currentFile && (
            <div className="p-3 rounded-xl bg-zinc-900 border border-indigo-500/30 flex flex-col space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-zinc-200 truncate max-w-md">
                  Transcribing: <span className="text-indigo-400">{currentFile}</span>
                </span>
                <span className="font-mono font-bold text-indigo-400">{overallProgress}%</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 to-red-500 rounded-full transition-all duration-300"
                  style={{ width: `${overallProgress}%` }}
                />
              </div>
            </div>
          )}
          <div className="flex-1 min-h-0">
            <TerminalLog logs={logs} onClear={() => setLogs([])} />
          </div>
        </div>
      </div>
    </div>
  );
};
