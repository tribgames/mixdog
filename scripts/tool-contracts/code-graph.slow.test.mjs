// code_graph dispatch behaviors: outlines, symbol lookups, and absorption.
import './_env.mjs';
import test from 'node:test';
import { root } from './_env.mjs';
import { assertOk } from './_helpers.mjs';
import { executeCodeGraphTool } from '../../src/runtime/agent/orchestrator/tools/code-graph.mjs';
import { validateBuiltinArgs } from '../../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';

test('code_graph guard absorbs stringified file arrays and outline filters', () => {
  // Absorb shape: code_graph file/files as a JSON-stringified array → parsed to
  // a real array before lookup (dispatched into files[]).
  const cgStringifiedFileArgs = { mode: 'symbols', file: JSON.stringify(['a.mjs', 'b.mjs']) };
  const cgStringifiedFileErr = validateBuiltinArgs('code_graph', cgStringifiedFileArgs);
  if (cgStringifiedFileErr || 'file' in cgStringifiedFileArgs
    || !Array.isArray(cgStringifiedFileArgs.files)
    || cgStringifiedFileArgs.files[0] !== 'a.mjs' || cgStringifiedFileArgs.files[1] !== 'b.mjs') {
    throw new Error(`code_graph guard must parse JSON-stringified file array: err=${cgStringifiedFileErr} args=${JSON.stringify(cgStringifiedFileArgs)}`);
  }
  const cgFilteredOutlineArgs = { mode: 'symbols', files: ['a.mjs'], symbols: ['guard'] };
  const cgFilteredOutlineErr = validateBuiltinArgs('code_graph', cgFilteredOutlineArgs);
  if (cgFilteredOutlineErr || cgFilteredOutlineArgs.mode !== 'symbols'
    || cgFilteredOutlineArgs.symbols?.[0] !== 'guard') {
    throw new Error(`code_graph guard must preserve symbols[] file-outline filters: err=${cgFilteredOutlineErr} args=${JSON.stringify(cgFilteredOutlineArgs)}`);
  }
  const codeGraphSymbolSearchErr = validateBuiltinArgs('code_graph', { mode: 'symbol_search', symbols: ['hook', 'deny'], limit: 5 });
  if (codeGraphSymbolSearchErr) {
    throw new Error(`code_graph guard must accept symbol_search with symbols[] batching: ${codeGraphSymbolSearchErr}`);
  }
});

test('code_graph outlines, symbol lookups, and reference ownership', async () => {
  const graphOut = await executeCodeGraphTool('code_graph', {
    mode: 'symbols',
    file: 'scripts/smoke.mjs',
  }, root);
  assertOk('code_graph', graphOut, /binding|spawnSync|symbol/i);
  const graphFilteredOut = await executeCodeGraphTool('code_graph', {
    mode: 'symbols',
    file: 'src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs',
    symbols: ['validateBuiltinArgs'],
  }, root);
  const graphFilteredLines = String(graphFilteredOut).split('\n').filter(Boolean);
  if (!graphFilteredLines.length
    || graphFilteredLines.some((line) => !/validateBuiltinArgs/i.test(line))) {
    throw new Error(`code_graph symbols[] file-outline filtering failed:\n${graphFilteredOut}`);
  }
  const graphNamePathOut = await executeCodeGraphTool('code_graph', {
    mode: 'find_symbol',
    file: 'src/runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs',
    symbol: 'AgentStallAbortError/constructor',
    body: false,
  }, root);
  if (!/path=AgentStallAbortError\/constructor/.test(String(graphNamePathOut))) {
    throw new Error(`code_graph find_symbol name-path lookup failed:\n${graphNamePathOut}`);
  }
  const graphHierarchyOut = await executeCodeGraphTool('code_graph', {
    mode: 'overview',
    file: 'src/runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs',
    depth: 1,
  }, root);
  if (!/outline:/.test(String(graphHierarchyOut))
    || !/\n  method constructor\b/.test(String(graphHierarchyOut))) {
    throw new Error(`code_graph hierarchical overview failed:\n${graphHierarchyOut}`);
  }
  const graphOwnedReferenceOut = await executeCodeGraphTool('code_graph', {
    mode: 'references',
    file: 'src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs',
    symbol: '_filterSymbolOutline',
    limit: 20,
  }, root);
  if (!/owner=codeGraph/.test(String(graphOwnedReferenceOut))) {
    throw new Error(`code_graph reference owner lookup failed:\n${graphOwnedReferenceOut}`);
  }
  if (!/^# declaration$/m.test(String(graphOwnedReferenceOut))
    || !/dispatch\.mjs:\d+/.test(String(graphOwnedReferenceOut))
    || (String(graphOwnedReferenceOut).match(/^# references$/gm) || []).length !== 1) {
    throw new Error(`code_graph reference declaration contract failed:\n${graphOwnedReferenceOut}`);
  }
  const graphStringSymbolOut = await executeCodeGraphTool('code_graph', {
    mode: 'symbols',
    symbols: 'executeBuiltinTool',
  }, root);
  assertOk('code_graph string symbols', graphStringSymbolOut, /executeBuiltinTool|symbol_search/i);
  const graphRootAnchorOut = await executeCodeGraphTool('code_graph', {
    mode: 'symbol_search',
    symbol: 'executeBuiltinTool',
    file: root,
  }, root);
  if (/file not found|outside cwd|arbitrary tree/i.test(String(graphRootAnchorOut))) {
    throw new Error(`code_graph redundant root anchor was not normalized:\n${graphRootAnchorOut}`);
  }

  const graphSymbolBatchOut = await executeCodeGraphTool('code_graph', {
    mode: 'symbol_search',
    symbols: ['executeBuiltinTool', 'validateBuiltinArgs'],
    limit: 2,
  }, root);
  if (!/# symbol_search executeBuiltinTool\b/.test(String(graphSymbolBatchOut)) || !/# symbol_search validateBuiltinArgs\b/.test(String(graphSymbolBatchOut))) {
    throw new Error(`code_graph symbol_search symbols[] batch execution failed:\n${graphSymbolBatchOut}`);
  }

  // Absorb shape (real dispatch): file as a JSON-stringified array batches per
  // file instead of hitting "file not found: [...]".
  const graphStringifiedFileOut = await executeCodeGraphTool('code_graph', {
    mode: 'symbols',
    file: JSON.stringify(['scripts/smoke.mjs']),
  }, root);
  if (/file not found/.test(String(graphStringifiedFileOut))
    || !/binding|spawnSync|symbol/i.test(String(graphStringifiedFileOut))) {
    throw new Error(`code_graph must parse JSON-stringified file array before lookup:\n${graphStringifiedFileOut}`);
  }

  const graphMissingFileOut = await executeCodeGraphTool('code_graph', {
    mode: 'symbols',
    file: 'src/runtime/loop.mjs',
  }, root);
  if (!/^Error: code_graph: file not found: src\/runtime\/loop\.mjs/.test(String(graphMissingFileOut))) {
    throw new Error(`code_graph missing-file fast path failed:\n${graphMissingFileOut}`);
  }

  const graphDotDirOut = await executeCodeGraphTool('code_graph', {
    mode: 'overview',
    file: '.',
  }, root);
  assertOk('code_graph dot directory anchor', graphDotDirOut, /files\s+\d+|edges\s+\d+/i);
});
