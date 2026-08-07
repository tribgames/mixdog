import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { findCachedGraphBinary } from '../src/runtime/agent/orchestrator/tools/graph-binary-fetcher.mjs';
import { CODE_GRAPH_OUTPUT_MAX_BYTES } from '../src/runtime/agent/orchestrator/tools/builtin/tool-output-limit.mjs';

const previousDataDir = process.env.MIXDOG_DATA_DIR;
const previousGraphBin = process.env.MIXDOG_GRAPH_BIN;
const ambientDataDir = previousDataDir || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
const ambientGraphBin = findCachedGraphBinary(ambientDataDir);
const isolatedDataDir = await mkdtemp(join(tmpdir(), 'mixdog-code-graph-dispatch-data-'));
process.env.MIXDOG_DATA_DIR = isolatedDataDir;
if (!previousGraphBin && ambientGraphBin) process.env.MIXDOG_GRAPH_BIN = ambientGraphBin;

const { executeCodeGraphTool } = await import('../src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
const { _prewarmSourceTextNodes } = await import('../src/runtime/agent/orchestrator/tools/code-graph/search.mjs');
const { drainCodeGraphCache } = await import('../src/runtime/agent/orchestrator/tools/code-graph/disk-cache.mjs');
const project = await mkdtemp(join(tmpdir(), 'mixdog-code-graph-dispatch-project-'));
const sourceDir = join(project, 'src');
await mkdir(sourceDir);
await writeFile(join(project, 'package.json'), '{}');
await writeFile(join(sourceDir, 'one.mjs'), [
  'export function alpha() { return beta(); }',
  'export function beta() { return 2; }',
  '',
].join('\n'));
await writeFile(join(sourceDir, 'two.mjs'), [
  "import { alpha } from './one.mjs';",
  'export function gamma() { return alpha(); }',
  '',
].join('\n'));
await writeFile(join(sourceDir, 'huge.mjs'), [
  'export function huge() {',
  ...Array.from({ length: 100 }, () => `  void "${'x'.repeat(600)}";`),
  '}',
  '',
].join('\n'));

test.after(async () => {
  drainCodeGraphCache();
  await Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(isolatedDataDir, { recursive: true, force: true }),
  ]);
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  if (previousGraphBin === undefined) delete process.env.MIXDOG_GRAPH_BIN;
  else process.env.MIXDOG_GRAPH_BIN = previousGraphBin;
});

test('source prewarm bounds per-call reads and reuses fingerprinted cache entries', async () => {
  const nodes = Array.from({ length: 24 }, (_, index) => ({
    rel: `src/file-${index}.mjs`,
    abs: `virtual-${index}`,
    fingerprint: `fp-${index}`,
  }));
  const graph = { _sourceTextCache: new Map() };
  let active = 0;
  let peak = 0;
  let calls = 0;
  const readFileImpl = async (path) => {
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return `export const value = ${JSON.stringify(path)};`;
  };
  await _prewarmSourceTextNodes(graph, nodes, { concurrency: 3, readFileImpl });
  assert.equal(peak, 3);
  assert.equal(calls, nodes.length);
  assert.equal(graph._sourceTextCache.size, nodes.length);
  await _prewarmSourceTextNodes(graph, nodes, { concurrency: 3, readFileImpl });
  assert.equal(calls, nodes.length, 'matching fingerprints must stay cache hits');
});

test('source prewarm globally caps a 32-owner burst', async () => {
  let active = 0;
  let peak = 0;
  const calls = Array.from({ length: 32 }, (_, index) => {
    const node = {
      rel: `src/session-${index}.mjs`,
      abs: `virtual-session-${index}`,
      fingerprint: `session-fp-${index}`,
    };
    return _prewarmSourceTextNodes(
      { _sourceTextCache: new Map() },
      [node],
      {
        ownerKey: `session-${index}`,
        readFileImpl: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return 'export const ok = true;';
        },
      },
    );
  });
  await Promise.all(calls);
  assert.ok(peak > 1, `burst unexpectedly serialized at peak=${peak}`);
  assert.ok(peak <= 16, `global source-I/O cap exceeded: peak=${peak}`);
});

