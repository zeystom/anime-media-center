import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simulated WhisperManager to verify queue lifecycle and runPromise behavior
class MockWhisperManager {
  constructor() {
    this.isRunning = false;
    this.cancelled = false;
    this.currentItem = null;
    this.currentRunId = null;
    this.runPromise = null;
    this.queue = [];
    this.logs = [];
  }

  async startQueue(items, simulateProcessingFn) {
    if (this.isRunning || this.runPromise) {
      return { success: false, error: 'Whisper task is already in progress' };
    }

    const runId = Date.now().toString() + Math.random().toString();
    this.currentRunId = runId;
    this.cancelled = false;
    this.isRunning = true;
    this.queue = items.map((item) => ({ ...item }));

    const pendingItems = this.queue.filter((q) => q.status === 'pending');
    if (pendingItems.length === 0) {
      this.isRunning = false;
      this.currentRunId = null;
      this.logs.push('Nothing to do: all episodes already have .whisper.srt');
      return { success: true, message: 'All skipped' };
    }

    const run = (async () => {
      await Promise.resolve();
      try {
        for (let i = 0; i < this.queue.length; i++) {
          if (this.cancelled || this.currentRunId !== runId) break;
          const item = this.queue[i];
          if (item.status === 'skipped') continue;

          item.status = 'processing';
          this.currentItem = item;
          if (simulateProcessingFn) {
            await simulateProcessingFn(item, () => this.cancelled || this.currentRunId !== runId);
          }
          if (this.cancelled || this.currentRunId !== runId) {
            item.status = 'cancelled';
            break;
          }
          item.status = 'completed';
        }
      } finally {
        if (this.currentRunId === runId) {
          this.isRunning = false;
          this.currentItem = null;
        }
      }
    })();

    this.runPromise = run;
    run.finally(() => {
      if (this.runPromise === run) {
        this.runPromise = null;
      }
    });

    return { success: true };
  }

  cancel() {
    this.cancelled = true;
    if (this.currentItem) {
      this.currentItem.status = 'cancelled';
    }
  }
}

