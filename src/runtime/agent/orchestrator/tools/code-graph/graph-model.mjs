// Graph (de)serialization, runtime-cache lifecycle, and signature hashing.
// Extracted verbatim from code-graph.mjs. Graph shape: { cwd, nodes:
// Map<rel,node>, reverse: Map<rel,Set<rel>>, schemaVersion, builtAt,
// signature, +runtime caches }. Persisted form omits empty fields.
import { createHash } from 'node:crypto';
import { resolve as pathResolve } from 'node:path';
import { SYMBOL_SCHEMA_VERSION, CODE_GRAPH_MAX_FILES } from './constants.mjs';

export function _computeGraphSignature(fileMetas) {
  const hash = createHash('sha1');
  hash.update(`${SYMBOL_SCHEMA_VERSION}\n`);
  // R5-③: include rel/path alongside fp so renames and path-swaps (same
  // bytes moved to a different rel, or two files exchanging paths) flip
  // the signature and invalidate the memory/disk cache checks at the
  // call sites just below in buildCodeGraphAsync. Without rel, an fp-only
  // hash collides across rename pairs and the cache serves stale graph
  // topology where node.rel no longer matches what's on disk.
  for (const meta of fileMetas) hash.update(`${meta.rel || ''}\0${meta.fp}\n`);
  return hash.digest('hex');
}

export function _serializeGraph(graph) {
  // Compact-on-disk: omit empty / falsy fields. Saves ~30-50% on disk
  // for typical mixed-language graphs because most nodes don't carry
  // packageName / namespaceName / topLevelTypes. Smaller
  // payload → faster JSON.parse on cold-process boot. _deserializeGraph
  // tolerates missing fields by defaulting to '' / [].
  return {
    schemaVersion: SYMBOL_SCHEMA_VERSION,
    builtAt: Number(graph?.builtAt || Date.now()),
    signature: String(graph?.signature || ''),
    truncated: Boolean(graph?.truncated),
    maxFiles: CODE_GRAPH_MAX_FILES,
    nodes: [...(graph?.nodes?.values?.() || [])].map((node) => {
      const out = {
        rel: node.rel,
        lang: node.lang,
      };
      if (node.fingerprint) out.fingerprint = node.fingerprint;
      if (Array.isArray(node.rawImports) && node.rawImports.length) out.rawImports = node.rawImports;
      if (Array.isArray(node.resolvedImportsRel) && node.resolvedImportsRel.length) {
        out.resolvedImports = node.resolvedImportsRel;
      }
      if (Array.isArray(node.importedBy) && node.importedBy.length) {
        out.importedBy = node.importedBy;
      }
      if (node.packageName) out.packageName = node.packageName;
      if (node.namespaceName) out.namespaceName = node.namespaceName;
      if (node.goPackageName) out.goPackageName = node.goPackageName;
      if (Array.isArray(node.topLevelTypes) && node.topLevelTypes.length) {
        out.topLevelTypes = node.topLevelTypes;
      }
      if (Array.isArray(node.tokenSymbols) && node.tokenSymbols.length) {
        out.tokenSymbols = node.tokenSymbols;
      }
      if (Array.isArray(node.symbols) && node.symbols.length) {
        out.symbols = node.symbols;
      }
      return out;
    }),
  };
}

