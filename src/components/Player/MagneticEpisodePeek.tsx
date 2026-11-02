import React, { useEffect, useRef, useCallback } from 'react';
import { ChevronLeft } from 'lucide-react';

interface MagneticEpisodePeekProps {
  isOpen: boolean;
  onOpen: () => void;
  areControlsVisible: boolean;
  episodeCount: number;
  onActivity?: () => void;
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
  onActivity,
}) => {
  // DOM Refs for ZERO React re-renders during 144Hz mouse movement
  const containerRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const restingTabRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);

  // Physics animation variables in refs (bypass React state completely for buttery 144fps)
  const targetPullRef = useRef<number>(0);
  const currentPullRef = useRef<number>(0);
  const targetYRef = useRef<number>(typeof window !== 'undefined' ? window.innerHeight / 2 : 400);
  const currentYRef = useRef<number>(typeof window !== 'undefined' ? window.innerHeight / 2 : 400);
  const animFrameRef = useRef<number | null>(null);
  const isRunningRef = useRef<boolean>(false);

  // Keep callback refs stable
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;

  const areControlsVisibleRef = useRef(areControlsVisible);
  areControlsVisibleRef.current = areControlsVisible;

  // SVG dimensions
  const SVG_WIDTH = 140;
  const MAX_PROTRUSION = 58;
  const HALF_HEIGHT = 115;

  // Direct GPU DOM update function - 0ms overhead, no React reconciler
  const renderDOM = useCallback((pullVal: number, yVal: number) => {
    const protrusion = pullVal * MAX_PROTRUSION;
    const apexX = SVG_WIDTH - protrusion;

    // 1. Update SVG Path
    if (pathRef.current) {
      if (protrusion > 0.5) {
        const d = calculateArcPath(SVG_WIDTH, yVal, protrusion, HALF_HEIGHT);
        pathRef.current.setAttribute('d', d);
      } else {
        pathRef.current.setAttribute('d', '');
      }
    }

    // 2. Update Dynamic Arc Container Opacity
    if (containerRef.current) {
      if (pullVal >= 0.04) {
        containerRef.current.style.opacity = '1';
        containerRef.current.style.pointerEvents = 'auto';
      } else {
        containerRef.current.style.opacity = '0';
        containerRef.current.style.pointerEvents = 'none';
      }
    }

    // 3. Update Apex Pill Handle Position & Visibility
    if (handleRef.current) {
      if (pullVal >= 0.06) {
        handleRef.current.style.transform = `translate3d(${apexX + 2}px, ${yVal}px, 0) translateY(-50%)`;
        const handleOpacity = Math.min(1, (pullVal - 0.06) / 0.22);
        handleRef.current.style.opacity = `${handleOpacity}`;
        handleRef.current.style.pointerEvents = 'auto';
      } else {
        handleRef.current.style.opacity = '0';
        handleRef.current.style.pointerEvents = 'none';
      }
    }

    // 4. Update Badge (Episodes + count)
    if (badgeRef.current) {
      if (pullVal > 0.35) {
        badgeRef.current.style.display = 'flex';
        badgeRef.current.style.opacity = `${Math.min(1, (pullVal - 0.35) / 0.25)}`;
      } else {
        badgeRef.current.style.display = 'none';
        badgeRef.current.style.opacity = '0';
      }
    }

    // 5. Update Resting Tab (cross-fades out when magnetic pull starts)
    if (restingTabRef.current) {
      const showResting = areControlsVisibleRef.current && pullVal < 0.12;
      restingTabRef.current.style.opacity = showResting ? '0.7' : '0';
      restingTabRef.current.style.pointerEvents = showResting ? 'auto' : 'none';
      restingTabRef.current.style.transform = showResting
        ? 'translateY(-50%) translateX(0)'
        : 'translateY(-50%) translateX(16px)';
    }
  }, []);

  // High-performance Physics loop
  const updatePhysics = useCallback(() => {
    // Smooth elastic spring lerp
    currentPullRef.current += (targetPullRef.current - currentPullRef.current) * 0.22;
    currentYRef.current += (targetYRef.current - currentYRef.current) * 0.26;

    const pullDiff = Math.abs(targetPullRef.current - currentPullRef.current);
    const yDiff = Math.abs(targetYRef.current - currentYRef.current);

    // Apply to DOM directly without React re-render
    renderDOM(currentPullRef.current, currentYRef.current);

    // Keep loop alive only while actively animating towards target
    if (pullDiff > 0.001 || yDiff > 0.2) {
      animFrameRef.current = requestAnimationFrame(updatePhysics);
    } else {
      // Snap to exact target and stop RAF to conserve 100% CPU/GPU
      currentPullRef.current = targetPullRef.current;
      currentYRef.current = targetYRef.current;
      renderDOM(currentPullRef.current, currentYRef.current);
      isRunningRef.current = false;
      animFrameRef.current = null;
    }
  }, [renderDOM]);

  const ensurePhysicsRunning = useCallback(() => {
    if (!isRunningRef.current) {
      isRunningRef.current = true;
      animFrameRef.current = requestAnimationFrame(updatePhysics);
    }
  }, [updatePhysics]);

  // Sync resting tab whenever areControlsVisible changes externally
  useEffect(() => {
    if (restingTabRef.current) {
      const showResting = areControlsVisible && currentPullRef.current < 0.12;
      restingTabRef.current.style.opacity = showResting ? '0.7' : '0';
      restingTabRef.current.style.pointerEvents = showResting ? 'auto' : 'none';
      restingTabRef.current.style.transform = showResting
        ? 'translateY(-50%) translateX(0)'
        : 'translateY(-50%) translateX(16px)';
    }
  }, [areControlsVisible]);

  useEffect(() => {
    if (isOpen) {
      targetPullRef.current = 0;
      currentPullRef.current = 0;
      renderDOM(0, currentYRef.current);
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        isRunningRef.current = false;
      }
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;

      // Safe vertical zone: strictly exclude top navbar (80px) and bottom controls bar (135px)
      const isSafeVertical = e.clientY > 80 && e.clientY < windowHeight - 135;
      const distToRight = windowWidth - e.clientX;

      // Approach zone: within 150px of right edge
      if (isSafeVertical && distToRight >= 0 && distToRight <= 150) {
        // Keep player controls alive while user hovers the magnetic zone
        if (onActivityRef.current) {
          onActivityRef.current();
        }

        // Clamp Y to keep arc smoothly within visible screen bounds
        const clampedY = Math.max(HALF_HEIGHT + 20, Math.min(windowHeight - HALF_HEIGHT - 60, e.clientY));
        targetYRef.current = clampedY;

        // Normalized pull: 0 at 150px, 1 at edge
        const normalized = Math.max(0, Math.min(1, 1 - distToRight / 150));
        // Exponential curve for organic magnetic feel
        targetPullRef.current = Math.pow(normalized, 1.25);

        ensurePhysicsRunning();

        // Snap threshold: if cursor reaches within 16px of right edge, open drawer
        if (distToRight <= 16 && targetPullRef.current > 0.85) {
          targetPullRef.current = 0;
          currentPullRef.current = 0;
          renderDOM(0, currentYRef.current);
          onOpenRef.current();
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
  }, [isOpen, ensurePhysicsRunning, renderDOM]);

  if (isOpen) return null;

  return (
    <>
      {/* 1. Subtle Resting Tab when mouse is idle / far from edge */}
      <div
        ref={restingTabRef}
        onClick={() => onOpenRef.current()}
        className="fixed right-0 top-1/2 -translate-y-1/2 z-40 pr-1 pl-2.5 py-4 rounded-l-2xl bg-zinc-900/60 hover:bg-zinc-800 text-zinc-400 hover:text-white border-y border-l border-white/10 shadow-xl backdrop-blur-md cursor-pointer transition-all duration-300 group flex items-center space-x-1.5 select-none opacity-0 pointer-events-none"
        title="Episodes (or push cursor to right edge)"
      >
        <ChevronLeft className="w-4 h-4 text-zinc-400 group-hover:text-red-400 transition-colors" />
        <span className="text-[11px] font-semibold tracking-wider uppercase text-zinc-300 group-hover:text-white [writing-mode:vertical-lr] rotate-180">
          Episodes
        </span>
      </div>

      {/* 2. Dynamic Magnetic Peek Arc (Springs and curves out towards cursor) */}
      <div
        ref={containerRef}
        className="fixed right-0 top-0 bottom-0 pointer-events-none z-45 select-none opacity-0"
        style={{ width: `${SVG_WIDTH}px` }}
      >
        {/* Organic SVG Arc */}
        <svg className="w-full h-full overflow-visible pointer-events-none">
          <defs>
            {/* High-tech glassmorphism dark gradient */}
            <linearGradient id="magnetic-arc-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#1c1c24" stopOpacity="0.95" />
              <stop offset="50%" stopColor="#14141a" stopOpacity="0.97" />
              <stop offset="100%" stopColor="#0c0c10" stopOpacity="0.98" />
            </linearGradient>
          </defs>

          {/* SVG Path with native GPU CSS drop-shadow (zero shader re-compilation!) */}
          <path
            ref={pathRef}
            fill="url(#magnetic-arc-gradient)"
            stroke="rgba(255, 255, 255, 0.18)"
            strokeWidth="1.2"
            style={{
              filter: 'drop-shadow(-4px 0 14px rgba(239, 68, 68, 0.45)) drop-shadow(-1px 0 3px rgba(255, 255, 255, 0.12))',
            }}
            className="pointer-events-auto cursor-pointer transition-colors hover:stroke-red-500/60"
            onClick={() => onOpenRef.current()}
          />
        </svg>

        {/* Apex Content & Icon Handle (Centered exactly at apex of the magnetic arc) */}
        <div
          ref={handleRef}
          onClick={() => onOpenRef.current()}
          className="absolute pointer-events-auto cursor-pointer flex items-center group -translate-y-1/2 opacity-0 select-none"
          title="Open Episodes Drawer"
        >
          {/* Magnetic Pill Handle */}
          <div className="flex items-center space-x-1.5 px-2.5 py-2 rounded-l-xl bg-red-600/20 group-hover:bg-red-600/35 border-y border-l border-red-500/40 text-white shadow-lg backdrop-blur-md transition-all duration-150">
            <ChevronLeft className="w-4 h-4 text-red-400 group-hover:text-white transition-transform duration-200" />

            <div ref={badgeRef} className="items-center space-x-1.5 whitespace-nowrap hidden">
              <span className="text-[11px] font-bold tracking-wide uppercase text-zinc-200 group-hover:text-white">
                Episodes
              </span>
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-500/30 text-red-300 border border-red-500/40">
                {episodeCount}
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
