/**
 * VPN tunnel detection for the P2P guard (BYOC — no bundled credentials, no
 * bundled endpoints). Purely local: reads os.networkInterfaces() and matches
 * well-known tunnel adapter naming patterns. No child processes, no network
 * probes, no telemetry.
 *
 * The result is cached for 10 seconds because adapter enumeration is not free
 * and the P2P guard may poll it around every download start/pause decision.
 * Tests can reset the cache with clearVpnCache().
 */

import os from 'os';
import type { VpnStatus } from './types.ts';

/**
 * Matches the interface-name (or alias description) fragments commonly used by
 * VPN tunnel adapters across platforms: generic tun/tap/ppp, WireGuard, and
 * the most common commercial client adapter names. Fully generic patterns —
 * no provider is endorsed, required, or bundled.
 */
const VPN_INTERFACE_PATTERN =
  /(tun|tap|wg|wireguard|vpn|ppp|tailscale|protonvpn|nord|mullvad|surfshark|expressvpn|openvpn)/i;

/** How long a detected status is reused before re-enumerating adapters. */
const CACHE_TTL_MS = 10_000;

/** Module-level cache; null means "no cached status, re-detect". */
let cachedStatus: VpnStatus | null = null;

/**
 * Detect whether at least one VPN tunnel adapter is currently present.
 * Cached for 10 seconds; call clearVpnCache() to force a fresh detection.
 */
export function detectVpnStatus(): VpnStatus {
  if (cachedStatus && Date.now() - cachedStatus.checkedAt < CACHE_TTL_MS) {
    return cachedStatus;
  }
  cachedStatus = computeVpnStatus();
  return cachedStatus;
}

/** Drop the cached status so the next detectVpnStatus() re-enumerates. */
export function clearVpnCache(): void {
  cachedStatus = null;
}

/**
 * Enumerate adapters and collect the names of tunnel-like ones. An interface
 * counts when its NAME matches, even if Node reports it as internal — TUN
 * adapters on Windows frequently report internal: true. Alias descriptions
 * (when the runtime exposes them) are matched too, so a plain adapter name
 * with a vendor-provided tunnel description is still detected.
 */
function computeVpnStatus(): VpnStatus {
  const matches = new Set<string>();
  const tables = os.networkInterfaces();
  for (const [name, aliases] of Object.entries(tables)) {
    let matched = VPN_INTERFACE_PATTERN.test(name);
    if (!matched) {
      for (const alias of aliases ?? []) {
        // Node's public types omit `description`, but runtimes may attach it.
        const description = (alias as { description?: unknown }).description;
        if (typeof description === 'string' && VPN_INTERFACE_PATTERN.test(description)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) matches.add(name);
  }
  return {
    active: matches.size > 0,
    interfaces: [...matches].sort((a, b) => a.localeCompare(b)),
    checkedAt: Date.now(),
  };
}
