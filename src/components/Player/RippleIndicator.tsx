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
 * Center-screen OSD feedback. Renders a compact circular frosted-glass badge
 * for icon-only actions and short seek deltas, expanding into a frosted pill
 * for longer status labels so text never overflows the badge.
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

  const visibleText = type === 'play' || type === 'pause' ? undefined : text?.trim();
  const isPill = Boolean(visibleText && visibleText.length > 4);
  const iconClass = isPill ? 'w-5 h-5' : 'w-7 h-7';

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
      <div
        className={`osd-badge flex items-center justify-center rounded-full border border-white/[0.14] bg-[#0b0912]/55 text-white shadow-2xl backdrop-blur-xl ${
          isPill
            ? 'h-11 max-w-[min(82vw,420px)] flex-row gap-2.5 px-4'
            : 'h-16 w-16 flex-col gap-0.5 overflow-hidden'
        }`}
      >
        <span className={`inline-flex shrink-0 items-center justify-center ${nudgeClass}`}>
          {isSeekForward && <FastForward className={`${iconClass} text-rose-500 fill-rose-500`} />}
          {isSeekBackward && <Rewind className={`${iconClass} text-rose-500 fill-rose-500`} />}
          {(type === 'play' || type === 'pause') && (
            type === 'play'
              ? <Play className={`${iconClass} text-white fill-white`} />
              : <Pause className={`${iconClass} text-white fill-white`} />
          )}
          {(type === 'volume' || type === 'mute') && (
            type === 'volume'
              ? <Volume2 className={`${iconClass} text-white`} />
              : <VolumeX className={`${iconClass} text-rose-400`} />
          )}
          {type === 'sync' && <SlidersHorizontal className={`${iconClass} text-amber-400`} />}
          {type === 'info' && <Info className={`${iconClass} text-zinc-300`} />}
        </span>

        {visibleText && (
          <span
            className={
              isPill
                ? 'truncate text-xs font-semibold tracking-wide text-zinc-100'
                : 'text-[10px] font-bold leading-none tracking-widest font-mono uppercase text-zinc-200'
            }
          >
            {visibleText}
          </span>
        )}
      </div>
    </div>
  );
};
