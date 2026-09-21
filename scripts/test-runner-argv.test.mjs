// The suite is discovered, not listed: a full run hands Node ~700 paths, which
// overflows the OS command line. These cases pin the batching that keeps a
// full run alive and the flag errors that must stay flag errors.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARG_BUDGET, chunkFileArgs } from './lib/run-node-tests.mjs';
import { parseArgs } from './test.mjs';

const runnerPath = fileURLToPath(new URL('./test.mjs', import.meta.url));
const runNodeTestsUrl = new URL('./lib/run-node-tests.mjs', import.meta.url).href;
const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
const cost = (files) => files.reduce((total, file) => total + file.length + 3, 0);

async function fixture(t, entries) {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-test-runner-argv-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(entries)) {
    const path = join(cwd, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return cwd;
}

function runNode(cwd, args, timeout = 60_000) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test('a full-suite file list is batched under the command-line cap, in order', () => {
  const files = Array.from(
    { length: 716 },
    (_, index) => `src/runtime/agent/orchestrator/session/suite-${String(index).padStart(3, '0')}.test.mjs`
  );
  const budget = 30_000;
  assert.ok(cost(files) > budget, 'a full suite must not fit in one spawn');
  const batches = chunkFileArgs(files, budget);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), files);
  for (const batch of batches) {
    assert.ok(batch.length > 0);
    assert.ok(cost(batch) <= budget);
  }
  if (process.platform === 'win32') assert.ok(ARG_BUDGET < WINDOWS_COMMAND_LINE_LIMIT);
});

test('batching keeps an empty list and an oversized single path runnable', () => {
  assert.deepEqual(chunkFileArgs([], 100), [[]]);
  assert.deepEqual(chunkFileArgs(['src/a.test.mjs'], 100), [['src/a.test.mjs']]);
  const huge = `src/${'long-'.repeat(20)}.test.mjs`;
  assert.deepEqual(chunkFileArgs([huge, 'src/b.test.mjs'], 10), [[huge], ['src/b.test.mjs']]);
});

test('a batched run executes every file, keeps one full log, and fails on any failing batch', async (t) => {
  const cwd = await fixture(t, {
    'first.test.mjs': "import test from 'node:test';\ntest('first batch case', () => {});\n",
    'second.test.mjs':
      "import test from 'node:test';\ntest('second batch case', () => { throw new Error('second batch failure'); });\n",
    'third.test.mjs': "import test from 'node:test';\ntest('third batch case', () => {});\n",
  });
  const probe = `
    const { runNodeTests } = await import(${JSON.stringify(runNodeTestsUrl)});
    await runNodeTests(['--test'], JSON.parse(process.argv[1]), { argBudget: 1 });
  `;
  const files = ['first.test.mjs', 'second.test.mjs', 'third.test.mjs'];
  const result = runNode(cwd, ['--input-type=module', '--eval', probe, JSON.stringify(files)]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr.match(/^Full test log: /gm).length, 1);
  assert.equal(result.stdout.match(/^. duration_ms /gm).length, files.length, 'one batch per file');
  assert.match(result.stdout, /second batch failure/);
  const logPath = /^Full test log: (.+)$/m.exec(result.stderr)[1];
  t.after(() => rm(dirname(logPath), { recursive: true, force: true }));
  assert.deepEqual(await readdir(dirname(logPath)), ['full.log'], 'per-batch logs are merged away');
  const log = await readFile(logPath, 'utf8');
  for (const name of ['first batch case', 'second batch case', 'third batch case']) assert.match(log, new RegExp(name));
});

test('a valueless --import is a flag error, never an undefined spawn argument', () => {
  assert.throws(() => parseArgs(['--import']), { message: '--import requires a value' });
  assert.throws(() => parseArgs(['src/lib', '--import']), { message: '--import requires a value' });
  assert.deepEqual(parseArgs(['--import', 'setup.mjs']).nodeArgs, ['--import', 'setup.mjs']);
  const result = runNode(process.cwd(), [runnerPath, '--import'], 10_000);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--import requires a value/);
  assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE/);
});
