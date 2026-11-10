import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const VERSION = pkg.version || '1.0.9';
const OWNER = 'zeystom';
const REPO = 'anime-media-center';
const TAG = `v${VERSION}`;
const RELEASE_NAME = `Kaiko ${VERSION}`;

function getGitHubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const creds = execSync('echo protocol=https`nhost=github.com | git credential fill', {
      shell: 'powershell.exe',
      encoding: 'utf8'
    });
    const match = creds.match(/password=(.+)/);
    if (match && match[1]) {
      return match[1].trim();
    }
  } catch (err) {
    console.warn('Failed to retrieve token from git credential manager:', err.message);
  }
  return null;
}

const token = getGitHubToken();
if (!token) {
  console.error('Error: GitHub token not found.');
  process.exit(1);
}

const RELEASE_BODY = `## What's new in v${VERSION}

### ⚡ BitTorrent Connecting & Metadata Timeout Fix
- **Fixed Connection Stalls:** Resolved an issue where newly connected peers were inadvertently dropped after 15s before extension handshakes and PEX could complete. Each peer connection now has a guaranteed 12s window for handshake and peer exchange.
- **Active DHT & Tracker Discovery:** Added periodic DHT \`lookup(infoHash)\` and tracker announces every 8–15s during the connecting phase to rapidly locate seeders.
- **Enhanced Swarm Trackers:** Added high-availability public UDP, HTTP/HTTPS, and WebTorrent WebSocket trackers with automatic deduplication, plus DHT bootstrap nodes (\`router.bittorrent.com\`, \`dht.transmissionbt.com\`).
- **Extended Watchdog:** Increased metadata discovery watchdog to 180s.

### 🔄 Live Subtitle Refresh in Whisper Studio & Detail View
- **Instant UI Updates:** Generated subtitles (\`.whisper.srt\`) immediately appear as completed in Whisper Studio and Anime Detail views without requiring an application restart.
- **Robust Path Normalization:** Normalized cross-platform slash conventions and case sensitivity between Windows paths and renderer state.
- **Automatic Cache Invalidation:** The library disk scan cache is automatically purged when an episode finishes transcribing.

### 🎬 High-FPS Subtitle Sync & Audio Drift Compensation
- **Frame-Accurate Subtitles:** Replaced the 250ms HTML5 \`onTimeUpdate\` subtitle clock with a \`requestVideoFrameCallback\` animation loop, syncing subtitles directly with displayed video frames at 60+ FPS.
- **Audio Resync on Weaker Hardware:** Added \`aresample=async=1000:min_hard_comp=0.100000\` to dynamically eliminate audio drift exceeding 100ms.
- **Transcode Performance Cap:** Capped CPU video transcoding to 1080p (\`min(1920,iw)\`) with bounded threads, preventing 4K HEVC releases from pegging weak CPUs to 100%.
- **ASS Subtitle Optimization:** Chronologically sorted combined ASS dialog events and increased JASSUB font cache to 32.

### 📐 Player Top Bar Title Full-Width Expansion
- **No More Title Truncation:** Removed artificial width restrictions (\`max-w-md md:max-w-2xl\`) in the player top navbar, allowing long anime and episode titles to expand naturally across the entire screen.
- **Complete Title Tooltips:** Hovering over the title displays the full formatted anime title and episode name.

### 🔧 Faster-Whisper Compatibility
- Removed unsupported \`--hotwords\` CLI parameter to eliminate \`faster-whisper-xxl\` exit code 2 errors.

---
### Assets included:
- \`Kaiko-Setup-${VERSION}.exe\` — Windows NSIS installer
- \`latest.yml\` — Auto-update metadata for electron-updater
`;

const ASSETS = [
  { name: `Kaiko-Setup-${VERSION}.exe`, file: `dist-build/Kaiko-Setup-${VERSION}.exe`, type: 'application/octet-stream' },
  { name: `Kaiko-Setup-${VERSION}.exe.blockmap`, file: `dist-build/Kaiko Setup ${VERSION}.exe.blockmap`, type: 'application/octet-stream' },
  { name: `Kaiko.Setup.${VERSION}.exe`, file: `dist-build/Kaiko.Setup.${VERSION}.exe`, type: 'application/octet-stream' },
  { name: 'latest.yml', file: 'dist-build/latest.yml', type: 'text/yaml' }
];

