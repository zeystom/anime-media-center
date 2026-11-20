import { classifyRelease, isMultiSeasonCollection, type TorrentLanguageCode } from '../lib/releaseParser/releaseClassification.ts'
import { parseReleaseCore } from '../lib/releaseParser/regexEngine.ts'
import type { AnimeFolder, CatalogRelatedTitle, FranchiseSeasonEntry, ReleaseSearchResult } from '../types'

const RELEASE_PREFS_STORAGE_KEY = 'anime-center.release-prefs.v1'
const NON_LATIN_SYN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u0400-\u04ff\uac00-\ud7af]/

export interface QueuedEpisodeDownload {
  anilistId: number
  episode: number
  title: string
  aliases: string[]
  season: number | null
  part: number | null
  episodeCount: number | null
  episodeDurationMinutes: number | null
  mediaFormat: string | null
  franchiseSeasons: FranchiseSeasonEntry[]
  contentTitleAliases: string[]
  targetFolder?: string
  downloadRoot?: string
  airedAtMs?: number | null
  background?: boolean
}

export interface AnimeReleasePreference {
  preferredGroup?: string | null
  audioMode?: 'dub' | 'sub' | null
  updatedAt: number
}

export interface OngoingDownloadPlan {
  isOngoing: boolean
  allMissingAired: number[]
  unwatchedMissingAired: number[]
  targetEpisodes: number[]
  allAiredDownloaded: boolean
  allAiredWatchedAndCleared: boolean
  buttonLabel: string
  buttonDisabled: boolean
}

export interface SearchAliasDetailsInput {
  format?: string | null
  title?: {
    english?: string | null
    romaji?: string | null
  } | null
  synonyms?: string[] | null
}

function readAllReleasePreferences(): Record<string, AnimeReleasePreference> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(RELEASE_PREFS_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, AnimeReleasePreference>)
      : {}
  } catch {
    return {}
  }
}

export function readAnimeReleasePreference(anilistId: number): AnimeReleasePreference | null {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return null
  const all = readAllReleasePreferences()
  return all[String(Math.trunc(anilistId))] ?? null
}

export function saveAnimeReleasePreference(anilistId: number, patch: Partial<AnimeReleasePreference>): void {
  if (!Number.isFinite(anilistId) || anilistId <= 0 || typeof localStorage === 'undefined') return
  const key = String(Math.trunc(anilistId))
  try {
    const all = readAllReleasePreferences()
    const existing = all[key] ?? { updatedAt: Date.now() }
    const next: AnimeReleasePreference = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    }
    all[key] = next
    // Cap stored per-anime preferences cleanly at 250 most recent entries.
    const entries = Object.entries(all)
    if (entries.length > 250) {
      entries.sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
      localStorage.setItem(RELEASE_PREFS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries.slice(0, 250))))
    } else {
      localStorage.setItem(RELEASE_PREFS_STORAGE_KEY, JSON.stringify(all))
    }
  } catch {
    // Ignore storage quota or serialization errors.
  }
}

export function recordPickedReleasePreference(
  anilistId: number,
  release: Pick<ReleaseSearchResult, 'title' | 'description'>,
): void {
  if (!Number.isFinite(anilistId) || anilistId <= 0) return
  const title = typeof release?.title === 'string' ? release.title : ''
  if (!title) return
  const parsedGroup = parseReleaseCore(title).releaseGroup?.trim() || null
  const classification = classifyRelease(title, release?.description)
  const audioMode: 'dub' | 'sub' = classification.audioLanguageCodes.includes('en') ? 'dub' : 'sub'
  const patch: Partial<AnimeReleasePreference> = { audioMode }
  if (parsedGroup) patch.preferredGroup = parsedGroup
  saveAnimeReleasePreference(anilistId, patch)
}

export function inferReleasePreferenceFromEpisodes(
  episodes: Array<{ fileName?: string | null }>,
): Partial<AnimeReleasePreference> {
  const counts = new Map<string, { label: string; count: number }>()
  for (const ep of Array.isArray(episodes) ? episodes : []) {
    const fileName = ep?.fileName
    if (!fileName) continue
    const group = parseReleaseCore(fileName).releaseGroup?.trim()
    if (!group) continue
    const key = group.toLowerCase()
    const prev = counts.get(key)
    if (prev) prev.count += 1
    else counts.set(key, { label: group, count: 1 })
  }
  if (counts.size === 0) return {}
  let best: { label: string; count: number } | null = null
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry
  }
  return best ? { preferredGroup: best.label } : {}
}

