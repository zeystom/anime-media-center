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

const LANGUAGE_LABEL_MAP: Record<TorrentLanguageCode, string> = Object.fromEntries(
  TORRENT_LANGUAGES.map((entry) => [entry.code, entry.label]),
) as Record<TorrentLanguageCode, string>

export function getTorrentLanguageLabel(code: TorrentLanguageCode): string {
  return LANGUAGE_LABEL_MAP[code] || code.toUpperCase()
}

export interface ReleaseClassification {
  languageGroup: ReleaseLanguageGroup
  audioLabels: string[]
  audioLanguageCodes: TorrentLanguageCode[]
  subtitleLanguageCodes: TorrentLanguageCode[]
  subtitleLabels: string[]
  subtitleLabel: string | null
  hasDubtitles: boolean
  isDualAudio: boolean
  isMultiAudio: boolean
  isMultiSubs: boolean
  hasUnlistedMultiAudio: boolean
  hasUnlistedMultiSubs: boolean
  kind: ReleaseKind
  kindLabel: string | null
  rank: number
  hasLanguageInfo: boolean
}

interface LanguageDefinition {
  code: TorrentLanguageCode
  audioLabel: string
  subLabel: string
  wordAliases: string
  cjkAliases?: string
  shortCodes: string
  allCapsAliases?: string
}

const AUDIO_LANGUAGES: LanguageDefinition[] = [
  {
    code: 'en',
    audioLabel: 'English Dub',
    subLabel: 'English Subs',
    wordAliases: 'english|eng|английский|английская|английские|англ',
    shortCodes: 'en',
  },
  {
    code: 'ja',
    audioLabel: 'Japanese Audio',
    subLabel: 'Japanese Subs',
    wordAliases: 'japanese|jpn|jap|японский|японская|японские|яп',
    cjkAliases: '日本語',
    shortCodes: 'ja|jp',
  },
  {
    code: 'de',
    audioLabel: 'German Audio',
    subLabel: 'German Subs',
    wordAliases: 'german|deutsch|ger|deu|немецкий|немецкая|немецкие',
    shortCodes: 'de',
  },
  {
    code: 'fr',
    audioLabel: 'French Audio',
    subLabel: 'French Subs',
    wordAliases: 'french|français|francais|fre|fra|truefrench|vff|vfq|французский|французская|французские',
    shortCodes: 'fr',
  },
  {
    code: 'es',
    audioLabel: 'Spanish Audio',
    subLabel: 'Spanish Subs',
    wordAliases: 'spanish|español|espanol|spa|esp|castellano|latino|испанский|испанская|испанские',
    shortCodes: 'es',
  },
  {
    code: 'it',
    audioLabel: 'Italian Audio',
    subLabel: 'Italian Subs',
    wordAliases: 'italian|italiano|ita|итальянский|итальянская|итальянские',
    shortCodes: 'it',
  },
  {
    code: 'ru',
    audioLabel: 'Russian Audio',
    subLabel: 'Russian Subs',
    wordAliases: 'russian|rus|русский|русская|русские|рус',
    shortCodes: 'ru',
  },
  {
    code: 'pt',
    audioLabel: 'Portuguese Audio',
    subLabel: 'Portuguese Subs',
    wordAliases: 'portuguese|português|portugues|pt[-_]br|pt[-_]pt|brazilian|brasileiro|dublado|португальский|португальская|португальские',
    allCapsAliases: 'POR',
    shortCodes: 'pt',
  },
  {
    code: 'zh',
    audioLabel: 'Chinese Audio',
    subLabel: 'Chinese Subs',
    wordAliases: 'chinese|mandarin|cantonese|chs|cht|zho|chi|cmn|китайский|китайская|китайские',
    cjkAliases: '中文|简体|繁體',
    shortCodes: 'zh|cn',
  },
  {
    code: 'ko',
    audioLabel: 'Korean Audio',
    subLabel: 'Korean Subs',
    wordAliases: 'korean|kor|корейский|корейская|корейские',
    cjkAliases: '한국어',
    shortCodes: 'ko|kr',
  },
]

const LANGUAGE_DEF_BY_CODE = new Map<TorrentLanguageCode, LanguageDefinition>(
  AUDIO_LANGUAGES.map((def) => [def.code, def]),
)

