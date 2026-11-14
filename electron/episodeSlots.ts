/**
 * Slot resolution for the episode merge (pure — no electron dependencies, so
 * bulk validation harnesses can run it directly against cached snapshots).
 *
 * ani.zip's AniDB crosswalks sometimes number franchise extras (OVAs,
 * epilogue specials) as regular episodes — observed live on Steins;Gate:
 * the "Egoistic Poriomania" OVA crosswalked as ep 1 (aired ~10 months after
 * the real slot) while the true "Turning Point" was missing from the payload
 * entirely. Episode numbers alone cannot be trusted when an AniList airing
 * schedule exists: air dates identify the true owner of a slot.
 */

export interface SlotEpisodeRow {
  number: number;
  title?: string | null;
  thumbnailUrl?: string | null;
  airDate?: string | null;
  runtime?: number | null;
}

/** Episodes airing within this window of a schedule slot may claim it. */
export const TIGHT_DATE_TOLERANCE_MS = 3 * 24 * 60 * 60 * 1000;
/** A number-anchored row further than this from its own slot is treated as a
 *  mis-numbered extra and excluded from the grid (45 days still tolerates
 *  pre-air screenings, recap weeks and mid-cour hiatuses — the AniList
 *  schedule spine covers legitimate gaps because it lists every real slot). */
export const LOOSE_DATE_TOLERANCE_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * Picks the ani.zip row that owns slot `number`. `consumed` is mutated: one
 * row can never fill two slots. Returns null when nothing may fill the slot
 * (streaming/Kitsu sources get their turn afterwards).
 *
 * Resolution order:
 *  1. closest-air-date row within the tight window — reliable even when the
 *     payload's numbering is shifted or polluted;
 *  2. the number-anchored row, but only when its own air date sits within the
 *     loose window of the slot (or it has no date at all);
 *  3. nothing — a row deviating further than the loose window from its own
 *     slot is an extra, not a TV episode.
 */
export function resolveSlotRow(
  number: number,
  rowPool: SlotEpisodeRow[],
  consumed: Set<SlotEpisodeRow>,
  scheduleByNumber: Map<number, number>,
  tightMs = TIGHT_DATE_TOLERANCE_MS,
  looseMs = LOOSE_DATE_TOLERANCE_MS,
): SlotEpisodeRow | null {
  const slot = scheduleByNumber.get(number);
  const byNumber = rowPool.find((row) => row.number === number && !consumed.has(row)) ?? null;

  if (slot == null || scheduleByNumber.size < 3) {
    // No usable schedule spine — the number is all we have (old behavior).
    if (byNumber) consumed.add(byNumber);
    return byNumber;
  }

  // Tight date-match first: when the payload's numbering disagrees with the
  // schedule (interleaved extras, off-by-one crosswalks), air dates identify
  // the true owner of the slot.
  let best: SlotEpisodeRow | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const row of rowPool) {
    if (consumed.has(row) || !row.airDate) continue;
    const airTime = Date.parse(row.airDate);
    if (!Number.isFinite(airTime)) continue;
    const dist = Math.abs(airTime - slot);
    if (dist < bestDist || (dist === bestDist && best != null && Math.abs(row.number - number) < Math.abs(best.number - number))) {
      best = row;
      bestDist = dist;
    }
  }
  if (best != null && bestDist <= tightMs) {
    consumed.add(best);
    return best;
  }

  // No row sits within hours of the slot: the number-anchored row may still
  // be the episode (hiatus weeks, lagging AniDB dates) while it stays within
  // the loose window. Beyond it — a mis-numbered extra; leave it unconsumed
  // so it never renders as a TV episode.
  if (byNumber) {
    const airTime = byNumber.airDate ? Date.parse(byNumber.airDate) : NaN;
    if (!Number.isFinite(airTime) || Math.abs(airTime - slot) <= looseMs) {
      consumed.add(byNumber);
      return byNumber;
    }
    return null;
  }
  return null;
}

/**
 * Flags rows whose air date lands AFTER every higher-numbered episode of the
 * season by more than `looseMs` — an ordering that is impossible for a
 * correctly numbered TV run. ani.zip crosswalks do this when a franchise
 * extra (OVA/epilogue special) is numbered as an early regular episode:
 * Steins;Gate's "Egoistic Poriomania" OVA crosswalked as ep 1 while airing
 * ~5 months after ep 24, pushing the true "Turning Point" out of the payload.
 *
 * Works without an AniList airing schedule (finished shows return none) —
 * the rows' own dates carry the signal.
 */
export function findLateNumberedExtras(
  rows: SlotEpisodeRow[],
  looseMs = LOOSE_DATE_TOLERANCE_MS,
): Set<SlotEpisodeRow> {
  const flagged = new Set<SlotEpisodeRow>();
  const sorted = [...rows]
    .filter((row) => row.airDate && Number.isFinite(Date.parse(row.airDate!)))
    .sort((a, b) => b.number - a.number);
  let laterMax = Number.NEGATIVE_INFINITY;
  for (const row of sorted) {
    const t = Date.parse(row.airDate!);
    // A flagged row must NOT raise the threshold: payloads can carry several
    // junk extras (Steins;Gate shipped an OVA at slot 1 AND a 2015 special at
    // slot 7) — the later junk would otherwise legitimise the earlier one.
    if (laterMax !== Number.NEGATIVE_INFINITY && t - laterMax > looseMs) {
      flagged.add(row);
      continue;
    }
    if (t > laterMax) laterMax = t;
  }
  return flagged;
}
