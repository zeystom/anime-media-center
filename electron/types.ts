// Video container extensions recognized by the library scanner, stream server,
// and download-progress heuristics. Keep in sync with readContainerDuration().
export const VIDEO_EXTENSIONS = ['.mkv', '.mp4'] as const;

export interface AudioTrack {
  index: number;         // FFmpeg overall stream index (e.g. 1, 2)
  audioIndex: number;    // 0-based audio stream index for -map 0:a:<index> (0, 1...)
  language: string;      // 'eng', 'jpn', etc.
  languageName: string;  // 'English', 'Japanese', etc.
  codec: string;         // 'eac3', 'flac', 'aac', etc.
  title: string;         // e.g. 'English E-AC-3 2.0', 'Japanese FLAC 2.0'
  isDefault: boolean;
}

export interface SubtitleTrack {
  id: string;            // 'ext-<hash>' or 'emb-<index>'
  index: number | null;  // FFmpeg stream index if embedded, null if external
  type: 'external' | 'embedded';
  filePath?: string;     // path to .srt if external or cached
  language: string;      // 'eng', 'jpn', 'spa', etc.
  languageName: string;  // 'English', 'Spanish', etc.
  codec?: string;        // 'subrip', 'ass'
  title: string;         // 'Whisper AI (External)', 'English [CR]', etc.
  isForced: boolean;
  isDefault: boolean;
  isSigns: boolean;      // True if signs, songs, or forced
  isDubtitle: boolean;   // True if dubtitle / dialogue
}

export interface SubtitleCue {
  id: number;
  start: number; // in seconds
  end: number;   // in seconds
  text: string;
}

export interface SubtitleTrackPayload {
  format: 'ass' | 'srt';
  content?: string;
  fonts?: string[];
  port?: number;
  cues?: SubtitleCue[];
}

export interface VideoChapter {
  id: number;
  start: number; // in seconds
  end: number;   // in seconds
  title: string;
}

export interface VideoMetadata {
  filePath: string;
  fileName: string;
  title: string;
  duration: number; // in seconds
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  chapters?: VideoChapter[];
  hasExternalSrt: boolean;
  externalSrtPath?: string;
  hasEmbeddedDubtitles?: boolean;
  hasEmbeddedSubtitles?: boolean;
}

export interface Episode {
  filePath: string;
  fileName: string;
  episodeNumber: string; // e.g. 'S01E01' or 'E01'
  title: string;
  size: number;
  duration?: number;
  hasExternalSrt: boolean;
  hasWhisperSrt?: boolean;
  externalSrtPath?: string;
  hasEmbeddedDubtitles?: boolean;
  hasEmbeddedSubtitles?: boolean;
  thumbnailUrl?: string;
  kitsuThumbnail?: string | null;
  kitsuTitle?: string | null;
  episodeTitle?: string | null;
  isDownloading?: boolean;
  downloadProgress?: number;
}

export interface AnimeFolder {
  folderPath: string;
  folderName: string;
  episodes: Episode[];
  isDownloading?: boolean;
  downloadProgress?: number;
  hasSubtitlesCount: number;
  hasWhisperCount?: number;
  hasExtSubCount?: number;
  hasDubtitlesCount?: number;
  hasEmbeddedDubtitles?: boolean;
  hasEmbeddedSubtitles?: boolean;
  totalEpisodes: number;
  posterUrl?: string | null;
  bannerUrl?: string | null;
  canonicalTitle?: string | null;
  anilistId?: number | null;
  synopsis?: string | null;
  genres?: string[];
  averageScore?: number | null;
}

export interface PlaybackProgress {
  filePath: string;
  folderPath: string;
  fileName: string;
  episodeNumber: string;
  currentTime: number;
  duration: number;
  lastWatchedAt: number;
  completed: boolean;
}

export interface SeasonPreference {
  preferredAudioLanguage: string; // default 'eng'
  preferredAudioIndex?: number;
  mainSubtitleTrackId?: string | null;   // null means explicitly OFF
  topSubtitleTrackId?: string | null;    // null means explicitly OFF
  topSubEnabled: boolean;
  subSyncOffset: number;          // in seconds (-0.5, 0.5, etc.)
}

export type DiscoverSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
export type DiscoverMode = 'season' | 'trending' | 'popular' | 'recommended' | 'search';
export type DiscoverSort = 'RECOMMENDATION' | 'POPULARITY_DESC' | 'TRENDING_DESC' | 'SCORE_DESC' | 'TITLE_ROMAJI' | 'SEARCH_MATCH';
export type DiscoverAgeRating = 'ALL' | 'G' | 'PG' | 'PG-13' | 'R-17+' | 'R+' | 'NR';

export interface DiscoverCatalogParams {
  mode: DiscoverMode;
  search?: string;
  searchScope?: 'all' | 'season';
  /** False disables the season/year constraint in the non-search seasonal view. */
  seasonFilterEnabled?: boolean;
  year?: number;
  season?: DiscoverSeason;
  genre?: string;
  format?: 'TV' | 'TV_SHORT' | 'MOVIE' | 'SPECIAL' | 'OVA' | 'ONA' | 'MUSIC';
  status?: 'FINISHED' | 'RELEASING' | 'NOT_YET_RELEASED' | 'CANCELLED' | 'HIATUS';
  minScore?: number;
  ageRating?: DiscoverAgeRating;
  sort?: DiscoverSort;
  page?: number;
}

