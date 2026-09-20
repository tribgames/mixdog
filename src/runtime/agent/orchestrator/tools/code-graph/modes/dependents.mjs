/**
 * code-graph/modes/dependents.mjs — reverse imports of one file. The anchor
 * is the `file` argument, or — when none was supplied — a file inferred from
 * a symbol (its defining file) or a path-shaped symbol value.
 */
import { isAbsolute, resolve as pathResolve } from 'node:path';
import { _graphRel } from '../source-access.mjs';
import { _findSymbolHits, _prewarmSourceTextNodes } from '../search.mjs';
import { fileNotFound, GRAPH_LIST_CAP } from './shared.mjs';

const KNOWN_SRC_EXT =
  /\.(mjs|cjs|js|jsx|mts|cts|ts|tsx|json|py|pyi|go|rb|rs|java|kt|kts|c|h|cc|cpp|cxx|hpp|hxx|hh|cs|php|swift|scala|sc|sh|bash|zsh|lua|dart|m|mm|ex|exs|zig|r)$/i;

// Symbol inference runs ONLY when no `file` arg was supplied at all — an
// explicit file (even a directory that yields no rel) is never overridden.
// Symbol lookup FIRST — dotted names (e.g. obj.method) resolve here before
// any path classification; the pick is deterministic (defining hit, else
// first by sorted rel). Path classification only when the value has a slash
// or a known source extension — never for plain dotted symbol names.
function inferAnchor(args, cwd, graph) {
  const symCandidates = [...(Array.isArray(args?.symbols) ? args.symbols : []), args?.symbol]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  for (const s of symCandidates) {
    const hits = _findSymbolHits(graph, s, {});
    const usable = hits.filter((h) => graph.nodes.get(h.rel));
    const pool = usable.length ? usable : hits;
    if (!pool.length) continue;
    const sorted = [...pool].sort((a, b) => String(a.rel).localeCompare(String(b.rel)));
    const primary = sorted.find((h) => h.declarationLike) || sorted[0];
    let note = `# note: dependents resolved from symbol '${s}' → ${primary.rel}`;
    const others = [...new Set(sorted.map((h) => h.rel))].filter((r) => r !== primary.rel);
    if (others.length) note += `\n# note: '${s}' also defined in: ${others.join(', ')}`;
    return { rel: primary.rel, norm: primary.rel, note };
  }
  const pathLike = symCandidates.find((s) => /[\\/]/.test(s) || KNOWN_SRC_EXT.test(s));
  if (pathLike) {
    const pAbs = isAbsolute(pathLike) ? pathResolve(pathLike) : pathResolve(cwd, pathLike);
    const pRel = _graphRel(pAbs, cwd);
    if (graph.nodes.get(pRel)) {
      return { rel: pRel, norm: pathLike, note: `# note: treated symbol '${pathLike}' as file` };
    }
  }
  // Nothing resolved → actionable hint naming the attempted values, with a
  // distinct message when no symbol was supplied at all.
  throw new Error(
    symCandidates.length
      ? `code_graph dependents: dependents needs file:<path>; got symbol only (tried: ${symCandidates.join(', ')})`
      : 'code_graph dependents: "file" is required (no file or symbol supplied)'
  );
}

// `dep:line` when the cached source shows the import line, else `dep`.
function importLineRef(graph, dep, basename, stem) {
  const depNode = graph.nodes.get(dep);
  if (!depNode) return dep;
  const cached = graph._sourceTextCache?.get(depNode.rel);
  if (!cached || cached.fingerprint !== (depNode.fingerprint || '')) return dep;
  const linesArr = cached.text.split(/\r?\n/);
  for (let i = 0; i < linesArr.length; i++) {
    const ln = linesArr[i];
    if (!/(?:^|\W)(?:import|require)\b|\bfrom\s*['"]/.test(ln)) continue;
    if (
      ln.includes(`/${basename}`) ||
      ln.includes(`/${stem}`) ||
      ln.includes(`'${basename}'`) ||
      ln.includes(`"${basename}"`)
    ) {
      return `${dep}:${i + 1}`;
    }
  }
  return dep;
}

export async function dependents(ctx) {
  const { args, cwd, signal, graph, rel, normFile } = ctx;
  const anchor = rel || normFile ? { rel, norm: normFile, note: null } : inferAnchor(args, cwd, graph);
  const depFileNode = anchor.rel ? graph.nodes.get(anchor.rel) : null;
  if (!depFileNode) return fileNotFound('dependents', { normFile: anchor.norm, graph });
  const depsAll = [...(graph.reverse.get(anchor.rel) || [])].sort();
  if (!depsAll.length) return '(no dependents)';
  const deps = depsAll.slice(0, GRAPH_LIST_CAP);
  await _prewarmSourceTextNodes(graph, deps.map((dep) => graph.nodes.get(dep)).filter(Boolean), { signal });
  const basename = anchor.rel.split('/').pop();
  const stem = basename.replace(/\.[^/.]+$/, '');
  const body = deps.map((dep) => importLineRef(graph, dep, basename, stem)).join('\n');
  const out = anchor.note ? `${anchor.note}\n${body}` : body;
  return depsAll.length > deps.length
    ? `${out}\n[truncated — showing first ${GRAPH_LIST_CAP} of ${depsAll.length} dependents]`
    : out;
}
