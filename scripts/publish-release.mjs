import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const OWNER = 'zeystom';
const REPO = 'anime-media-center';
const TAG = 'v1.0.8';
const RELEASE_NAME = 'Kaiko 1.0.8';

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

const RELEASE_BODY = `## What's new in v1.0.8

### ⚡ In-App Faster-Whisper-XXL Engine Downloader & Auto-Setup
- **1-Click Engine Installation:** Download and configure the standalone \`Faster-Whisper-XXL\` speech-to-text engine directly inside Kaiko without ever having to visit GitHub, manually download \`.7z\` archives, or extract files with third-party tools.
- **Real-Time Download Progress:** Built-in streaming download engine with live percentage, transfer speed (MB/s), received/total size, and cancellation support.
- **Native Archive Extraction:** Uses Windows native \`tar.exe\` / \`libarchive\` to automatically extract the engine into persistent application storage (\`AppData/Roaming/Kaiko/bin/faster-whisper-xxl\`).
- **Immediate Setup:** Accessible from both **Settings → Whisper** and the **Whisper Studio** setup banner with immediate auto-detection upon completion.

### 🎨 Rich Release Notes Formatting in Updater
- **GitHub & Markdown Rendering:** The update notification modal now parses and renders formatted HTML / Markdown release notes directly from GitHub releases instead of showing raw markup tags.
- **Styled Typography & Dark Theme:** Headings, bulleted lists, bold text, inline code badges, and code blocks styled to match Kaiko's dark purple aesthetic.
- **Secure DOM Sanitization:** Comprehensive sanitization prevents XSS vulnerabilities and malicious script execution.
- **Safe External Link Handling:** Release note links securely launch in your system's default browser rather than navigating the app window.
- **Expanded Scroll View:** Increased container height with smooth scrolling for easier reading of release highlights.

---
### Assets included:
- \`Kaiko-Setup-1.0.8.exe\` — Windows NSIS installer
- \`latest.yml\` — Auto-update metadata for electron-updater
`;

const ASSETS = [
  { name: 'Kaiko-Setup-1.0.8.exe', file: 'dist-build/Kaiko-Setup-1.0.8.exe', type: 'application/octet-stream' },
  { name: 'Kaiko-Setup-1.0.8.exe.blockmap', file: 'dist-build/Kaiko Setup 1.0.8.exe.blockmap', type: 'application/octet-stream' },
  { name: 'Kaiko.Setup.1.0.8.exe', file: 'dist-build/Kaiko.Setup.1.0.8.exe', type: 'application/octet-stream' },
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
