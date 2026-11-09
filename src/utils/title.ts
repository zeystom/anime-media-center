export type TitleLanguagePreference = 'english' | 'romaji' | 'native';

/**
 * Checks whether a text string looks like an English / Latin title
 * rather than raw Japanese Kana/Kanji or Korean Hangul.
 */
export function isEnglishLikeTitle(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  // If it has Japanese Hiragana/Katakana, Kanji, or Korean Hangul, it's not English
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(trimmed)) return false;
  // Must contain at least one Latin letter
  return /[a-zA-Z]/.test(trimmed);
}

/**
 * Given a list of synonyms, finds the most descriptive English-like candidate.
 */
export function pickEnglishSynonym(synonyms?: string[] | null): string | null {
  if (!Array.isArray(synonyms) || synonyms.length === 0) return null;
  const candidates = synonyms.filter(isEnglishLikeTitle);
  if (candidates.length === 0) return null;
  // Prefer longer, descriptive English titles over 2-3 letter acronyms
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

/**
 * Resolves the display title for an anime based on user language preference.
 * - 'english' (default): prefers official english title -> english synonym -> romaji -> native
 * - 'romaji': prefers romaji -> english -> native
 * - 'native': prefers native (Japanese script) -> romaji -> english
 */
export function resolveAnimeTitle(
  title?: { english?: string | null; romaji?: string | null; native?: string | null } | null,
  synonyms?: string[] | null,
  preference: TitleLanguagePreference = 'english'
): string {
  if (!title) return '';

  const en = title.english?.trim() || '';
  const ro = title.romaji?.trim() || '';
  const nat = title.native?.trim() || '';

  if (preference === 'native') {
    return nat || ro || en || '';
  }

  if (preference === 'romaji') {
    return ro || en || nat || '';
  }

  // English preference (default)
  if (en) return en;

  // If official english is missing, inspect synonyms for an English localized name
  const bestSynonym = pickEnglishSynonym(synonyms);
  if (bestSynonym) return bestSynonym;

  return ro || nat || '';
}
