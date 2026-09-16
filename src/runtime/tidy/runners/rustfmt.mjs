// rustfmt — toolchain formatter. `--check` prints "Diff in <path> at line N:"
// blocks; the bare command rewrites the files.
import { diagnostic, runChunked, spawnFailureResult, tail, toRel, uniquePaths } from './shared.mjs';

const DIFF_HEADER = /^Diff in (.+?) at line (\d+):/;
const EDITION = ['--edition', '2021'];

/** Parse `rustfmt --check` output. */
export function parseRustfmtCheck(output, cwd) {
  const diagnostics = [];
  const files = [];
  for (const line of String(output || '').split('\n')) {
    const match = line.trim().match(DIFF_HEADER);
    if (!match) continue;
    const file = toRel(cwd, match[1]);
    files.push(file);
    diagnostics.push(diagnostic({
      file,
      line: match[2],
      code: 'rustfmt',
      message: 'rustfmt would reformat this block',
      severity: 'warning',
      fixable: true,
    }));
  }
  return { diagnostics, changedFiles: uniquePaths(files) };
}

export const runner = {
  id: 'rustfmt',
  async check({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args, ...EDITION, '--check'], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('rustfmt', result);
    const parsed = parseRustfmtCheck(result.stdout, cwd);
    return { ...parsed, stderrTail: parsed.changedFiles.length ? '' : tail(result.stderr) };
  },
  async fix({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args, ...EDITION], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('rustfmt', result);
    return { diagnostics: [], changedFiles: [], stderrTail: tail(result.stderr) };
  },
};

export default runner;
