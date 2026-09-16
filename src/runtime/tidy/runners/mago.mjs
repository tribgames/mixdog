// mago — the PHP formatter + linter (carthage-software/mago 1.48).
//
// Upstream contract:
//   `mago format --dry-run <paths>`  prints "diff of '<file>':" + a unified diff
//                                    per file, writes nothing (src/commands/format.rs
//                                    → utils::apply_update). `--check` only sets the
//                                    exit code, so the dry run is what names files.
//   `mago format <paths>`            writes.
//   `mago lint --reporting-format json <paths>` emits {"issues":[ExpandedIssue]}
//                                    (crates/reporting/src/formatter/json.rs); each
//                                    issue has level/code/message, annotations with
//                                    span.file_id.name and a ZERO-BASED start.line
//                                    (crates/database/src/file.rs line_number), and
//                                    `edits` when an automatic fix exists.
//   `mago lint --fix <paths>`        applies the safe fixes.
import { diagnostic, runChunked, spawnFailureResult, stripAnsi, tail, toRel, uniquePaths } from './shared.mjs';

const DIFF_HEADER = /^diff of '(.+?)':\s*$/;
const JSON_FLAGS = ['--reporting-format', 'json', '--reporting-target', 'stdout'];

/**
 * Parse `mago format --dry-run` output. Headers can arrive colorized and on
 * either stream depending on `--reporting-target` and the color heuristics, so
 * callers pass stdout and stderr merged and the SGR escapes come off first.
 */
export function parseMagoFormatDryRun(output, cwd) {
  const changedFiles = uniquePaths(
    stripAnsi(output)
      .split('\n')
      .map((line) => line.trim().match(DIFF_HEADER)?.[1])
      .filter(Boolean)
      .map((file) => toRel(cwd, file))
  );
  return {
    changedFiles,
    diagnostics: changedFiles.map((file) =>
      diagnostic({
        file,
        code: 'mago/format',
        message: 'mago would reformat this file',
        severity: 'warning',
        fixable: true,
      })
    ),
  };
}

function severityOf(level) {
  const value = String(level || '').toLowerCase();
  if (value === 'error') return 'error';
  if (value === 'warning') return 'warning';
  return 'info';
}

/** Parse `mago lint --reporting-format json`. */
export function parseMagoLintJson(stdout, cwd) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  const issues = Array.isArray(payload?.issues) ? payload.issues : Array.isArray(payload) ? payload : [];
  return issues.map((issue) => {
    const annotation = Array.isArray(issue?.annotations) ? issue.annotations[0] : null;
    const span = annotation?.span;
    return diagnostic({
      file: toRel(cwd, span?.file_id?.name || span?.file_id?.path || ''),
      // mago reports zero-based lines; the report speaks 1-based everywhere.
      line: Number.isFinite(Number(span?.start?.line)) ? Number(span.start.line) + 1 : 0,
      col: 0,
      code: String(issue?.code || 'mago'),
      message: String(issue?.message || ''),
      severity: severityOf(issue?.level),
      fixable: Array.isArray(issue?.edits) && issue.edits.length > 0,
    });
  });
}

export const runner = {
  id: 'mago',
  async check({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const format = await runChunked({ bin, baseArgs: [...args, 'format', '--dry-run'], files, cwd, timeoutMs, signal });
    if (format.error) return spawnFailureResult('mago', format);
    const lint = await runChunked({ bin, baseArgs: [...args, 'lint', ...JSON_FLAGS], files, cwd, timeoutMs, signal });
    const parsed = parseMagoFormatDryRun(`${format.stdout}\n${format.stderr}`, cwd);
    return {
      diagnostics: [...parsed.diagnostics, ...parseMagoLintJson(lint.stdout, cwd)],
      changedFiles: parsed.changedFiles,
      stderrTail: tail(`${format.stderr}\n${lint.stderr}`),
    };
  },
  async fix({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const lint = await runChunked({
      bin,
      baseArgs: [...args, 'lint', '--fix', ...JSON_FLAGS],
      files,
      cwd,
      timeoutMs,
      signal,
    });
    if (lint.error) return spawnFailureResult('mago', lint);
    const format = await runChunked({ bin, baseArgs: [...args, 'format'], files, cwd, timeoutMs, signal });
    return { diagnostics: [], changedFiles: [], stderrTail: tail(`${lint.stderr}\n${format.stderr}`) };
  },
};

export default runner;