const COMPILED_LANGUAGE_MATCHERS = AUDIO_LANGUAGES.map((def) => {
  const wordPart = `(?<![\\p{L}\\p{N}])(?:${def.wordAliases})(?![\\p{L}\\p{N}])`
  const longPattern = def.cjkAliases ? `(?:${wordPart}|${def.cjkAliases})` : wordPart
  const regionSuffix = '(?:-(?:br|pt|la|419|us|uk|gb|ca|mx|es|hans|hant|cn|tw|hk))?'
  const shortBody = `(?:${def.shortCodes})${regionSuffix}`
  const pureShortSources = [
    `^(?:${shortBody})(?=$|\\s|[([\\]|,;:/+-])`,
    `^[\\[(]\\s*(?:${shortBody})\\s*[\\])]$`,
  ]
  const allCapsParts = [def.shortCodes.toUpperCase() + regionSuffix.toUpperCase()]
  if (def.allCapsAliases) allCapsParts.push(def.allCapsAliases)
  return {
    def,
    longPattern,
    longRe: new RegExp(longPattern, 'iu'),
    pureShortReList: pureShortSources.map((src) => new RegExp(src, 'iu')),
    allCapsRe: new RegExp(`(?<![\\p{L}\\p{N}])(?:${allCapsParts.join('|')})(?![\\p{L}\\p{N}])`, 'u'),
    bracketShortRe: new RegExp(`[\\[(]\\s*(?:${shortBody}${def.allCapsAliases ? `|${def.allCapsAliases}` : ''})\\s*[\\])]`, 'iu'),
  }
})

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
    .replace(/<\/(?:td|th)\s*>/gi, ' | ')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|tr|h[1-6]|pre|blockquote)\s*>|<hr\b[^>]*>/gi, '\n')
    .replace(/<\/?(?:b|strong|i|em|u|s|code|span|a|small|sup|sub|font|mark|abbr|td|th)\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
  return decodeHtmlEntities(cleaned)
    .replace(/\*\*|__/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\| *(?=\n|$)/g, '')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripClassifierBoilerplate(text: string): string {
  return text
    .replace(/\bAnime\s*[-–—]\s*(?:Non-)?English-translated\b/gi, ' ')
    .replace(/\bLiterature\s*[-–—]\s*English\b/gi, ' ')
    .replace(/\bAudio\s*[-–—]\s*Loss(?:less|y)\b/gi, ' ')
}

const DUAL_AUDIO_RE = /\bdual[-_\s]*audio\b/i
const DUAL_TAG_RE = /(?:\[|\()\s*dual\s*(?:\]|\))/i
const SCENE_MEDIA_MARKER = '(?:2160p|1080p|720p|480p|web-?dl|webrip|bluray|bdrip|nf|cr|amzn|hdtv)'
const SCENE_AUDIO_CODEC_MARKER = '(?:ddp|aac|flac|ac3|eac3|dts|opus|h\\.?26[45]|x26[45]|hevc|av1)'
const DUAL_SCENE_TOKEN_RE = new RegExp(
  `(?:\\b${SCENE_MEDIA_MARKER}\\b.*\\.)dual(?=\\.|$)|\\.dual\\.(?=.*\\b(?:${SCENE_MEDIA_MARKER}|${SCENE_AUDIO_CODEC_MARKER})\\b)`,
  'i',
)
const MULTI_AUDIO_RE = /\bmulti[-_\s]*audio\b/i
const MULTI_TAG_RE = /(?:\[|\()\s*multi\s*(?:\]|\))/i
const MULTI_SCENE_TOKEN_RE = new RegExp(
  `(?:\\b${SCENE_MEDIA_MARKER}\\b.*\\.)multi(?=\\.(?!subs?\\b)|$)|\\.multi\\.(?!subs?\\b)(?=.*\\b(?:${SCENE_MEDIA_MARKER}|${SCENE_AUDIO_CODEC_MARKER})\\b)`,
  'i',
)
const MULTI_SUBS_RE = /\b(?:multi[-_\s]*subs?(?:titles?)?|multisubs?)\b/i

const SIGNS_MARKER_RE = /(?<![\p{L}\p{N}])(?:signs?(?:\s*(?:&|\/|\+|and)\s*songs?|\s*only)?|songs?|forced|op\s*\/\s*ed|надписи|форсированные)(?![\p{L}\p{N}])/iu
const DIALOGUE_MARKER_RE = /(?<![\p{L}\p{N}])(?:full|dialogue|complete|sdh|cc|dubtitles?|полные|диалоги)(?![\p{L}\p{N}])/iu
const EXPLICIT_SIGNS_SUB_RE = /(?<![\p{L}\p{N}])(?:signs?(?:\s*(?:&|\/|\+|and)\s*songs?|\s*only)?|forced)\s+(?:subs?|subtitles?)(?![\p{L}\p{N}])/iu
const DUBTITLES_RE = /(?<![\p{L}\p{N}])(?:(?:english\s+)?dubtitles?|english\s+(?:sdh|closed\s+captions?|cc)|sdh|closed\s+captions?)(?![\p{L}\p{N}])/iu

function isSignsOnlyText(text: string, forced = false): boolean {
  if (!text && !forced) return false
  if (DIALOGUE_MARKER_RE.test(text)) return false
  if (forced) return true
  if (EXPLICIT_SIGNS_SUB_RE.test(text)) return true
  if (!SIGNS_MARKER_RE.test(text)) return false
  // Allow phrases like "English Subtitles + Signs" when "subtitles/subs" appears
  // and isn't explicitly "Signs/Songs Subtitles" or "Signs Only".
  if (/(?<![\p{L}\p{N}])(?:subtitles?|subs?|субтитры)(?![\p{L}\p{N}])/iu.test(text)) {
    if (/(?<![\p{L}\p{N}])signs?\s*(?:only|track)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:signs?\s*(?:&|\/|\+|and)\s*songs?)(?![\p{L}\p{N}])/iu.test(text)) {
      return true
    }
    return false
  }
  return true
}

const TRACK_PREFIX_STRIP_RE = /^(?:[-*•+]|\d+[.)]|#\d+|track\s*\d+\s*[:.\-–—]?|stream\s*\d+\s*[:.\-–—]?|audio\s*#?\d*\s*[:.\-–—]?|sub(?:title)?s?\s*#?\d*\s*[:.\-–—]?)\s*/iu
const SUB_TAG_EDGE_STRIP_RE = /^(?:(?:soft|hard)?subs?(?:titles?)?|subtitles?)\s*[:.\-–—_]+\s*|\s*[:.\-–—_]+\s*(?:soft|hard)?subs?(?:titles?)?$/giu
const PURE_SHORT_TAIL_TOKENS_RE = /^(?:[\s([{\])}|,;:/+-]|(?:full|dialogue|dub(?:bed)?|audio|voice|track|original|soft|hard|subs?|subtitles?|captions?|sdh|cc|dubtitles?|forced|default|cr|nf|amzn|flac|aac|ac3|eac3|ddp(?:\d(?:\.\d)?)?|dts(?:-hd)?|opus|vorbis|mp3|pcm|ass|ssa|srt|pgs|vobsub|2\.0|5\.1|7\.1|16bit|24bit|kbps|\d+ch))+$/iu

