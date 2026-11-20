export type OverscrollSide = 'left' | 'right';

export interface OverscrollState {
  side: OverscrollSide | null;
  progress: number;
  pullPx: number;
  railShiftPx: number;
}

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  scrollLeft: number;
  maxScroll: number;
  clientWidth: number;
  now: number;
}

export interface WheelAction {
  preventDefault: boolean;
  engageScroll: boolean;
  markScrolling: boolean;
  nextScrollLeft: number | null;
  overscroll: OverscrollState | null;
  overscrollActive: boolean;
  scheduleReleaseMs: number | null;
  clearReleaseTimer: boolean;
  finishNow: boolean;
  isGestureStart: boolean;
}

export interface FinishWheelAction {
  overscroll: OverscrollState;
  wrapSide: OverscrollSide | null;
}

export interface WrapSuppressState {
  until: number;
  hardUntil: number;
  side: OverscrollSide;
  dir: -1 | 1;
  lastEventAt: number;
  lastAbsDx: number;
}

export interface HorizontalWheelState {
  axis: 'none' | 'horizontal' | 'vertical';
  ambiguousDx: number;
  ambiguousDy: number;
  active: boolean;
  startedAtEdge: boolean;
  pull: number;
  pullSide: OverscrollSide | null;
  activeDeadzone: number;
  activeThreshold: number;
  armedAt: number;
  inertiaFinalizing: boolean;
  peakAbsDx: number;
  peakAbsDxAtArm: number;
  lastAbsDx: number;
  lastRiseAt: number;
  lastEventAt: number;
  edgeBlockedMinDx: number;
  edgeBlockedStartAt: number;
  virtualScrollLeft: number | null;
  lastEmittedOverscroll: OverscrollState;
  wrapSuppress: WrapSuppressState | null;
}

export const EMPTY_OVERSCROLL: OverscrollState = { side: null, progress: 0, pullPx: 0, railShiftPx: 0 };
export const PULL_THRESHOLD = 110;
export const TOUCHPAD_PULL_THRESHOLD = 140;
export const TOUCHPAD_EDGE_DEADZONE = 18;
export const EDGE_EPSILON = 2.5;
export const GESTURE_GAP_MS = 120;
export const WHEEL_RELEASE_MS = 220;
export const TOUCHPAD_UNARMED_RELEASE_MS = 220;
export const TOUCHPAD_ARMED_RELEASE_MS = 140;
export const TOUCHPAD_INERTIA_FINALIZE_MS = 60;
export const TOUCHPAD_ARM_MIN_VISIBLE_MS = 110;
export const WRAP_SUPPRESS_MAX_MS = 900;
export const WRAP_SUPPRESS_HARD_MS = 260;

function noopAction(): WheelAction {
  return {
    preventDefault: false,
    engageScroll: false,
    markScrolling: false,
    nextScrollLeft: null,
    overscroll: null,
    overscrollActive: false,
    scheduleReleaseMs: null,
    clearReleaseTimer: false,
    finishNow: false,
    isGestureStart: false,
  };
}

export function computeOverscrollState(
  side: OverscrollSide,
  rawOverscroll: number,
  deadzone: number,
  threshold: number = PULL_THRESHOLD
): OverscrollState {
  const effectivePull = Math.max(0, rawOverscroll - deadzone);
  const progress = Math.min(1, effectivePull / threshold);
  const scaledPull = effectivePull * (PULL_THRESHOLD / threshold);
  const pullPx = scaledPull > 0 ? Math.min(44, Math.pow(scaledPull, 0.72) * 1.45) : 0;
  const railShiftPx = scaledPull > 0 ? Math.min(18, Math.pow(scaledPull, 0.65) * 0.75) : 0;
  return { side, progress, pullPx, railShiftPx };
}

