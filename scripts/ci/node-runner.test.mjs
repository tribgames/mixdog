import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { nodeTestArgs } from './node-runner.mjs';

const WRAPPER = fileURLToPath(new URL('./node-runner.mjs', import.meta.url));

test('without a report file it is plain node --test; with one the skip reporter joins the spec reporter', () => {
  assert.deepEqual(nodeTestArgs(['--import', 'x', 'a.test.mjs'], {}), ['--test', '--import', 'x', 'a.test.mjs']);
  const args = nodeTestArgs(['a.test.mjs'], { MIXDOG_RECEIPT: join(tmpdir(), 'skips.jsonl') });
  assert.deepEqual(
    args.filter((arg) => arg.startsWith('--test-reporter=spec') || arg === '--test-reporter-destination=stdout').length,
    3
  );
  assert.match(
    args.find((arg) => arg.includes('skip-reporter.mjs')),
    /^--test-reporter=file:.*skip-reporter\.mjs\?out=/
  );
  assert.equal(args.at(-2), '--test');
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'node-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'a.test.mjs'),
    "import test from 'node:test';\ntest('fine', () => {});\ntest('skipped', { skip: 'a reason' }, () => {});\n"
  );
  writeFileSync(
    join(dir, 'b.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fails', () => assert.fail('boom'));\n"
  );
  // a receipt names the commit of the checkout the runner starts in, so the runs start in a repository of their own
  // and a gate's own children folder is not these fixture runs' to receive
  const {
    NODE_TEST_CONTEXT: _context,
    GIT_DIR: _gitDir,
    GIT_WORK_TREE: _gitTree,
    MIXDOG_CHILD_RECEIPTS: _kids,
    MIXDOG_RECEIPT: _lane,
    ...inherited
  } = process.env;
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: inherited,
    });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  const run = (file, env) =>
    spawnSync(process.execPath, [WRAPPER, join(dir, file)], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...inherited, ...env },
    });
  return { dir, run };
}

test("a direct node --test run reports its skips and passes the tests' output through", (t) => {
  const { dir, run } = fixture(t);
  const out = join(dir, 'skips.jsonl');
  const ok = run('a.test.mjs', { MIXDOG_RECEIPT: out });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /fine/);
  const receipt = JSON.parse(readFileSync(out, 'utf8'));
  const skipped = receipt.records.find((record) => record.status === 'skip');
  assert.deepEqual(
    [skipped.kind, skipped.id[0], skipped.id.at(-1), skipped.reasonText],
    ['case', 'node', 'skipped', 'a reason']
  );
  assert.match(skipped.id[1], /a\.test\.mjs$/);
  assert.deepEqual(
    [receipt.complete, receipt.exitCode, receipt.records.filter((record) => record.status === 'pass').length],
    [true, 0, 1]
  );
  assert.equal(receipt.trailer.recordCount, receipt.records.length);
});

test("a failing node --test run keeps node's exit status in its receipt", (t) => {
  const { dir, run } = fixture(t);
  const bad = run('b.test.mjs', { MIXDOG_RECEIPT: join(dir, 'bad.json') });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, 'bad.json'), 'utf8')).exitCode, 1);
});

test("a runner a test starts leaves a receipt in its parent's children folder naming that parent", (t) => {
  const { dir, run } = fixture(t);
  const out = join(dir, 'skips.jsonl');
  assert.equal(run('a.test.mjs', { MIXDOG_RECEIPT: out }).status, 0);
  const parent = JSON.parse(readFileSync(out, 'utf8'));
  const kids = `${out}.children`;
  const child = run('a.test.mjs', { MIXDOG_CHILD_RECEIPTS: kids });
  assert.equal(child.status, 0, child.stderr);
  const [kid] = readdirSync(kids);
  assert.equal(JSON.parse(readFileSync(join(kids, kid), 'utf8')).envelope.parentInvocation, parent.id);
});

test('with neither receipt variable it is plain node --test and leaves nothing', (t) => {
  const { dir, run } = fixture(t);
  assert.equal(run('a.test.mjs', {}).status, 0);
  assert.deepEqual(
    readdirSync(dir).filter((name) => !['a.test.mjs', 'b.test.mjs', '.git'].includes(name)),
    []
  );
});
