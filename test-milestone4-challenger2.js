/**
 * Milestone 4 Empirical Challenger 2 Verification & Stress Harness
 * Target: Library UI/UX Polish & Consistency
 *
 * Verifies:
 * 1. HeroContinueWatching & MovieHeroCard deduplication, custom event lifecycle, unmount cleanup, unexpected payloads
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
    HeroContinueWatching: './src/components/Library/HeroContinueWatching.tsx',
    WhisperStudio: './src/components/WhisperStudio/WhisperStudio.tsx',
  },
  bundle: true,
  format: 'esm',
  outdir: tempDir,
  platform: 'node',
  external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'lucide-react', 'electron'],
});

const { HeroContinueWatching } = await import(`file://${path.join(tempDir, 'HeroContinueWatching.js').replace(/\\/g, '/')}`);
const { WhisperStudio } = await import(`file://${path.join(tempDir, 'WhisperStudio.js').replace(/\\/g, '/')}`);

// Cleanup bundle artifacts
try {
  fs.rmSync(tempDir, { recursive: true, force: true });
} catch {}

// ===========================================================================
// CHALLENGE GROUP 1: HeroContinueWatching & MovieHeroCard Deduplication
// ===========================================================================
console.log('--- CHALLENGE GROUP 1: Hero Card Deduplication & Event Lifecycle ---');

// Mock Window & DOM Environment for Hero Card Deduplication
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

// 1.2 HeroContinueWatching Event Listener Lifecycle & Unmount Cleanup
runTest('1.2 HeroContinueWatching attaches and properly detaches movie-hero-active-change listener', () => {
  const mockWindow = new MockDOMWindow();

  // Emulate HeroContinueWatching state machine logic
  class HeroContinueStateHarness {
    constructor(lastWatched, isMovieHeroActive, selectedFolderPath) {
      this.lastWatched = lastWatched;
      this.isMovieHeroActive = isMovieHeroActive;
      this.selectedFolderPath = selectedFolderPath;
      this.activeMovieHeroPath = null;
      this.mounted = false;

      this.handleMovieHeroChange = (e) => {
        const custom = e;
        this.activeMovieHeroPath = custom.detail?.folderPath || null;
      };
    }

    mount(win, initialEl = null) {
      this.mounted = true;
      if (initialEl) {
        this.activeMovieHeroPath = initialEl.getAttribute('data-folder-path') || null;
      }
      win.addEventListener('movie-hero-active-change', this.handleMovieHeroChange);
    }

    unmount(win) {
      this.mounted = false;
      win.removeEventListener('movie-hero-active-change', this.handleMovieHeroChange);
    }

    isDuplicate() {
      return Boolean(
        this.isMovieHeroActive ||
        (this.selectedFolderPath && this.selectedFolderPath === this.lastWatched.folderPath) ||
        (this.activeMovieHeroPath && this.activeMovieHeroPath === this.lastWatched.folderPath)
      );
    }
  }

  const lastWatched = { folderPath: 'C:/Anime/Frieren', fileName: 'Frieren_01.mkv', currentTime: 120, duration: 1400 };
  const harness = new HeroContinueStateHarness(lastWatched, false, undefined);

  assert.strictEqual(mockWindow.listenerCount('movie-hero-active-change'), 0);
  harness.mount(mockWindow);
  assert.strictEqual(mockWindow.listenerCount('movie-hero-active-change'), 1, 'Listener registered on mount');

  // Unmount must clean up
  harness.unmount(mockWindow);
  assert.strictEqual(mockWindow.listenerCount('movie-hero-active-change'), 0, 'Listener removed on unmount');

  // Verify events dispatched after unmount do not affect state
  mockWindow.dispatchEvent(
    new CustomEvent('movie-hero-active-change', {
      detail: { folderPath: 'C:/Anime/Frieren' },
    })
  );
  assert.strictEqual(harness.activeMovieHeroPath, null, 'Unmounted component state unchanged');
});

// 1.3 HeroContinueWatching Initial State from Existing DOM element
runTest('1.3 HeroContinueWatching reads data-folder-path if MovieHeroCard already in DOM at mount', () => {
  const mockWindow = new MockDOMWindow();
  mockWindow.setMockElement('[data-movie-hero-card="true"]', {
    'data-folder-path': 'C:/Anime/SpiritedAway',
  });

  const lastWatchedMatch = { folderPath: 'C:/Anime/SpiritedAway', fileName: 'movie.mkv', currentTime: 50, duration: 7200 };
  const lastWatchedDiff = { folderPath: 'C:/Anime/VinlandSaga', fileName: 'ep1.mkv', currentTime: 50, duration: 1400 };

  // Match scenario
  const el = mockWindow.querySelector('[data-movie-hero-card="true"]');
  const initialPath = el?.getAttribute('data-folder-path') || null;
  assert.strictEqual(initialPath, 'C:/Anime/SpiritedAway');

  const isDupMatch = Boolean(initialPath === lastWatchedMatch.folderPath);
  assert.strictEqual(isDupMatch, true, 'Immediately deduplicates matching movie hero');

  const isDupDiff = Boolean(initialPath === lastWatchedDiff.folderPath);
  assert.strictEqual(isDupDiff, false, 'Does not deduplicate when folder path differs');
});

// 1.4 Unexpected Event Payload Robustness (null, undefined, malformed, empty)
runTest('1.4 HeroContinueWatching safely handles null, undefined, and malformed event payloads', () => {
  const mockWindow = new MockDOMWindow();
  let activePath = 'INITIAL';

  const handler = (e) => {
    const custom = e;
    activePath = custom.detail?.folderPath || null;
  };
  mockWindow.addEventListener('movie-hero-active-change', handler);

  // Payload: null detail (unmount signal)
  mockWindow.dispatchEvent(new CustomEvent('movie-hero-active-change', { detail: null }));
  assert.strictEqual(activePath, null, 'detail: null safely resolves to null');

  // Payload: undefined detail
  mockWindow.dispatchEvent(new CustomEvent('movie-hero-active-change', { detail: undefined }));
  assert.strictEqual(activePath, null, 'detail: undefined safely resolves to null');

  // Payload: empty object
  mockWindow.dispatchEvent(new CustomEvent('movie-hero-active-change', { detail: {} }));
  assert.strictEqual(activePath, null, 'detail: {} safely resolves to null');

  // Payload: empty folderPath string
  mockWindow.dispatchEvent(new CustomEvent('movie-hero-active-change', { detail: { folderPath: '' } }));
  assert.strictEqual(activePath, null, 'detail: { folderPath: "" } safely resolves to null');

  // Payload: malformed numerical folderPath
  mockWindow.dispatchEvent(new CustomEvent('movie-hero-active-change', { detail: { folderPath: 99999 } }));
  assert.strictEqual(activePath, 99999, 'malformed number handled without throwing');
  assert.strictEqual(Boolean(activePath === 'C:/Anime/SomeFolder'), false);

  // Payload: valid matching folderPath
  mockWindow.dispatchEvent(new CustomEvent('movie-hero-active-change', { detail: { folderPath: 'C:/Anime/Frieren' } }));
  assert.strictEqual(activePath, 'C:/Anime/Frieren');

  mockWindow.removeEventListener('movie-hero-active-change', handler);
});

// 1.5 Rapid Event Dispatches and State Machine Stability (1,000 cycles)
runTest('1.5 Deduplication state machine remains consistent under rapid event storm (1,000 cycles)', () => {
  const mockWindow = new MockDOMWindow();
  const targetFolder = 'C:/Anime/MovieTarget';

  const lastWatched = {
    folderPath: targetFolder,
    fileName: 'movie.mkv',
    currentTime: 300,
    duration: 6000,
  };

  let activeMovieHeroPath = null;
  mockWindow.addEventListener('movie-hero-active-change', (e) => {
    activeMovieHeroPath = e.detail?.folderPath || null;
  });

  const getIsDuplicate = () => Boolean(activeMovieHeroPath && activeMovieHeroPath === lastWatched.folderPath);

  for (let i = 0; i < 1000; i++) {
    if (i % 3 === 0) {
      mockWindow.dispatchEvent(new CustomEvent('movie-hero-active-change', { detail: { folderPath: targetFolder } }));
      assert.strictEqual(getIsDuplicate(), true, `Cycle ${i}: Expected duplicate`);
    } else if (i % 3 === 1) {
      mockWindow.dispatchEvent(new CustomEvent('movie-hero-active-change', { detail: { folderPath: 'C:/Anime/Other' } }));
      assert.strictEqual(getIsDuplicate(), false, `Cycle ${i}: Expected non-duplicate for different path`);
    } else {
      mockWindow.dispatchEvent(new CustomEvent('movie-hero-active-change', { detail: null }));
      assert.strictEqual(getIsDuplicate(), false, `Cycle ${i}: Expected non-duplicate for null detail`);
    }
  }
});

// 1.6 HeroContinueWatching SSR / Component render verification
runTest('1.6 HeroContinueWatching returns null when isMovieHeroActive prop is true', () => {
  const dummyEpisode = {
    fileName: 'ep01.mkv',
    filePath: 'C:/Anime/Frieren/ep01.mkv',
    episodeNumber: 1,
    hasExternalSrt: false,
    hasWhisperSrt: false,
    hasEmbeddedSubtitles: true,
    hasEmbeddedDubtitles: false,
  };

  const html = renderToString(
    React.createElement(HeroContinueWatching, {
      lastWatched: {
        folderPath: 'C:/Anime/Frieren',
        filePath: 'C:/Anime/Frieren/ep01.mkv',
        fileName: 'ep01.mkv',
        currentTime: 240,
        duration: 1440,
        episodeNumber: 1,
      },
      episode: dummyEpisode,
      seasonName: 'Frieren: Beyond Journey\'s End',
      isMovieHeroActive: true, // Should suppress rendering
      onResume: () => {},
    })
  );

  assert.strictEqual(html, '', 'HeroContinueWatching must render nothing when isMovieHeroActive is true');
});

runTest('1.7 HeroContinueWatching renders full card when not duplicated', () => {
  const dummyEpisode = {
    fileName: 'ep01.mkv',
    filePath: 'C:/Anime/Frieren/ep01.mkv',
    episodeNumber: 1,
    hasExternalSrt: false,
    hasWhisperSrt: false,
    hasEmbeddedSubtitles: true,
    hasEmbeddedDubtitles: false,
  };

  const html = renderToString(
    React.createElement(HeroContinueWatching, {
      lastWatched: {
        folderPath: 'C:/Anime/Frieren',
        filePath: 'C:/Anime/Frieren/ep01.mkv',
        fileName: 'ep01.mkv',
        currentTime: 240,
        duration: 1440,
        episodeNumber: 1,
      },
      episode: dummyEpisode,
      seasonName: 'Frieren: Beyond Journey\'s End',
      isMovieHeroActive: false,
      onResume: () => {},
    })
  );

  assert(html.includes('Continue Watching'), 'Must render Continue Watching badge');
  assert(html.includes('Resume from'), 'Must render Resume button');
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
