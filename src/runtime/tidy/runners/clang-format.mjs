// clang-format — `--dry-run -Werror` reports violations on stderr with
// positions; `-i` formats in place.
import { diagnostic, runChunked, spawnFailureResult, tail, toRel, uniquePaths } from './shared.mjs';

const VIOLATION = /^(.*?):(\d+):(\d+):\s*(warning|error):\s*(.*)$/;

/** Parse `clang-format --dry-run -Werror` stderr. */
export function parseClangFormatDryRun(stderr, cwd) {
  const diagnostics = [];
  const changedFiles = [];
  for (const line of String(stderr || '').split('\n')) {
    const match = line.trim().match(VIOLATION);
    if (!match) continue;
    const file = toRel(cwd, match[1]);
    changedFiles.push(file);
    diagnostics.push(
      diagnostic({
        file,
        line: match[2],
        col: match[3],
        code: 'clang-format',
        message: match[5],
        severity: match[4] === 'error' ? 'error' : 'warning',
        fixable: true,
      })
    );
  }
  return { diagnostics, changedFiles: uniquePaths(changedFiles) };
}

export const runner = {
  id: 'clang-format',
  async check({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({
      bin,
      baseArgs: [...args, '--dry-run', '-Werror'],
      files,
      cwd,
      timeoutMs,
      signal,
    });
    if (result.error) return spawnFailureResult('clang-format', result);
    const parsed = parseClangFormatDryRun(result.stderr, cwd);
    return { ...parsed, stderrTail: parsed.diagnostics.length ? '' : tail(result.stderr) };
  },
  async fix({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args, '-i'], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('clang-format', result);
    return { diagnostics: [], changedFiles: [], stderrTail: tail(result.stderr) };
  },
};

export default runner;
