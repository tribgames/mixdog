// code-graph/build-file-infos.mjs — the middle of one graph build: which files
// come back unchanged from the previous graph and how the rest get parsed
// (chunked --files, prefix-scoped --files, or a full walk), the cross-file
// import closure over the resulting records, and the node/reverse maps the
// graph is assembled from.
//
// Change detection, the cache tiers and the graph finalization stay in
// build.mjs; nothing here reads or writes a cache.
import { resolve as pathResolve } from 'node:path';
import { _runGraphWalk, _runGraphFiles, _fileInfoFromRustRecord, _reuseFileInfo } from './graph-binary.mjs';

const CODE_GRAPH_FILES_ARG_MAX_CHARS = 16_000;

// Keep the existing binary protocol while bounding Windows command-line size.
// Each invocation still resolves against the whole tree. Duplicate lightweight
// reused records are merged so relationship fields survive every chunk.
async function _runGraphFilesChunked(
  absRoot,
  rels,
  reusedMetas,
  { maxArgChars = CODE_GRAPH_FILES_ARG_MAX_CHARS, runGraphFiles = _runGraphFiles } = {}
) {
  const budget = Math.max(1, Math.floor(Number(maxArgChars) || CODE_GRAPH_FILES_ARG_MAX_CHARS));
  const chunks = [];
  let chunk = [];
  let chars = 0;
  for (const rel of Array.isArray(rels) ? rels : []) {
    const cost = String(rel).length + 3; // separator plus conservative quoting margin
    if (cost > budget) throw new Error(`code-graph relative path exceeds --files argument budget: ${rel}`);
    if (chunk.length && chars + cost > budget) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(rel);
    chars += cost;
  }
  if (chunk.length) chunks.push(chunk);

  const merged = new Map();
  for (const relChunk of chunks) {
    const records = await runGraphFiles(absRoot, relChunk, reusedMetas);
    for (const rec of Array.isArray(records) ? records : []) {
      if (!rec || typeof rec.rel !== 'string') continue;
      const previous = merged.get(rec.rel);
      if (!previous) {
        merged.set(rec.rel, rec);
        continue;
      }
      const next = { ...previous, ...rec };
      for (const field of ['resolvedImports', 'importedBy']) {
        next[field] = [
          ...new Set([
            ...(Array.isArray(previous[field]) ? previous[field] : []),
            ...(Array.isArray(rec[field]) ? rec[field] : []),
          ]),
        ];
      }
      merged.set(rec.rel, next);
    }
  }
  return [...merged.values()];
}

/**
 * Reuse unchanged nodes by fingerprint; parse the rest in Rust.
 *
 * @param {object} input
 * @param {string} input.absRoot
 * @param {Array<{rel: string, fp: string}>} input.indexed  in-scope manifest entries
 * @param {object|null} input.previousGraph  seed graph, already checked for reuse eligibility
 * @param {string[]} input.prefixes  scoped manifest prefixes (empty = whole tree)
 * @param {number} input.maxFiles
 * @returns {Promise<{ fileInfos: object[], reusedWithoutCalls: boolean }>}
 */
