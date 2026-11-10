# Kaiko

<p align="center">
  <img src="public/kaiko-icon.png" width="144" height="144" alt="Kaiko app icon" />
</p>

<p align="center"><strong>Your anime library, player, and subtitle studio — on your PC.</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-1.0.10-ec4899?style=flat-square" alt="Version 1.0.10" />
  <img src="https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011-blue?style=flat-square" alt="Windows 10 and 11" />
  <img src="https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron" alt="Electron 33" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License" />
</p>

Kaiko organizes anime files already on your drives, finds catalog information, and plays episodes locally with built-in FFmpeg support. Optional features include AI subtitle generation with Faster-Whisper and torrent downloads from indexers that you configure yourself.

## Features

- **Library and playback:** scan multiple media folders, identify episodes and movies, resume viewing, track watched state, and browse recent activity. Built-in FFmpeg enables out-of-the-box support for 10-bit HEVC, MKV audio/subtitle extraction, and audio transcoding with zero manual setup.
- **Anime discovery:** browse seasonal, popular, and trending titles; filter by genre, format, status, score, and age rating. Age ratings use a bundled index and refresh in the background every three days.
- **Personal tracking:** favourite any title, follow airing anime for new-episode alerts, manage a watchlist, and filter your local collection by favourites, followed titles, or currently watching.
- **Subtitles:** play common external and embedded subtitle formats, customize their appearance, and show dialogue and styled signs together where available.
- **Whisper Studio & In-App Engine Setup:** visual anime selection from library, automated character name detection via AniList, and subtitle generation locally with Faster-Whisper. 1-click in-app download and setup for both the **Faster-Whisper-XXL engine** and AI models (`large-v3-turbo`, `medium`, and `small`) with zero manual file extraction. Subtitle progress seamlessly routes to toasts, native desktop notifications, and the in-app notification center.
- **Optional P2P:** the integrated WebTorrent engine is off by default and requires explicit consent. It searches RSS/Torznab feeds that you configure. Kaiko does not bundle indexer accounts, feeds, torrent files, or anime video files.
- **Windows integration:** themed app icon, installer, desktop and Start menu shortcuts, and a small launcher.

## Torrent and indexer model

Torrent downloads are an optional feature. The application includes the WebTorrent client; it is **not** a front end for an external qBittorrent or Transmission installation. You provide and configure your own RSS/Torznab indexer endpoints in **Settings → P2P & Downloads**. No indexer feeds or credentials are shipped in the repository, and the engine will not start until you enable it and accept the in-app notice.

For a magnet link that contains no tracker address, the engine appends a small list of public tracker addresses bundled with the app to improve peer discovery. Magnets that already contain trackers keep their own tracker list. Trackers only help peers find each other; they do not provide search results or host download content. You are responsible for the sources you configure and the material you download or share; check the laws that apply where you live.

## Install the Windows app

Download the `Kaiko Setup 1.0.10.exe` installer from the project’s GitHub Releases page, run it, and choose an install folder. The installer creates shortcuts. Updates can also be installed directly from within the app via **Settings → Application Updates** or the startup update prompt (featuring rich GitHub-formatted release notes). During a normal uninstall, Kaiko asks separately whether to remove saved settings, anime lists, and watch history, and whether to clear the contents of configured media-library folders. Both choices default to **No**; deleting library contents requires a second confirmation listing the folders. Clearing a library folder removes every file inside it, not just Kaiko downloads, and leaves the folder itself in place. Silent uninstall and app upgrades preserve personal data. The first launch may take a little longer while Windows initializes Electron.

FFmpeg and a lightweight 7-Zip decompression engine (`7z.exe` + `7z.dll`) are bundled directly into Kaiko for seamless playback, extraction, and automated engine setup out-of-the-box across all Windows versions (Windows 10 & 11). The Faster-Whisper-XXL engine can be downloaded and configured automatically in 1-click directly inside Kaiko (or auto-detected from Subtitle Edit / custom paths). Recommended AI models (`large-v3-turbo`, `medium`, `small`) can also be downloaded in 1-click directly from the Settings menu or Whisper Studio.

## Build from source

### Requirements

- Windows 10 or 11, 64-bit
- Node.js 18 or later and npm
- Git
- Optional: .NET Framework C# compiler for the standalone shortcut launcher

### Clean install and development

```powershell
git clone https://github.com/zeystom/anime-media-center.git
cd anime-media-center
npm ci
npm run dev
```

### Build and package

```powershell
npm run build
npm start
npm run package
```

`npm run package` creates the Windows NSIS installer under `dist-build/`. `setup.bat` is a convenience script that builds the app and refreshes the local launcher and shortcuts.

### Tests

```powershell
npm test
npm run test:all
```

`npm test` runs the standard regression suite. `test:all` also runs the additional adversarial and interaction checks.

## Network services and local data

Kaiko contacts third-party services for catalog and episode metadata, image assets, intro skip data, and age-rating updates. Your library paths, playback history, settings, and watchlist are stored locally in the app’s user-data folder. Torrent indexer requests use the feeds you configure; there are no bundled feeds or indexer credentials. Whisper transcription runs locally with the separately installed tool.

The bundled age-rating index is derived from the [anime-mapper project](https://github.com/subhajeetch-fl/anime-mapper). Source and refresh details are in [`src/data/AGE-RATINGS-SOURCE.md`](src/data/AGE-RATINGS-SOURCE.md). To refresh the bundled copy during development, run `npm run update:age-ratings`.

## License

Kaiko is released under the [MIT License](LICENSE). Third-party services, tools, datasets, and dependencies remain subject to their own terms and licenses.
