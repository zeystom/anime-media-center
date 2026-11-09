import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow } from 'electron';
import { resolveUserDataPath } from './userDataPath';
import { WhisperLogMessage, WhisperQueueItem, WhisperStatus, WhisperOptions, WhisperLiveCue } from './types';
import { storage } from './storage';
import { probeMkv, invalidateProbeCache } from './ffmpeg';
import { hasWhisperSubtitle } from './subtitles';

/**
 * Detects whether a subtitle text contains Japanese characters (Hiragana, Katakana, or Kanji).
 * Used to filter out Japanese opening/ending song lyrics when transcribing English dubs.
 */
export function containsJapaneseLyrics(text: string): boolean {
  if (!text) return false;
  // Count Japanese kana characters (Hiragana and Katakana)
  const kanaMatches = text.match(/[\u3040-\u309f\u30a0-\u30ff]/gu);
  const kanaCount = kanaMatches ? kanaMatches.length : 0;

  // Count CJK Kanji
  const cjkMatches = text.match(/[\u4e00-\u9faf]/gu);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  const totalJapaneseChars = kanaCount + cjkCount;
  if (totalJapaneseChars === 0) return false;

  const latinMatches = text.match(/[a-zA-Z]/g);
  const latinCount = latinMatches ? latinMatches.length : 0;

  // If there are Japanese kana or kanji, and either:
  // 1. There are barely any Latin letters (< 5) while Japanese chars exist -> Japanese song/lyrics
  // 2. Japanese characters exceed Latin letters -> Japanese song
  // 3. Significant kana present (>= 3 kana characters) -> song lyrics
  if (latinCount < 5 && totalJapaneseChars >= 1) return true;
  if (totalJapaneseChars > latinCount) return true;
  if (kanaCount >= 3) return true;

  return false;
}

/**
 * Removes stray Japanese kana/kanji from English text lines.
 */
