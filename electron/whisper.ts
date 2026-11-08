import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import { resolveUserDataPath } from './userDataPath';
import { WhisperLogMessage, WhisperQueueItem, WhisperStatus } from './types';
import { storage } from './storage';
import { probeMkv, invalidateProbeCache } from './ffmpeg';
import { hasWhisperSubtitle } from './subtitles';

export class WhisperManager {
  private activeProcess: ChildProcess | null = null;
  private queue: WhisperQueueItem[] = [];
  private isRunning: boolean = false;
  private cancelled: boolean = false;
  private currentItem: WhisperQueueItem | null = null;
  private currentFolder: string = '';
  private currentAudioTrackNum: number = 1;
  private logsBuffer: WhisperLogMessage[] = [];
  private currentRunId: string | null = null;
  private runPromise: Promise<void> | null = null;

  getStatus(): WhisperStatus {
    return {
      isRunning: this.isRunning,
      folderPath: this.currentFolder,
      currentFile: this.currentItem ? this.currentItem.fileName : '',
      progress: this.currentItem ? this.currentItem.progress : 0,
      queue: this.queue,
      logs: this.logsBuffer.slice(-250),
    };
  }

  async startQueue(
    folderPath: string,
    audioTrackNum: number,
    skipExistingSrt: boolean,
    mainWindow: BrowserWindow
  ): Promise<{ success: boolean; error?: string }> {
    if (this.isRunning || this.runPromise) {
      return { success: false, error: 'Whisper task is already in progress' };
    }

    const settings = storage.getSettings();
    const whisperExe = settings.whisperPath;

    if (!whisperExe || !fs.existsSync(whisperExe)) {
      return { success: false, error: `Whisper binary not found at: ${whisperExe || '(not configured)'}` };
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

    const runId = Date.now().toString();
    this.currentRunId = runId;
    this.currentFolder = folderPath;
    this.currentAudioTrackNum = audioTrackNum;
    this.queue = [];
    this.cancelled = false;
    this.isRunning = true;

    for (const file of mkvFiles) {
      const fullPath = path.join(folderPath, file);
      const hasWhisper = hasWhisperSubtitle(fullPath);

      if (skipExistingSrt && hasWhisper) {
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
    this.sendLog(
      mainWindow,
      'info',
      `Initialized Whisper queue with ${this.queue.length} files (${
        this.queue.filter((q) => q.status === 'skipped').length
      } skipped)`
    );

    const pendingItems = this.queue.filter((q) => q.status === 'pending');
    if (pendingItems.length === 0) {
      this.isRunning = false;
      this.currentRunId = null;
      this.broadcastProgress(mainWindow);
      this.sendLog(mainWindow, 'info', 'Nothing to do: all episodes already have .whisper.srt');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('whisper-done', { completedCount: 0, failedCount: 0 });
      }
      return { success: true };
    }

    // Run sequentially in background with promise guard
    const run = (async () => {
      await Promise.resolve();
      let completedCount = 0;
      let failedCount = 0;

      try {
        for (let i = 0; i < this.queue.length; i++) {
          if (this.cancelled || this.currentRunId !== runId) {
            this.sendLog(mainWindow, 'info', 'Whisper queue cancelled.');
            break;
          }

          const item = this.queue[i];
          if (item.status === 'skipped') continue;

          item.status = 'processing';
          this.currentItem = item;
          this.broadcastProgress(mainWindow);

          // 1.5 Dynamic English audio track determination per file
          let effectiveTrack = audioTrackNum;
          try {
            const meta = await probeMkv(item.filePath, settings.ffmpegPath);
            if (meta.duration > 0) {
              item.duration = meta.duration;
            }
            const engTrack = meta.audioTracks.find(
              (t) => t.language === 'eng' || t.language === 'en' || (t.title && /english/i.test(t.title))
            );
            if (engTrack) {
              effectiveTrack = engTrack.audioIndex + 1; // 1-based index (1..6)
            } else if (audioTrackNum >= 1 && audioTrackNum <= meta.audioTracks.length) {
              effectiveTrack = audioTrackNum;
            }
          } catch (e) {
            // Duration and audio track fallback to defaults
          }

          // Check if file is empty or an incomplete pre-allocated sparse torrent file
          let isDownloadingOrIncomplete = false;
          try {
            const st = fs.statSync(item.filePath);
            if (st.size === 0) {
              isDownloadingOrIncomplete = true;
            } else if (st.size > 5 * 1024 * 1024) {
              const tailSize = Math.min(16384, st.size);
              const buf = Buffer.alloc(tailSize);
              // Safe read-only ('r') open that doesn't conflict with seeding or Read-Only flags
              const fd = fs.openSync(item.filePath, 'r');
              try {
                fs.readSync(fd, buf, 0, tailSize, st.size - tailSize);
              } finally {
                fs.closeSync(fd);
              }
              let allZeros = true;
              for (let b = 0; b < tailSize; b++) {
                if (buf[b] !== 0) {
                  allZeros = false;
                  break;
                }
              }
              if (allZeros) isDownloadingOrIncomplete = true;
            }
          } catch (e: any) {
            // Unable to read file
          }

          if (isDownloadingOrIncomplete) {
            item.status = 'failed';
            item.error = 'File is still downloading or incomplete (sparse zero fill)';
            failedCount++;
            this.sendLog(mainWindow, 'error', `[${i + 1}/${this.queue.length}] ${item.fileName}: ${item.error}`);
            this.broadcastProgress(mainWindow);
            continue;
          }

          if (effectiveTrack < 1) {
            effectiveTrack = 1;
          }

          if (effectiveTrack > 6) {
            this.sendLog(
              mainWindow,
              'info',
              `[${i + 1}/${this.queue.length}] Audio track (${effectiveTrack}) exceeds Faster-Whisper limit (6). Will extract via FFmpeg before transcribing.`
            );
          }

          this.sendLog(
            mainWindow,
            'info',
            `[${i + 1}/${this.queue.length}] Starting: ${item.fileName} (Audio Track: ${effectiveTrack})`
          );

          try {
            await this.processSingleFile(item, whisperExe, folderPath, effectiveTrack, runId, mainWindow);

            if (this.cancelled || this.currentRunId !== runId) {
              item.status = 'cancelled';
              item.error = 'Cancelled by user';
              break;
            }

            item.status = 'completed';
            item.progress = 100;
            completedCount++;
            this.sendLog(mainWindow, 'success', `[${i + 1}/${this.queue.length}] Completed: ${item.fileName}`);
          } catch (err: any) {
            if (this.cancelled || this.currentRunId !== runId) {
              item.status = 'cancelled';
              item.error = 'Cancelled by user';
              break;
            }

            item.status = 'failed';
            item.error = err.message || 'Unknown error';
            failedCount++;
            this.sendLog(mainWindow, 'error', `[${i + 1}/${this.queue.length}] Failed ${item.fileName}: ${err.message}`);
            if (err.message && /invalid model|unknown model|not a valid model|is not one of/i.test(err.message)) {
              this.sendLog(mainWindow, 'error', 'Update Faster-Whisper-XXL to r193.1 or newer.');
            }
          }

          this.broadcastProgress(mainWindow);
        }
      } finally {
        if (this.currentRunId === runId) {
          this.isRunning = false;
          this.currentItem = null;
          this.activeProcess = null;
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('whisper-done', { completedCount, failedCount });
        }
        this.sendLog(
          mainWindow,
          'info',
          `Batch processing finished. ${completedCount} generated, ${failedCount} errors.`
        );
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

  cancel(): void {
    this.cancelled = true;
    const proc = this.activeProcess;
    if (proc && proc.pid) {
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/PID', proc.pid.toString(), '/T', '/F'], { windowsHide: true });
        } catch {}
      }
      try {
        proc.kill('SIGKILL');
      } catch {}
      this.activeProcess = null;
    }
    if (this.currentItem) {
      this.currentItem.status = 'cancelled';
      this.currentItem.error = 'Cancelled by user';
    }
  }

  private async extractAudioTrack(
    filePath: string,
    audioIndex: number,
    outputPath: string,
    ffmpegPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-hide_banner',
        '-y',
        '-i', filePath,
        '-map', `0:a:${audioIndex}`,
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        outputPath,
      ];
      const child = spawn(ffmpegPath, args, { windowsHide: true });
      this.activeProcess = child;
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.on('close', (code) => {
        this.activeProcess = null;
        if (code === 0 && fs.existsSync(outputPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg audio extraction failed (code ${code}): ${stderr.slice(-200)}`));
        }
      });
      child.on('error', (err) => {
        this.activeProcess = null;
        reject(err);
      });
    });
  }

  private async processSingleFile(
    item: WhisperQueueItem,
    whisperExe: string,
    folderPath: string,
    audioTrackNum: number,
    runId: string,
    mainWindow: BrowserWindow
  ): Promise<void> {
    const fileId = path.parse(item.filePath).name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const tmpDir = path.join(resolveUserDataPath(), 'whisper_tmp', runId, fileId);

    fs.mkdirSync(tmpDir, { recursive: true });

    const stderrLines: string[] = [];

    try {
      const baseName = path.parse(item.filePath).name;
      let inputPath = item.filePath;
      const needExtract = audioTrackNum > 6;

      if (needExtract) {
        const settings = storage.getSettings();
        const extractedWav = path.join(tmpDir, `${baseName}.wav`);
        this.sendLog(mainWindow, 'info', `Extracting audio stream index ${audioTrackNum - 1} via FFmpeg...`);
        await this.extractAudioTrack(item.filePath, audioTrackNum - 1, extractedWav, settings.ffmpegPath);
        inputPath = extractedWav;
      }

      await new Promise<void>((resolve, reject) => {
        const args = [
          inputPath,
          '--model',
          'large-v3-turbo',
          '--task',
          'transcribe',
          '--language',
          'en',
        ];

        if (!needExtract) {
          args.push('--ff_track', audioTrackNum.toString(), '--ff_sync');
        }

        args.push(
          '--sentence',
          '--max_line_width',
          '46',
          '--max_line_count',
          '2',
          '--max_comma_cent',
          '70',
          '--min_dist_to_end',
          '8',
          '--output_format',
          'srt',
          '--output_dir',
          tmpDir
        );

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
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) {
              stderrLines.push(trimmed);
              if (stderrLines.length > 20) stderrLines.shift();
            }
          }
          this.parseProgress(item, text);
          this.sendLog(mainWindow, 'stderr', text);
          this.broadcastProgress(mainWindow);
        });

        child.on('close', (code) => {
          this.activeProcess = null;
          if (this.cancelled || this.currentRunId !== runId) {
            reject(new Error('Process cancelled'));
          } else if (code === 0) {
            resolve();
          } else {
            const recentStderr = stderrLines.slice(-10).join('\n');
            const detailMsg = recentStderr
              ? `Whisper exited with code ${code}:\n${recentStderr}`
              : `Whisper exited with code ${code}`;
            reject(new Error(detailMsg));
          }
        });

        child.on('error', (err) => {
          this.activeProcess = null;
          reject(err);
        });
      });

      // Verification: ensure output .srt exists and has size > 0
      const producedSrt = path.join(tmpDir, `${baseName}.srt`);

      if (!fs.existsSync(producedSrt) || fs.statSync(producedSrt).size === 0) {
        throw new Error('No subtitle file produced (no speech detected?)');
      }

      // Move atomically to <folder>/<base>.whisper.srt
      const destSrt = path.join(folderPath, `${baseName}.whisper.srt`);
      try {
        fs.renameSync(producedSrt, destSrt);
      } catch {
        fs.copyFileSync(producedSrt, destSrt);
        try {
          fs.unlinkSync(producedSrt);
        } catch {}
      }

      // Invalidate probe cache so media player discovers the new subtitle immediately
      invalidateProbeCache(item.filePath);
    } finally {
      // Clean up temporary output directory
      try {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch {}
    }
  }

  private parseProgress(item: WhisperQueueItem, output: string): void {
    // 1. Check if model is currently downloading line-by-line
    const lines = output.split(/[\r\n]+/);
    const downloadRegex =
      /huggingface|hf_hub|\bdownloading\b|model\.bin|\.safetensors|\d+(?:\.\d+)?\s*[KMG]i?B?\s*\/\s*\d+(?:\.\d+)?\s*[KMG]/i;

    let isDownloading = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && downloadRegex.test(trimmed)) {
        isDownloading = true;
        break;
      }
    }

    if (isDownloading) {
      item.speed = 'Downloading model...';
      return;
    }

    // Reset download speed status when download completes and transcription starts
    if (item.speed === 'Downloading model...') {
      item.speed = undefined;
    }

    // 2. Direct percentage pattern (e.g. "45%" or " 45%|")
    const pctMatch = output.match(/(\d{1,3})%/);
    if (pctMatch) {
      const pct = Math.min(100, Math.max(0, parseInt(pctMatch[1], 10)));
      item.progress = Math.max(item.progress, pct);
    }

    // 3. Parse faster-whisper-xxl timestamp intervals: [15:23.320 --> 15:24.640]
    const matches = Array.from(
      output.matchAll(
        /\[(?:(?:\d+:)?\d+:\d+(?:\.\d+)?)\s*-->\s*(?:(?:(\d+):)?(\d+):(\d+(?:\.\d+)?))\]/g
      )
    );
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const hrs = lastMatch[1] ? parseInt(lastMatch[1], 10) : 0;
      const mins = parseInt(lastMatch[2], 10) || 0;
      const secs = parseFloat(lastMatch[3]) || 0;
      const currentSeconds = hrs * 3600 + mins * 60 + secs;

      if (item.duration && item.duration > 0) {
        const pct = Math.min(99, Math.round((currentSeconds / item.duration) * 100));
        item.progress = Math.max(item.progress, pct);
      }
    }

    // 4. Iteration speed
    const speedMatch = output.match(/([\d.]+\s*(?:it\/s|s\/it|frames\/s))/i);
    if (speedMatch) {
      item.speed = speedMatch[1];
    }
  }

  private sendLog(mainWindow: BrowserWindow, type: WhisperLogMessage['type'], text: string) {
    const logMsg: WhisperLogMessage = {
      type,
      text,
      timestamp: Date.now(),
    };
    this.logsBuffer.push(logMsg);
    if (this.logsBuffer.length > 300) {
      this.logsBuffer.shift();
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('whisper-log', logMsg);
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
