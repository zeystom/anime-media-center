import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/**
 * Keep existing user data in place when the product display name changes.
 * Electron derives its default userData folder from the app name, so search
 * the prior app-name folders before accepting the new Kaiko folder.
 */
export function resolveUserDataPath(): string {
  const currentPath = app.getPath('userData');
  const appDataPath = app.getPath('appData');
  const legacyPaths = [
    path.join(appDataPath, 'Anime Media Center'),
    path.join(appDataPath, 'anime-media-center'),
  ];
  const markers = ['settings.json', 'history.json', 'user-library.json', 'metadata_cache'];

  for (const candidate of legacyPaths) {
    if (candidate === currentPath || !fs.existsSync(candidate)) continue;
    if (markers.some((marker) => fs.existsSync(path.join(candidate, marker)))) return candidate;
  }
  return currentPath;
}
