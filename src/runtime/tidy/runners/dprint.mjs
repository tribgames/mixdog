// dprint — `check` prints a per-file diff block, `fmt` writes. dprint only
// touches what its own dprint.json selects, so resolution requires that config.
import { emptyResult, parseReformatReport, runChunked, spawnFailureResult, tail } from './shared.mjs';

const FILE_HEADER = /^(?:from\s+(.+?):|---\s*(.+?)\s*---)$/;

/** Parse `dprint check` output. */
export function parseDprintCheck(output, cwd) {
  return parseReformatReport(output, { pattern: FILE_HEADER, cwd, id: 'dprint' });
}

export const runner = {
  id: 'dprint',
  async check({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args, 'check'], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('dprint', result);
    const parsed = parseDprintCheck(`${result.stdout}\n${result.stderr}`, cwd);
    return { ...parsed, stderrTail: parsed.changedFiles.length ? '' : tail(result.stderr) };
  },
  async fix({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args, 'fmt'], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('dprint', result);
    return emptyResult(tail(result.stderr));
  },
};

export default runner;
