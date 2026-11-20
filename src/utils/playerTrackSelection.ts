import { isTopSignsCandidate } from '../../electron/assSignsExtractor.ts';
import type {
  AppSettings,
  AudioTrack,
  DefaultSubtitleType,
  DefaultTopSubMode,
  SeasonMainSubtitleType,
  SeasonPreference,
  SubtitleTrack,
} from '../../electron/types.ts';
import type { TorrentLanguageCode } from '../lib/releaseParser/releaseClassification.ts';

export const ISO_CODE_ALIASES: Record<TorrentLanguageCode, string[]> = {
  en: ['en', 'eng', 'enm'],
  ja: ['ja', 'jpn', 'jp'],
  de: ['de', 'deu', 'ger'],
  fr: ['fr', 'fre', 'fra'],
  es: ['es', 'spa'],
  it: ['it', 'ita'],
  ru: ['ru', 'rus'],
  pt: ['pt', 'por'],
  zh: ['zh', 'chi', 'zho'],
  ko: ['ko', 'kor'],
};

const ALIAS_TO_CANONICAL: Record<string, TorrentLanguageCode> = Object.fromEntries(
  (Object.entries(ISO_CODE_ALIASES) as Array<[TorrentLanguageCode, string[]]>).flatMap(
    ([canonical, aliases]) => aliases.map((alias) => [alias, canonical])
  )
) as Record<string, TorrentLanguageCode>;

const VALID_TORRENT_CODES = new Set<TorrentLanguageCode>(
  Object.keys(ISO_CODE_ALIASES) as TorrentLanguageCode[]
);

const TITLE_LANGUAGE_PATTERNS: Array<{ code: TorrentLanguageCode; regex: RegExp }> = [
  { code: 'en', regex: /\benglish\b/i },
  { code: 'ja', regex: /\bjapanese\b|日本語/i },
  { code: 'ru', regex: /\brussian\b|русск/i },
  { code: 'de', regex: /\bgerman\b|\bdeutsch\b/i },
  { code: 'fr', regex: /\bfrench\b|\bfran[çc]ais\b/i },
  { code: 'es', regex: /\bspanish\b|\bespa[ñn]ol\b|\bcastellano\b/i },
  { code: 'it', regex: /\bitalian\b|\bitaliano\b/i },
  { code: 'pt', regex: /\bportuguese\b|\bportugu[êe]s\b/i },
  { code: 'zh', regex: /\bchinese\b|\bmandarin\b|\bcantonese\b|中文|简体|繁體/i },
  { code: 'ko', regex: /\bkorean\b|한국어/i },
];

export function isValidTorrentLanguageCode(value?: string | null): value is TorrentLanguageCode {
  if (!value) return false;
  return VALID_TORRENT_CODES.has(value.trim().toLowerCase() as TorrentLanguageCode);
}

/**
 * Canonicalizes an audio/subtitle track's language code, title, or external
 * file suffix into one of Kaiko's normalized 2-letter language codes.
 */
export function canonicalizeTrackLanguage(
  rawLang?: string | null,
  title?: string | null,
  filePath?: string | null
): TorrentLanguageCode | null {
  const cleaned = (rawLang || '').trim().toLowerCase();
  if (cleaned && cleaned !== 'und' && cleaned !== 'zxx' && cleaned !== 'unknown') {
    if (ALIAS_TO_CANONICAL[cleaned]) return ALIAS_TO_CANONICAL[cleaned];
    const base = cleaned.split(/[-_]/)[0];
    if (base && ALIAS_TO_CANONICAL[base]) return ALIAS_TO_CANONICAL[base];
  }

  if (filePath) {
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const tokens = fileName.toLowerCase().split('.');
    // Ignore filename stem (idx 0) and container/sub extension (last idx)
    for (let i = 1; i < tokens.length - 1; i += 1) {
      const token = tokens[i];
      if (ALIAS_TO_CANONICAL[token]) return ALIAS_TO_CANONICAL[token];
      const base = token.split(/[-_]/)[0];
      if (base && ALIAS_TO_CANONICAL[base]) return ALIAS_TO_CANONICAL[base];
    }
  }

  if (title) {
    for (const entry of TITLE_LANGUAGE_PATTERNS) {
      if (entry.regex.test(title)) return entry.code;
    }
  }

  return null;
}

