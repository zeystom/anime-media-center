export interface RangeDragSelectionParams {
  orderedPaths: readonly string[];
  baseSelection: ReadonlySet<string>;
  anchorIndex: number;
  targetIndex: number;
  select: boolean;
}

/**
 * Computes the next selection set for a phone-gallery range drag from `anchorIndex`
 * to `targetIndex`. Preserves `baseSelection` outside the active range so moving the
 * pointer back before releasing cleanly restores previously untouched items.
 */
export function computeRangeDragSelection({
  orderedPaths,
  baseSelection,
  anchorIndex,
  targetIndex,
  select,
}: RangeDragSelectionParams): Set<string> {
  const next = new Set(baseSelection);
  if (
    orderedPaths.length === 0 ||
    anchorIndex < 0 ||
    targetIndex < 0 ||
    anchorIndex >= orderedPaths.length ||
    targetIndex >= orderedPaths.length
  ) {
    return next;
  }

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  for (let i = start; i <= end; i++) {
    const path = orderedPaths[i];
    if (!path) continue;
    if (select) {
      next.add(path);
    } else {
      next.delete(path);
    }
  }
  return next;
}

/**
 * Resolves the episode index under `(clientX, clientY)` inside the card grid, falling
 * back to row/gap geometry when the pointer sits in a grid gutter or past the last card of a row.
 */
export function resolveEpisodeCardIndexFromPoint(
  orderedPaths: readonly string[],
  containerEl: HTMLElement | null,
  clientX: number,
  clientY: number
): number {
  if (orderedPaths.length === 0 || typeof document === 'undefined') return -1;

  const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  const hitCard = hit?.closest('[data-episode-card]') as HTMLElement | null;
  if (hitCard && (!containerEl || containerEl.contains(hitCard))) {
    const path = hitCard.getAttribute('data-episode-card');
    if (path) {
      const idx = orderedPaths.indexOf(path);
      if (idx !== -1) return idx;
    }
  }

  if (!containerEl) return -1;
  const cards = containerEl.querySelectorAll<HTMLElement>('[data-episode-card]');
  if (cards.length === 0) return -1;

  let bestRowPath: string | null = null;
  let bestRowHorizDist = Infinity;

  let bestOverallPath: string | null = null;
  let bestOverallDistSq = Infinity;

  let minTop = Infinity;
  let maxBottom = -Infinity;

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const path = card.getAttribute('data-episode-card');
    if (!path) continue;
    const rect = card.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    if (rect.top < minTop) minTop = rect.top;
    if (rect.bottom > maxBottom) maxBottom = rect.bottom;

    const dx = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;

    if (clientY >= rect.top - 6 && clientY <= rect.bottom + 6) {
      if (dx < bestRowHorizDist) {
        bestRowHorizDist = dx;
        bestRowPath = path;
      }
    }

    const distSq = dx * dx + dy * dy;
    if (distSq < bestOverallDistSq) {
      bestOverallDistSq = distSq;
      bestOverallPath = path;
    }
  }

  if (bestRowPath) {
    return orderedPaths.indexOf(bestRowPath);
  }
  if (clientY < minTop) {
    return 0;
  }
  if (clientY > maxBottom) {
    return orderedPaths.length - 1;
  }
  return bestOverallPath ? orderedPaths.indexOf(bestOverallPath) : -1;
}
