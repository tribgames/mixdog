// Shared helpers for the engine runners. Every runner exports
// `{ id, check({files,cwd,bin,args}), fix(...) }` returning
// `{ diagnostics, changedFiles, stderrTail }`, and keeps its output parsing in a
// pure exported function so the tests can drive it from fixture strings without
// the real engine installed.
import { isAbsolute, relative } from 'node:path';
import { runProcess } from '../process.mjs';

export const DEFAULT_ENGINE_TIMEOUT_MS = 120_000;
// Command lines are bounded (~32k on Windows); chunk long file lists.
export const FILES_PER_SPAWN = 80;

/** Split `files` into argv-safe groups. An empty list is one empty chunk. */
export function chunkFiles(files = [], size = FILES_PER_SPAWN) {
  const width = Math.max(1, Number(size) || FILES_PER_SPAWN);
  if (!files.length) return [[]];
  const chunks = [];
  for (let index = 0; index < files.length; index += width) {
    chunks.push(files.slice(index, index + width));
  }
  return chunks;
}

// Engines colorize the paths they report (air underlines them, mago colors its
// diffs), so every path-matching parser strips SGR sequences first.
// eslint-disable-next-line no-control-regex -- SGR escapes are the point
const ANSI_SGR = /\u001B\[[0-9;]*m/g;

export function stripAnsi(text) {
  return String(text || '').replace(ANSI_SGR, '');
}

export function tail(text, max = 600) {
  const value = String(text || '').trim();
  return value.length > max ? `…${value.slice(-max)}` : value;
}

/** Repo-relative, forward-slash path for report output. */
export function toRel(cwd, filePath) {
  const value = String(filePath || '').trim();
  if (!value) return '';
  const rel = isAbsolute(value) ? relative(cwd, value) : value;
  return rel.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function diagnostic({
  file,
  line = 0,
  col = 0,
  code = '',
  message = '',
  severity = 'error',
  fixable = false,
  fixKind = '',
  codeFix,
}) {
  return {
    file,
    line: Number(line) || 0,
    col: Number(col) || 0,
    code: String(code || ''),
    message: String(message || '').trim(),
    severity,
    fixable: Boolean(fixable),
    ...(fixKind ? { fixKind } : {}),
    ...(codeFix === true || codeFix === false ? { codeFix } : {}),
  };
}

/** Line/column (1-based) of a byte offset inside `source`. */
export function positionAt(source, offset) {
  const text = String(source || '');
  const index = Math.max(0, Math.min(Number(offset) || 0, text.length));
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const col = index - (before.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

/** Run one engine over a file list, chunked, and merge the captured output. */
export async function runChunked({
  bin,
  baseArgs = [],
  files = [],
  cwd,
  timeoutMs = DEFAULT_ENGINE_TIMEOUT_MS,
  signal = null,
  env = process.env,
  input = null,
  withoutFiles = false,
  filesPerSpawn = FILES_PER_SPAWN,
  run = runProcess,
}) {
  const chunks = withoutFiles ? [[]] : chunkFiles(files, filesPerSpawn);
  const merged = { code: 0, stdout: '', stderr: '', timedOut: false, error: '', truncated: false, results: [] };
  for (const chunk of chunks) {
    const result = await run(bin, [...baseArgs, ...chunk], { cwd, timeoutMs, signal, env, input });
    merged.results.push(result);
    merged.stdout += result.stdout;
    merged.stderr += result.stderr;
    merged.timedOut = merged.timedOut || result.timedOut;
    merged.truncated = merged.truncated || Boolean(result.truncated);
    if (result.error && !merged.error) merged.error = result.error;
    if (result.code !== 0) merged.code = result.code;
  }
  return merged;
}

/** Engine could not start (missing binary, EACCES): one actionable diagnostic. */
export function spawnFailureResult(id, result) {
  return {
    diagnostics: [
      diagnostic({
        file: '',
        code: `${id}/spawn`,
        message: result.timedOut ? `${id} timed out` : `${id} could not run: ${result.error || `exit ${result.code}`}`,
        severity: 'error',
      }),
    ],
    changedFiles: [],
    stderrTail: tail(result.stderr),
  };
}

export function emptyResult(stderrTail = '') {
  return { diagnostics: [], changedFiles: [], stderrTail };
}

/** Unique, order-preserving file list. */
export function uniquePaths(paths) {
  return [...new Set((paths || []).filter(Boolean))];
}

/** Parse a "one unformatted path per line" listing (shfmt -l, prettier -l). */
export function parsePathList(stdout, cwd) {
  return uniquePaths(
    String(stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('['))
      .map((line) => toRel(cwd, line))
  );
}

/**
 * Paths named by a per-line pattern (rustfmt/stylua diff headers, "Would
 * reformat: <path>"). The first non-empty capture group of each matching line
 * is the path; `strip` removes SGR escapes first for engines that colorize.
 */
export function parsePatternPaths(output, { pattern, cwd, strip = false }) {
  return uniquePaths(
    (strip ? stripAnsi(output) : String(output || ''))
      .split('\n')
      .map((line) => line.trim().match(pattern)?.slice(1).find(Boolean))
      .filter(Boolean)
      .map((file) => toRel(cwd, file))
  );
}

/** One "would reformat" warning per file. */
export function reformatDiagnostics(changedFiles, id, code = id) {
  return changedFiles.map((file) =>
    diagnostic({
      file,
      code,
      message: `${id} would reformat this file`,
      severity: 'warning',
      fixable: true,
    })
  );
}

/** Check-mode result for a formatter whose output names the files it would rewrite. */
export function parseReformatReport(output, { pattern, cwd, id, code = id, strip = false }) {
  const changedFiles = parsePatternPaths(output, { pattern, cwd, strip });
  return { changedFiles, diagnostics: reformatDiagnostics(changedFiles, id, code) };
}

/**
 * Runner factory for format-only engines whose check mode lists the files they
 * would rewrite (shfmt -l, gofmt -l, gofumpt -l, prettier --list-different) and
 * whose fix mode writes in place.
 */
export function createListFormatterRunner({ id, listArgs, writeArgs, code = id }) {
  return {
    id,
    async check({ files, cwd, bin, args = [], timeoutMs, signal }) {
      const result = await runChunked({ bin, baseArgs: [...args, ...listArgs], files, cwd, timeoutMs, signal });
      if (result.error) return spawnFailureResult(id, result);
      const changedFiles = parsePathList(result.stdout, cwd);
      return {
        diagnostics: reformatDiagnostics(changedFiles, id, code),
        changedFiles,
        stderrTail: tail(result.stderr),
      };
    },
    async fix({ files, cwd, bin, args = [], timeoutMs, signal }) {
      const result = await runChunked({ bin, baseArgs: [...args, ...writeArgs], files, cwd, timeoutMs, signal });
      if (result.error) return spawnFailureResult(id, result);
      return { diagnostics: [], changedFiles: [], stderrTail: tail(result.stderr) };
    },
  };
}
