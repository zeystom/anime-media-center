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
  <img src="https://img.shields.io/badge/Whisper-large--v3--turbo-10a37f?style=flat-square&logo=openai" alt="Whisper" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" />
</p>

---

## Why This Exists

Watching English-dubbed anime with English subtitles is often frustrating. Most releases only include subtitle tracks translated directly from the original Japanese script rather than closed captions (SDH/dubtitles) transcribed from the English audio. As a result, the spoken dialogue and on-screen text rarely match in phrasing or timing.

**Anime Media Center** solves this for English learners and dub viewers by combining a local media player with an offline transcription pipeline:

1. **Stream Inspection:** Scans local MKV containers to distinguish between standard translation tracks, signs/songs tracks, and actual English dubtitles.
2. **Whisper Studio:** Uses local `faster-whisper-xxl` (`large-v3-turbo`) to batch-transcribe English dub audio into synced `.srt` files (`<episode>.whisper.srt`) when dubtitles are missing.
3. **Dual-Subtitle Playback:** Renders voice-matched `.srt` dialogue alongside `.ass` signs and songs tracks simultaneously via WebAssembly `libass` (JASSUB).
4. **Live Contrast & Subtitle Customizer:** Real-time subtitle styling against a vertical rainbow contrast spectrum, ensuring perfect legibility across dark, vibrant, and bright scenes.
5. **Torrent & Incomplete Media Shield:** Detects files actively downloading via torrent clients (qBittorrent, uTorrent, Transmission) using sparse cluster allocation and EBML checks to prevent playback crashes.

---

## Features

### Video Player & Streaming
- **Local Streaming Pipeline:** Plays 10-bit HEVC/x265 and high-bitrate MKVs via a local Node.js/FFmpeg stream with NVIDIA NVENC hardware acceleration and automatic software fallback.
- **Fast Seeking:** Aligns demuxing to GOP keyframes to prevent audio desync and decoder stutter when scrubbing.
- **Timeline Previews:** Hover thumbnails on the progress bar with in-memory frame caching and fixed aspect ratio.
- **Power Efficiency:** Zero unthrottled JavaScript animation loops during playback for minimal CPU and battery usage.
- **Episode Drawer:** Side drawer for quick episode switching during playback (`E` hotkey or toolbar button) with persistent state.

### Subtitle Styling & Dual Display
- **Native ASS Rendering:** Full support for `.ass` styling, typesetting, vector drawings, and embedded fonts via JASSUB.
- **Dual Track Display:** Shows dialogue at the bottom and signs/songs at the top simultaneously.
- **Live Contrast Spectrum:** 10-band vertical rainbow contrast test (`Spectrum` / `Dark` / `Bright` modes) directly inside the styling preview to test legibility against real-world video backgrounds.
- **Outline Thickness Slider:** Smooth slider with a visual indicator dot at the **Standard (3px)** preset for quick reference.
- **Custom Fonts & Backdrops:** Choose between Clean Sans (Inter), Cinematic Sans (Trebuchet MS), Soft Rounded (Comfortaa), Editorial Serif (Georgia), and Monospace; adjust text colors, shadow colors, and background pill backdrops.
- **Settings Persistence:** Subtitle styles and track selections persist automatically across episodes and app restarts.

### Torrent & Incomplete Download Shield
- **Multi-Layer Detection:** Automatically checks for active torrent downloads via:
  1. Companion temporary files (`.!qb`, `.!ut`, `.part`, `.crdownload`, `.downloading`, etc.)
  2. Zero-byte and stub allocation verification
  3. Windows NTFS sparse file cluster allocation checks (`stat.blocks`)
  4. Matroska EBML header magic bytes (`0x1A 0x45 0xDF 0xA3`)
  5. Tail seeks and entropy checkpoint probing to catch non-sparse preallocated zeroes
- **Live Download Progress:** Shows real-time percentage and download size metrics directly on cards.
- **Playback Guard:** Blocks opening incomplete files with non-blocking toast warnings to prevent player freezes.
- **Blurred Posters:** Dynamically searches online posters via Kitsu/AniList API and blurs posters for downloading media.

### Library Management & Search
- **Multi-Drive Support:** Scans and merges folders across multiple drives into a single unified interface.
- **Fast Metadata:** Pulls posters, banners, scores, and synopses from AniList and Kitsu APIs with local title normalization, season parsing, and pagination support (>50 episodes).
- **Clean Subtitle Badges:**
  - `Dub Sub` — Embedded English dubtitles (SDH) detected inside the MKV container.
  - `Sub` — Embedded English translation dialogue detected.
  - `AI Sub` — Synced English subtitles generated by Whisper Studio (`<episode>.whisper.srt`).
  - `Ext Sub` — External English subtitle file present (`<episode>.srt`, `<episode>.en.srt`, etc.).
  - `No Sub` — No matching English subtitles found.
