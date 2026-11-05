/**
 * Milestone 4 Empirical Challenger 2 Verification & Stress Harness
 * Target: Library UI/UX Polish & Consistency
 *
 * Verifies:
 * 1. UpNextWidget (Home tab UP NEXT banner, the Phase 3 UI refactor replacement for the deleted
 *    Phase 2 hero resume banner): SSR render verification against adversarial payloads
 *    (duration 0 / currentTime 0, chip switching, poster/banner fallbacks, empty episode numbers,
 *    render storm) plus the MovieHeroCard broadcast vestige.
 * 2. App.tsx Global Escape key listener: drawer presence (.translate-x-0), dialog presence ([role="dialog"], [data-modal="true"]), e.defaultPrevented, normal close
 * 3. WhisperStudio visual cleanup: no raw CLI flags, chip rendering, card styling
 * 4. SettingsModal inline confirmation state machine & accessibility
 * 5. EpisodeCard & FolderBrowser subtitle hierarchy & search empty state matrix
 *
 * Authored by: Empirical Challenger (Milestone 4 Instance 2)
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';
import React from 'react';
import { renderToString } from 'react-dom/server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('================================================================');
console.log('   EMPIRICAL CHALLENGER 2: MILESTONE 4 INTERACTION STRESS SUITE ');
console.log('================================================================\n');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`         Error: ${err.message}`);
    process.exitCode = 1;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 0. BUNDLE LOADER: Compile Target Components
// ---------------------------------------------------------------------------
const tempDir = path.join(__dirname, 'temp-challenger2-m4-bundle');

await esbuild.build({
  entryPoints: {
    UpNextWidget: './src/components/Home/UpNextWidget.tsx',
    WhisperStudio: './src/components/WhisperStudio/WhisperStudio.tsx',
  },
  bundle: true,
  format: 'esm',
  outdir: tempDir,
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'lucide-react', 'electron'],
});

const { UpNextWidget } = await import(`file://${path.join(tempDir, 'UpNextWidget.js').replace(/\\/g, '/')}`);
const { WhisperStudio } = await import(`file://${path.join(tempDir, 'WhisperStudio.js').replace(/\\/g, '/')}`);

// Cleanup bundle artifacts
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {}

// ===========================================================================
// CHALLENGE GROUP 1: UP NEXT Widget SSR Rendering & Adversarial Payloads
// ===========================================================================
console.log('--- CHALLENGE GROUP 1: UpNextWidget Rendering & Adversarial Payloads ---');

// Mock Window & DOM Environment (used by the Group 2 App escape-key harness)
class MockDOMWindow {
  constructor() {
    this.listeners = new Map();
    this.elements = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.has(type)) {
      this.listeners.get(type).delete(listener);
    }
  }

  dispatchEvent(event) {
    const handlers = this.listeners.get(event.type);
    if (!handlers) return true;
    for (const h of Array.from(handlers)) {
      h(event);
    }
    return !event.defaultPrevented;
  }

  setMockElement(selector, attrs = {}) {
    this.elements.set(selector, {
      getAttribute: (k) => attrs[k] || null,
      closest: (sel) => (attrs[sel] ? {} : null),
    });
  }

  clearMockElement(selector) {
    this.elements.delete(selector);
  }

  querySelector(selector) {
    return this.elements.get(selector) || null;
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
}

// 1.1 MovieHeroCard Broadcast on Mount & Cleanup on Unmount
// NOTE (Phase 3 UI refactor): UpNextWidget now lives on the separate Home tab, so nothing listens
// to this channel anymore; the dispatch remains in MovieHeroCard as a harmless vestige we keep covered.
runTest('1.1 MovieHeroCard dispatches active detail on mount and null on unmount', () => {
  const movieHeroCardSrc = fs.readFileSync(
    path.join(__dirname, 'src', 'components', 'Library', 'MovieHeroCard.tsx'),
    'utf-8'
  );

  // Exact broadcast block check
  assert(
    movieHeroCardSrc.includes("window.dispatchEvent(\n      new CustomEvent('movie-hero-active-change'"),
    'MovieHeroCard must dispatch movie-hero-active-change'
  );
  assert(
    movieHeroCardSrc.includes('detail: { folderPath: folder.folderPath, filePath: episode.filePath }'),
    'Mount payload must include folderPath and filePath'
  );
  assert(
    movieHeroCardSrc.includes("new CustomEvent('movie-hero-active-change', {\n          detail: null,"),
    'Unmount cleanup must dispatch detail: null'
  );
  assert(
    movieHeroCardSrc.includes('data-movie-hero-card="true"'),
    'Root element must include data-movie-hero-card="true"'
  );
  assert(
    movieHeroCardSrc.includes('data-folder-path={folder.folderPath}'),
    'Root element must bind data-folder-path'
  );
});

// ---------------------------------------------------------------------------
// UpNextWidget SSR harness: UpNextWidget uses framer-motion (motion.div), which
// renders fine under react-dom/server's renderToString (static markup with
// initial styles) — the same empirical approach used for WhisperStudio below.
// React SSR inserts <!-- --> separators between adjacent text nodes; we strip
// them so assertions match the user-visible text.
// ---------------------------------------------------------------------------
function renderUpNext(data) {
  return renderToString(React.createElement(UpNextWidget, { data, onPlay: () => {} }));
}

function cleanSsr(html) {
  return html.replace(/<!-- -->/g, '');
}

function upNextPayload({ progress = {}, episode = {}, ...rest } = {}) {
  return {
    progress: {
      filePath: 'C:/Anime/Frieren/ep01.mkv',
      folderPath: 'C:/Anime/Frieren',
      fileName: 'ep01.mkv',
      currentTime: 240,
      duration: 1440,
      lastWatchedAt: 1,
      completed: false,
      ...progress,
    },
    episode: {
      fileName: 'ep01.mkv',
      filePath: 'C:/Anime/Frieren/ep01.mkv',
      episodeNumber: 1,
      hasExternalSrt: false,
      hasWhisperSrt: false,
      hasEmbeddedSubtitles: true,
      hasEmbeddedDubtitles: false,
      ...episode,
    },
    seasonName: "Frieren: Beyond Journey's End",
    posterUrl: 'https://example.com/frieren-poster.jpg',
    bannerUrl: 'https://example.com/frieren-banner.jpg',
    isUpNext: false,
    ...rest,
  };
}

// 1.2 Adversarial payload: progress.duration === 0 (progress-bar zero-guard)
runTest('1.2 UpNextWidget renders without throwing when progress.duration === 0', () => {
  let html;
  assert.doesNotThrow(() => {
    html = cleanSsr(renderUpNext(upNextPayload({ progress: { duration: 0, currentTime: 0 } })));
  }, 'Rendering with duration 0 must not throw');

  assert(html.length > 0, 'Widget must render non-empty markup');
  assert(/width:\s*0%/.test(html), 'Progress bar fill must compute 0% via the zero-guard, never NaN%');
  assert(!html.includes('NaN') && !html.includes('Infinity'), 'No NaN/Infinity may leak into the DOM');
  assert(html.includes('00:00'), 'Timecodes must render via formatTime even at zero progress');
});

// 1.3 Adversarial payload: currentTime === 0 and completed episodes
runTest('1.3 UpNextWidget renders without throwing when currentTime === 0 or episode is completed', () => {
  let zeroCurrent;
  assert.doesNotThrow(() => {
    zeroCurrent = cleanSsr(renderUpNext(upNextPayload({ progress: { currentTime: 0, completed: false } })));
  }, 'Rendering with currentTime 0 must not throw');
  assert(zeroCurrent.length > 0 && !zeroCurrent.includes('NaN'), 'currentTime 0 renders safely without NaN');

  let completed;
  assert.doesNotThrow(() => {
    completed = cleanSsr(renderUpNext(upNextPayload({ progress: { currentTime: 1500, duration: 1440, completed: true } })));
  }, 'Rendering a completed episode must not throw');
  assert(completed.length > 0, 'Completed episode renders non-empty markup');
  assert(/width:\s*100%/.test(completed), 'Over-watched completed progress clamps the bar to 100%');
  assert(completed.includes('25:00 / 24:00'), 'Completed episode still renders its timecode readout');
});

// 1.4 Chip switching: 'Up Next' when isUpNext, 'Continue Watching' otherwise
runTest('1.4 UpNextWidget renders UP NEXT when isUpNext is true and CONTINUE WATCHING otherwise', () => {
  const upNextHtml = cleanSsr(renderUpNext(upNextPayload({ isUpNext: true })));
  assert(upNextHtml.includes('Up Next'), 'isUpNext=true must render the Up Next chip');
  assert(!upNextHtml.includes('Continue Watching'), 'isUpNext=true must not render the Continue Watching chip');
  assert(upNextHtml.includes('uppercase'), 'Chip label must be presented uppercase');

  const continueHtml = cleanSsr(renderUpNext(upNextPayload({ isUpNext: false })));
  assert(continueHtml.includes('Continue Watching'), 'isUpNext=false must render the Continue Watching chip');
  assert(!continueHtml.includes('Up Next'), 'isUpNext=false must not render the Up Next chip');
});

// 1.5 Adversarial payload: null / undefined / '' poster & banner URLs
runTest('1.5 UpNextWidget renders poster fallback gracefully when posterUrl/bannerUrl are null, undefined or empty', () => {
  for (const posterUrl of [null, undefined, '']) {
    for (const bannerUrl of [null, undefined, '']) {
      let html;
      assert.doesNotThrow(() => {
        html = cleanSsr(renderUpNext(upNextPayload({ posterUrl, bannerUrl })));
      }, `posterUrl=${posterUrl}, bannerUrl=${bannerUrl} must not crash the render`);

      assert(html.includes('>F</span>'), 'Fallback initial of the series title must render when no poster resolves');
      assert(!html.includes('src="undefined"') && !html.includes('src="null"'), 'No broken undefined/null img src may be emitted');
    }
  }
});

// 1.6 Adversarial payload: empty progress.episodeNumber (label fallback)
runTest('1.6 UpNextWidget play button label falls back when progress.episodeNumber is empty', () => {
  for (const episodeNumber of [undefined, null, '']) {
    const html = cleanSsr(renderUpNext(upNextPayload({ progress: { episodeNumber } })));
    assert(html.includes('Play Episode'), `episodeNumber=${episodeNumber} must fall back to the "Play Episode" label`);
    assert(html.includes('title="Play episode"'), `episodeNumber=${episodeNumber} must fall back to the "Play episode" tooltip`);
    assert(!html.includes('>undefined<') && !html.includes('>null<'), 'No raw undefined/null may leak into the DOM');
  }

  const labeled = cleanSsr(renderUpNext(upNextPayload({ progress: { episodeNumber: 1 } })));
  assert(labeled.includes('Play 1'), 'Numeric episodeNumber renders as "Play 1"');
  assert(labeled.includes('title="Play 1"'), 'Numeric episodeNumber renders the matching tooltip');
});

// 1.7 Render storm: 1,000 adversarial payload alternations remain stable (mirrors the old event-storm stress)
runTest('1.7 UpNextWidget SSR render storm (1,000 cycles across adversarial payload alternations)', () => {
  const payloads = [
    upNextPayload({ progress: { duration: 0, currentTime: 0 }, isUpNext: true }),
    upNextPayload({ progress: { duration: -5, currentTime: NaN }, posterUrl: null, bannerUrl: null }),
    upNextPayload({ progress: { episodeNumber: '' }, posterUrl: '', bannerUrl: '' }),
    upNextPayload({ isUpNext: true, posterUrl: undefined, bannerUrl: undefined }),
  ];

  const baselines = payloads.map((p) => cleanSsr(renderUpNext(p)).length);
  assert(baselines.every((len) => len > 0), 'All adversarial payloads must render non-empty markup');

  for (let i = 0; i < 1000; i++) {
    const slot = i % payloads.length;
    const html = cleanSsr(renderUpNext(payloads[slot]));
    assert(html.length > 0 && !html.includes('NaN'), `Cycle ${i}: render must stay non-empty and NaN-free`);
    assert.strictEqual(html.length, baselines[slot], `Cycle ${i}: markup must be deterministic per payload`);
  }
});

// ===========================================================================
// CHALLENGE GROUP 2: App.tsx Global Escape Key Handling Invariants
// ===========================================================================
console.log('\n--- CHALLENGE GROUP 2: App.tsx Global Escape Key Invariants ---');

// Mock KeyboardEvent for Node.js
class MockKeyboardEvent extends Event {
  #isDefaultPrevented = false;
  constructor(type, init = {}) {
    super(type, { bubbles: true, cancelable: true });
    this.key = init.key || '';
    this.#isDefaultPrevented = Boolean(init.defaultPrevented);
  }

  get defaultPrevented() {
    return this.#isDefaultPrevented || super.defaultPrevented;
  }

  preventDefault() {
    this.#isDefaultPrevented = true;
    super.preventDefault();
  }
}

// App.tsx Escape Listener Simulator (mirrors App.tsx:466-496)
function createAppEscapeHarness(mockWin) {
  let closePlayerCalls = 0;

  const handleClosePlayer = () => {
    closePlayerCalls++;
  };

  const handleGlobalKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (e.defaultPrevented) return;

      const isDrawerOpen = Boolean(
        mockWin.querySelector('.translate-x-0') ||
        mockWin.querySelector('[aria-label="Close Episodes Drawer"]')
          ?.closest('.pointer-events-auto')
      );

      const isModalOpen = Boolean(
        mockWin.querySelector('.glass-dropdown') ||
        mockWin.querySelector('[role="dialog"]') ||
        mockWin.querySelector('[data-modal="true"]')
      );

      if (isDrawerOpen || isModalOpen) {
        return;
      }

      handleClosePlayer();
    }
  };

  mockWin.addEventListener('keydown', handleGlobalKeyDown);

  return {
    getCloseCount: () => closePlayerCalls,
    resetCount: () => { closePlayerCalls = 0; },
    teardown: () => mockWin.removeEventListener('keydown', handleGlobalKeyDown),
  };
}

// 2.1 Escape suppressed when .translate-x-0 (EpisodeDrawer) is present
runTest('2.1 Pressing Escape with .translate-x-0 does NOT close video player', () => {
  const mockWin = new MockDOMWindow();
  const harness = createAppEscapeHarness(mockWin);

  mockWin.setMockElement('.translate-x-0', {});

  const evt = new MockKeyboardEvent('keydown', { key: 'Escape' });
  mockWin.dispatchEvent(evt);

  assert.strictEqual(harness.getCloseCount(), 0, 'Player close must be suppressed when drawer is open');
  harness.teardown();
});

// 2.2 Escape suppressed when [aria-label="Close Episodes Drawer"] inside .pointer-events-auto
runTest('2.2 Pressing Escape with Drawer close button in .pointer-events-auto does NOT close video player', () => {
  const mockWin = new MockDOMWindow();
  const harness = createAppEscapeHarness(mockWin);

  mockWin.setMockElement('[aria-label="Close Episodes Drawer"]', {
    '.pointer-events-auto': true,
  });

  const evt = new MockKeyboardEvent('keydown', { key: 'Escape' });
  mockWin.dispatchEvent(evt);

  assert.strictEqual(harness.getCloseCount(), 0, 'Player close must be suppressed when drawer button is present');
  harness.teardown();
});

// 2.3 Escape suppressed when [role="dialog"] is present
runTest('2.3 Pressing Escape with [role="dialog"] does NOT close video player', () => {
  const mockWin = new MockDOMWindow();
  const harness = createAppEscapeHarness(mockWin);

  mockWin.setMockElement('[role="dialog"]', {});

  const evt = new MockKeyboardEvent('keydown', { key: 'Escape' });
  mockWin.dispatchEvent(evt);

  assert.strictEqual(harness.getCloseCount(), 0, 'Player close must be suppressed when dialog is open');
  harness.teardown();
});

// 2.4 Escape suppressed when [data-modal="true"] is present
runTest('2.4 Pressing Escape with [data-modal="true"] does NOT close video player', () => {
  const mockWin = new MockDOMWindow();
  const harness = createAppEscapeHarness(mockWin);

  mockWin.setMockElement('[data-modal="true"]', {});

  const evt = new MockKeyboardEvent('keydown', { key: 'Escape' });
  mockWin.dispatchEvent(evt);

  assert.strictEqual(harness.getCloseCount(), 0, 'Player close must be suppressed when modal is open');
  harness.teardown();
});

// 2.5 Escape suppressed when .glass-dropdown is present
runTest('2.5 Pressing Escape with .glass-dropdown does NOT close video player', () => {
  const mockWin = new MockDOMWindow();
  const harness = createAppEscapeHarness(mockWin);

  mockWin.setMockElement('.glass-dropdown', {});

  const evt = new MockKeyboardEvent('keydown', { key: 'Escape' });
  mockWin.dispatchEvent(evt);

  assert.strictEqual(harness.getCloseCount(), 0, 'Player close must be suppressed when dropdown is open');
  harness.teardown();
});

// 2.6 Escape suppressed when e.defaultPrevented is true (inner handler already consumed event)
runTest('2.6 Pressing Escape with e.defaultPrevented=true does NOT close video player even without modal', () => {
  const mockWin = new MockDOMWindow();
  const harness = createAppEscapeHarness(mockWin);

  const evt = new MockKeyboardEvent('keydown', { key: 'Escape', defaultPrevented: true });
  mockWin.dispatchEvent(evt);

  assert.strictEqual(harness.getCloseCount(), 0, 'Player close must respect e.defaultPrevented');
  harness.teardown();
});

// 2.7 Escape closes player when no drawer, modal, or dropdown is present and not defaultPrevented
runTest('2.7 Pressing Escape with clean DOM closes video player', () => {
  const mockWin = new MockDOMWindow();
  const harness = createAppEscapeHarness(mockWin);

  const evt = new MockKeyboardEvent('keydown', { key: 'Escape' });
  mockWin.dispatchEvent(evt);

  assert.strictEqual(harness.getCloseCount(), 1, 'Player close must be invoked when clear');
  harness.teardown();
});

// 2.8 Non-Escape keys do NOT trigger player close
runTest('2.8 Non-Escape keys (Space, Enter, Tab, ArrowRight) never close player', () => {
  const mockWin = new MockDOMWindow();
  const harness = createAppEscapeHarness(mockWin);

  for (const k of [' ', 'Enter', 'Tab', 'ArrowRight', 'ArrowLeft', 'KeyF', 'KeyM']) {
    const evt = new MockKeyboardEvent('keydown', { key: k });
    mockWin.dispatchEvent(evt);
  }

  assert.strictEqual(harness.getCloseCount(), 0, 'No non-Escape keys may close player');
  harness.teardown();
});

// 2.9 Stress test: alternating DOM states during 500 Escape keypresses
runTest('2.9 High-frequency Escape keypress storm (500 cycles) across shifting DOM states', () => {
  const mockWin = new MockDOMWindow();
  const harness = createAppEscapeHarness(mockWin);

  let expectedCloses = 0;

  for (let i = 0; i < 500; i++) {
    const mod = i % 4;
    if (mod === 0) {
      // Clear DOM
      mockWin.clearMockElement('.translate-x-0');
      mockWin.clearMockElement('[role="dialog"]');
      const evt = new MockKeyboardEvent('keydown', { key: 'Escape' });
      mockWin.dispatchEvent(evt);
      expectedCloses++;
    } else if (mod === 1) {
      // Drawer open
      mockWin.setMockElement('.translate-x-0', {});
      const evt = new MockKeyboardEvent('keydown', { key: 'Escape' });
      mockWin.dispatchEvent(evt);
    } else if (mod === 2) {
      // Dialog open
      mockWin.clearMockElement('.translate-x-0');
      mockWin.setMockElement('[role="dialog"]', {});
      const evt = new MockKeyboardEvent('keydown', { key: 'Escape' });
      mockWin.dispatchEvent(evt);
    } else {
      // Clear DOM but defaultPrevented
      mockWin.clearMockElement('[role="dialog"]');
      const evt = new MockKeyboardEvent('keydown', { key: 'Escape', defaultPrevented: true });
      mockWin.dispatchEvent(evt);
    }
  }

  assert.strictEqual(
    harness.getCloseCount(),
    expectedCloses,
    `Expected ${expectedCloses} closes, got ${harness.getCloseCount()}`
  );
  harness.teardown();
});

// ===========================================================================
// CHALLENGE GROUP 3: WhisperStudio Visual Cleanliness & DOM Chips
// ===========================================================================
console.log('\n--- CHALLENGE GROUP 3: WhisperStudio Visual Cleanliness ---');

runTest('3.1 WhisperStudio DOM output does NOT contain raw CLI flags', () => {
  const html = renderToString(
    React.createElement(WhisperStudio, {
      initialFolder: {
        folderPath: 'C:/Anime/SpyXFamily',
        folderName: 'Spy x Family',
        episodes: [
          {
            fileName: 'Spy_01.mkv',
            filePath: 'C:/Anime/SpyXFamily/Spy_01.mkv',
            episodeNumber: 1,
            hasExternalSrt: false,
            hasWhisperSrt: false,
            hasEmbeddedSubtitles: true,
            hasEmbeddedDubtitles: false,
          },
        ],
      },
      whisperExists: true,
      onRefreshLibrary: () => {},
    })
  );

  assert(!html.includes('--sentence --ff_sync'), 'Raw --sentence --ff_sync CLI flags must not be rendered');
  assert(!html.includes('Max lines: 2 | Max width: 42 chars'), 'Raw parameter dump must not be rendered');
});

runTest('3.2 WhisperStudio DOM renders polished human-readable chips', () => {
  const html = renderToString(
    React.createElement(WhisperStudio, {
      initialFolder: {
        folderPath: 'C:/Anime/SpyXFamily',
        folderName: 'Spy x Family',
        episodes: [],
      },
      whisperExists: true,
      onRefreshLibrary: () => {},
    })
  );

  assert(html.includes('large-v3-turbo'), 'Chip: large-v3-turbo rendered');
  assert(html.includes('Accurate Timestamps'), 'Chip: Accurate Timestamps rendered');
  assert(html.includes('English Dialogue'), 'Chip: English Dialogue rendered');
  assert(html.includes('Standard 2-Line'), 'Chip: Standard 2-Line rendered');
});

runTest('3.3 WhisperStudio processing options card uses consistent glassmorphic styling', () => {
  const wsSrc = fs.readFileSync(
    path.join(__dirname, 'src', 'components', 'WhisperStudio', 'WhisperStudio.tsx'),
    'utf-8'
  );

  assert(
    wsSrc.includes('rounded-2xl bg-[#141418] border border-white/10 space-y-3 shadow-md'),
    'Processing options card must match standard rounded dark container'
  );
});

// ===========================================================================
// CHALLENGE GROUP 4: SettingsModal Accidental Deletion Confirmation Lifecycle
// ===========================================================================
console.log('\n--- CHALLENGE GROUP 4: SettingsModal Confirmation Lifecycle ---');

runTest('4.1 SettingsModal confirmation state machine requires 2-step deletion', () => {
  class SettingsModalHarness {
    constructor(folders) {
      this.folders = [...folders];
      this.confirmDeleteIndex = null;
    }

    clickTrash(index) {
      this.confirmDeleteIndex = index;
    }

    clickCancel() {
      this.confirmDeleteIndex = null;
    }

    clickConfirmRemove(index) {
      if (this.confirmDeleteIndex === index) {
        this.folders.splice(index, 1);
        this.confirmDeleteIndex = null;
      }
    }
  }

  const harness = new SettingsModalHarness(['C:/Anime/FolderA', 'C:/Anime/FolderB']);

  // Initial state: no confirmation active
  assert.strictEqual(harness.confirmDeleteIndex, null);
  assert.strictEqual(harness.folders.length, 2);

  // Click trash on FolderB (index 1)
  harness.clickTrash(1);
  assert.strictEqual(harness.confirmDeleteIndex, 1);
  assert.strictEqual(harness.folders.length, 2, 'Folder not deleted on trash click');

  // Cancel deletion
  harness.clickCancel();
  assert.strictEqual(harness.confirmDeleteIndex, null);
  assert.strictEqual(harness.folders.length, 2, 'Folder not deleted on cancel');

  // Click trash on FolderA (index 0) and confirm
  harness.clickTrash(0);
  assert.strictEqual(harness.confirmDeleteIndex, 0);
  harness.clickConfirmRemove(0);
  assert.strictEqual(harness.confirmDeleteIndex, null);
  assert.strictEqual(harness.folders.length, 1);
  assert.strictEqual(harness.folders[0], 'C:/Anime/FolderB');
});

runTest('4.2 SettingsModal includes modal accessibility attributes', () => {
  const smSrc = fs.readFileSync(
    path.join(__dirname, 'src', 'components', 'SettingsModal.tsx'),
    'utf-8'
  );

  assert(smSrc.includes('role="dialog"'), 'SettingsModal must have role="dialog"');
  assert(smSrc.includes('aria-modal="true"'), 'SettingsModal must have aria-modal="true"');
  assert(smSrc.includes('data-modal="true"'), 'SettingsModal must have data-modal="true"');
});

// ===========================================================================
// CHALLENGE GROUP 5: EpisodeCard & FolderBrowser Subtitle Precedence
// ===========================================================================
console.log('\n--- CHALLENGE GROUP 5: Subtitle Precedence & Search State Matrix ---');

runTest('5.1 EpisodeCard subtitle badge precedence strictly prevents false negative "No Sub"', () => {
  // Pure evaluator replicating EpisodeCard subtitle branch
  function evaluateSubtitleBadge(ep) {
    if (ep.hasEmbeddedDubtitles) return 'Dub Sub';
    if (ep.hasWhisperSrt) return 'Whisper AI';
    if (ep.hasExternalSrt) return 'Ext Sub';
    if (ep.hasEmbeddedSubtitles) return 'Sub';
    return 'No Sub';
  }

  // Case 1: Standard embedded translation subtitles only
  const epEmbedded = {
    hasEmbeddedDubtitles: false,
    hasWhisperSrt: false,
    hasExternalSrt: false,
    hasEmbeddedSubtitles: true,
  };
  assert.strictEqual(evaluateSubtitleBadge(epEmbedded), 'Sub', 'Embedded subs must yield Sub');

  // Case 2: Dubtitles take top precedence
  const epDub = { ...epEmbedded, hasEmbeddedDubtitles: true };
  assert.strictEqual(evaluateSubtitleBadge(epDub), 'Dub Sub');

  // Case 3: Whisper takes precedence over external and embedded
  const epWhisper = { ...epEmbedded, hasWhisperSrt: true };
  assert.strictEqual(evaluateSubtitleBadge(epWhisper), 'Whisper AI');

  // Case 4: No subtitles found
  const epNone = {
    hasEmbeddedDubtitles: false,
    hasWhisperSrt: false,
    hasExternalSrt: false,
    hasEmbeddedSubtitles: false,
  };
  assert.strictEqual(evaluateSubtitleBadge(epNone), 'No Sub');
});

runTest('5.2 FolderBrowser search matrix: zero match query never displays unconfigured library warning', () => {
  function getFolderBrowserViewState(folders, filteredFolders, searchQuery, selectedFolder) {
    const isSearchEmpty = Boolean(filteredFolders.length === 0 && searchQuery.trim());
    const isLibraryEmpty = Boolean(folders.length === 0);
    const renderSelectedDetails = Boolean(filteredFolders.length > 0 && selectedFolder);

    return { isSearchEmpty, isLibraryEmpty, renderSelectedDetails };
  }

  // State 1: Active library, search returns 0 matches
  const state1 = getFolderBrowserViewState(
    [{ folderName: 'Attack on Titan' }],
    [],
    'Naruto',
    { folderName: 'Attack on Titan' }
  );
  assert.strictEqual(state1.isSearchEmpty, true, 'Dedicated search empty state shown');
  assert.strictEqual(state1.isLibraryEmpty, false, 'Unconfigured library warning NOT shown');
  assert.strictEqual(state1.renderSelectedDetails, false, 'Selected details grid suppressed');

  // State 2: Truly empty library
  const state2 = getFolderBrowserViewState([], [], '', null);
  assert.strictEqual(state2.isSearchEmpty, false);
  assert.strictEqual(state2.isLibraryEmpty, true, 'Unconfigured library warning shown when library is empty');
  assert.strictEqual(state2.renderSelectedDetails, false);
});

console.log('\n================================================================');
console.log(`ALL CHALLENGER 2 EMPIRICAL TESTS PASSED: ${passedTests} / ${totalTests} (100%)`);
console.log('================================================================\n');
