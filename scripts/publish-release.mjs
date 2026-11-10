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

### 🎙️ Subtitle Single-Word Merging & 2-Line Formatting Overhaul
- **Strict 2-Row Guarantee:** Subtitles are strictly formatted to at most 2 lines (\`max_line_count: 2\`) with smart mid-sentence line balancing. Any merge that would overflow into an awkward 3rd line is prevented.
- **Smart Capitalization Handling:** Mid-sentence orphan words are cleanly lowercased (e.g. \`"I think"\` + \`"So."\` → \`"I think so."\`), while properly preserving proper nouns, character names, and pronouns (\`"I"\`, \`"I'm"\`).
- **Natural Start-of-Cue Casing:** Orphan words prepended to subsequent cues are capitalized and the following word lowercased (e.g. \`"because"\` + \`"He was late."\` → \`"Because he was late."\`).

### 🧠 Whisper Initial Prompt & Hotwords Generator Overhaul
- **Priors-Compliant Natural Template:** Replaced instruction-style commands with natural spoken dialogue priors: \`"Dialogue from an anime episode. Characters: {names}."\`.
- **Eliminated Command Leaks:** Removed phrases like \`"clean subtitles"\` and \`"conversational speech"\` that Whisper often mistook as transcript text and leaked into subtitles.
- **Strict Token Budgeting:** Enforced token budget (≤ 180 tokens) with token-aware character ranking to prevent context window overflows.
- **Role Prioritization & Filtering:** \`MAIN\` characters prioritized first, then \`SUPPORTING\`. Completely skips \`BACKGROUND\` and episodic extras.
- **API Character Normalization:** Strips voice actor tags, parentheses, honorifics, titles, and non-name descriptions (\`"Kyon no Imouto"\`, \`"X's sister"\`, \`"Townsperson A"\`). Corrects Japanese surname-first ordering (\`"Yeager Eren"\` → \`"Eren Yeager"\`).
- **Length Trimming & Ambiguous Names:** Full names for top 3 characters, spoken/first names for characters 4+. Common English word names (\`"Light"\`, \`"Ray"\`, \`"May"\`, \`"Rose"\`, etc.) pushed to the end to prevent Whisper substitutions.
- **Faster-Whisper \`--hotwords\` Integration:** Automatically passes the top character names via \`--hotwords\` for every segment window.

### 🔍 RapidFuzz-Style Fuzzy Character Corrector & Hallucination Filter
- **Whole-Word Fuzzy Spelling Correction:** Corrects near-miss character name spellings in English transcripts using the unconstrained full cast list (Levenshtein distance ≤ 2, ratio ≥ 86%).
- **English Dictionary Stoplist Protection:** Top common English words are strictly immune from name replacement.
- **Silence & Music Hallucination Filtering:** Automatically drops known Whisper hallucinations on non-speech segments (\`"Thank you for watching"\`, \`"Subtitles by..."\`, repetitive loops).

### 🛠️ In-App Model & Engine Deletion in Settings
- **1-Click Deletion with Confirmation:** Delete installed Whisper AI models directly from Settings to easily free disk space.
- **Engine Deletion:** Dedicated control to remove the standalone Faster-Whisper-XXL engine from application storage.
- **Simplified Model Management:** Removed confusing Active/Select radio controls from Settings; active model selection is handled directly on-the-fly in Whisper Studio.

### ⚡ Windows MAX_PATH (260 Chars) Whisper Fix
- Resolved \`FileNotFoundError: [Errno 2]\` on long filenames by switching intermediate staging files to compact hashes in system temp (\`Temp/kaiko_w/<run>_<hash>\`), shortening paths by over 130 characters.

### 🎬 Player Episode Drawer Progress Resume Fix
- Selecting an episode from the in-player drawer or next-up button resumes playback from saved progress instead of restarting from 0:00.

### 🧹 UI De-clutter
- Removed verbose subtitle descriptions from Settings headers and removed the redundant "Transcribing in background" badge from the top navbar.

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
