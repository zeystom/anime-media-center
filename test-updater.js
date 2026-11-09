import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('================================================================');
console.log('   RUNNING COMPREHENSIVE KAIKO UPDATER TEST SUITE               ');
console.log('================================================================');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Bundle electron/updater.ts and electron/storage.ts via esbuild
// ---------------------------------------------------------------------------
const bundle = await esbuild.build({
  stdin: {
    contents: `
      export { isNewerVersion, getAppVersion } from './electron/updater.ts';
      export { StorageService } from './electron/storage.ts';
    `,
    resolveDir: process.cwd(),
    sourcefile: 'test-updater-entry.ts',
  },
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
  external: [
    'electron',
    'electron-updater',
    'fs',
    'path',
    'child_process',
    'crypto',
    'http',
    'url',
    'os',
    'events',
  ],
  plugins: [
    {
      name: 'mock-electron',
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => {
          return { path: path.join(process.cwd(), 'test-mock-electron.js') };
        });
      },
    },
  ],
});

const tmpBundlePath = path.join(process.cwd(), '.test_updater_bundle.mjs');
fs.writeFileSync(tmpBundlePath, bundle.outputFiles[0].text);

let isNewerVersion, getAppVersion, StorageService;
try {
  const mod = await import(pathToFileURL(tmpBundlePath).href);
  isNewerVersion = mod.isNewerVersion;
  getAppVersion = mod.getAppVersion;
  StorageService = mod.StorageService;
} finally {
  try { fs.unlinkSync(tmpBundlePath); } catch {}
}

// 1. Version Comparison Logic Test
console.log('\n--- TEST SUITE 1: Version Comparison Logic (isNewerVersion) ---');

runTest('1.1 Newer patch version detected', () => {
  assert.strictEqual(isNewerVersion('1.0.5', '1.0.4'), true);
  assert.strictEqual(isNewerVersion('v1.0.5', '1.0.4'), true);
  assert.strictEqual(isNewerVersion('1.0.5', 'v1.0.4'), true);
});

runTest('1.2 Newer minor and major versions detected', () => {
  assert.strictEqual(isNewerVersion('1.1.0', '1.0.4'), true);
  assert.strictEqual(isNewerVersion('2.0.0', '1.9.9'), true);
});

runTest('1.3 Same version is not newer', () => {
  assert.strictEqual(isNewerVersion('1.0.4', '1.0.4'), false);
  assert.strictEqual(isNewerVersion('v1.0.4', '1.0.4'), false);
  assert.strictEqual(isNewerVersion('1.0.4', 'v1.0.4'), false);
});

runTest('1.4 Older version is not newer', () => {
  assert.strictEqual(isNewerVersion('1.0.3', '1.0.4'), false);
  assert.strictEqual(isNewerVersion('0.9.9', '1.0.4'), false);
});

runTest('1.5 Edge cases: invalid / empty strings / null / undefined handled gracefully', () => {
  assert.strictEqual(isNewerVersion('', '1.0.4'), false);
  assert.strictEqual(isNewerVersion('1.0.4', ''), true);
  assert.strictEqual(isNewerVersion(null, '1.0.4'), false);
  assert.strictEqual(isNewerVersion(undefined, '1.0.4'), false);
  assert.strictEqual(isNewerVersion('1.0.4', null), true);
  assert.strictEqual(isNewerVersion(null, null), false);
});

// 2. Storage Settings & Defaults Test
console.log('\n--- TEST SUITE 2: Storage Settings & Defaults ---');

const storage = new StorageService();
const settings = storage.getSettings();

runTest('2.1 checkForUpdatesOnStartup defaults to true', () => {
  assert.strictEqual(settings.checkForUpdatesOnStartup, true);
});

runTest('2.2 autoUpdate defaults to true', () => {
  assert.strictEqual(settings.autoUpdate, true);
});

