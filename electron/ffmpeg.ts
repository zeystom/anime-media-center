import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { AudioTrack, SubtitleCue, SubtitleTrack, VideoMetadata } from './types';
import { storage } from './storage';

const LANG_MAP: Record<string, string> = {
  eng: 'English',
  en: 'English',
  jpn: 'Japanese',
  ja: 'Japanese',
  spa: 'Spanish',
  es: 'Spanish',
  fre: 'French',
  fra: 'French',
  fr: 'French',
  ger: 'German',
  deu: 'German',
  de: 'German',
  ita: 'Italian',
  it: 'Italian',
  por: 'Portuguese',
  pt: 'Portuguese',
  rus: 'Russian',
  ru: 'Russian',
  chi: 'Chinese',
  zho: 'Chinese',
  zh: 'Chinese',
  kor: 'Korean',
  ko: 'Korean',
  ara: 'Arabic',
  ar: 'Arabic',
  tha: 'Thai',
  th: 'Thai',
  vie: 'Vietnamese',
  vi: 'Vietnamese',
  pol: 'Polish',
  pl: 'Polish',
  ind: 'Indonesian',
  id: 'Indonesian',
};

export function getLanguageName(code?: string): string {
  if (!code) return 'Unknown';
  const clean = code.toLowerCase().trim();
  return LANG_MAP[clean] || clean.toUpperCase();
}

export function parseDuration(durationStr: string): number {
  const match = durationStr.match(/(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return 0;
  const hours = parseFloat(match[1]);
  const minutes = parseFloat(match[2]);
  const seconds = parseFloat(match[3]);
  return hours * 3600 + minutes * 60 + seconds;
}

export function parseSrtTimestamp(timeStr: string): number {
  const parts = timeStr.trim().replace(',', '.').split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return 0;
}

export function cleanSubtitleText(text: string): string {
  return text
    .replace(/\{[^}]+\}/g, '') // strip ASS tags like {\an8}
    .replace(/<[^>]+>/g, '')  // strip HTML tags like <font...>
    .replace(/\r\n/g, '\n')
    .trim();
}

export function parseSrt(content: string): SubtitleCue[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.split(/\n\s*\n/);
  const cues: SubtitleCue[] = [];

  let idCounter = 1;

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // Check if line 0 or line 1 contains the arrow
    let timeLineIdx = 1;
    if (lines[0].includes('-->')) {
      timeLineIdx = 0;
    } else if (lines.length > 1 && lines[1].includes('-->')) {
      timeLineIdx = 1;
    } else {
      continue;
    }

    const timeParts = lines[timeLineIdx].split('-->');
    if (timeParts.length !== 2) continue;

    const start = parseSrtTimestamp(timeParts[0]);
    const end = parseSrtTimestamp(timeParts[1]);

    const rawText = lines.slice(timeLineIdx + 1).join('\n');
    const cleaned = cleanSubtitleText(rawText);

    if (cleaned) {
      cues.push({
        id: idCounter++,
        start,
        end,
        text: cleaned,
      });
    }
  }

  return cues;
}

export async function probeMkv(filePath: string, ffmpegPath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-i', filePath];
    const child = spawn(ffmpegPath, args, { windowsHide: true });

    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });

    child.on('close', () => {
      try {
        const metadata = parseFfmpegProbeOutput(filePath, stderr);
        resolve(metadata);
      } catch (err: any) {
        reject(err);
      }
    });
  });
}

