# Anime Media Center & Whisper Studio

<p align="center">
  <img src="./app-icon.png" width="128" height="128" alt="Anime Media Center Icon" />
</p>

<p align="center">
  <strong>The modern anime media center and desktop player for Windows with automated AI English Dubtitle generation, multi-drive library management, smart OP/ED skipping, and native libass subtitle rendering.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011-blue?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react" alt="React" />
  <img src="https://img.shields.io/badge/Whisper-large--v3--turbo-10a37f?style=flat-square&logo=openai" alt="Whisper" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" />
</p>

---

## Why Anime Media Center? (The Motivation)

Many anime fans enjoy watching anime with **English dubbing while keeping English subtitles on** — whether for dialogue clarity, complex lore and terminology, Japanese proper noun spellings, hearing assistance, or personal preference.

However, in **approximately 70% of anime torrents, Blu-ray rips, and community releases**, the included English subtitles are literal translations of the original Japanese dialogue script (often known as "translate-subs" or "signs & songs" tracks) rather than authentic English dubtitles.

When watching with English voice acting, translated subtitles create a severe mismatch:
- The words, grammar, idioms, and humor spoken by the English voice actors diverge completely from what is written on screen.
- Timing and sentence boundaries rarely match the English vocal cadence.
- True voice-matched English SDH dubtitles ("Dubtitles") are almost never provided in anime releases.

**Anime Media Center was created specifically to solve this problem:**
1. **Intelligent Inspection:** It automatically probes each release's audio and subtitle streams to determine whether real English Dubtitles / SDH are present.
2. **One-Click AI Dubtitles (Whisper Studio):** If voice-matched subtitles are missing, the integrated **Whisper Studio** uses offline **Faster-Whisper AI** (`large-v3-turbo` model with voice activity detection and sentence splitting) to transcribe the English audio track directly into 100% voice-matched `.srt` subtitles in batch mode.
3. **Dual-Track Presentation:** During playback, voice-matched dialogue subtitles and translated Japanese on-screen signs/songs can be rendered simultaneously via hardware-accelerated **WebAssembly libass (JASSUB)**.

---

## Key Features

### 🎬 Video Player & Streaming Engine
- **Hardware-Accelerated Transcoding:** Local HTTP streaming server utilizing NVIDIA NVENC with automatic software fallback to play 10-bit HEVC/x265 and high-bitrate Blu-ray MKVs smoothly with minimal CPU usage.
- **Keyframe-Accurate Seeking:** Demuxes GOP boundaries so seeking and scrubbing are instant, without audio desync, decoder stutter, or black frames.
- **Timeline Hover Scrubbing:** High-speed thumbnail previews while hovering the playback scrubber bar, powered by in-memory frame caching and neighbor-frame prefetching.
- **Maximized Windowed Mode:** Launches maximized to fill the active display while keeping the Windows taskbar accessible.

### 📚 Multi-Drive Anime Library & Metadata
- **Multi-Folder Library Roots:** Add and manage anime directories spread across different hard drives and SSDs (e.g. `D:\films`, `E:\Anime`, `F:\Downloads`). All locations are scanned concurrently and merged seamlessly.
- **Rich Vertical Posters (2:3 Aspect Ratio):** Automatic AniList and Kitsu API integration with title normalization, regex season disambiguation (guaranteeing Season 1 is never confused with sequels or spin-offs), synopsis, scores, and banners.
- **Instant Subtitle Status Badges:**
  - 🟣 **`Dub Sub`** — Release contains embedded official English dubtitles.
  - 🟢 **`AI Sub`** — Voice-matched English subtitles generated offline by Whisper Studio.
  - ⚪ **`No Sub`** — No English dub subtitles detected (ready for 1-click generation).

### ⚡ Smart Skip Opening & Ending
- **Multi-Source Detection:** Detects opening and ending sequence intervals using:
  1. Embedded MKV chapter markers (`Opening`, `OP`, `Intro`, `Ending`, `ED`).
  2. Embedded ASS subtitle script markers.
  3. Online **AniSkip API** crowdsourced anime timestamps.
- **Timeline Scrubber Highlight:** Visual glowing indicator on the progress bar showing exactly where the opening theme occurs.
- **Sample-Accurate Skip Buttons:** "Skip Opening" button during the theme and a floating "Skip Ending & Play Next" card when credits roll.

### 🎨 Advanced Subtitle System
- **WebAssembly libass (JASSUB):** Direct canvas rendering of complex Advanced SubStation Alpha (`.ass`) styles, animated karaoke, custom typography, vector drawings, and embedded container fonts.
- **Dual Subtitle Rendering:** Dialogue displayed at the bottom and translated signboards/songs at the top at the same time.
- **Live Sync & Appearance Tuning:** Adjust subtitle sync offset (`[` / `]`) and subtitle font size in real time from within the player or settings modal.

