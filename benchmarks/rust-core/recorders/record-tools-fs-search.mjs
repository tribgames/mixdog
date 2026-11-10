#!/usr/bin/env node
// What Node's file and search tools answer in the cases the Rust core's `glob`, `grep`, `list`, `read` and `code_graph` replay
// (native/core/crates/mixdog-tools, `fs::tests` and `code_graph::tests`): the real tools of the exact export of b6f10295a, called
// through `executeBuiltinTool` / `executeCodeGraphTool` over a fresh workspace per scenario, in order, in one Node process per
// scenario. Glob, grep and find need Node's resident search server and code_graph its parser: both are the `mixdog-graph` binary built
// from the same commit's native/mixdog-graph (`--graph-bin`).
//
// Each scenario's process runs in a job object of its own (lib/job-run.mjs): the search server it starts is ended with it on every path.
//
//   node benchmarks/rust-core/recorders/record-tools-fs-search.mjs --tree <exact export of b6f10295a with node_modules> \
//        --graph-bin <mixdog-graph built from b6f10295a:native/mixdog-graph> --scratch <scratch parent> [--only <scenario>]
//
// Output: native/core/fixtures/tools-fs-search/<scenario>.json (+ MANIFEST.json); with --only the one scenario is recorded and printed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-tools-fs-search.mjs';
const SELF = fileURLToPath(import.meta.url);
const DEADLINE_MS = 240_000;
// Every file of a workspace is dated here unless its scenario dates it otherwise (glob lists newest first).
const FIXED = '2026-01-02T03:04:05Z';

