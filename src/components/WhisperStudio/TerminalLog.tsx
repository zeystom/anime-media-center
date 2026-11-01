import React, { useRef, useEffect, useState } from 'react';
import { Terminal, Trash2 } from 'lucide-react';
import { WhisperLogMessage } from '../../types';

interface TerminalLogProps {
  logs: WhisperLogMessage[];
  onClear: () => void;
}

export const TerminalLog: React.FC<TerminalLogProps> = ({ logs, onClear }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  return (
    <div className="flex flex-col h-full rounded-2xl bg-[#0c0c0e] border border-zinc-800/80 overflow-hidden shadow-2xl">
      {/* Terminal Title Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#141418] border-b border-zinc-800/80">
        <div className="flex items-center space-x-2">
          <div className="flex space-x-1.5 mr-2">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
          </div>
          <Terminal className="w-4 h-4 text-zinc-400" />
          <span className="text-xs font-mono font-semibold text-zinc-300">
            faster-whisper-xxl live output
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setAutoScroll((prev) => !prev)}
            className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
              autoScroll
                ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/40'
                : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-white'
            }`}
          >
            Auto-scroll: {autoScroll ? 'ON' : 'OFF'}
          </button>

          <button
            onClick={onClear}
            className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            title="Clear Terminal Output"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Output Body */}
      <div
        ref={containerRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 40;
          setAutoScroll(isAtBottom);
        }}
        className="flex-1 p-4 overflow-y-auto font-mono text-[11px] leading-relaxed space-y-0.5 select-text"
      >
        {logs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-zinc-600">
            <span>Terminal ready. Awaiting Whisper batch execution...</span>
          </div>
        ) : (
          logs.map((log, idx) => {
            const timeStr = new Date(log.timestamp).toLocaleTimeString();
            let textColor = 'text-zinc-300';
            if (log.type === 'error') textColor = 'text-red-400 font-bold';
            if (log.type === 'success') textColor = 'text-emerald-400 font-bold';
            if (log.type === 'info') textColor = 'text-indigo-400';

            return (
              <div key={idx} className="flex items-start space-x-2">
                <span className="text-zinc-600 select-none shrink-0">[{timeStr}]</span>
                <span className={`${textColor} whitespace-pre-wrap break-all flex-1`}>
                  {log.text}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
