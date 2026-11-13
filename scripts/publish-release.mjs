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

### 🛠 Fixed Wrong Episode Titles on Anime Detail Pages
- **Root cause:** ani.zip occasionally interleaves 2–5 minute specials (chibi shorts, PVs) into a season's main episode numbering. Observed live with K-On! S1: six ~3-minute shorts with their own monthly air dates occupied episode slots 2–7 of the 13-episode season, while the real episodes kept correct titles elsewhere — so the card showed "Ricchan's Kodak Moment Series…" instead of "Instruments!".
- **Runtime-consistency filter:** ani.zip rows whose runtime is far below the season's typical length are now dropped from the main numbering; the freed slots are refilled from the clean Kitsu/AniList streaming sources.
- **Safe heuristics:** shorts-only shows are unaffected (the season median itself is small), and seasons with sparse runtime data are never filtered.
- **Self-healing caches:** poisoned \`anizip_<id>.json\` disk caches are re-partitioned at every view open and rewritten with the final clean merged snapshot — no manual cache cleanup needed.

### 🕵️ Hidden Developer Mode (Session-Only)
- Tap the version label in the Settings footer **5 times** to unlock ("You are now a developer").
- **Stealth by design:** the label has no hover highlight, cursor change or tooltip — regular users can't discover it.
- **Auto-revoked on restart:** the flag is session-only, never persisted to disk or localStorage.
- The "Copy diagnostic history to clipboard" button on torrent cards in Downloads is now visible only in developer mode, and the mechanism is extensible for future dev-only UI.

---
### Assets included:
- \`Kaiko-Setup-${VERSION}.exe\` — Windows NSIS installer
- \`Kaiko-Setup-${VERSION}.exe.blockmap\` — Differential update blockmap
- \`latest.yml\` — Auto-update metadata for electron-updater
`;

const ASSETS = [
  { name: `Kaiko-Setup-${VERSION}.exe`, file: `dist-build/Kaiko-Setup-${VERSION}.exe`, type: 'application/octet-stream' },
  { name: `Kaiko-Setup-${VERSION}.exe.blockmap`, file: `dist-build/Kaiko-Setup-${VERSION}.exe.blockmap`, type: 'application/octet-stream' },
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
  const spaceMap = path.join(rootDir, `dist-build/Kaiko Setup ${VERSION}.exe.blockmap`);
  const hyphenMap = path.join(rootDir, `dist-build/Kaiko-Setup-${VERSION}.exe.blockmap`);

  if (fs.existsSync(hyphenExe)) {
    if (!fs.existsSync(spaceExe)) fs.copyFileSync(hyphenExe, spaceExe);
    if (!fs.existsSync(dotExe)) fs.copyFileSync(hyphenExe, dotExe);
  } else if (fs.existsSync(spaceExe)) {
    if (!fs.existsSync(hyphenExe)) fs.copyFileSync(spaceExe, hyphenExe);
    if (!fs.existsSync(dotExe)) fs.copyFileSync(spaceExe, dotExe);
  }

  if (fs.existsSync(hyphenMap) && !fs.existsSync(spaceMap)) {
    fs.copyFileSync(hyphenMap, spaceMap);
  } else if (fs.existsSync(spaceMap) && !fs.existsSync(hyphenMap)) {
    fs.copyFileSync(spaceMap, hyphenMap);
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
