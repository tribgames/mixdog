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
//        [--patch <PATCHES>: the tree is the export with these fixes applied, in order: node-fix-code-graph-self-federation.patch (a
//        sentinel-free cwd took its own lowercased graph-cache root for a child and federated into itself) and
//        node-fix-glob-verbatim-path.patch (a `\\?\` glob path was split at its `?`: a missing one walked the drive root, the UNC
//        form slipped past the UNC refusal)]
//
// Output: native/core/fixtures/tools-fs-search/<scenario>.json (+ MANIFEST.json); with --only the one scenario is recorded and printed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-tools-fs-search.mjs';
const PATCHES = ['node-fix-code-graph-self-federation.patch', 'node-fix-glob-verbatim-path.patch'].map((p) => `benchmarks/rust-core/recorders/node-patches/${p}`).join(',');
const SELF = fileURLToPath(import.meta.url);
const DEADLINE_MS = 240_000;
// Every file of a workspace is dated here unless its scenario dates it otherwise (glob lists newest first).
const FIXED = '2026-01-02T03:04:05Z';

// A scenario: the workspace (`files`: path -> text; `junctions`: path -> the workspace directory it points at; `mtimes`: path -> ISO
// time), the folder the calls run in (`cwd`, under the workspace), unrecorded `warmup` calls and the calls, in order. `<ROOT>` in an input is the workspace
// path, written with forward slashes; `<ROOTW>` is the same path as Windows spells it (backslashes).
const notebook = (cells) => JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1);
// A 1x1 PNG, and its base64 cut into `width`-character lines.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const wrap = (text, width, eol) => text.match(new RegExp(`.{1,${width}}`, 'g')).join(eol);
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
  // The casing hint reads the resident graph's token index (search-references.mjs _formatNoSymbolMatches); the graph
  // stays resident while fewer than CODE_GRAPH_MEMORY_MAX_ENTRIES (6) other roots were used since (memory-cache.mjs), and
  // a graph rebuilt after its eviction knows no earlier lookup.
  {
    name: 'code-graph-casing-eviction',
    files: Object.fromEntries(
      ['a', ...Array.from({ length: 11 }, (_, i) => `p${i + 1}`)].flatMap((p) => [
        [`${p}/package.json`, '{}\n'],
        [`${p}/src/main.ts`, p === 'a' ? 'export class Widget {}\n' : `export const ${p} = 1;\n`],
      ])
    ),
    warmup: [{ tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['warmupNone'], cwd: '<ROOT>/a' } }],
    calls: [
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['Widget'], cwd: '<ROOT>/a' } },
      ...Array.from({ length: 5 }, (_, i) => ({ tool: 'code_graph', input: { mode: 'find_symbol', symbols: [`p${i + 1}`], cwd: `<ROOT>/p${i + 1}` } })),
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['widget'], cwd: '<ROOT>/a' } },
      ...Array.from({ length: 6 }, (_, i) => ({ tool: 'code_graph', input: { mode: 'find_symbol', symbols: [`p${i + 6}`], cwd: `<ROOT>/p${i + 6}` } })),
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['widget'], cwd: '<ROOT>/a' } },
    ],
  },
  // Every code_graph mode over a small sentinel-free tree (the cases of fixtures/tools/code_graph, recorded through the
  // tool's entry with their outcome).
  {
    name: 'code-graph-modes',
    files: {
      'src/lib/math.mjs': 'export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n',
      'src/lib/util.mjs': "import { add } from './math.mjs';\n\nexport const twice = (x) => add(x, x);\n",
      'src/main.mjs': "import { add, sub } from './lib/math.mjs';\n\nexport function main() {\n  return add(1, 2) + sub(5, 3);\n}\n\nexport function other() {\n  return add(3, 4);\n}\n",
      'src/app.py': 'def greet(name):\n    return name\n\n\nclass Greeter:\n    def run(self):\n        return 1\n',
    },
    warmup: [{ tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['warmupNone'] } }],
    calls: [
      { tool: 'code_graph', input: { mode: 'nope' } },
      { tool: 'code_graph', input: { files: ['src/missing.mjs'], mode: 'symbols' } },
      { tool: 'code_graph', input: { mode: 'find_symbol' } },
      { tool: 'code_graph', input: { file: 'src/lib/math.mjs', mode: 'symbols' } },
      { tool: 'code_graph', input: { mode: 'callees', symbols: ['main'] } },
      { tool: 'code_graph', input: { depth: 2, mode: 'callers', symbols: ['add'] } },
      { tool: 'code_graph', input: { mode: 'callers', symbols: ['add'] } },
      { tool: 'code_graph', input: { files: ['src/lib/math.mjs'], mode: 'dependents' } },
      { tool: 'code_graph', input: { body: false, mode: 'find_symbol', symbols: ['add'] } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['add'] } },
      { tool: 'code_graph', input: { files: ['src/lib/math.mjs'], mode: 'impact' } },
      { tool: 'code_graph', input: { files: ['src/main.mjs'], mode: 'imports' } },
      { tool: 'code_graph', input: { depth: 2, files: ['src/main.mjs'], mode: 'overview' } },
      { tool: 'code_graph', input: { files: ['src/main.mjs'], mode: 'overview' } },
      { tool: 'code_graph', input: { body: true, limit: 2, mode: 'references', symbols: ['add'] } },
      { tool: 'code_graph', input: { mode: 'references', symbols: ['add'] } },
      { tool: 'code_graph', input: { files: ['src/lib/math.mjs'], mode: 'related' } },
      { tool: 'code_graph', input: { mode: 'search', symbols: ['twice'] } },
      { tool: 'code_graph', input: { mode: 'symbol_search', symbols: ['gree'] } },
      { tool: 'code_graph', input: { files: ['src/lib/math.mjs'], mode: 'symbols', symbols: ['sub'] } },
      { tool: 'code_graph', input: { files: ['src/app.py'], mode: 'symbols' } },
      { tool: 'code_graph', input: { files: ['src/lib/math.mjs'], mode: 'symbols' } },
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
      // Mixed separators: Node's win32 resolve reads `/\` and `\/` as a UNC or device root too.
      { tool: 'glob', input: { pattern: '/\\server/share/x/*.ts' } },
      { tool: 'glob', input: { pattern: '\\/server/share/x/*.ts' } },
      { tool: 'glob', input: { pattern: '\\\\?\\C:\\x\\*.ts' } },
      { tool: 'glob', input: { pattern: '\\\\.\\C:\\x\\*.ts' } },
      { tool: 'glob', input: { pattern: '/\\./C:/x/*.ts' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '/\\server/share' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '\\/server/share/dir' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '/\\server/share/a/../b/./c' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '\\\\.\\C:\\x' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '//./C:/x' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '\\/./C:/x' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '/\\./C:/x' } },
    ],
  },
  // The resident graphs' memory budget (memory-cache.mjs _pruneCodeGraphMemoryCache, graph-model.mjs
  // _estimateGraphRetainedBytes) at 1 MB: a graph's retained bytes are its node records, token index and source caches,
  // not its files' text. Each `widget` after a `Widget` shows whether the first root's lookups survived.
  {
    name: 'code-graph-memory-budget',
    env: { MIXDOG_CODE_GRAPH_MEMORY_MAX_MB: '1' },
    files: {
      'a/package.json': '{}\n',
      'a/src/main.ts': 'export class Widget {}\n',
      'text/package.json': '{}\n',
      'text/src/main.ts': `// ${'x'.repeat(600000)}\nexport const t = 1;\n`,
      'pa/package.json': '{}\n',
      'pa/src/main.ts': `// ${'x'.repeat(600000)}\nexport const pa = 1;\n`,
      'pb/package.json': '{}\n',
      'pb/src/main.ts': `// ${'x'.repeat(600000)}\nexport const pb = 1;\n`,
      'mid/package.json': '{}\n',
      'mid/src/main.ts': `${Array.from({ length: 800 }, (_, i) => `export const m${i} = ${i};`).join('\n')}\n`,
      'big/package.json': '{}\n',
      'big/src/main.ts': `${Array.from({ length: 3000 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`,
    },
    warmup: [{ tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['warmupNone'], cwd: '<ROOT>/a' } }],
    calls: [
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['Widget'], cwd: '<ROOT>/a' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['t'], cwd: '<ROOT>/text' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['widget'], cwd: '<ROOT>/a' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['Widget'], cwd: '<ROOT>/a' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['zzz'], cwd: '<ROOT>/pa' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['zzz'], cwd: '<ROOT>/pb' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['widget'], cwd: '<ROOT>/a' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['m1'], cwd: '<ROOT>/mid' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['widget'], cwd: '<ROOT>/a' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['v1'], cwd: '<ROOT>/big' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['widget'], cwd: '<ROOT>/a' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['v2'], cwd: '<ROOT>/big' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['V2'], cwd: '<ROOT>/big' } },
    ],
  },
  // A missing grep path whose basename scans end inconclusive (past their 6000 directories) is looked up as a
  // `**/<basename>` glob (search-path-diagnostics.mjs _suggestIndexedPaths); `list` has no such fallback.
  // `bulkDirs` makes <dir>/<00000..count-1>, empty.
  {
    name: 'grep-missing-indexed',
    files: {
      'zz/sub/nope.txt': 'n\n',
      ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`zz/m${i}/other.txt`, 'o\n'])),
    },
    bulkDirs: { dir: 'd', count: 6100 },
    warmup: [{ tool: 'grep', input: { pattern: 'warmup-none' } }],
    calls: [
      { tool: 'grep', input: { pattern: 'x', path: 'nope.txt' } },
      { tool: 'grep', input: { pattern: 'x', path: 'zz/nope.txt' } },
      { tool: 'grep', input: { pattern: 'x', path: 'other.txt' } },
      { tool: 'grep', input: { pattern: 'x', path: 'none.md' } },
      { tool: 'grep', input: { pattern: 'x', path: ['nope.txt'] } },
      { tool: 'list', input: { path: 'nope.txt' } },
    ],
  },
  // A notebook image whose base64 is wrapped with line breaks is decoded as Node's Buffer.from(b64, 'base64') decodes
  // it (read-special-files.mjs notebookImageBlocks). `resizer`: the images the resize service (sharp, the core's
  // extension host) is asked to resize, with its replies, recorded through resizeImageBuffer.
  {
    name: 'read-ipynb-image',
    resizerImages: [PNG_B64],
    files: {
      'img.ipynb': notebook([
        { cell_type: 'code', execution_count: 1, metadata: {}, source: ['plot()'], outputs: [
          { output_type: 'display_data', metadata: {}, data: { 'image/png': wrap(PNG_B64, 16, '\n') } },
        ] },
      ]),
      'lines.ipynb': notebook([
        { cell_type: 'code', execution_count: 1, metadata: {}, source: ['plot()'], outputs: [
          { output_type: 'display_data', metadata: {}, data: { 'image/png': wrap(PNG_B64, 20, '\n').split(/(?<=\n)/) } },
        ] },
      ]),
      'crlf.ipynb': notebook([
        { cell_type: 'code', execution_count: 1, metadata: {}, source: ['plot()'], outputs: [
          { output_type: 'display_data', metadata: {}, data: { 'image/png': ` ${wrap(PNG_B64, 12, '\r\n')}\r\n` } },
        ] },
      ]),
      'plain.ipynb': notebook([
        { cell_type: 'code', execution_count: 1, metadata: {}, source: ['plot()'], outputs: [
          { output_type: 'display_data', metadata: {}, data: { 'image/png': PNG_B64 } },
        ] },
      ]),
    },
    calls: [
      { tool: 'read', input: { path: 'img.ipynb', full: true } },
      { tool: 'read', input: { path: 'lines.ipynb', full: true } },
      { tool: 'read', input: { path: 'crlf.ipynb', full: true } },
      { tool: 'read', input: { path: 'plain.ipynb', full: true } },
    ],
  },
  // gaps-tools item 11: past GLOB_ACCUM_CAP (50 000) matches an unbounded glob keeps the first 50 000 and says the list is
  // incomplete (search-glob-tool.mjs); a bounded one still counts every match. `bulk` writes <dir>/<00000..count-1><ext>, empty.
  {
    name: 'glob-past-cap',
    files: { 'zz/last-one.txt': '' },
    bulk: { dir: 'f', count: 50000, ext: '.txt' },
    warmup: [{ tool: 'glob', input: { pattern: '*.none' } }],
    calls: [
      { tool: 'glob', input: { pattern: '**/*.txt', limit: 0 } },
      { tool: 'glob', input: { pattern: '**/*.txt' } },
      { tool: 'glob', input: { pattern: 'f/*.txt', limit: 0 } },
      { tool: 'glob', input: { pattern: '**/*.txt', limit: 0, offset: 49990 } },
      { tool: 'glob', input: { pattern: '**/*.txt', limit: 20, offset: 49990 } },
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
  // A `path` (or `root`) that is not a non-empty string, an array included, is refused before the tool runs (arg-guard.mjs, the
  // glob guard): `glob arg "path" must be string (got <type>)` / `must be a non-empty string`.
  {
    name: 'glob-path-array',
    files: { 'a/x.ts': 'x\n', 'b/y.ts': 'y\n', 'top.ts': 't\n' },
    warmup: [{ tool: 'glob', input: { pattern: '*.none' } }],
    calls: [
      { tool: 'glob', input: { pattern: '*.ts', path: ['a', 'b'] } },
      { tool: 'glob', input: { pattern: '*.ts', path: ['a'] } },
      { tool: 'glob', input: { pattern: '*.ts', path: [] } },
      { tool: 'glob', input: { pattern: '*.ts', path: ['a', '//server/share'] } },
      { tool: 'glob', input: { pattern: '*.ts', path: ['/\\server/share', 'b'] } },
      { tool: 'glob', input: { pattern: ['*.ts', '//server/share/*.ts'], path: ['a', 'b'] } },
      { tool: 'glob', input: { pattern: '*.ts', path: 3 } },
      { tool: 'glob', input: { pattern: '*.ts', path: null } },
      { tool: 'glob', input: { pattern: '*.ts', path: { p: 'a' } } },
      { tool: 'glob', input: { pattern: '*.ts', path: true } },
      { tool: 'glob', input: { pattern: '*.ts', path: '' } },
      { tool: 'glob', input: { pattern: '*.ts', path: ' \t ' } },
      { tool: 'glob', input: { pattern: '*.ts', root: ['a'] } },
      { tool: 'glob', input: { pattern: '*.ts', root: '' } },
      { tool: 'glob', input: { pattern: '*.ts', path: 'a', root: ['b'] } },
      { tool: 'glob', input: { pattern: '*.ts', path: 'a' } },
    ],
  },
  // A Win32 verbatim path (`\\?\C:\x`, `\\?\UNC\…`), as a glob path or pattern, is a UNC/device spelling and refused
  // (search-glob-tool.mjs globUncRefusal); with node-fix-glob-verbatim-path.patch globBaseEntry no longer splits a missing one at
  // its `?` into a walk of the drive root.
  {
    name: 'glob-verbatim',
    files: { 'a/x.ts': 'x\n', 'a/sub/y.ts': 'y\n', 'top.ts': 't\n' },
    warmup: [{ tool: 'glob', input: { pattern: '*.none' } }],
    calls: [
      { tool: 'glob', input: { pattern: '*.ts', path: '\\\\?\\<ROOTW>\\a' } },
      { tool: 'glob', input: { pattern: '**/*.ts', path: '\\\\?\\<ROOTW>\\a' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '//?/<ROOT>/a' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '\\\\?\\<ROOTW>\\nope' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '\\\\?\\UNC\\server\\share' } },
      { tool: 'glob', input: { pattern: '*.ts', path: '//?/UNC/server/share' } },
      { tool: 'glob', input: { pattern: '\\\\?\\<ROOTW>\\a\\*.ts' } },
      { tool: 'glob', input: { pattern: '//?/<ROOT>/a/*.ts' } },
      { tool: 'glob', input: { pattern: '\\\\?\\UNC\\server\\share\\*.ts' } },
      { tool: 'glob', input: { path: '\\\\?\\<ROOTW>\\a\\*.ts' } },
      { tool: 'glob', input: { pattern: '*.ts', path: ['\\\\?\\<ROOTW>\\a', '.'] } },
    ],
  },
  // Non-alphabet characters in a notebook image's base64 (read-special-files.mjs notebookImageBlocks, Buffer.from(b64, 'base64')):
  // each UTF-16 code unit is looked up by its low byte, so a character whose low byte is an alphabet letter adds a sextet (and
  // spoils the PNG), one whose low byte is `=` ends the decoding. `resizerImages` records the resize service on Node's bytes.
  ...(() => {
    const at = 20;
    const spliced = (junk, b64 = PNG_B64) => `${b64.slice(0, at)}${junk}${b64.slice(at)}`;
    const urlSafe = PNG_B64.replace(/\+/g, '-').replace(/\//g, '_');
    const cases = {
      'latin1.ipynb': spliced('é\u00ff\u00c1'),
      'two-byte-skipped.ipynb': spliced('\u0100\u020a'),
      'two-byte-letter.ipynb': spliced('Ł'),
      'three-byte-skipped.ipynb': spliced('€'),
      'three-byte-letter.ipynb': spliced('\u4e41'),
      'three-byte-pad.ipynb': spliced('\u4e3d'),
      'astral.ipynb': spliced('😀'),
      'url-safe-letters.ipynb': spliced('\u012d\u015f\u0100\u0141', urlSafe),
      'url-safe-skipped.ipynb': spliced('é\u0100', urlSafe),
      'after-padding.ipynb': `${PNG_B64}Ł😀`,
      'short.ipynb': 'ZŁg==',
    };
    const imageNotebook = (b64) =>
      notebook([{ cell_type: 'code', execution_count: 1, metadata: {}, source: ['plot()'], outputs: [{ output_type: 'display_data', metadata: {}, data: { 'image/png': b64 } }] }]);
    return [{
      name: 'read-ipynb-base64-junk',
      resizerImages: [...new Set([PNG_B64, ...Object.values(cases)])],
      files: Object.fromEntries(Object.entries(cases).map(([name, b64]) => [name, imageNotebook(b64)])),
      calls: Object.keys(cases).map((name) => ({ tool: 'read', input: { path: name, full: true } })),
    }];
  })(),
  // A sentinel-free cwd spelled in another case than the graph built for it (code-graph/dispatch/federation.mjs notSelf, with
  // node-fix-code-graph-self-federation.patch): Windows paths compare without case, so the cwd is never a child of itself.
  {
    name: 'code-graph-self-case',
    files: {
      'mono/src/a.ts': 'export const alpha = 1;\n',
      'mono/src/b.ts': "import { alpha } from './a';\n\nexport function beta() {\n  return alpha;\n}\n",
    },
    warmup: [{ tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['warmupNone'], cwd: '<ROOT>/mono' } }],
    // The warmup's graph is written to the disk cache (drainCodeGraphCache) before the calls, so its root is a cached
    // root (listCachedCodeGraphRoots) when they plan their federation.
    drainAfterWarmup: true,
    calls: [
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['alpha'], cwd: '<ROOT>/mono' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['alpha'], cwd: '<ROOT>/MONO' } },
      { tool: 'code_graph', input: { mode: 'references', symbols: ['alpha'], cwd: '<ROOT>/Mono' } },
      { tool: 'code_graph', input: { mode: 'symbols', file: 'src/b.ts', cwd: '<ROOT>/MONO' } },
      { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['beta'], cwd: '<ROOT>/mono' } },
    ],
  },
  // grep over several paths (lib/grep-path-fanout.mjs): each path's section gets the call's context budget divided by the
  // number of paths (`Math.max(512, Math.floor(budget / paths))`), and executeBuiltinTool caps the assembled text at
  // GREP_OUTPUT_MAX_BYTES with _grepBudgetFooter (builtin.mjs _budgetBuiltinOutput).
  ...(() => {
    const dirs = ['a', 'b', 'c', 'd', 'e'];
    const big = (d) =>
      `${Array.from({ length: 90 }, (_, i) => (i % 3 === 0 ? `export const ${d}${i} = "hit ${d}${i} ${'x'.repeat(70)}";` : `const ${d}${i}_pad = ${i}; // ${'y'.repeat(40)}`)).join('\n')}\n`;
    const files = Object.fromEntries(dirs.map((d) => [`${d}/big.ts`, big(d)]));
    files['a/few.ts'] = 'const one = 1;\nexport const rare = "needle";\nconst two = 2;\n';
    files['b/few.ts'] = 'export const rare2 = "needle";\n';
    const two = ['a', 'b'];
    return [{
      name: 'grep-path-budget',
      files,
      warmup: [{ tool: 'grep', input: { pattern: 'warmup-none' } }],
      calls: [
        { tool: 'grep', input: { pattern: 'hit', path: two } },
        { tool: 'grep', input: { pattern: 'hit', path: dirs } },
        { tool: 'grep', input: { pattern: 'hit', path: two, mode: 'count' } },
        { tool: 'grep', input: { pattern: 'hit', path: dirs, mode: 'count' } },
        { tool: 'grep', input: { pattern: 'hit', path: two, mode: 'files' } },
        { tool: 'grep', input: { pattern: 'hit', path: two, context: 2 } },
        { tool: 'grep', input: { pattern: 'hit', path: two, context: 0 } },
        { tool: 'grep', input: { pattern: 'hit', path: dirs, context: 0 } },
        { tool: 'grep', input: { pattern: 'hit', path: two, limit: 3, offset: 2 } },
        { tool: 'grep', input: { pattern: 'hit', path: two, limit: 3, offset: 2, context: 0 } },
        { tool: 'grep', input: { pattern: 'hit', path: ['a', 'nope', 'b'] } },
        { tool: 'grep', input: { pattern: 'needle', path: two } },
        { tool: 'grep', input: { pattern: 'hit', path: 'a' } },
        { tool: 'grep', input: { pattern: 'hit', path: ['a'] } },
        { tool: 'grep', input: { pattern: 'hit', path: 'a', context: 0 } },
        { tool: 'grep', input: { pattern: 'needle', path: 'a' } },
      ],
    }];
  })(),
  // grep's rendering, each for one path and for several (search-grep-tool.mjs, lib/grep-path-fanout.mjs,
  // lib/grep-context-expander.mjs, lib/grep-output.mjs): more than 40 matches in context mode (automatic, explicit N, 0),
  // the head/tail selection and the offset it reports with its follow-up, the anchor stream's bound, long lines, several
  // patterns, a binary file and invalid UTF-8 among text files, files and count over five paths past the final cap, a
  // match on the first and the last line of a file without a trailing newline, offsets past the end. `filesBase64`
  // holds the files that are not UTF-8 text.
  ...(() => {
    const many = (tag, n) => `${Array.from({ length: n * 2 }, (_, i) => (i % 2 === 0 ? `export const ${tag}${i} = "hit ${tag}";` : `// pad ${tag} ${i}`)).join('\n')}\n`;
    const lines = (n, f) => `${Array.from({ length: n }, (_, i) => f(i)).join('\n')}\n`;
    const files = {
      'm/many.ts': many('m', 60),
      'n/many.ts': many('n', 70),
      'big/huge.ts': lines(300, (i) => `hit ${i}`),
      'huge/h.ts': lines(5000, (i) => `hit ${i}`),
      'edge/edges.ts': 'edge first\nmiddle 1\nmiddle 2\nmiddle 3\nedge last',
      'long/long.ts': `${[
        'pre 1',
        `hit ${'a'.repeat(496)}`,
        `${'é'.repeat(300)} hit`,
        `hit ${'b'.repeat(495)}`,
        `ctx ${'c'.repeat(700)}`,
        'post hit',
        `${'d'.repeat(1000)} hit ${'e'.repeat(10)}`,
        `hit ${'f'.repeat(1200)}`,
      ].join('\n')}\n`,
      'bin/ok.ts': 'export const ok = "hit";\n',
      // Several patterns' attribution (lib/grep-pattern-fanout.mjs attributeCombinedLines): each JavaScript regex is
      // tested on the clipped output line, so a match past column 500 or one only ripgrep's dialect sees is unattributed.
      'attr/a.ts': lines(6, (i) => [
        `${'x'.repeat(520)} needle`,
        'needle and other',
        'just other',
        `${'y'.repeat(510)} other needle`,
        `needle ${'z'.repeat(600)}`,
        'q7 posix class',
      ][i]),
    };
    const mtimes = {};
    for (const d of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      for (let i = 0; i < 40; i++) files[`${d}/file_with_a_rather_long_name_${String(i).padStart(2, '0')}.ts`] = lines((i % 5) + 1, (k) => `hit ${d} ${i} ${k}`);
    }
    mtimes['f1/file_with_a_rather_long_name_07.ts'] = '2026-03-01T00:00:00Z';
    mtimes['f1/file_with_a_rather_long_name_31.ts'] = '2026-02-01T00:00:00Z';
    mtimes['f1/file_with_a_rather_long_name_02.ts'] = '2025-12-01T00:00:00Z';
    const filesBase64 = {
      'bin/blob.bin': Buffer.from('hit before\n\0\0binary hit\nhit after\n', 'latin1').toString('base64'),
      'bin/bad.ts': Buffer.concat([
        Buffer.from('const a = 1;\nbad ', 'latin1'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from(' hit here\nctx ', 'latin1'),
        Buffer.from([0xc3]),
        Buffer.from(' after\nlast hit \xe9\n', 'latin1'),
      ]).toString('base64'),
    };
    const two = ['m', 'n'];
    const five = ['f1', 'f2', 'f3', 'f4', 'f5'];
    const both = (input, paths = two, single = 'm') => [
      { tool: 'grep', input: { ...input, path: single } },
      { tool: 'grep', input: { ...input, path: paths } },
    ];
    return [{
      name: 'grep-render',
      files,
      filesBase64,
      mtimes,
      warmup: [{ tool: 'grep', input: { pattern: 'warmup-none' } }],
      calls: [
        ...both({ pattern: 'hit' }),
        ...both({ pattern: 'hit', context: 3 }),
        ...both({ pattern: 'hit', context: 0 }),
        ...both({ pattern: 'hit', context: 0, limit: 100 }),
        ...both({ pattern: 'hit', limit: 100 }),
        ...both({ pattern: 'hit', limit: 100, offset: 20 }),
        ...both({ pattern: 'hit', limit: 7 }),
        ...both({ pattern: 'hit', limit: 7, offset: 4 }),
        ...both({ pattern: 'hit', context: 0, limit: 7, offset: 4 }),
        ...both({ pattern: 'hit', context: 3, limit: 7 }),
        ...both({ pattern: 'hit', offset: 500 }),
        ...both({ pattern: 'hit', context: 0, offset: 500 }),
        ...both({ pattern: 'hit' }, ['big', 'm'], 'big'),
        ...both({ pattern: 'hit', limit: 10 }, ['big', 'm'], 'big'),
        ...both({ pattern: 'hit', limit: 0 }, ['huge', 'big'], 'huge'),
        ...both({ pattern: 'hit', context: 0, limit: 0 }, ['huge', 'big'], 'huge'),
        ...both({ pattern: 'hit', context: 0 }, ['huge', 'big'], 'huge'),
        ...both({ pattern: 'hit' }, ['long', 'edge'], 'long'),
        ...both({ pattern: 'hit', context: 0 }, ['long', 'edge'], 'long'),
        ...both({ pattern: 'hit', limit: 2 }, ['long', 'm'], 'long'),
        ...both({ pattern: ['hit', 'pad'] }),
        ...both({ pattern: ['hit', 'pad'], context: 0, limit: 5 }),
        ...both({ pattern: ['edge', 'middle'] }, ['edge', 'm'], 'edge'),
        ...both({ pattern: 'hit' }, ['bin', 'edge'], 'bin'),
        ...both({ pattern: 'hit', context: 0 }, ['bin', 'edge'], 'bin'),
        ...both({ pattern: 'hit', context: 1 }, ['bin/bad.ts', 'bin/ok.ts'], 'bin/bad.ts'),
        ...both({ pattern: 'hit', context: 0 }, ['bin/bad.ts', 'bin/blob.bin'], 'bin/blob.bin'),
        ...both({ pattern: 'hit', mode: 'files' }, five, 'f1'),
        ...both({ pattern: 'hit', mode: 'count' }, five, 'f1'),
        ...both({ pattern: 'hit', mode: 'files', limit: 10, offset: 5 }, five, 'f1'),
        ...both({ pattern: 'hit', mode: 'count', limit: 3 }, five, 'f1'),
        ...both({ pattern: 'hit', mode: 'files', offset: 100 }, five, 'f1'),
        ...both({ pattern: 'hit', mode: 'count', offset: 100 }, five, 'f1'),
        ...both({ pattern: 'zzz-none', mode: 'count' }, five, 'f1'),
        ...both({ pattern: 'zzz-none', mode: 'files' }, five, 'f1'),
        ...both({ pattern: 'hit' }, ['m', 'n', 'big', 'long', 'f1'], 'f1'),
        ...both({ pattern: 'hit', context: 0 }, ['m', 'n', 'big', 'long', 'f1'], 'f1'),
        ...both({ pattern: 'edge' }, ['edge', 'm'], 'edge'),
        ...both({ pattern: 'edge', context: 2 }, ['edge', 'm'], 'edge'),
        ...both({ pattern: 'edge', context: 0 }, ['edge', 'm'], 'edge'),
        ...both({ pattern: 'edge' }, ['edge/edges.ts', 'm'], 'edge/edges.ts'),
        ...both({ pattern: 'last', context: 3 }, ['edge/edges.ts', 'bin/ok.ts'], 'edge/edges.ts'),
        ...both({ pattern: 'needle' }, ['attr', 'edge'], 'attr'),
        ...both({ pattern: ['needle', 'other'] }, ['attr', 'edge'], 'attr'),
        ...both({ pattern: ['needle', 'other'], context: 0 }, ['attr', 'edge'], 'attr'),
        ...both({ pattern: ['needle', 'other'], context: 2 }, ['attr', 'edge'], 'attr'),
        ...both({ pattern: ['q[[:digit:]]', 'other'] }, ['attr', 'edge'], 'attr'),
        ...both({ pattern: ['q[[:digit:]]', 'other'], context: 0 }, ['attr', 'edge'], 'attr'),
        ...both({ pattern: ['zzz1', 'zzz2'] }, ['attr', 'edge'], 'attr'),
        ...both({ pattern: ['zzz1', 'zzz2'], context: 0 }, ['attr', 'edge'], 'attr'),
        // The pattern list (grep-request.mjs resolveGrepRequest): non-empty, each once, the first 10 with a note.
        ...both({ pattern: ['other', '', 'other'], context: 0 }, ['attr', 'edge'], 'attr'),
        ...both({ pattern: ['just', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'other'], context: 0 }, ['attr', 'edge'], 'attr'),
        ...both({ pattern: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'just'], output_mode: 'files_with_matches' }, ['attr', 'edge'], 'attr'),
      ],
    }];
  })(),
  // Every non-string path shape at each path-taking tool (arg-guard.mjs validateBuiltinArgs: null dropped, a blank optional
  // path dropped, a path array flattened one level with blank entries dropped and removed when nothing is left, then the
  // tool's guard; `grep` keeps a path array as its scopes; `edit` (`file_path`) has no guard; code_graph is answered by
  // executeCodeGraphTool, which no guard precedes).
  ...(() => {
    const shapes = [['a', 'b'], ['a'], [], 3, { p: 'a' }, true, null, '', ' \t ', ['', null], [['a']]];
    return [{
      name: 'path-arg-shapes',
      files: {
        'a/x.ts': 'export const xa = 1;\n',
        'b/xy.ts': 'export const xb = 2;\n',
        'top.ts': 'export const top = 3;\n',
      },
      warmup: [{ tool: 'grep', input: { pattern: 'warmup-none' } }, { tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['warmupNone'] } }],
      calls: [
        ...shapes.map((path) => ({ tool: 'list', input: { path } })),
        ...shapes.map((path) => ({ tool: 'find', input: { query: 'x', path } })),
        ...shapes.map((path) => ({ tool: 'glob', input: { pattern: '*.ts', path } })),
        ...shapes.map((path) => ({ tool: 'grep', input: { pattern: 'export', path } })),
        { tool: 'grep', input: { pattern: 'export', path: ['a', ''] } },
        // Several scopes: one `# grep <path>` section each, a scope without a hit in the closing no-match line, a missing
        // one answered in its own section, duplicates and padding dropped.
        { tool: 'grep', input: { pattern: 'xb', path: ['a', 'b', 'top.ts'] } },
        { tool: 'grep', input: { pattern: 'export', path: ['a', 'nope', ' a ', 'top.ts'] } },
        { tool: 'grep', input: { pattern: 'zzz', path: ['a', 'b'] } },
        { tool: 'grep', input: { pattern: 'export', path: ['a', 'b'], mode: 'files' } },
        { tool: 'grep', input: { pattern: 'export', path: Array.from({ length: 11 }, (_, i) => `p${i}`) } },
        ...shapes.map((path) => ({ tool: 'read', input: { path } })),
        ...[['top.ts'], 3, null, ''].map((file_path) => ({ tool: 'read', input: { file_path } })),
        ...shapes.map((file_path) => ({ tool: 'edit', input: { file_path, old_string: 'nothing-here', new_string: 'y' } })),
        ...shapes.map((cwd) => ({ tool: 'code_graph', input: { mode: 'find_symbol', symbols: ['xa'], cwd } })),
        ...shapes.map((files) => ({ tool: 'code_graph', input: { mode: 'symbols', files } })),
        ...shapes.map((file) => ({ tool: 'code_graph', input: { mode: 'symbols', file } })),
        ...[false, 0].map((file) => ({ tool: 'code_graph', input: { mode: 'symbols', file } })),
        ...['find_symbol', 'references', 'callers', 'overview', 'imports', 'dependents', 'search'].map((mode) => ({
          tool: 'code_graph',
          input: { mode, symbols: ['xa'], file: 3 },
        })),
        ...[[3], [true], [{ p: 'a' }], [['a', 'b']], ['a', null]].map((files) => ({ tool: 'code_graph', input: { mode: 'symbols', files } })),
      ],
    }];
  })(),
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
  for (const [rel, b64] of Object.entries(scenario.filesBase64 ?? {})) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), Buffer.from(b64, 'base64'));
  }
  for (const [rel, target] of Object.entries(scenario.junctions ?? {})) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    symlinkSync(join(ws, target), join(ws, rel), 'junction');
  }
  for (const rel of [...Object.keys(scenario.files ?? {}), ...Object.keys(scenario.filesBase64 ?? {})]) {
    const at = new Date(scenario.mtimes?.[rel] ?? FIXED);
    utimesSync(join(ws, rel), at, at);
  }
  if (scenario.bulk) {
    const { dir, count, ext } = scenario.bulk;
    mkdirSync(join(ws, dir), { recursive: true });
    for (let i = 0; i < count; i++) {
      const file = join(ws, dir, `${String(i).padStart(5, '0')}${ext}`);
      writeFileSync(file, '');
      utimesSync(file, new Date(FIXED), new Date(FIXED));
    }
  }
  if (scenario.bulkDirs) {
    const { dir, count } = scenario.bulkDirs;
    for (let i = 0; i < count; i++) mkdirSync(join(ws, dir, String(i).padStart(5, '0')), { recursive: true });
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
  // A rich answer is its JSON text, where the workspace's backslashes are escaped.
  const scrub = (text) => String(text).replaceAll(JSON.stringify(ws).slice(1, -1), '<ROOT>').replaceAll(ws, '<ROOT>').replaceAll(fwd, '<ROOT>');
  const cwd = scenario.cwd ? join(ws, scenario.cwd) : ws;
  // Unrecorded calls first: the search server's first start can miss Node's 1 s readiness bound, which is a cold-start
  // artefact of the recording machine, not an answer.
  for (const call of scenario.warmup ?? []) {
    const run = call.tool === 'code_graph' ? executeCodeGraphTool('code_graph', call.input, cwd) : executeBuiltinTool(call.tool, call.input, cwd);
    await run.catch(() => {});
  }
  if (scenario.drainAfterWarmup) {
    const { drainCodeGraphCache } = await imp('src/runtime/agent/orchestrator/tools/code-graph/disk-cache.mjs');
    drainCodeGraphCache();
  }
  const calls = [];
  for (const call of scenario.calls) {
    const input = JSON.parse(JSON.stringify(call.input).replaceAll('<ROOT>', fwd).replaceAll('<ROOTW>', JSON.stringify(ws).slice(1, -1)));
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
  // The resize service's replies, from the module the extension host answers with, on the original image bytes.
  let resizer;
  if (scenario.resizerImages) {
    const { resizeImageBuffer } = await imp('src/runtime/shared/read-image-resize.mjs');
    resizer = [];
    for (const b64 of scenario.resizerImages) {
      const bytes = Buffer.from(b64, 'base64');
      const inputSha256 = createHash('sha256').update(bytes).digest('hex');
      if (resizer.some((r) => r.inputSha256 === inputSha256)) continue;
      // Bytes the decoder rejects (InvalidImageDataError) are recorded as such: the read shows no image for them.
      try {
        resizer.push({ inputSha256, ext: 'png', reply: await resizeImageBuffer(bytes, 'png') });
      } catch (error) {
        if (error?.code !== 'INVALID_IMAGE_DATA') throw error;
        resizer.push({ inputSha256, ext: 'png', invalid: true });
      }
    }
  }
  writeFileSync(process.env.RECORDER_RESULT, JSON.stringify({ calls, resizer }));
  process.exit(0);
}

const { FIXTURES_ROOT, REPO_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { readJobReport, spawnInJob } = await import('./lib/job-run.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
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
  const { calls: _calls, resizerImages: _images, ...rest } = scenario;
  const { calls, resizer } = JSON.parse(readFileSync(join(sandbox, 'result.json'), 'utf8'));
  return { ...rest, ...(resizer ? { resizer } : {}), calls };
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
      command: `node ${RECORDER} --tree <export of ${NODE_COMMIT} with the --patch fixes applied> --patch ${PATCHES} --graph-bin <mixdog-graph built from ${NODE_COMMIT}:native/mixdog-graph> --scratch <scratch parent>`,
      identity,
      extra: {
        ...recorderProvenance(import.meta.url),
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
