// ESLint — project-local only, JSON formatter. `--fix` applies its own fixes.
import { diagnostic, runChunked, spawnFailureResult, tail, toRel, uniquePaths } from './shared.mjs';

/** Parse `eslint -f json`. */
export function parseEslintJson(stdout, cwd) {
  const text = String(stdout || '').trim();
  if (!text) return { diagnostics: [], changedFiles: [] };
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    return { diagnostics: [], changedFiles: [] };
  }
  if (!Array.isArray(rows)) return { diagnostics: [], changedFiles: [] };
  const diagnostics = [];
  const changedFiles = [];
  for (const row of rows) {
    const file = toRel(cwd, row?.filePath || '');
    if (Number(row?.fixableErrorCount || 0) + Number(row?.fixableWarningCount || 0) > 0) changedFiles.push(file);
    for (const message of Array.isArray(row?.messages) ? row.messages : []) {
      diagnostics.push(
        diagnostic({
          file,
          line: message?.line || 0,
          col: message?.column || 0,
          code: String(message?.ruleId || 'eslint'),
          message: String(message?.message || ''),
          severity: Number(message?.severity) === 2 ? 'error' : 'warning',
          fixable: Boolean(message?.fix),
        })
      );
    }
  }
  return { diagnostics, changedFiles: uniquePaths(changedFiles) };
}

export const runner = {
  id: 'eslint',
  async check({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args, '-f', 'json'], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('eslint', result);
    return { ...parseEslintJson(result.stdout, cwd), stderrTail: tail(result.stderr) };
  },
  async fix({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args, '--fix', '-f', 'json'], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('eslint', result);
    return { ...parseEslintJson(result.stdout, cwd), changedFiles: [], stderrTail: tail(result.stderr) };
  },
};

export default runner;
