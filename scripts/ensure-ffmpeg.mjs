import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const binDir = path.join(rootDir, 'bin');
const ffmpegExe = path.join(binDir, 'ffmpeg.exe');

if (fs.existsSync(ffmpegExe)) {
  console.log('[ensure-ffmpeg] ffmpeg.exe is present at', ffmpegExe);
  process.exit(0);
}

console.log('[ensure-ffmpeg] ffmpeg.exe not found. Downloading static build from gyan.dev...');
if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

const zipUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const zipPath = path.join(rootDir, 'ffmpeg-temp.zip');
const tempDir = path.join(rootDir, 'temp-ffmpeg-extract');

try {
  console.log('[ensure-ffmpeg] Downloading essentials archive...');
  execSync(`curl.exe -L -o "${zipPath}" "${zipUrl}"`, { stdio: 'inherit' });
  console.log('[ensure-ffmpeg] Extracting ffmpeg.exe...');
  execSync(
    `powershell.exe -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force; Move-Item '${tempDir}\\*\\bin\\ffmpeg.exe' '${ffmpegExe}' -Force; Remove-Item '${tempDir}' -Recurse -Force; Remove-Item '${zipPath}' -Force"`,
    { stdio: 'inherit' }
  );
  console.log('[ensure-ffmpeg] Successfully placed ffmpeg.exe in', ffmpegExe);
} catch (err) {
  console.error('[ensure-ffmpeg] Failed to download or unpack ffmpeg.exe:', err);
  process.exit(1);
}