export function createHorizontalWheelState(): HorizontalWheelState {
  return {
    axis: 'none',
    ambiguousDx: 0,
    ambiguousDy: 0,
    active: false,
    startedAtEdge: false,
    pull: 0,
    pullSide: null,
    activeDeadzone: TOUCHPAD_EDGE_DEADZONE,
    activeThreshold: TOUCHPAD_PULL_THRESHOLD,
    armedAt: 0,
    inertiaFinalizing: false,
    peakAbsDx: 0,
    peakAbsDxAtArm: 0,
    lastAbsDx: 0,
    lastRiseAt: 0,
    lastEventAt: 0,
    edgeBlockedMinDx: Infinity,
    edgeBlockedStartAt: 0,
    virtualScrollLeft: null,
    lastEmittedOverscroll: EMPTY_OVERSCROLL,
    wrapSuppress: null,
  };
}

export function resetHorizontalWheelState(state: HorizontalWheelState): void {
  state.axis = 'none';
  state.ambiguousDx = 0;
  state.ambiguousDy = 0;
  state.active = false;
  state.startedAtEdge = false;
  state.pull = 0;
  state.pullSide = null;
  state.activeDeadzone = TOUCHPAD_EDGE_DEADZONE;
  state.activeThreshold = TOUCHPAD_PULL_THRESHOLD;
  state.armedAt = 0;
  state.inertiaFinalizing = false;
  state.peakAbsDx = 0;
  state.peakAbsDxAtArm = 0;
  state.lastAbsDx = 0;
  state.lastRiseAt = 0;
  state.lastEventAt = 0;
  state.edgeBlockedMinDx = Infinity;
  state.edgeBlockedStartAt = 0;
  state.virtualScrollLeft = null;
  state.lastEmittedOverscroll = EMPTY_OVERSCROLL;
  state.wrapSuppress = null;
}

