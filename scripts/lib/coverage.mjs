// V8 coverage, folded into the one artifact that answers a single question:
// does the suite actually execute this function? Grepping test files for a
// symbol answers it wrongly whenever a helper is reached only through a public
// entry point, so the evidence comes from Node itself — NODE_V8_COVERAGE makes
// every test process dump raw V8 coverage JSON at exit, and this module folds
// those dumps (one per batch, one per test child) into per-function lines.
//
// No dependency is involved: V8 emits the raw data, `node:fs` reads it back.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARTIFACT_PATH = '.runtime/coverage/coverage.json';

// The runner's own lane patterns: *.test.mjs and *-test.mjs (plus the jsx/ts
// spellings used by apps/desktop). A test executing itself proves nothing.
const TEST_FILE = /[.-]test\.[cm]?[jt]sx?$/;
// tsx transpiles TypeScript before V8 sees it, so the offsets V8 reports for a
// .ts file describe the transpiled output instead of the file on disk.
const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;

export const EXCLUSION_REASONS = {
  'transpiled-by-tsx':
    'TypeScript executed through tsx: V8 offsets describe the transpiled output, not this file, and this round does not translate them through source maps',
  'offsets-beyond-source':
    'recorded offsets run past the file on disk, so the executed source was generated or transformed rather than read from here',
  'source-unreadable': 'the file could not be read back while folding coverage',
};

// The identity a later query uses to tell whether the file still is what was
// measured. Content, not mtime or size: a checkout, a formatter rewriting a
// file byte-identically or a restored backup all move mtime without changing a
// single line, and an edit that swaps two lines keeps the size — either way the
// recorded line ranges would be wrong or wrongly distrusted. Folding already
// reads every source in full to translate offsets, so hashing it costs nothing
// and answers exactly. (A file absent from the artifact has no recorded
// content to compare, so its mtime against the collection time is the only
// evidence there is; `queryCoverage` uses that for the unknown-file case.)
export function sourceDigest(source) {
  return createHash('sha256').update(source).digest('hex');
}