export interface AppSettings {
  ffmpegPath: string;
  whisperPath: string;
  defaultLibraryRoot: string;
  libraryFolders?: string[];
  autoPlayNext: boolean;
  subtitlesFontSize: number;
  subtitlesOutline: boolean;
  subtitlesTextColor?: string;
  subtitlesFontFamily?: 'sans' | 'trebuchet' | 'rounded' | 'serif' | 'mono';
  subtitlesBgStyle?: 'none' | 'translucent' | 'semi' | 'solid';
  subtitlesOutlineWidth?: 'thin' | 'medium' | 'thick' | 'heavy' | 'none';
  subtitlesOutlineColor?: string;
  /** Legacy setting retained only so older settings files remain readable; incomplete titles are always hidden. */
  hideDownloadingAnime?: boolean;

  // ---- P2P / BitTorrent (BYOC — user provides their own indexers) ----
  enableP2P?: boolean;              // default false — the torrent engine never starts until the user opts in
  p2pConsentAcceptedAt?: number | null;
  maxConcurrentDownloads?: number;  // default 2
  seedMinutesAfterComplete?: number; // 0 = stop seeding immediately once the download completes
  downloadSpeedLimitMBps?: number;  // 0 = unlimited
  uploadSpeedLimitMBps?: number;    // 0 = unlimited
  rssProviders?: RssProvider[];     // user-provided RSS/Torznab indexers — NO defaults, nothing hardcoded
  downloadTargetFolder?: string;    // optional override; defaults to the first library folder
  releaseSelectionMode?: 'automatic' | 'manual'; // automatically queue the best ranked release, or let the user choose
  /** Languages accepted by automatic release matching; an empty list accepts any explicitly detected language. */
  preferredTorrentAudioLanguages?: string[];
  preferredTorrentSubtitleLanguages?: string[];
}

// ---- P2P shared types ----

export interface RssProvider {
  id: string;
  name: string;
  urlTemplate: string; // e.g. https://example.example/search?q={query} — user-supplied, never bundled
  type: 'rss' | 'torznab';
  enabled: boolean;
}

export interface VpnStatus {
  active: boolean;
  interfaces: string[];
  checkedAt: number;
}

export interface ReleaseSearchResult {
  providerId: string;
  providerName: string;
  title: string;
  downloadUrl: string; // magnet: URI or http(s) URL to a .torrent file
  /** Infohash supplied separately by RSS indexers, even when downloadUrl is a .torrent URL. */
  infoHash?: string;
  /** Optional description supplied by RSS/Torznab. May contain HTML. */
  description?: string | null;
  /** Optional human-readable release page URL, separate from the torrent URL. */
  detailsUrl?: string | null;
  sizeBytes: number | null;
  /** Warning attached by the app when an episode result is implausibly small for its runtime. */
  sizeWarning?: string | null;
  /** Whole-word title relevance vs the searched title/aliases, attached by the
   *  ranking step ('none' = the release names a different show, e.g.
   *  "Pocket Monsters" for a "Monster" search). */
  titleRelevance?: 'exact' | 'prefix' | 'related' | 'none';
  seeders: number | null;
  leechers: number | null;
  pubDate: number | null;
}

export interface ProviderReport {
  providerId: string;
  providerName: string;
  ok: boolean;
  itemCount: number;
  error?: string; // network / HTTP status / parse failure detail
}

export interface ReleaseSearchResponse {
  results: ReleaseSearchResult[];
  reports: ProviderReport[];   // one per ATTEMPTED provider; empty when zero enabled providers
  queries: string[];           // sanitized queries actually used (first = primary)
  skippedWrongEpisodeCount?: number;
}

export type TorrentJobStatus = 'queued' | 'connecting' | 'downloading' | 'paused' | 'seeding' | 'completed' | 'error';

export interface TorrentJob {
  infoHash: string;
  name: string;
  title: string;
  releaseTitle?: string;
  selectedFiles?: string[];
  anilistId: number | null;
  targetFolder: string;
  magnetUri: string;
  status: TorrentJobStatus;
  progress: number; // 0..100
  downloadedBytes: number;
  totalBytes: number;
  downloadSpeed: number; // bytes/sec
  uploadSpeed: number;   // bytes/sec
  peers: number;
  /** Seed count advertised by the indexer when the user picked the release; not a live swarm check. */
  reportedSeeders?: number | null;
  providerName?: string;
  connectingSeconds?: number;
  /** Seconds since the selected torrent data last increased during this run. */
  noProgressSeconds?: number;
  /** Piece availability among currently connected peers, when WebTorrent exposes it. */
  missingPieces?: number;
  availableMissingPieces?: number;
  stallRecoveryCount?: number;
  torrentWarning?: string;
  episode: number | null;
  /** All selectively requested episodes when a batch torrent serves several cards. */
  episodes?: number[];
  season?: number | null;
  error?: string;
  addedAt: number;
  completedAt?: number | null;
  filesProgress?: Array<{ name: string; progress: number; length: number }>;
}

export interface P2pState {
  enabled: boolean;
  consentAccepted: boolean;
  jobs: TorrentJob[];
  limits: {
    maxConcurrent: number;
    seedMinutes: number;
  };
}

export interface WhisperQueueItem {
  id: string;
  filePath: string;
  fileName: string;
  duration?: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' | 'cancelled';
  progress: number;
  speed?: string;
  error?: string;
}

export interface WhisperLogMessage {
  type: 'stdout' | 'stderr' | 'info' | 'error' | 'success';
  text: string;
  timestamp: number;
}

export interface WhisperStatus {
  isRunning: boolean;
  folderPath?: string;
  currentFile: string;
  progress: number;
  queue: WhisperQueueItem[];
  logs: WhisperLogMessage[];
}
