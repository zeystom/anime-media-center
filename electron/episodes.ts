/**
 * Episode number parser for anime release naming conventions.
 * Standalone module with zero Electron dependencies so it can be tested directly in Node.js.
 */
export function extractEpisodeNumber(fileName: string): { episodeNum: number | null; label: string } {
  const withoutExt = fileName.replace(/\.[a-zA-Z0-9]+$/, '');
  const cleaned = withoutExt.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').trim();

  // 1. SxxExx e.g. S01E05
  const sxxExxMatch = cleaned.match(/\bs(\d+)e(\d+)\b/i);
  if (sxxExxMatch) {
    const n = parseInt(sxxExxMatch[2], 10);
    return {
      episodeNum: n,
      label: `S${sxxExxMatch[1].padStart(2, '0')}E${sxxExxMatch[2].padStart(2, '0')}`,
    };
  }

  // 2. \b(?:ep|episode|e)[_.\s-]*(\d+)\b with word boundary
  const epWordMatch = cleaned.match(/\b(?:ep|episode|e)[_.\s-]*(\d+)\b/i);
  if (epWordMatch) {
    const n = parseInt(epWordMatch[1], 10);
    return {
      episodeNum: n,
      label: `E${n.toString().padStart(2, '0')}`,
    };
  }

  // 3. NxNN e.g. 1x05
  const nxMatch = cleaned.match(/\b\d+x(\d+)\b/i);
  if (nxMatch) {
    const n = parseInt(nxMatch[1], 10);
    return {
      episodeNum: n,
      label: `E${n.toString().padStart(2, '0')}`,
    };
  }

  // 4. Number after ' - ' with optional version: \s-\s(\d{1,4})(?:v\d+)?\b
  const dashMatch = cleaned.match(/\s-\s(\d{1,4})(?:v\d+)?\b/i);
  if (dashMatch) {
    const n = parseInt(dashMatch[1], 10);
    return {
      episodeNum: n,
      label: `E${n.toString().padStart(2, '0')}`,
    };
  }

  // 5. Fallback: number bounded by separator (e.g. "Show.Name.05.1080p")
  // Strip common resolution and codec tags first so 1080p / 720p aren't confused
  const withoutMediaTags = cleaned.replace(/\b(?:\d{3,4}p|x26[45]|h26[45]|hevc|avc|10bit|8bit|aac|flac)\b/gi, ' ');
  const fallbackMatch = withoutMediaTags.match(/(?:^|[-_.\s])(\d{1,3})(?:v\d+)?(?=[-_.\s]|$)/);
  if (fallbackMatch) {
    const n = parseInt(fallbackMatch[1], 10);
    return {
      episodeNum: n,
      label: `E${n.toString().padStart(2, '0')}`,
    };
  }

  return { episodeNum: null, label: 'EP' };
}
