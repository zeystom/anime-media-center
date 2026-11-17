import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

export const KAIKO_APP_ID = 'com.animemediacenter.app';

function isAsarPath(filePath: string): boolean {
  return /(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/i.test(filePath);
}

/**
 * Resolve an icon path for BrowserWindow({ icon }).
 * Prefers an unpacked .ico in process.resourcesPath so packaged builds do not
 * depend on reading icons from inside app.asar.
 */
export function resolveWindowIconPath(baseDir: string): string | undefined {
  const candidates = [
    ...(app.isPackaged ? [path.join(process.resourcesPath, 'app-icon.ico')] : []),
    path.join(baseDir, '../app-icon.ico'),
    path.join(app.getAppPath(), 'app-icon.ico'),
    ...(app.isPackaged ? [path.join(process.resourcesPath, 'app-icon.png')] : []),
    path.join(baseDir, '../app-icon.png'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolve a real Win32 filesystem icon resource for BrowserWindow.setAppDetails().
 * Windows Explorer cannot load PKEY_AppUserModel_RelaunchIconResource from inside
 * app.asar and falls back to a blank document icon if given an .asar path.
 */
export function resolveShellIconPath(baseDir: string): string | undefined {
  const diskCandidates = [
    ...(app.isPackaged ? [path.join(process.resourcesPath, 'app-icon.ico')] : []),
    path.join(baseDir, '../app-icon.ico'),
    path.join(app.getAppPath(), 'app-icon.ico'),
  ];

  for (const candidate of diskCandidates) {
    if (candidate && !isAsarPath(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (app.isPackaged && process.execPath && fs.existsSync(process.execPath)) {
    return process.execPath;
  }

  return undefined;
}

export function applyWindowAppDetails(win: BrowserWindow, baseDir: string): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;

  const relaunchPath = app.isPackaged
    ? process.execPath
    : path.join(app.getAppPath(), 'Kaiko.exe');
  const appIconPath = resolveShellIconPath(baseDir);

  win.setAppDetails({
    appId: KAIKO_APP_ID,
    ...(appIconPath ? { appIconPath, appIconIndex: 0 } : {}),
    relaunchCommand: `"${relaunchPath}"`,
    relaunchDisplayName: 'Kaiko',
  });
}
