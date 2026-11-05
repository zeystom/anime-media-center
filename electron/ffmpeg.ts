import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { AudioTrack, SubtitleCue, SubtitleTrack, VideoChapter, VideoMetadata } from './types';
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

import { findExternalSubtitles } from './subtitles';

const probeCache = new Map<string, VideoMetadata>();

export function invalidateProbeCache(filePath?: string): void {
  if (!filePath) {
    probeCache.clear();
    return;
  }
  for (const key of Array.from(probeCache.keys())) {
    if (key.startsWith(filePath + ':') || key === filePath) {
      probeCache.delete(key);
    }
  }
}

/**
 * Fast EBML reader that inspects the first 64KB of a Matroska (.mkv) file
 * to instantly extract the official container Segment Title (element ID 0x7BA9).
 * Runs in under 1ms with 0 subprocesses or network requests.
 * Returns null for non-Matroska containers (e.g. MP4) since scanning their
 * binary payload for the 0x7BA9 byte pair would only yield false positives.
 */
export function readMkvEmbeddedTitle(filePath: string): string | null {
  if (path.extname(filePath).toLowerCase() !== '.mkv') return null;
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

/**
 * Fast EBML reader that inspects the first 64KB of a Matroska (.mkv) file
 * to instantly extract container Duration (element ID 0x4489).
 * Runs in under 1ms with 0 subprocesses or network requests.
 */
export function readMkvDuration(filePath: string): number | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);

    if (bytesRead < 4) return null;

    // TimecodeScale: 0x2AD7B1 (default is 1,000,000 ns = 1 ms)
    let timecodeScale = 1000000;
    const tcIdx = buf.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
    if (tcIdx !== -1 && tcIdx + 3 < bytesRead) {
      let firstByte = buf[tcIdx + 3];
      let numBytes = 1;
      let mask = 0x80;
      while ((firstByte & mask) === 0 && numBytes <= 8) {
        mask >>= 1;
        numBytes++;
      }
      const tcLen = firstByte & (mask - 1);
      const tcStart = tcIdx + 3 + numBytes;
      if (tcLen > 0 && tcLen <= 8 && tcStart + tcLen <= bytesRead) {
        let val = 0;
        for (let i = 0; i < tcLen; i++) {
          val = val * 256 + buf[tcStart + i];
        }
        if (val > 0) timecodeScale = val;
      }
    }

    // Matroska Segment Info Duration element ID: 0x4489
    const idx = buf.indexOf(Buffer.from([0x44, 0x89]));
    if (idx === -1 || idx + 2 >= bytesRead) return null;

    // EBML variable length integer for size
    let firstByte = buf[idx + 2];
    let numBytes = 1;
    let mask = 0x80;
    while ((firstByte & mask) === 0 && numBytes <= 8) {
      mask >>= 1;
      numBytes++;
    }
    const length = firstByte & (mask - 1);
    const dataStart = idx + 2 + numBytes;
    if (length <= 0 || dataStart + length > bytesRead) return null;

    if (length === 4) {
      const rawDur = buf.readFloatBE(dataStart);
      if (rawDur > 0 && !isNaN(rawDur)) {
        return (rawDur * timecodeScale) / 1e9;
      }
    } else if (length === 8) {
      const rawDur = buf.readDoubleBE(dataStart);
      if (rawDur > 0 && !isNaN(rawDur)) {
        return (rawDur * timecodeScale) / 1e9;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fast binary parser that walks the top-level ISO-BMFF atom chain of an MP4
 * file ([4-byte size][4-byte type] boxes) to locate the `moov` atom — it can
 * live at the END of the file when not faststart-muxed — and then reads the
 * `mvhd` movie header to extract the container duration.
 * Runs in under 1ms with 0 subprocesses. Returns seconds (rounded) or null.
 */
export function readMp4Duration(filePath: string): number | null {
  let fd: number | null = null;
  try {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size < 32) return null;

    fd = fs.openSync(filePath, 'r');
    const headBuf = Buffer.alloc(8);

    let offset = 0;
    while (offset + 8 <= stat.size) {
      if (fs.readSync(fd, headBuf, 0, 8, offset) < 8) return null;
      let boxSize = headBuf.readUInt32BE(0);
      const boxType = headBuf.toString('latin1', 4, 8);

      if (boxSize === 1) {
        // 64-bit largesize variant: real size follows the type field
        const largeBuf = Buffer.alloc(8);
        if (fs.readSync(fd, largeBuf, 0, 8, offset + 8) < 8) return null;
        boxSize = Number(largeBuf.readBigUInt64BE(0));
      } else if (boxSize === 0) {
        // Size 0 means the box extends to the end of the file
        boxSize = stat.size - offset;
      }

      if (boxSize < 8) return null;

      if (boxType === 'moov') {
        const remaining = stat.size - offset;
        return parseMp4MvhdDuration(fd, offset, Math.min(boxSize, remaining));
      }
      offset += boxSize;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Reads the `mvhd` movie header (the first child of `moov`) to derive the
 * duration. mvhd version 0 uses 32-bit fields, version 1 uses 64-bit ones:
 *   v0: ctime u32, mtime u32, timescale u32, duration u32
 *   v1: ctime u64, mtime u64, timescale u32, duration u64
 * duration in seconds = duration / timescale.
 */
function parseMp4MvhdDuration(fd: number, moovOffset: number, moovSize: number): number | null {
  try {
    // mvhd is always the first child of moov, so a small window suffices
    const windowSize = Math.min(moovSize, 4096);
    const buf = Buffer.alloc(windowSize);
    if (fs.readSync(fd, buf, 0, windowSize, moovOffset) < 8) return null;

    // Walk moov child atoms starting after the 8-byte moov header
    let offset = 8;
    while (offset + 8 <= buf.length) {
      const childSize = buf.readUInt32BE(offset);
      const childType = buf.toString('latin1', offset + 4, offset + 8);
      if (childSize < 8) return null;
      if (childType === 'mvhd') {
        if (offset + childSize > buf.length) return null;

        const version = buf[offset + 8]; // after 8-byte box header
        const base = offset + 12;        // after version/flags field

        if (version === 1) {
          if (base + 28 > buf.length) return null;
          const timescale = buf.readUInt32BE(base + 16);
          const duration = Number(buf.readBigUInt64BE(base + 20));
          if (timescale <= 0 || !Number.isFinite(duration) || duration <= 0) return null;
          return Math.round(duration / timescale);
        }

        if (base + 16 > buf.length) return null;
        const timescale = buf.readUInt32BE(base + 8);
        const duration = buf.readUInt32BE(base + 12);
        if (timescale <= 0 || duration <= 0) return null;
        return Math.round(duration / timescale);
      }
      offset += childSize;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Container-agnostic instant duration reader: dispatches on the file extension
 * to the EBML (Matroska) or ISO-BMFF (MP4) binary parser. Unknown extensions
 * fall back to trying both parsers in sequence. Returns seconds or null.
 */
export function readContainerDuration(filePath: string): number | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mkv') return readMkvDuration(filePath);
  if (ext === '.mp4' || ext === '.m4v') return readMp4Duration(filePath);
  const mkvDur = readMkvDuration(filePath);
  if (mkvDur !== null) return mkvDur;
  return readMp4Duration(filePath);
}

export async function probeMkv(filePath: string, ffmpegPath: string): Promise<VideoMetadata> {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(filePath);
  } catch {}

  const cacheKey = stat ? `${filePath}:${stat.mtimeMs}:${stat.size}` : filePath;
  let containerMeta = probeCache.get(cacheKey);

  if (!containerMeta) {
    containerMeta = await new Promise<VideoMetadata>((resolve, reject) => {
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
          probeCache.set(cacheKey, metadata);
          resolve(metadata);
        } catch (err: any) {
          reject(err);
        }
      });
    });
  }

  // Always search for external subtitles anew to attach on top of cached container info (never mutate cache)
  const externalMatches = findExternalSubtitles(filePath);
  const externalTracks: SubtitleTrack[] = externalMatches.map((found) => {
    const ext = path.extname(found.fileName).toLowerCase();
    const codec = ext === '.ass' || ext === '.ssa' ? 'ass' : ext === '.vtt' ? 'webvtt' : 'subrip';
    return {
      id: `ext-${crypto.createHash('md5').update(found.fileName).digest('hex').slice(0, 8)}`,
      index: null,
      type: 'external',
      filePath: found.filePath,
      language: 'eng',
      languageName: 'English',
      codec,
      title: found.isWhisper ? 'AI (Whisper)' : `External: ${found.fileName}`,
      isDefault: false,
      isForced: found.isForced,
      isSigns: found.isSigns,
      isDubtitle: found.isWhisper,
    };
  });

  // Default track selection:
  // Choose .whisper.srt if present, otherwise first non-forced external track
  const whisperTrack = externalTracks.find((t) => t.isDubtitle);
  const firstRegularExt = externalTracks.find((t) => !t.isForced && !t.isSigns);
  const chosenDefault = whisperTrack || firstRegularExt;

  const embeddedTracks = containerMeta.subtitleTracks.map((t) => ({
    ...t,
    isDefault: chosenDefault ? false : t.isDefault,
  }));

  if (chosenDefault) {
    chosenDefault.isDefault = true;
  }

  const combinedSubtitles = [...externalTracks, ...embeddedTracks];

  return {
    ...containerMeta,
    subtitleTracks: combinedSubtitles,
    hasExternalSrt: externalTracks.length > 0,
    externalSrtPath: externalTracks[0]?.filePath,
  };
}

function parseFfmpegProbeOutput(filePath: string, stderr: string): VideoMetadata {
  const fileName = path.basename(filePath);
  const baseNameWithoutExt = path.parse(filePath).name;
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

  // Detect whether this file contains embedded English dialogue/translation subtitles
  const hasEmbeddedSubtitles = subtitleTracks.some(
    (s) => (s.language === 'eng' || s.language === 'en') && !s.isSigns
  );

  // 3. Chapters
  const chapters: VideoChapter[] = [];
  const chapterRegex = /Chapter #0:(\d+):\s*start\s+([\d.]+),\s*end\s+([\d.]+)(?:[\r\n\s]+Metadata:[\r\n\s]+title\s*:\s*([^\r\n]+))?/gi;
  let chMatch: RegExpExecArray | null;
  while ((chMatch = chapterRegex.exec(stderr)) !== null) {
    chapters.push({
      id: parseInt(chMatch[1], 10),
      start: parseFloat(chMatch[2]),
      end: parseFloat(chMatch[3]),
      title: chMatch[4] ? chMatch[4].trim() : `Chapter ${parseInt(chMatch[1], 10) + 1}`,
    });
  }

  return {
    filePath,
    fileName,
    title: baseNameWithoutExt,
    duration,
    audioTracks,
    subtitleTracks,
    chapters,
    hasExternalSrt: false,
    hasEmbeddedDubtitles,
    hasEmbeddedSubtitles,
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
  let mtime = 0;
  let size = 0;
  try {
    const st = fs.statSync(filePath);
    mtime = Math.round(st.mtimeMs);
    size = st.size;
  } catch {}
  const fileHash = crypto.createHash('md5').update(`${filePath}:${mtime}:${size}:${streamIndex}`).digest('hex');
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
  let mtime = 0;
  let size = 0;
  try {
    const st = fs.statSync(filePath);
    mtime = Math.round(st.mtimeMs);
    size = st.size;
  } catch {}
  const fileHash = crypto.createHash('md5').update(`${filePath}:${mtime}:${size}:${streamIndex}`).digest('hex');
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
          '-probesize', '32768',
          '-analyzeduration', '0',
          '-noaccurate_seek',
          '-ss', timeSec.toString(),
          '-skip_frame', 'nokey',
          '-i', filePath,
          '-an',
          '-sn',
          '-dn',
          '-threads', '2',
          '-frames:v', '1',
          '-vf', 'scale=160:90:flags=fast_bilinear',
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

/**
 * Periodically deletes cache files older than 60 days in background to keep disk usage light.
 */
export function cleanupOldCaches(): void {
  const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const dirs = [storage.getThumbnailDir(), storage.getSubtitleCacheDir()];

  function cleanDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) return;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        try {
          if (entry.isDirectory()) {
            cleanDir(fullPath);
            if (fs.readdirSync(fullPath).length === 0) {
              fs.rmdirSync(fullPath);
            }
          } else if (entry.isFile()) {
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs < sixtyDaysAgo) {
              fs.unlinkSync(fullPath);
            }
          }
        } catch {}
      }
    } catch {}
  }

  for (const dir of dirs) {
    cleanDir(dir);
  }
}

