export type AppNotificationState = 'downloading' | 'completed' | 'error'
export type NotificationTone = 'green' | 'purple' | 'blue' | 'red' | 'amber' | 'cyan'
export type NotificationKind = 'download' | 'airing' | 'follow' | 'whisper'
export type LibraryCollectionFilter =
  | 'all'
  | 'watching'
  | 'planning'
  | 'completed'
  | 'paused'
  | 'dropped'
  | 'favourites'
  | 'followed'
export type NotificationActionType =
  | 'open-anime'
  | 'open-library'
  | 'play-episode'
  | 'find-episode'
  | 'manual-pick'
  | 'open-downloads'
  | 'open-whisper'
  | 'open-settings'
export type SettingsTabId = 'general' | 'subtitles' | 'ai' | 'downloads' | 'backup' | 'updates'

export interface AppNotification {
  id: string
  kind: NotificationKind
  title: string
  /** Canonical series title preserved separately from headline (`"New episode aired"`). */
  animeTitle?: string
  message: string
  createdAt: number
  read: boolean
  anilistId?: number
  posterUrl?: string | null
  episode?: number
  /** Live torrent lifecycle for kind 'download': the panel renders a progress
   *  bar for 'downloading' and colors the icon per state. */
  state?: AppNotificationState
  /** 0..100 — updated in place while the torrent downloads. */
  progress?: number
  /** Stable id of the owning torrent job — progress updates replace the item. */
  infoHash?: string
  /** Semantic accent for notification types, including the season finale. */
  tone?: NotificationTone
  finalEpisode?: boolean
  /** Explicit click action routing + optional metadata */
  actionType?: NotificationActionType
  actionLabel?: string
  libraryFilter?: LibraryCollectionFilter
  folderPath?: string | null
  filePath?: string | null
  settingsTab?: SettingsTabId
}

export function resolveNotificationActionMeta(item: AppNotification): {
  actionType: NotificationActionType | null
  actionLabel: string | null
} {
  if (item.actionType) {
    const fallbackLabel =
      item.actionType === 'play-episode'
        ? 'Watch'
        : item.actionType === 'open-library'
          ? item.libraryFilter === 'favourites'
            ? 'View Favourites'
            : item.libraryFilter === 'followed'
              ? 'View Following'
              : 'Open Library'
          : item.actionType === 'find-episode'
            ? item.episode
              ? `Find EP ${item.episode}`
              : 'Find Episode'
            : item.actionType === 'manual-pick'
              ? 'Choose Release'
              : item.actionType === 'open-downloads'
                ? item.state === 'error'
                  ? 'View Error'
                  : 'Downloads'
                : item.actionType === 'open-whisper'
                  ? 'Whisper Studio'
                  : item.actionType === 'open-settings'
                    ? 'Open Settings'
                    : 'Open Anime'
    return {
      actionType: item.actionType,
      actionLabel: item.actionLabel || fallbackLabel,
    }
  }

  if (item.kind === 'follow') {
    return { actionType: 'open-library', actionLabel: 'View Following' }
  }

  if (item.kind === 'download') {
    if (item.state === 'completed' && (item.anilistId || item.folderPath)) {
      return { actionType: 'open-anime', actionLabel: 'Open Anime' }
    }
    if (item.state === 'error') {
      return { actionType: 'open-downloads', actionLabel: 'View Error' }
    }
    return { actionType: 'open-downloads', actionLabel: 'Downloads' }
  }

  if (item.kind === 'airing') {
    if (/couldn't find/i.test(item.title) && item.anilistId && item.episode) {
      return { actionType: 'manual-pick', actionLabel: 'Choose Release' }
    }
    if (item.anilistId && item.episode) {
      return { actionType: 'find-episode', actionLabel: `Find EP ${item.episode}` }
    }
    if (item.anilistId || item.folderPath) {
      return { actionType: 'open-anime', actionLabel: 'Open Anime' }
    }
    return { actionType: null, actionLabel: null }
  }

  if (item.kind === 'whisper') {
    if (item.filePath) {
      return { actionType: 'play-episode', actionLabel: 'Watch' }
    }
    return { actionType: 'open-whisper', actionLabel: 'Whisper Studio' }
  }

  return { actionType: null, actionLabel: null }
}

export interface FollowedAnime {
  anilistId: number
  title: string
  posterUrl: string | null
  status: string
  episodesCount: number | null
  autoDownload?: boolean
  preferredDownloadRoot?: string | null
}

export interface FavouriteAnime {
  /** AniList id when available; titleKey keeps local-only titles addressable. */
  anilistId: number | null
  titleKey: string
  title: string
  posterUrl: string | null
}