test('dispatch partitions every file and symbol mode by its supported target array', async () => {
  const files = ['src/one.mjs', 'src/two.mjs'];
  const assertNoErrorBody = (mode, result) => {
    assert.doesNotMatch(result, /(?:^|\n)Error:/i, `${mode} returned a caught/error body`);
  };
  const fileModeEvidence = {
    overview: [/file: src\/one\.mjs/, /file: src\/two\.mjs/, /symbols:.*alpha/, /symbols:.*gamma/],
    imports: [/# imports src\/two\.mjs[\s\S]*src\/one\.mjs/],
    dependents: [/# dependents src\/one\.mjs[\s\S]*src\/two\.mjs/],
    related: [/file\tsrc\/one\.mjs/, /file\tsrc\/two\.mjs/, /# related/],
    impact: [/file\tsrc\/one\.mjs/, /file\tsrc\/two\.mjs/, /external_callers\t\d+/],
    symbols: [/function alpha \(L1\)/, /function beta \(L2\)/, /function gamma \(L2\)/],
  };
  for (const mode of ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols']) {
    const result = await executeCodeGraphTool('code_graph', { mode, files }, project);
    assertNoErrorBody(mode, result);
    for (const file of files) assert.match(result, new RegExp(`# ${mode} ${file.replace('.', '\\.')}`));
    for (const evidence of fileModeEvidence[mode]) assert.match(result, evidence);
  }

  const exactModeEvidence = {
    find_symbol: [/src\/one\.mjs:1/, /src\/one\.mjs:2/, /# candidates/],
    references: [/src\/two\.mjs:2:\d+\s+export function gamma\(\) \{ return alpha\(\); \}/, /src\/one\.mjs:1:\d+\s+export function alpha\(\) \{ return beta\(\); \}/],
    callers: [/caller=gamma/, /caller=alpha/],
    callees: [/# callees/, /\bbeta\b/, /\(no callees\)/],
  };
  for (const mode of ['find_symbol', 'references', 'callers', 'callees']) {
    const result = await executeCodeGraphTool('code_graph', {
      mode,
      symbols: ['alpha', 'beta'],
      body: false,
    }, project);
    assertNoErrorBody(mode, result);
    assert.match(result, new RegExp(`# ${mode} alpha\\b`));
    assert.match(result, new RegExp(`# ${mode} beta\\b`));
    for (const evidence of exactModeEvidence[mode]) assert.match(result, evidence);
  }

  for (const mode of ['symbol_search', 'search']) {
    const result = await executeCodeGraphTool('code_graph', {
      mode,
      symbols: ['alp', 'bet'],
      body: false,
    }, project);
    const routedMode = mode === 'search' ? 'symbol_search' : mode;
    assertNoErrorBody(mode, result);
    assert.match(result, new RegExp(`# ${routedMode} alp\\b`));
    assert.match(result, new RegExp(`# ${routedMode} bet\\b`));
    assert.match(result, /# search keyword=alp matches=\d+ shown=\d+[\s\S]*\balpha\b/);
    assert.match(result, /# search keyword=bet matches=\d+ shown=\d+[\s\S]*\bbeta\b/);
  }
});

test('find_symbol stays structural and code_graph enforces symbol/output budgets', async () => {
  const alpha = await executeCodeGraphTool('code_graph', {
    mode: 'find_symbol',
    symbols: ['alpha'],
    body: false,
  }, project);
  assert.doesNotMatch(alpha, /# callees/);

  const many = Array.from({ length: 25 }, (_, index) => `missing${index}`);
  const batched = await executeCodeGraphTool('code_graph', {
    mode: 'find_symbol',
    symbols: many,
    body: false,
  }, project);
  assert.match(batched, /symbol list capped at 20/);
  assert.doesNotMatch(batched, /# find_symbol missing20\b/);

  const huge = await executeCodeGraphTool('code_graph', {
    mode: 'find_symbol',
    symbols: ['huge'],
    body: true,
  }, project);
  assert.ok(Buffer.byteLength(huge, 'utf8') <= CODE_GRAPH_OUTPUT_MAX_BYTES);
  assert.match(huge, /code_graph output capped at 30 KB/);
});
