# Changelog

## 1.0.11 — In-App Model & Engine Deletion, Windows Long Path Fix, Subtitle Single-Word Merging & Smart Prompt Overhaul

- **Subtitle Single-Word Merge & 2-Line Formatting Overhaul:**
  - Resolved an issue where merging isolated single words created an awkward 3rd subtitle line or messy capitalization.
  - Enforced a strict maximum of 2 lines per subtitle cue (`max_line_count: 2`) with smart mid-sentence line balancing (`maxLineWidth: 44`); merges that would overflow into a 3rd row are automatically rejected.
  - Implemented smart casing: lowercases isolated words when merged mid-sentence (e.g. `"I think"` + `"So."` -> `"I think so."`), while properly preserving proper nouns, character names, and pronouns (`"I"`, `"I'm"`).
  - Implemented start-of-cue uppercasing and subsequent word lowercasing when prepending (e.g. `"because"` + `"He was tired."` -> `"Because he was tired."`).
- **Whisper Initial Prompt & Hotwords Generator Overhaul:**
  - Reworked character prompt generation from the ground up to follow natural speech priors: `"Dialogue from an anime episode. Characters: {names}."`.
  - Removed prompt leak artifacts (`"Anime dialogue, conversational speech, clean subtitles"`).
  - Enforced strict token budget (<= 180 tokens) with token-aware character ranking.
  - Prioritized `MAIN` characters before `SUPPORTING`, completely skipping `BACKGROUND` and episodic extras.
  - Normalized API character data: stripped voice tags, titles, honorifics, and parentheses; fixed Japanese surname-first ordering (`"Yeager Eren"` -> `"Eren Yeager"`); and filtered out non-name descriptions (`"Kyon no Imouto"`, `"X's sister"`, `"Townsperson A"`).
  - Length trimming: full names for top 3 characters, spoken/first names for remaining characters.
  - Ambiguous common English word names (`"Light"`, `"Ray"`, `"May"`, `"Rose"`, etc.) pushed to the end of candidate lists to prevent Whisper substitutions.
  - Added `--hotwords` support passing top character names as a single comma-separated string to Faster-Whisper.
- **RapidFuzz-Style Fuzzy Character Name Post-Processing & Hallucination Filtering:**
  - Integrated conservative whole-word fuzzy spelling correction (Levenshtein distance <= 2, ratio >= 86%) for character names using the unconstrained full cast list.
  - English dictionary stoplist protection: common English words are strictly immune from name replacement.
  - Automatic silence and music loop hallucination filtering (`"Thank you for watching"`, `"Subtitles by..."`, repetitive loops).
- **In-Player Episode Drawer Resume Progress Fix:**
  - Resolved an issue where selecting an episode from the in-player side drawer or next episode switcher always restarted from 0:00 instead of resuming from the user's saved watch progress.
- **Windows Long Path (MAX_PATH 260 Chars) Whisper Generation Fix:**
  - Fixed `FileNotFoundError: [Errno 2] No such file or directory` when Faster-Whisper finishes transcribing episodes with long filenames and release group tags (e.g. `Even.the.Student.Council.Has.Its.Holes.S01E01...`).
  - Eliminated redundant 100+ character duplicated subfolder names in `AppData/Roaming/Kaiko/whisper_tmp/<runId>/<long_file_id>/<long_file_id>.srt`, replacing them with a compact hash-based directory in system temp (`Temp/kaiko_w/<run>_<hash>`), reducing path length by over 130 characters and preventing Windows MAX_PATH failures.
  - Added fallback subtitle file resolution in staging directories to ensure output files are reliably captured regardless of minor naming sanitizations.
- **In-App Engine & Model Deletion:**
  - Added full capability to delete installed AI Whisper models directly from within Settings with 1-click confirmation, cleanly freeing disk space from HuggingFace cache and local model directories.
  - Added dedicated **Delete Engine** control in Settings to remove the installed Faster-Whisper-XXL standalone engine from application storage whenever needed.
- **Simplified Model Management in Settings:**
  - Removed confusing "Active" / "Inactive" model selection badges, radio circles, and "Select" action buttons from Settings.
  - Model selection is handled directly on-the-fly in **Whisper Studio**, while Settings now purely provides clean **Download** and **Delete** actions for each model.
- **Settings & Navbar De-clutter:**
  - Removed verbose descriptive subtitles under section headers in Settings (Media Folders, Title Language, Application Updates, Data & Backup, and P2P & Downloads) for a sleek, compact settings layout.
  - Removed the redundant "Transcribing in background" badge from the top navigation bar, preserving clean UI aesthetics while keeping the active generation indicator on the Whisper Studio tab.

## 1.0.10 — Model Download Polish, Robust Cancellation, Whisper Auto-Select & Manual Update Prompt

- **Model Download Progress & TQDM Output Sanitization:**
  - Sanitized Faster-Whisper download terminal output, stripping ANSI escape sequences, carriage returns, and raw block characters.
  - Replaced scrambled terminal text with clean, human-readable status: file name, transferred/total size (`MB/GB`), transfer speed (`MB/s`), and estimated time remaining.
- **Graceful Cancellation & Model Integrity Validation:**
  - Fixed false `exit code null` error toast when cancelling model downloads in Settings.
  - Implemented deep file integrity check (`model.bin` / `model.safetensors` > 50 MB) before detecting models as installed, preventing cancelled partial folders from falsely showing as installed or active.
  - Fixed active badge logic so uninstalled models never display as "Active".
