import assert from 'assert';
import path from 'path';

function isPathInside(child, root) {
  try {
    const rel = path.win32.relative(path.win32.resolve(root), path.win32.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel));
  } catch {
    return false;
  }
}

const cases = [
  { root: 'E:\\', child: 'E:\\Anime\\Show\\ep01.mkv', expected: true, desc: 'Root E:\\ with nested episode' },
  { root: 'E:\\Anime', child: 'E:\\Anime2\\x.mkv', expected: false, desc: 'Sibling folder with prefix collision' },
  { root: 'E:\\Anime', child: 'E:\\Anime\\..\\Secret\\x.mkv', expected: false, desc: 'Directory traversal escaping root' },
  { root: 'E:\\Anime', child: 'D:\\Anime\\x.mkv', expected: false, desc: 'Different drive letter entirely' },
  { root: 'E:\\Anime', child: 'E:\\Anime', expected: true, desc: 'Exact directory match' },
  { root: 'E:\\Anime', child: 'E:\\Anime\\Episode 01.mkv', expected: true, desc: 'Direct child file' },
];

console.log('Testing isPathInside() security & drive root resolution on Windows:');
for (const tc of cases) {
  const result = isPathInside(tc.child, tc.root);
  assert.strictEqual(
    result,
    tc.expected,
    `FAILED: ${tc.desc} (root: "${tc.root}", child: "${tc.child}") -> got ${result}, expected ${tc.expected}`
  );
  console.log(`✓ Passed: ${tc.desc} (${result ? 'ALLOWED' : 'DENIED'})`);
}

console.log('\nAll isPathInside security checks passed successfully!');
