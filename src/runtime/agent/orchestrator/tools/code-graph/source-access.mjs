// Per-node source-text accessors with fingerprint-keyed runtime caching:
// raw text, raw lines, masked lines. Extracted verbatim from code-graph.mjs.
import { readFileSync } from 'node:fs';
import { toDisplayPath } from '../builtin.mjs';
import { _maskNonCodeText } from './text-mask.mjs';

export function _graphRel(absPath, cwd) {
  return toDisplayPath(absPath, cwd);
}

export function _getSourceTextForNode(graph, node, fallbackText = null) {
  const cached = graph?._sourceTextCache?.get(node.rel);
  if (cached && cached.fingerprint === (node.fingerprint || '')) {
    return cached.text;
  }
  if (typeof fallbackText === 'string') {
    graph?._sourceTextCache?.set(node.rel, {
      fingerprint: node.fingerprint || '',
      text: fallbackText,
    });
    return fallbackText;
  }
  let text = '';
  let readOk = false;
  try { text = readFileSync(node.abs, 'utf8'); readOk = true; } catch { text = ''; readOk = false; }
  if (readOk) {
    graph?._sourceTextCache?.set(node.rel, {
      fingerprint: node.fingerprint || '',
      text,
    });
  }
  return text;
}

export function _getSourceLinesForNode(graph, node) {
  const cached = graph?._sourceLinesCache?.get(node.rel);
  if (cached && cached.fingerprint === (node.fingerprint || '')) {
    return cached.lines;
  }
  const text = _getSourceTextForNode(graph, node);
  const lines = text.split(/\r?\n/);
  graph?._sourceLinesCache?.set(node.rel, {
    fingerprint: node.fingerprint || '',
    lines,
  });
  return lines;
}

export function _getMaskedLinesForNode(graph, node) {
  const cached = graph?._maskedLinesCache?.get(node.rel);
  if (cached && cached.fingerprint === (node.fingerprint || '')) {
    return cached.lines;
  }
  const text = _getSourceTextForNode(graph, node);
  const lines = _maskNonCodeText(text, node.lang).split(/\r?\n/);
  graph?._maskedLinesCache?.set(node.rel, {
    fingerprint: node.fingerprint || '',
    lines,
  });
  return lines;
}

// "file not found in graph" fires AFTER the dispatch-level existsSync check
// passed — the file EXISTS on disk but is not indexed. Say that explicitly,
// and offer same-basename indexed paths as a secondary pointer (capped at 3).
export function _appendSameBasenameHint(message, normFile, graph) {
  const raw = String(normFile || '');
  const base = raw.replace(/\\/g, '/').split('/').pop();
  if (!base || !graph?.nodes) return message;
  const baseLower = base.toLowerCase();
  const matches = [];
  for (const key of graph.nodes.keys()) {
    if (key.split('/').pop().toLowerCase() === baseLower) {
      matches.push(key);
      if (matches.length >= 3) break;
    }
  }
  const why = ' — the file exists on disk but is not indexed (excluded dir like dist/vendor, unsupported type, or graph file cap); use grep/read on it directly.';
  if (!matches.length) return `${message}${why}`;
  return `${message}${why} If you meant the indexed source, same filename is indexed at: ${matches.map((m) => `"${m}"`).join(', ')}.`;
}
