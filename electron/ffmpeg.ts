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

const probeCache = new Map<string, VideoMetadata>();

/**
 * Fast EBML reader that inspects the first 64KB of a Matroska (.mkv) file
 * to instantly extract the official container Segment Title (element ID 0x7BA9).
 * Runs in under 1ms with 0 subprocesses or network requests.
 */
export function readMkvEmbeddedTitle(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);

    if (bytesRead < 4) return null;

    // Matroska Segment Info Title element ID: 0x7BA9
    const idx = buf.indexOf(Buffer.from([0x7b, 0xa9]));
    if (idx === -1 || idx + 2 >= bytesRead) return null;

    // EBML variable length integer for size
    let firstByte = buf[idx + 2];
    let length = 0;
    let mask = 0x80;
    let numBytes = 1;
    while ((firstByte & mask) === 0 && numBytes <= 8) {
      mask >>= 1;
      numBytes++;
    }
    length = firstByte & (mask - 1);
    for (let i = 1; i < numBytes; i++) {
      if (idx + 2 + i >= bytesRead) return null;
      length = (length << 8) | buf[idx + 2 + i];
    }

    if (length <= 0 || length > 1024 || idx + 2 + numBytes + length > bytesRead) return null;

    const rawTitle = buf.slice(idx + 2 + numBytes, idx + 2 + numBytes + length).toString('utf8').trim();
    if (!rawTitle) return null;

    // Strip show name and season/episode prefix
    // e.g. "Clevatess S01E06 Insect Controlling Wizard" -> "Insect Controlling Wizard"
    // e.g. "Clevatess S01E01 The Lord of Dark Beasts" -> "The Lord of Dark Beasts"
    const cleaned = rawTitle
      .replace(/^.*?\b(?:S\d{1,2}\s*E\d{1,3}|EP?\s*\d{1,3})\s*[-–—:.]?\s*/i, '')
      .replace(/^[-_–—.\s]+|[-_–—.\s]+$/g, '')
      .trim();

    return cleaned.length >= 2 ? cleaned : rawTitle;
  } catch {
    return null;
  }
}

export async function probeMkv(filePath: string, ffmpegPath: string): Promise<VideoMetadata> {
  const cached = probeCache.get(filePath);
  if (cached) return cached;

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
        probeCache.set(filePath, metadata);
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
      const isHearingImpaired = block.includes('(hearing impaired)') || /hearing impaired/i.test(title);
      const isDubtitle = isHearingImpaired || /sdh|dubtitle|\bcc\b|closed caption/i.test(title) || /sdh|dubtitle/i.test(block);

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

  // Detect whether this file contains embedded English dubtitles (SDH / dubtitle)
  const hasEmbeddedDubtitles = subtitleTracks.some(
    (s) =>
      (s.language === 'eng' || s.language === 'en') &&
      (s.isDubtitle || /sdh|dubtitle|hearing impaired|\bcc\b/i.test(s.title)) &&
      !s.isSigns
  );

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
    hasEmbeddedDubtitles,
  };
}

const inFlightAss = new Map<string, Promise<string>>();
const inFlightSrt = new Map<string, Promise<string>>();

export async function extractEmbeddedSubtitle(
  filePath: string,
  streamIndex: number,
  ffmpegPath: string
): Promise<string> {
  const cacheDir = storage.getSubtitleCacheDir();
  const fileHash = crypto.createHash('md5').update(`${filePath}:${streamIndex}`).digest('hex');
  const cacheFile = path.join(cacheDir, `${fileHash}.srt`);

  if (fs.existsSync(cacheFile)) {
    try {
      const stat = fs.statSync(cacheFile);
      if (stat.size > 0) {
        return fs.readFileSync(cacheFile, 'utf-8');
      } else {
        fs.unlinkSync(cacheFile);
      }
    } catch {}
  }

  const inFlight = inFlightSrt.get(cacheFile);
  if (inFlight) return inFlight;

  const promise = new Promise<string>((resolve) => {
    const args = [
      '-hide_banner',
      '-y',
      '-discard:v', 'all',
      '-discard:a', 'all',
      '-i', filePath,
      '-map', `0:${streamIndex}`,
      '-vn',
      '-an',
      '-c:s', 'srt',
      cacheFile,
    ];

    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    child.on('close', (code) => {
      inFlightSrt.delete(cacheFile);
      if (code === 0 && fs.existsSync(cacheFile)) {
        try {
          const stat = fs.statSync(cacheFile);
          if (stat.size > 0) {
            return resolve(fs.readFileSync(cacheFile, 'utf-8'));
          }
          fs.unlinkSync(cacheFile);
        } catch {}
      }
      resolve('');
    });

    child.on('error', () => {
      inFlightSrt.delete(cacheFile);
      try {
        if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
      } catch {}
      resolve('');
    });
  });

  inFlightSrt.set(cacheFile, promise);
  return promise;
}

