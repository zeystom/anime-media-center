import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronLeft, ListVideo, Sparkles } from 'lucide-react';

interface MagneticEpisodePeekProps {
  isOpen: boolean;
  onOpen: () => void;
  areControlsVisible: boolean;
  episodeCount: number;
}

/**
 * Computes a smooth organic magnetic cubic bézier curve along the right screen edge.
 * Returns SVG path string.
 */
function calculateArcPath(
  svgWidth: number,
  apexY: number,
  protrusion: number,
  halfHeight: number
): string {
  if (protrusion <= 0.5) return '';

  const yTop = apexY - halfHeight;
  const yBottom = apexY + halfHeight;
  const apexX = svgWidth - protrusion;

  // Cubic Bézier control points:
  // cp1: leaves the screen edge purely vertically (tangent dx/dy = 0)
  const cp1X = svgWidth;
  const cp1Y = yTop + halfHeight * 0.42;

  // cp2: reaches apex tangentially
  const cp2X = apexX + protrusion * 0.12;
  const cp2Y = apexY - halfHeight * 0.38;

  // cp3: departs apex tangentially
  const cp3X = apexX + protrusion * 0.12;
  const cp3Y = apexY + halfHeight * 0.38;

  // cp4: returns into screen edge purely vertically
  const cp4X = svgWidth;
  const cp4Y = yBottom - halfHeight * 0.42;

  return `M ${svgWidth} ${yTop} C ${cp1X} ${cp1Y}, ${cp2X} ${cp2Y}, ${apexX} ${apexY} C ${cp3X} ${cp3Y}, ${cp4X} ${cp4Y}, ${svgWidth} ${yBottom} L ${svgWidth} ${yTop} Z`;
}

