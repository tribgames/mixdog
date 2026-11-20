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

test("a direct node --test run reports its skips, keeps node's exit status, and passes the tests' output through", () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-test-'));
  try {
    const out = join(dir, 'skips.jsonl');
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
    const env = { ...inherited, MIXDOG_RECEIPT: out };
    const ok = spawnSync(process.execPath, [WRAPPER, join(dir, 'a.test.mjs')], { cwd: dir, encoding: 'utf8', env });
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
    const bad = spawnSync(process.execPath, [WRAPPER, join(dir, 'b.test.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, MIXDOG_RECEIPT: join(dir, 'bad.json') },
    });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'bad.json'), 'utf8')).exitCode, 1);
    // a runner a test starts finds its parent's children folder instead of the lane's receipt, and leaves a receipt there naming that parent
    const { MIXDOG_RECEIPT: _lane, ...rest } = env;
    const kids = `${out}.children`;
    const child = spawnSync(process.execPath, [WRAPPER, join(dir, 'a.test.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...rest, MIXDOG_CHILD_RECEIPTS: kids },
    });
    assert.equal(child.status, 0, child.stderr);
    const [kid] = readdirSync(kids);
    assert.equal(JSON.parse(readFileSync(join(kids, kid), 'utf8')).envelope.parentInvocation, receipt.id);
    // with neither variable it is plain node --test, and leaves nothing
    assert.equal(
      spawnSync(process.execPath, [WRAPPER, join(dir, 'a.test.mjs')], { cwd: dir, encoding: 'utf8', env: rest }).status,
      0
    );
    assert.equal(readdirSync(kids).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
