let suppressMouseMoveUntil = 0;

/**
 * Mark synthetic cursor-sync probes so stationary pointer hit-tests do not
 * wake the auto-hidden player HUD or trigger edge drawers.
 */
export function markSyntheticMouseMove(durationMs = 160): void {
  suppressMouseMoveUntil = Math.max(suppressMouseMoveUntil, performance.now() + durationMs);
}

export function isSyntheticMouseMove(): boolean {
  return performance.now() < suppressMouseMoveUntil;
}
