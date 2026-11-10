/**
 * Whisper Initial Prompt & Hotwords Generator for Anime Dubs
 *
 * Implements Whisper prompt design invariants:
 * 1. Template: Natural sentence with names at the end: "Dialogue from an anime episode. Characters: {names}."
 *    No instruction-like phrases ("clean subtitles", "conversational speech") which leak into transcripts.
 * 2. Token Budget: Conservative token measurement keeping prompt <= 180 tokens.
 * 3. Priority: MAIN characters first, then SUPPORTING; skips BACKGROUND/episodic characters.
 * 4. Normalization: Dedupe, strip parentheses/voice tags/titles, fix Japanese surname-first order ("Yeager Eren" -> "Eren Yeager"),
 *    drop descriptions ("Kyon no Imouto" / "X's sister"), drop generic pets/objects.
 * 5. Length trimming: Full name for top ~3 characters; spoken/first name for characters 4+.
 * 6. Ambiguous names: Names that are also common English words ("Light", "Ray", "May", "Rose") are placed at the end
 *    or filtered behind a blocklist to prevent Whisper vocabulary substitutions.
 * 7. Hotwords: Produces comma-separated list of top characters for Faster-Whisper's `--hotwords`.
 */

export interface RawCharacterNode {
  name?: {
    first?: string | null;
    middle?: string | null;
    last?: string | null;
    full?: string | null;
    native?: string | null;
    alternative?: string[] | null;
    userPreferred?: string | null;
  } | null;
}

export interface RawCharacterEdge {
  role?: string | null; // "MAIN", "SUPPORTING", "BACKGROUND"
  node?: RawCharacterNode | null;
}

export interface NormalizedCharacter {
  fullName: string;
  spokenName: string;
  role: 'MAIN' | 'SUPPORTING' | 'BACKGROUND';
  isAmbiguous: boolean;
  priority: number; // 1 = MAIN, 2 = SUPPORTING, 3 = BACKGROUND
}

/**
 * Common English words that also exist as Japanese or English anime character names.
 * Whisper tends to substitute these for everyday speech ("a ray of light" -> "a Ray of Light").
 * These are pushed to the end of the prompt or excluded when the budget is tight.
 */
export const AMBIGUOUS_ANIME_NAMES = new Set<string>([
  'light', 'ray', 'l', 'rin', 'may', 'rose', 'major', 'penny', 'bill',
  'hope', 'chase', 'joy', 'grace', 'faith', 'summer', 'autumn', 'winter',
  'robin', 'miles', 'guy', 'red', 'blue', 'rain', 'ash', 'storm', 'shadow',
  'king', 'cross', 'angel', 'archer', 'hunter', 'fang', 'sky', 'stone',
  'bear', 'fox', 'clover', 'leaf', 'lane', 'park', 'ford', 'dale', 'mark',
  'zero', 'seven', 'nine', 'jack', 'ace', 'gene', 'bill', 'will', 'bob',
  'shin', 'gin', 'ren', 'jin', 'kai', 'dan', 'ken'
]);

/**
 * Non-name descriptions returned by anime databases (AniList, MAL, Jikan)
 * describing family relations, generic professions, extras, or unnamed background entities.
 */
const DESCRIPTION_PATTERNS: RegExp[] = [
  // Japanese relation descriptions (e.g. "Kyon no Imouto", "Tanaka no Haha")
  /\bno\s+(?:imouto|ane|haha|chichi|otouto|ani|sensei|tomodachi|hahaoya|chichioya)\b/i,
  // English possessive descriptions (e.g. "X's sister", "Hero's mother")
  /\b's\s+(?:sister|brother|mother|father|friend|daughter|son|boss|maid|butler|driver|cat|dog|pet)\b/i,
  // Generic background extras / roles
  /^(?:townsperson|villager|narrator|announcer|student|teacher|doctor|nurse|father|mother|parent|guard|soldier|driver|waiter|waitress|clerk|crowd|passerby|thug|citizen|police|officer|demon|monster|cat|dog|bird|boy|girl|man|woman|child|kid|extra|subordinate|operator|maid|butler|host|cashier|elder|old\s+man|old\s+woman|class\s*rep|student\s*council\s*president)\b/i,
  // Single generic role titles with letters/numbers (e.g. "Male Student A", "Villager 1", "Female Teacher")
  /^(?:male|female)?\s*(?:student|teacher|doctor|nurse|villager|soldier|guard|thug|citizen|customer|clerk|boy|girl|man|woman)\s*[a-z0-9]?$/i,
  // Pet/animal/inanimate names commonly listed in anime casts (e.g. "Shamisen" in Haruhi)
  /^(?:shamisen|ein|pen\s*pen|shiro|kuro|tama|pakkun|sadaharu|chopper|akaru)\b/i,
];