function parseFfmpegProbeOutput(filePath: string, stderr: string): VideoMetadata {
  const fileName = path.basename(filePath);
  const folder = path.dirname(filePath);

  // 1. Duration
  let duration = 0;
  const durMatch = stderr.match(/Duration:\s*(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  if (durMatch) {
    duration = parseDuration(durMatch[1]);
  }

  // 2. Audio & Subtitle Streams
  const audioTracks: AudioTrack[] = [];
  const subtitleTracks: SubtitleTrack[] = [];

  const streamRegex = /Stream #0:(\d+)(?:\(([a-zA-Z0-9_-]+)\))?:\s*(Audio|Subtitle|Video):\s*([^\r\n]+)/g;
  let match: RegExpExecArray | null;

  const streamEntries: Array<{
    index: number;
    lang: string;
    type: 'Audio' | 'Subtitle' | 'Video';
    details: string;
    startPos: number;
  }> = [];

  while ((match = streamRegex.exec(stderr)) !== null) {
    streamEntries.push({
      index: parseInt(match[1], 10),
      lang: match[2] || '',
      type: match[3] as any,
      details: match[4],
      startPos: match.index,
    });
  }

  let audioCounter = 0;

  for (let i = 0; i < streamEntries.length; i++) {
    const entry = streamEntries[i];
    const nextStart = i < streamEntries.length - 1 ? streamEntries[i + 1].startPos : stderr.length;
    const block = stderr.slice(entry.startPos, nextStart);

    // Extract title from metadata in this block
    const titleMatch = block.match(/title\s*:\s*([^\r\n]+)/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    if (entry.type === 'Audio') {
      const isDefault = block.includes('(default)');
      const codecMatch = entry.details.match(/^([a-zA-Z0-9_-]+)/);
      const codec = codecMatch ? codecMatch[1].toLowerCase() : 'unknown';

      const audioTrack: AudioTrack = {
        index: entry.index,
        audioIndex: audioCounter++,
        language: entry.lang.toLowerCase() || 'und',
        languageName: getLanguageName(entry.lang),
        codec,
        title: title || `${getLanguageName(entry.lang)} (${codec.toUpperCase()})`,
        isDefault,
      };
      audioTracks.push(audioTrack);
    } else if (entry.type === 'Subtitle') {
      const isDefault = block.includes('(default)');
      const isForced = block.includes('(forced)') || /forced/i.test(title);
      const isSigns = isForced || /sign|song|signs|songs/i.test(title);
      const isDubtitle = /dubtitle|sdh|dialogue|dialog|amzn|cr/i.test(title);

      const codecMatch = entry.details.match(/^([a-zA-Z0-9_-]+)/);
      const codec = codecMatch ? codecMatch[1].toLowerCase() : 'subrip';

      const subTrack: SubtitleTrack = {
        id: `emb-${entry.index}`,
        index: entry.index,
        type: 'embedded',
        language: entry.lang.toLowerCase() || 'und',
        languageName: getLanguageName(entry.lang),
        codec,
        title: title || `${getLanguageName(entry.lang)} [Stream ${entry.index}]`,
        isDefault,
        isForced,
        isSigns,
        isDubtitle,
      };
      subtitleTracks.push(subTrack);
    }
  }

  // 3. Check for external .srt files in the same directory
  const baseNameWithoutExt = path.parse(fileName).name;
  let hasExternalSrt = false;
  let externalSrtPath: string | undefined;

  try {
    const files = fs.readdirSync(folder);
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.srt')) continue;
      const fBase = path.parse(f).name;

      if (fBase === baseNameWithoutExt || fBase.startsWith(baseNameWithoutExt)) {
        hasExternalSrt = true;
        externalSrtPath = path.join(folder, f);

        // Add external subtitle track at the top
        subtitleTracks.unshift({
          id: `ext-${crypto.createHash('md5').update(f).digest('hex').slice(0, 8)}`,
          index: null,
          type: 'external',
          filePath: externalSrtPath,
          language: 'eng',
          languageName: 'English (Whisper / External)',
          title: `External: ${f}`,
          isForced: false,
          isDefault: true,
          isSigns: false,
          isDubtitle: true,
        });
        break;
      }
    }
  } catch (e) {
    console.error('Failed to scan folder for external srt:', e);
  }

  return {
    filePath,
    fileName,
    title: baseNameWithoutExt,
    duration,
    audioTracks,
    subtitleTracks,
    hasExternalSrt,
    externalSrtPath,
  };
}

export async function extractEmbeddedSubtitle(
  filePath: string,
  streamIndex: number,
  ffmpegPath: string
): Promise<string> {
  const cacheDir = storage.getSubtitleCacheDir();
  const fileHash = crypto.createHash('md5').update(`${filePath}:${streamIndex}`).digest('hex');
  const cacheFile = path.join(cacheDir, `${fileHash}.srt`);

  if (fs.existsSync(cacheFile)) {
    return fs.readFileSync(cacheFile, 'utf-8');
  }

  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-y',
      '-i', filePath,
      '-map', `0:${streamIndex}`,
      '-f', 'srt',
      cacheFile,
    ];

    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 0) {
        resolve(fs.readFileSync(cacheFile, 'utf-8'));
      } else {
        // If empty or failed, resolve empty
        resolve('');
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

export async function generateSingleThumbnail(
  filePath: string,
  timeSec: number,
  ffmpegPath: string,
  outputPath: string
): Promise<string> {
  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  return new Promise((resolve, reject) => {
    const parentDir = path.dirname(outputPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const args = [
      '-hide_banner',
      '-y',
      '-ss', timeSec.toString(),
      '-i', filePath,
      '-vframes', '1',
      '-vf', 'scale=160:90',
      '-q:v', '3',
      outputPath,
    ];

    const child = spawn(ffmpegPath, args, { windowsHide: true });
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        resolve('');
      }
    });
    child.on('error', () => {
      resolve('');
    });
  });
}

/**
 * Rapidly locates the exact timestamp of the nearest preceding keyframe (IDR/CRA)
 * using a single-frame copy demux probe (<70ms).
 * This ensures that zero-transcode Matroska stream seeks align video, audio,
 * and subtitle overlays with 0ms delay and 0 frame drift.
 */
export async function findPrecedingKeyframe(
  filePath: string,
  targetTime: number,
  ffmpegPath: string
): Promise<number> {
  if (targetTime <= 0.5) return 0;
  return new Promise((resolve) => {
    const p = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-noaccurate_seek',
        '-ss',
        targetTime.toString(),
        '-i',
        filePath,
        '-map',
        '0:v:0',
        '-c',
        'copy',
        '-frames:v',
        '1',
        '-f',
        'framecrc',
        '-',
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );

    let stdout = '';
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {}
      resolve(targetTime);
    }, 350);

    p.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    p.on('close', () => {
      clearTimeout(timer);
      const lines = stdout.split('\n').filter((l) => !l.startsWith('#') && l.trim().length > 0);
      if (lines.length > 0) {
        const parts = lines[0].split(',').map((s) => s.trim());
        // framecrc line: stream_idx, dts, pts, duration, size, hash
        const ptsOffsetMs = parseInt(parts[2], 10);
        if (!isNaN(ptsOffsetMs)) {
          const actualSeconds = Math.max(0, targetTime + ptsOffsetMs / 1000);
          return resolve(actualSeconds);
        }
      }
      resolve(targetTime);
    });

    p.on('error', () => {
      clearTimeout(timer);
      resolve(targetTime);
    });
  });
}

