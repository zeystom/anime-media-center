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

function htmlToText(raw: string): string {
  return raw
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|tr|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, value: string) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value: string) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

const DUAL_AUDIO_RE = /\b(?:dual[-_\s]*audio|multi[-_\s]*audio)\b/i
const MULTI_SUBS_RE = /\b(?:multi[-_\s]*subs?|multisubs?)\b/i

function explicitAudioLabel(text: string, aliases: string): boolean {
  const language = `(?:${aliases})`
  return new RegExp(`\\b${language}\\s+(?:(?:dual|multi)\\s+)?(?:audio|dub(?:bed)?|voice(?:\s+track)?)\\b`, 'i').test(text)
    || new RegExp(`\\b(?:audio|dub(?:bed)?|voice(?:\s+track)?)\\s*(?:in|:|-)?\\s*${language}\\b`, 'i').test(text)
    || new RegExp(`\\b${language}\\b[^\\n.;]{0,40}\\b(?:audio|dub(?:bed)?|voice|track)\\b`, 'i').test(text)
    || new RegExp(`\\b(?:audio|dub(?:bed)?|voice|tracks?|languages?)\\b[^\\n.;]{0,55}\\b${language}\\b`, 'i').test(text)
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
    const subtitleMention = new RegExp(`\\b${token}\\s+(?:soft\\s*)?(?:subs?|subtitles?|captions?)\\b`, 'i').test(text)
      || new RegExp(`\\b(?:subs?|subtitles?|captions?)\\s*(?:in|:|-)?\\s*${token}\\b`, 'i').test(text)
    if (subtitleMention) codes.add(language.code)
  }
  return [...codes]
}

function detectSubtitle(text: string): 'Dubtitles' | 'English Subs' | 'Multi-Subs' | null {
  if (/\b(?:english\s+)?dubtitles?\b/i.test(text) || /\benglish\s+(?:sdh|closed\s+captions?|cc)\b/i.test(text)) {
    return 'Dubtitles'
  }
  if (/\b(?:english|eng)\s*(?:soft\s*)?subs?\b/i.test(text)
    || /\b(?:english|eng)\s+subtitles?\b/i.test(text)
    || /\bsubtitles?\s*(?:in|:|-)?\s*(?:english|eng)\b/i.test(text)) {
    return 'English Subs'
  }
  if (MULTI_SUBS_RE.test(text)) {
    return 'Multi-Subs'
  }
  return null
}

function detectKind(title: string, parsed: ReturnType<typeof parseReleaseCore>): Pick<ReleaseClassification, 'kind' | 'kindLabel'> {
  const text = htmlToText(title)
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

/** Conservatively classify only explicit language/audio and subtitle claims. */
export function classifyRelease(title: string, description?: string | null): ReleaseClassification {
  const searchableText = htmlToText(`${title} ${description ?? ''}`).slice(0, 80_000)
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

/** Convert a fetched or RSS HTML snippet into bounded plain text. */
export function releaseDescriptionToText(raw: string | null | undefined): string {
  return raw ? htmlToText(raw).slice(0, 20_000) : ''
}
