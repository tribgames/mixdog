// rustfmt — toolchain formatter. `--check` prints one "Diff in …" header per
// block; the bare command rewrites the files.
//
// rustfmt 1.8 and older: `Diff in <path> at line N:`
// rustfmt 1.9+:          `Diff in <path>:N:`  (Windows may prefix `\\?\`)
import { diagnostic, runChunked, spawnFailureResult, tail, toRel, uniquePaths } from './shared.mjs';

const DIFF_AT_LINE = /^Diff in (.+?) at line (\d+):/;
const DIFF_COLON_LINE = /^Diff in (.+):(\d+):$/;
const EDITION = ['--edition', '2021'];

function rustfmtRel(cwd, raw) {
  let value = String(raw || '');
  if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice(8)}`;
  else if (value.startsWith('\\\\?\\')) value = value.slice(4);
  return toRel(cwd, value);
}

function parseDiffHeader(line) {
  // Unified-diff context lines start with a space; trim() would turn
  // ` Diff in src/other.rs:99:` into a fake header. Only drop the CR.
  const trimmed = String(line || '').trimEnd();
  const legacy = trimmed.match(DIFF_AT_LINE);
  if (legacy) return { file: legacy[1], line: legacy[2] };
  const modern = trimmed.match(DIFF_COLON_LINE);
  if (modern) return { file: modern[1], line: modern[2] };
  return null;
}

/** Parse `rustfmt --check` output. */
export function parseRustfmtCheck(output, cwd) {
  const diagnostics = [];
  const files = [];
  for (const line of String(output || '').split('\n')) {
    const match = parseDiffHeader(line);
    if (!match) continue;
    const file = rustfmtRel(cwd, match.file);
    files.push(file);
    diagnostics.push(diagnostic({
      file,
      line: match.line,
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
    if (parsed.changedFiles.length === 0 && result.stderr) {
      const fromErr = parseRustfmtCheck(result.stderr, cwd);
      if (fromErr.changedFiles.length) return { ...fromErr, stderrTail: '' };
    }
    return { ...parsed, stderrTail: parsed.changedFiles.length ? '' : tail(result.stderr) };
  },
  async fix({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args, ...EDITION], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('rustfmt', result);
    return { diagnostics: [], changedFiles: [], stderrTail: tail(result.stderr) };
  },
};

export default runner;
