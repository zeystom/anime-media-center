/**
 * Pure ASS/SSA subtitle parser and Signs & Songs extractor + shared Signs track
 * matching helpers. Zero Electron dependencies so it can be imported directly
 * in plain Node.js tests as well as the main process.
 */

export interface AssSignsExtractionResult {
  assContent: string;
  keptCount: number;
  totalCount: number;
  matchedStyles: string[];
}

interface ParsedStyleDef {
  name: string;
  fontName: string;
  alignment: number;
}

/**
 * Normalizes a subtitle title / track label to check whether it explicitly
 * denotes a Signs, Songs, Forced, or Typesetting track.
 */
export function isSignsSubtitleTitle(title?: string | null): boolean {
  const t = (title || '').trim();
  if (!t) return false;
  return /\b(?:sign|signs|song|songs|forced|typeset|typesetting)\b/i.test(t) ||
    /sign|song|forced/i.test(t);
}

/**
 * Returns true when a subtitle track's language code is acceptable for English
 * Signs & Songs playback in Kaiko.
 *
 * Includes `zxx` ("No linguistic content", common in MKVs for Signs & Songs)
 * and `und` ("Undetermined") / `enm` (fansub alternate English tags) ONLY when
 * paired with a Signs/Forced marker, while strictly ignoring foreign-language
 * tracks (jpn, rus, spa, etc.).
 */
export function isAllowedSignsLanguage(
  lang?: string | null,
  allowedLanguages?: string[]
): boolean {
  const code = (lang || '').trim().toLowerCase();
  if (allowedLanguages && allowedLanguages.length > 0) {
    if (code === '' || code === 'zxx' || code === 'und') return true;
    const base = code.split(/[-_]/)[0];
    const normalized = new Set(
      allowedLanguages
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    );
    return normalized.has(code) || normalized.has(base);
  }
  return (
    code === '' ||
    code === 'eng' ||
    code === 'en' ||
    code === 'enm' ||
    code === 'zxx' ||
    code === 'und' ||
    code.startsWith('en-') ||
    code.startsWith('eng-')
  );
}

/**
 * Shared predicate determining whether a SubtitleTrack belongs in the
 * "2nd Sub / Signs (Top)" slot.
 */
export function isTopSignsCandidate(
  track: {
    id: string;
    language?: string | null;
    title?: string | null;
    isSigns?: boolean;
    isForced?: boolean;
  },
  selectedMainSubId: string | null,
  allowedLanguages?: string[]
): boolean {
  if (track.id === selectedMainSubId) return false;
  if (!isAllowedSignsLanguage(track.language, allowedLanguages)) return false;
  return Boolean(track.isSigns || track.isForced || isSignsSubtitleTitle(track.title));
}

// Dialogue-only style names (never keep unless inline typesetting/karaoke overrides exist).
const EXPLICIT_DIALOGUE_STYLE_RE =
  /(?:^|[\s_\/-\d])(?:default|main|dialog|dialogue|norma|normal|italic|italics|flashback|thought|thoughts|thoug|narra|narration|narrator|overl|overlap|alt|secondary|internal|radio|whisper|offscreen|speech|spoken|subtitle|sub)(?:$|[\s_\/-\d])/i;

// Explicit Signs / Songs / Typesetting / Notes style names.
const EXPLICIT_SIGNS_STYLE_RE =
  /^ts(?:$|[\s_\/-]|ep)|(?:^|[\s_\/-])ts(?:$|[\s_\/-\d])|(?:typeset|typesetting|eyecatch|karaoke|kfx|lyrics?|tl[_ -]?notes?|watermark|credits|staff)|(?:^|[\s_\/-\d])(?:signs?|notes?|titles?|screen|board|paper|poster|card|letter|phone|sms|chat|hud|banner|label|overlay|kara|songs?|romaji|kanji|opening|ending)(?:$|[\s_\/-\d.])|(?:^|[\s_\/-])(?:op|ed)(?:$|[\s_\/-\d]|tl|ro|kanji|lyric|lyrics|jap|eng|jp|en)/i;

// Explicit Signs / Songs / Title Actor (Name) markers (used heavily in Crunchyroll/Erai-raws `top` lines).
const EXPLICIT_SIGNS_ACTOR_RE =
  /^(?:sign|signs|ts|typeset|title|text|screen|on[- ]?screen|caption|credits|staff|op|ed|opening|ending|song|songs|lyric|lyrics|note|notes|tl[- ]?note|kara|karaoke|romaji|kanji|eyecatch|date|location)(?:[\s_-].*)?$/i;