// Sources are normalized the same way at folding and at query time, so the
// digest compares like with like.
async function currentSource(rootPath, path) {
  try {
    return (await readFile(join(rootPath, path), 'utf8')).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

async function modifiedAfter(rootPath, path, generatedAt) {
  const collected = Date.parse(generatedAt ?? '');
  if (Number.isNaN(collected)) return false;
  try {
    return (await stat(join(rootPath, path))).mtimeMs > collected;
  } catch {
    return false;
  }
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

// 1-based line holding a 0-based character offset.
function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

// V8 keeps the script's own top-level range as a nameless function spanning the
// whole source. It is the module body, not a function anyone can call, so it
// becomes the file's `loaded` flag instead of an entry every line sits inside.
const isModuleBody = (entry, length) => entry.name === '' && entry.startOffset === 0 && entry.endOffset >= length;

function repoRelative(url, rootPath) {
  if (!url.startsWith('file:')) return '';
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  const absolute = fileURLToPath(parsed);
  const path = relative(rootPath, absolute).replaceAll('\\', '/');
  if (path === '' || path.startsWith('../') || isAbsolute(path)) return '';
  return path;
}

// Raw V8 dumps -> { path -> [{ name, startOffset, endOffset, executed }] }.
// Every dump contributes: a function executed in any batch is executed.
function collectFunctions(reports, rootPath, excluded) {
  const byFile = new Map();
  for (const report of reports) {
    for (const script of report?.result ?? []) {
      const path = repoRelative(script.url ?? '', rootPath);
      if (path === '' || path.split('/').includes('node_modules') || TEST_FILE.test(path)) continue;
      if (TYPESCRIPT_FILE.test(path)) {
        excluded.set(path, 'transpiled-by-tsx');
        continue;
      }
      const functions = byFile.get(path) ?? new Map();
      byFile.set(path, functions);
      for (const entry of script.functions ?? []) {
        const range = entry.ranges?.[0];
        if (!range) continue;
        const key = `${entry.functionName}\u0000${range.startOffset}\u0000${range.endOffset}`;
        const merged = functions.get(key);
        if (merged) merged.executed ||= range.count > 0;
        else
          functions.set(key, {
            name: entry.functionName,
            startOffset: range.startOffset,
            endOffset: range.endOffset,
            executed: range.count > 0,
          });
      }
    }
  }
  return byFile;
}

// The artifact: per repository source file, every function V8 covered, with
// offsets translated to 1-based lines and the single bit that matters.
export async function foldCoverage(reports, { root = process.cwd() } = {}) {
  const rootPath = resolve(root);
  const excluded = new Map();
  const collected = collectFunctions(reports, rootPath, excluded);
  const files = {};
  for (const path of [...collected.keys()].sort()) {
    const entries = [...collected.get(path).values()].sort(
      (left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset
    );
    let source;
    try {
      source = (await readFile(join(rootPath, path), 'utf8')).replace(/^\uFEFF/, '');
    } catch {
      excluded.set(path, 'source-unreadable');
      continue;
    }
    if (entries.some((entry) => entry.endOffset > source.length)) {
      excluded.set(path, 'offsets-beyond-source');
      continue;
    }
    const starts = lineStarts(source);
    const body = entries.find((entry) => isModuleBody(entry, source.length));
    files[path] = {
      loaded: body ? body.executed : entries.some((entry) => entry.executed),
      sha256: sourceDigest(source),
      functions: entries
        .filter((entry) => entry !== body)
        .map((entry) => ({
          name: entry.name || '(anonymous)',
          startLine: lineOf(starts, entry.startOffset),
          endLine: lineOf(starts, Math.max(entry.startOffset, entry.endOffset - 1)),
          executed: entry.executed,
        })),
    };
  }
  const covered = Object.values(files);
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    root: rootPath.replaceAll('\\', '/'),
    summary: {
      filesWithExecutedFunctions: covered.filter((file) => file.functions.some((fn) => fn.executed)).length,
      filesWithoutExecutedFunctions: covered.filter((file) => !file.functions.some((fn) => fn.executed)).length,
      excludedFiles: excluded.size,
    },
    files,
    exclusionReasons: EXCLUSION_REASONS,
    excluded: [...excluded.keys()].sort().map((path) => ({ path, reason: excluded.get(path) })),
  };
}

export async function readRawCoverage(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const reports = [];
  for (const name of names) reports.push(JSON.parse(await readFile(join(directory, name), 'utf8')));
  return reports;
}

export async function writeCoverageArtifact(artifact, { root = process.cwd(), artifactPath = ARTIFACT_PATH } = {}) {
  const target = resolve(root, artifactPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`);
  return target;
}

export async function loadCoverageArtifact({ root = process.cwd(), artifactPath = ARTIFACT_PATH } = {}) {
  return JSON.parse(await readFile(resolve(root, artifactPath), 'utf8'));
}

// Is this line inside a function the suite executed? The innermost enclosing
// function answers; a line the file's functions do not cover is reported as
// such rather than borrowed from the module body around it.
//
// A recorded answer is only worth giving while the file still is the file that
// was measured, so every query re-reads the source and compares its digest
// first: a changed file answers `stale`, never EXECUTED or NOT EXECUTED. An
// artifact predating this check has no digest to match, which is itself a
// mismatch, so it announces itself too.
export async function queryCoverage(artifact, file, line, { root = process.cwd() } = {}) {
  const rootPath = resolve(root);
  const path = String(file).replaceAll('\\', '/').replace(/^\.\//, '');
  const generatedAt = artifact.generatedAt;
  const entry = artifact.files?.[path];
  const excluded = artifact.excluded?.find((item) => item.path === path);
  if (!entry) {
    if (excluded) return { path, line, status: 'excluded', reason: excluded.reason, generatedAt };
    // Nothing was recorded for this file, so there is no content to compare
    // against; a file touched after the collection is the case where a test
    // was added since, which is exactly how this answer misled a reader.
    const changed = await modifiedAfter(rootPath, path, generatedAt);
    return { path, line, status: 'unknown-file', generatedAt, changedSinceCollection: changed };
  }
  const source = await currentSource(rootPath, path);
  if (source === null) return { path, line, status: 'stale', change: 'missing', generatedAt };
  if (sourceDigest(source) !== entry.sha256) return { path, line, status: 'stale', change: 'modified', generatedAt };
  const inside = entry.functions.filter((fn) => line >= fn.startLine && line <= fn.endLine);
  const innermost = inside.reduce(
    (best, fn) => (best === null || fn.endLine - fn.startLine <= best.endLine - best.startLine ? fn : best),
    null
  );
  if (!innermost) return { path, line, status: 'outside-functions', loaded: entry.loaded, generatedAt };
  return {
    path,
    line,
    status: innermost.executed ? 'executed' : 'not-executed',
    loaded: entry.loaded,
    generatedAt,
    function: innermost,
  };
}

// Every answer a reader must not act on says what to do instead.
const RECOLLECT = 're-run `node scripts/test.mjs --coverage`';

export function formatCoverageAnswer(result) {
  const at = `${result.path}:${result.line}`;
  const collected = result.generatedAt ? `collected ${result.generatedAt}` : 'collected at an unrecorded time';
  if (result.status === 'stale')
    return result.change === 'missing'
      ? `STALE ${at} — the file is gone since coverage was ${collected}, so nothing here can be answered: ${RECOLLECT}`
      : `STALE ${at} — the file changed since coverage was ${collected}, so its recorded lines no longer describe it: ${RECOLLECT}`;
  if (result.status === 'excluded')
    return `EXCLUDED ${at} — not in the artifact: ${EXCLUSION_REASONS[result.reason] ?? result.reason}`;
  if (result.status === 'unknown-file')
    return result.changedSinceCollection
      ? `STALE ${at} — no coverage was recorded for this file and it changed after coverage was ${collected}, so a test may cover it now: ${RECOLLECT}`
      : `NO COVERAGE ${at} — the run ${collected} recorded no coverage for this file; if a test was added since, ${RECOLLECT}`;
  if (result.status === 'outside-functions')
    return `NO FUNCTION ${at} — outside every covered function (module body ${result.loaded ? 'ran' : 'never ran'})`;
  const where = `${result.function.name} (lines ${result.function.startLine}-${result.function.endLine})`;
  return result.status === 'executed'
    ? `EXECUTED ${at} — inside ${where}, which the suite ran`
    : `NOT EXECUTED ${at} — inside ${where}, which no test ran`;
}

// The whole-artifact signal: how much of what was measured no longer exists as
// measured, and when it was measured, so a caller can decide to re-collect
// before asking anything at all.
export async function coverageStaleness(artifact, { root = process.cwd() } = {}) {
  const rootPath = resolve(root);
  const changed = [];
  const missing = [];
  for (const [path, entry] of Object.entries(artifact.files ?? {})) {
    const source = await currentSource(rootPath, path);
    if (source === null) missing.push(path);
    else if (sourceDigest(source) !== entry.sha256) changed.push(path);
  }
  return {
    generatedAt: artifact.generatedAt,
    files: Object.keys(artifact.files ?? {}).length,
    changed: changed.sort(),
    missing: missing.sort(),
    changedCount: changed.length + missing.length,
    stale: changed.length + missing.length > 0,
  };
}

export function formatStaleness(state) {
  const collected = state.generatedAt ? `collected ${state.generatedAt}` : 'collected at an unrecorded time';
  return state.stale
    ? `STALE coverage ${collected}: ${state.changedCount} of ${state.files} files changed since (${state.missing.length} gone); ${RECOLLECT}`
    : `FRESH coverage ${collected}: all ${state.files} files unchanged since`;
}

// Called once per `--coverage` run, after the last batch has exited.
export async function reportCoverage(rawDirectory, { root = process.cwd(), log = console.error } = {}) {
  const artifact = await foldCoverage(await readRawCoverage(rawDirectory), { root });
  const target = await writeCoverageArtifact(artifact, { root });
  const { filesWithExecutedFunctions, filesWithoutExecutedFunctions, excludedFiles } = artifact.summary;
  log(
    `Coverage: ${filesWithExecutedFunctions} files with executed functions, ${filesWithoutExecutedFunctions} without, ${excludedFiles} excluded`
  );
  log(`Coverage artifact: ${target}`);
  return target;
}