// A scenario: the workspace (`files`: path -> text; `junctions`: path -> the workspace directory it points at; `mtimes`: path -> ISO
// time), the folder the calls run in (`cwd`, under the workspace), unrecorded `warmup` calls and the calls, in order. `<ROOT>` in an input is the workspace
// path, written with forward slashes.
const notebook = (cells) => JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1);
const SCENARIOS = [
  // The public read's `mode` (read-tool.mjs, read-single-tool.mjs): the legacy `path` form reads every glance mode, the
  // `file_path` form only `count` and `hex`; an entry object of a `file_path` array may not carry one.
  {
    name: 'read-modes',
    files: {
      'nb.ipynb': notebook([{ cell_type: 'markdown', metadata: {}, source: ['# Title\n', 'Some *text*.'] }]),
      'a.txt': Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    },
    calls: [
      { tool: 'read', input: { path: 'nb.ipynb', mode: 'head' } },
      { tool: 'read', input: { path: 'nb.ipynb', mode: 'hex' } },
      { tool: 'read', input: { file_path: 'nb.ipynb', mode: 'head' } },
      { tool: 'read', input: { file_path: 'nb.ipynb', mode: 'tail' } },
      { tool: 'read', input: { file_path: 'nb.ipynb', mode: 'count' } },
      { tool: 'read', input: { file_path: 'nb.ipynb', mode: 'summary' } },
      { tool: 'read', input: { file_path: 'nb.ipynb', mode: 'hex' } },
      { tool: 'read', input: { file_path: 'a.txt', mode: 'head' } },
      { tool: 'read', input: { file_path: 'a.txt', mode: 'head', n: 3 } },
      { tool: 'read', input: { file_path: 'a.txt', mode: 'tail', n: 2 } },
      { tool: 'read', input: { file_path: 'a.txt', mode: 'count' } },
      { tool: 'read', input: { file_path: 'a.txt', mode: 'summary' } },
      { tool: 'read', input: { file_path: 'a.txt', mode: 'hex', n: 32 } },
      { tool: 'read', input: { file_path: 'a.txt', mode: 'full' } },
      { tool: 'read', input: { file_path: 'a.txt', mode: 'bogus' } },
      { tool: 'read', input: { file_path: 'a.txt', mode: 'head', offset: 5, limit: 2 } },
      { tool: 'read', input: { file_path: [{ file_path: 'a.txt', mode: 'tail', n: 2 }, 'nb.ipynb'] } },
      { tool: 'read', input: { path: 'a.txt', mode: 'head', n: 3 } },
      { tool: 'read', input: { path: 'a.txt', mode: 'tail', n: 2 } },
      { tool: 'read', input: { path: 'a.txt', mode: 'count' } },
      { tool: 'read', input: { path: 'a.txt', mode: 'summary' } },
    ],
  },
  // A public read's `mode` and `full`, and which read shapes render a notebook's cells (read-single-tool.mjs,
  // read-single-media.mjs, read-special-files.mjs extractIpynbText) and which refuse it.
  {
    name: 'read-shapes',
    files: {
      'nb.ipynb': notebook([
        { cell_type: 'markdown', metadata: {}, source: ['# Title\n', 'Some *text*.'] },
        { cell_type: 'code', execution_count: 1, metadata: {}, source: ['x = 1\n', 'print(x)'], outputs: [
          { output_type: 'stream', name: 'stdout', text: ['1\n'] },
          { output_type: 'execute_result', execution_count: 1, metadata: {}, data: { 'text/plain': ['2'], 'text/html': ['<b>2</b>'] } },
        ] },
        { cell_type: 'raw', metadata: {}, source: ['raw text'] },
        { cell_type: 'code', execution_count: null, metadata: {}, source: 'y = 2', outputs: [] },
        { cell_type: 'code', execution_count: 2, metadata: {}, source: [], outputs: [{ output_type: 'error', ename: 'E', evalue: 'v', traceback: [] }] },
        { cell_type: 'markdown', metadata: {}, source: [] },
      ]),
      'big.ipynb': notebook([{ cell_type: 'code', execution_count: 1, metadata: {}, source: ['print("x" * 12000)'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['x'.repeat(12000)] }] }]),
      'empty.ipynb': notebook([]),
      'blank.ipynb': notebook([{ cell_type: 'markdown', metadata: {}, source: [] }]),
      'nocells.ipynb': JSON.stringify({ metadata: {} }),
      'bad.ipynb': '{"cells": [',
      'UPPER.IPYNB': notebook([{ cell_type: 'markdown', metadata: {}, source: ['upper'] }]),
      'a.txt': Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    },
    calls: [
      { tool: 'read', input: { path: 'nb.ipynb' } },
      { tool: 'read', input: { path: 'nb.ipynb', full: true } },
      { tool: 'read', input: { path: 'nb.ipynb', full: true } },
      { tool: 'read', input: { file_path: 'nb.ipynb', full: true } },
      { tool: 'read', input: { path: ['nb.ipynb', 'a.txt'] } },
      { tool: 'read', input: { path: ['nb.ipynb', 'a.txt'], full: true } },
      { tool: 'read', input: { file_path: ['nb.ipynb', 'a.txt'], full: true } },
      { tool: 'read', input: { path: 'n*.ipynb' } },
      { tool: 'read', input: { path: 'n*.ipynb', full: true } },
      { tool: 'read', input: { file_path: 'n*.ipynb', full: true } },
      { tool: 'read', input: { path: 'big.ipynb', full: true } },
      { tool: 'read', input: { path: 'empty.ipynb', full: true } },
      { tool: 'read', input: { path: 'blank.ipynb', full: true } },
      { tool: 'read', input: { path: 'nocells.ipynb', full: true } },
      { tool: 'read', input: { path: 'bad.ipynb', full: true } },
      { tool: 'read', input: { path: 'UPPER.IPYNB', full: true } },
      { tool: 'read', input: { path: 'nb.ipynb', full: true, offset: 2 } },
    ],
  },
  // A missing `list` / `grep` path is answered with Node's recovery hints (search-path-diagnostics.mjs buildNotFoundHint):
  // the same filename or directory name elsewhere, the entries under the nearest existing directory, a conclusive absence.
  {
    name: 'not-found-hints',
    files: {
      'app/main.ts': 'export const x = 1;\n',
      'app/README.md': '# app\n',
      'app/run.log': 'log\n',
      'app/src/util.ts': 'export const u = 1;\n',
      'app/src/lib/helpers.ts': 'export const h = 1;\n',
      'app/docs/guide.md': '# guide\n',
      'app/build/util.ts': 'export const b = 1;\n',
      'app/.hidden/util.ts': 'export const h = 1;\n',
      'app/node_modules/pkg/index.js': 'module.exports = 1;\n',
      'app/one/assets/a.txt': 'a\n',
      'app/two/assets/b.txt': 'b\n',
      'shared/a.ts': 'export const a = 1;\n',
      'emptydir/.keep': '',
    },
    cwd: 'app',
    warmup: [{ tool: 'grep', input: { pattern: 'warmup-none' } }],
    calls: [
      { tool: 'list', input: { path: 'nope' } },
      { tool: 'list', input: { path: 'nope.txt' } },
      { tool: 'list', input: { path: 'util.ts' } },
      { tool: 'list', input: { path: 'lib' } },
      { tool: 'list', input: { path: 'assets' } },
      { tool: 'list', input: { path: 'README.md/x' } },
      { tool: 'list', input: { path: 'a, b' } },
      { tool: 'list', input: { path: 'src/nope/deeper' } },
      { tool: 'list', input: { path: 'nope/*.ts' } },
      { tool: 'list', input: { path: '../nope' } },
      { tool: 'list', input: { path: '../emptydir/nope' } },
      { tool: 'list', input: { path: '../nolib/*.ts' } },
      { tool: 'grep', input: { pattern: 'x', path: 'nope' } },
      { tool: 'grep', input: { pattern: 'x', path: 'nope.txt' } },
      { tool: 'grep', input: { pattern: 'x', path: 'util.ts' } },
      { tool: 'grep', input: { pattern: 'x', path: 'lib' } },
      { tool: 'grep', input: { pattern: 'x', path: '../nope' } },
      { tool: 'grep', input: { pattern: 'x', path: 'a, b' } },
      { tool: 'grep', input: { pattern: ['x', 'y'], path: 'nope' } },
    ],
  },
  // gaps-tools item 10: a reference scan past REFERENCE_HIT_CAP says it was cut (code-graph/search.mjs _cheapReferenceSearch),
  // and a symbol miss names a differently-cased spelling the graph's token index holds (search-references.mjs
  // _formatNoSymbolMatches).
  {
    name: 'code-graph-refs-casing',
    files: {
      'package.json': '{}\n',
      'src/widget.ts': 'export class Widget {\n  size = 1;\n}\n\nexport function makeWidget(): Widget {\n  return new Widget();\n}\n',
      'src/use.ts': `import { Widget } from './widget';\n\nexport const w = new Widget();\n`,
      'src/many.ts': `export function target(n: number): number {\n  return n;\n}\n\n${Array.from({ length: 230 }, (_, i) => `export const v${i} = target(${i});`).join('\n')}\n`,
      'src/shapes.ts': `export interface Shape {\n  n: number;\n}\n\n${Array.from({ length: 230 }, (_, i) => `export type S${i} = Shape;`).join('\n')}\n`,
      'src/zz-late.ts': `import { Shape } from './shapes';\n\nexport let late: Shape | null = null;\n`,
    },
    // Starts the graph server: its first build can outlast Node's 20 s bound on a loaded recording machine.
    warmup: [{ tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['warmupNone'] } }],
    calls: [
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['widget'] } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['Widget'] } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['widget'] } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['WIDGET'] } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['Widget', 'widget'] } },
      { tool: 'code_graph', input: { mode: 'references', symbols: ['target'] } },
      { tool: 'code_graph', input: { mode: 'references', symbols: ['target'], limit: 0 } },
      { tool: 'code_graph', input: { mode: 'callers', symbols: ['target'] } },
      { tool: 'code_graph', input: { mode: 'references', symbols: ['Widget'] } },
      { tool: 'code_graph', input: { mode: 'references', symbols: ['Shape'] } },
      { tool: 'code_graph', input: { mode: 'references', symbols: ['Shape'], limit: 3 } },
    ],
  },
  // REFERENCE_HIT_CAP (code-graph/search.mjs _cheapReferenceSearch): `Math.max(1, Number(env) || 200)` mentions per
  // scan, read at each scan; `env` is the scenario process's environment.
  ...[['2.5', 'fraction'], [' 0x2 ', 'hex'], ['-3', 'negative'], ['0', 'zero'], ['many', 'nan']].map(([cap, label]) => ({
    name: `code-graph-hit-cap-${label}`,
    env: { REFERENCE_HIT_CAP: cap },
    files: {
      'package.json': '{}\n',
      'src/many.ts': `export function target(n: number): number {\n  return n;\n}\n\n${Array.from({ length: 6 }, (_, i) => `export const v${i} = target(${i});`).join('\n')}\n`,
      'src/use.ts': `import { target } from './many';\n\nexport const u = target(9);\n`,
    },
    warmup: [{ tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['warmupNone'] } }],
    calls: [
      { tool: 'code_graph', input: { mode: 'references', symbols: ['target'] } },
      { tool: 'code_graph', input: { mode: 'callers', symbols: ['target'], file: 'src/use.ts' } },
    ],
  })),
  // gaps-tools item 8: a `.ipynb` read goes to Node's notebook extractor (read-single-media.mjs), never the raw JSON. The
  // extractor refuses a read with a window (offset/limit), which every `file_path` read carries, and renders the cells of
  // one without (read-special-files.mjs extractIpynbText).
  {
    name: 'read-ipynb',
    files: {
      'nb.ipynb': notebook([
        { cell_type: 'markdown', metadata: {}, source: ['# Title\n', 'Some *text*.'] },
        { cell_type: 'code', execution_count: 1, metadata: {}, source: ['print(1)'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }] },
      ]),
      'empty.ipynb': notebook([]),
      'UPPER.IPYNB': notebook([{ cell_type: 'markdown', metadata: {}, source: ['upper'] }]),
      'a.txt': 'alpha\n',
    },
    calls: [
      { tool: 'read', input: { file_path: 'nb.ipynb' } },
      { tool: 'read', input: { file_path: 'nb.ipynb' } },
      { tool: 'read', input: { file_path: 'empty.ipynb' } },
      { tool: 'read', input: { file_path: 'UPPER.IPYNB' } },
      { tool: 'read', input: { file_path: 'nb.ipynb', offset: 2 } },
      { tool: 'read', input: { file_path: 'nb.ipynb', full: true } },
      { tool: 'read', input: { file_path: ['nb.ipynb', 'a.txt'] } },
      { tool: 'read', input: { file_path: 'nope.ipynb' } },
    ],
  },
  // gaps-tools item 6: two or more content patterns are answered as independent greps (lib/grep-pattern-fanout.mjs), one
  // `# grep pattern:"x"` section each, matches already shown dropped, misses summarised, a bad pattern failing its own section.
  {
    name: 'grep-multi-pattern',
    files: {
      'src/a.ts': 'const alpha = 1;\nconst gamma = 2;\nexport function beta() {\n  return alpha;\n}\n',
      'src/b.ts': 'import { alpha } from "./a";\n// alpha and beta together\nexport const delta = beta;\n',
      'docs/x.md': '# Notes\n\nbeta release\n',
    },
    warmup: [{ tool: 'grep', input: { pattern: 'warmup-none' } }],
    calls: [
      { tool: 'grep', input: { pattern: ['alpha', 'beta'] } },
      { tool: 'grep', input: { pattern: ['alpha', 'nomatch1', 'nomatch2'] } },
      { tool: 'grep', input: { pattern: ['zzz', 'yyy'] } },
      { tool: 'grep', input: { pattern: ['alpha', '(bad'] } },
      { tool: 'grep', input: { pattern: ['alpha', 'beta'], context: 0 } },
      { tool: 'grep', input: { pattern: ['alpha', 'beta'], context: 1 } },
      { tool: 'grep', input: { pattern: ['alpha', 'beta'], limit: 1 } },
      { tool: 'grep', input: { pattern: ['alpha', 'beta'], mode: 'files' } },
      { tool: 'grep', input: { pattern: ['alpha', 'beta'], mode: 'count' } },
      { tool: 'grep', input: { pattern: ['alpha', 'beta'], path: 'src/b.ts' } },
      { tool: 'grep', input: { pattern: '(bad' } },
      { tool: 'grep', input: { pattern: ['gamma', 'delta'], glob: '*.ts' } },
    ],
  },
  // gaps-tools item 5: absolute glob patterns walk from their static prefix (lib/glob-static-prefix.mjs); a miss is expanded
  // straight off the filesystem (lib/absolute-glob-expand.mjs), which reaches through the junction the walker never follows.
  {
    name: 'glob-absolute',
    files: {
      'app/main.ts': 'm\n',
      'app/util.ts': 'u\n',
      'lib/a.ts': 'a\n',
      'lib/b.js': 'b\n',
      'lib/deep/c.ts': 'c\n',
      'deep/inner/x.ts': 'x\n',
    },
    junctions: { jn: 'deep/inner' },
    mtimes: { 'app/main.ts': '2026-01-05T00:00:00Z', 'lib/a.ts': '2026-01-04T00:00:00Z', 'lib/deep/c.ts': '2026-01-03T00:00:00Z' },
    cwd: 'app',
    warmup: [{ tool: 'glob', input: { pattern: '*.none' } }],
    calls: [
      { tool: 'glob', input: { pattern: '<ROOT>/lib/*.ts' } },
      { tool: 'glob', input: { pattern: '<ROOT>/lib/**/*.ts' } },
      { tool: 'glob', input: { pattern: '<ROOT>/app/*.ts' } },
      { tool: 'glob', input: { pattern: ['*.ts', '<ROOT>/lib/**/*.ts'] } },
      { tool: 'glob', input: { pattern: '<ROOT>/lib/**/*.ts', limit: 1 } },
      { tool: 'glob', input: { pattern: '<ROOT>/lib/a.ts' } },
      { tool: 'glob', input: { pattern: '<ROOT>/*/x.ts' } },
      { tool: 'glob', input: { pattern: '<ROOT>/j*/x.ts' } },
      { tool: 'glob', input: { pattern: '<ROOT>/lib/*.zz' } },
      { tool: 'glob', input: { pattern: '<ROOT>/lib/*.ts', sort: 'natural' } },
      { tool: 'glob', input: { pattern: '<ROOT>/lib/*.ts', limit: 1, offset: 5 } },
    ],
  },
  // A UNC/SMB or device-namespace pattern or path is refused before any walk or expansion (search-glob-tool.mjs
  // globUncRefusal); a backslashed drive pattern reaches the expansion with its drive root (absolute-glob-expand.mjs).
  {
    name: 'glob-unc',
    files: { 'deep/inner/x.ts': 'x\n' },
    junctions: { jn: 'deep/inner' },
    warmup: [{ tool: 'glob', input: { pattern: '*.none' } }],
    calls: [
      { tool: 'glob', input: { pattern: '//server/share/j*/x.ts' } },
      { tool: 'glob', input: { pattern: '\\\\server\\share\\x\\*.ts' } },
      { tool: 'glob', input: { pattern: '//./C:/x/*.ts' } },
      { tool: 'glob', input: { pattern: '//?/C:/x/*.ts' } },
      { tool: 'glob', input: { pattern: ['*.ts', '//server/share/*.ts'] } },
      { tool: 'glob', input: { pattern: '*.ts', path: '//server/share' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '\\\\server\\share\\dir' } },
      { tool: 'glob', input: { pattern: '<ROOT>\\j*\\x.ts' } },
    ],
  },
  // gaps-tools item 12: a glob-shaped `list` path is answered as a name search (list-tool.mjs -> executeFindFilesTool).
  {
    name: 'list-glob-path',
    files: {
      'src/a.ts': 'a\n',
      'src/b.ts': 'b'.repeat(3000),
      'src/c.js': 'c\n',
      'src/sub/d.ts': 'd\n',
      'src/.hid.ts': 'h\n',
      'src/.cfg/e.ts': 'e\n',
      'src/node_modules/m/i.ts': 'i\n',
      'src/node_modules/top.ts': 't\n',
      'README.md': 'r\n',
      'docs/x.md': 'x\n',
    },
    mtimes: { 'src/a.ts': '2026-01-05T00:00:00Z', 'src/sub/d.ts': '2026-01-04T00:00:00Z', 'docs/x.md': '2026-01-03T10:00:00Z', 'src/sub': '2026-01-06T00:00:00Z', 'src/node_modules': '2026-01-07T00:00:00Z' },
    warmup: [{ tool: 'list', input: { path: 'warm/*.none' } }, { tool: 'list', input: { path: '*.none' } }],
    calls: [
      { tool: 'list', input: { path: 'src/*.ts' } },
      { tool: 'list', input: { path: 'src/**/*.ts' } },
      { tool: 'list', input: { path: '**/*.md' } },
      { tool: 'list', input: { path: '*.md' } },
      { tool: 'list', input: { path: 'src/*.ts', limit: 1 } },
      { tool: 'list', input: { path: 'src/*.ts', offset: 1 } },
      { tool: 'list', input: { path: 'src/*.ts', hidden: true } },
      { tool: 'list', input: { path: 'src/*.ts', meta: true } },
      { tool: 'list', input: { path: 'src/*.TS' } },
      { tool: 'list', input: { path: 'src/*.zz' } },
      { tool: 'list', input: { path: '<ROOT>/src/*.ts' } },
      { tool: 'list', input: { path: 'src/{a,c}.*' } },
      { tool: 'list', input: { path: 'src/s*' } },
      { tool: 'list', input: { path: 'src/n*' } },
      { tool: 'list', input: { path: 'src/**/i.ts' } },
      { tool: 'list', input: { path: 'src/**/e.ts' } },
      { tool: 'list', input: { path: 'src/**/e.ts', hidden: true } },
      { tool: 'list', input: { path: 'README.md/*.x' } },
      { tool: 'list', input: { path: 'src/*.ts', limit: 0 } },
    ],
  },
];