// Strong ASS override tags that indicate positional typesetting, vector drawings, or karaoke.
const STRONG_TYPESET_TAG_RE =
  /\\(?:pos\(|move\(|org\(|frx|fry|frz|fr-?\d|fax|fay|p[1-9]\d*|i?clip\(|k[fo]?\d|K\d|fn[^\\}]+|an[1345679]\b)/;

// Moderate typesetting tags that only count when combined with \an8 or on non-dialogue styles.
const VISUAL_STYLE_OVERRIDE_RE =
  /\\(?:(?:1|2|3|4)?c&H|(?:1|2|3|4)?a&H|fs\d|fsc[xy]\d|bord\d|shad\d|fad\(|fade\(|t\()/;

function hasStrongTypesetOverrides(rawText: string, effect: string): boolean {
  if (/^(?:banner|scroll\s*(?:up|down))/i.test(effect.trim())) {
    return true;
  }
  const blocks = rawText.match(/\{[^}]*\}/g);
  if (!blocks || blocks.length === 0) return false;

  const joined = blocks.join('');
  if (STRONG_TYPESET_TAG_RE.test(joined)) return true;

  // Bare {\an8} in Default/Overlap is often spoken overlap dialogue; only treat
  // {\an8} as a sign when paired with visual styling/font/fade overrides.
  if (/\\an8\b/.test(joined) && VISUAL_STYLE_OVERRIDE_RE.test(joined)) {
    return true;
  }

  // Vector / colorized fade without \pos (e.g. title cards using {\fad(...)\fs36\c&H...})
  if (/\\fad\(/i.test(joined) && /\\(?:fs\d|(?:1|3)?c&H|bord|fn)/i.test(joined)) {
    return true;
  }

  return false;
}

function parseStyleDefinitions(lines: string[]): {
  styles: Map<string, ParsedStyleDef>;
} {
  const styles = new Map<string, ParsedStyleDef>();
  let inStyles = false;
  let nameIdx = 0;
  let fontIdx = 1;
  let alignIdx = 18;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\[V4\+?\s*Styles\]$/i.test(line)) {
      inStyles = true;
      continue;
    }
    if (line.startsWith('[')) {
      inStyles = false;
      continue;
    }
    if (!inStyles) continue;

    if (/^Format:/i.test(line)) {
      const cols = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((c) => c.trim().toLowerCase());
      const n = cols.indexOf('name');
      const f = cols.indexOf('fontname');
      const a = cols.indexOf('alignment');
      if (n >= 0) nameIdx = n;
      if (f >= 0) fontIdx = f;
      if (a >= 0) alignIdx = a;
      continue;
    }

    if (/^Style:/i.test(line)) {
      const parts = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((p) => p.trim());
      const name = parts[nameIdx];
      if (!name) continue;
      styles.set(name.toLowerCase(), {
        name,
        fontName: (parts[fontIdx] || '').toLowerCase(),
        alignment: parseInt(parts[alignIdx] || '2', 10) || 2,
      });
    }
  }

  return { styles };
}

function splitAssEventFields(rest: string, expectedCols: number): string[] {
  const parts: string[] = [];
  let start = 0;
  let commas = 0;
  for (let i = 0; i < rest.length && commas < expectedCols - 1; i++) {
    if (rest[i] === ',') {
      parts.push(rest.slice(start, i));
      start = i + 1;
      commas++;
    }
  }
  parts.push(rest.slice(start));
  return parts;
}

/**
 * Extracts only Signs, Songs, Titles, Notes, Credits, and Typesetting lines
 * from a full `.ass` / `.ssa` subtitle script while discarding spoken dialogue.
 */
export function extractSignsFromAss(assContent: string): AssSignsExtractionResult {
  if (!assContent || typeof assContent !== 'string') {
    return { assContent: '', keptCount: 0, totalCount: 0, matchedStyles: [] };
  }

  const hasBom = assContent.charCodeAt(0) === 0xfeff;
  const normalized = (hasBom ? assContent.slice(1) : assContent)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const { styles } = parseStyleDefinitions(lines);

  // Locate [Events] section and parse column schema
  const eventsIdx = lines.findIndex((l) => /^\[Events\]$/i.test(l.trim()));
  if (eventsIdx === -1) {
    return { assContent: '', keptCount: 0, totalCount: 0, matchedStyles: [] };
  }

  // Find end of [Events] (e.g. if [Fonts] or [Graphics] follows)
  let eventsEndIdx = lines.length;
  for (let i = eventsIdx + 1; i < lines.length; i++) {
    if (/^\[.+\]$/.test(lines[i].trim())) {
      eventsEndIdx = i;
      break;
    }
  }

  let colNames = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  let formatLine = 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text';

  const rawDialogues: Array<{
    line: string;
    style: string;
    actor: string;
    effect: string;
    rawText: string;
  }> = [];

  for (let i = eventsIdx + 1; i < eventsEndIdx; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^Format:/i.test(trimmed)) {
      formatLine = trimmed;
      const parsedCols = trimmed
        .slice(trimmed.indexOf(':') + 1)
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean);
      if (parsedCols.length >= 3 && parsedCols.includes('text')) colNames = parsedCols;
      continue;
    }
    if (/^Dialogue:/i.test(trimmed)) {
      const rest = trimmed.slice(trimmed.indexOf(':') + 1).trimStart();
      const fields = splitAssEventFields(rest, colNames.length);
      if (fields.length < colNames.length) continue;

      const idxStyle = colNames.indexOf('style');
      const idxName = colNames.indexOf('name');
      const idxEffect = colNames.indexOf('effect');
      const idxText = colNames.indexOf('text');

      const style = (fields[idxStyle >= 0 ? idxStyle : 3] || '').replace(/^\*/, '').trim();
      const actor = (fields[idxName >= 0 ? idxName : 4] || '').trim();
      const effect = (fields[idxEffect >= 0 ? idxEffect : 8] || '').trim();
      const rawText = fields[idxText >= 0 ? idxText : fields.length - 1] || '';
      if (!rawText.trim()) continue;

      rawDialogues.push({
        line: lines[i].trimEnd(),
        style,
        actor,
        effect,
        rawText,
      });
    }
  }

  if (rawDialogues.length === 0) {
    return { assContent: '', keptCount: 0, totalCount: 0, matchedStyles: [] };
  }

  // Determine the dominant spoken-dialogue style and its primary font
  const styleCounts = new Map<string, number>();
  for (const d of rawDialogues) {
    const k = d.style.toLowerCase();
    styleCounts.set(k, (styleCounts.get(k) || 0) + 1);
  }
  let dominantStyleKey = 'default';
  let maxCount = -1;
  for (const [k, count] of styleCounts.entries()) {
    if (EXPLICIT_SIGNS_STYLE_RE.test(k)) continue;
    if (count > maxCount) {
      maxCount = count;
      dominantStyleKey = k;
    }
  }
  const dominantFont = styles.get(dominantStyleKey)?.fontName || '';

  const keptLines: string[] = [];
  const matchedStylesSet = new Set<string>();

  for (const d of rawDialogues) {
    const styleKey = d.style.toLowerCase();
    const styleDef = styles.get(styleKey);
    const hasExplicitSignActor = d.actor.length > 0 && EXPLICIT_SIGNS_ACTOR_RE.test(d.actor);
    const hasExplicitSignStyle = EXPLICIT_SIGNS_STYLE_RE.test(d.style);
    const hasExplicitDialogueStyle = EXPLICIT_DIALOGUE_STYLE_RE.test(d.style);
    const hasTypesetTags = hasStrongTypesetOverrides(d.rawText, d.effect);

    let keep = false;

    if (hasExplicitSignStyle || hasExplicitSignActor) {
      keep = true;
    } else if (hasTypesetTags) {
      keep = true;
    } else if (!hasExplicitDialogueStyle && styleKey !== dominantStyleKey && styleDef) {
      // Custom non-dialogue style: keep if it uses a distinct typesetting font
      // or non-standard alignment (except top=8 when sharing the exact dialogue font,
      // which Crunchyroll uses for overlapping spoken dialogue unless Actor marks it).
      const distinctFont = Boolean(dominantFont && styleDef.fontName && styleDef.fontName !== dominantFont);
      const nonDialogueAlign = styleDef.alignment !== 2 && styleDef.alignment !== 8;
      if (distinctFont || nonDialogueAlign) {
        keep = true;
      }
    }

    if (keep) {
      keptLines.push(d.line);
      if (d.style) matchedStylesSet.add(d.style);
    }
  }

  if (keptLines.length === 0) {
    return {
      assContent: '',
      keptCount: 0,
      totalCount: rawDialogues.length,
      matchedStyles: [],
    };
  }

  const headerPart = lines.slice(0, eventsIdx + 1).join('\n');
  const tailPart = eventsEndIdx < lines.length ? '\n\n' + lines.slice(eventsEndIdx).join('\n') : '';
  const assembled = `${hasBom ? '\ufeff' : ''}${headerPart}\n${formatLine}\n${keptLines.join('\n')}\n${tailPart}`;

  return {
    assContent: assembled,
    keptCount: keptLines.length,
    totalCount: rawDialogues.length,
    matchedStyles: Array.from(matchedStylesSet),
  };
}

/**
 * Extracts normalized font family tokens referenced by an ASS script (`Style:`
 * definitions and inline `\fn` overrides) so online `.ass` downloads can fetch
 * matching `.ttf`/`.otf` attachments.
 */
export function findReferencedAssFontTokens(assContent: string): Set<string> {
  const referenced = new Set<string>();
  if (!assContent) return referenced;

  const styleRegex = /^Style:\s*[^,]+,\s*([^,]+)/gim;
  let m: RegExpExecArray | null;
  while ((m = styleRegex.exec(assContent)) !== null) {
    const token = m[1].trim().toLowerCase().replace(/[\s-_]/g, '');
    if (token) referenced.add(token);
  }
  const inlineRegex = /\\fn([^\\}]+)/gi;
  while ((m = inlineRegex.exec(assContent)) !== null) {
    const token = m[1].trim().toLowerCase().replace(/[\s-_]/g, '');
    if (token) referenced.add(token);
  }
  return referenced;
}
