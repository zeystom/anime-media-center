import React, { useRef, useEffect, useState } from 'react';
import { Radio, Sparkles, MessageSquareQuote, Activity, Eye, EyeOff } from 'lucide-react';
import { WhisperLiveCue } from '../../types';
import { cleanEpisodeTitle } from '../../utils/format';

interface LiveDialogueStreamProps {
  cues: WhisperLiveCue[];
  isProcessing: boolean;
  currentFile: string;
  speed?: string;
  progress: number;
}

export const LiveDialogueStream: React.FC<LiveDialogueStreamProps> = ({
  cues,
  isProcessing,
  currentFile,
  speed,
  progress,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showResults, setShowResults] = useState(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [cues]);

  const parsedCurrent = currentFile ? cleanEpisodeTitle(currentFile) : null;

  return (
    <div className="flex flex-col h-[320px] rounded-2xl bg-[#141418] border border-white/10 overflow-hidden shadow-lg">
      {/* Header Bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-zinc-900/80 border-b border-zinc-800/80 shrink-0">
        <div className="flex items-center space-x-2.5 truncate mr-2">
          <div className="w-7 h-7 rounded-lg bg-indigo-500/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30 shrink-0">
            {isProcessing ? (
              <Radio className="w-4 h-4 animate-pulse text-indigo-400" />
            ) : (
              <MessageSquareQuote className="w-4 h-4 text-zinc-400" />
            )}
          </div>
          <div className="truncate">
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-white tracking-tight">
                Live Dialogue Stream
              </span>
              {isProcessing && (
                <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                  <span>DECODING</span>
                </span>
              )}
            </div>
            {parsedCurrent && isProcessing ? (
              <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                <span className="text-indigo-400 font-semibold">{parsedCurrent.episodeLabel}:</span>{' '}
                {parsedCurrent.displayTitle}
              </p>
            ) : (
              <p className="text-[11px] text-zinc-500">
                Real-time speech cues recognized by Whisper AI
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowResults((prev) => !prev)}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
              showResults
                ? 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:text-white'
                : 'bg-indigo-600/30 text-indigo-200 border-indigo-500/50 hover:bg-indigo-600/40 shadow-sm'
            }`}
            title={showResults ? 'Hide dialogue text (anti-spoiler)' : 'Show dialogue text'}
          >
            {showResults ? (
              <>
                <EyeOff className="w-3.5 h-3.5 text-zinc-400" />
                <span>Hide results</span>
              </>
            ) : (
              <>
                <Eye className="w-3.5 h-3.5 text-indigo-300" />
                <span>Show results</span>
              </>
            )}
          </button>

          {isProcessing && (
            <>
              {speed && (
                <span className="hidden sm:inline-flex px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-zinc-800 text-indigo-300 border border-zinc-700">
                  {speed}
                </span>
              )}
              <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-bold bg-indigo-600/30 text-indigo-300 border border-indigo-500/40">
                {progress}%
              </span>
            </>
          )}
        </div>
      </div>

      {/* Stream Dialogue Cards */}
      <div
        ref={scrollRef}
        className="flex-1 p-3.5 overflow-y-auto space-y-2 scrollbar-thin select-text"
      >
        {cues.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-2.5 text-zinc-500">
            <div className="w-10 h-10 rounded-full bg-zinc-800/60 border border-zinc-700/60 flex items-center justify-center text-zinc-400">
              {isProcessing ? (
                <Activity className="w-5 h-5 animate-pulse text-indigo-400" />
              ) : (
                <Sparkles className="w-5 h-5 text-zinc-500" />
              )}
            </div>
            <div>
              <p className="text-xs font-medium text-zinc-300">
                {isProcessing
                  ? 'Listening for speech segments...'
                  : 'Awaiting Whisper transcription run'}
              </p>
              <p className="text-[11px] text-zinc-500 max-w-sm mt-0.5">
                {isProcessing
                  ? 'Dialogue subtitles will appear here live with synchronized timestamps.'
                  : 'Select target anime episodes and click Generate Subtitles to begin live recognition.'}
              </p>
            </div>
          </div>
        ) : (
          cues.map((cue, idx) => {
            const isLatest = idx === cues.length - 1 && isProcessing;

            return (
              <div
                key={cue.id || idx}
                className={`p-2.5 rounded-xl border transition-all duration-200 ${
                  isLatest
                    ? 'bg-indigo-600/15 border-indigo-500/60 text-white shadow-md shadow-indigo-500/10'
                    : 'bg-zinc-900/60 border-zinc-800/80 text-zinc-200 hover:bg-zinc-900/90'
                }`}
              >
                <div className="flex items-center justify-between text-[11px] mb-1">
                  <div className="flex items-center space-x-1.5 font-mono text-indigo-300">
                    <span className="px-1.5 py-0.5 rounded bg-zinc-800/90 border border-zinc-700/70 text-[10px]">
                      {cue.start} ➔ {cue.end}
                    </span>
                  </div>
                  {isLatest && (
                    <span className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider animate-pulse flex items-center space-x-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                      <span>Live</span>
                    </span>
                  )}
                </div>
                <p
                  className={`text-xs font-medium leading-relaxed transition-all duration-300 ${
                    showResults
                      ? 'text-zinc-100 select-text filter-none'
                      : 'text-zinc-400 select-none filter blur-[6px] hover:filter-none hover:text-zinc-200 cursor-pointer'
                  }`}
                  title={showResults ? undefined : 'Click or hover to peek line'}
                  onClick={() => {
                    if (!showResults) setShowResults(true);
                  }}
                >
                  {cue.text}
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
