// dprint — `check` prints a per-file diff block, `fmt` writes. dprint only
// touches what its own dprint.json selects, so resolution requires that config.
import { diagnostic, runChunked, spawnFailureResult, tail, toRel, uniquePaths } from './shared.mjs';

const FILE_HEADER = /^(?:from\s+(.+?):|---\s*(.+?)\s*---)$/;

/** Parse `dprint check` output. */
export function parseDprintCheck(output, cwd) {
  const changedFiles = uniquePaths(
    String(output || '')
      .split('\n')
      .map((line) => {
        const match = line.trim().match(FILE_HEADER);
        return match ? match[1] || match[2] : '';
      })
      .filter(Boolean)
      .map((file) => toRel(cwd, file))
  );
  return {
    changedFiles,
    diagnostics: changedFiles.map((file) =>
      diagnostic({
        file,
        code: 'dprint',
        message: 'dprint would reformat this file',
        severity: 'warning',
        fixable: true,
      })
    ),
  };
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
    return { diagnostics: [], changedFiles: [], stderrTail: tail(result.stderr) };
  },
};

export default runner;