/**
 * Formal titles and honors stripped to get clean spoken names.
 */
const TITLE_PREFIX_REGEX = /^(?:Captain|Capt\.|Dr\.|Doctor|Prof\.|Professor|Lord|Lady|King|Queen|Princess|Prince|General|Gen\.|Commander|Cmdr\.|Agent|Inspector|Detective|Officer|Father|Mother|Sister|Brother|President|Mayor|Baron|Count|Duke)\s+/i;

/**
 * Japanese honorifics stripped if present in text strings.
 */
const HONORIFIC_SUFFIX_REGEX = /-(?:san|kun|chan|sama|senpai|sensei|dono|shi)\b/gi;

/**
 * Normalizes an anime character record into a clean spoken name and full name.
 * Returns null if the character entry is a description or generic background entity.
 */
export function normalizeCharacter(edge: RawCharacterEdge): NormalizedCharacter | null {
  const node = edge.node;
  if (!node || !node.name) return null;

  const rawFull = (node.name.full || node.name.userPreferred || '').trim();
  const rawFirst = (node.name.first || '').trim();
  const rawLast = (node.name.last || '').trim();

  let working = rawFull || [rawFirst, rawLast].filter(Boolean).join(' ');
  if (!working) return null;

  // Strip parentheses e.g. "(Young)", "(Child)", "(Past)", "(Voice)", "(Narrator)"
  working = working.replace(/\s*\([^)]*\)/g, '').trim();

  // Strip honorifics e.g. "-kun", "-san", "-sensei"
  working = working.replace(HONORIFIC_SUFFIX_REGEX, '').trim();

  // Strip formal titles e.g. "Captain Levi" -> "Levi"
  working = working.replace(TITLE_PREFIX_REGEX, '').trim();

  // Clean excess whitespace
  working = working.replace(/\s+/g, ' ').trim();

  if (working.length < 2 || working.length > 40) return null;

  // Drop descriptions and non-name entries
  for (const pattern of DESCRIPTION_PATTERNS) {
    if (pattern.test(working)) {
      return null;
    }
  }

  // Handle Japanese name reversal: "Yeager Eren" -> "Eren Yeager"
  // When API supplies first & last, check if full was formatted in reverse (surname first)
  let cleanFirst = rawFirst.replace(/\s*\([^)]*\)/g, '').trim();
  let cleanLast = rawLast.replace(/\s*\([^)]*\)/g, '').trim();

  if (cleanFirst && cleanLast) {
    const reverseOrder = `${cleanLast} ${cleanFirst}`;
    if (working.toLowerCase() === reverseOrder.toLowerCase() || working.includes(',')) {
      working = `${cleanFirst} ${cleanLast}`;
    }
  }

  // Determine commonly spoken name:
  // If first and last name exist, spoken name defaults to first name (e.g. "Haruhi" for "Haruhi Suzumiya").
  // If only one name exists, spoken name is that name (e.g. "Kyon", "Levi", "Tsuruya").
  let spoken = cleanFirst || working.split(' ')[0] || working;
  if (spoken.length < 2) {
    spoken = working;
  }

  const roleRaw = (edge.role || '').toUpperCase();
  const role: 'MAIN' | 'SUPPORTING' | 'BACKGROUND' =
    roleRaw === 'MAIN' ? 'MAIN' : roleRaw === 'SUPPORTING' ? 'SUPPORTING' : 'BACKGROUND';

  const isAmbiguous = AMBIGUOUS_ANIME_NAMES.has(spoken.toLowerCase()) || AMBIGUOUS_ANIME_NAMES.has(working.toLowerCase());

  return {
    fullName: working,
    spokenName: spoken,
    role,
    isAmbiguous,
    priority: role === 'MAIN' ? 1 : role === 'SUPPORTING' ? 2 : 3,
  };
}

/**
 * Filter, dedupe, and prioritize characters according to dub transcription requirements:
 * 1. Filter out BACKGROUND characters.
 * 2. MAIN characters first, then SUPPORTING.
 * 3. Ambiguous English names placed at the end.
 * 4. Dedupe by lowercase name.
 * 5. Cap at maxCandidates (default: 18).
 */
