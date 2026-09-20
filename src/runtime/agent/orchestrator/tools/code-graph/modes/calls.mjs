/**
 * code-graph/modes/calls.mjs — the call-site modes: callees of a declaration,
 * references to a symbol (declaration + usages) and callers (direct or
 * transitive). references and callers share the scoped-symbol prelude.
 */
import {
  _findSymbolHits,
  _findSymbolAcrossGraph,
  _extractCallees,
  _formatCalleeRow,
  _resolveReferenceLanguageNode,
  _prewarmSourceTextNodes,
  _prewarmReferenceSourceText,
  _cheapReferenceSearch,
  _formatReferenceDetails,
  _formatCallerReferences,
  _formatTransitiveCallers,
  _astCallerTargetRels,
  _augmentNoHitDiagnostic,
} from '../search.mjs';
import { _graphHasAstCalls } from '../ast-calls.mjs';
import { callsCapabilityHint } from '../graph-binary.mjs';
import { fileNotFound, languageArg, requiredSymbol, userLimitArg } from './shared.mjs';

export async function callees(ctx) {
  const { args, cwd, signal, graph, rel, node } = ctx;
  const symbol = requiredSymbol('callees', args);
  const explicitLanguage = languageArg(args);
  if (rel && !node) return fileNotFound('callees', ctx);
  const allHits = _findSymbolHits(graph, symbol, { language: explicitLanguage });
  const hits = rel ? allHits.filter((h) => h.rel === rel) : allHits;
  const declHit = hits.find((h) => h.declarationLike) || hits[0];
  if (!declHit) {
    const scopeNote = rel ? ` file=${rel}` : '';
    return `(no symbol matches in cwd=${cwd}${scopeNote})`;
  }
  // Language-agnostic: whatever the binary extracted answers, and a file it
  // did not extract simply has no callees to report.
  const declNode = graph.nodes.get(declHit.rel) || null;
  await _prewarmSourceTextNodes(graph, [declNode].filter(Boolean), { signal });
  const rows = _extractCallees(graph, declHit, cwd, {
    cap: 200,
    callerSymbol: symbol,
    language: explicitLanguage,
  });
  if (!rows.length) return `(no callees)`;
  const out = ['# callees'];
  for (const row of rows) out.push(_formatCalleeRow(row));
  return out.join('\n');
}

// The symbol, language and limit a scoped call query runs with, or the error
// answer when the file anchor does not resolve.
async function scopedCallContext(mode, ctx) {
  const { args, cwd, signal, graph, normFile, rel, node, scopeRelPrefix } = ctx;
  const symbol = requiredSymbol(mode, args);
  const explicitLanguage = languageArg(args);
  const narrowedByCaller = Boolean(rel || scopeRelPrefix || explicitLanguage);
  if (node) await _prewarmSourceTextNodes(graph, [node], { signal });
  const resolved = _resolveReferenceLanguageNode(graph, symbol, rel, cwd, explicitLanguage);
  if (rel && resolved.kind === 'file-not-found') return { error: fileNotFound(mode, ctx) };
  if (rel && resolved.kind === 'symbol-not-present') {
    return { error: `Error: code_graph ${mode}: symbol "${symbol}" not found in ${normFile || rel}` };
  }
  const resolvedNode = resolved.kind === 'ok' ? resolved.node : null;
  const lang = explicitLanguage || (narrowedByCaller && resolvedNode ? resolvedNode.lang : null);
  return { symbol, lang, narrowedByCaller, userLimit: userLimitArg(args) };
}

export async function references(ctx) {
  const { args, cwd, signal, graph, rel, scopeRelPrefix } = ctx;
  requiredSymbol('references', args);
  const explicitLanguage = languageArg(args);
  if (explicitLanguage) {
    const langHasFiles = [...graph.nodes.values()].some((n) => n.lang === explicitLanguage);
    if (!langHasFiles) {
      throw new Error(
        `code_graph references: language '${explicitLanguage}' has no adapter topLevelTypes and is not in supportedRegexLangs for this project`
      );
    }
  }
  const scoped = await scopedCallContext('references', ctx);
  if (scoped.error) return scoped.error;
  const { symbol, lang, narrowedByCaller, userLimit } = scoped;
  const refNodes = await _prewarmReferenceSourceText(graph, symbol, lang, { signal });
  const refResult = _cheapReferenceSearch(graph, symbol, cwd, {
    language: lang,
    fileRel: rel,
    scopeRelPrefix,
    nodes: refNodes,
  });
  const detailedReferences = _formatReferenceDetails(
    graph,
    symbol,
    refResult,
    userLimit ? { limit: userLimit } : undefined
  );
  const referenceList = narrowedByCaller
    ? detailedReferences
    : _augmentNoHitDiagnostic(detailedReferences, '(no references)', graph, cwd, symbol);
  const declaration = _findSymbolAcrossGraph(graph, symbol, cwd, {
    language: lang,
    limit: 1,
    fileRel: rel,
    body: args?.body === true,
  });
  // Call-shaped rows are AST-only. On a graph with NO call data at all the
  // list silently loses every call site — for a symbol used only through
  // calls that renders as "(no references)", which reads like a verdict.
  // callers/callees throw here; references still has identifier usages to
  // report, so it says what is missing instead.
  const callsNote = _graphHasAstCalls(graph)
    ? ''
    : `\n\nnote: call sites are missing from this list — ${callsCapabilityHint()}`;
  return `# declaration\n${declaration}\n\n# references\n${referenceList}${callsNote}`;
}

export async function callers(ctx) {
  const { args, cwd, signal, graph, rel, scopeRelPrefix } = ctx;
  // No regex-language gate here: call sites come from the extractor, so an
  // unknown `language` simply selects no files.
  const scoped = await scopedCallContext('callers', ctx);
  if (scoped.error) return scoped.error;
  const { symbol, lang, narrowedByCaller, userLimit } = scoped;
  // Rendered call rows quote their source line; prewarm the candidate files
  // so those reads are async and batched instead of sync per row.
  await _prewarmReferenceSourceText(graph, symbol, lang, { signal });
  const depth = Math.max(1, Math.min(5, Math.floor(Number(args?.depth) || 1)));
  if (depth > 1) {
    // Scope and limit are honoured at every level: a file/directory anchor
    // and an explicit limit used to be dropped for depth>1.
    return _formatTransitiveCallers(graph, symbol, cwd, {
      language: lang,
      depth,
      page: args?.page,
      fileRel: rel,
      scopeRelPrefix,
      ...(userLimit ? { pageSize: userLimit } : {}),
    });
  }
  // The DECLARING files anchor the caller rule (same file or an importer);
  // a `file`/directory anchor scopes the scan AND narrows those
  // declarations to the one the caller pointed at.
  const callerResult = _formatCallerReferences(graph, symbol, {
    ...(userLimit ? { limit: userLimit } : {}),
    targetRels: _astCallerTargetRels(graph, symbol, lang, { fileRel: rel, scopeRelPrefix }),
    language: lang,
    fileRel: rel,
    scopeRelPrefix,
  });
  return narrowedByCaller ? callerResult : _augmentNoHitDiagnostic(callerResult, '(no callers)', graph, cwd, symbol);
}
