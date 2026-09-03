// Open every file of a freshly installed FastDirect runtime once, from the
// installed Mixdog.exe itself (ELECTRON_RUN_AS_NODE).
//
// Why: on a machine with real-time antivirus, the first open of a NEW file by
// Mixdog.exe costs ~7ms (measured 8.6s for 1,243 files sequentially, 0.6ms
// when node.exe opens the same files). Every FastDirect deploy rewrites the
// whole tree, so without this pass the next boot paid ~1s in the daemon's
// module graph and ~7ms on each of the ~900 lazily imported modules. The
// scan result is cached per file, so a parallel 1-byte read here (~0.6s for
// the whole tree) moves that cost out of the app's boot path.
//
// Usage: ELECTRON_RUN_AS_NODE=1 Mixdog.exe prewarm-fast-runtime.mjs <dir>...
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const CONCURRENCY = 32;

async function listFiles(root, out) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await listFiles(path, out);
    else if (entry.isFile()) out.push(path);
  }
}

async function touchFile(path) {
  let handle = null;
  try {
    handle = await open(path, 'r');
    await handle.read(Buffer.alloc(1), 0, 1, 0);
  } catch {
    // A file that cannot be opened is simply not warmed; the app copes.
  } finally {
    await handle?.close().catch(() => {});
  }
}

const roots = process.argv.slice(2).filter(Boolean);
const files = [];
for (const root of roots) await listFiles(root, files);
const startedAt = Date.now();
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < files.length) await touchFile(files[cursor++]);
}));
console.log(`prewarmed ${files.length} files in ${Date.now() - startedAt}ms`);