export async function resolveGraphFileInfos({ absRoot, indexed, previousGraph, prefixes, maxFiles }) {
  const reusable = [];
  const freshRels = [];
  // A node reused from a cache entry that was never hydrated carries NO call
  // sites (the main entry has none; they live in the sidecar). Such a rebuild
  // must stay eligible for the lazy sidecar read, otherwise one incremental
  // build silently strips every unchanged file of its call sites.
  let reusedWithoutCalls = false;
  for (const meta of indexed) {
    const previousNode = previousGraph?.nodes?.get(meta.rel) || null;
    if (previousNode && previousNode.fingerprint === meta.fp) {
      if (!Array.isArray(previousNode.calls)) reusedWithoutCalls = true;
      reusable.push(_reuseFileInfo(previousNode, previousGraph, absRoot));
    } else {
      freshRels.push(meta.rel);
    }
  }
  let fileInfos;
  if (freshRels.length === 0) {
    fileInfos = reusable;
  } else if (reusable.length > 0 && freshRels.length <= 256) {
    const recs = await _runGraphFilesChunked(absRoot, freshRels, reusable);
    const reusedByRel = new Map(reusable.map((info) => [info.rel, info]));
    const freshSet = new Set(freshRels);
    fileInfos = [...reusable];
    for (const rec of recs) {
      if (freshSet.has(rec.rel)) {
        fileInfos.push(_fileInfoFromRustRecord(rec, absRoot));
      } else {
        const reusedInfo = reusedByRel.get(rec.rel);
        if (!reusedInfo) continue;
        const resolved = Array.isArray(rec.resolvedImports)
          ? rec.resolvedImports.filter((v) => typeof v === 'string')
          : [];
        reusedInfo.resolvedImports = resolved;
        if (Array.isArray(rec.importedBy)) {
          reusedInfo.importedBy = rec.importedBy.filter((v) => typeof v === 'string');
        }
      }
    }
  } else if (prefixes.length) {
    const recs = await _runGraphFilesChunked(absRoot, freshRels, reusable);
    fileInfos = recs.map((rec) => _fileInfoFromRustRecord(rec, absRoot));
  } else {
    let recs = await _runGraphWalk(absRoot);
    if (recs.length > maxFiles) recs = recs.slice(0, maxFiles);
    fileInfos = recs.map((rec) => _fileInfoFromRustRecord(rec, absRoot));
  }
  return { fileInfos, reusedWithoutCalls };
}

/**
 * Import closure over the build's own records: drop edges that leave the
 * indexed scope, then rebuild importedBy from the surviving edges.
 */
export function linkGraphImports({ fileInfos, indexed }) {
  const allowedRels = new Set(indexed.map((meta) => meta.rel));
  for (const info of fileInfos) {
    info.resolvedImports = (info.resolvedImports || []).filter((rel) => allowedRels.has(rel));
    info.importedBy = [];
  }
  const importedBy = new Map(fileInfos.map((info) => [info.rel, []]));
  for (const info of fileInfos) {
    for (const targetRel of info.resolvedImports) {
      const sources = importedBy.get(targetRel);
      if (sources) sources.push(info.rel);
    }
  }
  for (const info of fileInfos) {
    info.importedBy = [...new Set(importedBy.get(info.rel) || [])];
  }
}

/** The graph's node map plus the reverse-import index. */
export function assembleGraphNodes({ fileInfos, absRoot }) {
  const nodes = new Map();
  const reverse = new Map();
  for (const info of fileInfos) {
    const resolvedImportsRel = Array.isArray(info.resolvedImports) ? info.resolvedImports : [];
    const importedBy = Array.isArray(info.importedBy) ? info.importedBy : [];
    const node = {
      abs: info.abs,
      rel: info.rel,
      lang: info.lang,
      fingerprint: info.fingerprint,
      parseError: info.parseError || '',
      rawImports: info.rawImports,
      resolvedImportsRel,
      resolvedImports: resolvedImportsRel.map((rel) => pathResolve(absRoot, rel)),
      importedBy,
      packageName: info.packageName,
      namespaceName: info.namespaceName,
      goPackageName: info.goPackageName,
      topLevelTypes: info.topLevelTypes,
      tokenSymbols: info.tokenSymbols,
      symbols: Array.isArray(info.symbols) ? info.symbols : [],
      // null = unknown (binary without `calls`), [] = no call sites.
      calls: Array.isArray(info.calls) ? info.calls : null,
    };
    nodes.set(info.rel, node);
    for (const rel of resolvedImportsRel) {
      if (!reverse.has(rel)) reverse.set(rel, new Set());
      reverse.get(rel).add(node.rel);
    }
  }
  return { nodes, reverse };
}