async function apiRequest(endpoint, method = 'GET', body = null, headers = {}) {
  const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint}`;
  const defaultHeaders = {
    'Authorization': `token ${token}`,
    'User-Agent': 'Kaiko-Release-Publisher',
    'Accept': 'application/vnd.github.v3+json',
    ...headers
  };

  const options = {
    method,
    headers: defaultHeaders
  };

  if (body) {
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      options.body = body;
    } else {
      options.body = JSON.stringify(body);
      defaultHeaders['Content-Type'] = 'application/json';
    }
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error [${response.status}] ${method} ${url}: ${errorText}`);
  }
  return response.json();
}

async function main() {
  console.log(`Checking for existing release for tag ${TAG}...`);
  let release = null;
  try {
    release = await apiRequest(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
    console.log(`Found existing release (ID: ${release.id})`);
  } catch (err) {
    if (err.message.includes('404')) {
      console.log(`Release ${TAG} not found. Creating new release...`);
    } else {
      throw err;
    }
  }

  if (!release) {
    release = await apiRequest(`/repos/${OWNER}/${REPO}/releases`, 'POST', {
      tag_name: TAG,
      name: RELEASE_NAME,
      body: RELEASE_BODY,
      draft: false,
      prerelease: false
    });
    console.log(`Release created successfully! (ID: ${release.id})`);
  } else {
    console.log(`Updating release notes for ID ${release.id}...`);
    release = await apiRequest(`/repos/${OWNER}/${REPO}/releases/${release.id}`, 'PATCH', {
      name: RELEASE_NAME,
      body: RELEASE_BODY
    });
  }

  // Assets upload url format: https://uploads.github.com/repos/zeystom/anime-media-center/releases/440317132/assets{?name,label}
  const uploadBaseUrl = release.upload_url.split('{')[0];

  // Ensure alias filenames exist for universal auto-updater and manual download compatibility
  const spaceExe = path.join(rootDir, `dist-build/Kaiko Setup ${VERSION}.exe`);
  const hyphenExe = path.join(rootDir, `dist-build/Kaiko-Setup-${VERSION}.exe`);
  const dotExe = path.join(rootDir, `dist-build/Kaiko.Setup.${VERSION}.exe`);

  if (fs.existsSync(spaceExe)) {
    if (!fs.existsSync(hyphenExe)) fs.copyFileSync(spaceExe, hyphenExe);
    if (!fs.existsSync(dotExe)) fs.copyFileSync(spaceExe, dotExe);
  }

  for (const asset of ASSETS) {
    const filePath = path.resolve(asset.file);
    if (!fs.existsSync(filePath)) {
      console.error(`Asset file not found: ${filePath}`);
      continue;
    }

    const stat = fs.statSync(filePath);
    console.log(`\nPreparing asset "${asset.name}" (${(stat.size / 1024 / 1024).toFixed(2)} MB)...`);

    // Check if asset already exists in release
    const existingAsset = release.assets.find(a => a.name === asset.name);
    if (existingAsset) {
      console.log(`Asset ${asset.name} already exists (ID: ${existingAsset.id}). Deleting before re-upload...`);
      await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${existingAsset.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `token ${token}`,
          'User-Agent': 'Kaiko-Release-Publisher',
          'Accept': 'application/vnd.github.v3+json'
        }
      });
      console.log(`Deleted existing asset ${asset.name}`);
    }

    console.log(`Uploading ${asset.name}...`);
    const fileBuffer = fs.readFileSync(filePath);
    const uploadUrl = `${uploadBaseUrl}?name=${encodeURIComponent(asset.name)}`;

    const uploaded = await apiRequest(uploadUrl, 'POST', fileBuffer, {
      'Content-Type': asset.type,
      'Content-Length': stat.size.toString()
    });

    console.log(`Uploaded ${asset.name} successfully! (Download URL: ${uploaded.browser_download_url})`);
  }

  console.log(`\n=== Release ${TAG} published successfully! ===`);
  console.log(`View at: ${release.html_url}`);
}

main().catch(err => {
  console.error('Fatal error during release publishing:', err);
  process.exit(1);
});