export function cleanJapaneseArtifacts(text: string): string {
  if (!text) return text;
  return text.replace(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/gu, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Normalizes and cleans generated SRT subtitles:
 * 1. Merges isolated single-word fragments caused by mid-sentence punctuation/pauses.
 * 2. Removes empty cues or trailing lonely hyphens/music note artifacts.
 * 3. Formats sequential 1-based subtitle indices and standardized timecodes.
 * 4. Filters out Japanese lyrics / kanji / kana when transcribing English subtitles.
 */
export function cleanSubtitleSrt(srtContent: string, isEnglish: boolean = true): string {
  if (!srtContent || typeof srtContent !== 'string') return srtContent;

  try {
    const rawBlocks = srtContent.replace(/\r\n/g, '\n').split(/\n\s*\n/);
    interface CueBlock {
      start: string;
      end: string;
      startMs: number;
      endMs: number;
      text: string;
    }

    function timecodeToMs(tc: string): number {
      const match = tc.match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
      if (!match) return 0;
      const h = match[1] ? parseInt(match[1], 10) : 0;
      const m = parseInt(match[2], 10) || 0;
      const s = parseInt(match[3], 10) || 0;
      const ms = parseInt(match[4].padEnd(3, '0').slice(0, 3), 10) || 0;
      return h * 3600000 + m * 60000 + s * 1000 + ms;
    }

    const cues: CueBlock[] = [];

    for (const raw of rawBlocks) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const lines = trimmed.split('\n');
      if (lines.length < 2) continue;

      let timeLineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('-->')) {
          timeLineIdx = i;
          break;
        }
      }
      if (timeLineIdx === -1) continue;

      const [startStr, endStr] = lines[timeLineIdx].split('-->').map((s) => s.trim());
      const textLines = lines.slice(timeLineIdx + 1).map((l) => l.trim()).filter(Boolean);
      let text = textLines.join('\n');

      // Strip lonely music notes or brackets
      text = text.replace(/^[♪♫#\s*]+$/g, '').trim();
      if (!text) continue;

      // Filter out Japanese song lyrics/kanji in English subtitles
      if (isEnglish) {
        if (containsJapaneseLyrics(text)) {
          continue;
        }
        text = cleanJapaneseArtifacts(text);
        if (!text) continue;
      }

      cues.push({
        start: startStr,
        end: endStr,
        startMs: timecodeToMs(startStr),
        endMs: timecodeToMs(endStr),
        text,
      });
    }

    if (cues.length <= 1) return srtContent;

    // Merge isolated 1-word orphan fragments
    const merged: CueBlock[] = [];
    for (let i = 0; i < cues.length; i++) {
      const cur = cues[i];
      const words = cur.text.trim().split(/\s+/);
      const isSingleWord = words.length === 1 && cur.text.length < 15;

      if (isSingleWord && i + 1 < cues.length) {
        const next = cues[i + 1];
        const gap = next.startMs - cur.endMs;
        const curEndsSentence = /[.!?…]$/.test(cur.text.trim());

        // Prepend orphan word if next cue is very close (< 600ms) and cur does not end sentence
        if (gap >= 0 && gap < 600 && !curEndsSentence) {
          next.text = `${cur.text} ${next.text}`;
          next.start = cur.start;
          next.startMs = cur.startMs;
          continue;
        }
      }

      if (isSingleWord && merged.length > 0) {
        const prev = merged[merged.length - 1];
        const gap = cur.startMs - prev.endMs;
        const prevEndsSentence = /[.!?…]$/.test(prev.text.trim());

        // Append orphan word if close to previous cue (< 400ms) and prev does not end sentence
        if (gap >= 0 && gap < 400 && !prevEndsSentence) {
          prev.text = `${prev.text} ${cur.text}`;
          prev.end = cur.end;
          prev.endMs = cur.endMs;
          continue;
        }
      }

      merged.push(cur);
    }

    let out = '';
    for (let i = 0; i < merged.length; i++) {
      const c = merged[i];
      out += `${i + 1}\n${c.start} --> ${c.end}\n${c.text}\n\n`;
    }

    return out.trim() ? out : srtContent;
  } catch {
    return srtContent;
  }
}

export class WhisperManager {
  private activeProcess: ChildProcess | null = null;
  private queue: WhisperQueueItem[] = [];
  private isRunning: boolean = false;
  private cancelled: boolean = false;
  private currentItem: WhisperQueueItem | null = null;
  private currentFolder: string = '';
  private currentAudioTrackNum: number = 1;
  private logsBuffer: WhisperLogMessage[] = [];
  private liveCues: WhisperLiveCue[] = [];
  private currentRunId: string | null = null;
  private runPromise: Promise<void> | null = null;
  private activeOptions: WhisperOptions = {};

  getStatus(): WhisperStatus {
    return {
      isRunning: this.isRunning,
      folderPath: this.currentFolder,
      currentFile: this.currentItem ? this.currentItem.fileName : '',
      progress: this.currentItem ? this.currentItem.progress : 0,
      speed: this.currentItem?.speed,
      queue: this.queue,
      logs: this.logsBuffer.slice(-250),
      liveCues: this.liveCues,
    };
  }

  async startQueue(
    folderPath: string,
    audioTrackNum: number,
    skipExistingSrt: boolean,
    mainWindow: BrowserWindow,
    options?: Partial<WhisperOptions>
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
    this.activeOptions = options || {};
    this.queue = [];
    this.liveCues = [];
    this.cancelled = false;
    this.isRunning = true;

    const selectedSet = options?.selectedFilePaths && options.selectedFilePaths.length > 0
      ? new Set(options.selectedFilePaths.map((p) => path.resolve(p).toLowerCase()))
      : null;

    for (const file of mkvFiles) {
      const fullPath = path.join(folderPath, file);
      const isSelected = !selectedSet || selectedSet.has(path.resolve(fullPath).toLowerCase());
      if (!isSelected) continue;

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
          let isTrackSurround = false;
          try {
            const meta = await probeMkv(item.filePath, settings.ffmpegPath);
            if (meta.duration > 0) {
              item.duration = meta.duration;
            }
            const engTrack = meta.audioTracks.find(
              (t) => t.language === 'eng' || t.language === 'en' || (t.title && /english/i.test(t.title))
            );
            const targetTrack = engTrack || (audioTrackNum >= 1 && audioTrackNum <= meta.audioTracks.length ? meta.audioTracks[audioTrackNum - 1] : undefined);
            if (targetTrack) {
              effectiveTrack = targetTrack.audioIndex + 1; // 1-based index (1..6)
              isTrackSurround = Boolean(targetTrack.isSurround || (targetTrack.channels && targetTrack.channels > 2));
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
            await this.processSingleFile(item, whisperExe, folderPath, effectiveTrack, runId, mainWindow, isTrackSurround);

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
    mainWindow: BrowserWindow,
    isTrackSurround = false
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
        this.liveCues = [];
        const opts = this.activeOptions;
        const preset = opts.preset || 'anime';

        // Tuned smart defaults by preset
        let defaultVadThreshold = 0.35;
        let defaultVadMinDuration = 150;
        let defaultVadPad = 900;
        let defaultNoSpeech = 0.6;
        let defaultCompressionRatio = 2.8;
        let defaultPrompt = 'Anime dialogue, conversational speech, clean subtitles.';
        let defaultSpeechNorm = false;

        if (preset === 'bgm') {
          defaultVadThreshold = 0.28;
          defaultVadMinDuration = 150;
          defaultVadPad = 1000;
          defaultNoSpeech = 0.7;
          defaultCompressionRatio = 2.8;
          defaultPrompt = 'Anime dialogue, spoken conversation over music, no singing, no lyrics.';
          defaultSpeechNorm = true;
        } else if (preset === 'fast') {
          defaultVadThreshold = 0.45;
          defaultVadMinDuration = 250;
          defaultVadPad = 900;
          defaultNoSpeech = 0.6;
          defaultCompressionRatio = 2.4;
          defaultPrompt = 'Clean dialogue and conversations.';
        }

        const model = opts.model || 'large-v3-turbo';
        const task = opts.task || 'transcribe';
        const language = opts.language || 'en';
        const condition = opts.conditionOnPreviousText ?? false;
        const vadThreshold = opts.vadThreshold ?? defaultVadThreshold;
        const vadMinDuration = opts.vadMinSpeechDurationMs ?? defaultVadMinDuration;
        const vadPad = opts.vadSpeechPadMs ?? defaultVadPad;
        const compressionRatio = opts.compressionRatioThreshold ?? defaultCompressionRatio;
        const noSpeech = opts.noSpeechThreshold ?? defaultNoSpeech;
        const prompt = opts.initialPrompt !== undefined ? opts.initialPrompt : defaultPrompt;
        const maxLineWidth = opts.maxLineWidth ?? 46;
        const maxLineCount = opts.maxLineCount ?? 2;
        const maxCommaCent = opts.maxCommaCent ?? 100;
        const minDistToEnd = opts.minDistToEnd ?? 8;
        const speechNorm = opts.speechNorm ?? defaultSpeechNorm;

        const args = [
          inputPath,
          '--model', model,
          '--task', task,
          '--language', language,
          '--vad_filter', 'True',
          '--vad_threshold', vadThreshold.toString(),
          '--vad_min_speech_duration_ms', vadMinDuration.toString(),
          '--vad_speech_pad_ms', vadPad.toString(),
          '--condition_on_previous_text', condition ? 'True' : 'False',
          '--compression_ratio_threshold', compressionRatio.toString(),
          '--no_speech_threshold', noSpeech.toString(),
        ];

        if (prompt && prompt.trim() && prompt !== 'None') {
          args.push('--initial_prompt', prompt.trim());
        }

        args.push(
          '--sentence',
          '--max_line_width', maxLineWidth.toString(),
          '--max_line_count', maxLineCount.toString(),
          '--max_comma_cent', maxCommaCent.toString(),
          '--min_dist_to_end', minDistToEnd.toString(),
          '--output_format', 'srt',
          '--output_dir', tmpDir
        );

        if (speechNorm) {
          args.push('--ff_speechnorm');
        }

        if (opts.channelMode === 'fc') {
          if (isTrackSurround) {
            args.push('--ff_fc');
            this.sendLog(mainWindow, 'info', 'Surround audio (5.1/7.1) detected: extracting Front Center (FC) dialogue channel');
          } else {
            this.sendLog(mainWindow, 'info', 'Stereo/mono audio detected: skipped --ff_fc to prevent muting dialogue');
          }
        }

        if (!needExtract) {
          args.push('--ff_track', audioTrackNum.toString(), '--ff_sync');
        }

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

      // Clean up isolated single words, Japanese song lyrics, and normalize SRT
      try {
        const rawSrt = fs.readFileSync(producedSrt, 'utf-8');
        const isEnglish = (this.activeOptions.language || 'en') === 'en';
        const cleaned = cleanSubtitleSrt(rawSrt, isEnglish);
        fs.writeFileSync(producedSrt, cleaned, 'utf-8');
      } catch {}

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

    // 5. Parse live recognized subtitle cues for native UI streaming
    const cueMatches = Array.from(
      output.matchAll(
        /\[((?:\d+:)?\d+:\d+(?:\.\d+)?)\s*-->\s*((?:\d+:)?\d+:\d+(?:\.\d+)?)]\s*(.*)/g
      )
    );
    for (const cm of cueMatches) {
      const start = cm[1].trim();
      const end = cm[2].trim();
      const text = cm[3].trim();
      if (text) {
        const isEnglish = (this.activeOptions.language || 'en') === 'en';
        if (isEnglish && containsJapaneseLyrics(text)) {
          continue;
        }
        const cleanedText = isEnglish ? cleanJapaneseArtifacts(text) : text;
        if (!cleanedText) continue;

        const cue: WhisperLiveCue = {
          id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          start,
          end,
          text: cleanedText,
          timestamp: Date.now(),
        };
        this.liveCues.push(cue);
        if (this.liveCues.length > 30) {
          this.liveCues.shift();
        }
        if (!item.liveCues) item.liveCues = [];
        item.liveCues.push(cue);
        if (item.liveCues.length > 30) {
          item.liveCues.shift();
        }
      }
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
        speed: this.currentItem?.speed,
        queue: this.queue,
        liveCues: this.liveCues,
      });
    }
  }
}

export const whisperManager = new WhisperManager();
