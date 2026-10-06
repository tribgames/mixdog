// The suite is discovered, not listed: a full run hands Node ~700 paths, which
// overflows the OS command line. These cases pin the batching that keeps a
// full run alive and the flag errors that must stay flag errors.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ARG_BUDGET, chunkFileArgs, testConcurrencyArg } from './lib/run-node-tests.mjs';
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

test('test concurrency: share of cores under a shell cap, explicit choices win, standalone untouched', () => {
  const capped = { MIXDOG_SHELL_CONCURRENCY_CAP: '8' };
  assert.equal(testConcurrencyArg([], capped, 20), '--test-concurrency=2');
  assert.equal(testConcurrencyArg([], { MIXDOG_SHELL_CONCURRENCY_CAP: '4' }, 20), '--test-concurrency=5');
  assert.equal(testConcurrencyArg([], capped, 4), '--test-concurrency=2', 'never below 2');
  assert.equal(testConcurrencyArg([], {}, 20), null, 'no cap: Node default');
  assert.equal(testConcurrencyArg([], { MIXDOG_SHELL_CONCURRENCY_CAP: 'x' }, 20), null);
  assert.equal(testConcurrencyArg([], { ...capped, MIXDOG_TEST_CONCURRENCY: '6' }, 20), '--test-concurrency=6');
  assert.equal(testConcurrencyArg([], { MIXDOG_TEST_CONCURRENCY: '3' }, 20), '--test-concurrency=3');
  assert.equal(testConcurrencyArg(['--test-concurrency=9'], { ...capped, MIXDOG_TEST_CONCURRENCY: '6' }, 20), null);
  assert.equal(testConcurrencyArg(['--test-concurrency', '9'], capped, 20), null);
});

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

test('separate test batches share tools but retain their own session data', async (t) => {
  const child = `
    import assert from 'node:assert/strict';
    import { appendFileSync, mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import test from 'node:test';
    test('private fixture', () => {
      const data = mkdtempSync(join(tmpdir(), 'session-'));
      const cache = process.env.MIXDOG_TEST_OOXML_CACHE_DIR;
      assert.ok(cache);
      appendFileSync('paths.jsonl', JSON.stringify({ data, cache }) + '\\n');
    });
  `;
  const cwd = await fixture(t, { 'a.test.mjs': child, 'b.test.mjs': child });
  const probe = `
    const { runNodeTests } = await import(${JSON.stringify(runNodeTestsUrl)});
    await runNodeTests(['--test'], ['a.test.mjs', 'b.test.mjs'], { argBudget: 1 });
  `;
  const result = runNode(cwd, ['--input-type=module', '--eval', probe]);
  assert.equal(result.status, 0, result.stderr);
  const rows = (await readFile(join(cwd, 'paths.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cache, rows[1].cache);
  assert.notEqual(rows[0].data, rows[1].data);
  assert.notEqual(rows[0].cache, rows[0].data);
});

test('explicit runs keep exact paths/globs, slow/live files, heap flags and preloads', async (t) => {
  const source = `
    import assert from 'node:assert/strict';
    import { appendFileSync } from 'node:fs';
    import test from 'node:test';
    import v8 from 'node:v8';
    test('selected case', () => {
      assert.equal(globalThis.directPreload, true);
      // The cap that applies, not the flag text: Node 24 rebuilds a test
      // process's execArgv and drops V8 flags, and the runner forwards them.
      assert.ok(v8.getHeapStatistics().heap_size_limit < 512 * 1024 * 1024);
      assert.ok(process.env.MIXDOG_TEST_OOXML_CACHE_DIR);
      appendFileSync('selected.jsonl', JSON.stringify(import.meta.url) + '\\n');
    });
    test('filtered case', () => assert.fail('name filter must be preserved'));
  `;
  const cwd = await fixture(t, {
    'setup.mjs': 'globalThis.directPreload = true;',
    'chosen/a.slow.test.mjs': source,
    'chosen/b.live.test.mjs': source,
    'exact.test.mjs': source,
    'exact.test.mjs.extra.test.mjs': "throw new Error('not an exact path');",
    'unselected.test.mjs': "throw new Error('must not discover other tests');",
  });
  const directPath = fileURLToPath(new URL('./test-direct.mjs', import.meta.url));
  const result = runNode(cwd, [
    '--max-old-space-size=128',
    '--import',
    './setup.mjs',
    directPath,
    '--test-name-pattern',
    'selected case',
    'chosen/*.test.mjs',
    'exact.test.mjs',
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const selected = (await readFile(join(cwd, 'selected.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  // Module URLs carry the resolved path (macOS tmpdir /var is /private/var).
  const root = await realpath(cwd);
  assert.deepEqual(
    selected.map((url) => fileURLToPath(url)).sort(),
    [join(root, 'chosen/a.slow.test.mjs'), join(root, 'chosen/b.live.test.mjs'), join(root, 'exact.test.mjs')].sort()
  );
});

for (const explicit of [false, true]) {
  test(`explicit runs honor ${explicit ? 'a CLI override' : 'the shared concurrency budget'}`, async (t) => {
    const source = `
      import assert from 'node:assert/strict';
      import { closeSync, openSync, unlinkSync } from 'node:fs';
      import test from 'node:test';
      import { setTimeout } from 'node:timers/promises';
      test('exclusive fixture', async () => {
        const fd = openSync('active.lock', 'wx');
        try {
          assert.ok(process.env.MIXDOG_TEST_OOXML_CACHE_DIR);
          await setTimeout(100);
        } finally { closeSync(fd); unlinkSync('active.lock'); }
      });
    `;
    const cwd = await fixture(t, {
      'a.test.mjs': source,
      'b.test.mjs': source,
      'budget.mjs': `process.env.MIXDOG_TEST_CONCURRENCY = '${explicit ? 4 : 1}';`,
    });
    const directPath = fileURLToPath(new URL('./test-direct.mjs', import.meta.url));
    const result = runNode(cwd, [
      '--import',
      './budget.mjs',
      directPath,
      ...(explicit ? ['--test-concurrency', '1'] : []),
      'a.test.mjs',
      'b.test.mjs',
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
