# Changelog

## 3.2.0 — Whisper Accuracy Overhaul, Movie Detection, Discover & Completion Prompt Fixes

### Whisper Studio & Subtitles
- Switched default VAD across presets to `pyannote_v3` to capture child and higher-pitched speech without skipping lines.
- Stopped forcing synthetic prompt strings (`"Dialogue from an anime episode."` / unrequested character lists) when no custom prompt is set, preventing skipped cue starts and leaked non-English artifacts.
- Restored `condition_on_previous_text` (`true`), `compression_ratio_threshold` (`2.4`), and `--max_comma_cent 70` for natural multi-line timing.
- Filtered non-Latin gibberish / stutter-loop hallucinations, merged 1-2 word spillover cues, and widened the player subtitle overlay (`max-w-[92vw]`) to avoid accidental 3-line wrapping.

### UI & Playback
- **Movie Detection:** added folder-name and AniList `MOVIE` format detection (`isFolderMovie`, `resolveEpisodeBadgeLabel`, `resolveResumeUnitLabel`) so movies show `Movie` and `Resume Movie` instead of `EP` / `Resume EP` in the Home hero banner, Recent Episodes rail, player Episode Drawer, Anime Detail view, and Season Hero chips.
- **Completion Notification:** centered `CompletionPrompt` using a full-width flex container so Framer Motion's vertical slide animation no longer overrides horizontal centering.
- **Discover Dropdowns:** fixed `SelectField` and `GlassSelect` click propagation so single-select filter dropdowns close cleanly after selection while the multi-select `Genre` picker stays open.

## 3.1.0 — Fast Multi-Connection Updater, Touchpad Magnetic Rail Scroll, Flush Card Badges & Episode Synopses

### Auto-Updater & Progress UI
- **Fast single-pass updater (`electron/updater.ts`):** disabled `electron-updater`'s sequential differential blockmap pass that triggered a slow second download from scratch on checksum mismatch, and upgraded `downloadDirectAsset` to stream installers directly over 6 parallel HTTP Range connections with automatic single-stream fallback.
- **Reliable download progress (`UpdatePromptModal.tsx`):** reset `displayPercent` cleanly when a phase changes or transfer restarts so the percentage indicator never stalls at `100%`.

### Home, Touchpad Gestures & Cards
- **Touchpad two-finger magnetic wrap-around (`HorizontalScroller.tsx`, `App.tsx`):** two-finger horizontal trackpad swipes at either end of a Home rail now activate the magnetic overscroll indicator and smoothly wrap back to the beginning or end upon gesture release instead of handing off to back navigation.
- **Episode synopsis in Continue Watching / Up Next (`UpNextWidget.tsx`, `aniZip.ts`, `main.ts`):** the Home resume banner now displays the current episode's synopsis (sourced from ani.zip / Kitsu) and falls back to the series overview when no episode summary is available.
- **Flush bottom badge backdrop (`AnimeCard.tsx`):** anchored the dark gradient behind status and download badges directly to the bottom and side edges of poster cards.

## 3.0.0 — Schedule Overhaul, Unified Hero Banners, Whisper Loading State & Windows Identity

### Schedule & Discovery
- **Airing schedule overhaul (`ScheduleView`):** switched to a 7-day board alongside focused single-day filtering, added week navigation controls (`Last week`, `This week`, `Today`, `Next week`), a calendar date picker to jump to any week or day, inline title search within the schedule, and a `Followed only` toggle.
- **Horizontal rails & Discover navigation (`HomeView`, `HorizontalScroller`):** rail scroll arrows now appear on hover across the entire row width; dragging past the edge engages a magnetic progress indicator that wraps to the beginning or end only upon cursor release; `See all` links on Home rails open Discover filtered to the matching category or genre.

### Interface, Player & Metadata
- **Unified hero banners & Navbar layout:** added official series clearlogos to Home resume banners and anime detail pages, aligned header banners across Discover, Library, Schedule, and Downloads, and fixed Navbar wrapping/resize geometry.
- **Downloads & storage view:** combined disk usage metrics, available drive space, active P2P transfer stats, and downloaded series cleanup into a cohesive layout.
- **Episode metadata & player polish:** improved Kitsu/AniList/ani.zip/Fribb episode title and 16:9 thumbnail matching, refined `VideoPlayer`, `EpisodeDrawer`, and `TimelineScrubber`, and avoided full disk library rescans when changing watchlist status or score.

### Whisper Studio
- **Clean anime switching state:** changing the active anime or browsing a different folder immediately clears the previous series' episodes, resets stale selection and audio tracks, and displays an episode scanning indicator and card skeletons while probing.

