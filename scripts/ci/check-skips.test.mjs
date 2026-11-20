import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { matchingTests, receiptsProblems } from './check-skips.mjs';
import { appendPart, beginReceipt, finishReceipt } from './receipt.mjs';

const SCRIPT = fileURLToPath(new URL('./check-skips.mjs', import.meta.url));
const ENV = {
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/w.yml@refs/heads/main',
  GITHUB_RUN_ID: '1',
  GITHUB_RUN_ATTEMPT: '1',
  MIXDOG_LEG: 'linux/x/1of1',
};
const PLATFORM = process.platform;
const OS = { linux: 'linux', darwin: 'macos', win32: 'windows' }[PLATFORM];
const OTHER = OS === 'linux' ? 'windows' : 'linux';
const id = (...parts) => ['node', 'src/a.test.mjs', ...parts];
const exceptions = (...tuples) => ({ v: 1, exceptions: tuples });
const tuple = (extra) => ({
  id: id('x'),
  platform: OS,
  kind: 'skip',
  reasonCode: 'platform-windows-only',
  owner: 'o',
  reason: 'r',
  replacement: { kind: 'none', reason: 'local' },
  ...extra,
});

// a receipt names the commit of the checkout it is written in: this file's receipts are written inside a repository of its own
const REPO = mkdtempSync(join(tmpdir(), 'check-skips-repo-'));
before(() => {
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: REPO, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'x');
  process.chdir(REPO);
});
after(() => {
  process.chdir(tmpdir());
  rmSync(REPO, { recursive: true, force: true });
});

function receipt(dir, name, records, { exit = 0, complete = true } = {}) {
  const path = join(dir, `${name}.json`);
  beginReceipt(path, 'node', {}, ENV);
  appendPart(path, { records });
  if (complete) finishReceipt(path, exit);
  return path;
}

test('an intact receipt whose skips all have an exact reviewed exception passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-skips-'));
  try {
    const path = receipt(dir, 'a', [
      { kind: 'case', id: id('ok'), status: 'pass' },
      { kind: 'case', id: id('x'), status: 'skip', reasonCode: 'platform-windows-only', reasonText: 'Windows only' },
    ]);
    assert.deepEqual(receiptsProblems([path], exceptions(tuple()), PLATFORM), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a skip with another test, platform, kind or reason code than its tuple fails; a suite skip is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-skips-'));
  try {
    const skip = (extra) => ({
      kind: 'case',
      id: id('x'),
      status: 'skip',
      reasonCode: 'platform-windows-only',
      reasonText: 'Windows only',
      ...extra,
    });
    for (const [label, record, platform] of [
      ['another test', skip({ id: id('y') }), PLATFORM],
      ['another kind', skip({ status: 'todo' }), PLATFORM],
      ['another reason code', skip({ reasonCode: 'something-new' }), PLATFORM],
      ['uncoded', skip({ reasonCode: undefined }), PLATFORM],
    ]) {
      const path = receipt(dir, label.replaceAll(' ', '-'), [record]);
      assert.equal(receiptsProblems([path], exceptions(tuple()), platform).length, 1, label);
    }
    const other = receipt(dir, 'other-platform', [skip()]);
    assert.equal(
      receiptsProblems([other], exceptions(tuple({ platform: OTHER })), PLATFORM).length,
      1,
      'a tuple for another platform'
    );
    const suite = receipt(dir, 'suite', [
      {
        kind: 'suite',
        id: ['node-suite', 'src/a.test.mjs', 's'],
        status: 'skip',
        reasonCode: 'platform-windows-only',
        reasonText: 'r',
      },
    ]);
    assert.match(receiptsProblems([suite], exceptions(tuple()), PLATFORM)[0], /skipped suite/);
    const strict = receipt(dir, 'strict', [
      { kind: 'case', id: id('x'), status: 'skip', reasonCode: 'platform-windows-only', reasonText: 'r' },
    ]);
    assert.match(receiptsProblems([strict], exceptions(tuple()), PLATFORM, { strict: true })[0], /no skip is accepted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing, incomplete, failed or tampered receipt fails, and so does a reused invocation id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-skips-'));
  try {
    assert.match(receiptsProblems([join(dir, 'absent.json')], exceptions(), PLATFORM)[0], /did not run/);
    const open = receipt(dir, 'open', [{ kind: 'case', id: id('ok'), status: 'pass' }], { complete: false });
    assert.match(receiptsProblems([open], exceptions(), PLATFORM).join('\n'), /not complete/);
    const failed = receipt(dir, 'failed', [{ kind: 'case', id: id('ok'), status: 'pass' }], { exit: 1 });
    assert.match(receiptsProblems([failed], exceptions(), PLATFORM).join('\n'), /exit status 1/);
    const good = receipt(dir, 'good', [{ kind: 'case', id: id('ok'), status: 'pass' }]);
    const text = JSON.parse(
      spawnSync(
        process.execPath,
        [
          '-e',
          `process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync(${JSON.stringify(good)}, 'utf8'))))`,
        ],
        { encoding: 'utf8' }
      ).stdout
    );
    text.records[0].status = 'skip';
    const tampered = join(dir, 'tampered.json');
    writeFileSync(tampered, JSON.stringify(text));
    assert.match(receiptsProblems([tampered], exceptions(), PLATFORM).join('\n'), /content hash/);
    writeFileSync(
      join(dir, 'copy.json'),
      JSON.stringify(
        JSON.parse(
          spawnSync(
            process.execPath,
            ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(good)}, 'utf8'))`],
            { encoding: 'utf8' }
          ).stdout
        )
      )
    );
    assert.match(receiptsProblems([good, join(dir, 'copy.json')], exceptions(), PLATFORM).join('\n'), /is not reused/);
    // a failed case inside an otherwise complete receipt is reported too
    const red = receipt(dir, 'red', [{ kind: 'case', id: id('bad'), status: 'fail' }]);
    assert.match(receiptsProblems([red], exceptions(), PLATFORM).join('\n'), /fail/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command line: exit 1 names the problem, exit 0 prints ok; matches counts only filter matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-skips-'));
  try {
    const path = receipt(dir, 'a', [{ kind: 'case', id: id('ok'), status: 'pass' }]);
    const ok = spawnSync(process.execPath, [SCRIPT, 'receipts', path], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const missing = spawnSync(process.execPath, [SCRIPT, 'receipts', join(dir, 'none.json')], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /did not run/);
    assert.equal(
      matchingTests({
        'rust-suites': {
          a: {
            testcases: { t: { 'filter-match': { status: 'matches' } }, u: { 'filter-match': { status: 'mismatch' } } },
          },
        },
      }),
      1
    );
    mkdirSync(join(dir, 'x'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