const deadline = (promise, ms, what) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

if (process.argv[2] === '--child') {
  const tree = process.env.RECORDER_TREE;
  const ws = process.env.RECORDER_WORKSPACE;
  const scenario = SCENARIOS.find((s) => s.name === process.env.RECORDER_SCENARIO);
  const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
  for (const [rel, text] of Object.entries(scenario.files ?? {})) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), text);
  }
  for (const [rel, target] of Object.entries(scenario.junctions ?? {})) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    symlinkSync(join(ws, target), join(ws, rel), 'junction');
  }
  for (const rel of Object.keys(scenario.files ?? {})) {
    const at = new Date(scenario.mtimes?.[rel] ?? FIXED);
    utimesSync(join(ws, rel), at, at);
  }
  // Directories are dated last: writing their files moved their mtimes.
  for (const [rel, iso] of Object.entries(scenario.mtimes ?? {})) {
    if (!(rel in (scenario.files ?? {}))) utimesSync(join(ws, rel), new Date(iso), new Date(iso));
  }
  const { executeBuiltinTool } = await imp('src/runtime/agent/orchestrator/tools/builtin.mjs');
  const { executeCodeGraphTool } = await imp('src/runtime/agent/orchestrator/tools/code-graph.mjs');
  const { normalizeToolEnvelope } = await imp('src/runtime/agent/orchestrator/session/tool-envelope.mjs');
  const { classifyResultKind } = await imp('src/runtime/agent/orchestrator/session/result-classification.mjs');
  const fwd = ws.replace(/\\/g, '/');
  const scrub = (text) => String(text).replaceAll(ws, '<ROOT>').replaceAll(fwd, '<ROOT>');
  const cwd = scenario.cwd ? join(ws, scenario.cwd) : ws;
  // Unrecorded calls first: the search server's first start can miss Node's 1 s readiness bound, which is a cold-start
  // artefact of the recording machine, not an answer.
  for (const call of scenario.warmup ?? []) {
    const run = call.tool === 'code_graph' ? executeCodeGraphTool('code_graph', call.input, cwd) : executeBuiltinTool(call.tool, call.input, cwd);
    await run.catch(() => {});
  }
  const calls = [];
  for (const call of scenario.calls) {
    const input = JSON.parse(JSON.stringify(call.input).replaceAll('<ROOT>', fwd));
    let outcome;
    try {
      const raw = call.tool === 'code_graph' ? await executeCodeGraphTool('code_graph', input, cwd) : await executeBuiltinTool(call.tool, input, cwd);
      const env = normalizeToolEnvelope(raw);
      const text = typeof env.result === 'string' ? env.result : JSON.stringify(env.result ?? '');
      // Node's outcome of the call: an explicit failure, or a text its one classifier calls an error (a navigation miss
      // is a zero-match there, not a failure).
      const isError = env.explicitFailure || (!env.explicitSuccess && classifyResultKind(text, false, call.tool) === 'error');
      outcome = { text: scrub(text), isError };
    } catch (error) {
      outcome = { thrown: scrub(String(error?.message ?? error)) };
    }
    calls.push({ tool: call.tool, input: call.input, ...outcome });
  }
  writeFileSync(process.env.RECORDER_RESULT, JSON.stringify(calls));
  process.exit(0);
}

