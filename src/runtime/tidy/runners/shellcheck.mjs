// ShellCheck — JSON reporter. Lint-only: `fix` re-runs the same read-only
// analysis (shellcheck never writes), so structural rules stay the fixer.
import { diagnostic, levelSeverity as severityOf, runChunked, spawnFailureResult, tail, toRel } from './shared.mjs';

/** Parse `shellcheck -f json`. */
export function parseShellcheckJson(stdout, cwd) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((row) =>
    diagnostic({
      file: toRel(cwd, row?.file || ''),
      line: row?.line || 0,
      col: row?.column || 0,
      code: row?.code ? `SC${row.code}` : 'shellcheck',
      message: String(row?.message || ''),
      severity: severityOf(row?.level),
      fixable: Boolean(row?.fix),
    })
  );
}

async function analyze({ files, cwd, bin, args = [], timeoutMs, signal }) {
  const result = await runChunked({ bin, baseArgs: [...args, '-f', 'json'], files, cwd, timeoutMs, signal });
  if (result.error) return spawnFailureResult('shellcheck', result);
  return {
    diagnostics: parseShellcheckJson(result.stdout, cwd),
    changedFiles: [],
    stderrTail: tail(result.stderr),
  };
}

export const runner = {
  id: 'shellcheck',
  check: analyze,
  fix: analyze,
};

export default runner;
