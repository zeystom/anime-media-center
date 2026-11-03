import assert from 'assert';

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
}

runTests();