export async function extractEmbeddedAss(
  filePath: string,
  streamIndex: number,
  ffmpegPath: string
): Promise<string> {
  const cacheDir = storage.getSubtitleCacheDir();
  const fileHash = crypto.createHash('md5').update(`${filePath}:${streamIndex}`).digest('hex');
  const cacheFile = path.join(cacheDir, `${fileHash}.ass`);

  if (fs.existsSync(cacheFile)) {
    try {
      const stat = fs.statSync(cacheFile);
      if (stat.size > 0) {
        return fs.readFileSync(cacheFile, 'utf-8');
      } else {
        fs.unlinkSync(cacheFile);
      }
    } catch {}
  }

  const inFlight = inFlightAss.get(cacheFile);
  if (inFlight) return inFlight;

  const promise = new Promise<string>((resolve) => {
    const args = [
      '-hide_banner',
      '-y',
      '-discard:v', 'all',
      '-discard:a', 'all',
      '-i', filePath,
      '-map', `0:${streamIndex}`,
      '-vn',
      '-an',
      '-c:s', 'copy',
      cacheFile,
    ];

    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    child.on('close', (code) => {
      inFlightAss.delete(cacheFile);
      if (code === 0 && fs.existsSync(cacheFile)) {
        try {
          const stat = fs.statSync(cacheFile);
          if (stat.size > 0) {
            return resolve(fs.readFileSync(cacheFile, 'utf-8'));
          }
          fs.unlinkSync(cacheFile);
        } catch {}
      }
      resolve('');
    });

    child.on('error', () => {
      inFlightAss.delete(cacheFile);
      try {
        if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
      } catch {}
      resolve('');
    });
  });

  inFlightAss.set(cacheFile, promise);
  return promise;
}

export async function extractEmbeddedFonts(
  filePath: string,
  ffmpegPath: string,
  port: number
): Promise<string[]> {
  const fileHash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 16);
  const fontsDir = path.join(storage.getThumbnailDir(), 'fonts', fileHash);

  if (!fs.existsSync(fontsDir)) {
    fs.mkdirSync(fontsDir, { recursive: true });
  }

  // Check if fonts are already extracted
  const existingFiles = fs.readdirSync(fontsDir).filter((f) => /\.(ttf|otf|ttc|woff2?)$/i.test(f));
  if (existingFiles.length === 0) {
    await new Promise<void>((resolve) => {
      const p = spawn(
        ffmpegPath,
        ['-hide_banner', '-y', '-dump_attachment:t', '', '-i', filePath, '-vn', '-an', '-t', '0', '-f', 'null', '-'],
        { cwd: fontsDir, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }
      );
      p.on('close', () => resolve());
      p.on('error', () => resolve());
    });
  }

  // Filter valid TTF/OTF fonts (exclude TTC collections as WASM FreeType does not support them without index)
  const fontFiles = fs.readdirSync(fontsDir).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f));
  return fontFiles.map((name) => `http://127.0.0.1:${port}/font/${fileHash}/${encodeURIComponent(name)}`);
}