const { FIXTURES_ROOT, REPO_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { readJobReport, spawnInJob } = await import('./lib/job-run.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const graphBin = args.get('graph-bin');
if (!graphBin || !existsSync(graphBin)) throw new Error('--graph-bin <mixdog-graph built from b6f10295a:native/mixdog-graph> is required');
const scratch = args.get('scratch');
if (!scratch) throw new Error('--scratch <scratch parent> is required');
const only = args.get('only');
const selected = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
if (only && selected.length === 0) throw new Error(`no scenario ${only}`);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

mkdirSync(scratch, { recursive: true });
const run = mkdtempSync(join(scratch, 'fs-search-'));

/** One scenario in a Node process of its own, inside a job that ends with it. */
async function recordScenario(scenario) {
  const sandbox = join(run, scenario.name);
  const ws = join(sandbox, 'ws');
  mkdirSync(ws, { recursive: true });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, RECORDER_TREE: tree, RECORDER_WORKSPACE: ws, RECORDER_SCENARIO: scenario.name, RECORDER_RESULT: join(sandbox, 'result.json'), MIXDOG_GRAPH_BIN: graphBin, MIXDOG_SKIP_USER_DATA_BACKUP: '1', MIXDOG_FEATURE_MEMORY: '0' };
  for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    env[name] = join(sandbox, name.toLowerCase());
    mkdirSync(env[name], { recursive: true });
  }
  Object.assign(env, scenario.env ?? {});
  const report = join(sandbox, 'job.json');
  const child = spawnInJob(process.execPath, [SELF, '--child'], { env, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], report });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  try {
    await deadline(exited, DEADLINE_MS, `scenario ${scenario.name}`);
  } catch (error) {
    // Ending the job's host closes the job, which ends every process in it.
    child.kill();
    await deadline(exited, 30_000, `scenario ${scenario.name}'s job host ending`);
    throw new Error(`${error.message}\n${output}`);
  }
  const job = readJobReport(report);
  if (job.exitCode !== 0) throw new Error(`scenario ${scenario.name} failed (${job.exitCode}):\n${output}`);
  const { calls: _calls, ...rest } = scenario;
  return { ...rest, calls: JSON.parse(readFileSync(join(sandbox, 'result.json'), 'utf8')) };
}