export function matchesPreferredReleaseLanguages(
  result: Pick<ReleaseSearchResult, 'title' | 'description'>,
  audioPreferences: string[],
  subtitlePreferences: string[],
): boolean {
  const classification = classifyRelease(result.title, result.description)
  const audioMatch = audioPreferences.length
    ? audioPreferences.some((code) => classification.audioLanguageCodes.includes(code as TorrentLanguageCode))
    : classification.audioLanguageCodes.length > 0
  const subtitleMatch = subtitlePreferences.length
    ? subtitlePreferences.some((code) => classification.subtitleLanguageCodes.includes(code as TorrentLanguageCode))
    : classification.subtitleLanguageCodes.length > 0
  return audioMatch && subtitleMatch
}

export function isEnglishDubFallback(
  result: Pick<ReleaseSearchResult, 'title' | 'description'>,
  audioPreferences: string[],
  subtitlePreferences: string[],
): boolean {
  if (!audioPreferences.includes('en') || !subtitlePreferences.includes('en')) return false
  const classification = classifyRelease(result.title, result.description)
  return classification.audioLanguageCodes.includes('en')
    && !classification.subtitleLanguageCodes.includes('en')
}

function preferSeeded(releases: ReleaseSearchResult[]): ReleaseSearchResult[] {
  const seeded = releases.filter((release) => (release.seeders ?? 0) > 0)
  return seeded.length > 0 ? seeded : releases
}

function preferSeededAndGroup(releases: ReleaseSearchResult[], preferredGroup?: string | null): ReleaseSearchResult[] {
  const pool = preferSeeded(releases)
  const target = preferredGroup?.trim().toLowerCase()
  if (!target || pool.length <= 1) return pool
  const matching: ReleaseSearchResult[] = []
  const others: ReleaseSearchResult[] = []
  for (const release of pool) {
    const group = parseReleaseCore(release.title || '').releaseGroup?.trim().toLowerCase()
    if (group && group === target) matching.push(release)
    else others.push(release)
  }
  return matching.length > 0 ? [...matching, ...others] : pool
}

function matchesNonDubSubRelease(
  release: Pick<ReleaseSearchResult, 'title' | 'description'>,
  subtitlePreferences: string[],
  preferredGroup?: string | null,
): 'sub-match' | 'group-match' | null {
  const classification = classifyRelease(release.title, release.description)
  if (classification.audioLanguageCodes.includes('en')) return null
  const subtitleMatch = subtitlePreferences.length
    ? subtitlePreferences.some((code) => classification.subtitleLanguageCodes.includes(code as TorrentLanguageCode))
    : classification.subtitleLanguageCodes.length > 0
  if (subtitleMatch) return 'sub-match'
  const target = preferredGroup?.trim().toLowerCase()
  if (target) {
    const group = parseReleaseCore(release.title || '').releaseGroup?.trim().toLowerCase()
    if (group && group === target) return 'group-match'
  }
  return null
}

function isNonDubJapaneseSubRelease(
  release: Pick<ReleaseSearchResult, 'title' | 'description'>,
  subtitlePreferences: string[],
): boolean {
  const classification = classifyRelease(release.title, release.description)
  if (classification.audioLanguageCodes.includes('en')) return false
  const hasJaOrSub = classification.audioLanguageCodes.includes('ja')
    || (subtitlePreferences.length
      ? subtitlePreferences.some((code) => classification.subtitleLanguageCodes.includes(code as TorrentLanguageCode))
      : classification.subtitleLanguageCodes.length > 0)
  return hasJaOrSub
}

