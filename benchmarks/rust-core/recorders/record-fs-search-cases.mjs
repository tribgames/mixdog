#!/usr/bin/env node
// Records what Node's search tools answer for the cases of the Node tests whose behaviour the Rust `fs/search.rs` module has
// but no Rust test proved (k1 gaps-tools.md section 3, `mixdog-tools/src/fs/search.rs`). Each case calls the Node function its
// test calls, at b6f10295a, with the test's input (a test that hands the tool a search-server answer through an `__` option
// gets the same answer here; Rust has no search server, so its replay builds the workspace that answer describes, and a
// served partial is a walk that lists those entries and then stalls past the call's deadline).
//
//   node benchmarks/rust-core/recorders/record-fs-search-cases.mjs --tree <exact export of b6f10295a with node_modules> --work <temp dir>
//
// Writes native/core/fixtures/fs-search-cases/{golden.json,MANIFEST.json}. Each case: the Node test and test name, the Rust
// tool and its arguments (`<ROOT>` is the workspace), the workspace (`files`: relative path → content, all with one fixed
// mtime; `gitignore`: written as `.gitignore`; `dirs`: extra empty directories), `stall` (the walk stops after listing the
// workspace and the deadline passes), the calls' results in order, whole, with the workspace path as `<ROOT>`.
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-fs-search-cases.mjs';
const B = 'src/runtime/agent/orchestrator/tools/builtin';
const FIXED = new Date('2026-01-02T03:04:05Z');

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const workRoot = resolve(args.get('work') ?? (() => { throw new Error('--work <temp dir> is required'); })());
mkdirSync(workRoot, { recursive: true });
process.env.MIXDOG_DATA_DIR = join(workRoot, 'data');

// glob and find run through `executeBuiltinTool`, the entry that applies the tool's output budget; the `__` answers reach the
// tool through its options.
const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const executeGlobTool = (a, cwd, options = {}) => executeBuiltinTool('glob', a, cwd, options);
const executeFuzzyFindTool = (a, cwd, options = {}) => executeBuiltinTool('find', a, cwd, options);
const { runGrepSingleFileRescue } = await importFrom(tree, `${B}/lib/grep-single-file-rescue.mjs`);
const { runGrepPatternFanout } = await importFrom(tree, `${B}/lib/grep-pattern-fanout.mjs`);

/** A fresh workspace holding `files` (one fixed mtime), `.gitignore` and `dirs`. */
function workspace(name, { files = {}, gitignore = null, dirs = [] } = {}) {
  const root = mkdtempSync(join(workRoot, `${name}-`));
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  if (gitignore !== null) writeFileSync(join(root, '.gitignore'), gitignore);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    utimesSync(path, FIXED, FIXED);
  }
  return root;
}

const scrub = (root, text) => {
  const forms = [root, root.replace(/\\/g, '/'), root.replace(/\\/g, '\\\\')];
  return forms.reduce((s, f) => s.replaceAll(f, '<ROOT>'), String(text));
};

const cases = [];
/** Records one case: `calls` are [rust args, () => Node result] pairs run in order. */
async function record(c, root, calls) {
  const results = [];
  for (const [, run] of calls) results.push(scrub(root, await run()));
  cases.push({ ...c, calls: calls.map(([rustArgs], i) => ({ args: rustArgs, result: results[i] })) });
}

// ---- find-search-budget.test.mjs ----------------------------------------------------------------
const FSB = `${B}/find-search-budget.test.mjs`;
{
  const root = workspace('find-miss');
  await record({ name: 'find-complete-miss', test: FSB, case: 'a complete fuzzy miss returns without an unsolicited noise-tree probe', tool: 'find', files: {} }, root, [
    [{ query: 'not-in-requested-scope' }, () => executeFuzzyFindTool({ query: 'not-in-requested-scope' }, root, {
      __tryServeFuzzySearch: async () => ({ matches: [], complete: true, hasMore: false, cacheSafe: false }),
    })],
  ]);
}
{
  const files = { 'src/alpha.ts': '' };
  const root = workspace('find-partial', { files });
  await record({ name: 'find-served-partial', test: FSB, case: 'a served partial still reports its ranked matches', tool: 'find', files, stall: true }, root, [
    [{ query: 'alpha', path: '.', limit: 5 }, () => executeFuzzyFindTool({ query: 'alpha', path: '.', head_limit: 5 }, root, {
      __tryServeFuzzySearch: async () => ({ matches: ['src/alpha.ts'], hasMore: false, totalMatches: 1, totalSeen: 1, complete: false, partial: true, timeout: true, scanErrors: 0, walkErrorDetails: [] }),
    })],
  ]);
}

