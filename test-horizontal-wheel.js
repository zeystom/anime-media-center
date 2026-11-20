import assert from 'assert';
import {
  EMPTY_OVERSCROLL,
  GESTURE_GAP_MS,
  PULL_THRESHOLD,
  TOUCHPAD_ARMED_RELEASE_MS,
  TOUCHPAD_INERTIA_FINALIZE_MS,
  TOUCHPAD_PULL_THRESHOLD,
  TOUCHPAD_UNARMED_RELEASE_MS,
  WRAP_SUPPRESS_HARD_MS,
  WRAP_SUPPRESS_MAX_MS,
  createHorizontalWheelState,
  finishHorizontalWheelGesture,
  processHorizontalWheel,
} from './src/utils/horizontalWheel.ts';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ Passed: ${name}`);
  } catch (err) {
    failed++;
    console.log(`✗ Failed: ${name}\n    ${err.stack || err.message}`);
  }
}

function makeInput(overrides = {}) {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
    scrollLeft: 0,
    maxScroll: 2000,
    clientWidth: 1200,
    now: 1000,
    ...overrides,
  };
}

console.log('Running horizontal wheel / touchpad tests...\n');

// 1. Smooth 1:1 middle-of-rail scrolling left & right
check('1. Smooth 1:1 middle-of-rail scrolling left & right with preventDefault', () => {
  const state = createHorizontalWheelState();
  let scrollLeft = 400;
  const maxScroll = 2000;

  const rightDeltas = [12, 18, 25, 20, 15];
  let now = 1000;
  for (const dx of rightDeltas) {
    const action = processHorizontalWheel(state, makeInput({ deltaX: dx, deltaY: 0, scrollLeft, maxScroll, now }));
    assert.strictEqual(action.preventDefault, true);
    assert.strictEqual(action.engageScroll, true);
    assert.strictEqual(action.markScrolling, true);
    assert.strictEqual(action.overscroll, null);
    assert.strictEqual(action.nextScrollLeft, scrollLeft + dx);
    scrollLeft = action.nextScrollLeft;
    now += 8;
  }
  assert.strictEqual(scrollLeft, 490);

  // New gesture left after gap
  now += GESTURE_GAP_MS + 30;
  const leftDeltas = [-10, -22, -18];
  for (const dx of leftDeltas) {
    const action = processHorizontalWheel(state, makeInput({ deltaX: dx, deltaY: 0, scrollLeft, maxScroll, now }));
    assert.strictEqual(action.preventDefault, true);
    assert.strictEqual(action.nextScrollLeft, scrollLeft + dx);
    scrollLeft = action.nextScrollLeft;
    now += 8;
  }
  assert.strictEqual(scrollLeft, 440);
});

// 2. Subpixel fractional DPI accumulation
check('2. Subpixel fractional DPI steps accumulate cleanly past 1.0px', () => {
  const state = createHorizontalWheelState();
  let domScrollLeft = 500; // Chromium truncates integer/quantized scrollLeft at fractional DPI
  let now = 1000;

  // Initial horizontal lock frame
  const init = processHorizontalWheel(
    state,
    makeInput({ deltaX: 2, deltaY: 0, scrollLeft: domScrollLeft, maxScroll: 2000, now })
  );
  assert.strictEqual(init.preventDefault, true);
  domScrollLeft = Math.floor(init.nextScrollLeft);
  assert.strictEqual(domScrollLeft, 502);
  now += 8;

  // Three 0.4px steps while locked horizontal: without virtualScrollLeft, floor(502 + 0.4) stays 502 forever
  for (let i = 0; i < 3; i++) {
    const action = processHorizontalWheel(
      state,
      makeInput({ deltaX: 0.4, deltaY: 0, scrollLeft: domScrollLeft, maxScroll: 2000, now })
    );
    assert.strictEqual(action.preventDefault, true);
    assert.ok(action.nextScrollLeft !== null);
    domScrollLeft = Math.floor(action.nextScrollLeft);
    now += 8;
  }
  // 502 + 3 * 0.4 = 503.2 -> DOM scrollLeft advances from 502 to 503
  assert.strictEqual(domScrollLeft, 503);
});

// 3. Diagonal swipe with vertical drift & mid-swipe wobble stays locked horizontal
check('3. Diagonal swipe with vertical drift and mid-swipe wobble stays locked horizontal', () => {
  const state = createHorizontalWheelState();
  let scrollLeft = 300;
  let now = 1000;

  // Initial horizontal intent (|dx| > |dy| * 1.15)
  const first = processHorizontalWheel(
    state,
    makeInput({ deltaX: 10, deltaY: 4, scrollLeft, maxScroll: 2000, now })
  );
  assert.strictEqual(state.axis, 'horizontal');
  assert.strictEqual(first.preventDefault, true);
  scrollLeft = first.nextScrollLeft;
  now += 8;

  // Mid-swipe frame where dy slightly exceeds dx (diagonal drift), plus pure vertical wobble
  const drift = processHorizontalWheel(
    state,
    makeInput({ deltaX: 6, deltaY: 8, scrollLeft, maxScroll: 2000, now })
  );
  assert.strictEqual(state.axis, 'horizontal');
  assert.strictEqual(drift.preventDefault, true);
  assert.strictEqual(drift.nextScrollLeft, scrollLeft + 6);
  scrollLeft = drift.nextScrollLeft;
  now += 8;

  // Pure micro vertical wobble (absDx === 0) while horizontally locked must be swallowed
  const wobble = processHorizontalWheel(
    state,
    makeInput({ deltaX: 0, deltaY: 3, scrollLeft, maxScroll: 2000, now })
  );
  assert.strictEqual(state.axis, 'horizontal');
  assert.strictEqual(wobble.preventDefault, true);
  assert.strictEqual(wobble.nextScrollLeft, null);
});

// 4. Vertical scroll over rail locks vertical with preventDefault: false
check('4. Vertical scroll over rail locks vertical with preventDefault false', () => {
  const state = createHorizontalWheelState();
  let now = 1000;

  for (let i = 0; i < 5; i++) {
    const action = processHorizontalWheel(
      state,
      makeInput({ deltaX: 2, deltaY: 16, scrollLeft: 400, maxScroll: 2000, now })
    );
    assert.strictEqual(state.axis, 'vertical');
    assert.strictEqual(action.preventDefault, false);
    assert.strictEqual(action.nextScrollLeft, null);
    assert.strictEqual(action.overscroll, null);
    now += 8;
  }
});

// 5. Immediate vertical -> horizontal switch within 40ms breaks out cleanly
check('5. Immediate vertical to horizontal switch within 40ms breaks out of vertical lock', () => {
  const state = createHorizontalWheelState();
  let now = 1000;

  // Lock vertical
  const v1 = processHorizontalWheel(
    state,
    makeInput({ deltaX: 1, deltaY: 14, scrollLeft: 400, maxScroll: 2000, now })
  );
  assert.strictEqual(state.axis, 'vertical');
  assert.strictEqual(v1.preventDefault, false);

  // Within 32ms (< GESTURE_GAP_MS), user switches decisively to horizontal swipe
  now += 32;
  const h1 = processHorizontalWheel(
    state,
    makeInput({ deltaX: 12, deltaY: 1, scrollLeft: 400, maxScroll: 2000, now })
  );
  assert.strictEqual(state.axis, 'horizontal');
  assert.strictEqual(h1.preventDefault, true);
  assert.strictEqual(h1.nextScrollLeft, 412);
});

// 6. Fast flick momentum from middle hitting right/left edge stops cleanly with zero wrap
check('6. Fast flick from middle hitting right or left edge stops cleanly with zero overscroll or wrap', () => {
  // Right edge flick
  {
    const state = createHorizontalWheelState();
    let scrollLeft = 1750;
    const maxScroll = 2000;
    let now = 1000;
    const flick = [70, 80, 90, 60, 40, 25, 14, 7, 3, 1.5];
    for (const dx of flick) {
      const action = processHorizontalWheel(
        state,
        makeInput({ deltaX: dx, deltaY: 0, scrollLeft, maxScroll, now })
      );
      assert.strictEqual(action.preventDefault, true);
      if (action.nextScrollLeft !== null) scrollLeft = action.nextScrollLeft;
      assert.strictEqual(action.overscroll, null);
      assert.strictEqual(action.overscrollActive, false);
      now += 8;
    }
    assert.strictEqual(scrollLeft, maxScroll);
    const fin = finishHorizontalWheelGesture(state, now + 130);
    assert.strictEqual(fin.wrapSide, null);
  }

  // Left edge flick
  {
    const state = createHorizontalWheelState();
    let scrollLeft = 220;
    const maxScroll = 2000;
    let now = 1000;
    const flick = [-70, -80, -90, -50, -30, -15, -6, -2];
    for (const dx of flick) {
      const action = processHorizontalWheel(
        state,
        makeInput({ deltaX: dx, deltaY: 0, scrollLeft, maxScroll, now })
      );
      assert.strictEqual(action.preventDefault, true);
      if (action.nextScrollLeft !== null) scrollLeft = action.nextScrollLeft;
      assert.strictEqual(action.overscroll, null);
      now += 8;
    }
    assert.strictEqual(scrollLeft, 0);
    const fin = finishHorizontalWheelGesture(state, now + 130);
    assert.strictEqual(fin.wrapSide, null);
  }
});

// 7. Fresh deliberate pull at edge after hitting edge
check('7. Fresh deliberate pull after hitting edge engages overscroll after gap or via velocity spike', () => {
  // 7a. After > GESTURE_GAP_MS pause
  {
    const state = createHorizontalWheelState();
    let scrollLeft = 1920;
    const maxScroll = 2000;
    let now = 1000;
    for (const dx of [50, 50, 30, 20]) {
      const a = processHorizontalWheel(state, makeInput({ deltaX: dx, scrollLeft, maxScroll, now }));
      if (a.nextScrollLeft !== null) scrollLeft = a.nextScrollLeft;
      now += 8;
    }
    assert.strictEqual(scrollLeft, maxScroll);
    assert.strictEqual(state.pullSide, null);

    // Pause > 120ms (finger lift) and pull again from edge
    now += GESTURE_GAP_MS + 40;
    let lastOv = null;
    for (let i = 0; i < 6; i++) {
      const a = processHorizontalWheel(state, makeInput({ deltaX: 25, scrollLeft, maxScroll, now }));
      lastOv = a.overscroll;
      now += 8;
    }
    assert.ok(lastOv && lastOv.side === 'right' && lastOv.progress > 0);
  }

  // 7b. Via fresh velocity spike while old momentum is decaying at edge
  {
    const state = createHorizontalWheelState();
    let scrollLeft = 1940;
    const maxScroll = 2000;
    let now = 1000;
    // Hit edge and decay for >= 50ms
    const decaying = [70, 25, 18, 12, 8, 5, 3, 2, 1.5];
    for (const dx of decaying) {
      const a = processHorizontalWheel(state, makeInput({ deltaX: dx, scrollLeft, maxScroll, now }));
      if (a.nextScrollLeft !== null) scrollLeft = a.nextScrollLeft;
      assert.strictEqual(a.overscroll, null);
      now += 10;
    }
    // Now user does a strong fresh swipe without waiting 120ms
    const spike = processHorizontalWheel(state, makeInput({ deltaX: 28, scrollLeft, maxScroll, now }));
    assert.strictEqual(state.startedAtEdge, true);
    assert.strictEqual(state.pullSide, 'right');
    assert.ok(spike.overscroll !== null && spike.overscroll.side === 'right');
  }
});

// 8. Intentional pull from edge fills smoothly -> arms -> releases crisply (lift, 60Hz decay, 120Hz quantized plateau) -> wraps
check('8. Intentional pull from edge arms and wraps on lift, 60Hz decay, and 120Hz quantized plateau', () => {
  // 8a. Clean finger lift at 140ms
  {
    const state = createHorizontalWheelState();
    let now = 1000;
    let armedAction = null;
    for (let i = 0; i < 12; i++) {
      const a = processHorizontalWheel(state, makeInput({ deltaX: 28, scrollLeft: 2000, maxScroll: 2000, now }));
      if (a.overscroll && a.overscroll.progress >= 1) armedAction = a;
      now += 8;
    }
    assert.ok(armedAction && armedAction.overscroll.progress === 1);
    assert.strictEqual(armedAction.scheduleReleaseMs, TOUCHPAD_ARMED_RELEASE_MS);
    const fin = finishHorizontalWheelGesture(state, now + TOUCHPAD_ARMED_RELEASE_MS);
    assert.strictEqual(fin.wrapSide, 'right');
  }

  // 8b. 60Hz smooth inertia decay tail triggers crisp wrap (finishNow or short finalize)
  {
    const state = createHorizontalWheelState();
    let now = 1000;
    for (let i = 0; i < 10; i++) {
      processHorizontalWheel(state, makeInput({ deltaX: 30, scrollLeft: 2000, maxScroll: 2000, now }));
      now += 16;
    }
    assert.strictEqual(state.lastEmittedOverscroll.progress, 1);

    let finalized = false;
    const decay = [14, 10, 7, 4.5, 3, 2, 1.5, 1.0, 0.7];
    for (const dx of decay) {
      now += 16;
      const a = processHorizontalWheel(state, makeInput({ deltaX: dx, scrollLeft: 2000, maxScroll: 2000, now }));
      if (a.finishNow) {
        const fin = finishHorizontalWheelGesture(state, now);
        assert.strictEqual(fin.wrapSide, 'right');
        finalized = true;
        break;
      }
      if (state.inertiaFinalizing && a.scheduleReleaseMs !== null) {
        assert.ok(a.scheduleReleaseMs >= TOUCHPAD_INERTIA_FINALIZE_MS);
        assert.ok(a.scheduleReleaseMs <= 120);
      }
    }
    assert.ok(finalized || state.inertiaFinalizing, '60Hz decay tail must enter fast finalize or finishNow');
  }

  // 8c. 120Hz quantized plateau decay (deltaX dropping to constant 2px frames)
  {
    const state = createHorizontalWheelState();
    let now = 1000;
    for (let i = 0; i < 10; i++) {
      processHorizontalWheel(state, makeInput({ deltaX: -30, scrollLeft: 0, maxScroll: 2000, now }));
      now += 8;
    }
    assert.strictEqual(state.lastEmittedOverscroll.progress, 1);

    // Wait >= 70ms since lastRiseAt and send quantized 2px frames
    now += 80;
    let scheduledShortFinalize = false;
    let blockedPushback = false;
    for (let i = 0; i < 5; i++) {
      const a = processHorizontalWheel(state, makeInput({ deltaX: -2, scrollLeft: 0, maxScroll: 2000, now }));
      if (a.scheduleReleaseMs !== null && state.inertiaFinalizing) {
        scheduledShortFinalize = true;
      } else if (state.inertiaFinalizing && a.scheduleReleaseMs === null) {
        blockedPushback = true;
      }
      now += 8;
    }
    assert.strictEqual(scheduledShortFinalize, true);
    assert.strictEqual(blockedPushback, true);
    const fin = finishHorizontalWheelGesture(state, now + TOUCHPAD_INERTIA_FINALIZE_MS);
    assert.strictEqual(fin.wrapSide, 'left');
  }
});

// 9. Hard cap on pull + instant reverse cancel
check('9. Hard pull cap lets first reverse event drop below 1.0 and unwinds into normal scroll', () => {
  const state = createHorizontalWheelState();
  let scrollLeft = 2000;
  const maxScroll = 2000;
  let now = 1000;

  // Push 1000+ pixels past 100%
  for (let i = 0; i < 50; i++) {
    processHorizontalWheel(state, makeInput({ deltaX: 30, scrollLeft, maxScroll, now }));
    now += 8;
  }
  assert.strictEqual(state.lastEmittedOverscroll.progress, 1);
  assert.ok(state.pull <= 18 + TOUCHPAD_PULL_THRESHOLD + 0.001);

  // First reverse event immediately drops progress < 1 and clears armedAt
  const rev1 = processHorizontalWheel(state, makeInput({ deltaX: -12, scrollLeft, maxScroll, now }));
  assert.ok(rev1.overscroll !== null && rev1.overscroll.progress < 1);
  assert.strictEqual(state.armedAt, 0);
  assert.strictEqual(rev1.scheduleReleaseMs, TOUCHPAD_UNARMED_RELEASE_MS);
  now += 8;

  // Unwind completely and verify smooth transition back into normal scrolling
  let scrolledBack = false;
  for (let i = 0; i < 12; i++) {
    const rev = processHorizontalWheel(state, makeInput({ deltaX: -20, scrollLeft, maxScroll, now }));
    if (rev.nextScrollLeft !== null && rev.nextScrollLeft < maxScroll) {
      scrollLeft = rev.nextScrollLeft;
      scrolledBack = true;
      assert.strictEqual(rev.overscrollActive, false);
    }
    now += 8;
  }
  assert.strictEqual(scrolledBack, true);
  assert.ok(scrollLeft < maxScroll);

  const fin = finishHorizontalWheelGesture(state, now + GESTURE_GAP_MS + 10);
  assert.strictEqual(fin.wrapSide, null);
});

// 10. Post-wrap inertia suppression
check('10. Post-wrap inertia suppression blocks same-dir tail, allows vertical, yields to opposite/gap', () => {
  const state = createHorizontalWheelState();
  let now = 1000;
  for (let i = 0; i < 10; i++) {
    processHorizontalWheel(state, makeInput({ deltaX: 30, scrollLeft: 2000, maxScroll: 2000, now }));
    now += 8;
  }
  const fin = finishHorizontalWheelGesture(state, now);
  assert.strictEqual(fin.wrapSide, 'right');
  assert.ok(state.wrapSuppress !== null);

  // Simulate rail smooth-scrolling to target 0 during suppression window
  let simulatedScroll = 1400;

  // 10a. Same-direction decaying tail during hardUntil is swallowed continuously
  for (const offset of [50, 120, 200, 250]) {
    const tail1 = processHorizontalWheel(
      state,
      makeInput({ deltaX: 12, deltaY: 0, scrollLeft: simulatedScroll, maxScroll: 2000, now: now + offset })
    );
    assert.strictEqual(tail1.preventDefault, true);
    assert.strictEqual(tail1.nextScrollLeft, null);
  }

  // 10b. Vertical scroll during suppression passes straight through (preventDefault: false)
  const vert = processHorizontalWheel(
    state,
    makeInput({ deltaX: 0, deltaY: 24, scrollLeft: simulatedScroll, maxScroll: 2000, now: now + 258 })
  );
  assert.strictEqual(vert.preventDefault, false);
  assert.strictEqual(vert.nextScrollLeft, null);

  // 10c. After hardUntil (still within GESTURE_GAP_MS of last tail event), same-direction small tail is still swallowed,
  //      and a fresh opposite swipe (>=4px) immediately breaks out
  const tail2 = processHorizontalWheel(
    state,
    makeInput({ deltaX: 5, deltaY: 0, scrollLeft: 0, maxScroll: 2000, now: now + WRAP_SUPPRESS_HARD_MS + 20 })
  );
  assert.strictEqual(tail2.preventDefault, true);
  assert.strictEqual(tail2.nextScrollLeft, null);

  const opp = processHorizontalWheel(
    state,
    makeInput({ deltaX: -12, deltaY: 0, scrollLeft: 400, maxScroll: 2000, now: now + WRAP_SUPPRESS_HARD_MS + 40 })
  );
  assert.strictEqual(state.wrapSuppress, null);
  assert.strictEqual(opp.preventDefault, true);
  assert.strictEqual(opp.nextScrollLeft, 388);

  // 10d. Also yields after gap > GESTURE_GAP_MS past hardUntil, or after WRAP_SUPPRESS_MAX_MS
  const state2 = createHorizontalWheelState();
  let t2 = 2000;
  for (let i = 0; i < 10; i++) {
    processHorizontalWheel(state2, makeInput({ deltaX: 30, scrollLeft: 2000, maxScroll: 2000, now: t2 }));
    t2 += 8;
  }
  finishHorizontalWheelGesture(state2, t2);
  const afterGap = processHorizontalWheel(
    state2,
    makeInput({ deltaX: 15, scrollLeft: 0, maxScroll: 2000, now: t2 + WRAP_SUPPRESS_HARD_MS + GESTURE_GAP_MS + 20 })
  );
  assert.strictEqual(state2.wrapSuppress, null);
  assert.strictEqual(afterGap.nextScrollLeft, 15);
  assert.ok(WRAP_SUPPRESS_MAX_MS > WRAP_SUPPRESS_HARD_MS);
});

// 11. Discrete mouse wheel (Shift+Wheel, deltaMode === 1)
check('11. Discrete mouse wheel leaves middle preventDefault false and caps/cancels edge pull', () => {
  const state = createHorizontalWheelState();
  let now = 1000;

  // Middle of rail with Shift+Wheel (deltaY = 100, deltaX = 0)
  const mid = processHorizontalWheel(
    state,
    makeInput({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true, scrollLeft: 400, maxScroll: 2000, now })
  );
  assert.strictEqual(mid.preventDefault, false);
  assert.strictEqual(mid.nextScrollLeft, null);
  assert.strictEqual(mid.engageScroll, true);

  // Edge pull with deltaMode === 1 (line mode)
  const stateEdge = createHorizontalWheelState();
  for (let i = 0; i < 15; i++) {
    const a = processHorizontalWheel(
      stateEdge,
      makeInput({ deltaX: 4, deltaY: 0, deltaMode: 1, shiftKey: false, scrollLeft: 2000, maxScroll: 2000, now })
    );
    assert.strictEqual(a.preventDefault, true);
    now += 30;
  }
  assert.strictEqual(stateEdge.lastEmittedOverscroll.progress, 1);
  assert.ok(stateEdge.pull <= 8 + PULL_THRESHOLD + 0.001);

  // Reverse notch drops below 1 immediately
  const rev = processHorizontalWheel(
    stateEdge,
    makeInput({ deltaX: -3, deltaY: 0, deltaMode: 1, shiftKey: false, scrollLeft: 2000, maxScroll: 2000, now })
  );
  assert.ok(rev.overscroll && rev.overscroll.progress < 1);
});

// 12. ctrlKey pinch-to-zoom and non-scrollable rail return pure no-ops
check('12. ctrlKey pinch-to-zoom and maxScroll <= 2 return pure no-ops', () => {
  const state = createHorizontalWheelState();
  const pinch = processHorizontalWheel(
    state,
    makeInput({ deltaX: 25, deltaY: -10, ctrlKey: true, scrollLeft: 500, maxScroll: 2000 })
  );
  assert.deepStrictEqual(pinch, {
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
  });

  const flat = processHorizontalWheel(
    state,
    makeInput({ deltaX: 25, deltaY: 0, ctrlKey: false, scrollLeft: 0, maxScroll: 2 })
  );
  assert.deepStrictEqual(flat, {
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
  });
  assert.deepStrictEqual(state.lastEmittedOverscroll, EMPTY_OVERSCROLL);
});

console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  process.exitCode = 1;
  console.log('HORIZONTAL WHEEL TESTS FAILED');
} else {
  console.log('All horizontal wheel tests passed successfully!');
}
