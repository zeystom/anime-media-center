import { parseReleaseCore } from './regexEngine.ts'

export type ReleaseLanguageGroup = 'eng-dub-dubtitles' | 'eng-dub-subs' | 'eng-dub' | 'japanese' | 'other' | 'unknown'
export type ReleaseKind = 'episode' | 'episode-range' | 'season-pack' | 'movie' | 'ova' | 'special' | 'unknown'
export type TorrentLanguageCode = 'en' | 'ja' | 'de' | 'fr' | 'es' | 'it' | 'ru' | 'pt' | 'zh' | 'ko'
export const TORRENT_LANGUAGES: Array<{ code: TorrentLanguageCode; label: string }> = [
  { code: 'en', label: 'English' }, { code: 'ja', label: 'Japanese' }, { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' }, { code: 'es', label: 'Spanish' }, { code: 'it', label: 'Italian' },
  { code: 'ru', label: 'Russian' }, { code: 'pt', label: 'Portuguese' }, { code: 'zh', label: 'Chinese' },
  { code: 'ko', label: 'Korean' },
]

export interface ReleaseClassification {
  languageGroup: ReleaseLanguageGroup
  audioLabels: string[]
  audioLanguageCodes: TorrentLanguageCode[]
  subtitleLanguageCodes: TorrentLanguageCode[]
  subtitleLabel: string | null
  kind: ReleaseKind
  kindLabel: string | null
  rank: number
  hasLanguageInfo: boolean
}

const AUDIO_LANGUAGES: Array<{ code: TorrentLanguageCode; label: string; aliases: string }> = [
  { code: 'en', label: 'English Dub', aliases: 'english|eng' },
  { code: 'ja', label: 'Japanese Audio', aliases: 'japanese|jpn|jap' },
  { code: 'de', label: 'German Audio', aliases: 'german|deutsch|ger' },
  { code: 'fr', label: 'French Audio', aliases: 'french|français|francais|fre|fra' },
  { code: 'es', label: 'Spanish Audio', aliases: 'spanish|español|espanol|spa' },
  { code: 'it', label: 'Italian Audio', aliases: 'italian|ita' },
  { code: 'ru', label: 'Russian Audio', aliases: 'russian|rus' },
  { code: 'pt', label: 'Portuguese Audio', aliases: 'portuguese|português|portugues|por|pt-br' },
  { code: 'zh', label: 'Chinese Audio', aliases: 'chinese|mandarin|chs|cht' },
  { code: 'ko', label: 'Korean Audio', aliases: 'korean|kor' },
]

export function decodeHtmlEntities(raw: string): string {
  return String(raw || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, value: string) => {
      const code = Number(value)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _
    })
    .replace(/&#x([\da-f]+);/gi, (_, value: string) => {
      const code = parseInt(value, 16)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function htmlToText(raw: string): string {
  const cleaned = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/<(head|script|style|nav|header|footer|select|form|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '\n')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|tr|h[1-6]|pre|blockquote)\s*>|<hr\b[^>]*>/gi, '\n')
    .replace(/<\/?(?:b|strong|i|em|u|s|code|span|a|small|sup|sub|font|mark|abbr)\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
  return decodeHtmlEntities(cleaned)
    .replace(/\*\*|__/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const DUAL_AUDIO_RE = /\b(?:dual[-_\s]*audio|multi[-_\s]*audio)\b/i
const MULTI_SUBS_RE = /\b(?:multi[-_\s]*subs?|multisubs?)\b/i

function explicitAudioLabel(text: string, aliases: string): boolean {
  const language = `(?:${aliases})`
  const nonAudioFollow = `(?!\\s*[-–—_]?\\s*(?:soft\\s*)?(?:subs?|subtitles?|captions?|signs?(?:\\s*\\/\\s*songs?)?|songs?|translated|translation))`
  const leadWindow = `(?:(?!\\b(?:subtitles?|subs?|captions?|video|source|literature|raw|menu)\\b)[^\\n.;]){0,55}`
  const trailWindow = `(?:(?!\\b(?:subtitles?|subs?|captions?|video|source|literature|raw|menu)\\b)[^\\n.;]){0,40}`
  const patterns = [
    new RegExp(`\\b${language}${nonAudioFollow}\\s+(?:(?:dual|multi)\\s+)?(?:audio|dub(?:bed)?|voice(?:\\s+track)?)\\b`, 'i'),
    new RegExp(`\\b(?:audio|dub(?:bed)?|voice(?:\\s+track)?)\\b[^\\S\\n]*(?:in|:|[-–—])?[^\\S\\n]*${language}${nonAudioFollow}\\b`, 'i'),
    new RegExp(`\\b${language}${nonAudioFollow}\\b${trailWindow}\\b(?:audio|dub(?:bed)?|voice|track)\\b`, 'i'),
    new RegExp(`\\b(?:audio|dub(?:bed)?|voice|tracks?|languages?)\\b${leadWindow}\\b${language}${nonAudioFollow}\\b`, 'i'),
  ]
  return String(text || '')
    .split('\n')
    .some((line) => patterns.some((re) => re.test(line)))
}

function detectLanguages(text: string): string[] {
  const labels: string[] = []
  for (const language of AUDIO_LANGUAGES) {
    if (explicitAudioLabel(text, language.aliases)) labels.push(language.label)
  }
  if (DUAL_AUDIO_RE.test(text)) {
    if (!labels.includes('English Dub')) labels.push('English Dub')
    if (!labels.includes('Japanese Audio')) labels.push('Japanese Audio')
  }
  return labels
}

function detectAudioLanguageCodes(text: string): TorrentLanguageCode[] {
  const codes = new Set<TorrentLanguageCode>(
    AUDIO_LANGUAGES.filter((language) => explicitAudioLabel(text, language.aliases)).map((language) => language.code)
  )
  if (DUAL_AUDIO_RE.test(text)) {
    codes.add('en')
    codes.add('ja')
  }
  return [...codes]
}

function detectSubtitleLanguageCodes(text: string): TorrentLanguageCode[] {
  const codes = new Set<TorrentLanguageCode>()
  if (/\b(?:english\s+)?dubtitles?\b/i.test(text) || /\benglish\s+(?:sdh|closed\s+captions?|cc)\b/i.test(text)) codes.add('en')
  if (MULTI_SUBS_RE.test(text)) codes.add('en')
  for (const language of AUDIO_LANGUAGES) {
    const token = `(?:${language.aliases})`
    const subtitleMention = new RegExp(`\\b${token}(?:[-–—/_ \\t]+|(?=(?:soft)?(?:subs?|subtitles?|captions?)\\b))(?:soft[-–—_ \\t]*)?(?:subs?|subtitles?|captions?)\\b`, 'i').test(text)
      || new RegExp(`\\b(?:subs?|subtitles?|captions?)[^\\S\\n]*(?:in|:|[-–—])?[^\\S\\n]*${token}(?:\\b|(?=_))`, 'i').test(text)
    if (subtitleMention) codes.add(language.code)
  }
  return [...codes]
}

function detectSubtitle(text: string): 'Dubtitles' | 'English Subs' | 'Multi-Subs' | null {
  if (/\b(?:english\s+)?dubtitles?\b/i.test(text) || /\benglish\s+(?:sdh|closed\s+captions?|cc)\b/i.test(text)) {
    return 'Dubtitles'
  }
  if (/\b(?:english|eng)[-–—/_ \t]*(?:soft[-–—_ \t]*)?(?:subs?|subtitles?)\b/i.test(text)
    || /\bsubtitles?[^\S\n]*(?:in|:|[-–—])?[^\S\n]*(?:english|eng)\b/i.test(text)) {
    return 'English Subs'
  }
  if (MULTI_SUBS_RE.test(text)) {
    return 'Multi-Subs'
  }
  return null
}

function detectKind(title: string, parsed: ReturnType<typeof parseReleaseCore>): Pick<ReleaseClassification, 'kind' | 'kindLabel'> {
  const text = htmlToText(title)
  const explicitSeasons = Array.from(text.matchAll(/\bseasons?\s*0*(\d{1,2})\b/gi), (match) => Number(match[1]))
  // Multi-content collections ("(Season 01 + Season 02 + Movie + OVA +
  // Specials)", "1-26+OVA Complete") must classify as a season pack, not as
  // the Movie/OVA mentioned inside the contents list. A collection marker or
  // two distinct content kinds in one title means the release is a batch.
  const contentTokenTests = [
    /\bseasons?\s*0*\d{1,2}\b/i,
    /\b(?:movie|film|gekijouban|gekijōban)\b/i,
    /\b(?:ova|oad)\b/i,
    /\b(?:specials?)\b/i,
  ]
  const contentTokenCount = contentTokenTests.filter((re) => re.test(text)).length
  const isCollection = contentTokenCount >= 2
    || /\b(?:batch|season\s*pack|complete(?:d)?(?:\s+(?:series|season|collection))?|full\s+season|complete\s+series|collection)\b/i.test(text)
  if (isCollection) {
    const isMultiSeason = new Set(explicitSeasons).size > 1
    const isWholeSeries = isMultiSeason || /\bcomplete\s+series\b/i.test(text)
    return { kind: 'season-pack', kindLabel: isWholeSeries ? 'Complete series pack' : parsed.season != null ? `Season ${parsed.season} pack` : 'Season pack' }
  }
  if (/\b(?:movie|film|gekijouban|gekijōban|theatrical)\b/i.test(text) || parsed.releaseType === 'Movie') {
    return { kind: 'movie', kindLabel: 'Movie' }
  }
  if (/\b(?:ova|o\s*a\s*v|oad)\b/i.test(text) || parsed.releaseType === 'OVA' || parsed.releaseType === 'OAD') {
    return { kind: 'ova', kindLabel: parsed.releaseType === 'OAD' ? 'OAD' : 'OVA' }
  }
  if (/\b(?:special|\bsp\b)\b/i.test(text) || parsed.releaseType === 'SP') return { kind: 'special', kindLabel: 'Special' }
  if (/\b(?:batch|season\s*pack|complete(?:d)?(?:\s+(?:series|season|collection))?|full\s+season)\b/i.test(text)) {
    return { kind: 'season-pack', kindLabel: parsed.season != null ? `Season ${parsed.season} pack` : 'Season pack' }
  }
  if (parsed.episodeNumbers.length > 1) {
    return {
      kind: 'episode-range',
      kindLabel: `Episodes ${String(parsed.episodeNumbers[0]).padStart(2, '0')}–${String(parsed.episodeNumbers[parsed.episodeNumbers.length - 1]).padStart(2, '0')}`,
    }
  }
  if (parsed.episodeNumber != null) return { kind: 'episode', kindLabel: `Episode ${String(parsed.episodeNumber).padStart(2, '0')}` }
  return { kind: 'unknown', kindLabel: null }
}

/** True for collections that explicitly bundle more than one numbered season:
 *  spelled-out forms ("Season 01 + Season 02") and short ones ("S01+02",
 *  "S1 S2"). The plus-number shape only counts numbers directly attached to a
 *  `+` separator, so "1-13+OVA" stays a single-season range. */
export function isMultiSeasonCollection(title: string | null | undefined): boolean {
  if (typeof title !== 'string' || !title) return false
  const text = htmlToText(title)
  const seasons = Array.from(text.matchAll(/\bseasons?\s*0*(\d{1,2})\b/gi), (match) => Number(match[1]))
    .concat(Array.from(text.matchAll(/\bs\s*0*(\d{1,2})\b/gi), (match) => Number(match[1])))
    .concat(Array.from(text.matchAll(/\+\s*0*(\d{1,2})\b/g), (match) => Number(match[1])))
  return new Set(seasons).size > 1
}

/** Conservatively classify only explicit language/audio and subtitle claims. */
export function classifyRelease(title: string, description?: string | null): ReleaseClassification {
  const searchableText = htmlToText(`${title}\n${description ?? ''}`).slice(0, 80_000)
  const parsed = parseReleaseCore(title)
  const audioLabels = detectLanguages(searchableText)
  const audioLanguageCodes = detectAudioLanguageCodes(searchableText)
  const subtitleLanguageCodes = detectSubtitleLanguageCodes(searchableText)
  const englishDub = audioLabels.includes('English Dub')
  const japanese = audioLabels.includes('Japanese Audio')
  const subtitleLabel = detectSubtitle(searchableText)
  const hasEnglishSubs = subtitleLabel === 'English Subs' || subtitleLabel === 'Multi-Subs'

  let languageGroup: ReleaseLanguageGroup = 'unknown'
  let rank = 5
  if (englishDub && subtitleLabel === 'Dubtitles') {
    languageGroup = 'eng-dub-dubtitles'
    rank = 0
  } else if (englishDub && hasEnglishSubs) {
    languageGroup = 'eng-dub-subs'
    rank = 1
  } else if (englishDub) {
    languageGroup = 'eng-dub'
    rank = 2
  } else if (japanese && hasEnglishSubs) {
    languageGroup = 'japanese'
    rank = 2
  } else if (japanese && audioLabels.length === 1) {
    languageGroup = 'japanese'
    rank = 3
  } else if (audioLabels.length > 0 || subtitleLabel) {
    languageGroup = 'other'
    rank = 4
  }

  return {
    languageGroup,
    audioLabels,
    audioLanguageCodes,
    subtitleLanguageCodes,
    subtitleLabel,
    ...detectKind(title, parsed),
    rank,
    hasLanguageInfo: audioLabels.length > 0 || subtitleLabel != null,
  }
}

/**
 * Extract season number from an anime or release title:
 * - "Season 2", "Season 02"
 * - "2nd Season", "3rd Season"
 * - "S2", "S02"
 * - Roman numerals: "II", "III", "IV", "V", ... (e.g. "Mob Psycho 100 II")
 * - Trailing single digit preceded by separator/space: "Cyberpunk: Edgerunners 2", "KonoSuba 2"
 */
export function detectSeasonFromTitle(title: string | null | undefined): number | null {
  if (!title || typeof title !== 'string') return null
  const t = title.trim()

  // 1. Explicit named season: "Season 2", "Season 02"
  const seasonNamed = /\bseason\s*0*(\d{1,2})\b/i.exec(t)
  if (seasonNamed) return Number(seasonNamed[1])

  // 2. Ordinal season: "2nd Season", "3rd Season", "4th Season"
  const seasonOrdinal = /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i.exec(t)
  if (seasonOrdinal) return Number(seasonOrdinal[1])

  // 3. Short marker: " S2", " S02", "(S2)", "[S2]"
  const seasonShort = /(?:^|\s|[([_-])S0*(\d{1,2})(?:\s*[([\]_)-]|$)/i.exec(t)
  if (seasonShort) return Number(seasonShort[1])

  // 4. Roman numerals at end of title: " II", " III", " IV", " V", " VI", " VII", " VIII", " IX", " X"
  const romanMatch = /(?:^|\s|[([:_-])(II|III|IV|V|VI|VII|VIII|IX|X)(?:\s*[([\])-]|$)/i.exec(t)
  if (romanMatch) {
    const romanMap: Record<string, number> = {
      II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10,
    }
    const val = romanMap[romanMatch[1].toUpperCase()]
    if (val) return val
  }

  // 5. Trailing single digit (2-9) preceded by separator (e.g. ": 2", " - 2", " 2"):
  // "Cyberpunk: Edgerunners 2", "KonoSuba 2", "Love Live! 2"
  const trailingDigit = /(?:[:–—-]|\s)\s*([2-9])\s*$/.exec(t)
  if (trailingDigit) {
    const num = Number(trailingDigit[1])
    if (num >= 2 && num <= 9) return num
  }

  return null
}

/**
 * Resolution rank:
 * 4320p / 8K -> 5
 * 2160p / 4K / UHD -> 4
 * 1440p / 2K -> 3
 * 1080p -> 2
 * 720p -> 1
 * other -> 0
 */
export function qualityRank(title: string | null | undefined, parsedResolution?: string | null): number {
  const resolution = ((parsedResolution || '') + ' ' + (title || '')).toLowerCase()
  if (/\b(?:4320p|8k)\b/i.test(resolution)) return 5
  if (/\b(?:2160p|4k|uhd)\b/i.test(resolution)) return 4
  if (/\b(?:1440p|2k)\b/i.test(resolution)) return 3
  if (/\b1080p\b/i.test(resolution)) return 2
  if (/\b720p\b/i.test(resolution)) return 1
  return 0
}

function extractTorrentDescriptionHtml(raw: string): string | null {
  const openMatch = /<div\b[^>]*\bid=["']torrent-description["'][^>]*>/i.exec(raw)
  if (!openMatch) return null
  const contentStart = openMatch.index + openMatch[0].length
  const divTagRe = /<\/?div\b[^>]*>/gi
  divTagRe.lastIndex = contentStart
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = divTagRe.exec(raw)) !== null) {
    if (/^<\/div/i.test(match[0])) {
      depth -= 1
      if (depth === 0) {
        return raw.slice(contentStart, match.index)
      }
    } else if (!/\/>$/.test(match[0])) {
      depth += 1
    }
  }
  return raw.slice(contentStart)
}

/** Convert a fetched or RSS HTML snippet into bounded plain text. */
export function releaseDescriptionToText(raw: string | null | undefined): string {
  if (!raw) return ''
  const scoped = extractTorrentDescriptionHtml(raw) ?? raw
  return htmlToText(scoped).slice(0, 20_000)
}