export function toIso639_2(code: TorrentLanguageCode): string {
  switch (code) {
    case 'en': return 'eng';
    case 'ja': return 'jpn';
    case 'de': return 'deu';
    case 'fr': return 'fra';
    case 'es': return 'spa';
    case 'it': return 'ita';
    case 'ru': return 'rus';
    case 'pt': return 'por';
    case 'zh': return 'zho';
    case 'ko': return 'kor';
  }
}

export function isDubtitleLikeTrack(track: SubtitleTrack): boolean {
  return Boolean(
    track.isDubtitle ||
      /\b(?:sdh|dubtitle|dubtitles|cc|whisper)\b|hearing impaired|closed caption/i.test(track.title || '') ||
      (track.filePath && /\.whisper\./i.test(track.filePath))
  );
}

export function isSignsLikeTrack(track: SubtitleTrack): boolean {
  return Boolean(
    track.isSigns ||
      track.isForced ||
      /\b(?:sign|signs|song|songs|forced|typeset|typesetting)\b|sign|song|forced/i.test(track.title || '')
  );
}

export function classifySubtitleTrackType(
  track: SubtitleTrack
): Exclude<SeasonMainSubtitleType, 'off'> {
  if (isSignsLikeTrack(track)) return 'signs';
  if (isDubtitleLikeTrack(track)) return 'dubtitles';
  if (track.type === 'external') return 'external';
  return 'dialogue';
}

export interface EffectivePlaybackPreferences {
  audioLanguages: TorrentLanguageCode[];
  preferOriginalAudio: boolean;
  subtitleLanguages: TorrentLanguageCode[];
  subtitlesOffByDefault: boolean;
  subtitleType: DefaultSubtitleType;
  topSubMode: DefaultTopSubMode;
  signsPreferredLanguages: TorrentLanguageCode[];
  signsAllowedLanguages: string[];
}

function dedupeCodes(list: TorrentLanguageCode[]): TorrentLanguageCode[] {
  return Array.from(new Set(list));
}

/**
 * Resolves the user's effective playback preferences from AppSettings,
 * falling back to Downloads language preferences when `'auto'` is selected.
 */
export function resolveEffectivePlaybackPreferences(
  settings?: Partial<AppSettings>
): EffectivePlaybackPreferences {
  const torrentAudio = (settings?.preferredTorrentAudioLanguages || []).filter((c): c is TorrentLanguageCode =>
    isValidTorrentLanguageCode(c)
  );
  const torrentSubs = (settings?.preferredTorrentSubtitleLanguages || []).filter((c): c is TorrentLanguageCode =>
    isValidTorrentLanguageCode(c)
  );

  const rawDefaultAudio = (settings?.defaultAudioLanguage || 'auto').trim().toLowerCase();
  const rawDefaultSub = (settings?.defaultSubtitleLanguage || 'auto').trim().toLowerCase();
  const subtitleType: DefaultSubtitleType = settings?.defaultSubtitleType || 'auto';
  const topSubMode: DefaultTopSubMode = settings?.defaultTopSubMode || 'auto';

  const preferOriginalAudio = rawDefaultAudio === 'original';
  let audioLanguages: TorrentLanguageCode[];
  if (preferOriginalAudio) {
    audioLanguages = ['ja'];
  } else if (isValidTorrentLanguageCode(rawDefaultAudio)) {
    audioLanguages = dedupeCodes([rawDefaultAudio, ...torrentAudio]);
  } else {
    audioLanguages = torrentAudio.length > 0 ? dedupeCodes(torrentAudio) : ['en'];
  }

  const subtitlesOffByDefault = rawDefaultSub === 'off' || subtitleType === 'off';
  let subtitleLanguages: TorrentLanguageCode[];
  if (subtitlesOffByDefault) {
    subtitleLanguages = [];
  } else if (isValidTorrentLanguageCode(rawDefaultSub)) {
    subtitleLanguages = dedupeCodes([rawDefaultSub, ...torrentSubs]);
  } else {
    subtitleLanguages = torrentSubs.length > 0 ? dedupeCodes(torrentSubs) : ['en'];
  }

  // Signs & Songs language fallback even when main subtitles are turned OFF
  // (common for Dub viewers who still want localized on-screen signs/titles).
  let signsPreferredLanguages: TorrentLanguageCode[];
  if (subtitleLanguages.length > 0) {
    signsPreferredLanguages = subtitleLanguages;
  } else if (isValidTorrentLanguageCode(rawDefaultSub)) {
    signsPreferredLanguages = dedupeCodes([rawDefaultSub, ...torrentSubs]);
  } else if (torrentSubs.length > 0) {
    signsPreferredLanguages = dedupeCodes(torrentSubs);
  } else if (isValidTorrentLanguageCode(rawDefaultAudio) && rawDefaultAudio !== 'ja') {
    signsPreferredLanguages = [rawDefaultAudio];
  } else {
    signsPreferredLanguages = ['en'];
  }

  const signsAllowedLanguages = Array.from(
    new Set(signsPreferredLanguages.flatMap((code) => ISO_CODE_ALIASES[code] || [code]))
  );

  return {
    audioLanguages,
    preferOriginalAudio,
    subtitleLanguages,
    subtitlesOffByDefault,
    subtitleType,
    topSubMode,
    signsPreferredLanguages,
    signsAllowedLanguages,
  };
}

