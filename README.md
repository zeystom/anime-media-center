# Anime Media Center

<p align="center">
  <img src="./app-icon.png" width="128" height="128" alt="Anime Media Center Icon" />
</p>

<p align="center">
  <strong>Desktop anime library and media player for Windows featuring offline Whisper subtitle generation, native libass rendering, and smart OP/ED skipping.</strong>
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

**Anime Media Center** solves this by combining a local media player with an offline transcription pipeline:

1. **Stream Inspection:** Scans local MKV/MP4 containers to distinguish between standard translation tracks, signs/songs tracks, and actual English dubtitles.
2. **Whisper Studio:** Uses local `faster-whisper-xxl` (`large-v3-turbo`) to batch-transcribe English audio tracks into synced `.srt` files when dubtitles are missing.
3. **Dual-Subtitle Playback:** Renders voice-matched `.srt` dialogue alongside `.ass` signs and songs tracks simultaneously via WebAssembly `libass` (JASSUB).

---

## Features

### Video Player & Streaming
- **Local Streaming Pipeline:** Plays 10-bit HEVC/x265 and high-bitrate MKVs via a local Node.js/FFmpeg stream with NVIDIA NVENC hardware acceleration and automatic software fallback.
- **Fast Seeking:** Aligns demuxing to GOP keyframes to prevent audio desync and decoder stutter when scrubbing.
- **Timeline Previews:** Hover thumbnails on the progress bar with in-memory frame caching.

### Library Management
- **Multi-Drive Support:** Scans and merges folders across multiple drives (e.g., `D:\Anime`, `E:\Downloads`) into a single interface.
- **Metadata Fetching:** Pulls posters, banners, scores, and synopses from AniList and Kitsu APIs with local title normalization and season parsing.
- **Subtitle Status Badges:**
  - `Dub Sub` — Embedded English dubtitles detected.
  - `AI Sub` — Synced `.srt` generated locally by Whisper Studio.
  - `No Sub` — No matching dubtitles found.

### Subtitles
- **Native ASS Rendering:** Full support for `.ass` styling, typesetting, vector drawings, and embedded fonts via JASSUB.
- **Dual Track Display:** Shows dialogue at the bottom and signs/songs at the top simultaneously.
- **Live Controls:** Adjust subtitle delay (`[` / `]`) and font scaling (`-` / `+`) on the fly.

### Opening & Ending Skip
- **Interval Detection:** Reads timestamps from embedded MKV chapters, `.ass` script markers, or the AniSkip API.
- **UI Integration:** Highlights OP/ED sections on the timeline and displays a skip prompt during playback.

### Whisper Studio
- **100% Offline:** Runs locally on your GPU/CPU without external API keys or cloud uploads.
- **Batch Processing:** Transcribes entire season folders in the background with real-time CLI output in the UI.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` / `Click` | Play / Pause |
| `F` | Toggle fullscreen |
| `Left` / `Right` | Seek -5s / +5s |
| `J` / `L` | Seek -10s / +10s |
| `N` | Next episode |
| `[` / `]` | Subtitle delay (-0.5s / +0.5s) |
| `-` / `+` | Subtitle font size |
| `M` | Mute / Unmute |
| `Esc` | Close drawer / Back to library |

---

## External Dependencies

The app relies on two external binaries:
1. **`ffmpeg.exe`** — Media probing, demuxing, and thumbnail extraction.
2. **`faster-whisper-xxl.exe`** — Offline audio transcription.

Both binaries are auto-detected on startup if installed in standard paths, or can be linked manually in **Settings**.

### Option 1: Standalone Portable (Recommended)
1. Download `Faster-Whisper-XXL_windows.7z` from [Purfview/whisper-standalone-win](https://github.com/Purfview/whisper-standalone-win/releases).
2. Extract it anywhere on your PC (the archive includes both `faster-whisper-xxl.exe` and `ffmpeg.exe`).
3. Put the files in the project's `./bin` folder for auto-detection, or select their paths in the app **Settings**.

### Option 2: Via Subtitle Edit
If you already have **Faster-Whisper XXL** installed through [Subtitle Edit](https://www.nikse.dk/subtitleedit), Anime Media Center will automatically detect both binaries in:
`%APPDATA%\Subtitle Edit\SpeechToText\Purfview-Faster-Whisper-XXL\`

> [!NOTE]
> On your first transcription job, `faster-whisper-xxl` will automatically download the `large-v3-turbo` model (~1.5 GB) from Hugging Face into its local `_models` folder.

---

## Development

### Prerequisites
- Windows 10/11 (x64)
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

# Build for production
npm run build
npm start
```

Alternatively, run `setup.bat` to install dependencies, build the production bundle, and create desktop shortcuts.

---

## Tech Stack

- **Core:** Electron 33, React 18, TypeScript, Vite 5
- **Styling:** Tailwind CSS, Lucide Icons
- **Subtitles:** JASSUB (WebAssembly libass)
- **Media & AI:** Node.js HTTP streaming, FFmpeg, Faster-Whisper-XXL
- **APIs:** AniList GraphQL, Kitsu REST, AniSkip

---

## License

[MIT](LICENSE)
