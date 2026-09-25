// air — the R formatter (posit-dev/air 0.11).
//
// Upstream contract (crates/air/src/args.rs + commands/format/paths.rs):
//   `air format --check <paths>`  writes nothing, prints "Would reformat: <path>"
//                                 per changed file on stderr (path underlined
//                                 with ANSI when colored), exits non-zero.
//   `air format <paths>`          formats in place.
import { emptyResult, parseReformatReport, runChunked, spawnFailureResult, tail } from './shared.mjs';

const WOULD_REFORMAT = /^Would reformat:\s*(.+?)\s*$/;

/** Parse `air format --check` stderr. */
export function parseAirCheck(stderr, cwd) {
  return parseReformatReport(stderr, { pattern: WOULD_REFORMAT, cwd, id: 'air', strip: true });
}

export const runner = {
  id: 'air',
  async check({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args, 'format', '--check'], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('air', result);
    const parsed = parseAirCheck(result.stderr, cwd);
    return { ...parsed, stderrTail: parsed.changedFiles.length ? '' : tail(result.stderr) };
  },
  async fix({ files, cwd, bin, args = [], timeoutMs, signal }) {
    const result = await runChunked({ bin, baseArgs: [...args, 'format'], files, cwd, timeoutMs, signal });
    if (result.error) return spawnFailureResult('air', result);
    return emptyResult(tail(result.stderr));
  },
};

export default runner;