- **Whisper Studio Auto-Selection for All Episodes Without AI Subs:**
  - Auto-selects all episodes that lack AI-generated subtitles (`.whisper.srt`), even if they contain regular Japanese translation subtitles (embedded or external SRTs).
  - Episodes are now only excluded from auto-selection if AI dubtitles have already been created for them.
  - Improved progress feedback when Faster-Whisper downloads models on-the-fly, displaying clear `Downloading AI Model...` badges and status explanations in both the header and Live Dialogue stream.
- **Manual Update Prompt in Settings:**
  - Clicking "Check for Updates" in Settings now opens the rich, formatted Update Prompt modal with release highlights when a new version is found, with the "Don't show again" checkbox cleanly hidden for on-demand checks.

## 1.0.9 — Bundled 7-Zip Engine & Zero-Dependency Archive Decompression

- **Bundled 7-Zip Decompression Engine (`7z.exe` + `7z.dll`):**
  - Resolved Faster-Whisper-XXL engine decompression failure (exit code 1) on Windows 10 and systems where Windows `tar.exe` lacks native `.7z` / `libarchive` format support.
  - Bundled lightweight, standalone 7-Zip decompression binaries (`bin/7z.exe` and `bin/7z.dll`) directly into Kaiko's application resources (`resources/bin/`), guaranteeing 100% extraction reliability on all Windows versions with zero external dependencies.
  - Added smart extraction cascade prioritizing the bundled 7-Zip engine, with graceful fallbacks to user-installed 7-Zip and system `tar.exe`.
  - Added real-time extraction progress percentage streaming (`-bsp1`) directly in the UI during unpacking with detailed stdout and stderr error reporting.

## 1.0.8 — In-App Faster-Whisper-XXL Engine Downloader & Rich Release Notes Formatting

- **In-App Faster-Whisper-XXL Engine Downloader & Auto-Setup:**
  - Integrated 1-click in-app downloading and extraction of the standalone `Faster-Whisper-XXL` speech-to-text engine directly within Kaiko.
  - Completely eliminates the need to visit GitHub or manually download and extract `.7z` archives using external tools.
  - Built-in streaming download engine with real-time transfer progress, speed, percentage, and cancellation support.
  - Native archive extraction powered by Windows `tar.exe` / `libarchive` directly into persistent application storage (`AppData/Roaming/Kaiko/bin/faster-whisper-xxl`).
  - Accessible from both **Settings → Whisper** and the **Whisper Studio** setup banner with immediate auto-configuration upon completion.
- **Rich Release Notes Formatting & Sanitization in Updater:**
  - The Update Available dialog now parses and renders formatted HTML / Markdown release notes from GitHub / `electron-builder` instead of displaying unrendered raw markup tags.
  - Polished GitHub-style dark theme styling for headings, bulleted lists, bold text, inline monospace code badges, and code blocks.
  - Secure DOM sanitization preventing XSS or malicious script injection.
  - Intercepts external links to safely open in the user's default web browser instead of navigating the app window.
  - Expanded container height with smooth scrolling for enhanced readability.

## 1.0.7 — Built-in FFmpeg, Visual Whisper Studio, Model Presets & Notification Center Integration

- **Built-in FFmpeg Media Engine:**
  - FFmpeg is now automatically fetched and bundled directly into the installer/application package (`bin/ffmpeg.exe`), enabling out-of-the-box support for 10-bit HEVC, MKV audio/subtitle extraction, and audio transcoding without requiring manual user downloads or external tools.
  - Eliminated redundant FFmpeg setup clutter from Settings; auto-detection seamlessly locates the bundled binary across installed, portable, or project paths.
- **Visual Anime Selection in Whisper Studio:**
  - Replaced raw disk path picking with interactive visual anime cards from the local library, complete with poster art, episode counts, and status indicators.
  - Added a responsive modal library browser with search and filter tabs (All, Needs Subtitles, Has AI Subs).
  - Consolidated redundant model badges down to a single clean badge in the header.
- **Preset Model Quick-Download & Local Model Detection:**
  - Fast 1-click in-app downloading for `large-v3-turbo` (Default & Recommended), `medium` (Mid-Range GPU), and `small` (CPU / Low VRAM) with real-time download percentage progress.
  - Added "Other Locally Installed Models" section displaying any locally detected models (such as `tiny` from Subtitle Edit or HuggingFace cache) with one-click selection.
  - Added download guard: prevents subtitle generation errors while a model is in the middle of downloading, with live status pills on the model buttons.
- **Comprehensive Subtitle Detection & Dynamic Character Tracking:**
  - Accurately detects and distinguishes embedded dubtitles (SDH), embedded stylized signs/dialogue, and external SRTs alongside AI-generated subtitles.
  - Dynamic character name detection via AniList updates automatically whenever a different anime is chosen.
  - Locked anime selection and episode controls while subtitles are actively generating to prevent race conditions.
- **Audio & Notification Polish:**
  - Suppressed the sharp system beep / console bell emitted by `faster-whisper-xxl` upon completion by passing `--beep_off`.
  - Full Notification Center integration: completed episodes and finished batches route into the app's persistent Notifications drawer (`Navbar` bell) with direct "Whisper Studio" action navigation.
  - Simultaneous non-intrusive in-app toasts and quiet native Windows desktop notifications.
- **UI & Localization Polish:**
  - Cleaned up AI section in Settings with collapsible details and eliminated text clutter.
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