function stripShortCodeCandidate(raw: string): string {
  return raw
    .trim()
    .replace(TRACK_PREFIX_STRIP_RE, '')
    .replace(SUB_TAG_EDGE_STRIP_RE, '')
    .replace(SUB_TAG_EDGE_STRIP_RE, '')
    .trim()
}

function isPureShortCodeItem(stripped: string, shortPattern: RegExp): boolean {
  const match = shortPattern.exec(stripped)
  if (!match) return false
  const tail = stripped.slice(match[0].length).trim()
  if (!tail) return true
  const withoutParens = tail.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').trim()
  if (!withoutParens) return true
  return PURE_SHORT_TAIL_TOKENS_RE.test(withoutParens)
}

function extractLanguageCodesFromListItem(rawItem: string): TorrentLanguageCode[] {
  const item = String(rawItem || '').trim()
  if (!item) return []
  const found = new Set<TorrentLanguageCode>()

  for (const matcher of COMPILED_LANGUAGE_MATCHERS) {
    if (matcher.longRe.test(item)) {
      found.add(matcher.def.code)
      continue
    }
    if (matcher.allCapsRe.test(item) || matcher.bracketShortRe.test(item)) {
      found.add(matcher.def.code)
    }
  }

  const stripped = stripShortCodeCandidate(item)
  if (stripped) {
    for (const matcher of COMPILED_LANGUAGE_MATCHERS) {
      if (found.has(matcher.def.code)) continue
      if (matcher.pureShortReList.some((re) => isPureShortCodeItem(stripped, re))) {
        found.add(matcher.def.code)
      }
    }
  }

  // Handle "por" only when pure/uppercase/bracketed (never "Subtitulado por Grupo").
  const porDef = LANGUAGE_DEF_BY_CODE.get('pt')
  if (porDef && !found.has('pt') && stripped && isPureShortCodeItem(stripped, /^por(?=$|\s|[([\]])/i)) {
    found.add('pt')
  }

  return [...found]
}

function extractLanguageCodesFromSlashOrPlus(raw: string): TorrentLanguageCode[] {
  const parts = raw.split(/\s*(?:\/|\+|&)\s*/).map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return extractLanguageCodesFromListItem(raw)
  const collected: TorrentLanguageCode[] = []
  for (const part of parts) {
    for (const code of extractLanguageCodesFromListItem(part)) {
      if (!collected.includes(code)) collected.push(code)
    }
  }
  return collected
}

function isPureMultiLanguageTag(clause: string): TorrentLanguageCode[] {
  const parts = clause.split(/\s*(?:\/|\+|&)\s*/).map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return []
  const codes: TorrentLanguageCode[] = []
  for (const part of parts) {
    const partCodes = extractLanguageCodesFromListItem(part)
    if (partCodes.length !== 1) return []
    const stripped = stripShortCodeCandidate(part)
    // Ensure the part itself is essentially a language token (not prose with a word inside)
    const matcher = COMPILED_LANGUAGE_MATCHERS.find((m) => m.def.code === partCodes[0])
    const looksPure = matcher
      ? (matcher.pureShortReList.some((re) => isPureShortCodeItem(stripped, re))
        || new RegExp(`^${matcher.longPattern}$`, 'iu').test(stripped))
      : false
    if (!looksPure) return []
    if (!codes.includes(partCodes[0])) codes.push(partCodes[0])
  }
  return codes.length >= 2 ? codes : []
}

function splitBalancedGroups(text: string): { groups: string[]; outsideSegments: string[] } {
  const groups: string[] = []
  const outsideSegments: string[] = []
  let outsideBuf = ''
  let groupBuf = ''
  const stack: string[] = []

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '[' || ch === '(') {
      if (stack.length === 0) {
        if (outsideBuf.trim()) outsideSegments.push(outsideBuf)
        outsideBuf = ''
        groupBuf = ''
      } else {
        groupBuf += ch
      }
      stack.push(ch === '[' ? ']' : ')')
    } else if (stack.length > 0 && ch === stack[stack.length - 1]) {
      stack.pop()
      if (stack.length === 0) {
        if (groupBuf.trim()) groups.push(groupBuf.trim())
        groupBuf = ''
      } else {
        groupBuf += ch
      }
    } else if (stack.length > 0) {
      groupBuf += ch
    } else {
      outsideBuf += ch
    }
  }
  if (outsideBuf.trim()) outsideSegments.push(outsideBuf)
  if (groupBuf.trim()) groups.push(groupBuf.trim())

  return { groups, outsideSegments }
}

const AUDIO_ROLE_RE = /(?<![\p{L}\p{N}])(?:audio|dub(?:bed)?|voice(?:\s+track)?|озвучка|звук)(?![\p{L}\p{N}])/iu
const SUB_ROLE_RE = /(?<![\p{L}\p{N}])(?:soft|hard)?subs?(?:titles?)?(?![\p{L}\p{N}])|(?:soft|hard|multi|eng|jpn|rus|ger|fre|fra|ita|spa|por)subs?(?:titles?)?|(?<![\p{L}\p{N}])(?:subtitles?|captions?|dubtitles?|sdh|closed\s+captions?|cc|субтитры)(?![\p{L}\p{N}])/iu