let failure = null;
try {
  const recorded = [];
  for (const scenario of selected) recorded.push(await recordScenario(scenario));
  if (only) {
    console.log(JSON.stringify(recorded[0], null, 1));
  } else {
    const finalDir = join(FIXTURES_ROOT, 'tools-fs-search');
    const stage = stageSet(finalDir);
    for (const scenario of recorded) writeJson(join(stage, `${scenario.name}.json`), scenario);
    writeSetManifest(stage, {
      set: 'tools-fs-search',
      recorder: RECORDER,
      command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}> --graph-bin <mixdog-graph built from ${NODE_COMMIT}:native/mixdog-graph> --scratch <scratch parent>`,
      identity,
      extra: {
        node: process.version,
        recorderSha256: sha256(readFileSync(SELF)),
        inputs: ['benchmarks/rust-core/recorders/lib/common.mjs', 'benchmarks/rust-core/recorders/lib/job-run.mjs'].map((path) => ({ path, sha256: sha256(readFileSync(join(REPO_ROOT, path))) })),
        graphBinary: { builtFrom: `${NODE_COMMIT}:native/mixdog-graph (cargo build --locked --bin mixdog-graph, dev profile)`, sha256: sha256(readFileSync(graphBin)) },
        scenarios: recorded.map((s) => s.name),
        normalised: [
          'the workspace path (backslash and forward-slash forms) is <ROOT> in every text',
          'a replay whose workspace lies under the home or Mixdog data folder reads that path\'s redacted spelling (~/…, <mixdog-data>/…) as <ROOT> too',
        ],
        exclusions: [
          'what each scenario process left running at its exit (Node\'s resident search server) is ended with its job and not recorded',
          'the answers of a scenario\'s warmup calls (they start the search server; the replay runs them too and ignores them)',
        ],
      },
    });
    commitStage(stage, finalDir);
    console.log(`recorded ${recorded.length} scenario(s)`);
  }
} catch (error) {
  failure = error;
}
if (failure) {
  console.error(`the run's folder ${run} is kept`);
  throw failure;
}
rmSync(run, { recursive: true, force: true });
process.exit(0);