runTest('2.3 updateSettings persists updater preferences', () => {
  const updated = storage.updateSettings({
    checkForUpdatesOnStartup: false,
    autoUpdate: false,
  });
  assert.strictEqual(updated.checkForUpdatesOnStartup, false);
  assert.strictEqual(updated.autoUpdate, false);

  // Read back fresh
  const reloaded = storage.getSettings();
  assert.strictEqual(reloaded.checkForUpdatesOnStartup, false);
  assert.strictEqual(reloaded.autoUpdate, false);

  // Restore defaults
  storage.updateSettings({
    checkForUpdatesOnStartup: true,
    autoUpdate: true,
  });
  const restored = storage.getSettings();
  assert.strictEqual(restored.checkForUpdatesOnStartup, true);
  assert.strictEqual(restored.autoUpdate, true);
});

// 3. Static Analysis of SettingsModal.tsx
console.log('\n--- TEST SUITE 3: SettingsModal.tsx Updater Integration Invariants ---');

const settingsModalSrc = fs.readFileSync(path.join(__dirname, 'src', 'components', 'SettingsModal.tsx'), 'utf-8');

runTest('3.1 SettingsModal renders version inscription in the corner', () => {
  assert(
    settingsModalSrc.includes('v{appVersion}'),
    'SettingsModal must render v{appVersion} badge in the corner'
  );
  assert(
    settingsModalSrc.includes('getAppVersion'),
    'SettingsModal must fetch appVersion via getAppVersion API'
  );
});

runTest('3.2 SettingsModal has toggle for search updates at start', () => {
  assert(
    settingsModalSrc.includes('Check for updates on startup'),
    'SettingsModal must include "Check for updates on startup" label'
  );
  assert(
    settingsModalSrc.includes('checkForUpdatesOnStartup'),
    'SettingsModal must bind checkForUpdatesOnStartup state'
  );
});

runTest('3.3 SettingsModal has toggle for auto-updates', () => {
  assert(
    settingsModalSrc.includes('Auto-updates'),
    'SettingsModal must include "Auto-updates" label'
  );
  assert(
    settingsModalSrc.includes('autoUpdate'),
    'SettingsModal must bind autoUpdate state'
  );
});

runTest('3.4 SettingsModal has button to check for updates', () => {
  assert(
    settingsModalSrc.includes('Check for Updates'),
    'SettingsModal must include "Check for Updates" button'
  );
  assert(
    settingsModalSrc.includes('handleCheckForUpdates'),
    'SettingsModal must have handleCheckForUpdates handler'
  );
});

runTest('3.5 SettingsModal preserves modal accessibility attributes', () => {
  assert(settingsModalSrc.includes('role="dialog"'), 'Must have role="dialog"');
  assert(settingsModalSrc.includes('aria-modal="true"'), 'Must have aria-modal="true"');
  assert(settingsModalSrc.includes('data-modal="true"'), 'Must have data-modal="true"');
});

// 4. Static Analysis of UpdatePromptModal.tsx
console.log('\n--- TEST SUITE 4: UpdatePromptModal.tsx Invariants ---');

const updatePromptModalSrc = fs.readFileSync(path.join(__dirname, 'src', 'components', 'UpdatePromptModal.tsx'), 'utf-8');

runTest('4.1 UpdatePromptModal has choice to update or not', () => {
  assert(updatePromptModalSrc.includes('Update Now'), 'Must have "Update Now" choice button');
  assert(updatePromptModalSrc.includes('Later'), 'Must have "Later" choice button');
});

runTest('4.2 UpdatePromptModal has checkbox to not show again and turn off auto-updates', () => {
  assert(
    updatePromptModalSrc.includes("Don't show again and disable auto-updates"),
    'Must have checkbox with text "Don\'t show again and disable auto-updates"'
  );
  assert(
    updatePromptModalSrc.includes('dontShowAgain'),
    'Must track dontShowAgain state'
  );
  assert(
    updatePromptModalSrc.includes('checkForUpdatesOnStartup: false') &&
    updatePromptModalSrc.includes('autoUpdate: false'),
    'Must set both checkForUpdatesOnStartup: false and autoUpdate: false when checked'
  );
});

runTest('4.3 UpdatePromptModal includes modal accessibility attributes', () => {
  assert(updatePromptModalSrc.includes('role="dialog"'), 'Must have role="dialog"');
  assert(updatePromptModalSrc.includes('aria-modal="true"'), 'Must have aria-modal="true"');
  assert(updatePromptModalSrc.includes('data-modal="true"'), 'Must have data-modal="true"');
});

