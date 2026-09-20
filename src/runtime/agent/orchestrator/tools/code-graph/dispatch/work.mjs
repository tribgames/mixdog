/**
 * work.mjs — the code_graph call itself once its root is settled: the mode
 * router with symbols[] / files[] batch fan-out.
 */
import { _stripEmptyArgs } from '../project-root.mjs';
import { _collectGraphFileList } from '../aggregate-roots.mjs';
import { collectGraphSymbolList } from '../modes/shared.mjs';

const CODE_GRAPH_BATCHABLE_MODES = new Set([
  'symbol',
  'find_symbol',
  'symbol_search',
  'callers',
  'callees',
  'references',
]);
const CODE_GRAPH_FILE_BATCHABLE_MODES = new Set(['imports', 'dependents', 'related', 'impact', 'symbols', 'overview']);
const CODE_GRAPH_BATCH_CONCURRENCY = 20;
const DECLARATION_MODES = new Set(['symbol', 'find_symbol']);

async function _mapWithConcurrency(values, mapper) {
  const out = new Array(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CODE_GRAPH_BATCH_CONCURRENCY, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        out[index] = await mapper(values[index], index);
      }
    })
  );
  return out;
}

/** `run` over every item with bounded concurrency; each answer is a `# header` section, a failure inline. */
async function _fanoutSections(items, header, run) {
  const sections = await _mapWithConcurrency(items, async (item) => {
    let body;
    try {
      body = await run(item);
    } catch (e) {
      body = `Error: ${e?.message || String(e)}`;
    }
    return `# ${header(item)}\n${body}`;
  });
  return sections.join('\n\n');
}

/**
 * `body:true` asks for declaration bodies, which the outline-only symbols
 * mode cannot supply — it was silently ignored and models fell back to large
 * reads. Honor it via find_symbol, which batches symbols[] and respects the
 * file scope.
 */
function promoteSymbolsWithBody(args) {
  if (String(args?.mode || '').trim() === 'symbols' && args?.body === true && collectGraphSymbolList(args).length) {
    return { ...args, mode: 'find_symbol' };
  }
  return args;
}

/**
 * `files` is documented as an optional SCOPE for the symbol modes, but only
 * the file-mode branch normalized it — so find_symbol / symbol_search /
 * references / callers / callees silently answered for the whole repository.
 * Apply the scope here: a single entry becomes the `file` anchor, several
 * entries fan out per file.
 */
function scopedDispatch(dispatchRaw, args, batchMode) {
  const symbolScopeFiles =
    CODE_GRAPH_BATCHABLE_MODES.has(batchMode) && !(typeof args?.file === 'string' && args.file.trim())
      ? _collectGraphFileList(args)
      : [];
  if (symbolScopeFiles.length === 1) {
    return (a) => dispatchRaw({ ...a, file: symbolScopeFiles[0], files: undefined });
  }
  if (symbolScopeFiles.length > 1) {
    return (a) =>
      _fanoutSections(
        symbolScopeFiles,
        (f) => `file ${f}`,
        (f) => dispatchRaw({ ...a, file: f, files: undefined })
      );
  }
  return dispatchRaw;
}

export function runCodeGraphWork(name, rawArgs, effectiveCwd, signal, options, { findSymbolTool, codeGraph }) {
  if (name !== 'code_graph') throw new Error(`Unknown code-graph tool: ${name}`);
  const args = promoteSymbolsWithBody(rawArgs);
  const rawMode = String(args?.mode || '').trim();
  const batchMode = rawMode === 'search' ? 'symbol_search' : rawMode;
  const dispatchRaw = (a) =>
    DECLARATION_MODES.has(rawMode)
      ? findSymbolTool(_stripEmptyArgs(a), effectiveCwd, signal, options)
      : codeGraph(a, effectiveCwd, signal, options);
  const dispatchOne = scopedDispatch(dispatchRaw, args, batchMode);
  if (CODE_GRAPH_BATCHABLE_MODES.has(batchMode)) {
    const symbolList = collectGraphSymbolList(args);
    if (symbolList.length > 1) {
      return _fanoutSections(
        symbolList,
        (sym) => `${batchMode} ${sym}`,
        (sym) => dispatchOne({ ...args, symbol: sym, symbols: undefined })
      );
    }
    if (symbolList.length === 1 && args?.symbol !== symbolList[0]) {
      return dispatchOne({ ...args, symbol: symbolList[0], symbols: undefined });
    }
  }
  if (CODE_GRAPH_FILE_BATCHABLE_MODES.has(batchMode)) {
    const fileList = _collectGraphFileList(args);
    if (fileList.length > 1) {
      return _fanoutSections(
        fileList,
        (f) => `${batchMode} ${f}`,
        (f) => dispatchOne({ ...args, file: f, files: undefined })
      );
    }
    if (fileList.length === 1 && args?.file !== fileList[0]) {
      return dispatchOne({ ...args, file: fileList[0], files: undefined });
    }
  }
  return dispatchOne(args);
}
