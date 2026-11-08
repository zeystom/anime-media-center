export type AppNotificationState = 'downloading' | 'completed' | 'error'
export type NotificationTone = 'green' | 'purple' | 'blue' | 'red' | 'amber' | 'cyan'

export interface AppNotification {
  id: string
  kind: 'download' | 'airing' | 'follow'
  title: string
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
}

export interface FollowedAnime {
  anilistId: number
  title: string
  posterUrl: string | null
  status: string
  episodesCount: number | null
}

export interface FavouriteAnime {
  /** AniList id when available; titleKey keeps local-only titles addressable. */
  anilistId: number | null
  titleKey: string
  title: string
  posterUrl: string | null
}