// ---- glob-accum-cap.test.mjs: the merged run through the whole glob tool ------------------------------
const CAP = 50000;
{
  // A walk of one directory lists its names in name order: the paths the tool is handed are in that order.
  const exact = Array.from({ length: CAP }, (_, i) => `file-${i}.mjs`).sort();
  const over = [...exact, 'one-more.mjs'].sort();
  for (const [name, paths] of [['glob-exact-cap', exact], ['glob-over-cap', over]]) {
    const root = workspace(name);
    cases.push({
      name,
      test: `${B}/glob-accum-cap.test.mjs`,
      case: `a glob run that exactly fills the accumulation cap is complete, not truncated (${name === 'glob-exact-cap' ? 'exactly the cap' : 'one past the cap'})`,
      tool: 'glob',
      generated: { count: paths.length, extra: name === 'glob-over-cap' ? ['one-more.mjs'] : [] },
      calls: [{
        args: { pattern: '*.mjs', path: '<ROOT>', sort: 'natural', limit: CAP },
        result: scrub(root, await executeGlobTool({ pattern: '*.mjs', path: root, sort: 'natural', limit: CAP }, root, {
          __runRgWindowedLines: async () => ({ lines: paths, complete: true, partial: false, cacheSafe: false }),
        })),
      }],
    });
  }
}

// ---- glob-empty-partial.test.mjs ----------------------------------------------------------------
{
  const root = workspace('glob-empty-partial');
  const options = { __runRgWindowedLines: async () => ({ lines: [], complete: false, partial: true, timeout: true, cacheSafe: false }) };
  const call = () => executeGlobTool({ path: root, pattern: '**/*.mjs', sort: 'natural', limit: 25 }, root, options);
  await record({ name: 'glob-empty-partial', test: `${B}/glob-empty-partial.test.mjs`, case: 'empty partial glob results keep the incomplete warning and are not cached', tool: 'glob', files: {}, stall: true }, root, [
    [{ path: '<ROOT>', pattern: '**/*.mjs', sort: 'natural', limit: 25 }, call],
    [{ path: '<ROOT>', pattern: '**/*.mjs', sort: 'natural', limit: 25 }, call],
  ]);
}

// ---- glob-ignore-contract.test.mjs: every call of both windows ----------------------------------------
{
  const files = { 'visible.txt': 'fixture\n', 'bundle-one/item.txt': 'fixture\n', 'bundle-two/item.txt': 'fixture\n', 'node_modules/pkg/item.txt': 'fixture\n' };
  const ws = { files, gitignore: 'bundle-*/\n', dirs: ['.git'] };
  const root = workspace('glob-ignore', ws);
  const calls = [];
  for (const window of [{ sort: 'natural', limit: 100 }, { sort: 'mtime', limit: 0 }]) {
    const base = { pattern: '**/*.txt', path: root, ...window };
    const rust = (a) => JSON.parse(scrub(root, JSON.stringify(a)).replace(/\\\\/g, '/'));
    for (const a of [base, { ...base, include_noise: true }, { ...base, include_noise: false }, { ...base, pattern: ['bundle-*/item.txt', '!bundle-two/**'], include_noise: true }]) {
      calls.push([rust(a), () => executeGlobTool({ ...a }, root)]);
    }
  }
  await record({ name: 'glob-ignore-contract', test: `${B}/glob-ignore-contract.test.mjs`, case: 'glob opt-in includes ignored files without leaking across cached scopes', tool: 'glob', ...ws }, root, calls);
}