export function pickAutomaticEpisodeRelease(
  results: ReleaseSearchResult[],
  options: {
    audioPreferences: string[]
    subtitlePreferences: string[]
    animePref?: Partial<AnimeReleasePreference> | null
  },
): { best: ReleaseSearchResult | null; usedEnglishDubFallback: boolean; hasJapaneseSubAlternative: boolean } {
  const { audioPreferences, subtitlePreferences, animePref } = options
  const preferredGroup = animePref?.preferredGroup ?? null
  const automaticCandidates = (results ?? []).filter((release) =>
    !release.sizeWarning
    && (release.titleRelevance == null || release.titleRelevance === 'exact' || release.titleRelevance === 'prefix'),
  )

  let best: ReleaseSearchResult | null = null
  if (animePref?.audioMode === 'sub' && audioPreferences.includes('en')) {
    const subMatches = automaticCandidates.filter((r) => matchesNonDubSubRelease(r, subtitlePreferences, preferredGroup) === 'sub-match')
    const groupOnlyMatches = automaticCandidates.filter((r) => matchesNonDubSubRelease(r, subtitlePreferences, preferredGroup) === 'group-match')
    best = preferSeededAndGroup(subMatches, preferredGroup)[0]
      ?? preferSeeded(groupOnlyMatches)[0]
      ?? preferSeededAndGroup(automaticCandidates.filter((r) => matchesPreferredReleaseLanguages(r, audioPreferences, subtitlePreferences)), preferredGroup)[0]
      ?? preferSeededAndGroup(automaticCandidates.filter((r) => isEnglishDubFallback(r, audioPreferences, subtitlePreferences)), preferredGroup)[0]
      ?? null
  } else {
    best = preferSeededAndGroup(automaticCandidates.filter((r) => matchesPreferredReleaseLanguages(r, audioPreferences, subtitlePreferences)), preferredGroup)[0]
      ?? preferSeededAndGroup(automaticCandidates.filter((r) => isEnglishDubFallback(r, audioPreferences, subtitlePreferences)), preferredGroup)[0]
      ?? null
  }

  const usedEnglishDubFallback = !!best && !matchesPreferredReleaseLanguages(best, audioPreferences, subtitlePreferences)
    && !(animePref?.audioMode === 'sub' && matchesNonDubSubRelease(best, subtitlePreferences, preferredGroup) != null)
  const hasJapaneseSubAlternative = best == null
    && audioPreferences.includes('en')
    && automaticCandidates.some((r) => isNonDubJapaneseSubRelease(r, subtitlePreferences))

  return { best, usedEnglishDubFallback, hasJapaneseSubAlternative }
}

export function pickAutomaticSeasonRelease(
  results: ReleaseSearchResult[],
  options: {
    isOvaTitle: boolean
    audioPreferences: string[]
    subtitlePreferences: string[]
    animePref?: Partial<AnimeReleasePreference> | null
    allowedKinds?: string[]
  },
): { best: ReleaseSearchResult | null; usedEnglishDubFallback: boolean } {
  const { isOvaTitle, audioPreferences, subtitlePreferences, animePref, allowedKinds } = options
  const preferredGroup = animePref?.preferredGroup ?? null
  const ovaKinds = ['ova', 'unknown', 'season-pack', 'episode-range']
  const bundleKinds = allowedKinds ?? ['season-pack', 'episode-range']

  const validReleases = (results ?? []).filter((release) =>
    !release.sizeWarning
    && (release.titleRelevance == null || release.titleRelevance === 'exact' || release.titleRelevance === 'prefix')
    && (isOvaTitle ? ovaKinds : bundleKinds).includes(classifyRelease(release.title, release.description).kind),
  )

  const ovaShapeGroup = (release: ReleaseSearchResult) => {
    const kind = classifyRelease(release.title, release.description).kind
    if (kind === 'ova' || kind === 'unknown') return 0
    if (!isMultiSeasonCollection(release.title)) return 1
    return 2
  }

  const pickByTier = (list: ReleaseSearchResult[]): ReleaseSearchResult | null => {
    const ranked = preferSeededAndGroup(list, preferredGroup)
    if (ranked.length === 0) return null
    if (!isOvaTitle) return ranked[0]
    return [...ranked].sort((a, b) => ovaShapeGroup(a) - ovaShapeGroup(b))[0] ?? null
  }

  let best: ReleaseSearchResult | null = null
  if (animePref?.audioMode === 'sub' && audioPreferences.includes('en')) {
    const subMatches = validReleases.filter((r) => matchesNonDubSubRelease(r, subtitlePreferences, preferredGroup) === 'sub-match')
    const groupOnlyMatches = validReleases.filter((r) => matchesNonDubSubRelease(r, subtitlePreferences, preferredGroup) === 'group-match')
    best = pickByTier(subMatches)
      ?? pickByTier(groupOnlyMatches)
      ?? pickByTier(validReleases.filter((r) => matchesPreferredReleaseLanguages(r, audioPreferences, subtitlePreferences)))
      ?? pickByTier(validReleases.filter((r) => isEnglishDubFallback(r, audioPreferences, subtitlePreferences)))
  } else {
    best = pickByTier(validReleases.filter((r) => matchesPreferredReleaseLanguages(r, audioPreferences, subtitlePreferences)))
      ?? pickByTier(validReleases.filter((r) => isEnglishDubFallback(r, audioPreferences, subtitlePreferences)))
  }

  const usedEnglishDubFallback = !!best && !matchesPreferredReleaseLanguages(best, audioPreferences, subtitlePreferences)
    && !(animePref?.audioMode === 'sub' && matchesNonDubSubRelease(best, subtitlePreferences, preferredGroup) != null)

  return { best, usedEnglishDubFallback }
}