function findAudioTrackByLanguage(
  audioTracks: AudioTrack[],
  lang: TorrentLanguageCode
): AudioTrack | undefined {
  const matches = audioTracks.filter(
    (t) => canonicalizeTrackLanguage(t.language, t.title) === lang
  );
  if (matches.length === 0) return undefined;
  return matches.find((t) => t.isDefault) || matches[0];
}

function pickMainSubForLanguage(
  subtitleTracks: SubtitleTrack[],
  targetLang: TorrentLanguageCode,
  mode: 'auto' | 'dubtitles' | 'dialogue',
  isDubAudio: boolean
): SubtitleTrack | undefined {
  const nonSigns = subtitleTracks.filter((s) => !isSignsLikeTrack(s));
  const langMatches = nonSigns.filter((s) => {
    const canonical = canonicalizeTrackLanguage(s.language, s.title, s.filePath);
    if (canonical === targetLang) return true;
    // Allow completely untagged external Whisper SRTs when seeking English
    if (!canonical && targetLang === 'en' && s.type === 'external' && isDubtitleLikeTrack(s)) {
      return true;
    }
    return false;
  });

  if (langMatches.length === 0) return undefined;

  const dubtitleTrack = langMatches.find((s) => isDubtitleLikeTrack(s));
  const dialogueTracks = langMatches.filter((s) => !isDubtitleLikeTrack(s));
  const defaultDialogue = dialogueTracks.find((s) => s.isDefault);
  const anyDialogue = dialogueTracks[0];
  const extNonSigns = dialogueTracks.find((s) => s.type === 'external' && !s.isForced);
  const extAnyNonSigns = langMatches.find((s) => s.type === 'external' && !s.isForced);

  const effectiveMode = mode === 'auto' ? (isDubAudio ? 'dubtitles' : 'dialogue') : mode;
  if (effectiveMode === 'dubtitles') {
    return dubtitleTrack || extAnyNonSigns || defaultDialogue || anyDialogue;
  }
  return defaultDialogue || anyDialogue || extNonSigns || dubtitleTrack;
}

function pickSignsCandidate(
  subtitleTracks: SubtitleTrack[],
  mainSubId: string | null,
  preferredLangs: TorrentLanguageCode[],
  allowedLanguages: string[],
  preferExternalFirst = false
): SubtitleTrack | undefined {
  const candidates = subtitleTracks.filter((s) =>
    isTopSignsCandidate(s, mainSubId, allowedLanguages)
  );
  if (candidates.length === 0) return undefined;

  const sortByType = (list: SubtitleTrack[]) => {
    if (!preferExternalFirst) return list;
    return [
      ...list.filter((s) => s.type === 'external'),
      ...list.filter((s) => s.type !== 'external'),
    ];
  };

  for (const code of preferredLangs) {
    const exactLang = sortByType(candidates).find(
      (s) => canonicalizeTrackLanguage(s.language, s.title, s.filePath) === code
    );
    if (exactLang) return exactLang;
  }

  return sortByType(candidates)[0];
}

