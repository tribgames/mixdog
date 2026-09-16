// AST call-site path for callers / callees / references, exercised through the
// public dispatch entry with an injected in-memory graph. Fixtures carry the
// native `calls` WIRE V2 contract — one tuple per call site:
//   [name, line(1-based), col(0-based char), kind(0 call|1 method|2 new),
//    recv(""=absent), inSymbol(""=top level)]
// The cache half (sidecar) is exercised against a temp MIXDOG_DATA_DIR.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Every disk-cache write in this file must land in a throwaway dir, never in
// the user's real plugin data. resolvePluginData() reads the env per call, so
// setting it before the first disk-cache call is enough.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-calls-cache-'));
process.env.MIXDOG_DATA_DIR = DATA_DIR;
process.on('exit', () => {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const { codeGraph } = await import('./dispatch.mjs');
const { _attachGraphRuntimeCaches, _serializeGraph, _deserializeGraph } = await import('./graph-model.mjs');
const {
  _fileInfoFromRustRecord,
  _reuseFileInfo,
  _setCallsWireV2ForTest,
  _ensureCallsWireProbe,
  _callsWireV2Enabled,
  _noteCallsWireFromRecords,
  callsWireSignatureToken,
} = await import('./graph-binary.mjs');
const { _astCalls } = await import('./ast-calls.mjs');
const { _setDiskCodeGraphEntry, drainCodeGraphCacheStrict, getDiskCodeGraphEntry, hydrateGraphCallsFromSidecar } =
  await import('./disk-cache.mjs');
const { canonicalGraphCwd } = await import('../code-graph-state.mjs');

const runNode = promisify(execFile);
const graphBinary = resolve(
  'native/mixdog-graph/target/release',
  process.platform === 'win32' ? 'mixdog-graph.exe' : 'mixdog-graph'
);

const CWD = process.cwd();

// Native symbol record v2: unified kinds (variable, not 'binding'), optional
// exported/sig/parent. `parent` is the innermost enclosing symbol NAME — the
// only containment signal, so a class fixture must state it on its members.
function sym(name, kind, startLine, endLine, startCol = 1, extra = {}) {
  return {
    name,
    kind,
    startLine,
    endLine,
    startCol,
    endCol: startCol + String(name).length,
    ...(extra.exported ? { exported: true } : {}),
    ...(extra.sig ? { sig: extra.sig } : {}),
    ...(extra.parent ? { parent: extra.parent } : {}),
  };
}

// The binary ships an identifier/word token list per file; these fixtures
// mirror that payload instead of re-deriving one at query time (the JS
// re-tokenizer is gone — native `tokens` are the only source).
function fixtureTokens(text) {
  return [...new Set(String(text || '').match(/[A-Za-z_$][\w$]*/g) || [])];
}

const KIND_INDEX = { call: 0, method: 1, new: 2 };

// One wire-v2 tuple. Positional and complete: the decoder accepts nothing else.
function call(name, line, col, kind = 'call', inSymbol = '', recv = '') {
  return [name, line, col, KIND_INDEX[kind], recv, inSymbol];
}

function makeNode(
  rel,
  lang,
  text,
  { symbols = [], calls = null, imports = [], tokenSymbols = fixtureTokens(text), rawImports = imports } = {}
) {
  return {
    node: {
      abs: resolve(CWD, rel),
      rel,
      lang,
      fingerprint: 'fp',
      parseError: '',
      rawImports,
      resolvedImportsRel: imports,
      resolvedImports: imports.map((item) => resolve(CWD, item)),
      importedBy: [],
      packageName: '',
      namespaceName: '',
      goPackageName: '',
      topLevelTypes: [],
      tokenSymbols,
      symbols,
      calls,
    },
    text,
  };
}

function makeGraph(entries) {
  const nodes = new Map();
  const reverse = new Map();
  for (const { node } of entries) {
    nodes.set(node.rel, node);
    for (const rel of node.resolvedImportsRel) {
      if (!reverse.has(rel)) reverse.set(rel, new Set());
      reverse.get(rel).add(node.rel);
    }
  }
  const graph = _attachGraphRuntimeCaches({ cwd: CWD, nodes, reverse });
  for (const { node, text } of entries) {
    graph._sourceTextCache.set(node.rel, { fingerprint: node.fingerprint, text });
  }
  return graph;
}

const dispatch = async (graph, args) => String(await codeGraph(args, CWD, null, { graph }));

// ── fixtures ────────────────────────────────────────────────────────────────
const SVC_TEXT = [
  'export function runTask(input) {', // 1
  '  return helper(input);', // 2
  '}', // 3
  '', // 4
  'export class Worker {', // 5
  '  start() {', // 6
  "    return runTask('x');", // 7
  '  }', // 8
  '  stop() {', // 9
  '    return this.cleanup();', // 10
  '  }', // 11
  '  cleanup() {', // 12
  '    return new Timer(5);', // 13
  '  }', // 14
  '}', // 15
  '', // 16
  'function helper(v) { return v; }', // 17
  'function Timer(n) { return n; }', // 18
  '',
].join('\n');

const SVC_SYMBOLS = [
  sym('runTask', 'function', 1, 3, 16, { exported: true, sig: 'function runTask(input)' }),
  sym('Worker', 'class', 5, 15, 13, { exported: true, sig: 'class Worker' }),
  sym('start', 'method', 6, 8, 2, { sig: 'start()', parent: 'Worker' }),
  sym('stop', 'method', 9, 11, 2, { sig: 'stop()', parent: 'Worker' }),
  sym('cleanup', 'method', 12, 14, 2, { sig: 'cleanup()', parent: 'Worker' }),
  sym('helper', 'function', 17, 17, 9, { sig: 'function helper(v)' }),
  sym('Timer', 'function', 18, 18, 9, { sig: 'function Timer(n)' }),
];

const SVC_CALLS = [
  call('helper', 2, 9, 'call', 'runTask'),
  call('runTask', 7, 11, 'call', 'start'),
  call('cleanup', 10, 16, 'method', 'stop', 'this'),
  call('Timer', 13, 15, 'new', 'cleanup'),
];

const APP_TEXT = [
  "import { runTask } from './svc.js';", // 1
  '', // 2
  'export function boot() {', // 3
  "  return runTask('boot');", // 4
  '}', // 5
  '', // 6
  'export function reboot() {', // 7
  "  return runTask('again');", // 8
  '}', // 9
  '', // 10
  'export const handler = runTask;', // 11
  '',
].join('\n');

const APP_SYMBOLS = [
  sym('boot', 'function', 3, 5, 16, { exported: true, sig: 'function boot()' }),
  sym('reboot', 'function', 7, 9, 16, { exported: true, sig: 'function reboot()' }),
  sym('handler', 'variable', 11, 11, 14, { exported: true }),
];
const APP_CALLS = [call('runTask', 4, 9, 'call', 'boot'), call('runTask', 8, 9, 'call', 'reboot')];

// Calls `runTask` while neither declaring nor importing any declaration of it
// — the text heuristic's classic false positive.
const STRAY_TEXT = [
  'export function strayEntry(runner) {', // 1
  "  return runTask('stray');", // 2
  '}', // 3
  '',
].join('\n');

const strayNode = (calls = [call('runTask', 2, 9, 'call', 'strayEntry')]) =>
  makeNode('src/other/stray.js', 'javascript', STRAY_TEXT, {
    symbols: [sym('strayEntry', 'function', 1, 3, 16)],
    calls,
  });

// Same NAME, second declaration in an unrelated file.
const UNRELATED_TEXT = [
  'function runTask(x) { return x; }', // 1
  '', // 2
  'export function localOnly() {', // 3
  '  return runTask(1);', // 4
  '}', // 5
  '',
].join('\n');

const UNRELATED_SYMBOLS = [sym('runTask', 'function', 1, 1, 9), sym('localOnly', 'function', 3, 5, 16)];
const UNRELATED_CALLS = [call('runTask', 4, 9, 'call', 'localOnly')];

const LEGACY_TEXT = [
  "import { runTask } from './svc.js';", // 1
  '', // 2
  'export function legacyBoot() {', // 3
  "  return runTask('legacy');", // 4
  '}', // 5
  '',
].join('\n');

const LEGACY_SYMBOLS = [sym('legacyBoot', 'function', 3, 5, 16)];

const svcNode = (calls = SVC_CALLS) => makeNode('src/svc.js', 'javascript', SVC_TEXT, { symbols: SVC_SYMBOLS, calls });
const appNode = (calls = APP_CALLS) =>
  makeNode('src/app.js', 'javascript', APP_TEXT, {
    symbols: APP_SYMBOLS,
    calls,
    imports: ['src/svc.js'],
  });
const unrelatedNode = (calls = UNRELATED_CALLS) =>
  makeNode('src/other/unrelated.js', 'javascript', UNRELATED_TEXT, {
    symbols: UNRELATED_SYMBOLS,
    calls,
  });
const legacyNode = () =>
  makeNode('src/legacy.js', 'javascript', LEGACY_TEXT, {
    symbols: LEGACY_SYMBOLS,
    calls: null, // older binary: no AST call data for this file
    imports: ['src/svc.js'],
  });

// Method-receiver fixtures.
const STORE_TEXT = [
  'export class Store {', // 1
  '  save(v) {', // 2
  '    return v;', // 3
  '  }', // 4
  '  saveAll(items) {', // 5
  '    return items.map((v) => this.save(v));', // 6
  '  }', // 7
  '}', // 8
  '', // 9
  'export function copy(other) {', // 10
  '  return other.save(3);', // 11
  '}', // 12
  '',
].join('\n');

const storeNode = () =>
  makeNode('src/store.js', 'javascript', STORE_TEXT, {
    symbols: [
      sym('Store', 'class', 1, 8, 13, { exported: true, sig: 'class Store' }),
      sym('save', 'method', 2, 4, 2, { sig: 'save(v)', parent: 'Store' }),
      sym('saveAll', 'method', 5, 7, 2, { sig: 'saveAll(items)', parent: 'Store' }),
      sym('copy', 'function', 10, 12, 16, { exported: true, sig: 'function copy(other)' }),
    ],
    calls: [
      call('map', 6, 17, 'method', 'saveAll', 'items'),
      call('save', 6, 33, 'method', 'saveAll', 'this'),
      call('save', 11, 15, 'method', 'copy', 'other'),
    ],
  });

const useStoreNode = () =>
  makeNode(
    'src/use-store.js',
    'javascript',
    [
      "import { Store } from './store.js';", // 1
      '', // 2
      'export function persist(store) {', // 3
      '  return store.save(1);', // 4
      '}', // 5
      '',
    ].join('\n'),
    {
      symbols: [sym('persist', 'function', 3, 5, 16)],
      calls: [call('save', 4, 15, 'method', 'persist', 'store')],
      imports: ['src/store.js'],
    }
  );

const noStoreNode = () =>
  makeNode(
    'src/other/nostore.js',
    'javascript',
    [
      'export function keep(cache) {', // 1
      '  return cache.save(2);', // 2
      '}', // 3
      '',
    ].join('\n'),
    {
      symbols: [sym('keep', 'function', 1, 3, 16)],
      calls: [call('save', 2, 15, 'method', 'keep', 'cache')],
    }
  );

const PY_TEXT = [
  'def run_task(value):', // 1
  '    return helper(value)', // 2
  '', // 3
  '', // 4
  'def helper(value):', // 5
  '    return value', // 6
  '',
].join('\n');

const pyNode = (calls) =>
  makeNode('py/service.py', 'python', PY_TEXT, {
    symbols: [sym('run_task', 'function', 1, 2, 4), sym('helper', 'function', 5, 6, 4)],
    calls,
  });

// ── byte parity for non-call modes ──────────────────────────────────────────
// A fixed 62-query matrix over every mode that does NOT read call sites.
// imports/dependents/related/impact keep the digests captured before the
// AST-only rewrite — those answers must not move a single byte. The symbol
// modes (overview outline, symbols, find_symbol, symbol_search) were re-baselined
// once, for symbol record v2: rows now carry the unified kind, the declaration
// head and the export marker, and members nest under `parent`.
function parityGraph() {
  return makeGraph([svcNode(), appNode(), storeNode(), pyNode([call('helper', 2, 11, 'call', 'run_task')])]);
}

const PARITY_FILES = ['src/svc.js', 'src/app.js', 'src/store.js', 'py/service.py'];
const PARITY_SYMBOLS = ['runTask', 'helper', 'Worker', 'save', 'saveAll', 'run_task', 'boot', 'missingSymbol'];

function parityQueries() {
  const q = [{ mode: 'overview' }];
  for (const file of PARITY_FILES) q.push({ mode: 'overview', file });
  for (const file of PARITY_FILES) q.push({ mode: 'symbols', file });
  for (const file of PARITY_FILES) q.push({ mode: 'imports', file });
  for (const file of PARITY_FILES) q.push({ mode: 'dependents', file });
  for (const file of PARITY_FILES) q.push({ mode: 'related', file });
  for (const file of PARITY_FILES) q.push({ mode: 'impact', file });
  for (const file of PARITY_FILES) q.push({ mode: 'impact', file, symbol: 'runTask' });
  for (const symbol of PARITY_SYMBOLS) q.push({ mode: 'find_symbol', symbol });
  for (const file of PARITY_FILES) q.push({ mode: 'find_symbol', symbol: 'runTask', file });
  for (const symbol of PARITY_SYMBOLS.slice(0, 4)) q.push({ mode: 'find_symbol', symbol, body: true });
  for (const symbol of PARITY_SYMBOLS.slice(0, 3)) q.push({ mode: 'find_symbol', symbol, limit: 3 });
  for (const symbol of ['run', 'save', 'task', 'helper']) q.push({ mode: 'symbol_search', symbol });
  q.push({ mode: 'symbol_search', symbol: 'runTask', file: 'src/svc.js' });
  q.push({ mode: 'symbol_search', symbol: 'save', file: 'src/store.js' });
  for (const symbol of ['runTask', 'save', 'helper']) q.push({ mode: 'search', symbol });
  q.push({ mode: 'overview', file: 'src/svc.js', depth: 2 });
  q.push({ mode: 'overview', file: 'src/store.js', depth: 3 });
  q.push({ mode: 'symbols', file: 'src/svc.js', depth: 2 });
  q.push({ mode: 'related', file: 'py/service.py', depth: 2 });
  q.push({ mode: 'impact', file: 'src/app.js', symbol: 'boot' });
  return q;
}

// Absolute roots differ per machine; everything else is compared byte-exact.
const parityDigest = (text) =>
  createHash('sha256')
    .update(String(text).split(CWD).join('<ROOT>').split(CWD.replace(/\\/g, '/')).join('<ROOT>'))
    .digest('hex')
    .slice(0, 16);

const PARITY_DIGESTS = {
  '{"mode":"overview"}': '355d548df10da7ea',
  '{"mode":"overview","file":"src/svc.js"}': 'b0166f3a32b87571',
  '{"mode":"overview","file":"src/app.js"}': '4a77b270fb1c83bb',
  '{"mode":"overview","file":"src/store.js"}': '9764704c59c4be64',
  '{"mode":"overview","file":"py/service.py"}': '6abfa82539d4a71a',
  '{"mode":"symbols","file":"src/svc.js"}': 'f3aecfb061ad53a6',
  '{"mode":"symbols","file":"src/app.js"}': 'ae787f725bc2fcde',
  '{"mode":"symbols","file":"src/store.js"}': 'cab7387659ebfb06',
  '{"mode":"symbols","file":"py/service.py"}': 'ef61935fba556c27',
  '{"mode":"imports","file":"src/svc.js"}': '4e1a3469efde431a',
  '{"mode":"imports","file":"src/app.js"}': 'f23d201354967c77',
  '{"mode":"imports","file":"src/store.js"}': '4e1a3469efde431a',
  '{"mode":"imports","file":"py/service.py"}': '4e1a3469efde431a',
  '{"mode":"dependents","file":"src/svc.js"}': '42e5cc9d54fd7d88',
  '{"mode":"dependents","file":"src/app.js"}': 'a34ce2de080d7f40',
  '{"mode":"dependents","file":"src/store.js"}': 'a34ce2de080d7f40',
  '{"mode":"dependents","file":"py/service.py"}': 'a34ce2de080d7f40',
  '{"mode":"related","file":"src/svc.js"}': '7af354c79a2517f8',
  '{"mode":"related","file":"src/app.js"}': 'dcdb007e6a0e8b05',
  '{"mode":"related","file":"src/store.js"}': '986f30fc0fd2f576',
  '{"mode":"related","file":"py/service.py"}': '0fc810379482376f',
  '{"mode":"impact","file":"src/svc.js"}': '43081c975ef4bcc3',
  '{"mode":"impact","file":"src/app.js"}': '683e4d39fa67c491',
  '{"mode":"impact","file":"src/store.js"}': '05d56fd69d2da77a',
  '{"mode":"impact","file":"py/service.py"}': '8eaa5b0aeb7806c7',
  '{"mode":"impact","file":"src/svc.js","symbol":"runTask"}': 'f9c28bee57e3cfae',
  '{"mode":"impact","file":"src/app.js","symbol":"runTask"}': '4c705d3363a5ba46',
  '{"mode":"impact","file":"src/store.js","symbol":"runTask"}': '5f5efcefaaf2b711',
  '{"mode":"impact","file":"py/service.py","symbol":"runTask"}': 'd3024c7d0c428dbd',
  '{"mode":"find_symbol","symbol":"runTask"}': '3dbe88baa4ec468b',
  '{"mode":"find_symbol","symbol":"helper"}': 'c594d6e77563429a',
  '{"mode":"find_symbol","symbol":"Worker"}': 'ee64420bcdc306f6',
  '{"mode":"find_symbol","symbol":"save"}': '83d0c1731656a7a9',
  '{"mode":"find_symbol","symbol":"saveAll"}': 'e6e42ef8d846eac6',
  '{"mode":"find_symbol","symbol":"run_task"}': '0b926e978c792852',
  '{"mode":"find_symbol","symbol":"boot"}': '33c51542989b1b75',
  '{"mode":"find_symbol","symbol":"missingSymbol"}': 'f6addfba47785fe4',
  '{"mode":"find_symbol","symbol":"runTask","file":"src/svc.js"}': 'a2755abb44856109',
  // A file-scoped miss now names the declaring file (src/svc.js) instead of
  // calling an imported project symbol a global/builtin.
  '{"mode":"find_symbol","symbol":"runTask","file":"src/app.js"}': 'f5686a796760b2ea',
  '{"mode":"find_symbol","symbol":"runTask","file":"src/store.js"}': 'f33d589599977c26',
  '{"mode":"find_symbol","symbol":"runTask","file":"py/service.py"}': 'cd9badce0eacfd63',
  '{"mode":"find_symbol","symbol":"runTask","body":true}': '3dbe88baa4ec468b',
  '{"mode":"find_symbol","symbol":"helper","body":true}': 'c594d6e77563429a',
  '{"mode":"find_symbol","symbol":"Worker","body":true}': 'ee64420bcdc306f6',
  '{"mode":"find_symbol","symbol":"save","body":true}': '83d0c1731656a7a9',
  '{"mode":"find_symbol","symbol":"runTask","limit":3}': '3dbe88baa4ec468b',
  '{"mode":"find_symbol","symbol":"helper","limit":3}': 'c594d6e77563429a',
  '{"mode":"find_symbol","symbol":"Worker","limit":3}': 'ee64420bcdc306f6',
  '{"mode":"symbol_search","symbol":"run"}': '37519d915e134961',
  '{"mode":"symbol_search","symbol":"save"}': '490168ad8a4e0fe9',
  '{"mode":"symbol_search","symbol":"task"}': '9c70f4f791dc9966',
  '{"mode":"symbol_search","symbol":"helper"}': 'cbd76aba55686857',
  '{"mode":"symbol_search","symbol":"runTask","file":"src/svc.js"}': '722992029c5d51b9',
  '{"mode":"symbol_search","symbol":"save","file":"src/store.js"}': '490168ad8a4e0fe9',
  '{"mode":"search","symbol":"runTask"}': 'f5dd5f7f45885b4d',
  '{"mode":"search","symbol":"save"}': '490168ad8a4e0fe9',
  '{"mode":"search","symbol":"helper"}': 'cbd76aba55686857',
  '{"mode":"overview","file":"src/svc.js","depth":2}': 'b0166f3a32b87571',
  '{"mode":"overview","file":"src/store.js","depth":3}': '9764704c59c4be64',
  '{"mode":"symbols","file":"src/svc.js","depth":2}': 'f3aecfb061ad53a6',
  '{"mode":"related","file":"py/service.py","depth":2}': '0fc810379482376f',
  '{"mode":"impact","file":"src/app.js","symbol":"boot"}': 'b5d07b8c7df3bcf2',
};

test('non-call modes stay byte-identical across the AST-only rewrite (62 queries)', async () => {
  const queries = parityQueries();
  assert.equal(queries.length, 62);
  const graph = parityGraph();
  const seen = {};
  for (const args of queries) {
    seen[JSON.stringify(args)] = parityDigest(await dispatch(graph, args));
  }
  assert.deepEqual(seen, PARITY_DIGESTS);
});

// ── callees ─────────────────────────────────────────────────────────────────
test('AST callees: inSymbol match reports kind, receiver and 1-based column', async () => {
  const graph = makeGraph([svcNode(), appNode()]);
  const out = await dispatch(graph, { mode: 'callees', symbol: 'runTask' });
  // helper() is the only call inside runTask; col 9 (0-based) → 10.
  assert.match(out, /^helper\tcallsite src\/svc\.js:2:10\tdecl src\/svc\.js:17\t\(in runTask\)\tkind=call$/m);
  assert.doesNotMatch(out, /\brunTask\tcallsite/);
  assert.doesNotMatch(out, /Timer|cleanup/);
});

test('AST callees: a container symbol also reports the calls of its members', async () => {
  const graph = makeGraph([svcNode()]);
  const out = await dispatch(graph, { mode: 'callees', symbol: 'Worker' });
  // start/stop/cleanup are nested in class Worker's line span (5..15).
  assert.match(out, /^runTask\tcallsite src\/svc\.js:7:12\tdecl src\/svc\.js:1\t\(in start\)\tkind=call$/m);
  assert.match(
    out,
    /^cleanup\tcallsite src\/svc\.js:10:17\tdecl src\/svc\.js:12\t\(in stop\)\tkind=method recv=this$/m
  );
  assert.match(out, /^Timer\tcallsite src\/svc\.js:13:16\tdecl src\/svc\.js:18\t\(in cleanup\)\tkind=new$/m);
  // helper() belongs to runTask, which is NOT a member of Worker.
  assert.doesNotMatch(out, /^helper\t/m);
});

test('container membership is the unified kind vocabulary plus `parent`, not a line span', async () => {
  // Rust shape: a struct, its impl block and a trait — all unified container
  // kinds — with members the record nests by `parent`. `mem` sits inside the
  // impl's line span but is NOT nested under `Engine`, so a span-derived rule
  // would wrongly hand its calls to the struct.
  const rustText = [
    'pub struct Engine {', // 1
    '    pub name: String,', // 2
    '}', // 3
    'impl Engine {', // 4
    '    pub fn start(&self) -> u8 {', // 5
    '        boot(self)', // 6
    '    }', // 7
    '}', // 8
    'fn mem() -> u8 { detach() }', // 9
    'trait Sink { fn flush(&self); }', // 10
    '',
  ].join('\n');
  const rustNode = makeNode('src/engine.rs', 'rust', rustText, {
    symbols: [
      sym('Engine', 'struct', 1, 3, 12, { exported: true, sig: 'pub struct Engine' }),
      sym('name', 'field', 2, 2, 9, { parent: 'Engine' }),
      sym('Engine', 'impl', 4, 8, 6, { sig: 'impl Engine' }),
      sym('start', 'function', 5, 7, 12, { exported: true, sig: 'pub fn start(&self) -> u8', parent: 'Engine' }),
      sym('mem', 'function', 9, 9, 4, { sig: 'fn mem() -> u8' }),
      sym('Sink', 'trait', 10, 10, 7, { sig: 'trait Sink' }),
      sym('flush', 'function', 10, 10, 17, { sig: 'fn flush(&self)', parent: 'Sink' }),
    ],
    calls: [
      call('boot', 6, 8, 'call', 'start'),
      call('detach', 9, 18, 'call', 'mem'),
      call('drain', 10, 20, 'call', 'flush'),
    ],
  });
  const graph = makeGraph([rustNode]);

  const impl = await dispatch(graph, { mode: 'callees', symbol: 'Engine' });
  assert.match(impl, /^boot\tcallsite src\/engine\.rs:6:9\t/m);
  // `mem` is a sibling inside the same lines, never a member.
  assert.doesNotMatch(impl, /^detach\t/m);

  const trait = await dispatch(graph, { mode: 'callees', symbol: 'Sink' });
  assert.match(trait, /^drain\tcallsite src\/engine\.rs:10:21\t/m);

  // The outline nests by parent across both containers of the same name.
  const outline = await dispatch(graph, { mode: 'symbols', file: 'src/engine.rs' });
  assert.equal(
    outline,
    [
      'export struct Engine (L1-3)  pub struct Engine',
      '  field name (L2)',
      'impl Engine (L4-8)',
      '  export function start (L5-7)  pub fn start(&self) -> u8',
      'function mem (L9)  fn mem() -> u8',
      'trait Sink (L10)',
      '  function flush (L10)  fn flush(&self)',
    ].join('\n')
  );
});

test('retired kind tokens are not container kinds any more', async () => {
  // 'object'/'record'/'contract'/'union'/'mixin' were per-language kinds the
  // extractor no longer emits; nothing may treat them as containers, and a
  // member that claims one as `parent` still nests only because the record
  // says so.
  const text = [
    'const Legacy = {', // 1
    '  run() { return work(); },', // 2
    '};', // 3
    '',
  ].join('\n');
  const node = makeNode('src/legacy-kind.js', 'javascript', text, {
    symbols: [sym('Legacy', 'object', 1, 3, 7), sym('run', 'method', 2, 2, 3, { sig: 'run()', parent: 'Legacy' })],
    calls: [call('work', 2, 17, 'call', 'run')],
  });
  const graph = makeGraph([node]);

  // Not a container kind → only its OWN call sites, none of its members'.
  assert.equal(await dispatch(graph, { mode: 'callees', symbol: 'Legacy' }), '(no callees)');
  const member = await dispatch(graph, { mode: 'callees', symbol: 'run' });
  assert.match(member, /^work\tcallsite src\/legacy-kind\.js:2:18\t/m);
  // Rendering never invents a vocabulary: the kind is printed as shipped.
  assert.match(
    await dispatch(graph, { mode: 'symbols', file: 'src/legacy-kind.js' }),
    /^object Legacy \(L1-3\)\n {2}method run \(L2\) {2}run\(\)$/m
  );
});

test('callees are language-agnostic; a file the extractor skipped simply has none', async () => {
  const astGraph = makeGraph([pyNode([call('helper', 2, 11, 'call', 'run_task')])]);
  const astOut = await dispatch(astGraph, { mode: 'callees', symbol: 'run_task' });
  assert.match(astOut, /^helper\tcallsite py\/service\.py:2:12\tdecl py\/service\.py:5\t\(in run_task\)\tkind=call$/m);

  // calls === null for THAT file (non-extraction language, parse error): no
  // rows, no language excuse, and no text guess.
  const skipped = makeGraph([svcNode(), pyNode(null)]);
  assert.equal(await dispatch(skipped, { mode: 'callees', symbol: 'run_task' }), '(no callees)');
});

// ── callers ─────────────────────────────────────────────────────────────────
test('AST callers: same file plus direct importers, grouped by (file, inSymbol)', async () => {
  const graph = makeGraph([svcNode(), appNode(), strayNode()]);
  const out = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  const rows = out.split('\n').filter((line) => line.includes('\tcall\t'));
  assert.deepEqual(
    rows.map((line) => line.split('\t').slice(0, 3).join('\t')),
    [
      'src/app.js:4:10\tcall\tcaller=boot',
      'src/app.js:8:10\tcall\tcaller=reboot',
      // the wire carries `start`; the outline's spans restore the chain
      'src/svc.js:7:12\tcall\tcaller=Worker/start',
    ]
  );
});

test('caller= renders the containment chain when the outline has spans, else the innermost name', async () => {
  const spanned = makeGraph([svcNode(), appNode()]);
  const withSpans = await dispatch(spanned, { mode: 'callers', symbol: 'runTask' });
  assert.match(withSpans, /^src\/svc\.js:7:12\tcall\tcaller=Worker\/start\t/m);

  // Same file, same call tuples, outline WITHOUT spans (no endLine) → the
  // chain cannot be proven, so the innermost name stands alone.
  const spanless = makeGraph([
    makeNode('src/svc.js', 'javascript', SVC_TEXT, {
      symbols: SVC_SYMBOLS.map(({ name, kind, startLine, startCol }) => ({ name, kind, startLine, startCol })),
      calls: SVC_CALLS,
    }),
    appNode(),
  ]);
  const withoutSpans = await dispatch(spanless, { mode: 'callers', symbol: 'runTask' });
  assert.match(withoutSpans, /^src\/svc\.js:7:12\tcall\tcaller=start\t/m);
});

test('AST callers: method calls need a self receiver or an importing caller file', async () => {
  const graph = makeGraph([storeNode(), useStoreNode(), noStoreNode()]);
  const out = await dispatch(graph, { mode: 'callers', symbol: 'save' });
  const rows = out.split('\n').filter((line) => line.includes('\tcall\t'));
  assert.deepEqual(
    rows.map((line) => line.split('\t').slice(0, 3).join('\t')),
    [
      // this.save(...) inside the declaring file, and store.save(...) in the importer
      'src/store.js:6:34\tcall\tcaller=Store/saveAll',
      'src/use-store.js:4:16\tcall\tcaller=persist',
    ]
  );
  // other.save(3) in the declaring file is somebody else's method …
  assert.doesNotMatch(out, /src\/store\.js:11/);
  // … and cache.save(2) lives in a file that never imports src/store.js.
  assert.doesNotMatch(out, /src\/other\/nostore\.js/);
});

test('no ADDITION: a call that reaches no declaration is not a caller', async () => {
  // src/other/stray.js calls a `runTask` it neither declares nor imports — the
  // false positive the old text heuristic reported. There is no heuristic left
  // to report it, and the reachable call sites are unaffected.
  const graph = makeGraph([svcNode(), appNode(), strayNode()]);
  const out = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  assert.doesNotMatch(out, /src\/other\/stray\.js/);
  assert.match(out, /src\/app\.js:4:10\tcall\tcaller=boot/);
});

test('a file without call data contributes no rows and never blocks the rest', async () => {
  // src/legacy.js imports svc.js and calls runTask, but the extractor produced
  // nothing for it (calls === null): it is simply absent from the answer.
  const graph = makeGraph([svcNode(), appNode(), legacyNode()]);
  const out = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  assert.match(out, /src\/app\.js:4:10\tcall\tcaller=boot/);
  assert.match(out, /src\/svc\.js:7:12\tcall\tcaller=Worker\/start/);
  assert.doesNotMatch(out, /src\/legacy\.js/);
});

// ── references ──────────────────────────────────────────────────────────────
test('references: call rows come from `calls`, non-call identifier usages from the text scan', async () => {
  const graph = makeGraph([svcNode(), appNode()]);
  const out = await dispatch(graph, { mode: 'references', symbol: 'runTask' });
  const refs = out.split('# references')[1] || '';
  assert.match(refs, /^src\/app\.js:4:10\tcall\towner=boot\t/m);
  assert.match(refs, /^src\/app\.js:8:10\tcall\towner=reboot\t/m);
  assert.match(refs, /^src\/svc\.js:7:12\tcall\towner=Worker\/start\t/m);
  // `export const handler = runTask;` is not a call — the text scan keeps it.
  const aliasRow = refs.split('\n').find((line) => line.startsWith('src/app.js:11:'));
  assert.ok(aliasRow, `expected the alias reference in:\n${refs}`);
  assert.match(aliasRow, /\treference\t/);
  // Declarations and imports stay out of references.
  assert.doesNotMatch(refs, /^src\/svc\.js:1:/m);
  assert.doesNotMatch(refs, /^src\/app\.js:1:/m);
});

test('references still answer for a file the extractor produced no calls for', async () => {
  // src/legacy.js (calls === null) imports svc.js, calls runTask on line 4 and
  // names it in its import on line 1. The call row is gone — call rows exist
  // only in `calls` — but the file is still reachable through references, and
  // a non-call usage in it is still reported.
  const aliasLegacy = makeNode(
    'src/legacy.js',
    'javascript',
    [
      "import { runTask } from './svc.js';", // 1
      '', // 2
      'export const legacyAlias = runTask;', // 3
      '',
    ].join('\n'),
    { symbols: [], calls: null, imports: ['src/svc.js'] }
  );
  const graph = makeGraph([svcNode(), aliasLegacy]);
  const refs = (await dispatch(graph, { mode: 'references', symbol: 'runTask' })).split('# references')[1] || '';
  assert.match(refs, /^src\/legacy\.js:3:28\treference\t/m);
  assert.doesNotMatch(refs, /^src\/legacy\.js:\d+:\d+\tcall\t/m);
});

test('a call-shaped string literal is never a call row, and `calls: []` files still answer references', async () => {
  // The extractor parsed this file and found NO call site ([]), while the raw
  // text contains `runTask(` inside a string literal and a real non-call usage.
  const literal = makeNode(
    'src/literal.js',
    'javascript',
    [
      "import { runTask } from './svc.js';", // 1
      '', // 2
      'export function shout() {', // 3
      '  const pattern = "runTask(";', // 4  ← call-shaped text only
      '  return [pattern, runTask];', // 5  ← real non-call usage
      '}', // 6
      '',
    ].join('\n'),
    { symbols: [sym('shout', 'function', 3, 6, 16)], calls: [], imports: ['src/svc.js'] }
  );

  const graph = makeGraph([svcNode(), literal]);
  const refs = (await dispatch(graph, { mode: 'references', symbol: 'runTask' })).split('# references')[1] || '';
  // No row may be produced for the string literal, in any kind.
  assert.doesNotMatch(refs, /^src\/literal\.js:4:/m, refs);
  // …while the genuine identifier usage in the same file is still reported.
  assert.match(refs, /^src\/literal\.js:5:\d+\treference\towner=shout\t/m);
  // And the file contributes no call row at all: its `calls` is empty.
  assert.doesNotMatch(refs, /^src\/literal\.js:\d+:\d+\tcall\t/m);
  // callers agrees: a parsed file with no call sites is simply not a caller.
  const callers = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  assert.doesNotMatch(callers, /src\/literal\.js/);
});

// ── malformed / partial call data ───────────────────────────────────────────
test('malformed wire-v2 tuples are rejected per FILE and never become a location', () => {
  // Unusable payloads → the whole file reports nothing (null), never a
  // fabricated location.
  assert.equal(_astCalls({ calls: 'nope' }), null);
  assert.equal(_astCalls({ calls: { name: 'x' } }), null);
  assert.equal(_astCalls({ calls: [null] }), null);
  assert.equal(_astCalls({ calls: [['runTask', 4, 9]] }), null); // short tuple
  assert.equal(_astCalls({ calls: [['runTask', 4, 9, 0, '', 'boot', 16]] }), null); // long tuple
  assert.equal(_astCalls({ calls: [['', 4, 9, 0, '', '']] }), null); // empty name
  assert.equal(_astCalls({ calls: [['x', 0, 9, 0, '', '']] }), null); // line < 1
  assert.equal(_astCalls({ calls: [['x', 4.5, 9, 0, '', '']] }), null); // non-integer line
  assert.equal(_astCalls({ calls: [['x', '4', 9, 0, '', '']] }), null); // stringly line
  assert.equal(_astCalls({ calls: [['x', 4, -1, 0, '', '']] }), null); // col < 0
  assert.equal(_astCalls({ calls: [['x', 4, 9, 3, '', '']] }), null); // unknown kind index
  assert.equal(_astCalls({ calls: [['x', 4, 9, 'call', '', '']] }), null); // kind must be an index
  assert.equal(_astCalls({ calls: [['x', 4, 9, 0, null, '']] }), null); // recv must be a string
  assert.equal(_astCalls({ calls: [['x', 4, 9, 0, '', null]] }), null); // inSymbol must be a string
  // The v1 OBJECT wire is gone: a binary still emitting it reads as malformed.
  assert.equal(_astCalls({ calls: [{ name: 'x', line: 4, col: 9, kind: 'call', inSymbol: '' }] }), null);
  // One bad tuple poisons the file: a partially decoded payload would report
  // some call sites of that file and silently hide the rest.
  assert.equal(_astCalls({ calls: [call('runTask', 4, 9, 'call', 'boot'), ['x', 4, -1, 0, '', '']] }), null);

  // Decoded shape: kind index → name, recv/inSymbol verbatim, no endCol field.
  assert.deepEqual(_astCalls({ calls: [call('mk', 2, 4, 'new', 'boot', 'Foo')] }), [
    { name: 'mk', line: 2, col: 4, kind: 'new', recv: 'Foo', inSymbol: 'boot' },
  ]);
  assert.deepEqual(_astCalls({ calls: [] }), []);
});

test('a file with malformed calls reports nothing, and no bogus column survives', async () => {
  const graph = makeGraph([
    svcNode(),
    appNode([call('runTask', 4, 9, 'call', 'boot'), ['runTask', 8, -1, 0, '', 'reboot']]),
  ]);
  const out = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  assert.doesNotMatch(out, /src\/app\.js/);
  assert.doesNotMatch(out, /:-\d+|:\d+:0\b/);
  // The healthy file in the same graph still answers.
  assert.match(out, /^src\/svc\.js:7:12\tcall\tcaller=Worker\/start\t/m);

  // A non-array `calls` is the same "unknown" as a missing field.
  const stringGraph = makeGraph([svcNode(), appNode('nope')]);
  const stringOut = await dispatch(stringGraph, { mode: 'callers', symbol: 'runTask' });
  assert.doesNotMatch(stringOut, /src\/app\.js/);
});

test('a v1 object payload is not decoded: that file reports nothing, the v2 files still answer', async () => {
  const graph = makeGraph([
    svcNode(),
    appNode([{ name: 'runTask', line: 4, col: 9, endCol: 16, kind: 'call', inSymbol: 'boot' }]),
    strayNode(),
  ]);
  const out = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  assert.doesNotMatch(out, /src\/app\.js/);
  // The v2 file next to it keeps answering, and the stray call stays out.
  assert.match(out, /^src\/svc\.js:7:12\tcall\tcaller=Worker\/start\t/m);
  assert.doesNotMatch(out, /src\/other\/stray\.js/);
});

// ── no call data at all → explicit tool error ───────────────────────────────
test('an old binary (no callsFormat: 2) makes callers/callees fail with the remedy, not empty', async () => {
  const graph = makeGraph([svcNode(null), appNode(null), legacyNode()]);
  _setCallsWireV2ForTest(false);
  try {
    for (const mode of ['callers', 'callees']) {
      await assert.rejects(
        () => dispatch(graph, { mode, symbol: 'runTask' }),
        (err) => {
          assert.match(err.message, new RegExp(`^code_graph ${mode}: no AST call sites are available`));
          assert.match(err.message, /binary: .+mixdog-graph|binary: \(no mixdog-graph binary resolved\)/);
          assert.match(err.message, /does not advertise callsFormat: 2/);
          assert.match(err.message, /cargo build --release in native\/mixdog-graph|packaged/);
          return true;
        }
      );
    }
  } finally {
    _setCallsWireV2ForTest(false);
  }
});

test('a v2 binary with no call data in the whole graph fails as a stale-cache error', async () => {
  const graph = makeGraph([svcNode(null), appNode(null)]);
  _setCallsWireV2ForTest(true);
  try {
    await assert.rejects(
      () => dispatch(graph, { mode: 'callers', symbol: 'runTask' }),
      /advertises callsFormat: 2, but no indexed file of this project carries call data/
    );
  } finally {
    _setCallsWireV2ForTest(false);
  }
});

test('references still answer when the graph has no call data at all', async () => {
  // Only callers/callees are call-only; references keeps its identifier scan.
  const graph = makeGraph([svcNode(null), appNode(null)]);
  const out = await dispatch(graph, { mode: 'references', symbol: 'runTask' });
  assert.match(out, /# references/);
  assert.match(out, /^src\/app\.js:11:24\treference\t/m);
});

// ── caller rule edge cases ──────────────────────────────────────────────────
const barrelNode = () =>
  makeNode('src/index.js', 'javascript', "export { runTask } from './svc.js';\n", {
    symbols: [], // a re-export barrel declares nothing of its own
    calls: [],
    imports: ['src/svc.js'],
  });

const viaBarrelNode = () =>
  makeNode(
    'src/via-barrel.js',
    'javascript',
    [
      "import { runTask } from './index.js';", // 1
      '', // 2
      'export function viaBarrel() {', // 3
      "  return runTask('barrel');", // 4
      '}', // 5
      '',
    ].join('\n'),
    {
      symbols: [sym('viaBarrel', 'function', 3, 5, 16)],
      calls: [call('runTask', 4, 9, 'call', 'viaBarrel')],
      imports: ['src/index.js'],
    }
  );

const facadeNode = () =>
  makeNode(
    'src/facade.js',
    'javascript',
    [
      "import { runTask } from './svc.js';", // 1
      '', // 2
      'export function reexport(v) {', // 3
      '  return runTask(v);', // 4
      '}', // 5
      '',
    ].join('\n'),
    {
      // NOT a barrel: it declares a symbol of its own.
      symbols: [sym('reexport', 'function', 3, 5, 16)],
      calls: [call('runTask', 4, 9, 'call', 'reexport')],
      imports: ['src/svc.js'],
    }
  );

const viaFacadeNode = () =>
  makeNode(
    'src/via-facade.js',
    'javascript',
    [
      "import { reexport } from './facade.js';", // 1
      '', // 2
      'export function viaFacade() {', // 3
      "  return runTask('facade');", // 4
      '}', // 5
      '',
    ].join('\n'),
    {
      symbols: [sym('viaFacade', 'function', 3, 5, 16)],
      calls: [call('runTask', 4, 9, 'call', 'viaFacade')],
      imports: ['src/facade.js'],
    }
  );

test('callers reach through a re-export forwarder, but not through a file that calls the symbol', async () => {
  const graph = makeGraph([svcNode(), barrelNode(), viaBarrelNode(), facadeNode(), viaFacadeNode()]);
  const out = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  // forwarder hop: src/via-barrel.js imports src/index.js, which re-exports svc.
  assert.match(out, /^src\/via-barrel\.js:4:10\tcall\tcaller=viaBarrel\t/m);
  // direct importer stays a caller
  assert.match(out, /^src\/facade\.js:4:10\tcall\tcaller=reexport\t/m);
  // src/facade.js CALLS runTask, so it is a caller, not a conduit: callers of
  // facade.js are not pulled in as callers of runTask.
  assert.doesNotMatch(out, /src\/via-facade\.js/);
});

test('a file that never mentions the symbol is not a forwarder', async () => {
  const opaque = makeNode('src/opaque.js', 'javascript', "export { other } from './svc.js';\n", {
    symbols: [],
    calls: [],
    imports: ['src/svc.js'],
    tokenSymbols: ['export', 'other', 'svc'], // no `runTask` token
  });
  const viaOpaque = makeNode(
    'src/via-opaque.js',
    'javascript',
    [
      "import { other } from './opaque.js';", // 1
      '', // 2
      'export function viaOpaque() {', // 3
      "  return runTask('opaque');", // 4
      '}', // 5
      '',
    ].join('\n'),
    {
      symbols: [sym('viaOpaque', 'function', 3, 5, 16)],
      calls: [call('runTask', 4, 9, 'call', 'viaOpaque')],
      imports: ['src/opaque.js'],
    }
  );
  const graph = makeGraph([svcNode(), opaque, viaOpaque]);
  const out = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  assert.doesNotMatch(out, /src\/via-opaque\.js/);
});

test('two same-name declarations: both are anchors, a file scope picks one', async () => {
  const graph = makeGraph([svcNode(), appNode(), unrelatedNode()]);
  // Unscoped: every declaration anchors the query, so neither declaration's
  // call sites are dropped — anchoring on one only would delete the other's.
  const unscoped = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  assert.match(unscoped, /^src\/app\.js:4:10\tcall\tcaller=boot\t/m);
  assert.match(unscoped, /^src\/other\/unrelated\.js:4:10\tcall\tcaller=localOnly\t/m);
  // A file anchor narrows the declaration set to that file — without it the
  // scoped query answered "(no call sites)" whenever the other file ranked first.
  const scoped = await dispatch(graph, { mode: 'callers', symbol: 'runTask', file: 'src/other/unrelated.js' });
  assert.match(scoped, /^src\/other\/unrelated\.js:4:10\tcall\tcaller=localOnly\t/m);
  assert.doesNotMatch(scoped, /src\/app\.js|src\/svc\.js/);
});

const dynNode = () =>
  makeNode(
    'src/dyn.js',
    'javascript',
    [
      "import { Store } from './store.js';", // 1
      'export function persistAll(reg, key) {', // 2
      '  return reg[key].save(7);', // 3
      '}', // 4
      '',
    ].join('\n'),
    {
      symbols: [sym('persistAll', 'function', 2, 4, 16)],
      calls: [call('save', 3, 18, 'method', 'persistAll', 'reg[key]')],
      imports: ['src/store.js'],
    }
  );

const dynOutsideNode = () =>
  makeNode(
    'src/other/dyn-outside.js',
    'javascript',
    [
      'export function touch(reg, key) {', // 1
      '  return reg[key].save(9);', // 2
      '}', // 3
      '',
    ].join('\n'),
    {
      symbols: [sym('touch', 'function', 1, 3, 16)],
      calls: [call('save', 2, 18, 'method', 'touch', 'reg[key]')],
    }
  );

test('a file whose imports resolved to nothing is still judged reachable', async () => {
  // Python-shaped: `from harness.provenance import runTask` never resolves to
  // a repo file, so the import rule cannot see the edge at all.
  const pyCaller = makeNode(
    'py/test_svc.py',
    'python',
    [
      'from harness.svc import runTask', // 1
      '', // 2
      'def test_runs():', // 3
      "    return runTask('py')", // 4
      '',
    ].join('\n'),
    {
      symbols: [sym('test_runs', 'function', 3, 4, 4)],
      calls: [call('runTask', 4, 11, 'call', 'test_runs')],
      imports: [], // resolution failed …
      rawImports: ['harness.svc'], // … although the file does import
    }
  );
  const graph = makeGraph([svcNode(), pyCaller, strayNode()]);
  const out = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  assert.match(out, /^py\/test_svc\.py:4:12\tcall\tcaller=test_runs\t/m);
  // A file that imports NOTHING is still judged: its call reaches no declaration.
  assert.doesNotMatch(out, /src\/other\/stray\.js/);
});

test('computed receivers follow the import rule instead of the receiver text', async () => {
  const graph = makeGraph([storeNode(), dynNode(), dynOutsideNode()]);
  const out = await dispatch(graph, { mode: 'callers', symbol: 'save' });
  assert.match(out, /^src\/dyn\.js:3:19\tcall\tcaller=persistAll\t/m);
  assert.doesNotMatch(out, /src\/other\/dyn-outside\.js/);
});

const recurNode = () =>
  makeNode(
    'src/recur.js',
    'javascript',
    [
      'export function walk(node) {', // 1
      '  if (!node) return 0;', // 2
      '  return walk(node.next) + 1;', // 3
      '}', // 4
      '',
    ].join('\n'),
    {
      symbols: [sym('walk', 'function', 1, 4, 16)],
      calls: [call('walk', 3, 9, 'call', 'walk')],
    }
  );

test('recursion is a real call site for callers, callees and the transitive walk', async () => {
  const graph = makeGraph([recurNode()]);
  const callers = await dispatch(graph, { mode: 'callers', symbol: 'walk' });
  assert.match(callers, /^src\/recur\.js:3:10\tcall\tcaller=walk\t/m);
  const callees = await dispatch(graph, { mode: 'callees', symbol: 'walk' });
  assert.match(callees, /^walk\tcallsite src\/recur\.js:3:10\tdecl src\/recur\.js:1\t\(in walk\)\tkind=call$/m);
  // The self-edge must not expand forever.
  const transitive = await dispatch(graph, { mode: 'callers', symbol: 'walk', depth: 2 });
  assert.ok(typeof transitive === 'string' && transitive.length > 0);
});

const topLevelNode = () =>
  makeNode(
    'src/top.js',
    'javascript',
    [
      "import { runTask } from './svc.js';", // 1
      '', // 2
      "runTask('top');", // 3
      '',
    ].join('\n'),
    {
      symbols: [],
      calls: [call('runTask', 3, 0, 'call', '')],
      imports: ['src/svc.js'],
    }
  );

test('a top-level call site (inSymbol "") groups first and carries no caller', async () => {
  const graph = makeGraph([svcNode(), appNode(), topLevelNode()]);
  const out = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  const topRow = out.split('\n').find((line) => line.startsWith('src/top.js:'));
  assert.ok(topRow, `expected the top-level row in:\n${out}`);
  assert.match(topRow, /^src\/top\.js:3:1\tcall\t/);
  assert.doesNotMatch(topRow, /caller=/);
});

// ── plumbing ────────────────────────────────────────────────────────────────
test('the record decides: a shipped array is kept, an absent field stays unknown', () => {
  const rec = { rel: 'src/svc.js', lang: 'javascript', fp: 'fp', calls: SVC_CALLS };
  // The probe is NOT consulted here. A record that shipped tuples keeps them
  // even while the probe is unanswered (only a callsFormat-2 binary emits the
  // field), and `[]` — "parsed, provably call-free" — survives as itself.
  _setCallsWireV2ForTest(false);
  assert.deepEqual(_fileInfoFromRustRecord(rec, CWD).calls, SVC_CALLS);
  assert.deepEqual(_fileInfoFromRustRecord({ rel: 'a.js', lang: 'javascript', calls: [] }, CWD).calls, []);
  // Absent field = the extractor did not parse this file (JSON, Markdown, a
  // scan-only language): unknown, never "no call sites".
  assert.equal(_fileInfoFromRustRecord({ rel: 'a.json', lang: 'json' }, CWD).calls, null);

  _setCallsWireV2ForTest(true);
  try {
    assert.deepEqual(_fileInfoFromRustRecord(rec, CWD).calls, SVC_CALLS);
    assert.deepEqual(_fileInfoFromRustRecord({ rel: 'a.js', lang: 'javascript', calls: [] }, CWD).calls, []);
    // …and a confirmed wire does not upgrade an unparsed file to call-free.
    assert.equal(_fileInfoFromRustRecord({ rel: 'a.json', lang: 'json' }, CWD).calls, null);
  } finally {
    _setCallsWireV2ForTest(false);
  }

  // Node reuse is wire-agnostic: an unchanged file keeps whatever it had.
  const reused = _reuseFileInfo(
    { rel: 'src/svc.js', lang: 'javascript', fingerprint: 'fp', calls: SVC_CALLS },
    null,
    CWD
  );
  assert.deepEqual(reused.calls, SVC_CALLS);
  assert.equal(_reuseFileInfo({ rel: 'a.js', lang: 'javascript' }, null, CWD).calls, null);
});

// The text scanner is gone: nothing may promote a call-SHAPED piece of text to
// a call row, and the identifier scan must keep working on both `[]` (parsed,
// call-free) and null (unknown) files.
test('call rows are AST-only: a string literal that reads like a call is never one', async () => {
  const literalText = [
    'export function shout() {', // 1
    "  return 'runTask(now)';", // 2  ← literal text, not a call
    '}', // 3
    'export const label = "runTask(x)";', // 4  ← ditto
    'export const alias = runTask;', // 5  ← a real, non-call usage
    '',
  ].join('\n');
  const literalNode = makeNode('src/literal.js', 'javascript', literalText, {
    symbols: [
      sym('shout', 'function', 1, 3, 16, { exported: true }),
      sym('label', 'variable', 4, 4, 13, { exported: true }),
    ],
    calls: [], // the extractor parsed it and found no call site
    imports: ['src/svc.js'], // …and it even imports the declaration
  });
  const blindText = [
    'export function blindBoot() {', // 1
    "  return runTask('blind');", // 2  ← a real call, unknown to us
    '}', // 3
    'export const blindAlias = runTask;', // 4  ← non-call usage
    '',
  ].join('\n');
  const blindNode = makeNode('src/blind.js', 'javascript', blindText, {
    symbols: [
      sym('blindBoot', 'function', 1, 3, 16, { exported: true }),
      sym('blindAlias', 'variable', 4, 4, 13, { exported: true }),
    ],
    calls: null, // older binary / un-hydrated entry: unknown
    imports: ['src/svc.js'],
  });
  const graph = makeGraph([svcNode(), appNode(), literalNode, blindNode, legacyNode()]);

  const callers = await dispatch(graph, { mode: 'callers', symbol: 'runTask' });
  assert.doesNotMatch(callers, /src\/literal\.js/, 'a string literal is not a call site');
  // blind.js/legacy.js DO call runTask in their text, but their call data is
  // unknown — there is no text path left to recover it.
  assert.doesNotMatch(callers, /src\/blind\.js/);
  assert.doesNotMatch(callers, /src\/legacy\.js/);
  assert.match(callers, /src\/app\.js:4:\d+\tcall/);

  const refs = await dispatch(graph, { mode: 'references', symbol: 'runTask' });
  assert.doesNotMatch(refs, /src\/literal\.js:[24]:\d+\tcall/);
  assert.doesNotMatch(refs, /src\/blind\.js:2:\d+\tcall/);
  // Non-call identifier usages still come through — on a parsed call-free file
  // (`calls: []`) and on one whose call data is unknown (`calls: null`) alike.
  assert.match(refs, /src\/app\.js:11:\d+\treference/);
  assert.match(refs, /src\/literal\.js:5:\d+\treference/);
  assert.match(refs, /src\/blind\.js:4:\d+\treference/);
});

// references keeps answering without call data, but it must not pass an
// AST-less list off as the whole truth: a symbol used only through calls
// renders as "(no references)", which reads like a verdict rather than a gap.
test('references flags a project with no call data instead of reporting a short list', async () => {
  const blind = makeGraph([svcNode(null), appNode(null)]);
  const out = await dispatch(blind, { mode: 'references', symbol: 'runTask' });
  assert.match(out, /note: call sites are missing from this list/);
  // …and the note carries the same remedy the capability error names.
  assert.match(out, /callsFormat: 2|carries call data/);

  const healthy = makeGraph([svcNode(), appNode()]);
  const ok = await dispatch(healthy, { mode: 'references', symbol: 'runTask' });
  assert.doesNotMatch(ok, /call sites are missing/);
  assert.match(ok, /src\/app\.js:4:\d+\tcall/);
});

// Regression: the tool-contract suite routes every native spawn through one
// debug mixdog-spawn, so the `--langs` probe QUEUES behind a multi-second walk
// of this repo and loses its wait budget. The build then mapped a v2 walk as
// "no wire" and every call row of that process vanished (references reported
// "(no references)" for a symbol with call sites).
test('a run that shipped call tuples proves the wire even when the probe never answers', async () => {
  const previousBin = process.env.MIXDOG_GRAPH_BIN;
  _setCallsWireV2ForTest(null);
  // A binary that cannot answer --langs at all: the probe resolves false.
  process.env.MIXDOG_GRAPH_BIN = process.execPath;
  try {
    const probe = _ensureCallsWireProbe(CWD);
    assert.equal(_callsWireV2Enabled(), false, 'unknown until something proves it');
    // Records of that same run carry tuples → only a callsFormat-2 binary does.
    assert.equal(
      _noteCallsWireFromRecords([
        { rel: 'a.js', lang: 'javascript' },
        { rel: 'src/svc.js', lang: 'javascript', calls: SVC_CALLS },
      ]),
      true
    );
    assert.equal(_callsWireV2Enabled(), true);
    // …which is what keeps the cache signature (#calls2) and the capability
    // diagnosis of THIS process honest about the binary it actually ran.
    assert.ok(callsWireSignatureToken().includes('calls2'));
    // The late "no wire" answer must not revoke the proof.
    assert.equal(await probe, false);
    assert.equal(_callsWireV2Enabled(), true);
  } finally {
    if (previousBin === undefined) delete process.env.MIXDOG_GRAPH_BIN;
    else process.env.MIXDOG_GRAPH_BIN = previousBin;
    _setCallsWireV2ForTest(null);
  }

  // Records without the field prove nothing: an old binary stays "no wire".
  assert.equal(_noteCallsWireFromRecords([{ rel: 'a.js', lang: 'javascript' }]), false);
  assert.equal(_callsWireV2Enabled(), false);
});

test('the main cache payload carries no calls at all', () => {
  const graph = makeGraph([svcNode(), appNode([]), legacyNode()]);
  const payload = _serializeGraph(graph);
  assert.ok(!JSON.stringify(payload).includes('"calls"'), 'main entry must stay call-free');
  const restored = _deserializeGraph(CWD, payload);
  for (const rel of ['src/svc.js', 'src/app.js', 'src/legacy.js']) {
    assert.equal(restored.nodes.get(rel).calls, null, rel);
  }
  // …and the graph is marked for the lazy sidecar read.
  assert.equal(restored._callsHydration, 'pending');
});

// ── sidecar cache ───────────────────────────────────────────────────────────
function cacheHashFor(cwd) {
  const manifest = JSON.parse(readFileSync(join(DATA_DIR, 'code-graph-cache', 'manifest.json'), 'utf8'));
  // The manifest is keyed by the canonical form the cache itself uses.
  return manifest[canonicalGraphCwd(cwd)]?.hash || null;
}

function cacheFiles(hash) {
  const dir = join(DATA_DIR, 'code-graph-cache');
  return { main: join(dir, `${hash}.json`), sidecar: join(dir, `${hash}.calls.json`) };
}

// A root of its own per test so manifest entries never collide.
function persistGraph(root, entries) {
  const graph = makeGraph(entries);
  graph.cwd = root;
  graph.signature = `sig-${root}`;
  for (const node of graph.nodes.values()) node.abs = join(root, node.rel);
  _setDiskCodeGraphEntry(root, graph);
  drainCodeGraphCacheStrict();
  return graph;
}

function reloadGraph(root) {
  const entry = getDiskCodeGraphEntry(root);
  assert.ok(entry, `expected a persisted entry for ${root}`);
  return _deserializeGraph(root, entry);
}

test('sidecar round-trip: calls leave the main entry and come back on hydration', () => {
  const root = join(tmpdir(), 'mixdog-calls-root-a');
  persistGraph(root, [svcNode(), appNode([]), legacyNode()]);

  const hash = cacheHashFor(root);
  assert.ok(hash, 'manifest must know the root');
  const { main, sidecar } = cacheFiles(hash);
  assert.ok(!readFileSync(main, 'utf8').includes('"calls"'), 'main entry must stay call-free');
  const payload = JSON.parse(readFileSync(sidecar, 'utf8'));
  assert.equal(payload.v, 1);
  assert.deepEqual(payload.files['src/svc.js'], ['fp', SVC_CALLS]);
  // [] (parsed, no call sites) is written; null (unknown) is simply absent.
  assert.deepEqual(payload.files['src/app.js'], ['fp', []]);
  assert.equal(payload.files['src/legacy.js'], undefined);

  const restored = reloadGraph(root);
  assert.equal(restored.nodes.get('src/svc.js').calls, null, 'not hydrated yet');
  assert.equal(hydrateGraphCallsFromSidecar(restored), 2);
  assert.deepEqual(restored.nodes.get('src/svc.js').calls, SVC_CALLS);
  assert.deepEqual(restored.nodes.get('src/app.js').calls, []);
  assert.equal(restored.nodes.get('src/legacy.js').calls, null);
  // One attempt per graph: a second call is a no-op, not a second read.
  assert.equal(hydrateGraphCallsFromSidecar(restored), 0);

  // A file whose bytes changed since the sidecar was written stays unknown.
  const changed = reloadGraph(root);
  changed.nodes.get('src/svc.js').fingerprint = 'fp-new';
  assert.equal(hydrateGraphCallsFromSidecar(changed), 1);
  assert.equal(changed.nodes.get('src/svc.js').calls, null);
});

test('an old cache without a sidecar hydrates to null instead of failing', () => {
  const root = join(tmpdir(), 'mixdog-calls-root-b');
  persistGraph(root, [svcNode(), appNode()]);
  const { sidecar } = cacheFiles(cacheHashFor(root));
  unlinkSync(sidecar);
  assert.equal(existsSync(sidecar), false);

  const restored = reloadGraph(root);
  assert.equal(hydrateGraphCallsFromSidecar(restored), 0);
  assert.equal(restored.nodes.get('src/svc.js').calls, null);
  assert.equal(restored._callsHydration, 'done');
});

test('incremental update: unchanged files keep their sidecar entry, changed ones are refreshed', () => {
  const root = join(tmpdir(), 'mixdog-calls-root-c');
  persistGraph(root, [svcNode(), appNode()]);

  // Rebuild in the shape of a `--files` run whose reused nodes came from an
  // un-hydrated cache entry: svc.js is unchanged and knows nothing (null),
  // app.js was re-parsed with new call data, and a stale rel disappears.
  const refreshedApp = [call('runTask', 4, 9, 'call', 'boot')];
  persistGraph(root, [svcNode(null), appNode(refreshedApp)]);

  const payload = JSON.parse(readFileSync(cacheFiles(cacheHashFor(root)).sidecar, 'utf8'));
  assert.deepEqual(payload.files['src/svc.js'], ['fp', SVC_CALLS], 'unchanged file kept its calls');
  assert.deepEqual(payload.files['src/app.js'], ['fp', refreshedApp], 'changed file was refreshed');

  // A build that carries NO call data at all leaves the sidecar untouched, so
  // an older binary cannot erase what a newer one produced.
  persistGraph(root, [svcNode(null), appNode(null)]);
  const after = JSON.parse(readFileSync(cacheFiles(cacheHashFor(root)).sidecar, 'utf8'));
  assert.deepEqual(after.files['src/svc.js'], ['fp', SVC_CALLS]);
  assert.deepEqual(after.files['src/app.js'], ['fp', refreshedApp]);

  // A file whose fingerprint moved on loses the stale entry instead of
  // carrying call sites that belong to other bytes.
  const movedOn = makeNode('src/svc.js', 'javascript', SVC_TEXT, { symbols: SVC_SYMBOLS, calls: null });
  movedOn.node.fingerprint = 'fp-2';
  persistGraph(root, [movedOn, appNode(refreshedApp)]);
  const final = JSON.parse(readFileSync(cacheFiles(cacheHashFor(root)).sidecar, 'utf8'));
  assert.equal(final.files['src/svc.js'], undefined);
});

test('a crash between the entry write and the sidecar write cannot mispair calls', () => {
  const root = join(tmpdir(), 'mixdog-calls-root-crash');
  persistGraph(root, [svcNode(), appNode()]);
  const { sidecar } = cacheFiles(cacheHashFor(root));
  const beforeCrash = readFileSync(sidecar);

  // Next build: svc.js changed (new fingerprint + new calls), app.js did not.
  // The process dies after the main entry lands → the sidecar is still the
  // previous file.
  const changedSvc = makeNode('src/svc.js', 'javascript', SVC_TEXT, {
    symbols: SVC_SYMBOLS,
    calls: [call('helper', 2, 9, 'call', 'runTask'), call('extra', 3, 1, 'call', 'runTask')],
  });
  changedSvc.node.fingerprint = 'fp-crash';
  persistGraph(root, [changedSvc, appNode()]);
  writeFileSync(sidecar, beforeCrash);

  const graph = reloadGraph(root);
  assert.doesNotThrow(() => hydrateGraphCallsFromSidecar(graph));
  // The changed file must NOT get the calls of its previous bytes …
  assert.equal(graph.nodes.get('src/svc.js').calls, null);
  // … while the untouched file keeps answering from the AST.
  assert.deepEqual(graph.nodes.get('src/app.js').calls, APP_CALLS);
});

test('a sidecar written for another root is ignored file by file', () => {
  const mine = join(tmpdir(), 'mixdog-calls-root-mine');
  const other = join(tmpdir(), 'mixdog-calls-root-other');
  persistGraph(mine, [svcNode(), appNode()]);
  // Same rels, different bytes (fingerprints) and different call sites.
  const foreignSvc = makeNode('src/svc.js', 'javascript', SVC_TEXT, {
    symbols: SVC_SYMBOLS,
    calls: [call('FOREIGN', 1, 0, 'call', 'x')],
  });
  foreignSvc.node.fingerprint = 'fp-other';
  const foreignApp = makeNode('src/app.js', 'javascript', APP_TEXT, {
    symbols: APP_SYMBOLS,
    calls: [call('FOREIGN', 1, 0, 'call', 'x')],
  });
  foreignApp.node.fingerprint = 'fp-other';
  persistGraph(other, [foreignSvc, foreignApp]);

  copyFileSync(cacheFiles(cacheHashFor(other)).sidecar, cacheFiles(cacheHashFor(mine)).sidecar);
  const graph = reloadGraph(mine);
  assert.doesNotThrow(() => hydrateGraphCallsFromSidecar(graph));
  for (const rel of ['src/svc.js', 'src/app.js']) {
    assert.equal(graph.nodes.get(rel).calls, null, `${rel} must not adopt another root's calls`);
  }
});

test('a corrupt sidecar leaves calls unknown instead of throwing', () => {
  const root = join(tmpdir(), 'mixdog-calls-root-corrupt');
  for (const body of [
    '{"v":1,"files":{"src/svc.js":["fp",[', // truncated
    '{"v":99,"files":{"src/svc.js":["fp",[]]}}', // unknown version
    '{"v":1,"files":[]}', // files is not a map
    '{"v":1,"files":{"src/svc.js":"nope","src/app.js":["fp",{"0":1}]}}', // junk entries
    '', // empty file
  ]) {
    persistGraph(root, [svcNode(), appNode()]);
    writeFileSync(cacheFiles(cacheHashFor(root)).sidecar, body);
    const graph = reloadGraph(root);
    let applied = -1;
    assert.doesNotThrow(
      () => {
        applied = hydrateGraphCallsFromSidecar(graph);
      },
      `payload ${JSON.stringify(body.slice(0, 24))}`
    );
    assert.equal(applied, 0);
    assert.equal(graph.nodes.get('src/svc.js').calls, null);
    assert.equal(graph._callsHydration, 'done', 'a miss must not re-read on every query');
  }
});

test('only the call modes trigger the sidecar read', async () => {
  const root = join(tmpdir(), 'mixdog-calls-root-d');
  persistGraph(root, [svcNode(), appNode()]);

  const outlineGraph = reloadGraph(root);
  await codeGraph({ mode: 'symbols', file: 'src/svc.js' }, root, null, { graph: outlineGraph });
  assert.equal(outlineGraph._callsHydration, 'pending', 'symbols must not read the sidecar');

  const callersGraph = reloadGraph(root);
  await codeGraph({ mode: 'callers', symbol: 'runTask' }, root, null, { graph: callersGraph });
  assert.equal(callersGraph._callsHydration, 'done');
  assert.deepEqual(callersGraph.nodes.get('src/svc.js').calls, SVC_CALLS);
});

test('non-call modes never open the sidecar; the first call mode opens it once', async () => {
  const root = join(tmpdir(), 'mixdog-calls-root-fsspy');
  persistGraph(root, [svcNode(), appNode()]);
  const script = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    // Patch BEFORE the code-graph modules bind their node:fs import, so every
    // sidecar read is observable instead of inferred from a marker.
    const fs = createRequire(process.cwd() + '/probe.mjs')('node:fs');
    const reads = [];
    const originalRead = fs.readFileSync;
    fs.readFileSync = function (path, ...rest) { reads.push(String(path)); return originalRead.call(this, path, ...rest); };
    const [root, dataDir] = process.argv.slice(1);
    process.env.MIXDOG_DATA_DIR = dataDir;
    const CG = './src/runtime/agent/orchestrator/tools/code-graph/';
    const { codeGraph } = await import(CG + 'dispatch.mjs');
    const { getDiskCodeGraphEntry, ensureDiskCodeGraphLoaded } = await import(CG + 'disk-cache.mjs');
    const { _deserializeGraph } = await import(CG + 'graph-model.mjs');
    ensureDiskCodeGraphLoaded();
    const sidecarReads = () => reads.filter((p) => p.endsWith('.calls.json'));
    const load = () => {
      const entry = getDiskCodeGraphEntry(root);
      assert.ok(entry, 'the persisted entry must be readable in this process');
      return _deserializeGraph(root, entry);
    };
    for (const args of [
      { mode: 'overview', file: 'src/svc.js' },
      { mode: 'symbols', file: 'src/svc.js' },
      { mode: 'imports', file: 'src/svc.js' },
      { mode: 'dependents', file: 'src/svc.js' },
      { mode: 'related', file: 'src/svc.js' },
      { mode: 'impact', file: 'src/svc.js' },
      { mode: 'symbol_search', symbol: 'runTask' },
    ]) {
      await codeGraph(args, root, null, { graph: load() });
    }
    assert.deepEqual(sidecarReads(), [], 'a non-call mode opened the sidecar');
    const graph = load();
    await codeGraph({ mode: 'callers', symbol: 'runTask' }, root, null, { graph });
    assert.equal(sidecarReads().length, 1, 'the first call-mode query reads the sidecar exactly once');
    await codeGraph({ mode: 'references', symbol: 'runTask' }, root, null, { graph });
    await codeGraph({ mode: 'callees', symbol: 'runTask' }, root, null, { graph });
    assert.equal(sidecarReads().length, 1, 'later queries on the same graph must not re-read');
  `;
  await runNode(process.execPath, ['--input-type=module', '-e', script, root, DATA_DIR], {
    cwd: process.cwd(),
    maxBuffer: 2 * 1024 * 1024,
  });
});

test('byte-budget eviction drops the entry and its sidecar together, never an orphan', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { readdirSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    const dataDir = process.argv[1];
    process.env.MIXDOG_DATA_DIR = dataDir;
    // Read by constants.mjs at import time — 1 MB is its floor.
    process.env.MIXDOG_CODE_GRAPH_CACHE_MAX_MB = '1';
    const CG = './src/runtime/agent/orchestrator/tools/code-graph/';
    const { _attachGraphRuntimeCaches } = await import(CG + 'graph-model.mjs');
    const { _setDiskCodeGraphEntry, drainCodeGraphCacheStrict } = await import(CG + 'disk-cache.mjs');
    const bigCalls = (tag) => Array.from({ length: 9000 }, (_, i) => [tag + 'Callee' + i, i + 1, 4, 0, '', 'owner' + i]);
    const persist = (root, tag) => {
      const node = {
        abs: join(root, 'big.js'), rel: 'big.js', lang: 'javascript', fingerprint: 'fp-' + tag,
        parseError: '', rawImports: [], resolvedImportsRel: [], resolvedImports: [], importedBy: [],
        packageName: '', namespaceName: '', goPackageName: '', topLevelTypes: [],
        tokenSymbols: null, symbols: [], calls: bigCalls(tag),
      };
      const graph = _attachGraphRuntimeCaches({
        cwd: root, nodes: new Map([[node.rel, node]]), reverse: new Map(),
        schemaVersion: 'sym-range-v3-rustimports', builtAt: Date.now(), signature: 'sig-' + tag,
      });
      _setDiskCodeGraphEntry(root, graph);
      drainCodeGraphCacheStrict();
    };
    const roots = ['X:\\\\evict\\\\one', 'X:\\\\evict\\\\two', 'X:\\\\evict\\\\three'];
    for (const [index, root] of roots.entries()) {
      persist(root, 'g' + index);
      await new Promise((r) => setTimeout(r, 15)); // distinct builtAt ordering
    }
    const dir = join(dataDir, 'code-graph-cache');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const live = new Set(Object.values(manifest).map((meta) => meta.hash));
    assert.ok(live.size < roots.length, 'the byte budget must have evicted at least one root');
    const onDisk = readdirSync(dir).filter((f) => f !== 'manifest.json' && f.endsWith('.json'));
    const mains = new Set(onDisk.filter((f) => !f.endsWith('.calls.json')).map((f) => f.slice(0, -5)));
    const sidecars = new Set(onDisk.filter((f) => f.endsWith('.calls.json')).map((f) => f.slice(0, -'.calls.json'.length)));
    assert.deepEqual([...sidecars].sort(), [...mains].sort(), 'every sidecar must have its entry and vice versa');
    assert.deepEqual([...mains].sort(), [...live].sort(), 'only live hashes may survive on disk');
  `;
  const evictDir = mkdtempSync(join(tmpdir(), 'mixdog-calls-evict-'));
  try {
    await runNode(process.execPath, ['--input-type=module', '-e', script, evictDir], {
      cwd: process.cwd(),
      maxBuffer: 4 * 1024 * 1024,
    });
  } finally {
    rmSync(evictDir, { recursive: true, force: true });
  }
});

test('concurrent persists of one root leave a self-consistent entry/sidecar pair', async () => {
  const concurrentDir = mkdtempSync(join(tmpdir(), 'mixdog-calls-conc-'));
  const script = `
    import { join } from 'node:path';
    const [dataDir, tag] = process.argv.slice(1);
    process.env.MIXDOG_DATA_DIR = dataDir;
    const CG = './src/runtime/agent/orchestrator/tools/code-graph/';
    const { _attachGraphRuntimeCaches } = await import(CG + 'graph-model.mjs');
    const { _setDiskCodeGraphEntry, drainCodeGraphCacheStrict } = await import(CG + 'disk-cache.mjs');
    const root = 'X:\\\\conc\\\\root';
    for (let round = 0; round < 6; round += 1) {
      const nodes = new Map();
      for (const rel of ['a.js', 'b.js', 'c.js']) {
        nodes.set(rel, {
          abs: join(root, rel), rel, lang: 'javascript', fingerprint: 'fp-' + tag + '-' + round,
          parseError: '', rawImports: [], resolvedImportsRel: [], resolvedImports: [], importedBy: [],
          packageName: '', namespaceName: '', goPackageName: '', topLevelTypes: [],
          tokenSymbols: null, symbols: [],
          calls: [[tag + round, 1, 0, 0, '', '']],
        });
      }
      const graph = _attachGraphRuntimeCaches({
        cwd: root, nodes, reverse: new Map(),
        schemaVersion: 'sym-range-v3-rustimports', builtAt: Date.now(), signature: tag + round,
      });
      _setDiskCodeGraphEntry(root, graph);
      drainCodeGraphCacheStrict();
    }
  `;
  try {
    await Promise.all(
      ['A', 'B'].map((tag) =>
        runNode(process.execPath, ['--input-type=module', '-e', script, concurrentDir, tag], {
          cwd: process.cwd(),
          maxBuffer: 2 * 1024 * 1024,
        })
      )
    );
    const dir = join(concurrentDir, 'code-graph-cache');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const hash = Object.values(manifest)[0]?.hash;
    assert.ok(hash, 'the root must be in the manifest');
    const entry = JSON.parse(readFileSync(join(dir, `${hash}.json`), 'utf8'));
    const payload = JSON.parse(readFileSync(join(dir, `${hash}.calls.json`), 'utf8'));
    assert.equal(payload.v, 1);
    for (const node of entry.nodes) {
      const persisted = payload.files[node.rel];
      if (!persisted) continue;
      // Whatever survived must belong to the fingerprint the ENTRY carries:
      // the writer's own generation, never a neighbour's half-write.
      assert.equal(persisted[0], node.fingerprint, `${node.rel} pairs a foreign fingerprint`);
      const [tuple] = persisted[1];
      assert.ok(
        String(tuple[0]).startsWith(node.fingerprint.split('-')[1]),
        `${node.rel} pairs tuples of another writer`
      );
    }
  } finally {
    rmSync(concurrentDir, { recursive: true, force: true });
  }
});

// Does the local build speak wire v2? `--langs` is the capability channel.
async function localBinaryCallsFormat() {
  if (!existsSync(graphBinary)) return null;
  try {
    const { stdout } = await runNode(graphBinary, ['.', '--langs'], { maxBuffer: 8 * 1024 * 1024 });
    for (const line of String(stdout).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed);
      if (Number(parsed?.callsFormat)) return Number(parsed.callsFormat);
    }
    return 0;
  } catch {
    return null;
  }
}

test('the calls-wire probe is memoized per BINARY, not per process', async (t) => {
  const format = await localBinaryCallsFormat();
  if (format !== 2) {
    t.skip(`pending: local mixdog-graph advertises callsFormat=${format === null ? 'no --langs' : format}`);
    return;
  }
  const previous = process.env.MIXDOG_GRAPH_BIN;
  try {
    _setCallsWireV2ForTest(null);
    // A binary that answers nothing useful to --langs: no v2 wire.
    process.env.MIXDOG_GRAPH_BIN = process.execPath;
    assert.equal(await _ensureCallsWireProbe(CWD), false);
    assert.equal(_callsWireV2Enabled(), false);
    // Repointed mid-process (a fetched prebuilt, a test seam): the memo must
    // follow the new path instead of answering for the old binary.
    process.env.MIXDOG_GRAPH_BIN = graphBinary;
    assert.equal(await _ensureCallsWireProbe(CWD), true);
    assert.equal(_callsWireV2Enabled(), true);
    // …and back, so a downgrade cannot keep decoding a wire that is gone.
    process.env.MIXDOG_GRAPH_BIN = process.execPath;
    assert.equal(await _ensureCallsWireProbe(CWD), false);
    assert.equal(_callsWireV2Enabled(), false);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_GRAPH_BIN;
    else process.env.MIXDOG_GRAPH_BIN = previous;
    _setCallsWireV2ForTest(null);
  }
});

test('real binary: an incremental rebuild from an un-hydrated cache answers from the AST', async (t) => {
  const format = await localBinaryCallsFormat();
  if (format !== 2) {
    t.skip(`pending: local mixdog-graph advertises callsFormat=${format === null ? 'no --langs' : format}`);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'mixdog-graph-rehydrate-'));
  const dataDir = join(root, 'data');
  try {
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(
      join(root, 'keep.mjs'),
      'export function keptSymbol() { return helper(); }\nfunction helper() { return 1; }\n'
    );
    await writeFile(
      join(root, 'touch.mjs'),
      "import { keptSymbol } from './keep.mjs';\nexport function touched() { return keptSymbol(); }\n"
    );

    // Process 1: full build → main entry + sidecar on disk.
    const build = `
      const [root, dataDir, bin] = process.argv.slice(1);
      process.env.MIXDOG_DATA_DIR = dataDir;
      process.env.MIXDOG_GRAPH_BIN = bin;
      const CG = './src/runtime/agent/orchestrator/tools/code-graph/';
      const { _buildCodeGraph } = await import(CG + 'build.mjs');
      const { drainCodeGraphCacheStrict } = await import(CG + 'disk-cache.mjs');
      await _buildCodeGraph(root);
      drainCodeGraphCacheStrict();
    `;
    await runNode(process.execPath, ['--input-type=module', '-e', build, root, dataDir, graphBinary], {
      cwd: process.cwd(),
      maxBuffer: 2 * 1024 * 1024,
    });

    // A changed file only: keep.mjs is reused from a cache entry that this
    // process never hydrated, so its call sites live only in the sidecar.
    await writeFile(
      join(root, 'touch.mjs'),
      "import { keptSymbol } from './keep.mjs';\nexport function touched() { return keptSymbol(); }\nexport function extra() { return 2; }\n"
    );

    const verify = `
      import assert from 'node:assert/strict';
      const [root, dataDir, bin] = process.argv.slice(1);
      process.env.MIXDOG_DATA_DIR = dataDir;
      process.env.MIXDOG_GRAPH_BIN = bin;
      const CG = './src/runtime/agent/orchestrator/tools/code-graph/';
      const { _buildCodeGraph } = await import(CG + 'build.mjs');
      const { executeCodeGraphTool } = await import('./src/runtime/agent/orchestrator/tools/code-graph.mjs');
      const graph = await _buildCodeGraph(root);
      assert.equal(graph._callsHydration, 'pending', 'a reuse without call data must stay sidecar-eligible');
      assert.equal(graph.nodes.get('keep.mjs').calls, null, 'reused node starts unknown');
      assert.ok(Array.isArray(graph.nodes.get('touch.mjs').calls), 'the changed file was re-parsed');
      const callers = await executeCodeGraphTool('code_graph', { mode: 'callers', symbols: ['helper'] }, root);
      assert.match(callers, /keep\\.mjs:1:\\d+\\tcall\\tcaller=keptSymbol/, callers);
      assert.ok(Array.isArray(graph.nodes.get('keep.mjs').calls), 'the query hydrated the reused node');
    `;
    await runNode(process.execPath, ['--input-type=module', '-e', verify, root, dataDir, graphBinary], {
      cwd: process.cwd(),
      maxBuffer: 2 * 1024 * 1024,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The shipped pre-v2 build, used to prove the capability-change cache path.
const legacyGraphBinary = resolve('native-tools', process.platform === 'win32' ? 'mixdog-graph.exe' : 'mixdog-graph');

test('a cache indexed by a pre-v2 binary re-indexes under a v2 binary instead of failing forever', async (t) => {
  const format = await localBinaryCallsFormat();
  if (format !== 2 || !existsSync(legacyGraphBinary)) {
    t.skip(`needs both binaries: local callsFormat=${format}, legacy present=${existsSync(legacyGraphBinary)}`);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'mixdog-graph-capability-'));
  const dataDir = join(root, 'data');
  try {
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(
      join(root, 'svc.mjs'),
      'export function runTask(v) { return helper(v); }\nfunction helper(v) { return v; }\n'
    );
    await writeFile(
      join(root, 'app.mjs'),
      "import { runTask } from './svc.mjs';\nexport function boot() { return runTask(1); }\n"
    );

    const script = `
      import assert from 'node:assert/strict';
      const [root, dataDir, bin, expectation] = process.argv.slice(1);
      process.env.MIXDOG_DATA_DIR = dataDir;
      process.env.MIXDOG_GRAPH_BIN = bin;
      const { executeCodeGraphTool } = await import('./src/runtime/agent/orchestrator/tools/code-graph.mjs');
      const { drainCodeGraphCacheStrict } = await import('./src/runtime/agent/orchestrator/tools/code-graph/disk-cache.mjs');
      let result = null;
      let failure = null;
      try { result = String(await executeCodeGraphTool('code_graph', { mode: 'callers', symbols: ['runTask'] }, root)); }
      catch (err) { failure = err; }
      drainCodeGraphCacheStrict();
      if (expectation === 'capability-error') {
        assert.ok(failure, 'a pre-v2 binary must fail loudly, got: ' + result);
        assert.match(failure.message, /does not advertise callsFormat: 2/);
        // Non-call modes keep working on the very same graph.
        const overview = String(await executeCodeGraphTool('code_graph', { mode: 'overview', files: ['svc.mjs'] }, root));
        assert.match(overview, /svc\\.mjs/);
      } else {
        assert.ok(!failure, 'the v2 binary must re-index the stale cache, got: ' + (failure && failure.message));
        assert.match(result, /app\\.mjs:2:\\d+\\tcall\\tcaller=boot/, result);
      }
    `;
    const run = (bin, expectation) =>
      runNode(process.execPath, ['--input-type=module', '-e', script, root, dataDir, bin, expectation], {
        cwd: process.cwd(),
        maxBuffer: 4 * 1024 * 1024,
      });
    await run(legacyGraphBinary, 'capability-error'); // seeds a call-free cache
    await run(graphBinary, 'reindexed'); // must re-index, not serve it
    await run(legacyGraphBinary, 'capability-error'); // and downgrade cleanly again
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real binary: --langs advertises wire v2 and --files reuse keeps calls on unchanged nodes', async (t) => {
  const format = await localBinaryCallsFormat();
  if (format !== 2) {
    t.skip(
      `pending: local mixdog-graph advertises callsFormat=${format === null ? 'no --langs' : format} — rerun once the Rust v2 build lands`
    );
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'mixdog-graph-calls-'));
  try {
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(root, 'keep.mjs'), 'export function keptSymbol() { return 1; }\n');
    await writeFile(
      join(root, 'touch.mjs'),
      "import { keptSymbol } from './keep.mjs';\nexport function touched() { return keptSymbol(); }\n"
    );
    const script = `
      import assert from 'node:assert/strict';
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      const root = process.argv[1];
      process.env.MIXDOG_DATA_DIR = join(root, 'data');
      process.env.MIXDOG_GRAPH_BIN = process.argv[2];
      const { _buildCodeGraph } = await import('./src/runtime/agent/orchestrator/tools/code-graph/build.mjs');
      const { _serializeGraph, _deserializeGraph } = await import('./src/runtime/agent/orchestrator/tools/code-graph/graph-model.mjs');
      const { _setDiskCodeGraphEntry, drainCodeGraphCacheStrict, hydrateGraphCallsFromSidecar } =
        await import('./src/runtime/agent/orchestrator/tools/code-graph/disk-cache.mjs');
      const first = await _buildCodeGraph(root);
      // Real v2 payload: tuples, and the file that calls keptSymbol has one.
      const touchCalls = first.nodes.get('touch.mjs').calls;
      assert.ok(Array.isArray(touchCalls), 'v2 binary must emit calls');
      assert.ok(touchCalls.every((c) => Array.isArray(c) && c.length === 6), 'calls must be wire-v2 tuples');
      assert.ok(touchCalls.some((c) => c[0] === 'keptSymbol'), 'the call site must be reported');
      // Sentinel tuple no parser can produce: what survives the rebuild was
      // REUSED, what disappears was re-parsed.
      const keepSentinel = ['REUSED_KEEP_SENTINEL', 1, 0, 0, '', ''];
      const touchSentinel = ['STALE_TOUCH_SENTINEL', 1, 0, 0, '', ''];
      first.nodes.get('keep.mjs').calls = [keepSentinel];
      first.nodes.get('touch.mjs').calls = [touchSentinel];
      await writeFile(join(root, 'touch.mjs'), "import { keptSymbol } from './keep.mjs';\\nexport function touched() { return keptSymbol() + 1; }\\n");
      const second = await _buildCodeGraph(root);
      // unchanged file → reused node carries its call data forward
      assert.deepEqual(second.nodes.get('keep.mjs').calls, [keepSentinel]);
      // changed file → re-parsed, never stale
      const touched = second.nodes.get('touch.mjs').calls;
      assert.ok(Array.isArray(touched));
      assert.ok(!touched.some((c) => c[0] === 'STALE_TOUCH_SENTINEL'));
      // The cache round trip goes through the sidecar, not the main entry.
      _setDiskCodeGraphEntry(root, second);
      drainCodeGraphCacheStrict();
      const payload = _serializeGraph(second);
      assert.ok(!JSON.stringify(payload).includes('"calls"'));
      const restored = _deserializeGraph(root, payload);
      assert.equal(restored.nodes.get('keep.mjs').calls, null);
      hydrateGraphCallsFromSidecar(restored);
      assert.deepEqual(restored.nodes.get('keep.mjs').calls, [keepSentinel]);
      assert.deepEqual(restored.nodes.get('touch.mjs').calls, touched);
    `;
    await runNode(process.execPath, ['--input-type=module', '-e', script, root, graphBinary], {
      cwd: process.cwd(),
      maxBuffer: 2 * 1024 * 1024,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