export function computeOngoingDownloadPlan(params: {
  status: string | null | undefined
  isFeatureFilm: boolean
  isSingleEpisodeEntry: boolean
  releasedEpisodeCount: number | null
  episodeTotal: number
  downloadedEpisodeNums: Iterable<number>
  activeEpisodeNums: Iterable<number>
  watchedEpisodeNums: Iterable<number>
  watchedMaxProgress: number
}): OngoingDownloadPlan {
  const {
    status,
    isFeatureFilm,
    isSingleEpisodeEntry,
    releasedEpisodeCount,
    episodeTotal,
    downloadedEpisodeNums,
    activeEpisodeNums,
    watchedEpisodeNums,
    watchedMaxProgress,
  } = params

  if (status !== 'RELEASING' || isFeatureFilm || isSingleEpisodeEntry || releasedEpisodeCount == null || releasedEpisodeCount <= 0) {
    return {
      isOngoing: false,
      allMissingAired: [],
      unwatchedMissingAired: [],
      targetEpisodes: [],
      allAiredDownloaded: false,
      allAiredWatchedAndCleared: false,
      buttonLabel: '',
      buttonDisabled: false,
    }
  }

  const downloadedSet = new Set(downloadedEpisodeNums)
  const activeSet = new Set(activeEpisodeNums)
  const watchedSet = new Set(watchedEpisodeNums)

  const allMissingAired: number[] = []
  for (let ep = 1; ep <= releasedEpisodeCount; ep += 1) {
    if (!downloadedSet.has(ep) && !activeSet.has(ep)) {
      allMissingAired.push(ep)
    }
  }

  const unwatchedMissingAired = allMissingAired.filter(
    (ep) => ep > watchedMaxProgress && !watchedSet.has(ep),
  )

  const allAiredDownloaded = allMissingAired.length === 0 && activeSet.size === 0
  const allAiredWatchedAndCleared = allMissingAired.length > 0 && unwatchedMissingAired.length === 0 && downloadedSet.size === 0
  const targetEpisodes = unwatchedMissingAired.length > 0 ? unwatchedMissingAired : allMissingAired

  const denom = episodeTotal > 0 ? episodeTotal : releasedEpisodeCount
  let buttonLabel: string
  let buttonDisabled = false

  if (allAiredDownloaded) {
    buttonLabel = `Up to date (${releasedEpisodeCount}/${denom})`
    buttonDisabled = true
  } else if (allMissingAired.length === 0 && activeSet.size > 0) {
    buttonLabel = `Downloading (${releasedEpisodeCount}/${denom})`
    buttonDisabled = true
  } else if (unwatchedMissingAired.length > 0 && unwatchedMissingAired.length < allMissingAired.length) {
    buttonLabel = unwatchedMissingAired.length === 1
      ? `Download Ep ${unwatchedMissingAired[0]}`
      : `Download ${unwatchedMissingAired.length} new`
  } else if (targetEpisodes.length === 1) {
    buttonLabel = `Download Ep ${targetEpisodes[0]}`
  } else if (downloadedSet.size === 0) {
    buttonLabel = `Download aired (${targetEpisodes.length})`
  } else {
    buttonLabel = `Download ${targetEpisodes.length} missing`
  }

  return {
    isOngoing: true,
    allMissingAired,
    unwatchedMissingAired,
    targetEpisodes,
    allAiredDownloaded,
    allAiredWatchedAndCleared,
    buttonLabel,
    buttonDisabled,
  }
}