export interface InitialTrackSelectionResult {
  audioIndex: number;
  selectedAudioTrack: AudioTrack | null;
  mainSubtitleTrackId: string | null;
  topSubtitleTrackId: string | null;
  topSubEnabled: boolean;
  explicitTopSubOff: boolean;
}

/**
 * Selects the initial Audio, Main Subtitle, and Top Signs tracks when loading
 * an episode, honoring per-season SeasonPreference rules first and falling back
 * to global AppSettings playback preferences.
 */
export function selectInitialTracks(
  meta: { audioTracks: AudioTrack[]; subtitleTracks: SubtitleTrack[] },
  seasonPref: SeasonPreference | null,
  settings?: Partial<AppSettings>
): InitialTrackSelectionResult {
  const prefs = resolveEffectivePlaybackPreferences(settings);
  const isV2SeasonPref = Boolean(seasonPref?.schemaVersion && seasonPref.schemaVersion >= 2);

  // ---- 1. Audio Track Selection ----
  let selectedAudioTrack: AudioTrack | null = null;
  let audioIndex = 0;

  if (seasonPref) {
    const savedIndex = seasonPref.preferredAudioIndex;
    const savedCanonical = canonicalizeTrackLanguage(seasonPref.preferredAudioLanguage);
    const byIndex =
      savedIndex !== undefined
        ? meta.audioTracks.find((t) => t.audioIndex === savedIndex) || null
        : null;

    if (isV2SeasonPref) {
      if (byIndex && (!savedCanonical || canonicalizeTrackLanguage(byIndex.language, byIndex.title) === savedCanonical)) {
        selectedAudioTrack = byIndex;
      } else if (savedCanonical) {
        selectedAudioTrack = findAudioTrackByLanguage(meta.audioTracks, savedCanonical) || byIndex;
      } else {
        selectedAudioTrack = byIndex;
      }
    } else if (byIndex) {
      // Legacy SeasonPreference (v1 hardcoded preferredAudioLanguage: 'eng')
      selectedAudioTrack = byIndex;
    }
  }

  if (!selectedAudioTrack) {
    for (const lang of prefs.audioLanguages) {
      const match = findAudioTrackByLanguage(meta.audioTracks, lang);
      if (match) {
        selectedAudioTrack = match;
        break;
      }
    }
  }

  if (!selectedAudioTrack) {
    selectedAudioTrack =
      meta.audioTracks.find((t) => t.isDefault) || meta.audioTracks[0] || null;
  }

  if (selectedAudioTrack) {
    audioIndex = selectedAudioTrack.audioIndex;
  } else if (seasonPref?.preferredAudioIndex !== undefined) {
    audioIndex = seasonPref.preferredAudioIndex;
  }

  const activeAudioLang = selectedAudioTrack
    ? canonicalizeTrackLanguage(selectedAudioTrack.language, selectedAudioTrack.title)
    : null;
  const isDubAudio = activeAudioLang !== null ? activeAudioLang !== 'ja' : false;

  // ---- 2. Main Subtitle Selection ----
  let mainSubId: string | null = null;

  if (seasonPref && 'mainSubtitleTrackId' in seasonPref && seasonPref.mainSubtitleTrackId !== undefined) {
    if (seasonPref.mainSubtitleTrackId === null) {
      mainSubId = null;
    } else {
      const targetId = seasonPref.mainSubtitleTrackId;
      const exactMatch = meta.subtitleTracks.find((s) => s.id === targetId) || null;
      const savedSubCanonical = canonicalizeTrackLanguage(seasonPref.mainSubtitleLanguage);

      const exactMatchesLanguageAndType =
        exactMatch &&
        (!isV2SeasonPref ||
          ((!savedSubCanonical ||
            canonicalizeTrackLanguage(exactMatch.language, exactMatch.title, exactMatch.filePath) ===
              savedSubCanonical) &&
            (!seasonPref.mainSubtitleType ||
              seasonPref.mainSubtitleType === 'off' ||
              classifySubtitleTrackType(exactMatch) === seasonPref.mainSubtitleType)));

      if (exactMatch && exactMatchesLanguageAndType) {
        mainSubId = exactMatch.id;
      } else {
        const recoveryLangs = dedupeCodes([
          ...(savedSubCanonical ? [savedSubCanonical] : []),
          ...prefs.subtitleLanguages,
          ...(prefs.signsPreferredLanguages.length > 0
            ? prefs.signsPreferredLanguages
            : (['en'] as TorrentLanguageCode[])),
        ]);
        const savedType = seasonPref.mainSubtitleType;

        let recovered: SubtitleTrack | undefined;
        if (targetId.startsWith('ext-') || savedType === 'external') {
          for (const lang of recoveryLangs) {
            recovered =
              meta.subtitleTracks.find(
                (s) =>
                  s.type === 'external' &&
                  !isSignsLikeTrack(s) &&
                  canonicalizeTrackLanguage(s.language, s.title, s.filePath) === lang
              ) ||
              pickMainSubForLanguage(
                meta.subtitleTracks,
                lang,
                savedType === 'dubtitles' ? 'dubtitles' : savedType === 'dialogue' ? 'dialogue' : 'auto',
                isDubAudio
              );
            if (recovered) break;
          }
          if (!recovered && targetId.startsWith('ext-')) {
            recovered =
              meta.subtitleTracks.find((s) => s.type === 'external' && isDubtitleLikeTrack(s) && !isSignsLikeTrack(s)) ||
              meta.subtitleTracks.find((s) => s.type === 'external' && !isSignsLikeTrack(s) && !s.isForced);
          }
        } else if (savedType === 'signs') {
          recovered = pickSignsCandidate(
            meta.subtitleTracks,
            null,
            recoveryLangs,
            recoveryLangs.flatMap((c) => ISO_CODE_ALIASES[c] || [c])
          );
        } else {
          const targetMode: 'auto' | 'dubtitles' | 'dialogue' =
            savedType === 'dubtitles'
              ? 'dubtitles'
              : savedType === 'dialogue'
                ? 'dialogue'
                : prefs.subtitleType === 'off'
                  ? 'auto'
                  : prefs.subtitleType;
          for (const lang of recoveryLangs) {
            recovered = pickMainSubForLanguage(meta.subtitleTracks, lang, targetMode, isDubAudio);
            if (recovered) break;
          }
        }

        if (recovered) {
          mainSubId = recovered.id;
        } else if (exactMatch) {
          mainSubId = exactMatch.id;
        }
      }
    }
  } else if (!prefs.subtitlesOffByDefault) {
    const mode = prefs.subtitleType === 'off' ? 'auto' : prefs.subtitleType;
    for (const lang of prefs.subtitleLanguages) {
      const picked = pickMainSubForLanguage(meta.subtitleTracks, lang, mode, isDubAudio);
      if (picked) {
        mainSubId = picked.id;
        break;
      }
    }
  }

  // ---- 3. Top Signs / 2nd Subtitle Selection ----
  let topSubId: string | null = null;
  let topSubEnabled = false;
  let explicitTopSubOff = false;

  if (seasonPref && 'topSubtitleTrackId' in seasonPref && seasonPref.topSubtitleTrackId !== undefined) {
    if (seasonPref.topSubtitleTrackId === null) {
      explicitTopSubOff = true;
      topSubId = null;
      topSubEnabled = false;
    } else {
      explicitTopSubOff = false;
      const savedTopCanon = canonicalizeTrackLanguage(seasonPref.topSubtitleLanguage);
      const topPrefLangs = dedupeCodes([
        ...(savedTopCanon ? [savedTopCanon] : []),
        ...prefs.signsPreferredLanguages,
      ]);
      const topAllowed = Array.from(
        new Set(topPrefLangs.flatMap((c) => ISO_CODE_ALIASES[c] || [c]))
      );

      const exactTop = meta.subtitleTracks.find((s) => s.id === seasonPref.topSubtitleTrackId);
      if (
        exactTop &&
        exactTop.id !== mainSubId &&
        (!isV2SeasonPref ||
          !savedTopCanon ||
          !canonicalizeTrackLanguage(exactTop.language, exactTop.title, exactTop.filePath) ||
          canonicalizeTrackLanguage(exactTop.language, exactTop.title, exactTop.filePath) === savedTopCanon)
      ) {
        topSubId = exactTop.id;
        topSubEnabled = seasonPref.topSubEnabled;
      } else {
        const fallbackSigns = pickSignsCandidate(
          meta.subtitleTracks,
          mainSubId,
          topPrefLangs,
          topAllowed,
          seasonPref.topSubtitleTrackId.startsWith('ext-')
        );
        if (fallbackSigns) {
          topSubId = fallbackSigns.id;
          topSubEnabled = seasonPref.topSubEnabled;
        }
      }
    }
  } else if (prefs.topSubMode === 'off') {
    explicitTopSubOff = true;
    topSubId = null;
    topSubEnabled = false;
  } else {
    explicitTopSubOff = false;
    const selectedMain = meta.subtitleTracks.find((s) => s.id === mainSubId);
    const isMainFull = Boolean(selectedMain && /full|all/i.test(selectedMain.title));
    const signsCandidate = pickSignsCandidate(
      meta.subtitleTracks,
      mainSubId,
      prefs.signsPreferredLanguages,
      prefs.signsAllowedLanguages
    );
    if (signsCandidate) {
      topSubId = signsCandidate.id;
      topSubEnabled = prefs.topSubMode === 'always' ? true : !isMainFull;
    }
  }

  return {
    audioIndex,
    selectedAudioTrack,
    mainSubtitleTrackId: mainSubId,
    topSubtitleTrackId: topSubId,
    topSubEnabled,
    explicitTopSubOff,
  };
}

