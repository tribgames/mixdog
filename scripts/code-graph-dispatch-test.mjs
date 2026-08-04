import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { findCachedGraphBinary } from '../src/runtime/agent/orchestrator/tools/graph-binary-fetcher.mjs';

const previousDataDir = process.env.MIXDOG_DATA_DIR;
const previousGraphBin = process.env.MIXDOG_GRAPH_BIN;
const ambientDataDir = previousDataDir || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
const ambientGraphBin = findCachedGraphBinary(ambientDataDir);
const isolatedDataDir = await mkdtemp(join(tmpdir(), 'mixdog-code-graph-dispatch-data-'));
process.env.MIXDOG_DATA_DIR = isolatedDataDir;
if (!previousGraphBin && ambientGraphBin) process.env.MIXDOG_GRAPH_BIN = ambientGraphBin;

const { executeCodeGraphTool } = await import('../src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
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
