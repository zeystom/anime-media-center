let scrollCooldownUntil = 0;

/** Records recent scroll activity without mutating DOM attributes or invalidating styles. */
export function markScrollActivity(cooldownMs = 150): void {
  const next = performance.now() + cooldownMs;
  if (next > scrollCooldownUntil) scrollCooldownUntil = next;
}

/** True while a vertical page or horizontal rail was recently scrolled. */
export function isScrollActive(): boolean {
  return performance.now() < scrollCooldownUntil;
}