export function prioritizeCharacters(
  rawEdges: RawCharacterEdge[],
  maxCandidates: number = 18
): NormalizedCharacter[] {
  const normalizedList: NormalizedCharacter[] = [];
  const seen = new Set<string>();

  for (const edge of rawEdges) {
    const norm = normalizeCharacter(edge);
    if (!norm) continue;

    // Skip background / episodic characters
    if (norm.role === 'BACKGROUND') continue;

    const key = norm.fullName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    normalizedList.push(norm);
  }

  // Sort:
  // 1. Role: MAIN (1) before SUPPORTING (2)
  // 2. Ambiguity: Non-ambiguous before ambiguous
  // 3. Stable original order preserved for equal rank
  normalizedList.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.isAmbiguous !== b.isAmbiguous) return a.isAmbiguous ? 1 : -1;
    return 0;
  });

  return normalizedList.slice(0, maxCandidates);
}

/**
 * Estimates token count for Whisper's BPE tokenizer (GPT-2 vocabulary).
 * English words: 1 token for short words, ~word.length / 3.5 for longer/Japanese names,
 * plus 1 token per punctuation mark.
 */
export function estimateWhisperTokens(text: string): number {
  if (!text || !text.trim()) return 0;

  const words = text.trim().split(/\s+/);
  let tokenCount = 0;

  for (const w of words) {
    // Strip trailing punctuation from word body
    const cleanWord = w.replace(/^[^\w]+|[^\w]+$/g, '');
    const punctMatches = w.match(/[.,!?;:"'—–()[\]{}]/g);
    const punctCount = punctMatches ? punctMatches.length : 0;

    if (cleanWord.length > 0) {
      if (cleanWord.length <= 4) {
        tokenCount += 1;
      } else if (cleanWord.length <= 7) {
        tokenCount += 2;
      } else {
        tokenCount += Math.max(2, Math.ceil(cleanWord.length / 3.5));
      }
    }
    tokenCount += punctCount;
  }

  return tokenCount;
}

export interface PromptBuildOptions {
  /** Maximum token budget (default: 180, Whisper hard limit is ~223) */
  maxTokens?: number;
  /** Number of top characters receiving full name instead of spoken/first name (default: 3) */
  fullNameTopCount?: number;
  /** Template prefix (default: "Dialogue from an anime episode.") */
  baseSentence?: string;
}

/**
 * Builds the Whisper initial prompt for English anime dubs.
 *
 * Invariants:
 * - Natural template: "Dialogue from an anime episode. Characters: {names}."
 * - Strict token budget <= 180 tokens.
 * - Top ~3 characters get full name; remaining characters get spoken name.
 * - Never includes instructional commands like "clean subtitles".
 */
export function buildInitialPrompt(
  characters: NormalizedCharacter[],
  options: PromptBuildOptions = {}
): string {
  const maxTokens = options.maxTokens ?? 180;
  const fullNameTopCount = options.fullNameTopCount ?? 3;
  const baseSentence = options.baseSentence ?? 'Dialogue from an anime episode.';

  if (!characters || characters.length === 0) {
    return baseSentence;
  }

  const prefix = `${baseSentence} Characters: `;
  const suffix = '.';
  const baseTokens = estimateWhisperTokens(`${prefix}${suffix}`);

  if (baseTokens >= maxTokens) {
    return baseSentence;
  }

  const selectedNames: string[] = [];

  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    // Length trimming: top 3 get full name, rank 4+ get spoken/first name
    const nameToUse = i < fullNameTopCount ? char.fullName : char.spokenName;

    const candidateList = [...selectedNames, nameToUse];
    const candidatePrompt = `${prefix}${candidateList.join(', ')}${suffix}`;
    const tokenEst = estimateWhisperTokens(candidatePrompt);

    if (tokenEst <= maxTokens) {
      selectedNames.push(nameToUse);
    } else {
      // Budget reached; stop adding names to preserve token limit
      break;
    }
  }

  if (selectedNames.length === 0) {
    return baseSentence;
  }

  return `${prefix}${selectedNames.join(', ')}${suffix}`;
}

/**
 * Builds the Faster-Whisper hotwords string.
 * Passes the top 10-15 character names as a single comma-separated string.
 */
export function buildHotwords(
  characters: NormalizedCharacter[],
  maxHotwords: number = 12
): string {
  if (!characters || characters.length === 0) return '';
  const names = characters.slice(0, maxHotwords).map((c, idx) => {
    // Top 3 characters full name, rest spoken name
    return idx < 3 ? c.fullName : c.spokenName;
  });
  return names.join(', ');
}

/**
 * Extracts a complete list of unique character names (full, spoken, and alternatives)
 * to be used by fuzzy post-processing, unconstrained by prompt token limits.
 */
export function buildFullCharacterNameList(characters: NormalizedCharacter[]): string[] {
  const set = new Set<string>();
  for (const c of characters) {
    if (c.fullName) set.add(c.fullName);
    if (c.spokenName) set.add(c.spokenName);
  }
  return Array.from(set);
}