// ---- grep-no-match-body.test.mjs and grep-single-file-rescue.test.mjs: the single-file scan ---------------
const RESCUE_NOTICE = '\n[notice] native search could not serve this file scope; the file was scanned directly.';
const STATUS = 'Name:\tnode\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nCapEff:\t000001ffffffffff\n';
function rescueRequest(file, root, overrides) {
  return {
    filePath: file, searchPath: file, grepResolvedPath: file, workDir: root,
    caseInsensitive: false, multilineMode: false, onlyMatching: false, fileType: null, outputMode: 'content', showLineNumbers: true,
    withFilename: false, filenameOmitted: true, beforeN: 0, afterN: 0, contextN: 0, headLimit: 250, offset: 0, patternCapNote: '', globPatterns: [],
    ...overrides,
  };
}
{
  const files = { status: 'Name:\tnode\nUid:\t0\n' };
  const root = workspace('grep-no-match', { files });
  const file = join(root, 'status');
  await record({ name: 'grep-rescue-miss', test: `${B}/grep-no-match-body.test.mjs`, case: 'the single-file rescue answers a miss with the short no-match body', tool: 'grep', files, rescueNotice: RESCUE_NOTICE }, root, [
    [{ pattern: 'NoSuchFieldHere', path: '<ROOT>/status', context: 0 }, () => runGrepSingleFileRescue(rescueRequest(file, root, { patterns: ['NoSuchFieldHere'] }))],
    [{ pattern: 'NoSuchFieldHere', path: '<ROOT>/status', context: 2 }, () => runGrepSingleFileRescue(rescueRequest(file, root, { patterns: ['NoSuchFieldHere'], contextN: 2 }))],
  ]);
}
{
  const files = { status: STATUS };
  const root = workspace('grep-rescue', { files });
  const file = join(root, 'status');
  const pattern = '^(Uid|Gid|Cap(Inh|Prm|Eff|Bnd|Amb))';
  await record({ name: 'grep-rescue-matches', test: `${B}/grep-single-file-rescue.test.mjs`, case: 'a missed file scope is scanned directly and reports the same matches', tool: 'grep', files, rescueNotice: RESCUE_NOTICE }, root, [
    [{ pattern, path: '<ROOT>/status', context: 0 }, () => runGrepSingleFileRescue(rescueRequest(file, root, { patterns: [pattern] }))],
  ]);
  await record({ name: 'grep-rescue-count-and-miss', test: `${B}/grep-single-file-rescue.test.mjs`, case: 'counts and no-match answers keep the ordinary grep shapes', tool: 'grep', files, rescueNotice: RESCUE_NOTICE }, root, [
    [{ pattern: '^(Uid|Gid)', path: '<ROOT>/status', mode: 'count', context: 0 }, () => runGrepSingleFileRescue(rescueRequest(file, root, { outputMode: 'count', patterns: ['^(Uid|Gid)'] }))],
    [{ pattern: 'NoSuchFieldHere', path: '<ROOT>/status', context: 0 }, () => runGrepSingleFileRescue(rescueRequest(file, root, { patterns: ['NoSuchFieldHere'] }))],
  ]);
}

// ---- grep-pattern-fanout.test.mjs 'all-miss …' (the single-line search; multiline is no public argument) ------------------
{
  const root = workspace('grep-all-miss');
  await record({ name: 'grep-all-miss', test: `${B}/grep-pattern-fanout.test.mjs`, case: 'all-miss combined and prefiltered fallback searches return one whole-scope notice (multilineMode false)', tool: 'grep', files: {} }, root, [
    [{ pattern: ['alpha', 'beta'], path: '.', limit: 10, context: 0 }, () => runGrepPatternFanout({
      args: {}, patterns: ['alpha', 'beta'], workDir: root, executeChildBuiltinTool: async () => '', readStateScope: null,
      options: { __runRgWindowedLines: async () => ({ lines: [], complete: true, partial: false }) },
      callContextCharBudget: 4_096, patternCapNote: '', searchPath: '.', grepResolvedPath: root, normalizedGlobPatterns: [], outputMode: 'content',
      headLimit: 10, offset: 0, caseInsensitive: false, showLineNumbers: true, beforeN: null, afterN: null, contextN: 0, multilineMode: false,
      pcre2Mode: false, fileType: '', executeGrepTool: async () => { throw new Error('unexpected fallback'); },
    })],
  ]);
}

