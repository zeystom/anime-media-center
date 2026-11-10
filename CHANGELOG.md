# Changelog

## 1.0.7 — Built-in FFmpeg, streamlined Whisper onboarding & default large-v3-turbo model downloader

- **Built-in FFmpeg Media Engine:**
  - FFmpeg is now automatically fetched and bundled directly into the installer/application package (`bin/ffmpeg.exe`), enabling out-of-the-box support for 10-bit HEVC, MKV audio/subtitle extraction, and audio transcoding without requiring manual user downloads or external tools.
  - Eliminated redundant FFmpeg setup clutter from Settings; auto-detection seamlessly locates the bundled binary across installed, portable, or project paths.
- **Streamlined Whisper Studio & Onboarding:**
  - Removed startup binary warning banner in general library navigation so users can enjoy playback immediately without unnecessary notifications.
  - Setup guidance is surfaced contextualized within the Whisper Studio tab only when subtitle generation is needed.
  - Added clean, direct links to Faster-Whisper-XXL releases and Subtitle Edit for zero-friction engine setup.
- **Focused Model Selection with Default large-v3-turbo:**
  - Standardized on the state-of-the-art `large-v3-turbo` model by default (delivering near large-v3 accuracy at up to 8x faster inference speed).
  - Replaced confusing multi-model selection grids with a focused default card featuring a 1-click in-app downloader with real-time download progress tracking and cancellation.
  - Added seamless custom model support: users can select custom model folders from disk with auto-detection of model names and instant fallback to default.
- **UI & Localization Polish:**
  - Verified 100% English UI consistency across all settings, buttons, dialogs, badges, and notifications.

## 1.0.6 — Intelligent P2P release ranking, quality-first filtering & UI polish

- **Intelligent P2P Quality-First Filtering:**
  - Releases with matching language confidence (e.g. English Dub + Sub / Multi-Subs) now strictly prioritize higher video resolutions (4K / 2160p > 1080p > 720p), regardless of seed count differences.
  - Quality never sacrifices language confidence: a 1080p release with verified English Dub + Sub will never be demoted below a 4K release that lacks English audio or subtitles.
  - Verified Dubtitles (`eng-dub-dubtitles`) retain ultimate precedence over standard subtitles and raw video resolutions.
- **Full Dual-Audio & Multi-Subs Support:**
  - Indexer and release parser now fully detects `Dual-Audio`, `Multi-Subs`, `MultiSub`, and `Multi-Audio` tags, assigning full English/Japanese audio and subtitle metadata with dedicated badges in the release picker.
- **Season Pack Prioritization & Strict Season Isolation:**
  - Whole-season downloads now strictly rank season packs and batches above single individual episodes.
  - Automatic season detection extracts season numbers from titles like `Cyberpunk: Edgerunners 2`, `KonoSuba 2`, `Mob Psycho 100 II`, etc.
  - Releases explicitly belonging to a different season (e.g. Season 1 releases during a Season 2 search) are automatically rejected.
  - Indexer URL builder auto-normalizes missing slashes before `{query}` in user templates (e.g. `http://rutor.info{query}`).
- **UI & UX Refinements:**
  - **Discover:** Vertically centered the genre dropdown chevron icon to align cleanly with format and status filters.
  - **Anime Detail:** Locked width and symmetrical styling for Follow and Favourite buttons to prevent layout shifting on toggle.
  - **My List & Library Sync:** Elevated My List dropdown with backdrop isolation to prevent clipping under episodes, with real-time status synchronization across library and detail views.
  - **Schedule View:** Followed anime are highlighted with a distinct bell icon and subtle raspberry accent border, floating to the top of the schedule.
  - **Status Badges:** Suppressed redundant "Watched" badge on Completed anime to prevent UI duplication.
  - **Escape Key Routing:** Pressing Escape in SettingsModal captures the event and no longer inadvertently navigates back from anime detail pages.

## 1.0.5 — In-app updater & automated GitHub Releases deployment

- **In-App Auto-Updater:** Seamless application updates directly from GitHub Releases without needing to git clone or pull manually.
- **Startup Update Check:** Configurable check on startup (enabled by default) with an interactive prompt to update now, postpone, or permanently suppress future startup prompts.
- **Settings Management:** Display current app version badge in Settings, toggle automatic background updates and startup checks, and trigger manual "Check for Updates" with live progress indicators.
- **Direct GitHub Fallback:** Dual update engine supporting both packaged NSIS delta packages and direct stream-downloaded installers from GitHub Releases API.
- **Episode Art Assets:** Bundled 16:9 widescreen placeholder artwork for upcoming or unreleased episodes.

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