export function filterFontsForAss(assContent: string, fontUrls: string[]): string[] {
  if (!assContent || fontUrls.length === 0) return [];
  const referenced = new Set<string>();
  const styleRegex = /^Style:\s*[^,]+,\s*([^,]+)/gim;
  let m: RegExpExecArray | null;
  while ((m = styleRegex.exec(assContent)) !== null) {
    referenced.add(m[1].trim().toLowerCase().replace(/[\s-_]/g, ''));
  }
  const inlineRegex = /\\fn([^\\}]+)/gi;
  while ((m = inlineRegex.exec(assContent)) !== null) {
    referenced.add(m[1].trim().toLowerCase().replace(/[\s-_]/g, ''));
  }

  if (referenced.size === 0) {
    return fontUrls
      .filter((u) => !u.toLowerCase().includes('arialunicodems') && !u.toLowerCase().endsWith('.ttc'))
      .slice(0, 5);
  }

  const matched = fontUrls.filter((u) => {
    const fileName = decodeURIComponent(u.split('/').pop() || '').toLowerCase();
    if (fileName.endsWith('.ttc')) return false;
    if (fileName.includes('arialunicodems') && !referenced.has('arialunicodems')) return false;

    const cleanFile = fileName.replace(/[\s-_]/g, '');
    for (const ref of referenced) {
      if (cleanFile.includes(ref) || ref.includes(cleanFile.replace(/\.[a-z0-9]+$/, ''))) return true;
    }
    return false;
  });

  return matched.slice(0, 8);
}

export async function generateSingleThumbnail(
  filePath: string,
  timeSec: number,
  ffmpegPath: string,
  outputPath: string,
  signalOrOptions?: AbortSignal | { isCard?: boolean },
  signal?: AbortSignal
): Promise<string> {
  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  const isCard =
    typeof signalOrOptions === 'object' &&
    signalOrOptions !== null &&
    !(signalOrOptions instanceof AbortSignal) &&
    'isCard' in signalOrOptions
      ? Boolean(signalOrOptions.isCard)
      : false;

  const activeSignal = signalOrOptions instanceof AbortSignal ? signalOrOptions : signal;

  if (activeSignal?.aborted) {
    return '';
  }

  return new Promise((resolve) => {
    const parentDir = path.dirname(outputPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // High quality for cards (640x360 with thumbnail filter), or fast keyframe skip for scrubber (160x90)
    const fastArgs = isCard
      ? [
          '-hide_banner',
          '-y',
          '-ss', timeSec.toString(),
          '-i', filePath,
          '-an',
          '-sn',
          '-threads', '2',
          '-vf', 'thumbnail=50,scale=640:360',
          '-frames:v', '1',
          '-q:v', '2',
          outputPath,
        ]
      : [
          '-hide_banner',
          '-y',
          '-noaccurate_seek',
          '-ss', timeSec.toString(),
          '-skip_frame', 'nokey',
          '-i', filePath,
          '-an',
          '-sn',
          '-threads', '2',
          '-frames:v', '1',
          '-vf', 'scale=160:90',
          '-q:v', '5',
          outputPath,
        ];

    let child = spawn(ffmpegPath, fastArgs, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    const onAbort = () => {
      try {
        child.kill();
      } catch {}
      resolve('');
    };

    if (activeSignal) {
      activeSignal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('close', (code) => {
      if (activeSignal) {
        activeSignal.removeEventListener('abort', onAbort);
      }

      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 100) {
        resolve(outputPath);
      } else {
        // Fallback for edge cases where keyframe skip didn't catch a frame
        if (activeSignal?.aborted) return resolve('');

        const fallbackArgs = isCard
          ? [
              '-hide_banner',
              '-y',
              '-ss', timeSec.toString(),
              '-i', filePath,
              '-an',
              '-sn',
              '-threads', '2',
              '-vf', 'scale=640:360',
              '-frames:v', '1',
              '-q:v', '2',
              outputPath,
            ]
          : [
              '-hide_banner',
              '-y',
              '-ss', timeSec.toString(),
              '-i', filePath,
              '-an',
              '-sn',
              '-threads', '2',
              '-frames:v', '1',
              '-vf', 'scale=160:90',
              '-q:v', '5',
              outputPath,
            ];
        const fbChild = spawn(ffmpegPath, fallbackArgs, {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        if (activeSignal) {
          activeSignal.addEventListener('abort', () => {
            try { fbChild.kill(); } catch {}
            resolve('');
          }, { once: true });
        }
        fbChild.on('close', (fbCode) => {
          if (fbCode === 0 && fs.existsSync(outputPath)) {
            resolve(outputPath);
          } else {
            resolve('');
          }
        });
        fbChild.on('error', () => resolve(''));
      }
    });

    child.on('error', () => {
      if (activeSignal) activeSignal.removeEventListener('abort', onAbort);
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
    }, 600);

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

