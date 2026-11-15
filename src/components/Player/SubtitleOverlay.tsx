import React, { useEffect, useMemo, useRef } from 'react';
import { SubtitleCue } from '../../types';

interface CueIndex {
  cues: SubtitleCue[];
  prefixMaxEnd: number[];
}

function buildCueIndex(cues: SubtitleCue[]): CueIndex {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const prefixMaxEnd: number[] = [];
  let maxEnd = -Infinity;
  for (let i = 0; i < sorted.length; i += 1) {
    maxEnd = Math.max(maxEnd, sorted[i].end);
    prefixMaxEnd.push(maxEnd);
  }
  return { cues: sorted, prefixMaxEnd };
}

function findActiveCues(index: CueIndex, time: number, limit: number): SubtitleCue[] {
  const { cues, prefixMaxEnd } = index;
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (cues[mid].start <= time) low = mid + 1;
    else high = mid;
  }

  const found: SubtitleCue[] = [];
  for (let i = low - 1; i >= 0 && found.length < limit; i -= 1) {
    // Since this is a prefix maximum, no earlier cue can still be active.
    if (prefixMaxEnd[i] <= time) break;
    const cue = cues[i];
    if (time < cue.end) found.push(cue);
  }
  return found.reverse();
}

interface SubtitleOverlayProps {
  currentTime: number;
  mainCues: SubtitleCue[];
  topCues: SubtitleCue[];
  topSubEnabled: boolean;
  syncOffset: number; // in seconds
  fontSize?: number;  // default 38
  hasOutline?: boolean; // always true
  textColor?: string;
  fontFamily?: 'sans' | 'trebuchet' | 'rounded' | 'serif' | 'mono';
  bgStyle?: 'none' | 'translucent' | 'semi' | 'solid';
  outlineWidth?: 'thin' | 'medium' | 'thick' | 'heavy' | 'none';
  outlineColor?: string;
  controlsVisible?: boolean;
}

export function getSubtitleTextShadow(
  width: 'none' | 'thin' | 'medium' | 'thick' | 'heavy' = 'thick',
  color: string = '#000000'
): string {
  if (width === 'none') {
    return '0 2px 4px rgba(0, 0, 0, 0.4)';
  }
  const c = color || '#000000';
  if (width === 'thin') {
    return `
      1px 1px 0 ${c},
      -1px -1px 0 ${c},
      1px -1px 0 ${c},
      -1px 1px 0 ${c},
      0 1px 3px rgba(0, 0, 0, 0.8)
    `;
  }
  if (width === 'medium') {
    return `
      2px 2px 0 ${c},
      -2px -2px 0 ${c},
      2px -2px 0 ${c},
      -2px 2px 0 ${c},
      0 0 4px ${c},
      0 2px 4px rgba(0, 0, 0, 0.9)
    `;
  }
  if (width === 'heavy') {
    return `
      3px 3px 0 ${c},
      -3px -3px 0 ${c},
      3px -3px 0 ${c},
      -3px 3px 0 ${c},
      0 3px 0 ${c},
      3px 0 0 ${c},
      0 -3px 0 ${c},
      -3px 0 0 ${c},
      0 0 8px ${c},
      0 4px 6px rgba(0, 0, 0, 0.95)
    `;
  }
  // 'thick' (Default Fansub / Netflix 360° shadow)
  return `
    0px 0px 4px ${c},
    0px 0px 8px ${c},
    2px 2px 1px ${c},
    -2px -2px 1px ${c},
    2px -2px 1px ${c},
    -2px 2px 1px ${c},
    0 2px 4px rgba(0, 0, 0, 0.95)
  `;
}

