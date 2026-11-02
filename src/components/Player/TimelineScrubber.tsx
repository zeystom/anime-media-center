import React, { useState, useRef, useCallback, useEffect } from 'react';
import { formatTime } from '../../utils/format';

interface TimelineScrubberProps {
  currentTime: number;
  duration: number;
  filePath: string;
  serverPort?: number;
  onSeek: (seconds: number) => void;
}

const BOX_WIDTH = 176;
const HALF_WIDTH = BOX_WIDTH / 2;

export const TimelineScrubber: React.FC<TimelineScrubberProps> = ({
  currentTime,
  duration,
  filePath,
  serverPort = 0,
  onSeek,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);
  const timestampRef = useRef<HTMLSpanElement>(null);
  const ghostBarRef = useRef<HTMLDivElement>(null);
  const ghostKnobRef = useRef<HTMLDivElement>(null);

  const [isHovering, setIsHovering] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [displayedThumbUrl, setDisplayedThumbUrl] = useState<string>('');

  // Local In-Memory Cache of loaded thumbnails to achieve 0ms instant display on repeat hovers
  const localCacheRef = useRef<Map<number, string>>(new Map());
  const activeBucketRef = useRef<number>(-1);
  const debounceTimerRef = useRef<any>(null);
  const rafIdRef = useRef<number | null>(null);

  // Clear cache when media file changes
  useEffect(() => {
    localCacheRef.current.clear();
    setDisplayedThumbUrl('');
    activeBucketRef.current = -1;
  }, [filePath]);

  // Construct thumbnail URL synchronously if port is available
  const getThumbUrlForBucket = useCallback(
    (bucket: number): string => {
      if (serverPort && serverPort > 0) {
        return `http://127.0.0.1:${serverPort}/thumb?file=${encodeURIComponent(filePath)}&time=${bucket}`;
      }
      return '';
    },
    [filePath, serverPort]
  );

  // Load thumbnail with double buffering (keeps previous frame while next frame loads)
  const scheduleThumbnailFetch = useCallback(
    (time: number) => {
      const bucket = Math.max(0, Math.floor(time / 5) * 5);
      if (bucket === activeBucketRef.current) return;
      activeBucketRef.current = bucket;

      // 1. Instant Memory Cache Hit (0ms)
      const cached = localCacheRef.current.get(bucket);
      if (cached) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        setDisplayedThumbUrl(cached);
        return;
      }

      // 2. Debounce network/disk request during sweeping (90ms)
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(async () => {
        let url = getThumbUrlForBucket(bucket);
        if (!url && window.electronAPI) {
          try {
            url = await window.electronAPI.getThumbnailUrl(filePath, bucket);
          } catch {}
        }
        if (!url) return;

        // Preload in memory without flickering the UI
        const img = new Image();
        img.src = url;
        img.onload = () => {
          localCacheRef.current.set(bucket, url);
          // Only show if user is still hovering over this bucket
          if (activeBucketRef.current === bucket) {
            setDisplayedThumbUrl(url);
          }
        };
      }, 90);
    },
    [filePath, getThumbUrlForBucket]
  );

  const calculateTimeFromX = useCallback(
    (clientX: number): { time: number; x: number; fraction: number; boxX: number; arrowX: number } => {
      if (!containerRef.current || duration <= 0) {
        return { time: 0, x: 0, fraction: 0, boxX: 0, arrowX: HALF_WIDTH };
      }
      const rect = containerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
      const fraction = rect.width > 0 ? x / rect.width : 0;
      const time = Math.max(0, Math.min(fraction * duration, duration));

      // Precision centering: box is centered on x, clamped strictly within player boundaries
      const boxX = Math.max(0, Math.min(x - HALF_WIDTH, rect.width - BOX_WIDTH));
      // Pointer arrow follows cursor x relative to box, clamped inside card rounded corners
      const arrowX = Math.max(16, Math.min(x - boxX, BOX_WIDTH - 16));

      return { time, x, fraction, boxX, arrowX };
    },
    [duration]
  );

  // Zero-Latency Mouse Movement Handler (Direct DOM transform at 144Hz, bypassing React render delays)
  const updatePointerPosition = useCallback(
    (clientX: number) => {
      const { time, fraction, boxX, arrowX } = calculateTimeFromX(clientX);

      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        if (tooltipRef.current) {
          tooltipRef.current.style.transform = `translate3d(${boxX}px, 0, 0)`;
        }
        if (arrowRef.current) {
          arrowRef.current.style.left = `${arrowX}px`;
        }
        if (timestampRef.current) {
          timestampRef.current.textContent = formatTime(time);
        }
        if (ghostBarRef.current) {
          ghostBarRef.current.style.width = `${fraction * 100}%`;
        }
        if (ghostKnobRef.current) {
          ghostKnobRef.current.style.left = `${fraction * 100}%`;
        }
      });

      scheduleThumbnailFetch(time);
    },
    [calculateTimeFromX, scheduleThumbnailFetch]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      setIsHovering(true);
      updatePointerPosition(e.clientX);
    },
    [updatePointerPosition]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      setIsDragging(true);
      setIsHovering(true);
      updatePointerPosition(e.clientX);

      const onGlobalMouseMove = (moveEvent: MouseEvent) => {
        updatePointerPosition(moveEvent.clientX);
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
    },
    [calculateTimeFromX, onSeek, updatePointerPosition]
  );

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => {
        if (!isDragging) setIsHovering(false);
      }}
      onMouseDown={handleMouseDown}
      className="relative w-full h-8 flex items-center cursor-pointer select-none group"
    >
      {/* Background Track Bar */}
      <div className="relative w-full h-1.5 group-hover:h-2 bg-white/20 rounded-full overflow-hidden transition-all duration-150">
        {/* Instant Ghost Bar */}
        <div
          ref={ghostBarRef}
          className={`absolute left-0 top-0 bottom-0 bg-white/30 rounded-full pointer-events-none transition-opacity duration-150 ${
            isHovering ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ width: '0%' }}
        />

        {/* Current Playback Progress Bar */}
        <div
          className="absolute left-0 top-0 bottom-0 bg-red-600 rounded-full shadow-sm shadow-red-600/50"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Ghost Hover Knob Indicator on Track */}
      <div
        ref={ghostKnobRef}
        className={`absolute w-3 h-3 bg-white/80 rounded-full shadow-md -translate-x-1/2 scale-0 group-hover:scale-100 pointer-events-none transition-transform duration-100 ${
          isHovering ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ left: '0%' }}
      />

      {/* Scrubber Knob / Active Playhead */}
      <div
        className="absolute w-3.5 h-3.5 bg-red-500 rounded-full shadow-lg shadow-black/80 -translate-x-1/2 scale-0 group-hover:scale-100 transition-transform duration-100 pointer-events-none ring-2 ring-white/20"
        style={{ left: `${progressPercent}%` }}
      />

      {/* Zero-Latency Floating Hover Preview Card (Centered directly above cursor) */}
      <div
        ref={tooltipRef}
        className={`absolute bottom-9 left-0 pointer-events-none z-30 transition-opacity duration-150 ${
          isHovering && duration > 0 ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ willChange: 'transform', width: `${BOX_WIDTH}px` }}
      >
        <div className="relative p-1.5 rounded-2xl bg-[#121217]/95 border border-white/15 shadow-2xl shadow-black/90 backdrop-blur-2xl flex flex-col items-center">
          {/* 16:9 Thumbnail Box */}
          <div className="w-full aspect-video bg-black rounded-xl overflow-hidden relative border border-white/10 shadow-inner">
            {displayedThumbUrl ? (
              <img
                src={displayedThumbUrl}
                alt="Seek Preview"
                className="w-full h-full object-cover"
                loading="eager"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-zinc-950 text-[11px] font-mono text-zinc-500">
                Preview
              </div>
            )}
          </div>

          {/* Time Badge */}
          <div className="mt-1 px-3 py-0.5 rounded-lg bg-black/60 border border-white/5 flex items-center justify-center">
            <span
              ref={timestampRef}
              className="text-xs font-mono font-bold text-zinc-100 tracking-wider"
            >
              00:00
            </span>
          </div>

          {/* Precision Pointer Arrow (Aligns exactly to cursor position) */}
          <div
            ref={arrowRef}
            className="absolute -bottom-1.5 w-3 h-3 bg-[#121217] border-r border-b border-white/15 -translate-x-1/2 rotate-45"
            style={{ left: `${HALF_WIDTH}px` }}
          />
        </div>
      </div>
    </div>
  );
};
