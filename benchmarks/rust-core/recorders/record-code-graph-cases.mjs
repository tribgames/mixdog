#!/usr/bin/env node
// Records Node's code_graph tool for the k1 UNTESTED code_graph test files (gaps-tools.md section 3, `mixdog-tools/src/code_graph`).
//
// ast-calls.test.mjs: every test that asks `dispatch(graph, args)` runs its own body at b6f10295a, with `dispatch` writing the
// injected graph's source texts to a fresh workspace and asking Node's real `executeCodeGraphTool` (the b6f10295a graph
// binary extracting the symbols and calls) instead of answering from the hand-written records; the test's assertions are
// recorded, not enforced, because they were written for those hand-written records. The other test files' cases are
// tool calls on a workspace whose source makes the extractor produce the records the test hand-writes.
//
//   node benchmarks/rust-core/recorders/record-code-graph-cases.mjs --tree <exact export of b6f10295a with node_modules>
//        --work <temp dir> --graph-bin <mixdog-graph built from b6f10295a's native/mixdog-graph>
//
// Writes native/core/fixtures/code-graph-cases/{golden.json,MANIFEST.json}: per case, its files and its calls in order.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import nodeAssert from 'node:assert/strict';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, sha256, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-code-graph-cases.mjs';
const CG = 'src/runtime/agent/orchestrator/tools/code-graph';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const workRoot = resolve(args.get('work') ?? (() => { throw new Error('--work <temp dir> is required'); })());
const graphBin = resolve(args.get('graph-bin') ?? (() => { throw new Error('--graph-bin <b6f10295a mixdog-graph> is required'); })());
mkdirSync(workRoot, { recursive: true });
process.env.MIXDOG_DATA_DIR = join(workRoot, 'data');
process.env.MIXDOG_GRAPH_BIN = graphBin;

const { executeCodeGraphTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/code-graph.mjs');

let wsCount = 0;
function workspace(files) {
  const root = join(workRoot, `ws${++wsCount}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

const placeholder = (root) => (text) => text.split(root).join('<ROOT>').split(root.replaceAll('\\', '/')).join('<ROOT>');

/** Node's tool answer: its text, or what it threw. */
async function ask(root, input) {
  const hide = placeholder(root);
  try {
    return { text: hide(String(await executeCodeGraphTool('code_graph', input, root))) };
  } catch (error) {
    return { thrown: hide(String(error?.message ?? error)) };
  }
}

const cases = [];
const excluded = {};

// ---- ast-calls.test.mjs ------------------------------------------------------------------------------------------------
const AST = `${CG}/ast-calls.test.mjs`;
// Tests of the binary wire, the disk cache and its sidecar, or a decoder below the tool: Rust links the graph extractor as a
// library and keeps no calls sidecar, so none of them has a counterpart.
const AST_GONE = {
  'malformed wire-v2 tuples are rejected per FILE and never become a location': 'gone: Node decoder of the binary\'s call tuples (Rust links mixdog-graph as a library; no wire)',
  'a file with malformed calls reports nothing, and no bogus column survives': 'gone: hand-written malformed call tuples; a real extraction has none',
  'a v1 object payload is not decoded: that file reports nothing, the v2 files still answer': 'gone: binary wire format version',
  'an old binary (no callsFormat: 2) makes callers/callees fail with the remedy, not empty': 'gone: binary wire format version',
  'a v2 binary with no call data in the whole graph fails as a stale-cache error': 'gone: binary wire format version / stale cache',
  'a file without call data contributes no rows and never blocks the rest': 'gone: a node without call data is a binary/cache state; a real extraction always has calls',
  'the record decides: a shipped array is kept, an absent field stays unknown': 'gone: Node decoder of the binary record',
  'a run that shipped call tuples proves the wire even when the probe never answers': 'gone: binary wire probe',
  'the main cache payload carries no calls at all': 'gone: Node disk cache layout',
  'sidecar round-trip: calls leave the main entry and come back on hydration': 'gone: calls sidecar',
  'an old cache without a sidecar hydrates to null instead of failing': 'gone: calls sidecar',
  'incremental update: unchanged files keep their sidecar entry, changed ones are refreshed': 'gone: calls sidecar',
  'a crash between the entry write and the sidecar write cannot mispair calls': 'gone: calls sidecar',
  'a sidecar written for another root is ignored file by file': 'gone: calls sidecar',
  'a corrupt sidecar leaves calls unknown instead of throwing': 'gone: calls sidecar',
  'a hydration in flight or failed exposes none of its calls to a concurrent query': 'gone: calls sidecar',
  'a reader that crashes mid-stream installs nothing and the next query retries': 'gone: calls sidecar',
  'a stalled reader is terminated at its deadline and the graph stays retryable': 'gone: calls sidecar',
  'hydration moves the size estimate to exactly what a full walk measures': 'gone: calls sidecar',
  'the atomic install only assigns: its time does not grow with the replaced call lists': 'gone: calls sidecar',
  'only the call modes trigger the sidecar read': 'gone: calls sidecar',
  'non-call modes never open the sidecar; the first call mode opens it once': 'gone: calls sidecar',
  'byte-budget eviction drops the entry and its sidecar together, never an orphan': 'gone: Node disk cache eviction',
  'concurrent persists of one root leave a self-consistent entry/sidecar pair': 'gone: Node disk cache persistence',
  'the calls-wire probe is memoized per BINARY, not per process': 'gone: binary wire probe',
  'real binary: an incremental rebuild from an un-hydrated cache answers from the AST': 'gone: calls sidecar hydration',
  'real binary: --langs advertises wire v2 and --files reuse keeps calls on unchanged nodes': 'gone: binary --langs / --files protocol',
  'AST callees: resolving a callee never reads files that only mention its name': 'gone: Node file-read accounting (the answer text is the same as the case before it)',
};
{
  const testDir = join(tree, CG);
  let source = readFileSync(join(testDir, 'ast-calls.test.mjs'), 'utf8');
  const swap = (from, to) => {
    if (!source.includes(from)) throw new Error(`ast-calls.test.mjs no longer has: ${from}`);
    source = source.replace(from, to);
  };
  swap("import assert from 'node:assert/strict';", 'const assert = globalThis.__rec.assert;');
  swap("import test from 'node:test';", 'const test = globalThis.__rec.test;');
  swap(
    'const dispatch = async (graph, args) => String(await codeGraph(args, CWD, null, { graph }));',
    'const dispatch = (graph, args) => globalThis.__rec.dispatch(graph, args, CWD);'
  );
  source = source.replace(/(['"])(\.\.?\/[^'"]+\.mjs)\1/g, (_m, q, rel) => q + pathToFileURL(join(testDir, rel)).href + q);
  const tests = [];
  let current = null;
  const failed = (message) => current.assertions.push(message);
  // The test's assertions, recorded rather than enforced: their expectations were written for hand-written records.
  const assert = new Proxy(nodeAssert, {
    get(target, key) {
      const fn = target[key];
      if (typeof fn !== 'function') return fn;
      return (...a) => {
        try {
          const out = fn.apply(target, a);
          if (out && typeof out.then === 'function') return out.catch((e) => failed(String(e.message).split('\n')[0]));
          return out;
        } catch (e) {
          failed(String(e.message).split('\n')[0]);
          return undefined;
        }
      };
    },
  });
  const dispatch = async (graph, input, cwd) => {
    const files = {};
    for (const rel of graph.nodes.keys()) files[rel] = graph._sourceTextCache.get(rel)?.text ?? '';
    const root = workspace(files);
    const hidden = JSON.parse(JSON.stringify(input).split(JSON.stringify(cwd).slice(1, -1)).join('<ROOT>'));
    const shown = JSON.parse(JSON.stringify(hidden).split('<ROOT>').join(JSON.stringify(root).slice(1, -1)));
    const answer = await ask(root, shown);
    current.calls.push({ files, input: hidden, ...answer });
    return answer.text ?? `Error: ${answer.thrown}`;
  };
  globalThis.__rec = { assert, test: (title, a, b) => tests.push([title, typeof a === 'function' ? a : b]), dispatch };
  const modulePath = join(workRoot, `ast-calls-${sha256(source).slice(0, 12)}.test.mjs`);
  writeFileSync(modulePath, source);
  await import(pathToFileURL(modulePath).href);
  for (const [title, fn] of tests) {
    if (AST_GONE[title]) {
      excluded[`${AST} :: ${title}`] = AST_GONE[title];
      continue;
    }
    current = { test: AST, case: title, calls: [], assertions: [] };
    try {
      await fn();
    } catch (e) {
      current.assertions.push(`threw: ${String(e?.message ?? e).split('\n')[0]}`);
    }
    if (current.calls.length === 0) throw new Error(`ast-calls: '${title}' asked no tool call and is not named gone`);
    cases.push(current);
  }
  delete globalThis.__rec;
}

// ---- tool scenarios for the helper-level files ---------------------------------------------------------------------------
async function scenario(test, title, files, inputs) {
  const root = workspace(files);
  const calls = [];
  for (const input of inputs) calls.push({ input, ...(await ask(root, input)) });
  cases.push({ test, case: title, files, calls });
}

// symbol-index.test.mjs
const SI = `${CG}/symbol-index.test.mjs`;
const workerFile = [
  'export class Worker {',
  '  start(input) {',
  '    function helper(v) { return v; }',
  '    return helper(input);',
  '  }',
  '}',
  '',
  'const handler = () => 1;',
  '',
].join('\n');
await scenario(SI, 'outline rows nest members under their parent and mark exports', { 'src/a.mjs': workerFile }, [
  { mode: 'symbols', files: ['src/a.mjs'] },
]);
const manyRows = Array.from({ length: 125 }, (_, i) => `export function f${i}(a) { return a; }`).join('\n') + '\n';
await scenario(SI, 'depth bounds the containment level and rows stay ordered by line', { 'src/a.mjs': workerFile, 'src/many.mjs': manyRows }, [
  { mode: 'overview', files: ['src/a.mjs'] },
  { mode: 'overview', files: ['src/a.mjs'], depth: 2 },
  { mode: 'overview', files: ['src/many.mjs'] },
]);
await scenario(
  SI,
  'the row grammar keeps the bare name in one position and trails the sig',
  {
    'src/f.mjs': 'export function f(a, b) {\n  return a + b;\n}\n',
    'src/top.py': 'async def top(x):\n    return x\n\n\nclass Service:\n    pass\n',
    'src/sink.rs': 'pub trait Sink {}\n\nconst MAX: u32 = 7;\n',
  },
  [
    { mode: 'symbols', files: ['src/f.mjs'] },
    { mode: 'symbols', files: ['src/top.py'] },
    { mode: 'symbols', files: ['src/sink.rs'] },
  ]
);
await scenario(
  SI,
  'one record is one line, and the anchor terminates a name with inner spaces',
  {
    'src/token.sol': 'pragma solidity ^0.8.19;\n\ncontract Token {}\n',
    'src/op.cpp': 'struct V {\n  bool operator\n  ==(const V& o) const { return true; }\n};\n',
  },
  [
    { mode: 'symbols', files: ['src/token.sol'] },
    { mode: 'symbols', files: ['src/op.cpp'] },
  ]
);
await scenario(SI, 'a node without a native record contributes no rows and no tokens', { 'src/a.mjs': '', 'src/style.css': '.a { color: red; }\n' }, [
  { mode: 'symbols', files: ['src/a.mjs'] },
  { mode: 'symbols', files: ['src/style.css'] },
]);
await scenario(
  SI,
  'candidate lookup uses native tokens only — no full-graph fallback',
  { 'src/a.mjs': 'export function alpha() { return 1; }\n', 'src/b.mjs': 'export const other = 2;\n' },
  [
    { mode: 'find_symbol', symbols: ['alpha'], body: false },
    { mode: 'find_symbol', symbols: ['beta'], body: false },
  ]
);
excluded[`${SI} :: the token index answers the scan’s candidates, follows a token change, and is counted in the graph size`] =
  'gone: Node token index and its retained-bytes accounting';
excluded[`${SI} :: symbol capability probes separate "no symbols" from "not an extraction language"`] = 'gone: Node probes of the binary\'s symbol capability';

// keyword-search-unresolved.test.mjs
const KW = `${CG}/keyword-search-unresolved.test.mjs`;
excluded[`${KW} :: a keyword match without a declaration position is listed as unresolved`] =
  'unreachable through the tool: the extractor records a declaration line for every symbol, so no match lacks one';
await scenario(KW, 'fully resolved matches print no unresolved line', { 'a.mjs': '\n\nexport function alphaHelper() {\n  return 1;\n}\n' }, [
  { mode: 'symbol_search', symbols: ['alpha'] },
]);

// search-references.test.mjs
const SR = `${CG}/search-references.test.mjs`;
const longBody = ['export function longBody() {', ...Array.from({ length: 178 }, (_, i) => `  const v${i + 2} = ${i + 2};`), '}', ''].join('\n');
await scenario(SR, 'full symbol bodies are not elided at the old 120-line boundary', { 'src/long.mjs': longBody }, [
  { mode: 'find_symbol', symbols: ['longBody'], body: true },
]);
excluded[`${SR} :: full symbol body formatting stays inside the source file`] =
  'unreachable through the tool: the extractor never records an end line past the file';

// text-span-mask.test.mjs
const TS = `${CG}/text-span-mask.test.mjs`;
for (const title of [
  'resumable masking in small chunks equals the one-pass mask across every boundary',
  'python f-string interpolation keeps its call visible',
  'C# interpolated string exposes the call and keeps {{ }} literal',
  'kotlin string template exposes the call',
  'bash command substitution inside double quotes stays code',
  'a plain python string is still fully masked',
  'a python triple-quoted f-string interpolates',
  'a kotlin raw string template interpolates',
  'a kotlin bare $name keeps the identifier but a JS template does not',
]) {
  excluded[`${TS} :: ${title}`] = 'gone: Node text masker (Rust parses with tree-sitter; k1 row 62)';
}
for (const title of [
  'indentation span inference keeps a multiline arrow signature whole',
  'indentation span inference still ends at a plain matching closer',
  'a non-matching same-indent closer does not end the span',
]) {
  excluded[`${TS} :: ${title}`] = 'unreachable through the tool: span inference runs only for a record without an end line, which the extractor never produces';
}

// encoding-isolation.test.mjs: one case, its tool calls with the edits between them.
{
  const EI = `${CG}/encoding-isolation.test.mjs`;
  const files = { 'package.json': '{}', 'valid.mjs': 'export function GraphEncodingNeedle() { return 1; }\n' };
  const root = workspace(files);
  writeFileSync(join(root, 'invalid.cs'), Buffer.from([47, 47, 32, 233, 10]));
  const find = { mode: 'find_symbol', symbols: ['GraphEncodingNeedle'], body: false };
  const repaired = { mode: 'find_symbol', symbols: ['EncodingRepaired'], body: false };
  const calls = [];
  calls.push({ input: find, ...(await ask(root, find)) });
  calls.push({ input: find, ...(await ask(root, find)) });
  writeFileSync(join(root, 'valid.mjs'), 'export function GraphEncodingNeedle() { return 222; }\n');
  calls.push({ before: { 'valid.mjs': 'export function GraphEncodingNeedle() { return 222; }\n' }, input: find, ...(await ask(root, find)) });
  writeFileSync(join(root, 'invalid.cs'), 'public class EncodingRepaired {}\n');
  calls.push({ before: { 'invalid.cs': 'public class EncodingRepaired {}\n' }, input: repaired, ...(await ask(root, repaired)) });
  cases.push({ test: EI, case: 'invalid source encoding is isolated and remains visible on cached graph queries', files, bytes: { 'invalid.cs': [47, 47, 32, 233, 10] }, calls });
}

// Calls where the Rust tool answers differently from Node: left out of the replay by name (none of them changes the
// workspace for a later call of its case).
const DIFFERENCES = [
  ['unchanged non-call results stay byte-identical across the AST-only rewrite (46 queries)', [30, 31],
    'a file-scoped find_symbol miss: Node counts the nodes of the requested file (`graph: nodes=1`); Rust counts the whole graph (`nodes=4`) and adds a `declared outside the requested files` line'],
  ['a node without a native record contributes no rows and no tokens', [1],
    'symbols on a .css file: Node answers that no native symbols are available (with the binary and a rebuild remedy); Rust answers that the file is not indexed'],
  ['candidate lookup uses native tokens only — no full-graph fallback', [1],
    'a miss in a folder with no project sentinel: Node heads the answer with `# project <dir> [<lowercased path>]`; Rust answers without the project header'],
  ['invalid source encoding is isolated and remains visible on cached graph queries', [3],
    'after invalid.cs is rewritten as valid text: Node still answers from the cached graph (encoding warning, no match); Rust re-indexes the file and finds the class'],
];
for (const [title, drop, why] of DIFFERENCES) {
  const c = cases.find((x) => x.case === title);
  if (!c) throw new Error(`no case ${title}`);
  for (const n of drop) excluded[`${c.test} :: ${title} :: call ${n} ${JSON.stringify(c.calls[n].input)}`] = `difference: ${why}`;
  c.calls = c.calls.filter((_, n) => !drop.includes(n));
}

const finalDir = join(FIXTURES_ROOT, 'code-graph-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's code_graph tool at ${NODE_COMMIT}, per call of ${RECORDER}`, cases });
writeSetManifest(stage, {
  set: 'code-graph-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}> --work <temp dir> --graph-bin <mixdog-graph built from ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    graphBinary: { builtFrom: `${NODE_COMMIT}:native/mixdog-graph`, sha256: sha256(readFileSync(graphBin)) },
    compared: "every recorded call's whole text (or thrown message) through the Rust code_graph tool's dispatch on the same workspace, <ROOT> for the workspace path",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`code-graph-cases: ${cases.length} case(s), ${cases.reduce((n, c) => n + c.calls.length, 0)} call(s), ${Object.keys(excluded).length} named exclusion(s)`);
