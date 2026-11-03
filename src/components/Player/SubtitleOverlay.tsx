import React, { useMemo } from 'react';
import { SubtitleCue } from '../../types';

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

  // Find all active main dialogue cues (Bottom, up to 3 overlapping cues)
  const activeMainCues = useMemo(() => {
    if (!mainCues || mainCues.length === 0) return [];
    return mainCues
      .filter((cue) => adjustedTime >= cue.start && adjustedTime <= cue.end)
      .slice(0, 3);
  }, [mainCues, adjustedTime]);

  // Find active signs/forced cue (Top)
  const activeTopCue = useMemo(() => {
    if (!topSubEnabled || !topCues || topCues.length === 0) return null;
    return topCues.find(cue => adjustedTime >= cue.start && adjustedTime <= cue.end);
  }, [topCues, adjustedTime, topSubEnabled]);

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

  return (
    <div
      className="absolute inset-0 pointer-events-none select-none z-20 flex flex-col justify-between p-8 overflow-hidden"
      style={{
        transform: 'translateZ(0)',
        backfaceVisibility: 'hidden',
        willChange: 'transform',
      }}
    >
      {/* 2nd Subtitle / Signs (Top) */}
      <div
        className={`w-full flex justify-center items-start min-h-[60px] pt-2 transition-transform duration-300 ease-out ${
          controlsVisible ? 'translate-y-14' : 'translate-y-0'
        }`}
      >
        {activeTopCue && (
          <div
            className="max-w-4xl text-center px-4 py-1 rounded bg-black/60 transition-opacity duration-150 subtitles-overlay-top"
            style={{
              fontSize: `${Math.round(fontSize * 0.85)}px`,
              color: '#fef08a', // High-visibility soft yellow for signs/forced
              fontFamily: activeFontFamily,
              textShadow: computedShadow,
            }}
          >
            {activeTopCue.text.split('\n').map((line, idx) => (
              <div key={idx}>{line}</div>
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
        {activeMainCues.length > 0 && (
          <div
            className={`max-w-4xl text-center transition-opacity duration-100 flex flex-col space-y-1.5 subtitles-overlay-main ${bgClass}`}
            style={{
              fontSize: `${fontSize}px`,
              color: textColor,
              fontFamily: activeFontFamily,
              textShadow: computedShadow,
            }}
          >
            {activeMainCues.map((cue) => (
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
