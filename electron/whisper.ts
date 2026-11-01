import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { BrowserWindow } from 'electron';
import { WhisperLogMessage, WhisperQueueItem } from './types';
import { storage } from './storage';

export class WhisperManager {
  private activeProcess: ChildProcess | null = null;
  private queue: WhisperQueueItem[] = [];
  private isRunning: boolean = false;
  private cancelled: boolean = false;
  private currentItem: WhisperQueueItem | null = null;

  async startQueue(
    folderPath: string,
    audioTrackNum: number,
    skipExistingSrt: boolean,
    mainWindow: BrowserWindow
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isRunning) {
      return { success: false, error: 'Whisper task is already in progress' };
    }

    const settings = storage.getSettings();
    const whisperExe = settings.whisperPath;

    if (!fs.existsSync(whisperExe)) {
      return { success: false, error: `Whisper binary not found at: ${whisperExe}` };
    }

    if (!fs.existsSync(folderPath)) {
      return { success: false, error: `Folder not found: ${folderPath}` };
    }

    // Scan folder for .mkv files
    const entries = fs.readdirSync(folderPath);
    const mkvFiles = entries
      .filter((file) => file.toLowerCase().endsWith('.mkv'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    if (mkvFiles.length === 0) {
      return { success: false, error: 'No .mkv video files found in selected folder' };
    }

    this.queue = [];
    this.cancelled = false;
    this.isRunning = true;

    for (const file of mkvFiles) {
      const fullPath = path.join(folderPath, file);
      const baseName = path.parse(file).name;
      const srtPath = path.join(folderPath, `${baseName}.srt`);
      const hasSrt = fs.existsSync(srtPath);

      if (skipExistingSrt && hasSrt) {
        this.queue.push({
          id: file,
          filePath: fullPath,
          fileName: file,
          status: 'skipped',
          progress: 100,
        });
      } else {
        this.queue.push({
          id: file,
          filePath: fullPath,
          fileName: file,
          status: 'pending',
          progress: 0,
        });
      }
    }

    this.broadcastProgress(mainWindow);
    this.sendLog(mainWindow, 'info', `Initialized Whisper queue with ${this.queue.length} files (${this.queue.filter(q => q.status === 'skipped').length} skipped)`);

    // Run sequentially in background
    (async () => {
      let completedCount = 0;
      let failedCount = 0;

      for (let i = 0; i < this.queue.length; i++) {
        if (this.cancelled) {
          this.sendLog(mainWindow, 'info', 'Whisper queue cancelled by user.');
          break;
        }

        const item = this.queue[i];
        if (item.status === 'skipped') continue;

        item.status = 'processing';
        this.currentItem = item;
        this.broadcastProgress(mainWindow);

        this.sendLog(mainWindow, 'info', `[${i + 1}/${this.queue.length}] Starting: ${item.fileName} (Audio Track: ${audioTrackNum})`);

        try {
          await this.processSingleFile(item, whisperExe, folderPath, audioTrackNum, mainWindow);
          if (this.cancelled) {
            item.status = 'failed';
            item.error = 'Cancelled';
            break;
          }
          item.status = 'completed';
          item.progress = 100;
          completedCount++;
          this.sendLog(mainWindow, 'success', `[${i + 1}/${this.queue.length}] Completed: ${item.fileName}`);
        } catch (err: any) {
          item.status = 'failed';
          item.error = err.message || 'Unknown error';
          failedCount++;
          this.sendLog(mainWindow, 'error', `[${i + 1}/${this.queue.length}] Failed ${item.fileName}: ${err.message}`);
        }

        this.broadcastProgress(mainWindow);
      }

      this.isRunning = false;
      this.currentItem = null;
      this.activeProcess = null;
      mainWindow.webContents.send('whisper-done', { completedCount, failedCount });
      this.sendLog(mainWindow, 'info', `Batch processing finished. ${completedCount} generated, ${failedCount} errors.`);
    })();

    return { success: true };
  }

  cancel(): void {
    this.cancelled = true;
    if (this.activeProcess) {
      try {
        this.activeProcess.kill('SIGKILL');
      } catch {}
      this.activeProcess = null;
    }
    this.isRunning = false;
  }

  private processSingleFile(
    item: WhisperQueueItem,
    whisperExe: string,
    folderPath: string,
    audioTrackNum: number,
    mainWindow: BrowserWindow
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Note: Use <folder_path>. with a trailing dot to prevent Windows backslash quote escaping bugs
      const sanitizedOutDir = folderPath.endsWith('\\') || folderPath.endsWith('/')
        ? `${folderPath}.`
        : `${folderPath}\\.`;

      const args = [
        item.filePath,
        '--model', 'large-v3-turbo',
        '--language', 'en',
        '--ff_track', audioTrackNum.toString(),
        '--ff_sync',
        '--sentence',
        '--max_line_count', '2',
        '--max_line_width', '42',
        '--output_format', 'srt',
        '--output_dir', sanitizedOutDir,
      ];

      this.sendLog(mainWindow, 'info', `Executing: "${path.basename(whisperExe)}" ${args.slice(1).join(' ')}`);

      const child = spawn(whisperExe, args, { windowsHide: true });
      this.activeProcess = child;

      child.stdout.on('data', (data) => {
        const text = data.toString();
        this.parseProgress(item, text);
        this.sendLog(mainWindow, 'stdout', text);
        this.broadcastProgress(mainWindow);
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        this.parseProgress(item, text);
        this.sendLog(mainWindow, 'stderr', text);
        this.broadcastProgress(mainWindow);
      });

      child.on('close', (code) => {
        this.activeProcess = null;
        if (this.cancelled) {
          reject(new Error('Process cancelled'));
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Whisper exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        this.activeProcess = null;
        reject(err);
      });
    });
  }

  private parseProgress(item: WhisperQueueItem, output: string): void {
    // Look for percentage patterns like "45%" or "[00:12<01:20, 2.50it/s]"
    const pctMatch = output.match(/(\d{1,3})%/);
    if (pctMatch) {
      item.progress = Math.min(100, Math.max(0, parseInt(pctMatch[1], 10)));
    }

    const speedMatch = output.match(/([\d.]+\s*(?:it\/s|s\/it|frames\/s))/i);
    if (speedMatch) {
      item.speed = speedMatch[1];
    }
  }

  private sendLog(mainWindow: BrowserWindow, type: WhisperLogMessage['type'], text: string) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('whisper-log', {
        type,
        text,
        timestamp: Date.now(),
      } as WhisperLogMessage);
    }
  }

  private broadcastProgress(mainWindow: BrowserWindow) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('whisper-progress', {
        currentFile: this.currentItem ? this.currentItem.fileName : '',
        progress: this.currentItem ? this.currentItem.progress : 0,
        queue: this.queue,
      });
    }
  }
}

export const whisperManager = new WhisperManager();
