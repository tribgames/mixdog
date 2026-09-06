// Exact-file graph: a single-file graph built straight from the native record,
// cached by source hash so repeated outline / find_symbol calls on the same
// file never re-run the binary. Extracted from dispatch.mjs.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve as pathResolve } from 'node:path';
import { _graphRel } from './source-access.mjs';
import { _fileInfoFromRustRecord, _runGraphFiles } from './graph-binary.mjs';
import { _attachGraphRuntimeCaches, _estimateGraphRetainedBytes } from './graph-model.mjs';

const _exactFileGraphInflight = new Map();
const _exactFileGraphCache = new Map();
const EXACT_FILE_GRAPH_CACHE_MAX = 64;
const EXACT_FILE_GRAPH_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export function _pruneExactFileGraphCache() {
  const rows = [..._exactFileGraphCache.entries()].map(([key, entry]) => ({
    key,
    retainedBytes: _estimateGraphRetainedBytes(entry?.graph),
  }));
  let totalRetainedBytes = rows.reduce((sum, row) => sum + row.retainedBytes, 0);
  for (const row of rows) {
    if (
      _exactFileGraphCache.size <= EXACT_FILE_GRAPH_CACHE_MAX
      && totalRetainedBytes <= EXACT_FILE_GRAPH_CACHE_MAX_BYTES
    ) break;
    _exactFileGraphCache.delete(row.key);
    totalRetainedBytes -= row.retainedBytes;
  }
}

export async function _buildExactFileGraph(cwd, abs, signal = null) {
  const root = pathResolve(cwd);
  const file = pathResolve(abs);
  const rel = _graphRel(file, root);
  const key = `${root}\0${rel}`;
  const sourceText = await readFile(file, { encoding: 'utf8', signal: signal || undefined });
  const sourceHash = createHash('sha256').update(sourceText).digest('hex');
  const cached = _exactFileGraphCache.get(key);
  if (cached?.sourceHash === sourceHash) {
    _exactFileGraphCache.delete(key);
    _exactFileGraphCache.set(key, cached);
    return cached.graph;
  }
  const existing = _exactFileGraphInflight.get(key);
  if (existing?.sourceHash === sourceHash) return existing.promise;
  const pending = (async () => {
    const records = await _runGraphFiles(root, [rel], [], signal);
    const record = records.find((item) => _graphRel(pathResolve(root, item.rel), root) === rel);
    if (!record) return null;
    const info = _fileInfoFromRustRecord(record, root);
    const node = {
      abs: info.abs,
      rel: info.rel,
      lang: info.lang,
      fingerprint: info.fingerprint,
      rawImports: info.rawImports,
      resolvedImportsRel: [],
      resolvedImports: [],
      importedBy: [],
      packageName: info.packageName,
      namespaceName: info.namespaceName,
      goPackageName: info.goPackageName,
      topLevelTypes: info.topLevelTypes,
      tokenSymbols: info.tokenSymbols,
      symbols: Array.isArray(info.symbols) ? info.symbols : [],
    };
    const graph = _attachGraphRuntimeCaches({
      cwd: root,
      nodes: new Map([[node.rel, node]]),
      reverse: new Map(),
      builtAt: Date.now(),
      signature: info.fingerprint || '',
      truncated: false,
    });
    graph._sourceTextCache.set(node.rel, {
      fingerprint: node.fingerprint || '',
      text: sourceText,
    });
    _exactFileGraphCache.delete(key);
    _exactFileGraphCache.set(key, { sourceHash, graph });
    _pruneExactFileGraphCache();
    return graph;
  })();
  const inflight = { sourceHash, promise: pending };
  _exactFileGraphInflight.set(key, inflight);
  try {
    return await pending;
  } finally {
    if (_exactFileGraphInflight.get(key) === inflight) _exactFileGraphInflight.delete(key);
  }
}