### Startup & Windows Integration
- **Startup splash window & black-flash fix:** redesigned the startup splash screen (`kaiko-splash.html`) and initialized `BrowserWindow` directly at full `workArea` dimensions before maximize/reveal so Chromium never exposes an intermediate centered black surface during launch.
- **Task Manager process identity:** compiled assembly metadata into the root `Kaiko.exe` launcher and branded the Electron runtime executable with `Kaiko` version info and icon so Windows Task Manager displays **Kaiko** (`Kaiko.exe`) instead of **Electron**.

## 2.0.1 — Hotfix: Update Flow & Provider Retry

### 🔄 Update Flow
- **Honest download progress:** the update progress bar no longer shows a hardcoded 160 MB total followed by jumpy delta/full phases. The differential (blockmap) phase is labeled `(delta)`, a silent fallback from the delta to the full installer restarts the progress window instead of keeping a stuck monotonic percent, and the real installer size from the GitHub release API replaces the placeholder.
- **"What's New" no longer offers a fake update:** viewing release notes for the current version renders the modal as a plain notes viewer (Close button, no "Update Now", no don't-show-again checkbox), and the main process refuses to re-download the same version. "Check for Updates" on the latest release only confirms you are up to date.

### 🖥 Touchpad Swipe Back
- **Two-finger swipe back works on Windows laptops:** the app now tracks mostly-horizontal touchpad swipes at the wheel level (the Chromium overscroll gesture often never fires there). Swiping left returns to the previous screen — over horizontally scrollable rails the swipe scrolls them instead, at end-of-scroll it hands off to back navigation. Direction flips reset the gesture and a cooldown absorbs trackpad inertia.

### 🌐 Provider Errors & Retries
- **Failed provider searches are no longer cached:** when all providers fail (timeout, offline, 5xx) the empty result is not written into the search cache, so retrying the download immediately re-queries the providers instead of replaying the cached error for two minutes. Partial failures that still found usable releases stay cached so a season queue drain doesn't hammer providers.

## 2.0.0 — Design Overhaul, OVA Torrent Search Engine & Episode List Integrity

A global update: a full visual overhaul of the app shell, a rework of the OVA torrent search and download pipeline, and integrity fixes for episode lists polluted by franchise extras.

### 🎨 Design Overhaul

- **Floating glass navbar:** the navbar is now a floating overlay — pages scroll under it so the backdrop blur reads real content, with a per-title hue tint. The banner tint fades out with scroll progress (it no longer hides the blur), and the blur is toggleable in Settings (`navbarBlur`, on by default) for weaker PCs.
- **Glass design system:** new `GlassSelect` component, hue-family color remap, glow tokens, and banner fade rebalance; cold blue-gray hexes replaced with palette tokens throughout.
- **Scroll performance:** navbar progress flows through a pub-sub outside React state, page trees are memoized, hover transitions are suppressed during scrolls, and pills use a backdrop-filter-free glass style — smooth FPS while scrolling long pages.
- **Notifications drawer:** relative timestamps on a 5-second ticker while the drawer is open, swipe-to-dismiss rows, more opaque cards and larger fonts.
- **Library cards:** rating pill that survives 2-line titles, icon-only Followed/Favourite badges, and catalog scores lazy-loaded for collection-only entries.
- **Discover:** accent-gradient filter controls, centered mode tabs, and a cleaner header.
- **Whisper Studio:** the episode selector is rebuilt as a thumbnail card grid with click-toggle and hold-drag sweep selection; redundant folder button removed; link-style buttons de-underlined.
- **Single-episode titles** of any format (OVAs, specials, music videos) get the film treatment: hero Play/Download actions instead of a one-card grid.

### 🔍 OVA Torrent Search & Downloads, End to End

- **OVA pages search with parent-season aliases:** aliases are built from the AniList PARENT relation (previously only PREQUEL/SEQUEL, leaving the alias list empty so a single query fired). The ≤3 indexer queries now also run in parallel.
- **Wrong-season bundle rejection on OVA pages:** franchise season chains are resolved for OVAs via the AniList graph, so mega-bundles containing other seasons are rejected during automatic search; the franchise filter guards automatic searches again (the condition was inverted).
- **Smarter OVA auto-pick:** dedicated OVA/unknown releases compete with bundles inside seeded-first language tiers; shape ordering prefers dedicated → single-season bundle → whole-franchise mega-bundle; uncensored releases get a tie-break bonus; content-type tails (+OVA, +Movie, Specials, S01+02) keep prefix relevance and count as multi-season collections.
- **Engine file selection fixes:** repaired the `ovaMarker` regex whose character class closed early — it had silently killed every `' ova '` basename match; plural OVA dirs/files are accepted, marker-matched files beat token-only matches, and ties break by distinctive title tokens.
- **Multi-episode OVA series** (Hellsing Ultimate, DxD OVA): `episodeCount` is plumbed renderer → preload → job → persist/resume, so the whole download is kept and episode cards narrow by decimal or roman number; season isolation inside the OVA branch drops other seasons' OVAs from franchise mega-bundles.
- **No more eternal zombie downloads:** a swarm stalled 75 s after both stall-recovery attempts with no peers and no available pieces now fails with a clear message instead of sitting at 0 MB/s forever.

### 📺 Episode List Integrity (API Episode Search)

- **Franchise extras no longer pose as regular episodes:** ani.zip crosswalks number franchise OVAs/specials as regular episodes (Steins;Gate's OVA shipped as ep 1 while the true "Turning Point" was missing). Every slot is now date-guarded against the AniList schedule spine, and rows airing after all higher-numbered episodes are dropped (`electron/episodeSlots.ts`). Validated across all 216 cached snapshots — zero legit episodes flagged. Poisoned caches self-heal on every view open.

### ⚡ Subtitle Performance

- **Two-phase subtitle extraction:** cold opens extract a 2-minute window around the playback position first (indexed seek, ~8% of the file, 1–3 s) while the full track builds in the background; the renderer swaps seamlessly via a `forceFull` re-request that dedupes onto the running extraction.

### 🛠 Other Fixes & Polish

- Season and OVA release downloads fixed end to end (season-batch title formats like `Title 01-12 Complete` are matched correctly against the franchise chain).
- Collection-only cards fetch missing posters via catalog details (24 h cache), matching the queue-cover fallback pattern; the storage overview reloads when the active job set changes.
- **No more subtitle-generation toasts during playback:** background Whisper events ("Episode Subtitles Ready", "Whisper Batch Completed", model/engine readiness) no longer pop toasts over the video player — they land silently in the notification center.

## 1.0.18 — Episode Titles Integrity Fix & Hidden Developer Mode

- **Fixed Wrong Episode Titles on Anime Detail Pages (ani.zip Interleaved Shorts):**
  - ani.zip occasionally interleaves 2–5 minute specials (chibi shorts, PVs) into a season's main episode numbering (observed live: K-On! S1 — six ~3-minute shorts with their own monthly air dates occupied slots 2–7 of a 13-episode season, pushing the real episodes off their slots while keeping correct titles elsewhere).
  - Added a runtime-consistency filter (`dropInterleavedShortRows`): ani.zip rows whose runtime is far below the season's typical length are dropped from the main numbering, and the freed slots are refilled from the clean Kitsu/AniList streaming sources in the pipeline merge.
  - Shorts-only shows are unaffected (the median itself is small, so nothing qualifies as "far below typical"), and seasons with sparse runtime data are never filtered.
  - Poisoned disk caches self-heal: cached rows are re-partitioned at every view open, and the final merged (clean) snapshot is persisted back, replacing the 7-day poisoned `anizip_<id>.json` records.
  - Normalized the extensionless `./anilist` import to `./anilist.ts`, consistent with the module's other imports.
- **Hidden Developer Mode (Session-Only):**
  - New session-only capability flag (`src/utils/devMode.ts`): granted by tapping the version label in the settings footer 5 times ("You are now a developer" toast), automatically revoked on every app restart. Nothing is persisted to disk or localStorage.
  - The version label stays completely stealth: no hover highlight, no cursor change, no tooltip.
  - The "Copy diagnostic history to clipboard" button on torrent cards in Downloads is now visible only in developer mode.
  - Extensible for future developer-only UI: gate new features with `useDeveloperMode()`.

## 1.0.17 — Instant .torrent Metadata Cache, Connecting Fixes & Player Title Overflow Wrapping

- **Persistent Disk .torrent Cache for Instant Connecting (<100ms):**
  - Downloaded `.torrent` files and resolved swarm metadata are now automatically saved to a persistent disk cache (`torrents/<infoHash>.torrent`).
  - When starting or resuming downloads, the engine loads full metadata directly from the disk cache and passes it straight to the client, completely bypassing the slow `ut_metadata` peer negotiation phase. Downloads start instantly without waiting for metadata.
- **Fixed Peer Discovery & Eliminated Tracker Rate-Limiting:**
  - Removed aggressive tracker polling intervals that caused public trackers to rate-limit or time out (`tracker request timed out (udp://exodus.desync.com:6969/announce)`).
  - Stopped premature disconnection of leecher peers and slow wires during connecting. Leecher wires are now preserved to ensure continuous Peer Exchange (PEX) discovery.
  - Increased connecting watchdog timeout from 180s to 300s (5 minutes), with automatic extension when live peers are actively connected.
- **Player & Library Header Long Title Wrapping:**
  - Fixed title truncation in the video player top header where long anime titles or official episode titles were cut off with an ellipsis (`...`).
  - Added multi-line title wrapping (`line-clamp-2 break-words`) and responsive alignment in `VideoPlayer.tsx`, allowing full titles to display gracefully on any screen resolution without clipping.
  - Improved episode title clamping in `EpisodeDrawer.tsx` and `EpisodeRow.tsx` so long names fit cleanly.

- **Fix Missing Final Piece Stall on Batch Torrents (e.g. 99.7% / 1 Missing Piece):**
  - Resolved a critical piece selection bug where deselecting unchosen files in a multi-file batch torrent pruned the shared boundary piece belonging to the chosen episode.
  - In batch releases, the end of Episode 1 and the start of Episode 2 share a single piece. Deselecting Episode 2 after selecting Episode 1 previously removed that shared piece from WebTorrent's download queue, leaving Episode 1 permanently stuck at 99.7% with 1 missing piece.
  - File selection now strictly deselects unchosen files FIRST, and then selects chosen files, explicitly reinforcing torrent-level piece intervals so boundary pieces are never pruned.
- **Active Piece Selection & Critical Re-Queueing:**
  - When missing pieces are available in the swarm (`availableMissingPieces > 0`), the engine proactively verifies and selects missing pieces directly on the torrent every 10 seconds, ensuring WebTorrent immediately requests them from connected peers.
  - Fixed accurate DHT node count display in diagnostic reports.

## 1.0.15 — Clean Torrent Cards & Full Diagnostic History Clipboard Export

- **Clean Torrent Downloads UI (No Raw Log Clutter):**
  - Removed raw internal technical diagnostics, tracker timeout warnings, and error traces from direct text display on torrent cards in the Downloads tab.
  - The card now remains clean and focused: series title, episode/season badges, clean status chip, progress bar, file size, peer count, live transfer speeds, and selected files.
- **Copy Full Diagnostic History Button (Notepad Icon):**
  - Added a notepad (`FileText`) button to every torrent item in the Downloads page.
  - Clicking the notepad instantly exports the complete chronological event history and network diagnostics to the clipboard, along with an instant toast notification.
  - The exported report contains:
    - **Job Overview**: title, release name, infoHash, status, added date, folder/staging paths, magnet URI, reported seeders vs provider.
    - **Live Swarm & Transfer Metrics**: progress %, downloaded / total bytes, download / upload speeds, live connected peers, missing pieces, available missing pieces, stall recovery count.
    - **Selected Files**: file names, lengths, done status, progress.
    - **Active Wires**: remote address/port, client version/peer ID, connection age, down/up speeds, `ut_metadata` extension support & size, delivered metadata pieces.
    - **Trackers & DHT**: active tracker URLs and announce states, DHT listening status & node count.
    - **Chronological Event Log**: every timestamped action from job creation to present (connecting, wire handshakes, metadata pieces received, timeouts, file selection, stall restarts).
  - Diagnostic history is cached even after cancelling or clearing a torrent, so diagnostics remain exportable.

## 1.0.14 — Manual Update Confirmation, Differential Blockmap Updates & Complete WebTorrent Purge

- **Manual Update Confirmation (No Unwanted Background Downloads):**
  - Eliminated automatic background update downloads on update discovery. The app now only discovers and presents the update and What's New notes, leaving downloading entirely to the user's explicit action ("Update Now").
  - Set `autoUpdater.autoDownload = false` and `autoInstallOnAppQuit = false` to guarantee electron-updater never downloads updates unprompted.
- **Differential Delta Updates (Save Bandwidth & Avoid 160 MB Downloads):**
  - Prioritized `electron-updater` differential blockmap updates (`NsisUpdater`) for packaged installations. It downloads only modified code chunks (typically 5–15 MB) instead of re-downloading the entire 168 MB installer.
  - Standardized installer artifact naming to `Kaiko-Setup-${version}.exe` and `.blockmap` in electron-builder configuration, ensuring blockmaps and checksums align seamlessly with GitHub release metadata.
  - Streaming direct download fallback retains full real-time chunk progress, MB/s speed, and byte counters if differential updates are unavailable.
  - Fixed stream finish listener in `downloadDirectAsset` so completion promises never stall or miss `'finish'`.
- **Settings "Update Now" One-Click Download:**
  - Fixed the "Update Now" button in Settings to directly initiate update downloading and display the live progress bar inline, while "What's New" opens the release highlights modal.
- **Permanent WebTorrent Memory Purge & Duplicate Torrent Fix:**
  - Addressed WebTorrent's internal asynchronous array retention by actively pruning and splicing cancelled, errored, or retried torrents directly out of `client.torrents`.
  - Re-adding any previously deleted or stalled release now reliably starts a clean download without triggering `"Cannot add duplicate torrent"`.

## 1.0.13 — Live Update Progress Bar, Duplicate Torrent Prevention & Clean WebTorrent Unregister

- **Live Streaming Update Progress Bar:**
  - Fixed an issue where manual update downloads in Settings or the update modal stayed frozen at 0% without showing progress.
  - Prioritized direct streaming downloads with live progress chunk reading, real-time speed calculation (MB/s), transferred bytes counter, and immediate visual progress bar movement.
  - Automatically synchronized in-flight download progress as soon as the update prompt modal opens.
- **Prevent "Cannot Add Duplicate Torrent" on Deleted / Retried Torrents:**
  - Fixed an issue where deleting a stalled or connecting torrent left the internal WebTorrent client instance alive in memory, causing subsequent downloads of the same release to fail with a "Duplicate torrent" error.
  - `engineCancel` now thoroughly destroys both `job.torrent` and `job.connectingTorrent`, explicitly purging the infoHash from the WebTorrent client instance.
  - `activateJob` proactively purges any orphaned client instance before calling `client.add()`.
  - Re-adding a previously failed or stalled release cleanly resets the job to queued and re-downloads fresh.

## 1.0.12 — BitTorrent Engine Connection Fix, Live Subtitle Refresh, High-FPS Subtitle Sync & Player Title Polish

- **BitTorrent Connecting & Metadata Timeout Resolution:**
  - Fixed a critical connection cycling bug where newly connected peers were severed after 15s before PEX (`ut_pex`) and metadata (`ut_metadata`) handshakes could complete.
  - Implemented per-wire lifecycle tracking (`wire._connectedAt`), guaranteeing a 12-second grace period for handshakes and peer exchange.
  - Added periodic active DHT `lookup(infoHash)` and tracker announces every 8–15s during the connecting phase.
  - Added high-availability fallback trackers (public UDP, HTTP/HTTPS, and WebTorrent WebSocket swarms) and explicit DHT bootstrap nodes (`router.bittorrent.com`, `dht.transmissionbt.com`, etc.).
  - Extended the connecting watchdog timeout to 180s.
- **Whisper Live Subtitle Badge Refresh Without App Restart:**
  - Resolved an issue where generated subtitles did not appear in Whisper Studio or Anime Detail View until restarting the application.
  - Added real-time `onWhisperEpisodeDone` event processing in Whisper Studio with path normalization across Windows slash styles, immediately updating badges, folder statistics, and selection state.
  - Added reactive `detailSource` updating in the main application view so currently inspected anime screens update subtitle indicators on the fly.
  - Automatically invalidated disk scan cache (`storage.clearLibraryCache()`) upon subtitle completion.
- **Player High-FPS Subtitle Synchronization & Audio Drift Compensation:**
  - Implemented a `requestVideoFrameCallback` frame synchronizer in the video player, driving subtitle cues at the native display refresh rate (60+ FPS) and completely eliminating the 250ms HTML5 `onTimeUpdate` subtitle lag.
  - Added `aresample=async=1000:min_hard_comp=0.100000` to the audio transcoding pipeline to hard-compensate for audio drift exceeding 100ms on weaker PCs.
  - Capped CPU software transcoding output to 1080p (`min(1920,iw)`) and bounded worker threads to prevent 4K HEVC releases from starving CPU on lower-spec hardware.
  - Sorted combined ASS dialogue events chronologically and increased JASSUB font cache to 32 to eliminate rendering bottlenecks on signs and songs tracks.
- **Player Top Bar Title Width & Tooltip Polish:**
  - Removed artificial `max-w-md md:max-w-2xl` width restrictions in the player header, allowing long anime and episode titles to expand naturally across the entire screen.
  - Set `title` attribute to the full formatted anime and episode title for clean hover tooltips.
- **Faster-Whisper CLI Compatibility:**
  - Removed unsupported `--hotwords` command-line argument to prevent `faster-whisper-xxl` exit code 2 errors while preserving full prompt prioritization.

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
