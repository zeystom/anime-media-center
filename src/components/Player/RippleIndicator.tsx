import React from 'react';
import { FastForward, Rewind, Play, Pause, Volume2, VolumeX, SlidersHorizontal, Info } from 'lucide-react';

export type RippleType =
  | 'seek-forward'
  | 'forward'
  | 'seek-backward'
  | 'play'
  | 'pause'
  | 'volume'
  | 'mute'
  | 'sync'
  | 'info'
  | null;

interface RippleIndicatorProps {
  type?: RippleType;
  text?: string;
}

/**
 * Center-screen OSD feedback. Circular frosted-glass badges with a springy
 * pop-pulse; seek feedback nudges the icon in the seek direction.
 */
export const RippleIndicator: React.FC<RippleIndicatorProps> = ({ type, text }) => {
  if (!type) return null;

  const isSeekForward = (type === 'seek-forward' || type === 'forward');
  const isSeekBackward = type === 'seek-backward';
  const nudgeClass = isSeekForward
    ? 'osd-nudge-right'
    : isSeekBackward
      ? 'osd-nudge-left'
      : '';

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
      <div className="osd-badge flex h-[76px] w-[76px] flex-col items-center justify-center gap-0.5 rounded-full border bg-[#0F0A16]/65 text-white shadow-glow-crimson-sm backdrop-blur-[20px]"
        style={{ borderColor: 'rgba(255, 30, 109, 0.3)' }}
      >
        <span className={nudgeClass}>
          {isSeekForward && <FastForward className="w-7 h-7 text-rose-500 fill-rose-500" />}
          {isSeekBackward && <Rewind className="w-7 h-7 text-rose-500 fill-rose-500" />}
          {(type === 'play' || type === 'pause') && (
            type === 'play'
              ? <Play className="w-7 h-7 text-white fill-white" />
              : <Pause className="w-7 h-7 text-white fill-white" />
          )}
          {(type === 'volume' || type === 'mute') && (
            type === 'volume'
              ? <Volume2 className="w-7 h-7 text-white" />
              : <VolumeX className="w-7 h-7 text-rose-400" />
          )}
          {type === 'sync' && <SlidersHorizontal className="w-7 h-7 text-amber-400" />}
          {type === 'info' && <Info className="w-7 h-7 text-zinc-300" />}
        </span>

        {text && (
          <span className="text-[10px] font-bold tracking-widest font-mono uppercase text-zinc-200">
            {text}
          </span>
        )}
      </div>
    </div>
  );
};