export function buildCatalogSearchAliases(
  heroTitle: string,
  details: SearchAliasDetailsInput | null | undefined,
  relatedTitles: CatalogRelatedTitle[] = [],
): string[] {
  if (!details) return []
  const displayKey = (heroTitle || '').trim().toLowerCase()
  const seen = new Set<string>(displayKey ? [displayKey] : [])
  const aliases: string[] = []
  const isOva = details.format?.toUpperCase() === 'OVA'

  const parentTitles = isOva
    ? relatedTitles
      .filter((item) => ['TV', 'TV_SHORT'].includes(String(item.format || '').toUpperCase()) && ['PREQUEL', 'SEQUEL', 'PARENT'].includes(String(item.relationType || '').toUpperCase()))
      .sort((a, b) => (a.relationType === 'PREQUEL' ? -1 : 0) - (b.relationType === 'PREQUEL' ? -1 : 0))
      .flatMap((item) => [item.title.english, item.title.romaji].filter((value): value is string => !!value))
    : []
  const ovaSearchAliases = isOva
    ? [...parentTitles.map((value) => `${value} OVA`), ...parentTitles]
    : []

  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const normalizeQuotesAndSpaces = (value: string) => value.replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim()
  const childCandidates = [details.title?.english, details.title?.romaji, heroTitle]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const parentDerivedAliases: string[] = []
  for (const item of relatedTitles) {
    if (!['PARENT', 'MAIN_STORY'].includes(String(item.relationType || '').toUpperCase())) continue
    const parentTitleSet = [item.title.english, item.title.romaji]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (parentTitleSet.length < 2) continue
    for (const baseParent of parentTitleSet) {
      const basePattern = escapeRegExp(normalizeQuotesAndSpaces(baseParent))
        .replace(/'/g, "['’‘`]")
        .replace(/ /g, '\\s+')
      const prefixRe = new RegExp(`^${basePattern}(?:\\s*[:\\-–—]+\\s*|\\s+)(.+)$`, 'i')
      for (const childTitle of childCandidates) {
        const match = prefixRe.exec(childTitle.trim())
        const suffix = match?.[1]?.trim()
        if (!suffix) continue
        for (const siblingParent of parentTitleSet) {
          if (siblingParent === baseParent) continue
          parentDerivedAliases.push(`${siblingParent.trim()} ${suffix}`)
        }
      }
    }
  }

  const normalizeSyn = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const relatedTitleSet = new Set<string>(
    relatedTitles.flatMap((item) =>
      [item.title.english, item.title.romaji]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map(normalizeSyn)
        .filter(Boolean),
    ),
  )
  const primaryNorms = [details.title?.english, details.title?.romaji]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalizeSyn)
    .filter(Boolean)
  const prefixSynonyms = (details.synonyms || []).filter((syn) => {
    if (typeof syn !== 'string') return false
    const trimmed = syn.trim()
    if (!trimmed || NON_LATIN_SYN_RE.test(trimmed)) return false
    const norm = normalizeSyn(trimmed)
    if (!norm || relatedTitleSet.has(norm)) return false
    const wordCount = norm.split(' ').filter(Boolean).length
    if (wordCount < 3 && (wordCount < 2 || norm.length < 14)) return false
    return primaryNorms.some((primaryNorm) =>
      primaryNorm.length > norm.length
      && primaryNorm.startsWith(norm)
      && primaryNorm[norm.length] === ' ',
    )
  })

  for (const t of [...ovaSearchAliases, ...parentDerivedAliases, ...prefixSynonyms, details.title?.romaji, details.title?.english]) {
    if (!t) continue
    const key = t.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    aliases.push(t)
  }
  return aliases
}

export function normalizeMatchTitle(s: string): string {
  if (!s) return ''
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function getFolderAnilistId(folder: AnimeFolder): number | null {
  const raw = folder.anilistId
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
  return Math.trunc(raw)
}

export function parseNumericEpisodeNumber(
  fileName?: string | null,
  rawEpisodeNumber?: string | number | null,
): number | null {
  if (typeof rawEpisodeNumber === 'number' && Number.isFinite(rawEpisodeNumber)) {
    return rawEpisodeNumber
  }
  if (typeof fileName === 'string' && fileName) {
    const parsed = parseReleaseCore(fileName).episodeNumber
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed
  }
  if (typeof rawEpisodeNumber === 'string' && rawEpisodeNumber.trim()) {
    const match = /(?:^|E)(\d{1,4})\b/i.exec(rawEpisodeNumber.trim()) ?? /(\d{1,4})$/.exec(rawEpisodeNumber.trim())
    if (match) {
      const num = Number(match[1])
      if (Number.isFinite(num)) return num
    }
  }
  return null
}

export function findAllLocalFolders(
  folders: AnimeFolder[],
  ref: { anilistId?: number | null; title?: string | null },
): AnimeFolder[] {
  if (!Array.isArray(folders) || folders.length === 0) return []
  const rawId = ref?.anilistId
  const refId = typeof rawId === 'number' && Number.isFinite(rawId) && rawId > 0 ? Math.trunc(rawId) : null

  if (refId !== null) {
    const byId = folders.filter((folder) => getFolderAnilistId(folder) === refId)
    if (byId.length > 0) return byId
  }

  const normalizedTitle = normalizeMatchTitle(ref?.title || '')
  if (normalizedTitle) {
    const pool = refId !== null
      ? folders.filter((folder) => getFolderAnilistId(folder) === null)
      : folders
    return pool.filter(
      (folder) => normalizeMatchTitle(folder.canonicalTitle || folder.folderName) === normalizedTitle,
    )
  }

  return []
}

export function mergeLocalFolders(matched: AnimeFolder[]): AnimeFolder | null {
  if (!Array.isArray(matched) || matched.length === 0) return null
  if (matched.length === 1) return matched[0]

  const primary = matched[0]
  const epByPath = new Map<string, AnimeFolder['episodes'][number]>()
  for (const folder of matched) {
    for (const ep of folder.episodes || []) {
      if (!ep?.filePath || epByPath.has(ep.filePath)) continue
      epByPath.set(ep.filePath, ep)
    }
  }

  const episodes = Array.from(epByPath.values()).sort((a, b) => {
    const numA = parseNumericEpisodeNumber(a.fileName, a.episodeNumber)
    const numB = parseNumericEpisodeNumber(b.fileName, b.episodeNumber)
    if (numA != null && numB != null && numA !== numB) return numA - numB
    if (numA != null && numB == null) return -1
    if (numA == null && numB != null) return 1
    return (a.fileName || '').localeCompare(b.fileName || '')
  })

  const downloadingEps = episodes.filter((ep) => ep.isDownloading)
  const isDownloading = downloadingEps.length > 0 && (episodes.length === 1 || downloadingEps.length === episodes.length)
  const downloadProgress = isDownloading
    ? Math.round(downloadingEps.reduce((acc, ep) => acc + (ep.downloadProgress || 0), 0) / downloadingEps.length)
    : undefined

  const totalEpisodes = Math.max(
    episodes.length,
    ...matched.map((folder) => (typeof folder.totalEpisodes === 'number' ? folder.totalEpisodes : 0)),
  )

  return {
    ...primary,
    anilistId: matched.map(getFolderAnilistId).find((id) => id != null) ?? primary.anilistId,
    canonicalTitle: matched.map((f) => f.canonicalTitle).find((t) => !!t) ?? primary.canonicalTitle,
    posterUrl: matched.map((f) => f.posterUrl).find((u) => !!u) ?? primary.posterUrl,
    bannerUrl: matched.map((f) => f.bannerUrl).find((u) => !!u) ?? primary.bannerUrl,
    episodes,
    totalEpisodes,
    isDownloading,
    downloadProgress,
    hasSubtitlesCount: episodes.filter((ep) => ep.hasExternalSrt || ep.hasEmbeddedSubtitles || ep.hasEmbeddedDubtitles || ep.hasWhisperSrt).length,
    hasWhisperCount: episodes.filter((ep) => ep.hasWhisperSrt).length,
    hasExtSubCount: episodes.filter((ep) => ep.hasExternalSrt).length,
    hasDubtitlesCount: episodes.filter((ep) => ep.hasEmbeddedDubtitles).length,
    hasEmbeddedDubtitles: matched.some((f) => f.hasEmbeddedDubtitles) || episodes.some((ep) => ep.hasEmbeddedDubtitles),
    hasEmbeddedSubtitles: matched.some((f) => f.hasEmbeddedSubtitles) || episodes.some((ep) => ep.hasEmbeddedSubtitles),
  }
}
