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

const RELEASE_BODY = `## Kaiko 2.0.0 — Design Overhaul, OVA Torrent Search Engine & Episode List Integrity

A global update: a full visual overhaul of the app shell, a rework of the OVA torrent search and download pipeline, and integrity fixes for episode lists polluted by franchise extras.

### 🎨 Design Overhaul
- **Floating glass navbar:** pages scroll under the navbar so the backdrop blur reads real content, with a per-title hue tint. The banner tint fades out with scroll progress (it no longer hides the blur), and the blur is toggleable in Settings for weaker PCs.
- **Glass design system:** new \`GlassSelect\` component, hue-family color remap, glow tokens, banner fade rebalance; cold blue-gray hexes replaced with palette tokens throughout.
- **Scroll performance:** navbar progress flows through a pub-sub outside React state, page trees are memoized, hover transitions are suppressed during scrolls — smooth FPS on long pages.
- **Notifications drawer:** relative timestamps on a 5-second ticker, swipe-to-dismiss rows, more opaque cards and larger fonts.
- **Library cards:** rating pill that survives 2-line titles, icon-only Followed/Favourite badges, catalog scores lazy-loaded for collection-only entries.
- **Discover:** accent-gradient filter controls, centered mode tabs, cleaner header.
- **Whisper Studio:** the episode selector is rebuilt as a thumbnail card grid with click-toggle and hold-drag sweep selection; redundant folder button removed; link-style buttons de-underlined.
- **Single-episode titles** of any format (OVAs, specials, music videos) get the film treatment: hero Play/Download actions instead of a one-card grid.

### 🔍 OVA Torrent Search & Downloads, End to End
- **OVA pages search with parent-season aliases:** aliases are built from the AniList PARENT relation (previously the alias list was empty and only one query fired). The ≤3 indexer queries now also run in parallel.
- **Wrong-season bundle rejection on OVA pages:** franchise season chains are resolved for OVAs via the AniList graph, so mega-bundles containing other seasons are rejected during automatic search; the franchise filter guards automatic searches again (the condition was inverted).
- **Smarter OVA auto-pick:** dedicated OVA releases compete with bundles inside seeded-first language tiers; shape ordering prefers dedicated → single-season bundle → whole-franchise mega-bundle; uncensored releases get a tie-break bonus; content-type tails (+OVA, +Movie, Specials, S01+02) keep prefix relevance and count as multi-season collections.
- **Engine file selection fixes:** repaired the \`ovaMarker\` regex that had silently killed every \`' ova '\` basename match; plural OVA dirs/files are accepted, marker-matched files beat token-only matches, ties break by distinctive title tokens.
- **Multi-episode OVA series** (Hellsing Ultimate, DxD OVA): \`episodeCount\` is plumbed renderer → preload → job → persist/resume — the whole download is kept and episode cards narrow by decimal or roman number; other seasons' OVAs are dropped from franchise mega-bundles.
- **No more eternal zombie downloads:** a swarm stalled 75 s after both stall-recovery attempts with no peers and no available pieces fails with a clear message instead of sitting at 0 MB/s forever.

### 📺 Episode List Integrity (API Episode Search)
- **Franchise extras no longer pose as regular episodes:** ani.zip crosswalks number franchise OVAs/specials as regular episodes (Steins;Gate's OVA shipped as ep 1 while the true "Turning Point" was missing). Every slot is now date-guarded against the AniList schedule spine, and rows airing after all higher-numbered episodes are dropped. Validated across all 216 cached snapshots — zero legit episodes flagged. Poisoned caches self-heal on every view open.

### ⚡ Subtitle Performance
- **Two-phase subtitle extraction:** cold opens extract a 2-minute window around the playback position first (indexed seek, ~8% of the file, 1–3 s) while the full track builds in the background; the renderer swaps seamlessly onto the full track when it is ready.

### 🛠 Other Fixes & Polish
- Season and OVA release downloads fixed end to end (season-batch title formats like \`Title 01-12 Complete\` are matched correctly against the franchise chain).
- Collection-only cards fetch missing posters via catalog details (24 h cache); the storage overview reloads when the active job set changes.
- **No more subtitle-generation toasts during playback:** background Whisper events ("Episode Subtitles Ready", "Whisper Batch Completed", model/engine readiness) no longer pop toasts over the video player — they land silently in the notification center.

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