const FONT_FAMILIES: Record<string, string> = {
  sans: 'Inter, system-ui, -apple-system, sans-serif',
  trebuchet: '"Trebuchet MS", "Lucida Grande", "Segoe UI", sans-serif',
  rounded: '"Comfortaa", "Nunito", "Segoe UI Rounded", "Arial Rounded MT Bold", sans-serif',
  serif: 'Georgia, "Times New Roman", Cambria, serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace',
};

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  currentTime,
  mainCues,
  topCues,
  topSubEnabled,
  syncOffset,
  fontSize = 38,
  hasOutline = true,
  textColor = '#ffffff',
  fontFamily = 'sans',
  bgStyle = 'none',
  outlineWidth = 'thick',
  outlineColor = '#000000',
  controlsVisible = false,
}) => {
  // Apply sync offset to current playback time
  const adjustedTime = currentTime + syncOffset;
  const mainCueIndex = useMemo(() => buildCueIndex(mainCues || []), [mainCues]);
  const topCueIndex = useMemo(() => buildCueIndex(topCues || []), [topCues]);

  // Binary search the cue timeline instead of scanning every subtitle on each update.
  const activeMainCues = useMemo(() => {
    if (mainCueIndex.cues.length === 0) return [];
    return findActiveCues(mainCueIndex, adjustedTime, 3);
  }, [mainCueIndex, adjustedTime]);

  // Find active signs/forced cues (Top)
  const activeTopCues = useMemo(() => {
    if (!topSubEnabled || topCueIndex.cues.length === 0) return [];
    return findActiveCues(topCueIndex, adjustedTime, 3);
  }, [topCueIndex, adjustedTime, topSubEnabled]);

  const activeMainTextCues = useMemo(
    () => activeMainCues.filter((cue) => !cue.bitmaps?.length && Boolean(cue.text?.trim())),
    [activeMainCues]
  );
  const activeMainBitmapCues = useMemo(
    () => activeMainCues.filter((cue) => Boolean(cue.bitmaps && cue.bitmaps.length > 0)),
    [activeMainCues]
  );
  const activeTopTextCues = useMemo(
    () => activeTopCues.filter((cue) => !cue.bitmaps?.length && Boolean(cue.text?.trim())),
    [activeTopCues]
  );
  const activeTopBitmapCues = useMemo(
    () => activeTopCues.filter((cue) => Boolean(cue.bitmaps && cue.bitmaps.length > 0)),
    [activeTopCues]
  );

  // Pre-warm the next 3 upcoming PGS bitmap images so cues appear with zero flash
  const prefetchedBitmapUrlsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (typeof Image === 'undefined') return;
    const warmQueue: string[] = [];
    const collectUpcoming = (cues: SubtitleCue[]) => {
      for (let i = 0; i < cues.length && warmQueue.length < 6; i += 1) {
        const cue = cues[i];
        if (!cue.bitmaps?.length) continue;
        if (cue.end < adjustedTime - 0.5) continue;
        if (cue.start > adjustedTime + 20) break;
        for (const bmp of cue.bitmaps) {
          if (bmp.url && !prefetchedBitmapUrlsRef.current.has(bmp.url)) {
            warmQueue.push(bmp.url);
          }
        }
      }
    };
    collectUpcoming(mainCueIndex.cues);
    if (topSubEnabled) collectUpcoming(topCueIndex.cues);

    for (const url of warmQueue) {
      if (prefetchedBitmapUrlsRef.current.size > 300) {
        prefetchedBitmapUrlsRef.current.clear();
      }
      prefetchedBitmapUrlsRef.current.add(url);
      const img = new Image();
      img.src = url;
    }
  }, [mainCueIndex, topCueIndex, topSubEnabled, adjustedTime]);

  // Background style classes
  const bgClass = useMemo(() => {
    switch (bgStyle) {
      case 'translucent':
        return 'bg-black/60 backdrop-blur-[2px] rounded-xl px-4 py-1.5 shadow-lg';
      case 'semi':
        return 'bg-black/80 rounded-xl px-4 py-1.5 shadow-xl';
      case 'solid':
        return 'bg-black/95 rounded-xl px-4 py-1.5 shadow-2xl';
      case 'none':
      default:
        return 'px-3 py-1';
    }
  }, [bgStyle]);

  const activeFontFamily = FONT_FAMILIES[fontFamily] || FONT_FAMILIES.sans;
  const computedShadow = useMemo(() => getSubtitleTextShadow(outlineWidth, outlineColor), [outlineWidth, outlineColor]);
  const bitmapSizeScale = Math.max(0.65, Math.min(1.5, fontSize / 38));

  return (
    <div
      className="absolute inset-0 pointer-events-none select-none z-20 flex flex-col justify-between p-8 overflow-hidden"
      style={{
        transform: 'translateZ(0)',
        backfaceVisibility: 'hidden',
        willChange: 'transform',
      }}
    >
      {/* Main Subtitle PGS Bitmaps positioned in exact video-frame coordinates */}
      {activeMainBitmapCues.length > 0 && (() => {
        const firstBmp = activeMainBitmapCues[0]?.bitmaps?.[0];
        const cw = firstBmp?.canvasWidth || 1920;
        const ch = firstBmp?.canvasHeight || 1080;
        return (
          <div className="absolute inset-0 pointer-events-none select-none flex items-center justify-center">
            <div
              className="relative"
              style={{
                width: `min(100vw, ${(100 * (cw / ch)).toFixed(4)}vh)`,
                height: `min(100vh, ${(100 * (ch / cw)).toFixed(4)}vw)`,
              }}
            >
              {activeMainBitmapCues.map((cue) =>
                (cue.bitmaps || []).map((b, bIdx) => {
                  const objCw = b.canvasWidth || cw;
                  const objCh = b.canvasHeight || ch;
                  const isNearBottom = (b.y + b.height) / objCh > 0.78;
                  return (
                    <img
                      key={`${cue.id || cue.start}-${bIdx}`}
                      src={b.url}
                      alt=""
                      draggable={false}
                      className={`absolute pointer-events-none select-none object-contain transition-transform duration-300 ease-out ${
                        isNearBottom && controlsVisible ? '-translate-y-20' : 'translate-y-0'
                      }`}
                      style={{
                        left: `${(b.x / objCw) * 100}%`,
                        top: `${(b.y / objCh) * 100}%`,
                        width: `${(b.width / objCw) * 100}%`,
                        height: `${(b.height / objCh) * 100}%`,
                      }}
                    />
                  );
                })
              )}
            </div>
          </div>
        );
      })()}

      {/* 2nd Subtitle / Signs (Top) */}
      <div
        className={`w-full flex flex-col items-center justify-start gap-1.5 min-h-[60px] pt-2 transition-transform duration-300 ease-out ${
          controlsVisible ? 'translate-y-14' : 'translate-y-0'
        }`}
      >
        {activeTopBitmapCues.length > 0 && (
          <div className="w-full flex flex-col items-center gap-1 subtitles-overlay-top-bitmap">
            {activeTopBitmapCues.map((cue) => {
              const sortedBitmaps = [...(cue.bitmaps || [])].sort((a, b) => a.y - b.y || a.x - b.x);
              return (
                <div key={cue.id || cue.start} className="flex flex-col items-center gap-0.5">
                  {sortedBitmaps.map((b, bIdx) => {
                    const cw = b.canvasWidth || 1920;
                    const ch = b.canvasHeight || 1080;
                    const hVh = (b.height / ch) * 100 * bitmapSizeScale;
                    const hVw = (b.height / cw) * 100 * bitmapSizeScale;
                    return (
                      <img
                        key={bIdx}
                        src={b.url}
                        alt=""
                        draggable={false}
                        className="max-w-[92vw] w-auto object-contain pointer-events-none select-none"
                        style={{ height: `min(${hVh.toFixed(3)}vh, ${hVw.toFixed(3)}vw)` }}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        {activeTopTextCues.length > 0 && (
          <div
            className="max-w-[92vw] text-center px-4 py-1 rounded bg-black/60 transition-opacity duration-150 subtitles-overlay-top flex flex-col space-y-1"
            style={{
              fontSize: `${Math.round(fontSize * 0.85)}px`,
              color: '#fef08a', // High-visibility soft yellow for signs/forced
              fontFamily: activeFontFamily,
              textShadow: computedShadow,
            }}
          >
            {activeTopTextCues.map((cue) => (
              <div key={cue.id || cue.start}>
                {cue.text.split('\n').map((line, idx) => (
                  <div key={idx}>{line}</div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Main Dialogue (Bottom) */}
      {/* Smoothly glides up above the timeline scrubber when UI controls appear, and returns down when UI hides */}
      <div
        className={`w-full flex justify-center items-end min-h-[80px] pb-4 transition-transform duration-300 ease-out ${
          controlsVisible ? '-translate-y-24' : 'translate-y-0'
        }`}
      >
        {activeMainTextCues.length > 0 && (
          <div
            className={`max-w-[92vw] text-center transition-opacity duration-100 flex flex-col space-y-1.5 subtitles-overlay-main ${bgClass}`}
            style={{
              fontSize: `${fontSize}px`,
              color: textColor,
              fontFamily: activeFontFamily,
              textShadow: computedShadow,
            }}
          >
            {activeMainTextCues.map((cue) => (
              <div key={cue.id || cue.start}>
                {cue.text.split('\n').map((line, idx) => (
                  <div key={idx}>{line}</div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
