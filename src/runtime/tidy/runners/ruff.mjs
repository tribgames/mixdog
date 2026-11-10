// Ruff — `check --output-format json` for lint, `format --check` for the
// would-reformat list; fix runs both write modes.
import { diagnostic, emptyResult, parsePatternPaths, runChunked, spawnFailureResult, tail, toRel } from './shared.mjs';

/** Parse `ruff check --output-format json`. */
export function parseRuffJson(stdout, cwd) {
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
      file: toRel(cwd, row?.filename || ''),
      line: row?.location?.row || 0,
      col: row?.location?.column || 0,
      code: String(row?.code || 'ruff'),
      message: String(row?.message || ''),
      severity: 'error',
      fixable: Boolean(row?.fix),
    })
  );
}

/** Parse `ruff format --check` ("Would reformat: path"). */
export function parseRuffFormatCheck(stdout, cwd) {
  return parsePatternPaths(stdout, { pattern: /^Would reformat:\s*(.+?)\s*$/, cwd });
}

export const runner = {
  id: 'ruff',
  async check({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const lint = await runChunked({
      bin,
      baseArgs: [...args, 'check', '--output-format', 'json', '--no-fix'],
      files,
      cwd,
      timeoutMs,
      signal,
    });
    if (lint.error) return spawnFailureResult('ruff', lint);
    const format = await runChunked({ bin, baseArgs: [...args, 'format', '--check'], files, cwd, timeoutMs, signal });
    const changedFiles = parseRuffFormatCheck(format.stdout, cwd);
    return {
      diagnostics: parseRuffJson(lint.stdout, cwd),
      changedFiles,
      stderrTail: tail(`${lint.stderr}\n${format.stderr}`),
    };
  },
  async fix({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const lint = await runChunked({ bin, baseArgs: [...args, 'check', '--fix'], files, cwd, timeoutMs, signal });
    if (lint.error) return spawnFailureResult('ruff', lint);
    const format = await runChunked({ bin, baseArgs: [...args, 'format'], files, cwd, timeoutMs, signal });
    return emptyResult(tail(`${lint.stderr}\n${format.stderr}`));
  },
};

export default runner;
