import fs from 'fs';
import path from 'path';

export interface ExternalSubtitleMatch {
  filePath: string;
  fileName: string;
  isWhisper: boolean;
  isForced: boolean;
  isSigns: boolean;
  isDubtitle?: boolean;
  suffix: string;
}

/**
 * Unified finder for external .srt files associated with a video file.
 * Matches <base>.srt or <base>.<suffix>.srt where suffix is a token without spaces.
 * Any other prefix (e.g. "Show - 10.srt" for "Show - 1.mkv") is strictly rejected.
 */
export function findExternalSubtitles(videoPath: string): ExternalSubtitleMatch[] {
  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const base = path.basename(videoPath, ext);

  if (!fs.existsSync(dir)) {
    return [];
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  // Regex for <base>.(srt|ass|ssa|vtt) or <base>.<suffix>.(srt|ass|ssa|vtt)
  // Escape base for regex safety
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Token suffix: dot followed by characters containing letters, digits, hyphens or underscores
  const pattern = new RegExp(`^${escapedBase}(\\.[a-zA-Z0-9_-]+)*\\.(srt|ass|ssa|vtt)$`, 'i');

  const matches: ExternalSubtitleMatch[] = [];

  for (const file of entries) {
    const fileLower = file.toLowerCase();
    const isSupportedExt =
      fileLower.endsWith('.srt') ||
      fileLower.endsWith('.ass') ||
      fileLower.endsWith('.ssa') ||
      fileLower.endsWith('.vtt');
    if (!isSupportedExt) continue;

    if (pattern.test(file)) {
      const fullPath = path.join(dir, file);
      const extDot = path.extname(file);
      const nameWithoutExt = file.slice(0, -extDot.length);
      const rawSuffix = nameWithoutExt.slice(base.length); // e.g. ".whisper" or ".en.forced" or ""
      const suffixTokens = rawSuffix.toLowerCase().split('.').filter(Boolean);

      const isWhisper =
        suffixTokens.includes('whisper') ||
        fileLower === `${base.toLowerCase()}.whisper.srt`;
      const isForced = suffixTokens.includes('forced');
      const isSigns = suffixTokens.includes('signs') || suffixTokens.includes('sign');
      const isDubtitle =
        suffixTokens.includes('sdh') ||
        suffixTokens.includes('dub') ||
        suffixTokens.includes('dubtitle') ||
        suffixTokens.includes('cc');

      matches.push({
        filePath: fullPath,
        fileName: file,
        isWhisper,
        isForced,
        isSigns,
        isDubtitle,
        suffix: suffixTokens.join('.'),
      });
    }
  }

  // Sort order:
  // 1. .whisper.srt first
  // 2. Base .srt or general non-forced .srt
  // 3. Forced / Signs tracks
  matches.sort((a, b) => {
    if (a.isWhisper && !b.isWhisper) return -1;
    if (!a.isWhisper && b.isWhisper) return 1;
    if (!a.isForced && !a.isSigns && (b.isForced || b.isSigns)) return -1;
    if ((a.isForced || a.isSigns) && !b.isForced && !b.isSigns) return 1;
    return a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' });
  });

  return matches;
}

export const findSubtitlesForEpisode = findExternalSubtitles;

export function hasWhisperSubtitle(videoPath: string): boolean {
  const subs = findExternalSubtitles(videoPath);
  return subs.some((s) => s.isWhisper);
}

export function getWhisperSubtitlePath(videoPath: string): string {
  const dir = path.dirname(videoPath);
  const ext = path.extname(videoPath);
  const base = path.basename(videoPath, ext);
  return path.join(dir, `${base}.whisper.srt`);
}