/**
 * Picks an appropriate main subtitle when the user switches audio tracks inside
 * the player, honoring the user's preferred subtitle language & subtitle type.
 */
export function selectSubtitleOnAudioSwitch(
  newAudio: AudioTrack | undefined,
  subtitleTracks: SubtitleTrack[],
  currentMainSubId: string | null,
  settings?: Partial<AppSettings>
): string | null {
  const prefs = resolveEffectivePlaybackPreferences(settings);
  if (prefs.subtitlesOffByDefault) {
    return currentMainSubId;
  }

  const newAudioLang = newAudio ? canonicalizeTrackLanguage(newAudio.language, newAudio.title) : null;
  const isDub = newAudioLang !== null ? newAudioLang !== 'ja' : false;

  // If user already had subtitles OFF and switched into dub audio, don't force subs on unexpectedly
  if (isDub && currentMainSubId === null) {
    return null;
  }

  const mode = prefs.subtitleType === 'off' ? 'auto' : prefs.subtitleType;
  for (const lang of prefs.subtitleLanguages) {
    const picked = pickMainSubForLanguage(subtitleTracks, lang, mode, isDub);
    if (picked) return picked.id;
  }

  return currentMainSubId;
}

/**
 * Converts a player's active track choices into global default playback
 * settings (`AppSettings`) for one-click "Save as Default".
 */