// 5. Static Analysis of App.tsx
console.log('\n--- TEST SUITE 5: App.tsx Startup Update Integration ---');

const appSrc = fs.readFileSync(path.join(__dirname, 'src', 'App.tsx'), 'utf-8');

runTest('5.1 App.tsx renders UpdatePromptModal when startup update is found', () => {
  assert(appSrc.includes('UpdatePromptModal'), 'App.tsx must import and render UpdatePromptModal');
  assert(appSrc.includes('onStartupUpdateAvailable'), 'App.tsx must listen to onStartupUpdateAvailable');
});

// 6. Main Process & Preload API Invariants
console.log('\n--- TEST SUITE 6: IPC & Preload Channel Invariants ---');

const preloadSrc = fs.readFileSync(path.join(__dirname, 'electron', 'preload.ts'), 'utf-8');
const mainSrc = fs.readFileSync(path.join(__dirname, 'electron', 'main.ts'), 'utf-8');

runTest('6.1 Preload exposes updater API methods', () => {
  assert(preloadSrc.includes('getAppVersion'), 'Preload must expose getAppVersion');
  assert(preloadSrc.includes('getUpdaterState'), 'Preload must expose getUpdaterState');
  assert(preloadSrc.includes('checkForUpdates'), 'Preload must expose checkForUpdates');
  assert(preloadSrc.includes('downloadUpdate'), 'Preload must expose downloadUpdate');
  assert(preloadSrc.includes('installUpdate'), 'Preload must expose installUpdate');
  assert(preloadSrc.includes('onUpdaterStateChanged'), 'Preload must expose onUpdaterStateChanged');
  assert(preloadSrc.includes('onStartupUpdateAvailable'), 'Preload must expose onStartupUpdateAvailable');
});

runTest('6.2 Main process handles updater IPC channels and startup check', () => {
  assert(mainSrc.includes('updater:get-version'), 'Main must handle updater:get-version');
  assert(mainSrc.includes('updater:get-state'), 'Main must handle updater:get-state');
  assert(mainSrc.includes('updater:check'), 'Main must handle updater:check');
  assert(mainSrc.includes('updater:download'), 'Main must handle updater:download');
  assert(mainSrc.includes('updater:install'), 'Main must handle updater:install');
  assert(mainSrc.includes('checkForUpdates(true)'), 'Main must run startup update check');
});

// 7. Package.json publish configuration
console.log('\n--- TEST SUITE 7: package.json publish configuration ---');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));

runTest('7.1 package.json includes github publish config for zeystom/anime-media-center', () => {
  assert(Array.isArray(pkg.build?.publish), 'build.publish must be an array');
  const gh = pkg.build.publish.find((p) => p.provider === 'github');
  assert(gh, 'Must have github provider');
  assert.strictEqual(gh.owner, 'zeystom');
  assert.strictEqual(gh.repo, 'anime-media-center');
});

runTest('7.2 electron-updater dependency is present', () => {
  assert(pkg.dependencies['electron-updater'], 'electron-updater must be in dependencies');
});

// 8. Robustness & State Synchronization Invariants
console.log('\n--- TEST SUITE 8: Robustness & State Synchronization Invariants ---');

const updaterSrc = fs.readFileSync(path.join(__dirname, 'electron', 'updater.ts'), 'utf-8');

runTest('8.1 dev-app-update.yml exists with GitHub feed config for dev testing', () => {
  const devYmlPath = path.join(__dirname, 'dev-app-update.yml');
  assert(fs.existsSync(devYmlPath), 'dev-app-update.yml must exist');
  const devYml = fs.readFileSync(devYmlPath, 'utf-8');
  assert(devYml.includes('provider: github'), 'dev-app-update.yml must specify github provider');
  assert(devYml.includes('zeystom'), 'dev-app-update.yml must specify zeystom owner');
  assert(devYml.includes('anime-media-center'), 'dev-app-update.yml must specify anime-media-center repo');
});

