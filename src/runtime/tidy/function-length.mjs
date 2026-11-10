// Function-length summary for a check/fix run: spans come from the code-graph
// engine's outline records (the rows `code_graph mode:"symbols"` prints as
// `kind name (Lstart-end)`), so the counts match what the graph reports.
import { extname } from 'node:path';

const FILE_BATCH = 200;
const FUNCTION_KINDS = new Set(['function', 'method', 'constructor']);
const LONGEST_COUNT = 5;

async function graphRunFiles(cwd, rels, signal) {
  const { _runGraphFiles } = await import('../agent/orchestrator/tools/code-graph/graph-binary.mjs');
  return _runGraphFiles(cwd, rels, [], signal);
}

const hasSpan = (symbol) => Number.isFinite(Number(symbol?.startLine)) && Number.isFinite(Number(symbol?.endLine));

/**
 * Count functions over 50/100/150 lines in `files` (project-relative). Files
 * whose language emits no spans are listed under `notMeasured`, never counted
 * as short.
 */
export async function summarizeFunctionLengths({ cwd, files = [], signal = null, runFiles = graphRunFiles }) {
  const functions = [];
  const spanned = new Set();
  const seen = new Map();
  try {
    for (let index = 0; index < files.length; index += FILE_BATCH) {
      const chunk = files.slice(index, index + FILE_BATCH);
      for (const record of await runFiles(cwd, chunk, signal)) {
        const rel = String(record.rel || '').replaceAll('\\', '/');
        const language = record.lang || extname(rel) || 'unknown';
        seen.set(rel, language);
        const symbols = Array.isArray(record.symbols) ? record.symbols : [];
        if (symbols.some(hasSpan)) spanned.add(language);
        for (const symbol of symbols) {
          if (!FUNCTION_KINDS.has(symbol.kind) || !hasSpan(symbol)) continue;
          functions.push({
            path: rel,
            name: String(symbol.name || ''),
            lines: Number(symbol.endLine) - Number(symbol.startLine) + 1,
          });
        }
      }
    }
  } catch (error) {
    return { measured: false, note: `function lengths not measured: ${error?.message || error}` };
  }
  for (const file of files) {
    const rel = String(file).replaceAll('\\', '/');
    if (!seen.has(rel)) seen.set(rel, extname(rel) || 'unknown');
  }
  const notMeasured = [...new Set(seen.values())].filter((language) => !spanned.has(language)).sort();
  const over = (limit) => functions.filter((fn) => fn.lines > limit).length;
  return {
    measured: true,
    functions: functions.length,
    over50: over(50),
    over100: over(100),
    over150: over(150),
    longest: functions.sort((a, b) => b.lines - a.lines).slice(0, LONGEST_COUNT),
    ...(notMeasured.length ? { notMeasured } : {}),
  };
}
