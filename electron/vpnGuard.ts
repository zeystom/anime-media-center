/**
 * VPN guard removed — user manages their own network safety.
 * Stub kept for API compatibility with existing imports.
 */

import type { VpnStatus } from './types.ts';

export function detectVpnStatus(): VpnStatus {
  return { active: true, interfaces: [], checkedAt: Date.now() };
}

export function clearVpnCache(): void {
  // no-op
}