function applyRoleSegment(
  segment: string,
  explicitAudio: Set<TorrentLanguageCode>,
  explicitSubs: Set<TorrentLanguageCode>,
  setDubtitles: () => void,
): void {
  const trimmed = segment.trim()
  if (!trimmed) return

  if (DUBTITLES_RE.test(trimmed)) {
    setDubtitles()
    const codes = extractLanguageCodesFromSlashOrPlus(trimmed)
    if (codes.length > 0) {
      for (const code of codes) explicitSubs.add(code)
    } else {
      explicitSubs.add('en')
    }
    return
  }

  const hasSubRole = SUB_ROLE_RE.test(trimmed)
  const hasAudioRole = AUDIO_ROLE_RE.test(trimmed)

  if (hasSubRole && hasAudioRole) {
    const subParts = trimmed.split(/\s*(?:\/|\+|&)\s*/)
    if (subParts.length > 1) {
      for (const part of subParts) applyRoleSegment(part, explicitAudio, explicitSubs, setDubtitles)
      return
    }
  }

  if (hasSubRole) {
    if (isSignsOnlyText(trimmed)) return
    for (const code of extractLanguageCodesFromSlashOrPlus(trimmed)) {
      explicitSubs.add(code)
    }
    return
  }

  if (hasAudioRole) {
    for (const code of extractLanguageCodesFromSlashOrPlus(trimmed)) {
      explicitAudio.add(code)
    }
    return
  }

  const multiTagCodes = isPureMultiLanguageTag(trimmed)
  if (multiTagCodes.length >= 2) {
    for (const code of multiTagCodes) explicitAudio.add(code)
  }
}

function extractInlineProseMatches(
  text: string,
  explicitAudio: Set<TorrentLanguageCode>,
  explicitSubs: Set<TorrentLanguageCode>,
  setDubtitles: () => void,
): void {
  if (!text) return
  if (DUBTITLES_RE.test(text)) {
    setDubtitles()
    let matchedLang = false
    for (const matcher of COMPILED_LANGUAGE_MATCHERS) {
      const dubRe = new RegExp(`${matcher.longPattern}\\s+(?:dubtitles?|sdh|closed\\s+captions?|cc)\\b`, 'iu')
      if (dubRe.test(text)) {
        explicitSubs.add(matcher.def.code)
        matchedLang = true
      }
    }
    if (!matchedLang && /\b(?:english\s+)?dubtitles?\b|\benglish\s+(?:sdh|closed\s+captions?|cc)\b/iu.test(text)) {
      explicitSubs.add('en')
    }
  }

  const nonAudioFollow = `(?!\\s*[-–—_]?\\s*(?:soft\\s*)?(?:subs?|subtitles?|captions?|signs?(?:\\s*\\/\\s*songs?)?|songs?|translated|translation))`
  for (const matcher of COMPILED_LANGUAGE_MATCHERS) {
    const audioBeforeRe = new RegExp(
      `${matcher.longPattern}${nonAudioFollow}[\\s_-]*(?:(?:dual|multi)[\\s_-]*)?(?:audio|dub(?:bed)?|voice(?:\\s+track)?|озвучка|звук)(?![\\p{L}\\p{N}])`,
      'iu',
    )
    const audioAfterRe = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:audio|dub(?:bed)?|voice(?:\\s+track)?|озвучка|звук)(?![\\p{L}\\p{N}])[^\\S\\n]*(?:in|:|[-–—])?[^\\S\\n]*${matcher.longPattern}${nonAudioFollow}`,
      'iu',
    )
    if (audioBeforeRe.test(text) || audioAfterRe.test(text)) {
      explicitAudio.add(matcher.def.code)
    }

    const subBeforeRe = new RegExp(
      `${matcher.longPattern}(?:[-–—/_ \\t]+|(?=(?:soft|hard)?(?:subs?|subtitles?|captions?)\\b))(?:soft[-–—_ \\t]*)?(?:subs?|subtitles?|captions?|субтитры)(?![\\p{L}\\p{N}])`,
      'iu',
    )
    const subAfterRe = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:subs?|subtitles?|captions?|субтитры)(?![\\p{L}\\p{N}])[^\\S\\n]*(?:in|:|[-–—])?[^\\S\\n]*${matcher.longPattern}`,
      'iu',
    )
    if (subBeforeRe.test(text) || subAfterRe.test(text)) {
      if (!isSignsOnlyText(text)) {
        explicitSubs.add(matcher.def.code)
      }
    }
  }
}

function detectSpecialAnimeTags(
  text: string,
  explicitAudio: Set<TorrentLanguageCode>,
  explicitSubs: Set<TorrentLanguageCode>,
  flags: { isDualAudio: boolean },
): void {
  if (/\bVOSTFR\b/i.test(text)) {
    explicitAudio.add('ja')
    explicitSubs.add('fr')
  }
  if (/\b(?:VFF|VFQ|TRUEFRENCH)\b/i.test(text)) {
    explicitAudio.add('fr')
  }
  if (/\bDublado\b/i.test(text)) {
    explicitAudio.add('pt')
  }
  if (/\b(?:Castellano|Audio\s+Latino|Dual\s+Latino)\b/i.test(text)) {
    explicitAudio.add('es')
    if (/\bDual\s+Latino\b/i.test(text)) flags.isDualAudio = true
  }
  if (/(?<![\p{L}\p{N}])(?:русская\s+озвучка|озвучка\s*[:|-]?\s*рус)/iu.test(text)) {
    explicitAudio.add('ru')
  }
}

