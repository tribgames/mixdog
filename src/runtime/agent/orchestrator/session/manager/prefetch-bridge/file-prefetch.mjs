// files[] prefetch through the per-file cross-dispatch cache (process-local):
// cached files are served from memory, misses are read once and — default
// window only — cached for the next dispatch.
import { isAbsolute, normalize, resolve } from 'node:path';
import { executeInternalTool } from '../../../internal-tools.mjs';
import { classifyResultKind } from '../../result-classification.mjs';
import { tryPrefetchCached, setPrefetchCached, capturePrefetchCacheState } from '../../read-dedup.mjs';
import { runAbortable, throwIfAborted } from '../../../../../shared/abort-race.mjs';

const DEFAULT_HEAD_LINES = 120;

export async function prefetchFiles(session, { files, readOpts }, signal) {
  throwIfAborted(signal);
  const cwd = session.cwd || null;
  const absPath = (file) => normalize(isAbsolute(file) ? file : resolve(cwd || process.cwd(), file));
  const hits = new Map(); // file → cached content
  const misses = []; // { file, abs } — need a disk read
  for (const file of files) {
    const abs = absPath(file);
    // Skip the cross-dispatch cache when the caller asked for a non-default
    // window (custom n or full-file). The cache key is the path alone, so a
    // default-window cache hit would silently feed the wrong slice back to
    // the next caller.
    const hit = readOpts.has(file) ? null : tryPrefetchCached(abs);
    if (hit) hits.set(file, hit.content);
    else misses.push({ file, abs });
  }

  const failed = [];
  const missResults = {}; // file → content string
  if (misses.length > 0) {
    // Read misses concurrently while retaining per-file cache provenance.
    const readStates = new Map();
    await runAbortable(signal, () =>
      Promise.all(
        misses.map(async ({ file, abs }) => {
          const opts = readOpts.get(file) || {};
          let readArgs;
          if (opts.mode === 'full') {
            readArgs = { path: file, mode: 'full' };
          } else {
            readArgs = { path: file, mode: 'head', n: Number.isFinite(opts.n) ? opts.n : DEFAULT_HEAD_LINES };
          }
          readStates.set(file, capturePrefetchCacheState(abs));
          const out = await executeInternalTool('read', readArgs, {
            scopeId: session.mcpScopeId || null,
            callerSessionId: session.id,
            callerCwd: session.cwd,
            signal,
          }).catch((e) => {
            process.stderr.write(`[agent-prefetch] file read failed (${file}): ${e?.message || e}\n`);
            return null;
          });
          if (out !== null) missResults[file] = String(out);
        })
      )
    );
    for (const { file, abs } of misses) {
      const content = missResults[file];
      if (content && classifyResultKind(content) !== 'error') {
        // Only cache default-window reads; custom-window results would poison
        // the shared cross-dispatch cache.
        if (!readOpts.has(file)) setPrefetchCached(abs, content, readStates.get(file));
      } else if (content === undefined || classifyResultKind(content) === 'error') {
        failed.push(file);
      }
    }
  }

  // Combined output in the original file order.
  const readParts = [];
  for (const file of files) {
    if (hits.has(file)) {
      readParts.push(hits.get(file));
      continue;
    }
    const content = missResults[file];
    if (content && classifyResultKind(content) !== 'error') readParts.push(content);
  }
  return {
    readParts,
    failed,
    stats: { files: files.length, cached: hits.size, miss: misses.length, failed: failed.length },
  };
}
