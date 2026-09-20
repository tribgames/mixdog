/**
 * code-graph/modes/structure.mjs — the file-structure modes: overview
 * (project or directory scope, or one file's explainer), imports, related
 * and impact.
 */
import { CODE_GRAPH_MAX_FILES } from '../constants.mjs';
import { _graphRel } from '../source-access.mjs';
import { _buildExplainerFileSummary } from '../symbol-index.mjs';
import { _formatRelated, _formatImpact, _impactSourceNodes, _prewarmSourceTextNodes } from '../search.mjs';
import { fileNotFound, GRAPH_LIST_CAP } from './shared.mjs';

export async function overview(ctx) {
  const { args, cwd, graph, rel, node, scopeRelPrefix, symbolsNote } = ctx;
  if (rel && !node) return fileNotFound('overview', ctx);
  if (node) return `${_buildExplainerFileSummary(node, graph, cwd, { depth: args?.depth })}${symbolsNote}`;
  // A directory anchor is a SCOPE: counting the whole repository under it
  // reported totals the caller never asked for.
  const scopedNodes = scopeRelPrefix
    ? [...graph.nodes.values()].filter((n) => n.rel === scopeRelPrefix.slice(0, -1) || n.rel.startsWith(scopeRelPrefix))
    : [...graph.nodes.values()];
  if (scopeRelPrefix && scopedNodes.length === 0) {
    return `(no indexed files under ${scopeRelPrefix})`;
  }
  const byLang = new Map();
  for (const scoped of scopedNodes) {
    byLang.set(scoped.lang, (byLang.get(scoped.lang) || 0) + 1);
  }
  const lines = [
    ...(scopeRelPrefix ? [`scope\t${scopeRelPrefix}`] : []),
    `files\t${scopedNodes.length}`,
    `edges\t${scopedNodes.reduce((sum, n) => sum + n.resolvedImports.length, 0)}`,
  ];
  for (const [lang, count] of [...byLang.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`${lang}\t${count}`);
  }
  if (graph?.truncated) {
    lines.push(
      `WARN: graph truncated at CODE_GRAPH_MAX_FILES=${CODE_GRAPH_MAX_FILES} — some files under cwd were not indexed`
    );
  }
  return `${lines.join('\n')}${symbolsNote}`;
}

export async function imports(ctx) {
  const { cwd, node } = ctx;
  if (!node) return fileNotFound('imports', ctx);
  const resolvedAll = node.resolvedImports.map((p) => _graphRel(p, cwd));
  const rawAll = node.rawImports;
  const resolved = resolvedAll.slice(0, GRAPH_LIST_CAP);
  const raw = rawAll.slice(0, GRAPH_LIST_CAP);
  const parts = [];
  if (resolved.length) parts.push(resolved.join('\n'));
  if (raw.length) parts.push(`# raw\n${raw.join('\n')}`);
  if (resolvedAll.length > resolved.length || rawAll.length > raw.length) {
    parts.push(
      `[truncated — showing first ${GRAPH_LIST_CAP} of ${resolvedAll.length} resolved / ${rawAll.length} raw imports]`
    );
  }
  return parts.join('\n\n') || '(no imports)';
}

export async function related(ctx) {
  const { cwd, graph, node } = ctx;
  if (!node) return fileNotFound('related', ctx);
  return _formatRelated(node, graph, cwd);
}

export async function impact(ctx) {
  const { args, cwd, signal, graph, node } = ctx;
  if (!node) return fileNotFound('impact', ctx);
  const targetSymbol = String(args?.symbol || '').trim();
  await _prewarmSourceTextNodes(graph, [node], { signal });
  await _prewarmSourceTextNodes(graph, _impactSourceNodes(node, graph, targetSymbol), { signal });
  return _formatImpact(node, graph, cwd, targetSymbol);
}