// ---- list-find-stable-paging.test.mjs 'fuzzy find has no offset …': the byte cap at the tool's own budget ------------------
{
  // The test caps 40 rows at a 512-byte budget; the Rust budget is fixed (the locator cap), so the rows are enough to pass that
  // cap. Every row scores the same, so the ranked order is by length, then name.
  const matches = Array.from({ length: 600 }, (_, i) => `src/some/long/directory/name/file-${i}.mjs`)
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const files = Object.fromEntries(matches.map((m) => [m, '']));
  const root = workspace('find-cap', { files });
  await record({ name: 'find-fuzzy-cap', test: `${B}/list-find-stable-paging.test.mjs`, case: 'fuzzy find has no offset, so its byte-cap marker must not offer one', tool: 'find', files }, root, [
    [{ query: 'file', path: '.', limit: 600 }, () => executeFuzzyFindTool({ query: 'file', path: '.', head_limit: 600 }, root, {
      __tryServeFuzzySearch: async () => ({ complete: true, matches, hasMore: false, cacheSafe: false }),
    })],
  ]);
}

// ---- cases not replayed ---------------------------------------------------------------------------------------------
const EXCLUDED = {
  [FSB]: {
    'server setup is not charged to the search budget': 'gone: the search-server budget (Rust has no search server)',
    'an empty served partial is returned without another filesystem walk': 'difference: a timed-out walk with no match is `Error: fuzzy search timed out before returning any matches for "missing".\\n... [native inventory was incomplete; absence of matches is not established]` in Node, `(no fuzzy match for "missing")\\n... [search timed out; partial results shown]` in Rust',
    'a fuzzy deadline returns promptly without starting another filesystem walk': 'difference: same as the empty served partial (Node: an Error that absence is not established; Rust: `(no fuzzy match …)` with a partial-results note)',
  },
  [`${B}/glob-empty-partial.test.mjs`]: {
    'the path cap does not hide errors from later groups or partial-result warnings':
      'gone: per-group rg runs with a faked failure in one group (Rust walks once, no group runs)',
  },
  [`${B}/grep-no-match-body.test.mjs`]: {
    'a chunk-merged pattern set answers a miss with the short no-match body': 'gone: pattern chunking (its body is the faked inner grep answer)',
  },
  [`${B}/grep-single-file-rescue.test.mjs`]: {
    'a request the scanner cannot reproduce declines instead of guessing': 'gone: the rescue scanner declining (Rust has no rescue path)',
  },
  [`${B}/grep-pattern-fanout.test.mjs`]: {
    'all-miss combined and prefiltered fallback searches return one whole-scope notice (multilineMode true)': 'not replayable: multiline is no public grep argument',
    'successful combined pattern fanout performs one broad scan': 'difference (gaps-tools row 33): Node answers several patterns in `# grep pattern:"x"` sections; Rust runs one alternation and returns one merged body',
    'nested path fanout runs patterns serially and preserves result and error order': 'difference (row 33): per-pattern sections and a per-pattern regex error in Node; one merged body in Rust',
    'combined patterns summarize only misses and retain per-pattern pages after deduplication': 'difference (row 33): `(no matches) patterns=[…]` miss summaries and per-pattern paging in Node only',
    'combined partial results retain timeout and execution warnings, not proven misses': 'difference (row 33): per-pattern sections in Node only',
    'fallback pattern deduplication drops empty context headers but keeps diagnostics and pages': 'difference (row 33): per-pattern sections in Node only',
    'path fallback consolidates only clean misses, preserving missing paths, errors and partials': 'difference (row 33): `(no matches) paths=[…]` summaries in Node only',
    'nested path and pattern misses name only the unmatched subsets once': 'difference (row 33): per-subset miss summaries in Node only',
    'combined pattern fanout preserves watcher cache safety (true)': 'gone: the result cache of the JS scan',
    'combined pattern fanout preserves watcher cache safety (false)': 'gone: the result cache of the JS scan',
  },
  [`${B}/list-find-stable-paging.test.mjs`]: {
    'find sort=size|mtime pages the same total order whatever order the walk returns': 'gone: find sort/offset are hidden arguments not in the public schema',
    'list sort=size|mtime pages the same total order whatever order the native walk returns': 'gone: list sort is a hidden argument not in the public schema',
    'fuzzy find has no offset, so its byte-cap marker must not offer one': 'difference: at the 20 KB locator cap Node keeps 487 rows (`[output capped at 20 KB; 487 match row(s) shown …]`), Rust 490 rows (`… 490 match row(s) shown …`)',
  },
  [`${B}/glob-accum-cap.test.mjs`]: {
    'a glob run that exactly fills the accumulation cap is complete, not truncated (exactly the cap)': 'difference: at the 20 KB locator cap Node ends `[output capped at 20 KB; 1364 complete row(s) shown for path="<ROOT>"; offset:1364 for more]`, Rust `[output capped at 20 KB; 1376 entries shown; offset:1376 for more]`',
    'a glob run that exactly fills the accumulation cap is complete, not truncated (one past the cap)': 'difference: as exactly the cap (1364 complete rows in Node, 1376 entries in Rust)',
  },
  [`${B}/glob-empty-partial.test.mjs`]: {
    'empty partial glob results keep the incomplete warning and are not cached': 'difference: Node `(no files found yet) pattern="**/*.mjs" path=<ROOT>; <ROOT>: path exists (dir)\\n[entries 1-0; offset:0 for more]\\n... [warning] rg exit 2 (partial results); listing may be incomplete`, Rust `(no files found yet)\\n[warning] search timed out; partial results shown. Narrow path/pattern for a complete result.`',
  },
  [`${B}/glob-ignore-contract.test.mjs`]: {
    'glob opt-in includes ignored files without leaking across cached scopes (call 1: sort natural, include_noise true)': 'difference: Node lists the walk order `visible.txt, node_modules/pkg/item.txt, bundle-two/item.txt, bundle-one/item.txt`, Rust the name order `bundle-one/…, bundle-two/…, node_modules/…, visible.txt`',
  },
  [`${B}/grep-single-file-rescue.test.mjs`]: {
    'counts and no-match answers keep the ordinary grep shapes (call 0: mode count)': 'difference: a one-file count is `2\\n[total 2 matches across 1 file]` in Node, `status:2\\n[total 2 matches across 1 file]` in Rust',
  },
};
// Differences named above: the case, or the call of the case, is left out of the replay.
const LEFT_OUT = { 'find-fuzzy-cap': null, 'glob-exact-cap': null, 'glob-over-cap': null, 'glob-empty-partial': null, 'glob-ignore-contract': [1], 'grep-rescue-count-and-miss': [0] };
const replayed = cases
  .filter((c) => LEFT_OUT[c.name] !== null)
  .map((c) => (LEFT_OUT[c.name] ? { ...c, calls: c.calls.filter((_, i) => !LEFT_OUT[c.name].includes(i)) } : c));

const finalDir = join(FIXTURES_ROOT, 'fs-search-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's search tools at ${NODE_COMMIT}, per case of ${RECORDER}`, platform: process.platform, mtime: FIXED.toISOString(), cases: replayed });
writeSetManifest(stage, {
  set: 'fs-search-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}> --work <temp dir>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: 'each call\'s whole result text, in order, through the Rust tool named by the case on the workspace the case names. Rust argument names are the public schema\'s (`limit` for `head_limit`, `context` for contextN, `mode` for outputMode). A case with `rescueNotice` has that notice removed from the Node text first: it says the native search server could not serve the file, and Rust has no server. glob and find are recorded through executeBuiltinTool, so Node\'s text includes the locator output budget.',
    excluded: EXCLUDED,
  },
});
commitStage(stage, finalDir);
console.log(`fs-search-cases: ${replayed.length} case(s) replayed of ${cases.length} recorded`);
