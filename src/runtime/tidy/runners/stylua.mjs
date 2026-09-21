// StyLua — `--check` prints a diff per unformatted file; the bare command
// formats in place.
import { parseReformatReport, runChunked, spawnFailureResult, tail } from './shared.mjs';

const DIFF_HEADER = /^Diff in (.+?):?\s*$/;

/** Parse `stylua --check` output (diff headers name the files). */
export function parseStyluaCheck(output, cwd) {
  return parseReformatReport(output, { pattern: DIFF_HEADER, cwd, id: 'stylua' });
}

export const runner = {
  id: 'stylua',
  async check({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args, '--check'], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('stylua', result);
    const parsed = parseStyluaCheck(`${result.stdout}\n${result.stderr}`, cwd);
    return { ...parsed, stderrTail: parsed.changedFiles.length ? '' : tail(result.stderr) };
  },
  async fix({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('stylua', result);
    return { diagnostics: [], changedFiles: [], stderrTail: tail(result.stderr) };
  },
};

export default runner;
