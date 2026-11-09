# Changelog

## 1.0.4 — Discover infinite scroll, multi-genres, title language & Whisper Studio overhaul

- **Discover Infinite Scroll:** Automatically loads more anime seamlessly as you scroll down.
- **Advanced Multi-Genre & Theme Filtering:** Expanded from 13 to 36 genres and themes (Isekai, Cyberpunk, Shounen, Iyashikei, Psychological, etc.) with multi-select combinations and quick-search.
- **Interactive Genre Navigation:** Click any genre badge on an anime details page to instantly open Discover pre-filtered by that genre.
- **Anime Title Language Preference:** New setting in Preferences allowing you to choose between Localized English, Romaji, and Native Japanese (日本語) titles across the entire app.
- **Player End Card Title Fix:** The "Next Episode" popup overlay at the end of an episode now displays clean official episode titles instead of raw release filenames.
- **Whisper Studio Overhaul:** Streamlined 3-step UI (Folder, Audio track, Quality preset), auto-retrieval of official character names via AniList API to guide recognition, live dialogue stream with spoiler-protection blur toggle, and automated subtitle post-processing (deduplication, hallucination removal, non-English raw character cleanup).

## 1.0.3 — Library and player improvements

- Added Favourites and Followed collection filters to the Library; saved titles remain visible even when their video files are not on this PC.
- Improved episode seeking so repeated 5-second skips build on the intended position and keep the last frame visible while the next stream starts.
- Improved subtitle synchronization between episodes and reduced repeated subtitle-font scans for files without embedded fonts.
- Made the episode drawer opened from the screen edge close when the pointer moves away; the Episodes button retains click-to-close behavior.

## 1.0.0 — Initial public release

- Rebranded the Windows desktop app as Kaiko, with its own icon, launcher, installer, and startup animation.
- Added local anime library management, episode playback and progress, watchlists, discovery filters, airing schedule, and age-rating badges.
- Added follow and download notifications, including in-app popups and per-item dismissal.
- Added the optional, consent-gated WebTorrent client with user-configured RSS/Torznab indexers and manual or preference-based release selection.
- Added subtitle customization, dual subtitle display, and the optional local Whisper Studio workflow.
- Added Windows-focused startup, navigation, media scanning, and scrolling performance improvements.