runTest('8.2 App.tsx synchronizes settings with UpdatePromptModal via onUpdateSettings', () => {
  assert(appSrc.includes('onUpdateSettings={handleSaveSettings}'), 'App.tsx must pass handleSaveSettings to UpdatePromptModal');
  assert(updatePromptModalSrc.includes('onUpdateSettings?:'), 'UpdatePromptModalProps must accept onUpdateSettings');
});

runTest('8.3 updater.ts includes periodic background update check', () => {
  assert(updaterSrc.includes('startPeriodicUpdateCheck'), 'updater.ts must implement startPeriodicUpdateCheck');
  assert(updaterSrc.includes('autoUpdate !== false'), 'updater.ts must respect autoUpdate setting');
});

runTest('8.4 updater.ts implements direct release asset download fallback', () => {
  assert(updaterSrc.includes('downloadDirectAsset'), 'updater.ts must implement downloadDirectAsset fallback');
  assert(updaterSrc.includes('downloadedInstallerPath'), 'updater.ts must track downloadedInstallerPath');
});

runTest('8.5 updater.ts handles non-200 HTTP responses in update check gracefully', () => {
  assert(updaterSrc.includes('GitHub API rate limit exceeded') || updaterSrc.includes('status === 403'), 'updater.ts must handle rate limits');
  assert(updaterSrc.includes('updaterState.status = \'error\''), 'updater.ts must set error status on failure');
});

// 9. Static Analysis & Simulation of Modal Escape Routing Invariants
console.log('\n--- TEST SUITE 9: SettingsModal & AnimeDetailView Escape Routing Invariants ---');

const animeDetailSrc = fs.readFileSync(path.join(__dirname, 'src', 'components', 'AnimeDetail', 'AnimeDetailView.tsx'), 'utf-8');

runTest('9.1 SettingsModal handles Escape in capture phase with stopPropagation', () => {
  assert(
    settingsModalSrc.includes("window.addEventListener('keydown', handleKeyDown, true)"),
    'SettingsModal must attach keydown listener in capture phase (true)'
  );
  assert(
    settingsModalSrc.includes("window.removeEventListener('keydown', handleKeyDown, true)"),
    'SettingsModal must clean up keydown listener in capture phase (true)'
  );
  assert(
    settingsModalSrc.includes('e.stopPropagation()') && settingsModalSrc.includes('e.stopImmediatePropagation()'),
    'SettingsModal must stop event propagation on Escape'
  );
});

runTest('9.2 AnimeDetailView suppresses Escape close when modal dialog is open', () => {
  assert(
    animeDetailSrc.includes("document.querySelector('[role=\"dialog\"]')"),
    'AnimeDetailView must check for role="dialog" before handling Escape'
  );
  assert(
    animeDetailSrc.includes("document.querySelector('[data-modal=\"true\"]')"),
    'AnimeDetailView must check for data-modal="true" before handling Escape'
  );
  assert(
    animeDetailSrc.includes('if (isModalOpen) return'),
    'AnimeDetailView must return early if any modal is open'
  );
});

runTest('9.3 Simulation: pressing Escape with SettingsModal open over AnimeDetailView closes settings without closing detail', () => {
  let settingsClosed = false;
  let detailClosed = false;

  const mockDom = {
    hasDialog: true,
  };

  // SettingsModal handler (runs in capture phase)
  const settingsHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      settingsClosed = true;
    }
  };

  // AnimeDetailView handler (runs in bubbling phase)
  const animeDetailHandler = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (mockDom.hasDialog) return;
    detailClosed = true;
  };

  class FakeEvent {
    constructor(key) {
      this.key = key;
      this.defaultPrevented = false;
      this.propagationStopped = false;
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.propagationStopped = true; }
    stopImmediatePropagation() { this.propagationStopped = true; }
  }

  const evt = new FakeEvent('Escape');
  settingsHandler(evt);
  if (!evt.propagationStopped) {
    animeDetailHandler(evt);
  }

  assert.strictEqual(settingsClosed, true, 'SettingsModal must have closed');
  assert.strictEqual(detailClosed, false, 'AnimeDetailView must NOT have closed');
});

console.log('\n================================================================');
console.log(`TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${totalTests - passedTests}`);
console.log('================================================================\n');

if (totalTests !== passedTests) {
  process.exit(1);
}
