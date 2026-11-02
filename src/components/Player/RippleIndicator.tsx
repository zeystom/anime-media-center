import React from 'react';
import { FastForward, Rewind, Play, Pause, Volume2, VolumeX } from 'lucide-react';

interface RippleIndicatorProps {
  type: 'seek-forward' | 'seek-backward' | 'play' | 'pause' | 'volume' | 'mute' | 'sync' | null;
  text?: string;
}

export const RippleIndicator: React.FC<RippleIndicatorProps> = ({ type, text }) => {
  if (!type) return null;

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
      <div className="flex flex-col items-center justify-center p-5 rounded-2xl bg-black/90 border border-white/10 text-white shadow-2xl animate-in fade-in zoom-in-75 duration-150">
        {type === 'seek-forward' && <FastForward className="w-10 h-10 text-red-500 fill-red-500 mb-1" />}
        {type === 'seek-backward' && <Rewind className="w-10 h-10 text-red-500 fill-red-500 mb-1" />}
        {type === 'play' && <Play className="w-10 h-10 text-white fill-white mb-1" />}
        {type === 'pause' && <Pause className="w-10 h-10 text-white fill-white mb-1" />}
        {type === 'volume' && <Volume2 className="w-10 h-10 text-white mb-1" />}
        {type === 'mute' && <VolumeX className="w-10 h-10 text-red-400 mb-1" />}

        {text && (
          <span className="text-sm font-bold tracking-wider font-mono uppercase mt-1">
            {text}
          </span>
        )}
      </div>
    </div>
  );
};
