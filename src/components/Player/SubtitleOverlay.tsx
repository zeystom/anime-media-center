import React, { useMemo } from 'react';
import { SubtitleCue } from '../../types';

interface SubtitleOverlayProps {
  currentTime: number;
  mainCues: SubtitleCue[];
  topCues: SubtitleCue[];
  topSubEnabled: boolean;
  syncOffset: number; // in seconds
  fontSize: number;   // default 28
  hasOutline: boolean;
  controlsVisible?: boolean;
}

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = ({
  currentTime,
  mainCues,
  topCues,
  topSubEnabled,
  syncOffset,
  fontSize,
  hasOutline,
  controlsVisible = false,
}) => {
  // Apply sync offset to current playback time
  const adjustedTime = currentTime + syncOffset;

  // Find active main dialogue cue (Bottom)
  const activeMainCue = useMemo(() => {
    if (!mainCues || mainCues.length === 0) return null;
    return mainCues.find(cue => adjustedTime >= cue.start && adjustedTime <= cue.end);
  }, [mainCues, adjustedTime]);

  // Find active signs/forced cue (Top)
  const activeTopCue = useMemo(() => {
    if (!topSubEnabled || !topCues || topCues.length === 0) return null;
    return topCues.find(cue => adjustedTime >= cue.start && adjustedTime <= cue.end);
  }, [topCues, adjustedTime, topSubEnabled]);

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
            className={`max-w-4xl text-center px-4 py-1 rounded bg-black/60 transition-opacity duration-150 ${
              hasOutline ? 'subtitles-overlay-top' : ''
            }`}
            style={{
              fontSize: `${Math.round(fontSize * 0.85)}px`,
              color: '#fef08a', // High-visibility soft yellow for signs/forced
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
        {activeMainCue && (
          <div
            className={`max-w-4xl text-center px-5 py-1.5 rounded transition-opacity duration-100 ${
              hasOutline ? 'subtitles-overlay-main' : ''
            }`}
            style={{
              fontSize: `${fontSize}px`,
              color: '#ffffff',
            }}
          >
            {activeMainCue.text.split('\n').map((line, idx) => (
              <div key={idx}>{line}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
