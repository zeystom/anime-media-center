import path from 'path';

/**
 * Returns true when `child` is the `root` itself or is located anywhere inside it.
 * Both paths are resolve-normalized before comparison, so directory traversal via
 * '..' segments, redundant separators, and differing drive letters are handled safely.
 *
 * Shared by the stream server's path allow-list and the library manager's deletion
 * guards. Keep in sync with test-path-security.js.
 */
export function isPathInside(child: string, root: string): boolean {
  try {
    const rel = path.relative(path.resolve(root), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/**
 * Finds the first root in `allowedRoots` that contains `targetPath`.
 * The exact root itself counts as allowed. Comparison is resolve-normalized
 * (see isPathInside), so '..' traversal escaping a root is never matched.
 *
 * Returns the matching entry from `allowedRoots` exactly as it was passed in,
 * or null when the target is outside every root (or inputs are invalid).
 */
export function findAllowedRootFor(targetPath: string, allowedRoots: string[]): string | null {
  if (!targetPath || typeof targetPath !== 'string') return null;
  if (!Array.isArray(allowedRoots)) return null;
  for (const root of allowedRoots) {
    if (!root || typeof root !== 'string') continue;
    if (isPathInside(targetPath, root)) {
      return root;
    }
  }
  return null;
}
