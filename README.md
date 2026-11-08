# Kaiko

<p align="center">
  <img src="public/kaiko-icon.png" width="144" height="144" alt="Kaiko app icon" />
</p>

<p align="center"><strong>Your anime library, player, and subtitle studio — on your PC.</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-1.0.1-ec4899?style=flat-square" alt="Version 1.0.1" />
  <img src="https://img.shields.io/badge/Platform-Windows%2010%20%2F%2011-blue?style=flat-square" alt="Windows 10 and 11" />
  <img src="https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron" alt="Electron 33" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License" />
</p>

Kaiko organizes anime files already on your drives, finds catalog information, and plays episodes locally. Optional features include subtitle generation with a separately installed Whisper tool and torrent downloads from indexers that you configure yourself.

## Features

- **Library and playback:** scan multiple media folders, identify episodes and movies, resume viewing, track watched state, and browse recent activity.
- **Anime discovery:** browse seasonal, popular, and trending titles; filter by genre, format, status, score, and age rating. Age ratings use a bundled index and refresh in the background every three days.
- **Personal tracking:** follow airing titles, manage a watchlist, and receive notifications for new episodes and download activity.
- **Subtitles:** play common external and embedded subtitle formats, customize their appearance, and show dialogue and styled signs together where available.
- **Whisper Studio:** optionally generate subtitles locally with Faster-Whisper. The executable and model are installed separately; Kaiko does not include them.
- **Optional P2P:** the integrated WebTorrent engine is off by default and requires explicit consent. It searches RSS/Torznab feeds that you configure. Kaiko does not bundle indexer accounts, feeds, torrent files, or anime video files.
- **Windows integration:** themed app icon, installer, desktop and Start menu shortcuts, and a small launcher.

## Torrent and indexer model

Torrent downloads are an optional feature. The application includes the WebTorrent client; it is **not** a front end for an external qBittorrent or Transmission installation. You provide and configure your own RSS/Torznab indexer endpoints in **Settings → P2P & Downloads**. No indexer feeds or credentials are shipped in the repository, and the engine will not start until you enable it and accept the in-app notice.

For a magnet link that contains no tracker address, the engine appends a small list of public tracker addresses bundled with the app to improve peer discovery. Magnets that already contain trackers keep their own tracker list. Trackers only help peers find each other; they do not provide search results or host download content. You are responsible for the sources you configure and the material you download or share; check the laws that apply where you live.

## Install the Windows app

Download the `Kaiko Setup 1.0.1.exe` installer from the project’s GitHub Releases page, run it, and choose an install folder. The installer creates shortcuts. During a normal uninstall, Kaiko asks separately whether to remove saved settings, anime lists, and watch history, and whether to clear the contents of configured media-library folders. Both choices default to **No**; deleting library contents requires a second confirmation listing the folders. Clearing a library folder removes every file inside it, not just Kaiko downloads, and leaves the folder itself in place. Silent uninstall and app upgrades preserve personal data. The first launch may take a little longer while Windows initializes Electron.

The installer does not include FFmpeg or Faster-Whisper. Kaiko can use FFmpeg installed on the system and can detect Faster-Whisper from Subtitle Edit; you can also set executable paths in **Settings**. These tools are only needed for their related media and transcription features.

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
