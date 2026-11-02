import React, { useState, useRef, useCallback } from 'react';
import { formatTime } from '../../utils/format';

interface TimelineScrubberProps {
  currentTime: number;
  duration: number;
  filePath: string;
  onSeek: (seconds: number) => void;
}

export const TimelineScrubber: React.FC<TimelineScrubberProps> = ({
  currentTime,
  duration,
  filePath,
  onSeek,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isHovering, setIsHovering] = useState(false);
  const [hoverTime, setHoverTime] = useState<number>(0);
  const [hoverX, setHoverX] = useState<number>(0);
  const [thumbUrl, setThumbUrl] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);

  const calculateTimeFromX = useCallback((clientX: number): { time: number; x: number; fraction: number } => {
    if (!containerRef.current || duration <= 0) return { time: 0, x: 0, fraction: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const fraction = x / rect.width;
    const time = Math.max(0, Math.min(fraction * duration, duration));
    return { time, x, fraction };
  }, [duration]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const { time, x } = calculateTimeFromX(e.clientX);
    setHoverTime(time);
    setHoverX(x);
    setIsHovering(true);

    if (window.electronAPI && filePath) {
      window.electronAPI.getThumbnailUrl(filePath, time).then(url => {
        setThumbUrl(url);
      }).catch(() => {});
    }
  }, [calculateTimeFromX, filePath]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    setIsDragging(true);
    const { time, x } = calculateTimeFromX(e.clientX);
    setHoverTime(time);
    setHoverX(x);
    setIsHovering(true);

    const onGlobalMouseMove = (moveEvent: MouseEvent) => {
      const { time: dragTime, x: dragX } = calculateTimeFromX(moveEvent.clientX);
      setHoverTime(dragTime);
      setHoverX(dragX);
      if (window.electronAPI && filePath) {
        window.electronAPI.getThumbnailUrl(filePath, dragTime).then((url) => {
          setThumbUrl(url);
        }).catch(() => {});
      }
    };

    const onGlobalMouseUp = (upEvent: MouseEvent) => {
      setIsDragging(false);
      const { time: finalTime } = calculateTimeFromX(upEvent.clientX);
      onSeek(finalTime);
      window.removeEventListener('mousemove', onGlobalMouseMove);
      window.removeEventListener('mouseup', onGlobalMouseUp);
    };

    window.addEventListener('mousemove', onGlobalMouseMove);
    window.addEventListener('mouseup', onGlobalMouseUp);
  }, [calculateTimeFromX, onSeek, filePath]);

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const hoverPercent = duration > 0 ? (hoverTime / duration) * 100 : 0;
  const activePercent = isDragging ? hoverPercent : progressPercent;

  // Clamp floating thumbnail preview box inside timeline bounds
  const previewBoxWidth = 160;
  const containerWidth = containerRef.current ? containerRef.current.clientWidth : 800;
  const clampedX = Math.max(
    previewBoxWidth / 2,
    Math.min(hoverX, containerWidth - previewBoxWidth / 2)
  );

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => {
        if (!isDragging) setIsHovering(false);
      }}
      onMouseDown={handleMouseDown}
      className="relative w-full h-7 flex items-center cursor-pointer select-none group"
    >
      {/* Background Track */}
      <div className="relative w-full h-1.5 group-hover:h-2.5 bg-white/20 rounded-full overflow-hidden transition-all duration-150">
        {/* Hover Ghost Bar */}
        {isHovering && (
          <div
            className="absolute left-0 top-0 bottom-0 bg-white/30 rounded-full pointer-events-none"
            style={{ width: `${hoverPercent}%` }}
          />
        )}

        {/* Current Playback Progress Bar */}
        <div
          className="absolute left-0 top-0 bottom-0 bg-red-600 rounded-full shadow-sm shadow-red-600/50"
          style={{ width: `${activePercent}%` }}
        />
      </div>

      {/* Scrubber Knob / Playhead */}
      <div
        className="absolute w-3.5 h-3.5 bg-red-500 rounded-full shadow-md shadow-black/80 -translate-x-1/2 scale-0 group-hover:scale-100 transition-transform duration-100 pointer-events-none"
        style={{ left: `${activePercent}%` }}
      />

      {/* Floating Hover Thumbnail Preview Box */}
      {isHovering && duration > 0 && (
        <div
          className="absolute bottom-9 -translate-x-1/2 pointer-events-none z-30 flex flex-col items-center animate-in fade-in zoom-in-95 duration-100"
          style={{ left: `${clampedX}px` }}
        >
          <div className="p-1 rounded-lg bg-zinc-900 border border-zinc-700/80 shadow-2xl flex flex-col items-center">
            {/* 160x90 Thumbnail Container */}
            <div className="w-[160px] h-[90px] bg-black rounded overflow-hidden relative">
              {thumbUrl ? (
                <img
                  src={thumbUrl}
                  alt="Scrub Preview"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-zinc-950 text-[10px] text-zinc-500">
                  Loading...
                </div>
              )}
            </div>

            {/* Timestamp Pill */}
            <span className="mt-1 text-xs font-mono font-bold text-white tracking-wide">
              {formatTime(hoverTime)}
            </span>
          </div>

          {/* Triangle caret pointing to seekbar */}
          <div className="w-2.5 h-2.5 bg-zinc-900 border-r border-b border-zinc-700/80 rotate-45 -mt-1.5" />
        </div>
      )}
    </div>
  );
};
