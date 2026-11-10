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

### 🗜️ Bundled 7-Zip Engine & Zero-Dependency Archive Decompression
- **Decompression Fix for Windows 10 & 11:** Fixed decompression failure (exit code 1) on Windows 10 and systems where Windows \`tar.exe\` lacked native \`.7z\` / \`libarchive\` format support.
- **Bundled 7-Zip Binaries:** Included lightweight, standalone 7-Zip binaries (\`bin/7z.exe\` and \`bin/7z.dll\`) directly within Kaiko's application resources (\`resources/bin/\`), guaranteeing 100% extraction reliability on all Windows versions with zero external tools or dependencies required.
- **Extractor Cascade:** Added smart extraction tool resolution that prioritizes the bundled 7-Zip engine with fallbacks to system 7-Zip and Windows \`tar.exe\`.
- **Live Extraction Progress:** Streamed real-time unpacking percentage (\`-bsp1\`) directly to the UI during Faster-Whisper-XXL engine installation, along with detailed stdout and stderr diagnostics.

### ⚡ Faster-Whisper-XXL In-App Downloader
- **1-Click Engine Installation:** Direct streaming download of the standalone \`Faster-Whisper-XXL\` speech-to-text engine within Kaiko without manual archive extraction.
- **Real-Time Speed & Progress:** Live MB/s speed, downloaded/total megabytes, percentage, and cancellation support.

### 🎨 Rich Release Notes Formatting in Updater
- **GitHub & Markdown Rendering:** The update notification modal parses and renders formatted HTML / Markdown release notes directly from GitHub releases with dark theme styling.
- **Safe DOM Sanitization & External Links:** Comprehensive sanitization prevents script injection, and release note links safely launch in your default system browser.

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