export function processHorizontalWheel(state: HorizontalWheelState, input: WheelInput): WheelAction {
  if (input.ctrlKey || input.maxScroll <= 2) {
    return noopAction();
  }

  const scale = input.deltaMode === 1
    ? 16
    : input.deltaMode === 2
      ? Math.max(260, input.clientWidth * 0.72)
      : 1;
  const isDiscreteWheel = input.deltaMode !== 0 || (input.shiftKey && input.deltaX === 0);
  const rawDx = input.deltaX !== 0 ? input.deltaX * scale : (input.shiftKey ? input.deltaY * scale : 0);
  const rawDy = (input.shiftKey && input.deltaX === 0) ? 0 : input.deltaY * scale;
  const absDx = Math.abs(rawDx);
  const absDy = Math.abs(rawDy);

  if (absDx < 0.05 && absDy < 0.05) {
    return noopAction();
  }

  // Reset gesture-level state across finger lifts so a new swipe starts fresh.
  if (state.lastEventAt > 0 && input.now - state.lastEventAt > GESTURE_GAP_MS && state.pullSide === null) {
    state.axis = 'none';
    state.ambiguousDx = 0;
    state.ambiguousDy = 0;
    state.active = false;
    state.startedAtEdge = false;
    state.virtualScrollLeft = null;
    state.lastAbsDx = 0;
    state.peakAbsDx = 0;
    state.lastRiseAt = 0;
    state.edgeBlockedMinDx = Infinity;
    state.edgeBlockedStartAt = 0;
  }

  // Axis locking
  if (isDiscreteWheel) {
    if (absDx < 0.5 || absDx <= absDy) {
      return noopAction();
    }
    state.axis = 'horizontal';
  } else {
    const activelyPulling = state.pullSide !== null && state.pull > state.activeDeadzone;
    if (activelyPulling) {
      if (absDy >= 14 && absDy > absDx * 2.5) {
        const hadOverscroll = state.lastEmittedOverscroll.side !== null;
        state.axis = 'vertical';
        state.ambiguousDx = 0;
        state.ambiguousDy = 0;
        state.active = false;
        state.startedAtEdge = false;
        state.pull = 0;
        state.pullSide = null;
        state.armedAt = 0;
        state.inertiaFinalizing = false;
        state.virtualScrollLeft = null;
        state.edgeBlockedMinDx = Infinity;
        state.edgeBlockedStartAt = 0;
        state.lastEmittedOverscroll = EMPTY_OVERSCROLL;
        state.lastEventAt = input.now;
        return {
          ...noopAction(),
          overscroll: hadOverscroll ? EMPTY_OVERSCROLL : null,
          overscrollActive: false,
          clearReleaseTimer: true,
        };
      }
      state.axis = 'horizontal';
    } else if (state.axis === 'none') {
      if (absDx > absDy * 1.15 && absDx >= 0.5) {
        state.axis = 'horizontal';
      } else if (absDy > absDx * 1.15 && absDy >= 0.5) {
        state.axis = 'vertical';
        state.lastEventAt = input.now;
        return noopAction();
      } else {
        state.ambiguousDx += absDx;
        state.ambiguousDy += absDy;
        state.lastEventAt = input.now;
        if (state.ambiguousDx + state.ambiguousDy >= 8) {
          state.axis = state.ambiguousDx > state.ambiguousDy * 1.15 ? 'horizontal' : 'vertical';
        }
        return noopAction();
      }
    } else if (state.axis === 'vertical') {
      if ((absDy < 0.5 && absDx >= 2) || (absDx >= 5 && absDx > absDy * 2.0)) {
        state.axis = 'horizontal';
        state.ambiguousDx = 0;
        state.ambiguousDy = 0;
        state.active = false;
        state.startedAtEdge = false;
        state.virtualScrollLeft = null;
        state.edgeBlockedMinDx = Infinity;
        state.edgeBlockedStartAt = 0;
      } else {
        state.lastEventAt = input.now;
        return noopAction();
      }
    } else {
      // Locked horizontal: only break back to vertical on a steep vertical turn.
      if (absDy >= 12 && absDy > absDx * 2.4) {
        const hadOverscroll = state.lastEmittedOverscroll.side !== null;
        state.axis = 'vertical';
        state.ambiguousDx = 0;
        state.ambiguousDy = 0;
        state.active = false;
        state.startedAtEdge = false;
        state.pull = 0;
        state.pullSide = null;
        state.armedAt = 0;
        state.inertiaFinalizing = false;
        state.virtualScrollLeft = null;
        state.edgeBlockedMinDx = Infinity;
        state.edgeBlockedStartAt = 0;
        state.lastEmittedOverscroll = EMPTY_OVERSCROLL;
        state.lastEventAt = input.now;
        return {
          ...noopAction(),
          overscroll: hadOverscroll ? EMPTY_OVERSCROLL : null,
          overscrollActive: false,
          clearReleaseTimer: true,
        };
      }
    }
  }

  // Post-wrap inertia suppression (only applies to horizontal-axis events).
  if (state.wrapSuppress) {
    const ws = state.wrapSuppress;
    if (input.now >= ws.until) {
      state.wrapSuppress = null;
    } else if (input.now < ws.hardUntil) {
      ws.lastEventAt = input.now;
      if (absDx > 0) ws.lastAbsDx = Math.min(ws.lastAbsDx, absDx);
      state.lastEventAt = input.now;
      return { ...noopAction(), preventDefault: true };
    } else if (
      (input.now - ws.lastEventAt > GESTURE_GAP_MS) ||
      (rawDx !== 0 && Math.sign(rawDx) !== ws.dir && absDx >= 4) ||
      (rawDx !== 0 && absDx > ws.lastAbsDx * 1.6 + 5)
    ) {
      state.wrapSuppress = null;
      state.active = false;
      state.virtualScrollLeft = null;
    } else {
      ws.lastEventAt = input.now;
      if (absDx > 0) ws.lastAbsDx = Math.min(ws.lastAbsDx, absDx);
      state.lastEventAt = input.now;
      return { ...noopAction(), preventDefault: true };
    }
  }

  // Swallow tiny vertical-only micro-wobble frames while horizontally locked.
  if (absDx < 0.05) {
    state.lastEventAt = input.now;
    return { ...noopAction(), preventDefault: !isDiscreteWheel };
  }

  const isGestureStart = !state.active;
  if (!state.active) {
    state.active = true;
    state.startedAtEdge =
      (rawDx > 0 && input.scrollLeft >= input.maxScroll - EDGE_EPSILON) ||
      (rawDx < 0 && input.scrollLeft <= EDGE_EPSILON);
    state.pull = 0;
    state.pullSide = null;
    state.armedAt = 0;
    state.inertiaFinalizing = false;
    state.peakAbsDx = 0;
    state.peakAbsDxAtArm = 0;
    state.lastAbsDx = 0;
    state.lastRiseAt = input.now;
    state.edgeBlockedMinDx = Infinity;
    state.edgeBlockedStartAt = 0;
    state.virtualScrollLeft = input.scrollLeft;
  }

  if (state.virtualScrollLeft === null || Math.abs(state.virtualScrollLeft - input.scrollLeft) > 1.5) {
    state.virtualScrollLeft = input.scrollLeft;
  }
  state.lastEventAt = input.now;

  const deadzone = isDiscreteWheel
    ? (state.startedAtEdge ? 8 : 30)
    : TOUCHPAD_EDGE_DEADZONE;
  const pullThreshold = isDiscreteWheel ? PULL_THRESHOLD : TOUCHPAD_PULL_THRESHOLD;
  const maxPull = deadzone + pullThreshold;
  state.activeDeadzone = deadzone;
  state.activeThreshold = pullThreshold;

  let clearedOverscroll = false;

  if (state.pullSide !== null && state.pull > 0) {
    const activeSide = state.pullSide;
    const isOpposite =
      (activeSide === 'right' && rawDx < 0) ||
      (activeSide === 'left' && rawDx > 0);

    if (isOpposite) {
      if (absDx < 0.5) {
        return {
          ...noopAction(),
          preventDefault: true,
          engageScroll: true,
          markScrolling: true,
          isGestureStart,
        };
      }
      if (state.pull <= deadzone) {
        state.pull = 0;
        state.pullSide = null;
        state.armedAt = 0;
        state.inertiaFinalizing = false;
        state.startedAtEdge = false;
        clearedOverscroll = state.lastEmittedOverscroll.side !== null;
        state.lastEmittedOverscroll = EMPTY_OVERSCROLL;
      } else {
        const pullBackGain = isDiscreteWheel ? 1.15 : 1.4;
        const prevAbove = state.pull - deadzone;
        const nextPull = Math.max(0, state.pull - absDx * pullBackGain);
        if (nextPull > deadzone) {
          state.pull = nextPull;
          const ov = computeOverscrollState(activeSide, nextPull, deadzone, pullThreshold);
          if (ov.progress < 1) {
            state.armedAt = 0;
            state.inertiaFinalizing = false;
          }
          state.lastEmittedOverscroll = ov;
          state.lastAbsDx = absDx;
          return {
            preventDefault: true,
            engageScroll: true,
            markScrolling: true,
            nextScrollLeft: null,
            overscroll: ov,
            overscrollActive: true,
            scheduleReleaseMs: isDiscreteWheel ? WHEEL_RELEASE_MS : TOUCHPAD_UNARMED_RELEASE_MS,
            clearReleaseTimer: false,
            finishNow: false,
            isGestureStart,
          };
        }

        state.pull = 0;
        state.pullSide = null;
        state.armedAt = 0;
        state.inertiaFinalizing = false;
        state.startedAtEdge = false;
        state.lastEmittedOverscroll = EMPTY_OVERSCROLL;
        state.lastAbsDx = absDx;

        const leftover = Math.max(0, absDx - prevAbove / pullBackGain);
        let nextScrollLeft: number | null = null;
        const hasLeftoverScroll = !isDiscreteWheel && leftover > 0;
        if (hasLeftoverScroll) {
          const baseScroll = state.virtualScrollLeft ?? input.scrollLeft;
          const nextVirtual = Math.max(0, Math.min(input.maxScroll, baseScroll + Math.sign(rawDx) * leftover));
          state.virtualScrollLeft = nextVirtual;
          nextScrollLeft = nextVirtual;
        }
        return {
          preventDefault: true,
          engageScroll: true,
          markScrolling: true,
          nextScrollLeft,
          overscroll: EMPTY_OVERSCROLL,
          overscrollActive: false,
          scheduleReleaseMs: hasLeftoverScroll ? GESTURE_GAP_MS : null,
          clearReleaseTimer: !hasLeftoverScroll,
          finishNow: false,
          isGestureStart,
        };
      }
    } else {
      if (absDx > state.lastAbsDx + 0.5) {
        state.lastRiseAt = input.now;
      }
      if (absDx > state.peakAbsDx) {
        state.peakAbsDx = absDx;
      }
      state.lastAbsDx = absDx;

      const pullGain = isDiscreteWheel ? 1.15 : 0.72;
      const maxStep = isDiscreteWheel ? 48 : 28;
      state.pull = Math.min(maxPull, state.pull + Math.min(maxStep, absDx * pullGain));

      const ov = computeOverscrollState(activeSide, state.pull, deadzone, pullThreshold);
      if (ov.progress >= 1 && state.armedAt === 0) {
        state.armedAt = input.now;
        state.peakAbsDxAtArm = Math.max(state.peakAbsDx, absDx);
      }
      state.lastEmittedOverscroll = ov;

      let scheduleReleaseMs: number | null = null;
      let clearReleaseTimer = false;
      let finishNow = false;

      if (isDiscreteWheel) {
        scheduleReleaseMs = (ov.progress < 1 || absDx >= 4) ? WHEEL_RELEASE_MS : null;
      } else if (ov.progress < 1) {
        state.inertiaFinalizing = false;
        scheduleReleaseMs = TOUCHPAD_UNARMED_RELEASE_MS;
      } else {
        const armedElapsed = input.now - state.armedAt;
        const isDecayingTail =
          (absDx < Math.max(3, state.peakAbsDxAtArm * 0.45) && input.now - state.lastRiseAt >= 70) ||
          absDx < 2.5;
        if (!isDecayingTail) {
          state.inertiaFinalizing = false;
          scheduleReleaseMs = TOUCHPAD_ARMED_RELEASE_MS;
        } else if (armedElapsed >= TOUCHPAD_ARM_MIN_VISIBLE_MS && absDx < 1.8) {
          finishNow = true;
          clearReleaseTimer = true;
        } else if (!state.inertiaFinalizing) {
          state.inertiaFinalizing = true;
          scheduleReleaseMs = Math.max(TOUCHPAD_INERTIA_FINALIZE_MS, TOUCHPAD_ARM_MIN_VISIBLE_MS - armedElapsed);
        } else {
          scheduleReleaseMs = null;
        }
      }

      return {
        preventDefault: true,
        engageScroll: true,
        markScrolling: true,
        nextScrollLeft: null,
        overscroll: ov,
        overscrollActive: true,
        scheduleReleaseMs,
        clearReleaseTimer,
        finishNow,
        isGestureStart,
      };
    }
  }

  // Normal scrolling & entering edge pull
  const atRightEdge = input.scrollLeft >= input.maxScroll - EDGE_EPSILON && rawDx > 0;
  const atLeftEdge = input.scrollLeft <= EDGE_EPSILON && rawDx < 0;

  if (atRightEdge || atLeftEdge) {
    let allowPull = isDiscreteWheel || state.startedAtEdge;
    if (!allowPull) {
      if (state.edgeBlockedStartAt === 0) {
        state.edgeBlockedStartAt = input.now;
        state.edgeBlockedMinDx = absDx;
      }
      const isFreshPullSpike =
        absDx >= state.edgeBlockedMinDx * 2.0 + 6 &&
        absDx >= 8 &&
        input.now - state.edgeBlockedStartAt >= 50;
      if (isFreshPullSpike) {
        state.startedAtEdge = true;
        state.edgeBlockedMinDx = Infinity;
        state.edgeBlockedStartAt = 0;
        allowPull = true;
      } else {
        state.edgeBlockedMinDx = Math.min(state.edgeBlockedMinDx, absDx);
        state.lastAbsDx = absDx;
        const clampedEdge = atRightEdge ? input.maxScroll : 0;
        state.virtualScrollLeft = clampedEdge;
        return {
          preventDefault: true,
          engageScroll: true,
          markScrolling: true,
          nextScrollLeft: clampedEdge,
          overscroll: clearedOverscroll ? EMPTY_OVERSCROLL : null,
          overscrollActive: false,
          scheduleReleaseMs: GESTURE_GAP_MS,
          clearReleaseTimer: false,
          finishNow: false,
          isGestureStart,
        };
      }
    }

    const side: OverscrollSide = atRightEdge ? 'right' : 'left';
    state.pullSide = side;
    state.armedAt = 0;
    state.inertiaFinalizing = false;
    state.peakAbsDx = absDx;
    state.peakAbsDxAtArm = 0;
    state.lastAbsDx = absDx;
    state.lastRiseAt = input.now;

    const pullGain = isDiscreteWheel ? 1.15 : 0.72;
    const maxStep = isDiscreteWheel ? 48 : 28;
    state.pull = Math.min(maxPull, Math.min(maxStep, absDx * pullGain));

    const ov = computeOverscrollState(side, state.pull, deadzone, pullThreshold);
    state.lastEmittedOverscroll = ov;
    return {
      preventDefault: true,
      engageScroll: true,
      markScrolling: true,
      nextScrollLeft: null,
      overscroll: ov,
      overscrollActive: true,
      scheduleReleaseMs: isDiscreteWheel ? WHEEL_RELEASE_MS : TOUCHPAD_UNARMED_RELEASE_MS,
      clearReleaseTimer: false,
      finishNow: false,
      isGestureStart,
    };
  }

  state.edgeBlockedMinDx = Infinity;
  state.edgeBlockedStartAt = 0;
  state.startedAtEdge = false;
  state.lastAbsDx = absDx;

  if (isDiscreteWheel) {
    return {
      preventDefault: false,
      engageScroll: true,
      markScrolling: true,
      nextScrollLeft: null,
      overscroll: clearedOverscroll ? EMPTY_OVERSCROLL : null,
      overscrollActive: false,
      scheduleReleaseMs: WHEEL_RELEASE_MS,
      clearReleaseTimer: false,
      finishNow: false,
      isGestureStart,
    };
  }

  const baseScroll = state.virtualScrollLeft ?? input.scrollLeft;
  const nextVirtual = Math.max(0, Math.min(input.maxScroll, baseScroll + rawDx));
  state.virtualScrollLeft = nextVirtual;
  return {
    preventDefault: true,
    engageScroll: true,
    markScrolling: true,
    nextScrollLeft: nextVirtual,
    overscroll: clearedOverscroll ? EMPTY_OVERSCROLL : null,
    overscrollActive: false,
    scheduleReleaseMs: GESTURE_GAP_MS,
    clearReleaseTimer: false,
    finishNow: false,
    isGestureStart,
  };
}

export function finishHorizontalWheelGesture(state: HorizontalWheelState, now: number): FinishWheelAction {
  const shouldWrap =
    state.lastEmittedOverscroll.progress >= 1 &&
    state.lastEmittedOverscroll.side !== null;
  const wrapSide = shouldWrap ? state.lastEmittedOverscroll.side : null;

  if (wrapSide !== null) {
    state.wrapSuppress = {
      until: now + WRAP_SUPPRESS_MAX_MS,
      hardUntil: now + WRAP_SUPPRESS_HARD_MS,
      side: wrapSide,
      dir: wrapSide === 'right' ? 1 : -1,
      lastEventAt: now,
      lastAbsDx: Math.max(state.lastAbsDx, 8),
    };
  }

  const preserveSuppress = state.wrapSuppress;
  resetHorizontalWheelState(state);
  state.wrapSuppress = preserveSuppress;

  return {
    overscroll: EMPTY_OVERSCROLL,
    wrapSide,
  };
}
