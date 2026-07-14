import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, parse, relative } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { findCachedGraphBinary } from '../src/runtime/agent/orchestrator/tools/graph-binary-fetcher.mjs';

const previousDataDir = process.env.MIXDOG_DATA_DIR;
const previousGraphBin = process.env.MIXDOG_GRAPH_BIN;
const ambientDataDir = previousDataDir || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
const ambientGraphBin = findCachedGraphBinary(ambientDataDir);
const isolatedDataDir = await mkdtemp(join(tmpdir(), 'mixdog-code-graph-test-data-'));
process.env.MIXDOG_DATA_DIR = isolatedDataDir;
if (!previousGraphBin && ambientGraphBin) process.env.MIXDOG_GRAPH_BIN = ambientGraphBin;
const { executeCodeGraphTool } = await import('../src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
const { drainCodeGraphCache } = await import('../src/runtime/agent/orchestrator/tools/code-graph/disk-cache.mjs');
let testTail = Promise.resolve();

function serialTest(name, fn) {
  test(name, async (t) => {
    const previous = testTail;
    let release;
    testTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      await fn(t);
    } finally {
      release();
    }
  });
}

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-code-graph-project-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'src', 'one.mjs'), 'export const one = 1;\n');
  await writeFile(join(root, 'src', 'two.mjs'), 'export const two = 2;\n');
  return root;
}

const primaryProject = await makeProject();

test.after(async () => {
  drainCodeGraphCache();
  await Promise.all([
    rm(primaryProject, { recursive: true, force: true }),
    rm(isolatedDataDir, { recursive: true, force: true }),
  ]);
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  if (previousGraphBin === undefined) delete process.env.MIXDOG_GRAPH_BIN;
  else process.env.MIXDOG_GRAPH_BIN = previousGraphBin;
});

serialTest('aggregate file anchors recover an invalid cwd only for one project root', async () => {
  const project = primaryProject;
  const invalidCwd = parse(project).root;
  const files = [join(project, 'src', 'one.mjs'), join(project, 'src', 'two.mjs')];
  const relativeFiles = files.map((file) => relative(invalidCwd, file));
  const result = await executeCodeGraphTool('code_graph', { mode: 'overview', files }, invalidCwd);
  assert.match(result, new RegExp(`# overview ${files[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result, new RegExp(`# overview ${files[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const relativeResult = await executeCodeGraphTool('code_graph', { mode: 'overview', files: relativeFiles }, invalidCwd);
  assert.match(relativeResult, new RegExp(`# overview ${files[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(relativeResult, new RegExp(`# overview ${files[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  drainCodeGraphCache();
});

serialTest('singleton JSON files retain aggregate cwd provenance', async () => {
  const project = primaryProject;
  const invalidCwd = parse(project).root;
  const file = join(project, 'src', 'one.mjs');
  const rejected = /aggregate file anchors do not all exist under exactly one detectable project root/;
  const result = await executeCodeGraphTool(
    'code_graph',
    { mode: 'overview', files: JSON.stringify([file]), cwd: invalidCwd },
    project,
  );
  assert.doesNotMatch(result, /^Error:/);
  await assert.rejects(
    executeCodeGraphTool(
      'code_graph',
      { mode: 'overview', files: JSON.stringify([join(project, 'missing.mjs')]), cwd: invalidCwd },
      project,
    ),
    rejected,
  );
  const scalarResult = await executeCodeGraphTool(
    'code_graph',
    { mode: 'overview', file: join(project, 'missing.mjs'), cwd: invalidCwd },
    project,
  );
  assert.match(scalarResult, /^Error: code_graph: file not found:/);
});

serialTest('aggregate cwd recovery rejects missing and multi-root anchors', async () => {
  const first = await makeProject();
  const second = await makeProject();
  const invalidCwd = parse(first).root;
  const rejected = /aggregate file anchors do not all exist under exactly one detectable project root/;
  const relativeFirst = relative(invalidCwd, join(first, 'src', 'one.mjs'));
  const relativeSecond = relative(invalidCwd, join(second, 'src', 'one.mjs'));
  try {
    await assert.rejects(
      executeCodeGraphTool('code_graph', { mode: 'overview', files: [join(first, 'src', 'one.mjs'), join(first, 'missing.mjs')] }, invalidCwd),
      rejected,
    );
    await assert.rejects(
      executeCodeGraphTool('code_graph', { mode: 'overview', files: [relativeFirst, relative(invalidCwd, join(first, 'missing.mjs'))] }, invalidCwd),
      rejected,
    );
    await assert.rejects(
      executeCodeGraphTool('code_graph', { mode: 'overview', files: [join(first, 'src', 'one.mjs'), join(second, 'src', 'one.mjs')] }, invalidCwd),
      rejected,
    );
    await assert.rejects(
      executeCodeGraphTool('code_graph', { mode: 'overview', files: [relativeFirst, relativeSecond] }, invalidCwd),
      rejected,
    );
  } finally {
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  }
});

serialTest('aggregate cwd recovery rejects capped, comma-delimited, and wildcard anchors', async () => {
  const project = await makeProject();
  const invalidCwd = parse(project).root;
  const rejected = /aggregate file anchors do not all exist under exactly one detectable project root/;
  const cappedFiles = await Promise.all(Array.from({ length: 21 }, async (_, index) => {
    const file = join(project, 'src', `anchor-${index}.mjs`);
    await writeFile(file, `export const anchor${index} = ${index};\n`);
    return file;
  }));
  const literalWildcard = join(project, 'src', 'literal[glob].mjs');
  await writeFile(literalWildcard, 'export const wildcard = true;\n');
  try {
    await assert.rejects(
      executeCodeGraphTool('code_graph', { mode: 'overview', files: cappedFiles }, invalidCwd),
      rejected,
    );
    await assert.rejects(
      executeCodeGraphTool('code_graph', { mode: 'overview', files: `${join(project, 'src', 'one.mjs')},${join(project, 'src', 'two.mjs')}` }, invalidCwd),
      rejected,
    );
    await assert.rejects(
      executeCodeGraphTool('code_graph', { mode: 'overview', files: [literalWildcard] }, invalidCwd),
      rejected,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