- **Movie Hero Deduplication:** Seamlessly eliminates duplicate stacked cards when resuming movies.
- **Smart Search:** Dedicated empty state with a 1-click `Clear Search` reset.
- **Folder Protection:** Confirmation step before deleting library folders in Settings to prevent accidental removal.

### Opening & Ending Skip
- **Interval Detection:** Reads timestamps from embedded MKV chapters, `.ass` script markers, or the AniSkip API.
- **UI Integration:** Highlights OP/ED sections on the timeline and displays a skip prompt (`S` key) during playback with onscreen ripple feedback.

### Whisper Studio
- **100% Offline:** Runs locally on your GPU/CPU without external API keys or cloud uploads.
- **High-Index Track Extraction:** Automatically extracts English audio tracks regardless of stream index.
- **Batch Processing:** Transcribes entire season folders in the background with real-time progress and logs.
- **Safe Output:** Generates `<episode>.whisper.srt` directly next to your video files without overwriting existing manual subtitle files.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` / `Click` / `K` | Play / Pause |
| `F` | Toggle fullscreen |
| `E` | Toggle Episodes Drawer |
| `S` | Skip opening (when opening interval is active) |
| `Left` / `Right` | Seek -5s / +5s |
| `J` / `L` | Seek -10s / +10s |
| `N` | Next episode |
| `]` | Subtitle sync +0.5s (show earlier) |
| `[` | Subtitle sync -0.5s (show later) |
| `-` / `+` | Subtitle font size down / up |
| `M` | Mute / Unmute |
| `Esc` | Close drawer / Dismiss modal / Back to library |

---

## External Dependencies

The application utilizes two external binaries:
1. **`ffmpeg.exe`** — Video demuxing, audio resampling, and thumbnail generation.
2. **`faster-whisper-xxl.exe`** — Offline English audio speech-to-text transcription.

Both tools are auto-detected on startup if installed in standard paths, or can be specified in **Settings**.

### Option 1: Standalone Portable (Recommended)
1. Download the Windows `.7z` archive from the [Faster-Whisper-XXL release page](https://github.com/Purfview/whisper-standalone-win/releases).
2. Extract the archive anywhere on your PC.
3. If `ffmpeg.exe` is not included inside the extracted folder, download FFmpeg separately or install it via winget (`winget install Gyan.FFmpeg`).
4. Point to `faster-whisper-xxl.exe` and `ffmpeg.exe` in the application **Settings**, or place them in `./bin`.

### Option 2: Via Subtitle Edit
If you have **Faster-Whisper XXL** installed through [Subtitle Edit](https://www.nikse.dk/subtitleedit), Anime Media Center will automatically detect the binaries in:
`%APPDATA%\Subtitle Edit\SpeechToText\Purfview-Faster-Whisper-XXL\`

> [!NOTE]
> On the first transcription run, `faster-whisper-xxl` will download the `large-v3-turbo` model (~1.5 GB) into its local `_models` directory.

---

## Development & Building

### Prerequisites
- Windows 10 / 11 (x64)
- [Node.js](https://nodejs.org/) 18+

### Setup & Build

```bash
# Clone the repository
git clone https://github.com/zeystom/anime-media-center.git
cd anime-media-center

# Install dependencies
npm install

# Start in development mode
npm run dev

# Run full test suite
node test-episodes.js
node test-torrents.js
node test-milestone1.js
node test-milestone2.js
node test-milestone3.js
node test-milestone4.js

# Build for production
npm run build
npm start
```

### Packaging an Installer
To build an NSIS Windows installer:
```bash
npm run package
```

### Building the Windows Launcher Executable
To compile the root launcher executable `Anime Media Center.exe` from `launcher.cs` using the built-in .NET C# compiler:
```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /win32icon:app-icon.ico /out:"Anime Media Center.exe" launcher.cs
```

Running `setup.bat` automatically handles this step. If `csc.exe` is not present, `setup.bat`, `install-shortcuts.ps1`, and `Launch Anime Media Center.vbs` automatically fall back to launching the local Electron binary (`node_modules\electron\dist\electron.exe`) seamlessly.

---

## Tech Stack

- **Core:** Electron 33, React 18, TypeScript, Vite 5
- **Styling:** Tailwind CSS, Lucide Icons
- **Subtitles:** JASSUB (WebAssembly libass)
- **Media & AI:** Node.js streaming server, FFmpeg, Faster-Whisper-XXL (`large-v3-turbo`)
- **APIs:** AniList GraphQL, Kitsu REST, AniSkip
- **Storage:** Atomic NTFS JSON storage with multi-level fallbacks

---

## License

[MIT](LICENSE)