### 🤖 Whisper Studio (Offline AI Subtitle Transcription)
- **Zero Cloud / Completely Offline:** Runs entirely locally on your Windows machine with full privacy.
- **High Accuracy & Speed:** Powered by `faster-whisper-xxl` with the cutting-edge `large-v3-turbo` model.
- **Batch Processing:** Select an anime season folder, choose the English audio track, and let Whisper Studio batch-transcribe every episode into `.srt` files alongside the video files with live terminal-like progress logs.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` / `Click` | Play / Pause |
| `F` | Toggle fullscreen |
| `Left` / `Right` | Seek -5 seconds / +5 seconds |
| `J` / `L` | Seek -10 seconds / +10 seconds |
| `N` | Play next episode |
| `[` / `]` | Subtitle sync offset (-0.5s / +0.5s) |
| `-` / `+` | Decrease / increase subtitle font size |
| `M` | Mute / unmute audio |
| `Esc` | Close episode drawer / return to library |

---

## Setup & External Tools Guide

Anime Media Center requires two external binaries for full functionality:
1. **FFmpeg (`ffmpeg.exe`)** — for video streaming, thumbnail generation, and container demuxing.
2. **Faster-Whisper-XXL (`faster-whisper-xxl.exe`)** — for offline AI subtitle generation.

The application contains **zero hardcoded paths** and includes an **Auto-Detect** engine that automatically locates these tools on launch.

### Method 1: Automatic Setup via Subtitle Edit (Recommended & Easiest)

If you already use [Subtitle Edit](https://www.nikse.dk/subtitleedit) (or install it):
1. Download and install **Subtitle Edit**.
2. Open Subtitle Edit and navigate to:
   `Video` &rarr; `Audio to text (Whisper...)`
3. In the engine dropdown, select **Faster-Whisper XXL**.
4. Click download — Subtitle Edit will automatically download the engine, models, and FFmpeg into:
   `%APPDATA%\Subtitle Edit\SpeechToText\Purfview-Faster-Whisper-XXL\`
5. **Done!** Anime Media Center will automatically detect `faster-whisper-xxl.exe` and `ffmpeg.exe` at this standard location on startup.

### Method 2: Standalone Portable Release

If you prefer not to install Subtitle Edit:
1. Download `Faster-Whisper-XXL_windows.7z` from the official repository:
   👉 **[Purfview/whisper-standalone-win Releases](https://github.com/Purfview/whisper-standalone-win/releases)**
2. Extract the archive to any location on your PC (e.g. `C:\Faster-Whisper-XXL` or in the project's `./bin` folder). It includes both `faster-whisper-xxl.exe` and `ffmpeg.exe`.
3. Open Anime Media Center &rarr; click the **Settings** gear icon (&gear;) &rarr; click **Browse** next to both paths to select your executables.

> [!NOTE]
> **How AI Models Work (`large-v3-turbo`):**
> When you run your first batch transcription in Whisper Studio, `faster-whisper-xxl` will automatically download the `large-v3-turbo` model (~1.5 GB) directly from Hugging Face into its `_models` directory. You do not need to download or copy model files manually.

---

## Development & Building

### Requirements
- Windows 10 or 11 (64-bit)
- [Node.js](https://nodejs.org/) (version 18 or higher)
- npm (bundled with Node.js)

### Quick Start

```bash
# 1. Clone repository
git clone https://github.com/your-username/anime-media-center.git
cd anime-media-center

# 2. Install dependencies
npm install

# 3. Launch in development mode with hot reload
npm run dev

# 4. Build production package
npm run build

# 5. Launch production build
npm start
```

### Automatic Setup Script
Run `setup.bat` in the project root to install dependencies, compile the production bundles, and create Windows Desktop and Start Menu shortcuts automatically.

---

## Tech Stack

- **Desktop Framework:** [Electron 33](https://www.electronjs.org/)
- **Frontend:** [React 18](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Tailwind CSS](https://tailwindcss.com/), [Lucide React](https://lucide.dev/)
- **Build Tool:** [Vite 5](https://vitejs.dev/) with `vite-plugin-electron`
- **Subtitle Rendering:** [JASSUB](https://github.com/ThaUnknown/jassub) (WebAssembly `libass`)
- **Metadata APIs:** [AniList GraphQL](https://anilist.co/) & [Kitsu REST API](https://kitsu.io/)
- **Opening Skip:** [AniSkip API](https://github.com/synacktraa/aniskip) & MKV Chapters
- **Backend Services:** Node.js streaming server, [FFmpeg](https://ffmpeg.org/), [Purfview Faster-Whisper-XXL](https://github.com/Purfview/whisper-standalone-win)

---

## License

This project is licensed under the [MIT License](LICENSE).