function parseTitleLanguages(
  cleanedTitle: string,
  explicitAudio: Set<TorrentLanguageCode>,
  explicitSubs: Set<TorrentLanguageCode>,
  setDubtitles: () => void,
): void {
  const { groups, outsideSegments } = splitBalancedGroups(cleanedTitle)
  for (const group of groups) {
    const clauses = group.split(/\s*[,;|]\s*/)
    for (const clause of clauses) {
      applyRoleSegment(clause, explicitAudio, explicitSubs, setDubtitles)
    }
  }
  for (const seg of outsideSegments) {
    extractInlineProseMatches(seg, explicitAudio, explicitSubs, setDubtitles)
  }
}

const OTHER_SECTION_HEADER_RE = /^(?:general|video|menu|chapters?|attachments?|source|encode|notes?|plot|synopsis|screenshots?|mediainfo|changelog|credits?|links?|info|release\s+info|файлы?|видео|описание|общие|информация)(?:\s*#?\d+)?\s*(?:[:|–—-].*)?$/iu
const STANDALONE_AUDIO_HEADER_RE = /^(?:audio(?:\s*(?:#?\d+|tracks?|streams?|languages?))?|sound|dubs?|voice(?:\s+tracks?)?|аудио(?:\s*#?\d+)?|звук(?:\s*#?\d+)?|озвучка|язык\s+озвучки)\s*[:=|–—-]?$/iu
const STANDALONE_SUB_HEADER_RE = /^(?:text(?:\s*#?\d+)?|subtitles?(?:\s*(?:#?\d+|tracks?|streams?|languages?))?|subs?(?:\s*(?:#?\d+|tracks?|languages?))?|captions?|субтитры(?:\s*#?\d+)?|язык\s+субтитров)\s*[:=|–—-]?$/iu
const INLINE_AUDIO_HEADER_RE = /^(?:(?:audio(?:\s*(?:#?\d+|tracks?|streams?|languages?))?|аудио(?:\s*#?\d+)?|озвучка|язык\s+озвучки)\s*(?:[:=|–—-]\s*|\s+(?=\S))|(?:sound|dubs?|voice(?:\s+tracks?)?|звук(?:\s*#?\d+)?)\s*[:=|–—-]\s*)(.+)$/iu
const INLINE_SUB_HEADER_RE = /^(?:(?:subtitles?(?:\s*(?:#?\d+|tracks?|streams?|languages?))?|subs?(?:\s*(?:#?\d+|tracks?|languages?))?|субтитры(?:\s*#?\d+)?|язык\s+субтитров)\s*(?:[:=|–—-]\s*|\s+(?=\S))|(?:text(?:\s*#?\d+)?|captions?)\s*[:=|–—-]\s*)(.+)$/iu
const MEDIAINFO_KV_RE = /^(language|title|forced|default|id|format|codec\s*id|bit\s*rate|channel(?:\(s\)|s)?|sampling\s*rate|compression\s*mode|stream\s*size|duration|writing\s*library|delay|count|menu\s*id|commercial\s*name|bit\s*depth|frame\s*rate|язык|название|принудительно)\s*[:=|]\s*(.*)$/iu
const MULTI_HEADER_SPLIT_RE = /(?:\s*\|\s*|\s*;\s*|\s{2,})(?=(?:audio|sound|dubs?|voice(?:\s+tracks?)?|text|subtitles?|subs?|captions?|аудио|звук|озвучка|субтитры)(?:\s*(?:#?\d+|tracks?|streams?|languages?))?\s*(?:[:=|–—-]|\s+\S))/iu
const FFPROBE_STREAM_RE = /Stream\s+#\d+:\d+(?:\[[^\]]+\])?\(([^)]+)\)\s*:\s*(Audio|Subtitle)\b(.*)$/iu
const MKVMERGE_TRACK_RE = /Track\s+ID\s+\d+\s*:\s*(audio|subtitles?)\b.*\blanguage[:=]\s*([a-z]{2,3}(?:-[a-z]{2})?)/iu
const TRACK_OR_LIST_LINE_RE = /^(?:[-*•+]|\d+[.)]|#\d+|(?:track|stream)\s*\d+\s*[:.\-–—]|(?:audio|text|sub(?:title)?)\s*#?\d+\s*\|)/iu

function splitSubtitleItems(tail: string): string[] {
  const rawChunks = tail.split(/\s*[,;|]\s*/).filter(Boolean)
  const items: string[] = []
  for (const chunk of rawChunks) {
    if (chunk.includes('/') && !SIGNS_MARKER_RE.test(chunk) && !/\bop\s*\/\s*ed\b/i.test(chunk)) {
      const slashParts = chunk.split(/\s*\/\s*/).filter(Boolean)
      if (slashParts.length > 1 && slashParts.every((p) => extractLanguageCodesFromListItem(p).length > 0)) {
        items.push(...slashParts)
        continue
      }
    }
    items.push(chunk)
  }
  return items
}

function splitAudioItems(tail: string): string[] {
  return tail.split(/\s*(?:[,;|/+]|&|\band\b)\s*/i).filter(Boolean)
}

function parseDescriptionLanguages(
  cleanedDesc: string,
  explicitAudio: Set<TorrentLanguageCode>,
  explicitSubs: Set<TorrentLanguageCode>,
  setDubtitles: () => void,
): void {
  if (!cleanedDesc) return

  type MediaInfoBlock = {
    kind: 'audio' | 'subtitle'
    langs: TorrentLanguageCode[]
    title: string
    forced: boolean
    hasMeta: boolean
  }

  let section: 'none' | 'audio' | 'subtitle' | 'other' = 'none'
  let mediaInfoBlock: MediaInfoBlock | null = null
  let blankStreak = 0

  const flushMediaInfoBlock = () => {
    if (!mediaInfoBlock) return
    const block = mediaInfoBlock
    mediaInfoBlock = null
    if (!block.hasMeta && block.langs.length === 0 && !block.title) return

    if (block.kind === 'audio') {
      const langs = block.langs.length > 0
        ? block.langs
        : extractLanguageCodesFromListItem(block.title)
      for (const code of langs) explicitAudio.add(code)
      return
    }

    if (isSignsOnlyText(block.title, block.forced)) return
    const hasDub = DUBTITLES_RE.test(block.title)
    const langs = block.langs.length > 0
      ? block.langs
      : extractLanguageCodesFromListItem(block.title)
    if (hasDub) {
      setDubtitles()
      if (langs.length > 0) {
        for (const code of langs) explicitSubs.add(code)
      } else {
        explicitSubs.add('en')
      }
      return
    }
    for (const code of langs) explicitSubs.add(code)
  }

  const processSubtitleItems = (items: string[]) => {
    for (const item of items) {
      if (isSignsOnlyText(item)) continue
      const hasDub = DUBTITLES_RE.test(item)
      const codes = extractLanguageCodesFromListItem(item)
      if (hasDub) {
        setDubtitles()
        if (codes.length > 0) {
          for (const code of codes) explicitSubs.add(code)
        } else {
          explicitSubs.add('en')
        }
        continue
      }
      for (const code of codes) explicitSubs.add(code)
    }
  }

  const processAudioItems = (items: string[]) => {
    for (const item of items) {
      for (const code of extractLanguageCodesFromListItem(item)) {
        explicitAudio.add(code)
      }
    }
  }

  const lines = cleanedDesc.split('\n')
  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim()
    if (!trimmedLine) {
      flushMediaInfoBlock()
      blankStreak += 1
      if (blankStreak >= 2) section = 'none'
      continue
    }
    blankStreak = 0

    // Check ffprobe / mkvmerge lines anywhere
    const ffMatch = FFPROBE_STREAM_RE.exec(trimmedLine)
    if (ffMatch) {
      flushMediaInfoBlock()
      const langRaw = ffMatch[1]
      const streamKind = ffMatch[2].toLowerCase()
      const metaRest = ffMatch[3] || ''
      const codes = extractLanguageCodesFromListItem(langRaw)
      if (streamKind === 'audio') {
        for (const c of codes) explicitAudio.add(c)
      } else if (!isSignsOnlyText(metaRest)) {
        if (DUBTITLES_RE.test(metaRest)) {
          setDubtitles()
          if (codes.length > 0) codes.forEach((c) => explicitSubs.add(c))
          else explicitSubs.add('en')
        } else {
          codes.forEach((c) => explicitSubs.add(c))
        }
      }
      continue
    }

    const mkvMatch = MKVMERGE_TRACK_RE.exec(trimmedLine)
    if (mkvMatch) {
      flushMediaInfoBlock()
      const trackKind = mkvMatch[1].toLowerCase()
      const codes = extractLanguageCodesFromListItem(mkvMatch[2])
      if (trackKind === 'audio') {
        codes.forEach((c) => explicitAudio.add(c))
      } else if (!isSignsOnlyText(trimmedLine)) {
        codes.forEach((c) => explicitSubs.add(c))
      }
      continue
    }

    const segments = trimmedLine.split(MULTI_HEADER_SPLIT_RE).map((s) => s.trim()).filter(Boolean)
    for (const seg of segments) {
      const normalizedSeg = seg.replace(/^[-*•+]\s+/, '').trim()
      if (!normalizedSeg) continue

      if (STANDALONE_AUDIO_HEADER_RE.test(normalizedSeg)) {
        flushMediaInfoBlock()
        section = 'audio'
        mediaInfoBlock = { kind: 'audio', langs: [], title: '', forced: false, hasMeta: false }
        continue
      }

      if (STANDALONE_SUB_HEADER_RE.test(normalizedSeg)) {
        flushMediaInfoBlock()
        section = 'subtitle'
        mediaInfoBlock = { kind: 'subtitle', langs: [], title: '', forced: false, hasMeta: false }
        continue
      }

      const inlineAudioMatch = INLINE_AUDIO_HEADER_RE.exec(normalizedSeg)
      if (inlineAudioMatch) {
        flushMediaInfoBlock()
        section = 'audio'
        processAudioItems(splitAudioItems(inlineAudioMatch[1]))
        continue
      }

      const inlineSubMatch = INLINE_SUB_HEADER_RE.exec(normalizedSeg)
      if (inlineSubMatch) {
        flushMediaInfoBlock()
        section = 'subtitle'
        processSubtitleItems(splitSubtitleItems(inlineSubMatch[1]))
        continue
      }

      if (OTHER_SECTION_HEADER_RE.test(normalizedSeg)) {
        flushMediaInfoBlock()
        section = 'other'
        continue
      }

      if (section === 'audio' || section === 'subtitle') {
        const kvMatch = MEDIAINFO_KV_RE.exec(normalizedSeg)
        if (kvMatch) {
          if (!mediaInfoBlock) {
            mediaInfoBlock = { kind: section, langs: [], title: '', forced: false, hasMeta: false }
          }
          mediaInfoBlock.hasMeta = true
          const key = kvMatch[1].toLowerCase().replace(/\s+/g, '')
          const value = kvMatch[2].trim()
          if (key === 'language' || key === 'язык') {
            for (const code of extractLanguageCodesFromListItem(value)) {
              if (!mediaInfoBlock.langs.includes(code)) mediaInfoBlock.langs.push(code)
            }
          } else if (key === 'title' || key === 'название') {
            mediaInfoBlock.title = value
          } else if (key === 'forced' || key === 'принудительно') {
            mediaInfoBlock.forced = /^(?:yes|true|1|да)\b/iu.test(value)
          }
          continue
        }

        if (mediaInfoBlock?.hasMeta) {
          flushMediaInfoBlock()
        }

        const isListLike = TRACK_OR_LIST_LINE_RE.test(seg)
        const listBody = seg.replace(TRACK_PREFIX_STRIP_RE, '').trim()
        const extractedInLine = section === 'audio'
          ? splitAudioItems(listBody).flatMap(extractLanguageCodesFromListItem)
          : splitSubtitleItems(listBody).flatMap(extractLanguageCodesFromListItem)
        const lineLooksLikeTrackList = isListLike
          || (extractedInLine.length > 0 && listBody.split(/\s+/).filter(Boolean).length <= 8)
          || (section === 'subtitle' && isSignsOnlyText(listBody))

        if (lineLooksLikeTrackList) {
          if (section === 'audio') {
            processAudioItems(splitAudioItems(seg))
          } else {
            processSubtitleItems(splitSubtitleItems(seg))
          }
          continue
        }

        // Non-track prose line terminates the active section
        flushMediaInfoBlock()
        section = 'none'
      }

      if (section === 'none') {
        const proseParts = seg.split(/\s*[;|]\s*/).filter(Boolean)
        for (const part of proseParts) {
          extractInlineProseMatches(part, explicitAudio, explicitSubs, setDubtitles)
        }
      }
    }
  }

  flushMediaInfoBlock()
}

function sortCanonicalCodes(codes: Iterable<TorrentLanguageCode>): TorrentLanguageCode[] {
  const codeSet = new Set(codes)
  return TORRENT_LANGUAGES
    .map((entry) => entry.code)
    .filter((code) => codeSet.has(code))
}

function detectKind(title: string, parsed: ReturnType<typeof parseReleaseCore>): Pick<ReleaseClassification, 'kind' | 'kindLabel'> {
  const text = htmlToText(title)
  const explicitSeasons = Array.from(text.matchAll(/\bseasons?\s*0*(\d{1,2})\b/gi), (match) => Number(match[1]))
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

/** Conservatively classify explicit audio/subtitle languages and Multi/Dual markers. */
export function classifyRelease(title: string, description?: string | null): ReleaseClassification {
  const cleanedTitle = stripClassifierBoilerplate(htmlToText(title || '')).slice(0, 2_000)
  const cleanedDesc = stripClassifierBoilerplate(htmlToText(description || '')).slice(0, 80_000)
  const combined = `${cleanedTitle}\n${cleanedDesc}`

  const parsed = parseReleaseCore(title)
  const explicitAudio = new Set<TorrentLanguageCode>()
  const explicitSubs = new Set<TorrentLanguageCode>()
  let hasDubtitles = false
  const setDubtitles = () => {
    hasDubtitles = true
  }

  const flags = {
    isDualAudio: DUAL_AUDIO_RE.test(combined) || DUAL_TAG_RE.test(combined) || DUAL_SCENE_TOKEN_RE.test(cleanedTitle),
  }
  const isMultiAudio = MULTI_AUDIO_RE.test(combined) || MULTI_TAG_RE.test(combined) || MULTI_SCENE_TOKEN_RE.test(cleanedTitle)
  const isMultiSubs = MULTI_SUBS_RE.test(combined)

  detectSpecialAnimeTags(combined, explicitAudio, explicitSubs, flags)
  parseTitleLanguages(cleanedTitle, explicitAudio, explicitSubs, setDubtitles)
  parseDescriptionLanguages(cleanedDesc, explicitAudio, explicitSubs, setDubtitles)

  const isDualAudio = flags.isDualAudio
  const resolvedAudio = new Set<TorrentLanguageCode>(explicitAudio)
  let hasUnlistedMultiAudio = false

  if (explicitAudio.size >= 2) {
    hasUnlistedMultiAudio = false
  } else if (isDualAudio || isMultiAudio) {
    if (explicitAudio.size === 1) {
      if (explicitAudio.has('ja')) {
        resolvedAudio.add('en')
      } else if (explicitAudio.has('en')) {
        resolvedAudio.add('ja')
      } else {
        resolvedAudio.add('ja')
        if (isMultiAudio) resolvedAudio.add('en')
      }
      hasUnlistedMultiAudio = isMultiAudio
    } else {
      resolvedAudio.add('en')
      resolvedAudio.add('ja')
      hasUnlistedMultiAudio = isMultiAudio
    }
  }

  const resolvedSubs = new Set<TorrentLanguageCode>(explicitSubs)
  let hasUnlistedMultiSubs = false
  if (explicitSubs.size > 0) {
    hasUnlistedMultiSubs = false
  } else if (isMultiSubs) {
    resolvedSubs.add('en')
    hasUnlistedMultiSubs = true
  }

  const audioLanguageCodes = sortCanonicalCodes(resolvedAudio)
  const subtitleLanguageCodes = sortCanonicalCodes(resolvedSubs)
  const audioLabels = audioLanguageCodes.map((code) => LANGUAGE_DEF_BY_CODE.get(code)?.audioLabel || `${code.toUpperCase()} Audio`)
  const subtitleLabels = subtitleLanguageCodes.map((code) => LANGUAGE_DEF_BY_CODE.get(code)?.subLabel || `${code.toUpperCase()} Subs`)

  let subtitleLabel: string | null = null
  if (hasDubtitles) {
    subtitleLabel = 'Dubtitles'
  } else if (hasUnlistedMultiSubs) {
    subtitleLabel = 'Multi-Subs'
  } else if (subtitleLanguageCodes.includes('en') && subtitleLanguageCodes.length === 1) {
    subtitleLabel = 'English Subs'
  } else if (isMultiSubs && subtitleLanguageCodes.length > 1) {
    subtitleLabel = 'Multi-Subs'
  } else if (subtitleLabels.length === 1) {
    subtitleLabel = subtitleLabels[0]
  } else if (subtitleLabels.length > 1) {
    subtitleLabel = 'Multi-Subs'
  }

  const englishDub = audioLanguageCodes.includes('en')
  const japanese = audioLanguageCodes.includes('ja')
  const hasEnglishSubs = subtitleLanguageCodes.includes('en') || hasUnlistedMultiSubs

  let languageGroup: ReleaseLanguageGroup = 'unknown'
  let rank = 5
  if (englishDub && hasDubtitles) {
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
  } else if (japanese && audioLanguageCodes.length === 1) {
    languageGroup = 'japanese'
    rank = 3
  } else if (audioLanguageCodes.length > 0 || subtitleLanguageCodes.length > 0 || isDualAudio || isMultiAudio || isMultiSubs) {
    languageGroup = 'other'
    rank = 4
  }

  return {
    languageGroup,
    audioLabels,
    audioLanguageCodes,
    subtitleLanguageCodes,
    subtitleLabels,
    subtitleLabel,
    hasDubtitles,
    isDualAudio,
    isMultiAudio,
    isMultiSubs,
    hasUnlistedMultiAudio,
    hasUnlistedMultiSubs,
    ...detectKind(title, parsed),
    rank,
    hasLanguageInfo: audioLanguageCodes.length > 0 || subtitleLanguageCodes.length > 0 || isDualAudio || isMultiAudio || isMultiSubs || subtitleLabel != null,
  }
}

export function matchesReleaseLanguagePreferences(
  classification: ReleaseClassification,
  audioPreferences?: readonly string[] | null,
  subtitlePreferences?: readonly string[] | null,
): boolean {
  const audioPrefs = audioPreferences ?? []
  const subPrefs = subtitlePreferences ?? []

  const explicitAudioMatch = audioPrefs.length === 0
    ? true
    : audioPrefs.some((code) => classification.audioLanguageCodes.includes(code as TorrentLanguageCode))
  const subMatch = subPrefs.length === 0
    ? true
    : subPrefs.some((code) => classification.subtitleLanguageCodes.includes(code as TorrentLanguageCode))

  if (explicitAudioMatch) return subMatch

  if (
    audioPrefs.includes('ja')
    && classification.audioLanguageCodes.length === 0
    && !classification.isMultiAudio
    && !classification.isDualAudio
    && (subPrefs.length > 0 ? subMatch : classification.subtitleLanguageCodes.length > 0 || classification.isMultiSubs)
  ) {
    return true
  }

  return false
}

export function computeLanguagePreferenceRank(
  classification: ReleaseClassification,
  audioPreferences?: readonly string[] | null,
  subtitlePreferences?: readonly string[] | null,
): number {
  const useDefault = audioPreferences === undefined && subtitlePreferences === undefined
  const audioPrefs = useDefault ? ['en'] : (audioPreferences ?? [])
  const subPrefs = useDefault ? ['en'] : (subtitlePreferences ?? [])

  if (audioPrefs.length === 0 && subPrefs.length === 0) return 0

  const audioIdx = audioPrefs.findIndex((code) => classification.audioLanguageCodes.includes(code as TorrentLanguageCode))
  const subIdx = subPrefs.findIndex((code) => classification.subtitleLanguageCodes.includes(code as TorrentLanguageCode))
  const jaIdx = audioPrefs.indexOf('ja')
  const implicitJaSub = audioIdx === -1
    && jaIdx >= 0
    && classification.audioLanguageCodes.length === 0
    && !classification.isMultiAudio
    && !classification.isDualAudio
    && (classification.subtitleLanguageCodes.length > 0 || classification.isMultiSubs)

  if (audioPrefs.length > 0 && subPrefs.length > 0) {
    if (audioIdx === 0 && subIdx === 0 && classification.hasDubtitles && audioPrefs[0] !== 'ja') return 0
    if (audioIdx >= 0 && subIdx >= 0) return 10 + audioIdx * 20 + subIdx
    if (implicitJaSub && subIdx >= 0) return 100 + jaIdx * 20 + subIdx
    if (audioIdx >= 0) return 200 + audioIdx
    if (subIdx >= 0) return 300 + (classification.audioLanguageCodes.includes('ja') ? 0 : 10) + subIdx
    if (classification.hasUnlistedMultiAudio || classification.hasUnlistedMultiSubs) return 350
    if (classification.audioLanguageCodes.includes('ja')) return 400
    if (classification.hasLanguageInfo) return 500
    return 600
  }

  if (audioPrefs.length > 0) {
    if (audioIdx >= 0) return 10 + audioIdx
    if (implicitJaSub) return 100 + jaIdx
    if (classification.hasUnlistedMultiAudio) return 350
    if (classification.audioLanguageCodes.includes('ja')) return 400
    if (classification.hasLanguageInfo) return 500
    return 600
  }

  if (subIdx >= 0) return 10 + subIdx
  if (classification.hasUnlistedMultiSubs) return 350
  if (classification.audioLanguageCodes.includes('ja')) return 400
  if (classification.hasLanguageInfo) return 500
  return 600
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