export function buildDefaultSettingsFromSelection(
  audioTrack: AudioTrack | undefined,
  mainSubTrack: SubtitleTrack | null,
  topSubId: string | null,
  topSubEnabled: boolean,
  explicitTopSubOff: boolean
): Partial<AppSettings> {
  const audioCanon = audioTrack
    ? canonicalizeTrackLanguage(audioTrack.language, audioTrack.title)
    : null;
  const defaultAudioLanguage = audioCanon === 'ja' ? 'original' : audioCanon || 'auto';

  let defaultSubtitleLanguage: string = 'auto';
  let defaultSubtitleType: DefaultSubtitleType = 'auto';

  if (!mainSubTrack) {
    defaultSubtitleLanguage = 'off';
    defaultSubtitleType = 'off';
  } else {
    const subCanon = canonicalizeTrackLanguage(
      mainSubTrack.language,
      mainSubTrack.title,
      mainSubTrack.filePath
    );
    if (subCanon) {
      defaultSubtitleLanguage = subCanon;
    }
    const kind = classifySubtitleTrackType(mainSubTrack);
    defaultSubtitleType = kind === 'dubtitles' ? 'dubtitles' : kind === 'dialogue' ? 'dialogue' : 'auto';
  }

  let defaultTopSubMode: DefaultTopSubMode = 'auto';
  if (explicitTopSubOff || (topSubId !== null && !topSubEnabled)) {
    defaultTopSubMode = 'off';
  } else if (topSubId !== null && topSubEnabled) {
    defaultTopSubMode = 'always';
  }

  return {
    defaultAudioLanguage,
    defaultSubtitleLanguage,
    defaultSubtitleType,
    defaultTopSubMode,
  };
}
