# Anime Media Center

<p align="center">
  <img src="./app-icon.png" width="128" height="128" alt="Anime Media Center Icon" />
</p>

<p align="center">
  <strong>Desktop anime library and media player for Windows featuring offline Whisper subtitle generation, native libass rendering, live subtitle styling with contrast spectrum, torrent download protection, and smart OP/ED skipping.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite-5.4-646CFF?style=flat-square&logo=vite" alt="Vite" />
  <img src="https://img.shields.io/badge/TailwindCSS-3.4-38B2AC?style=flat-square&logo=tailwind-css" alt="TailwindCSS" />
  <img src="https://img.shields.io/badge/Whisper-large--v3--turbo-10a37f?style=flat-square&logo=openai" alt="Whisper" />
  <img src="https://img.shields.io/badge/Subtitles-JASSUB%20(libass)-orange?style=flat-square" alt="JASSUB" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" />
</p>

---

## Table of Contents

1. [Why This Exists](#why-this-exists)
2. [System Architecture](#system-architecture)
3. [Core Capabilities & Technical Deep Dives](#core-capabilities--technical-deep-dives)
   - [Hardware-Accelerated Streaming & Demuxing](#hardware-accelerated-streaming--demuxing)
   - [Dual-Subtitle Rendering Engine](#dual-subtitle-rendering-engine)
   - [Faster-Whisper Studio (Offline AI Transcription)](#faster-whisper-studio-offline-ai-transcription)
   - [Windows 10/11 Hardening & System Resilience](#windows-1011-hardening--system-resilience)
   - [UI/UX & Player Ergonomics](#uiux--player-ergonomics)
4. [Keyboard Shortcuts Quick Reference](#keyboard-shortcuts-quick-reference)
5. [External Dependencies & Binary Setup](#external-dependencies--binary-setup)
6. [Installation, Setup & Development](#installation-setup--development)
   - [Prerequisites](#prerequisites)
   - [Setup & Run](#setup--run)
   - [Production Packaging](#production-packaging)
   - [Compiling Native Windows Launcher](#compiling-native-windows-launcher)
7. [Comprehensive Test & Quality Assurance Battery](#comprehensive-test--quality-assurance-battery)
8. [License](#license)

---

## Why This Exists

Watching English-dubbed anime with English subtitles is frequently frustrating. Most commercial and fansub releases only include subtitle tracks translated directly from the original Japanese audio rather than closed captions (SDH/dubtitles) transcribed from the English voice-acting track. As a result, spoken English dialogue and on-screen subtitle text rarely match in phrasing, vocabulary, or timing.

**Anime Media Center** solves this for English learners, hard-of-hearing viewers, and dub enthusiasts by marrying a high-performance local media player with an automated, offline transcription studio:

1. **Stream & Track Inspection:** Automatically inspects Matroska (MKV) containers to categorize audio streams and distinguish between Japanese translation subtitles, signs/songs tracks, and voice-matched English dubtitles.
2. **Offline Whisper Studio:** Employs local `faster-whisper-xxl` with OpenAI's `large-v3-turbo` model to transcribe English dub audio into word-accurate `.srt` files (`<episode>.whisper.srt`) whenever official dubtitles are missing.
3. **Dual-Subtitle Playback:** Renders voice-matched `.srt` dialogue at the screen bottom while simultaneously rendering complex `.ass` signs, songs, and on-screen translations at the top via WebAssembly `libass` (JASSUB).
4. **Live Contrast Spectrum Customizer:** Real-time subtitle styling against a 10-band vertical rainbow contrast test, guaranteeing legibility across dark, vibrant, and pure white scenes.
5. **Torrent & Incomplete Media Shield:** Multi-layer detection of downloading media via Windows NTFS sparse file cluster verification and Matroska EBML header inspection, preventing player crashes on partial downloads.

---

## System Architecture

Anime Media Center is structured as a decoupled desktop application combining an Electron 33 host process, a background streaming server, and a reactive React 18 single-page application:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        ELECTRON MAIN PROCESS                           │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ electron/main.ts                                                 │  │
│  │ • Window Lifecycle & Global Shortcut Dispatch                    │  │
│  │ • Multi-Drive Directory Scanning & Episode Extraction            │  │
│  │ • IPC Channel Handlers (Episodes, Subtitles, Settings, Torrents) │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│         │                                        │                     │
│         ▼                                        ▼                     │
│  ┌──────────────────────────────┐       ┌───────────────────────────┐  │
│  │ electron/server.ts           │       │ electron/whisper.ts       │  │
│  │ • Local HTTP Server          │       │ • Faster-Whisper Runner   │  │
│  │ • NVENC / x264 Transcoder    │       │ • Multi-Track WAV Demux   │  │
│  │ • EBML Fast Duration (<1ms)  │       │ • Job Queue & Progress    │  │
│  │ • Clamped Thumbnail Caching  │       └───────────────────────────┘  │
│  └──────────────────────────────┘                        │             │
│         │                                                │             │
│         ▼                                                ▼             │
│  ┌──────────────────────────────┐       ┌───────────────────────────┐  │
│  │ electron/torrents.ts         │       │ electron/storage.ts       │  │
│  │ • NTFS Sparse Verification   │       │ • Atomic JSON Persistence │  │
│  │ • EBML Magic Header Check    │       │ • Exponential Retry Lock  │  │
│  │ • Tail Zero Entropy Probe    │       │ • In-Memory Settings/Pref │  │
│  └──────────────────────────────┘       └───────────────────────────┘  │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ IPC / HTTP (localhost:PORT)
┌────────────────────────────────────▼───────────────────────────────────┐
│                    REACT 18 RENDERER PROCESS (Vite 5)                  │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ src/App.tsx                                                      │  │
│  │ • Root Navigation & Playback State Orchestrator                  │  │
│  │ • Fallback AnimeFolder Synthesis (Black-Screen Elimination)      │  │
│  │ • Context-Aware Escape Key Routing & Storm-Resistant Rescans     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│         │                                        │                     │
│         ▼                                        ▼                     │
│  ┌──────────────────────────────┐       ┌───────────────────────────┐  │
│  │ src/components/Player/       │       │ src/components/Library/   │  │
│  │ • VideoPlayer (<video> Host) │       │ • FolderBrowser (Search)  │  │
│  │ • JASSUB WebAssembly (libass)│       │ • EpisodeCard (Sub Badges)│  │
│  │ • SubtitleOverlay (Dual)     │       │ • MovieHeroCard (Dedupe)  │  │
│  │ • EpisodeDrawer (Hotkeys)    │       │ • HeroContinueWatching    │  │
│  │ • TimelineScrubber (Cleanup) │       └───────────────────────────┘  │
│  │ • TrackControls & Contrast   │                        │             │
│  └──────────────────────────────┘                        │             │
│         │                                                │             │
│         ▼                                                ▼             │
│  ┌──────────────────────────────┐       ┌───────────────────────────┐  │
│  │ src/components/Toast.tsx     │       │ src/components/Settings/  │  │
│  │ • Non-Blocking Global Toast  │       │ • WhisperStudio Options   │  │
│  │ • Sliding Window (Cap: 5)    │       │ • Inline Folder Deletion  │  │
│  │ • Leak-Free Timer Map        │       │   Confirmation Guard      │  │
│  └──────────────────────────────┘       └───────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Core Capabilities & Technical Deep Dives

### Hardware-Accelerated Streaming & Demuxing

- **Local HTTP Streaming Server (`electron/server.ts`):** High-bitrate 10-bit HEVC/H.265 and AV1 videos stream smoothly into Chromium's HTML5 `<video>` element using a local HTTP streaming endpoint with full byte-range (`Accept-Ranges: bytes`) support.
- **Hardware Acceleration:** Auto-probes NVIDIA NVENC capabilities (`hevc_nvenc`, `h264_nvenc`) with dynamic bitrate allocation and transparent software transcoding fallback (`libx264`) when hardware acceleration is unavailable.
- **Sub-Millisecond MKV Duration Extraction (`readMkvDuration` in `electron/ffmpeg.ts`):** Instead of spawning heavy `ffprobe` child processes on initial scan, the backend parses Matroska EBML headers directly from the first 64KB on disk. It locates the EBML Segment Info `TimecodeScale` (`0x2AD7B1`) and `Duration` (`0x4489`) elements in **<0.1ms**, allowing instant episode duration display and automatic movie classification.
- **Seek Clamping & Socket Abort Resilience:** Card thumbnails (`/thumb`) and timeline preview scrubbers clamp seek offsets safely within `[0, duration * 0.2]` and `[0, duration - 1]`. Stream pipelines monitor `res.destroyed` and client socket disconnections, preventing `ERR_HTTP_HEADERS_SENT` and unhandled promise crashes during rapid timeline scrubbing.

### Dual-Subtitle Rendering Engine

- **High-Performance WebAssembly JASSUB (`electron/subtitles.ts` & `src/components/Player/VideoPlayer.tsx`):** Embeds `libass` compiled to WebAssembly with Web Workers to render styled `.ass` and `.ssa` subtitles directly onto an off-screen HTML5 canvas overlay. Supports custom embedded fonts extracted directly from MKV container attachments.
- **Dual Track Display:** Simultaneously presents voice-matched `.srt` or SDH dialogue subtitles at the bottom while displaying styled `.ass` signs, songs, and location translations at the top of the viewport.
- **Broad Subtitle File Detection:** Scans for external subtitles with extensions `.srt`, `.ass`, `.ssa`, and `.vtt`, resolving loose episode naming conventions (e.g. `Show - 01.en.srt`, `Show - 01.default.ass`).
- **Non-Destructive Dialogue Classification:** Audio/video probing distinguishes between signs/songs tracks (`isSigns`) and standard English translation dialogue (`hasEmbeddedSubtitles`). Episodes with embedded translation subtitles correctly display emerald `Sub` badges, completely eliminating false-negative `"No Sub"` classifications.
- **Live Contrast Spectrum & Styling Suite (`src/components/Player/TrackControls.tsx`):**
  - Features an interactive **10-band vertical rainbow contrast test** (`Spectrum`, `Dark`, `Bright` modes) directly inside the styling popover.
  - Granular font family choices (Clean Sans Inter, Cinematic Trebuchet MS, Soft Rounded Comfortaa, Editorial Serif Georgia, Monospace).
  - Continuous outline thickness slider with visual snap dot at the **Standard (3px)** preset.
  - Persistent subtitle style configuration saved to atomic local storage.

### Faster-Whisper Studio (Offline AI Transcription)

- **100% Private Offline Generation (`electron/whisper.ts`):** Transcribes episodes locally using `faster-whisper-xxl` and OpenAI's `large-v3-turbo` model. No API keys, no network calls, and no cloud data leakage.
- **High-Index Audio Track Fallback (>6 Tracks):** The native Faster-Whisper CLI `--ff_track` parameter only supports stream indices 1 through 6. For media containing more than 6 audio streams (e.g. multi-dub Blu-ray releases), the backend automatically demuxes the selected English stream to a temporary 16kHz mono PCM WAV file via FFmpeg, passes the WAV directly to Faster-Whisper, and cleans up temporary files upon completion.
- **Sentence Alignment & Queue Management:** Includes sentence-boundary timestamp sync, background queue pause/resume/cancel controls, real-time percentage tracking, and atomic output saving (`<episode>.whisper.srt`).

### Windows 10/11 Hardening & System Resilience

- **NTFS Sparse Cluster Checkpoints (`electron/torrents.ts`):** In Node.js on Windows NTFS, `fs.stat().blocks` is consistently `undefined`. Anime Media Center replaces block checks with an entropy-based checkpoint sampler:
  1. Inspects active torrent companion files (`.!qb`, `.!ut`, `.part`, `.crdownload`, `.downloading`).
  2. Verifies Matroska EBML magic bytes (`0x1A 0x45 0xDF 0xA3`) at the file header.
  3. Tests 10 equidistant checkpoints across the file or companion container to compute real disk cluster allocation.
  4. Computes live download percentage metrics and shields downloading files from player initiation.
- **Atomic File Persistence with Exponential Retry Backoff (`electron/storage.ts`):** Windows Search Indexer and antivirus scanners periodically hold transient read handles on JSON metadata files. `renameSyncWithRetry` performs up to 5 progressive retry attempts with incremental delays (`attempt * 30ms`) on `EPERM` / `EBUSY`, followed by a safe `copyFileSync` + `unlinkSync` fallback.
- **Rescan Storm Immunity (`src/App.tsx`):** Alt-Tabbing or switching focus between applications does not trigger duplicate directory rescans. Rescan invocations utilize in-memory locking (`isScanningRef` and `scanPendingRef`) to collapse redundant scan storms.

### UI/UX & Player Ergonomics

- **Non-Blocking Glassmorphic Toast System (`src/components/Toast.tsx`):** Replaces disruptive synchronous browser `alert()` popups with elegant, stacked notifications. Features an automatic 5-toast queue ceiling, timer cleanup maps to prevent memory leaks, and global event dispatch (`showGlobalToast`).
- **Persistent Episode Drawer (`src/components/Player/EpisodeDrawer.tsx`):** Replaces sensitive hover timers with a rock-solid slide-out drawer. Stays open while browsing and closes only on explicit actions (close button, backdrop click, or `Escape` key). Discoverable via an explicit toolbar button and the `E` keyboard shortcut.
- **Smart Intro Skipping (`S`):** Skips opening sequences (`handleSkipIntro`) when intervals are defined by embedded chapters, AniSkip API, or `.ass` markers. If no intro is present, provides immediate on-screen ripple feedback rather than jumping blindly.
- **Ripple Indicator Polish (`src/components/Player/RippleIndicator.tsx`):** Features complete icon coverage for all playback actions (`seek-forward`, `seek-backward`, `forward`, `sync`, `info`), eliminating blank indicator boxes.
- **Movie vs. Episodic Series Classification (`src/utils/format.ts`):** Automatic single-episode feature film detection (`isFolderMovie`) switches UI presentation into a cinematic Movie Hero layout with backdrop banners, runtime formatting, and duplicate card deduplication.
- **Search Empty State & Settings Protection:**
  - Dedicated search empty state when queries yield zero matches, with a 1-click `Clear Search` reset that preserves library configuration.
  - Inline confirmation guard in Settings modal requiring explicit two-step verification before removing configured library directories.

---

## Keyboard Shortcuts Quick Reference

| Shortcut | Scope | Action |
| :--- | :--- | :--- |
| `Space` / `K` | Player | Toggle Play / Pause |
| `Left` / `Right` | Player | Seek -5 seconds / +5 seconds |
| `J` / `L` | Player | Seek -10 seconds / +10 seconds |
| `F` | Player | Toggle Fullscreen |
| `E` | Player | Open / Close Episode Drawer |
| `S` | Player | Skip Opening / Intro (when active) |
| `N` | Player | Jump to Next Episode |
| `M` | Player | Mute / Unmute Audio |
| `[` | Player | Subtitle Sync -0.5s (display later) |
| `]` | Player | Subtitle Sync +0.5s (display earlier) |
| `-` | Player | Subtitle Font Size Decrease (-2px) |
| `+` / `=` | Player | Subtitle Font Size Increase (+2px) |
| `Esc` | Global | Close Drawer → Dismiss Modal → Exit Player to Library |

---

## External Dependencies & Binary Setup

Anime Media Center relies on two standard, open-source external tools for media demuxing and speech recognition:

1. **`ffmpeg.exe` / `ffprobe.exe`**: Video transcoding, audio extraction, and frame capture.
2. **`faster-whisper-xxl.exe`**: Offline AI speech transcription using CTranslate2 and cuBLAS/CUDA.

Both binaries are auto-detected on startup from standard locations, or can be specified manually in **Settings**.

### Option 1: Standalone Portable (Recommended)

1. Download the Windows release archive from [Faster-Whisper-XXL Releases](https://github.com/Purfview/whisper-standalone-win/releases).
2. Extract the archive into your preferred folder or directly into the `./bin` directory of Anime Media Center.
3. If FFmpeg is not bundled, install it via Windows Package Manager:
   ```powershell
   winget install Gyan.FFmpeg
   ```
4. Verify or set paths in **Settings → Paths & Binaries**.

### Option 2: Automatic Detection via Subtitle Edit

If you already use [Subtitle Edit](https://www.nikse.dk/subtitleedit) with Faster-Whisper XXL installed, Anime Media Center automatically detects the executable at:
```
%APPDATA%\Subtitle Edit\SpeechToText\Purfview-Faster-Whisper-XXL\faster-whisper-xxl.exe
```

> **First Run Note:** When starting your first transcription task, `faster-whisper-xxl` automatically downloads the `large-v3-turbo` model weights (~1.5 GB) into its local `_models` directory.

---

## Installation, Setup & Development

### Prerequisites

- **Operating System:** Windows 10 or Windows 11 (64-bit)
- **Node.js:** v18.0.0 or higher
- **Package Manager:** `npm` (bundled with Node.js)
- **GPU (Recommended):** NVIDIA GPU with CUDA support for rapid NVENC streaming and Whisper inference

### Setup & Run

```powershell
# 1. Clone the repository
git clone https://github.com/zeystom/anime-media-center.git
cd anime-media-center

# 2. Install project dependencies
npm install

# 3. Launch in development mode (Vite HMR + Electron)
npm run dev

# 4. Compile production bundles (TypeScript + Vite)
npm run build

# 5. Launch compiled application
npm start
```

### Production Packaging

To compile a distributable Windows installer (NSIS setup wizard):
```powershell
npm run package
```
Output binaries are generated in `dist-build/`.

### Compiling Native Windows Launcher

The repository includes a native C# launcher stub (`launcher.cs`) that boots the application without an open terminal window and pins to the Windows Taskbar with the custom application icon. To compile the launcher using the built-in .NET framework compiler:

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /win32icon:app-icon.ico /out:"Anime Media Center.exe" launcher.cs
```

Running `setup.bat` automatically invokes this compiler. If `csc.exe` is unavailable, `setup.bat`, `install-shortcuts.ps1`, and `Launch Anime Media Center.vbs` seamlessly fall back to executing the local Electron binary (`node_modules\electron\dist\electron.exe`).

---

## Comprehensive Test & Quality Assurance Battery

Anime Media Center includes an exhaustive automated test battery covering backend parsing, NTFS file systems, state management, player ergonomics, and UI invariants.

### Quick Test Execution

```powershell
# Run baseline regression battery (Milestones 1 - 4)
npm test

# Run complete test battery (including all empirical challenger & adversarial stress suites)
npm run test:all
```

### Test Suite Inventory

| Test Suite | Focus Area | Key Invariants Verified |
| :--- | :--- | :--- |
| `test-episodes.js` | Episode & Title Parsing | 42 episode extraction cases, multi-part anime titles, season normalization, resolution tags, clean display titles. |
| `test-path-security.js` | Security & Directory Traversal | Root drive boundary security, prefix collision prevention, directory traversal containment on Windows. |
| `test-torrents.js` | Incomplete File Detection | Detection of finished media, `.qb` companion checks, zero-byte stubs, and sparse cluster allocation. |
| `test-whisper-queue.js` | Transcription Queue Lifecycle | Full queue state machine: item skipping, cancellation during active runs, retry idempotency. |
| `test-milestone1.js` | Backend Core Verification | External subtitle detection (`.srt`, `.ass`, `.vtt`), `readMkvDuration` EBML parsing, seek clamping. |
| `test-milestone1-adversarial.js` | Backend Adversarial Stress | Malformed EBML headers, 5,000 rapid calls, `renameSyncWithRetry` transient locks, Kitsu folder naming. |
| `test-milestone2.js` | App Architecture & Strings | Idempotent parentheses formatting, `formatEpisodeDisplayTitle`, TV vs. movie heuristic classification. |
| `test-milestone2-adversarial.js` | State Machine & Memory Leaks | 40 stress tests: Fallback `AnimeFolder` recovery, toast queue sliding window (5 items), zero timer leaks. |
| `test-milestone3.js` | Player Controls & Ergonomics | Episode drawer persistence, `KeyE` shortcut, `KeyS` intro skipping, ripple indicator coverage. |
| `test-milestone3-adversarial.js` | Scrubber & Drag Cleanup | Memory leak prevention, window listener unmount cleanup, rAF elimination, JASSUB pause-only rendering. |
| `test-milestone3-challenger2.js` | Subtitle Styling & Presets | TrackControls tab switching, Done action ergonomics, font size steppers `[14, 64]`, 1,000 styling clicks. |
| `test-milestone4.js` | Library UI Polish & Alerts | Subtitle false-negative elimination, replacement of `alert()` with toasts, search empty states, hero deduplication. |
| `test-milestone4-adversarial.js` | Subtitle Truth Table & Search | 16-state subtitle truth table, zero `alert()` in `src/`, regex metacharacter search safety, settings delete guard. |
| `test-milestone4-challenger2.js` | Interaction Stress & Invariants | 23 interaction challenges: Movie hero event broadcast lifecycle, drawer/modal Escape routing, chip polish. |

---

## License

This project is licensed under the [MIT License](LICENSE).