export const MagneticEpisodePeek: React.FC<MagneticEpisodePeekProps> = ({
  isOpen,
  onOpen,
  areControlsVisible,
  episodeCount,
}) => {
  const [pull, setPull] = useState<number>(0);
  const [currentY, setCurrentY] = useState<number>(() => (typeof window !== 'undefined' ? window.innerHeight / 2 : 400));

  // Refs for high-performance physics animation loop without re-rendering parent VideoPlayer
  const targetPullRef = useRef<number>(0);
  const currentPullRef = useRef<number>(0);
  const targetYRef = useRef<number>(typeof window !== 'undefined' ? window.innerHeight / 2 : 400);
  const currentYRef = useRef<number>(typeof window !== 'undefined' ? window.innerHeight / 2 : 400);
  const animFrameRef = useRef<number | null>(null);
  const isRunningRef = useRef<boolean>(false);

  // SVG dimensions
  const SVG_WIDTH = 140;
  const MAX_PROTRUSION = 56;
  const HALF_HEIGHT = 115;

  // Update physics loop
  const updatePhysics = useCallback(() => {
    // Smooth elastic spring lerp
    currentPullRef.current += (targetPullRef.current - currentPullRef.current) * 0.2;
    currentYRef.current += (targetYRef.current - currentYRef.current) * 0.24;

    // Check if close enough to rest
    const pullDiff = Math.abs(targetPullRef.current - currentPullRef.current);
    const yDiff = Math.abs(targetYRef.current - currentYRef.current);

    setPull(currentPullRef.current);
    setCurrentY(currentYRef.current);

    if (pullDiff > 0.002 || yDiff > 0.5 || targetPullRef.current > 0.01) {
      animFrameRef.current = requestAnimationFrame(updatePhysics);
    } else {
      currentPullRef.current = targetPullRef.current;
      setPull(targetPullRef.current);
      isRunningRef.current = false;
      animFrameRef.current = null;
    }
  }, []);

  const ensurePhysicsRunning = useCallback(() => {
    if (!isRunningRef.current) {
      isRunningRef.current = true;
      animFrameRef.current = requestAnimationFrame(updatePhysics);
    }
  }, [updatePhysics]);

  useEffect(() => {
    if (isOpen) {
      targetPullRef.current = 0;
      currentPullRef.current = 0;
      setPull(0);
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        isRunningRef.current = false;
      }
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      // Safe vertical zone: exclude top navbar (80px) and bottom controls bar (135px)
      const isSafeVertical = e.clientY > 80 && e.clientY < windowHeight - 135;
      const distToRight = windowWidth - e.clientX;

      // Approach zone: within 145px of right edge
      if (isSafeVertical && distToRight >= 0 && distToRight <= 145) {
        // Clamp Y to keep arc nicely on screen
        const clampedY = Math.max(HALF_HEIGHT + 20, Math.min(windowHeight - HALF_HEIGHT - 60, e.clientY));
        targetYRef.current = clampedY;

        // Normalized pull: 0 at 145px, 1 at edge
        const normalized = Math.max(0, Math.min(1, 1 - distToRight / 145));
        // Exponential curve for organic magnetic feel
        targetPullRef.current = Math.pow(normalized, 1.25);

        ensurePhysicsRunning();

        // Snap threshold: if cursor reaches within 16px of right edge, open drawer
        if (distToRight <= 16 && targetPullRef.current > 0.85) {
          targetPullRef.current = 0;
          currentPullRef.current = 0;
          setPull(0);
          onOpen();
        }
      } else {
        if (targetPullRef.current !== 0) {
          targetPullRef.current = 0;
          ensurePhysicsRunning();
        }
      }
    };

    const handleMouseLeave = () => {
      targetPullRef.current = 0;
      ensurePhysicsRunning();
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseleave', handleMouseLeave, { passive: true });

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseleave', handleMouseLeave);
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [isOpen, onOpen, ensurePhysicsRunning]);

  if (isOpen) return null;

  const protrusion = pull * MAX_PROTRUSION;
  const arcPath = calculateArcPath(SVG_WIDTH, currentY, protrusion, HALF_HEIGHT);
  const apexX = SVG_WIDTH - protrusion;

  return (
    <>
      {/* 1. Subtle Resting Tab when mouse is idle / far from edge */}
      <div
        onClick={onOpen}
        className={`fixed right-0 top-1/2 -translate-y-1/2 z-40 pr-1 pl-2.5 py-4 rounded-l-2xl bg-zinc-900/60 hover:bg-zinc-800 text-zinc-400 hover:text-white border-y border-l border-white/10 shadow-xl backdrop-blur-md cursor-pointer transition-all duration-300 group flex items-center space-x-1.5 select-none ${
          areControlsVisible && pull < 0.15
            ? 'opacity-70 translate-x-0'
            : 'opacity-0 translate-x-4 pointer-events-none'
        }`}
        title="Episodes (move cursor to right edge)"
      >
        <ChevronLeft className="w-4 h-4 text-zinc-400 group-hover:text-red-400 transition-colors" />
        <span className="text-[11px] font-semibold tracking-wider uppercase text-zinc-300 group-hover:text-white [writing-mode:vertical-lr] rotate-180">
          Episodes
        </span>
      </div>

      {/* 2. Dynamic Magnetic Peek Arc (Springs and curves out towards cursor) */}
      <div
        className={`fixed right-0 top-0 bottom-0 pointer-events-none z-45 select-none transition-opacity duration-200 ${
          areControlsVisible && pull >= 0.05 ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ width: `${SVG_WIDTH}px` }}
      >
        {/* Organic SVG Arc */}
        <svg className="w-full h-full overflow-visible pointer-events-none">
          <defs>
            {/* High-tech glassmorphism dark gradient */}
            <linearGradient id="magnetic-arc-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#1a1a22" stopOpacity="0.95" />
              <stop offset="50%" stopColor="#131318" stopOpacity="0.97" />
              <stop offset="100%" stopColor="#0c0c0f" stopOpacity="0.98" />
            </linearGradient>

            {/* Glowing magnetic red accent drop shadow */}
            <filter id="magnetic-arc-glow" x="-50%" y="-30%" width="180%" height="160%">
              <feDropShadow
                dx="-2"
                dy="0"
                stdDeviation={6 + pull * 8}
                floodColor="#ef4444"
                floodOpacity={0.2 + pull * 0.45}
              />
              <feDropShadow dx="-1" dy="0" stdDeviation="2" floodColor="#ffffff" floodOpacity="0.1" />
            </filter>
          </defs>

          {arcPath && (
            <path
              d={arcPath}
              fill="url(#magnetic-arc-gradient)"
              stroke="rgba(255, 255, 255, 0.18)"
              strokeWidth="1.2"
              filter="url(#magnetic-arc-glow)"
              className="pointer-events-auto cursor-pointer transition-colors hover:stroke-red-500/50"
              onClick={onOpen}
            />
          )}
        </svg>

        {/* Apex Content & Icon Handle (Centered exactly at apex of the magnetic arc) */}
        {pull >= 0.08 && (
          <div
            onClick={onOpen}
            className="absolute pointer-events-auto cursor-pointer flex items-center group -translate-y-1/2"
            style={{
              left: `${apexX + 2}px`,
              top: `${currentY}px`,
              opacity: Math.min(1, (pull - 0.08) / 0.25),
            }}
            title="Open Episodes Drawer"
          >
            {/* Magnetic Pill Handle */}
            <div className="flex items-center space-x-1.5 px-2.5 py-2 rounded-l-xl bg-red-600/20 group-hover:bg-red-600/30 border-y border-l border-red-500/40 text-white shadow-lg backdrop-blur-md transition-all duration-150">
              <ChevronLeft
                className={`w-4 h-4 text-red-400 group-hover:text-white transition-transform duration-200 ${
                  pull > 0.5 ? '-translate-x-0.5 scale-110' : ''
                }`}
              />

              {pull > 0.35 && (
                <div className="flex items-center space-x-1.5 animate-in fade-in duration-150 whitespace-nowrap">
                  <span className="text-[11px] font-bold tracking-wide uppercase text-zinc-200 group-hover:text-white">
                    Episodes
                  </span>
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-500/30 text-red-300 border border-red-500/40">
                    {episodeCount}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
};
