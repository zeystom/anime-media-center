import React, { useState, useRef, useCallback, useEffect } from 'react';
import { formatTime } from '../../utils/format';

export interface TimelineOpeningRange {
  start: number;
  end: number;
}

interface TimelineScrubberProps {
  currentTime: number;
  duration: number;
  filePath: string;
  serverPort?: number;
  onSeek: (seconds: number) => void;
  openingRange?: TimelineOpeningRange | null;
  controlsVisible?: boolean;
  onPreviewVisibilityChange?: (visible: boolean) => void;
}

const BOX_WIDTH = 176;
const HALF_WIDTH = BOX_WIDTH / 2;

export const TimelineScrubber: React.FC<TimelineScrubberProps> = ({
  currentTime,
  duration,
  filePath,
  serverPort = 0,
  onSeek,
  openingRange = null,
  controlsVisible = true,
  onPreviewVisibilityChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);
  const timestampRef = useRef<HTMLSpanElement>(null);
  const opBadgeRef = useRef<HTMLSpanElement>(null);
  const ghostBarRef = useRef<HTMLDivElement>(null);
  const ghostKnobRef = useRef<HTMLDivElement>(null);

  const [isHovering, setIsHovering] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [displayedThumbUrl, setDisplayedThumbUrl] = useState<string>('');
  const isPreviewVisible = (isHovering || isDragging) && duration > 0 && controlsVisible;

  useEffect(() => {
    if (!controlsVisible && !isDragging) {
      setIsHovering(false);
    }
  }, [controlsVisible, isDragging]);

  useEffect(() => {
    onPreviewVisibilityChange?.(isPreviewVisible);
  }, [isPreviewVisible, onPreviewVisibilityChange]);

  useEffect(() => {
    return () => {
      onPreviewVisibilityChange?.(false);
    };
  }, [onPreviewVisibilityChange]);

  // Local In-Memory Cache of loaded thumbnails to achieve 0ms instant display on repeat hovers
  const localCacheRef = useRef<Map<number, string>>(new Map());
  const activeBucketRef = useRef<number>(-1);
  const debounceTimerRef = useRef<any>(null);
  const rafIdRef = useRef<number | null>(null);
  const dragListenersRef = useRef<{ onMove: (e: MouseEvent) => void; onUp: (e: MouseEvent) => void } | null>(null);

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

  // Find nearest cached thumbnail so the UI never displays an empty black box or stale image
  const getNearestCachedUrl = useCallback((targetBucket: number): string | null => {
    if (localCacheRef.current.size === 0) return null;
    let closestBucket = -1;
    let minDiff = Infinity;
    for (const b of localCacheRef.current.keys()) {
      const diff = Math.abs(b - targetBucket);
      if (diff < minDiff) {
        minDiff = diff;
        closestBucket = b;
      }
    }
    // If nearest cached frame is within 120 seconds, use it as immediate preview
    if (closestBucket !== -1 && minDiff <= 120) {
      return localCacheRef.current.get(closestBucket) || null;
    }
    return null;
  }, []);

  // Pre-fetch adjacent buckets in idle time (e.g. +5s, -5s) for instant 0ms sweeping
  const prefetchNeighbors = useCallback(
    (centerBucket: number) => {
      const neighbors = [centerBucket + 5, centerBucket - 5];
      for (const nb of neighbors) {
        if (nb >= 0 && nb <= duration && !localCacheRef.current.has(nb)) {
          const url = getThumbUrlForBucket(nb);
          if (url) {
            const img = new Image();
            img.src = url;
            img.onload = () => {
              localCacheRef.current.set(nb, url);
            };
          }
        }
      }
    },
    [duration, getThumbUrlForBucket]
  );

  // Load thumbnail with continuous updates and nearest-neighbor fallback
  const scheduleThumbnailFetch = useCallback(
    (time: number) => {
      const bucket = Math.max(0, Math.floor(time / 5) * 5);
      if (bucket === activeBucketRef.current) return;
      activeBucketRef.current = bucket;

      // 1. Instant Exact Memory Cache Hit (0ms)
      const cached = localCacheRef.current.get(bucket);
      if (cached) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        setDisplayedThumbUrl(cached);
        prefetchNeighbors(bucket);
        return;
      }

      // 2. Nearest Cached Frame Fallback (0ms instant visual response while fetching exact)
      const nearest = getNearestCachedUrl(bucket);
      if (nearest) {
        setDisplayedThumbUrl(nearest);
      }

      // 3. Low-latency debounce (25ms) so quick cursor movement groups requests without lag
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
          // Continuous update: update preview if user is still nearby (within 20s)
          if (Math.abs(activeBucketRef.current - bucket) <= 20) {
            setDisplayedThumbUrl(url);
          }
          // Quietly prefetch adjacent frames
          prefetchNeighbors(bucket);
        };
      }, 25);
    },
    [filePath, getThumbUrlForBucket, getNearestCachedUrl, prefetchNeighbors]
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
        if (opBadgeRef.current) {
          const isInsideOp = openingRange && time >= openingRange.start && time <= openingRange.end;
          opBadgeRef.current.style.display = isInsideOp ? 'inline-flex' : 'none';
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
    [calculateTimeFromX, scheduleThumbnailFetch, openingRange]
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

      // Clean up previous listeners if still registered
      if (dragListenersRef.current) {
        window.removeEventListener('mousemove', dragListenersRef.current.onMove);
        window.removeEventListener('mouseup', dragListenersRef.current.onUp);
        dragListenersRef.current = null;
      }

      const onGlobalMouseMove = (moveEvent: MouseEvent) => {
        updatePointerPosition(moveEvent.clientX);
      };

      const onGlobalMouseUp = (upEvent: MouseEvent) => {
        setIsDragging(false);
        const rect = containerRef.current?.getBoundingClientRect();
        const stillInside = rect
          ? upEvent.clientX >= rect.left &&
            upEvent.clientX <= rect.right &&
            upEvent.clientY >= rect.top &&
            upEvent.clientY <= rect.bottom
          : false;
        if (!stillInside) {
          setIsHovering(false);
        }
        const { time: finalTime } = calculateTimeFromX(upEvent.clientX);
        onSeek(finalTime);
        window.removeEventListener('mousemove', onGlobalMouseMove);
        window.removeEventListener('mouseup', onGlobalMouseUp);
        dragListenersRef.current = null;
      };

      dragListenersRef.current = { onMove: onGlobalMouseMove, onUp: onGlobalMouseUp };
      window.addEventListener('mousemove', onGlobalMouseMove);
      window.addEventListener('mouseup', onGlobalMouseUp);
    },
    [calculateTimeFromX, onSeek, updatePointerPosition]
  );

  // Guarantee strict cleanup of dragging listeners, RAF, and debounce timer on component unmount
  useEffect(() => {
    return () => {
      if (dragListenersRef.current) {
        window.removeEventListener('mousemove', dragListenersRef.current.onMove);
        window.removeEventListener('mouseup', dragListenersRef.current.onUp);
        dragListenersRef.current = null;
      }
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const opStartPct = openingRange && duration > 0 ? (openingRange.start / duration) * 100 : 0;
  const opEndPct = openingRange && duration > 0 ? (openingRange.end / duration) * 100 : 0;
  const opWidthPct = Math.max(0, opEndPct - opStartPct);

  const hasPassedOp = openingRange && duration > 0 ? progressPercent >= opEndPct : false;
  const isInsideOp = openingRange && duration > 0 ? progressPercent > opStartPct && progressPercent < opEndPct : false;
  const opInnerProgressPct =
    isInsideOp && opWidthPct > 0
      ? Math.min(100, Math.max(0, ((progressPercent - opStartPct) / opWidthPct) * 100))
      : 0;

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
      {/* Background Track Bar: 4px resting, 6px on hover */}
      <div className="relative w-full h-1 group-hover:h-[6px] bg-black/45 ring-1 ring-white/[0.16] backdrop-blur-sm rounded-full overflow-hidden shadow-[0_2px_10px_rgba(0,0,0,0.45)] transition-all duration-200 ease-fluid">
        {/* Instant Ghost Bar */}
        <div
          ref={ghostBarRef}
          className={`absolute left-0 top-0 bottom-0 bg-white/25 rounded-full pointer-events-none transition-opacity duration-150 ${
            isHovering ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ width: '0%' }}
        />

        {/* Current Playback Progress Bar — crimson-magenta gradient */}
        <div
          className="absolute left-0 top-0 bottom-0 rounded-full z-10"
          style={{
            width: `${progressPercent}%`,
            background: 'linear-gradient(90deg, #9E1148, #FF1E6D)',
            boxShadow: '0 0 10px rgba(255, 30, 109, 0.6)',
          }}
        />

        {/* Opening Theme Segment Highlight (Amber / Golden accent - ALWAYS visible with crisp start/end tick notches) */}
        {openingRange && duration > 0 && opWidthPct > 0 && (
          <div
            className="absolute top-0 bottom-0 pointer-events-none z-20"
            style={{
              left: `${opStartPct}%`,
              width: `${opWidthPct}%`,
            }}
            title={`Opening (${formatTime(openingRange.start)} - ${formatTime(openingRange.end)})`}
          >
            {/* Base Fill (Opaque when passed to fully cover red bar underneath; semi-translucent when unplayed) */}
            <div
              className={`absolute inset-0 transition-colors duration-150 ${
                hasPassedOp
                  ? 'bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.6)]'
                  : 'bg-amber-500/50 group-hover:bg-amber-500/70 shadow-[0_0_6px_rgba(251,191,36,0.3)]'
              }`}
            />

            {/* Active Played Fill when currently inside opening */}
            {isInsideOp && opInnerProgressPct > 0 && (
              <div
                className="absolute left-0 top-0 bottom-0 bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.8)]"
                style={{ width: `${opInnerProgressPct}%` }}
              />
            )}

            {/* Crisp Start of Opening Marker Notch */}
            <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-amber-100 shadow-[0_0_4px_rgba(0,0,0,0.8),0_0_6px_rgba(254,240,138,1)] z-30" />

            {/* Crisp End of Opening Marker Notch */}
            <div className="absolute right-0 top-0 bottom-0 w-[2px] bg-amber-100 shadow-[0_0_4px_rgba(0,0,0,0.8),0_0_6px_rgba(254,240,138,1)] z-30" />
          </div>
        )}
      </div>

      {/* Ghost Hover Knob Indicator on Track */}
      <div
        ref={ghostKnobRef}
        className={`absolute w-3 h-3 bg-white/80 rounded-full shadow-md -translate-x-1/2 scale-0 group-hover:scale-100 pointer-events-none transition-transform duration-100 z-30 ${
          isHovering ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ left: '0%' }}
      />

      {/* Scrubber Knob / Active Playhead — glowing crimson thumb */}
      <div
        className="absolute w-3.5 h-3.5 rounded-full -translate-x-1/2 scale-0 group-hover:scale-100 transition-transform duration-100 pointer-events-none ring-2 ring-rose-200/40 z-30"
        style={{ left: `${progressPercent}%`, backgroundColor: '#FF1E6D', boxShadow: '0 0 14px #FF1E6D, 0 2px 8px rgba(0,0,0,0.8)' }}
      />

      {/* Zero-Latency Floating Hover Preview Card (Centered directly above cursor).
          Spring scaling: fades+lifts from scale(0.92) to scale(1) while hovering. */}
      <div
        ref={tooltipRef}
        className="absolute bottom-9 left-0 pointer-events-none z-40"
        style={{ willChange: 'transform', width: `${BOX_WIDTH}px` }}
      >
        <div
          className={`relative p-1 rounded-xl border border-white/[0.12] bg-[#0b0912]/75 backdrop-blur-xl shadow-[0_12px_32px_rgba(0,0,0,0.75)] flex flex-col items-center transition-all duration-200 ease-fluid ${
            isPreviewVisible
              ? 'opacity-100 scale-100 -translate-y-0'
              : 'opacity-0 scale-[0.92] translate-y-1.5'
          }`}
          style={{
            transformOrigin: 'bottom center',
          }}
        >
          {/* 16:9 Thumbnail Box with integrated bottom gradient time overlay */}
          <div className="w-full aspect-video bg-black rounded-lg overflow-hidden relative">
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

            {/* Time Badge & Opening Pill integrated cleanly inside thumbnail bottom */}
            <div className="absolute inset-x-0 bottom-0 pt-4 pb-1.5 px-2 bg-gradient-to-t from-black/85 via-black/35 to-transparent flex items-center justify-center space-x-1.5">
              <span
                ref={timestampRef}
                className="text-xs font-mono font-bold text-white tracking-wider leading-none drop-shadow"
              >
                00:00
              </span>
              <span
                ref={opBadgeRef}
                style={{ display: 'none' }}
                className="inline-flex items-center px-1.5 h-3.5 leading-none rounded text-[9px] font-bold font-mono tracking-wider bg-amber-500/25 text-amber-300 border border-amber-500/40 uppercase box-border"
              >
                Opening
              </span>
            </div>
          </div>

          {/* Preserved arrowRef node for ref alignment without visual clutter */}
          <div
            ref={arrowRef}
            className="opacity-0 pointer-events-none absolute -bottom-1 w-2 h-2 -translate-x-1/2"
            style={{ left: `${HALF_WIDTH}px` }}
          />
        </div>
      </div>
    </div>
  );
};
