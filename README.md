# Anime Media Center & Whisper Studio

A desktop media center and video player for Windows, built for watching anime releases (MKV, Dual Audio, 10-bit HEVC, Blu-ray Remux) with subtitle management and automated speech-to-text transcription.

<p align="center">
  <img src="./app-icon.png" width="120" height="120" alt="Anime Media Center Icon" />
</p>

---

## Features

### Video Player & Streaming
- **Hardware-accelerated playback**: Uses local FFmpeg streaming (NVIDIA NVENC with software fallback) to handle 10-bit HEVC/x265 and high-bitrate Blu-ray MKVs with low CPU usage.
- **Accurate seeking**: Demuxes keyframes for responsive seeking and timeline scrubbing without audio desync or black frames.
- **High-speed timeline thumbnails**: Fast preview frames while hovering the progress bar, backed by an in-memory cache and neighbor frame pre-fetching.
- **Maximized windowed launch**: Opens maximized filling the work area while keeping the Windows taskbar accessible.

### Subtitle System
- **Dual subtitle rendering**: Displays dialogue at the bottom and translated signs/songs at the top simultaneously.
- **JASSUB WebAssembly (libass)**: Renders complex ASS subtitle effects, styles, embedded fonts, and vector masks in browser canvas.
- **Smart track matching**:
  - Automatically switches to English Dubtitles / SDH when selecting English audio.
  - Automatically switches to full dialogue translation when selecting Japanese audio.
  - Remembers selected audio tracks, subtitle tracks, and sync offsets per anime season.
- **On-the-fly adjustments**: In-player sync offset controls (`[` / `]`) and live subtitle font size scaling.

### Navigation & Player Controls
- **Magnetic episode peek**: Hovering near the right edge reveals an elastic curved tab that follows the cursor and snaps open the episode switcher. Protected from accidental triggers near bottom playback controls.
- **Spring-animated episode drawer**: Smooth drawer transition with episode titles, thumbnails, and watch progress.
- **Chapter-aware intro/outro skips**:
  - Sample-accurate "Skip Intro" button based on embedded MKV OP chapters.
  - Floating "Skip Ending & Play Next" card during ending credits or the final 90 seconds.
- **Quick Next Episode button**: Direct button in the bottom control bar and shortcut (`N`).
- **Cleaned-up bottom controls**: Audio track and subtitle selection relocated to a unified popover next to fullscreen and volume controls.

### Whisper Studio
- Batch offline subtitle generation using `faster-whisper-xxl` (supports `large-v3-turbo` model).
- Automatically targets English audio streams, queues episodes, and writes `.srt` files directly alongside video files.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` / `Click` | Play / Pause |
| `F` | Toggle fullscreen |
| `Left` / `Right` | Seek -5s / +5s |
| `J` / `L` | Seek -10s / +10s |
| `N` | Play next episode |
| `[` / `]` | Subtitle sync offset (-0.5s / +0.5s) |
| `-` / `+` | Decrease / increase subtitle font size |
| `M` | Mute / unmute audio |
| `Esc` | Close drawer / return to library |

---

## Installation & Setup

### Requirements
- Windows 10 or 11 (64-bit)
- Node.js 18+ (if building from source)
- FFmpeg (can use the one bundled with Subtitle Edit / Faster-Whisper-XXL)

### Quick Start

1. **Automatic Setup (recommended):**
   Run `setup.bat` in the project root. It installs dependencies, builds the production bundles, and creates Start Menu and Desktop shortcuts.

2. **Standalone Launcher:**
   Double-click `Anime Media Center.exe` in the root folder.

3. **Manual Development / Build:**
   ```bash
   # Install dependencies
   npm install

   # Run dev server with hot reload
   npm run dev

   # Build production packages
   npm run build

   # Start production app
   npm start
   ```

---

## Configuration

Settings can be changed via the gear icon in the top-right corner or by editing `%APPDATA%\anime-media-center\settings.json`:
- `defaultLibraryRoot`: Default anime directory (e.g. `D:\films`).
- `ffmpegPath`: Path to `ffmpeg.exe`.
- `whisperPath`: Path to `faster-whisper-xxl.exe`.
- `autoPlayNext`: Automatically advance to the next episode when finishing one.
- `subtitlesFontSize`: Base subtitle font size in pixels.

---

## Tech Stack

- **Desktop Shell**: Electron 33
- **Frontend**: React 18, TypeScript, Tailwind CSS, Lucide Icons
- **Bundler**: Vite 5, `vite-plugin-electron`
- **Subtitles**: JASSUB (WebAssembly `libass`) + HTML overlay fallback
- **Backend / Transcoding**: Local Node.js streaming server, FFmpeg (NVENC / H.264), Faster-Whisper-XXL

---

## License

MIT
