// callers[] / references[] prefetch through code_graph, one lookup per symbol.
import { classifyResultKind } from '../../result-classification.mjs';
import { _executeCodeGraphToolLazy } from '../runtime-loaders.mjs';
import { runAbortable } from '../../../../../shared/abort-race.mjs';

export function symbolEntries(list) {
  return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.symbol === 'string') : [];
}

export async function prefetchSymbols(session, mode, entries, signal) {
  const tasks = entries.map(({ symbol, file }) => {
    const cgArgs = { mode, symbol };
    if (file) cgArgs.file = file;
    if (session?.cwd) cgArgs.cwd = session.cwd;
    return _executeCodeGraphToolLazy('code_graph', cgArgs, session?.cwd)
      .then((out) => ({ symbol, out }))
      .catch((e) => {
        process.stderr.write(`[agent-prefetch] ${mode}(${symbol}) failed: ${e?.message || e}\n`);
        return { symbol, out: null };
      });
  });
  const results = await runAbortable(signal, () => Promise.allSettled(tasks));
  const parts = [];
  const failed = [];
  for (const r of results) {
    const { symbol, out } = r.status === 'fulfilled' ? r.value : { symbol: '?', out: null };
    if (out && classifyResultKind(String(out)) !== 'error') parts.push(`### prefetch ${mode} ${symbol}\n${out}`);
    else failed.push(symbol);
  }
  return { parts, failed };
}