export function _deserializeGraph(cwd, payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.nodes)) return null;
  const nodes = new Map();
  const reverse = new Map();
  for (const item of payload.nodes) {
    if (!item || typeof item.rel !== 'string' || typeof item.lang !== 'string') continue;
    // Persisted fields are repo-relative, mirroring the live build. The
    // JS resolution layer is gone — resolvedImports/resolvedImportsRel are
    // restored straight from disk; the reverse index is rederived below from
    // the forward edges of every node.
    const resolvedImportsRel = Array.isArray(item.resolvedImports) ? item.resolvedImports.filter((v) => typeof v === 'string') : [];
    const importedBy = Array.isArray(item.importedBy) ? item.importedBy.filter((v) => typeof v === 'string') : [];
    const node = {
      abs: pathResolve(cwd, item.rel),
      rel: item.rel,
      lang: item.lang,
      fingerprint: item.fingerprint || '',
      rawImports: Array.isArray(item.rawImports) ? item.rawImports : [],
      resolvedImportsRel,
      resolvedImports: resolvedImportsRel.map((rel) => pathResolve(cwd, rel)),
      importedBy,
      packageName: item.packageName || '',
      namespaceName: item.namespaceName || '',
      goPackageName: item.goPackageName || '',
      topLevelTypes: Array.isArray(item.topLevelTypes) ? item.topLevelTypes : [],
      tokenSymbols: Array.isArray(item.tokenSymbols) ? item.tokenSymbols : null,
      symbols: Array.isArray(item.symbols) ? item.symbols : [],
    };
    nodes.set(node.rel, node);
    // reverse is derived from the FORWARD edges of every node, not from the
    // persisted importedBy. On the incremental --files path reused nodes carry
    // a stale importedBy, so a fresh edge A→B (A parsed, B reused) would drop
    // B's reverse entry. Walking resolvedImportsRel keeps reverse self-consistent.
    for (const rel of resolvedImportsRel) {
      if (!reverse.has(rel)) reverse.set(rel, new Set());
      reverse.get(rel).add(node.rel);
    }
  }
  const graph = _attachGraphRuntimeCaches({
    cwd,
    nodes,
    reverse,
    // Pre-endLine disk payloads have no schemaVersion → null → dropped by the
    // previousGraph schema guard so their endLine-less nodes never seed reuse.
    schemaVersion: typeof payload.schemaVersion === 'string' ? payload.schemaVersion : null,
    builtAt: Number(payload.builtAt || Date.now()),
    signature: String(payload.signature || ''),
  });
  // Restore the truncation flag persisted from the live build so disk-cache
  // hits keep emitting the WARN line in find_symbol/overview output instead
  // of silently working with a partial graph.
  if (graph && payload.truncated) graph.truncated = true;
  return graph;
}

export function _attachGraphRuntimeCaches(graph) {
  if (!graph || typeof graph !== 'object') return graph;
  if (!graph._referenceSearchCache) graph._referenceSearchCache = new Map();
  if (!graph._keywordSearchCache) graph._keywordSearchCache = new Map();
  if (!graph._maskedLinesCache) graph._maskedLinesCache = new Map();
  if (!graph._sourceLinesCache) graph._sourceLinesCache = new Map();
  if (!graph._sourceTextCache) graph._sourceTextCache = new Map();
  if (!graph._symbolTokenIndex) graph._symbolTokenIndex = new Map();
  if (typeof graph._symbolTokenIndexDirty !== 'boolean') graph._symbolTokenIndexDirty = true;
  return graph;
}

export function _estimateGraphRuntimeCacheBytes(graph) {
  if (!graph) return 0;
  let total = 0;
  for (const entry of graph._sourceTextCache?.values() || []) {
    total += Buffer.byteLength(String(entry?.text || ''), 'utf8');
  }
  for (const lines of graph._maskedLinesCache?.values() || []) {
    if (!Array.isArray(lines)) continue;
    for (const line of lines) total += Buffer.byteLength(String(line || ''), 'utf8');
  }
  for (const lines of graph._sourceLinesCache?.values() || []) {
    if (!Array.isArray(lines)) continue;
    for (const line of lines) total += Buffer.byteLength(String(line || ''), 'utf8');
  }
  for (const memo of graph._referenceSearchCache?.values() || []) {
    total += Buffer.byteLength(String(memo || ''), 'utf8');
  }
  for (const memo of graph._keywordSearchCache?.values() || []) {
    total += Buffer.byteLength(String(memo || ''), 'utf8');
  }
  return total;
}

export function _clearGraphRuntimeCaches(graph) {
  if (!graph) return;
  graph._sourceTextCache?.clear();
  graph._maskedLinesCache?.clear();
  graph._sourceLinesCache?.clear();
  graph._referenceSearchCache?.clear();
  graph._keywordSearchCache?.clear();
  graph._symbolTokenIndex?.clear();
  graph._symbolTokenIndexDirty = true;
}
