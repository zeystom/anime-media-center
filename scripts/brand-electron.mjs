import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

if (process.platform === 'win32') {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const version = pkg.version || '2.0.1';
    const iconPath = path.join(rootDir, 'app-icon.ico');
    const distDir = path.join(rootDir, 'node_modules', 'electron', 'dist');
    const electronExe = path.join(distDir, 'electron.exe');
    const brandedExe = path.join(distDir, 'Kaiko.exe');

    let rceditPath = path.join(rootDir, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
    if (!fs.existsSync(rceditPath) && process.env.LOCALAPPDATA) {
      const cacheDir = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign');
      if (fs.existsSync(cacheDir)) {
        for (const entry of fs.readdirSync(cacheDir)) {
          const candidate = path.join(cacheDir, entry, 'rcedit-x64.exe');
          if (fs.existsSync(candidate)) {
            rceditPath = candidate;
            break;
          }
        }
      }
    }

    if (fs.existsSync(electronExe) && fs.existsSync(rceditPath) && fs.existsSync(iconPath)) {
      const args = [
        electronExe,
        '--set-version-string', 'FileDescription', 'Kaiko',
        '--set-version-string', 'ProductName', 'Kaiko',
        '--set-version-string', 'CompanyName', 'Kaiko',
        '--set-version-string', 'InternalName', 'Kaiko',
        '--set-version-string', 'OriginalFilename', 'Kaiko.exe',
        '--set-version-string', 'LegalCopyright', 'Copyright © 2026 Kaiko',
        '--set-file-version', version,
        '--set-product-version', version,
        '--set-icon', iconPath,
      ];
      execFileSync(rceditPath, args, { stdio: 'ignore' });
      fs.copyFileSync(electronExe, brandedExe);
      console.log('[brand-electron] Branded node_modules/electron/dist/{electron.exe,Kaiko.exe} as Kaiko');
    }
  } catch (err) {
    console.warn('[brand-electron] Warning:', err?.message || err);
  }
}