async function runTests() {
  const manager = new MockWhisperManager();

  // Scenario (a): All skipped, then second start
  console.log('Testing Scenario (a): All skipped, followed by second start...');
  const resA1 = await manager.startQueue([
    { fileName: 'ep1.mkv', status: 'skipped' },
    { fileName: 'ep2.mkv', status: 'skipped' },
  ]);
  assert.strictEqual(resA1.success, true);
  assert.strictEqual(manager.runPromise, null);
  assert.strictEqual(manager.isRunning, false);

  const resA2 = await manager.startQueue([
    { fileName: 'ep3.mkv', status: 'skipped' },
  ]);
  assert.strictEqual(resA2.success, true, 'Second start after all skipped failed!');
  console.log('✓ Scenario (a) passed.');

  // Scenario (b): Cancel during run, then second start
  console.log('Testing Scenario (b): Cancel during execution, followed by second start...');
  const resB1 = await manager.startQueue(
    [
      { fileName: 'ep1.mkv', status: 'pending' },
      { fileName: 'ep2.mkv', status: 'pending' },
    ],
    async (item) => {
      // Simulate running for 50ms then cancelling
      await new Promise((r) => setTimeout(r, 20));
      manager.cancel();
    }
  );
  assert.strictEqual(resB1.success, true);
  await manager.runPromise; // Wait for run to finish cancelling
  assert.strictEqual(manager.runPromise, null, 'runPromise was not cleared after cancel');
  assert.strictEqual(manager.isRunning, false, 'isRunning was not false after cancel');

  const resB2 = await manager.startQueue([
    { fileName: 'ep1.mkv', status: 'skipped' },
  ]);
  assert.strictEqual(resB2.success, true, 'Second start after cancel failed!');
  console.log('✓ Scenario (b) passed.');

  // Scenario (c): Normal run, then second start
  console.log('Testing Scenario (c): Normal processing run, followed by second start...');
  const resC1 = await manager.startQueue(
    [
      { fileName: 'ep1.mkv', status: 'pending' },
    ],
    async (item) => {
      await new Promise((r) => setTimeout(r, 20));
    }
  );
  assert.strictEqual(resC1.success, true);
  await manager.runPromise; // Wait for normal completion
  assert.strictEqual(manager.runPromise, null);
  assert.strictEqual(manager.isRunning, false);

  const resC2 = await manager.startQueue([
    { fileName: 'ep2.mkv', status: 'pending' },
  ], async () => {});
  assert.strictEqual(resC2.success, true, 'Second start after normal run failed!');
  await manager.runPromise;
  console.log('✓ Scenario (c) passed.');

  console.log('\nAll Whisper queue lifecycle tests passed successfully!');

  // =========================================================================
  // FASTER-WHISPER-XXL IN-APP ENGINE DOWNLOADER INVARIANTS
  // =========================================================================
  console.log('\n--- Running Faster-Whisper-XXL In-App Downloader Invariants ---');

  // 1. Recursive Executable Search Test
  console.log('Testing findExecutableInDir recursive resolution...');
  const tmpTestDir = path.join(os.tmpdir(), `test_whisper_find_${Date.now()}`);
  const nestedSubDir = path.join(tmpTestDir, 'subfolder', 'deep');
  fs.mkdirSync(nestedSubDir, { recursive: true });
  const fakeExe = path.join(nestedSubDir, 'faster-whisper-xxl.exe');
  fs.writeFileSync(fakeExe, 'binary content');

  function findExecutableInDir(dir, exeName, depth = 3) {
    if (!dir || !fs.existsSync(dir) || depth < 0) return null;
    const direct = path.join(dir, exeName);
    if (fs.existsSync(direct)) return direct;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sub = path.join(dir, entry.name);
          const found = findExecutableInDir(sub, exeName, depth - 1);
          if (found) return found;
        }
      }
    } catch {}
    return null;
  }

  const foundPath = findExecutableInDir(tmpTestDir, 'faster-whisper-xxl.exe');
  assert.strictEqual(foundPath, fakeExe, 'findExecutableInDir must locate faster-whisper-xxl.exe in nested directory');
  fs.rmSync(tmpTestDir, { recursive: true, force: true });
  console.log('✓ findExecutableInDir correctly finds nested executables.');

  // 2. Preload API Invariants
  console.log('Testing preload.ts exposes Whisper Engine Downloader APIs...');
  const preloadSrc = fs.readFileSync(path.join(__dirname, 'electron', 'preload.ts'), 'utf-8');
  assert(preloadSrc.includes('downloadWhisperEngine'), 'preload must expose downloadWhisperEngine');
  assert(preloadSrc.includes('cancelWhisperEngineDownload'), 'preload must expose cancelWhisperEngineDownload');
  assert(preloadSrc.includes('getWhisperEngineDownloadStatus'), 'preload must expose getWhisperEngineDownloadStatus');
  assert(preloadSrc.includes('onWhisperEngineDownloadProgress'), 'preload must expose onWhisperEngineDownloadProgress');
  assert(preloadSrc.includes('onWhisperEngineDownloadStatus'), 'preload must expose onWhisperEngineDownloadStatus');
  console.log('✓ Preload correctly exposes all Whisper Engine Downloader APIs.');

  // 3. Main Process IPC Invariants
  console.log('Testing main.ts registers Whisper Engine IPC handlers...');
  const mainSrc = fs.readFileSync(path.join(__dirname, 'electron', 'main.ts'), 'utf-8');
  assert(mainSrc.includes('initWhisperEngineDownloader'), 'main must initialize WhisperEngineDownloader');
  assert(mainSrc.includes("'download-whisper-engine'"), 'main must handle download-whisper-engine IPC');
  assert(mainSrc.includes("'cancel-whisper-engine-download'"), 'main must handle cancel-whisper-engine-download IPC');
  assert(mainSrc.includes("'get-whisper-engine-download-status'"), 'main must handle get-whisper-engine-download-status IPC');
  assert(mainSrc.includes('isDownloadingEngine'), 'checkBinaries must return isDownloadingEngine state');
  console.log('✓ Main process correctly registers all Whisper Engine IPC handlers.');

  // 4. SettingsModal In-App Engine Download Invariants
  console.log('Testing SettingsModal.tsx renders in-app engine installer with English UI...');
  const settingsModalSrc = fs.readFileSync(path.join(__dirname, 'src', 'components', 'SettingsModal.tsx'), 'utf-8');
  assert(settingsModalSrc.includes('handleDownloadWhisperEngine'), 'SettingsModal must have handleDownloadWhisperEngine');
  assert(settingsModalSrc.includes('handleCancelWhisperEngineDownload'), 'SettingsModal must have handleCancelWhisperEngineDownload');
  assert(settingsModalSrc.includes('Download Engine'), 'SettingsModal must have "Download Engine" button');
  assert(settingsModalSrc.includes('onWhisperEngineDownloadProgress'), 'SettingsModal must listen to onWhisperEngineDownloadProgress');
  assert(settingsModalSrc.includes('Extracting Faster-Whisper-XXL Engine'), 'SettingsModal must have extracting progress label in English');
  console.log('✓ SettingsModal correctly includes in-app engine installer and progress handling.');

  // 5. WhisperStudio In-App Engine Download Invariants
  console.log('Testing WhisperStudio.tsx renders in-app engine installer banner with English UI...');
  const whisperStudioSrc = fs.readFileSync(path.join(__dirname, 'src', 'components', 'WhisperStudio', 'WhisperStudio.tsx'), 'utf-8');
  assert(whisperStudioSrc.includes('handleDownloadEngine'), 'WhisperStudio must have handleDownloadEngine');
  assert(whisperStudioSrc.includes('handleCancelEngineDownload'), 'WhisperStudio must have handleCancelEngineDownload');
  assert(whisperStudioSrc.includes('Install Engine in Kaiko'), 'WhisperStudio must have "Install Engine in Kaiko" button');
  assert(whisperStudioSrc.includes('Faster-Whisper Engine Not Installed'), 'WhisperStudio must have missing engine title in English');
  assert(whisperStudioSrc.includes('onWhisperEngineDownloadProgress'), 'WhisperStudio must listen to onWhisperEngineDownloadProgress');
  console.log('✓ WhisperStudio correctly includes in-app engine installer banner.');

  // 6. Bundled 7-Zip & Archive Extractor Invariants
  console.log('Testing 7-Zip bundling and resolveArchiveExtractor invariants...');
  const downloaderSrc = fs.readFileSync(path.join(__dirname, 'electron', 'whisperEngineDownloader.ts'), 'utf-8');
  assert(downloaderSrc.includes('resolveArchiveExtractor'), 'whisperEngineDownloader must include resolveArchiveExtractor');
  assert(downloaderSrc.includes('resourcesPath'), 'resolveArchiveExtractor must check process.resourcesPath');
  assert(downloaderSrc.includes('7z.exe'), 'resolveArchiveExtractor must prioritize 7z.exe');

  const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
  const extraRes = pkgJson.build && pkgJson.build.extraResources ? pkgJson.build.extraResources : [];
  assert(extraRes.some((r) => r.from === 'bin/7z.exe'), 'package.json extraResources must bundle bin/7z.exe');
  assert(extraRes.some((r) => r.from === 'bin/7z.dll'), 'package.json extraResources must bundle bin/7z.dll');
  assert(fs.existsSync(path.join(__dirname, 'bin', '7z.exe')), 'bin/7z.exe must exist in project bin directory');
  assert(fs.existsSync(path.join(__dirname, 'bin', '7z.dll')), 'bin/7z.dll must exist in project bin directory');
  console.log('✓ 7-Zip binaries and extraResources invariants verified.');

  console.log('\nAll Faster-Whisper-XXL in-app downloader tests passed successfully!');
}

runTests();
