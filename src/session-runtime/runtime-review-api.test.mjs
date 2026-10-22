import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

// Shadow repositories and turn records live under MIXDOG_DATA_DIR.
const root = mkdtempSync(join(tmpdir(), 'mixdog-review-api-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});

const { createRuntimeReviewApi } = await import('./runtime-review-api.mjs');
const { beginTurnSnapshot, recordTurnDiffChanges } = await import('../runtime/shared/turn-snapshot.mjs');
const { invalidateBuiltinResultCache } = await import('../runtime/agent/orchestrator/tools/builtin/cache-layers.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

function seedRepo(name) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'a.txt'), 'original a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');
  return repo;
}

test('an external edit of an own file never joins the live review, whatever the read kind', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = seedRepo('external-repo');
  const sessionId = 'sess_external_edit';
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp1' });
  const api = createRuntimeReviewApi({ getCwd: () => repo, getSessionId: () => sessionId });
  writeFileSync(join(repo, 'a.txt'), 'changed a\n');
  recordTurnDiffChanges(sessionId, [
    {
      path: join(repo, 'a.txt'),
      displayPath: 'a.txt',
      before: 'original a\n',
      after: 'changed a\n',
      additions: 1,
      deletions: 1,
    },
  ]);
  // An external editor rewrites it later: no tool of this session did.
  writeFileSync(join(repo, 'a.txt'), 'changed a\nexternal line\n');
  invalidateBuiltinResultCache([join(repo, 'a.txt')]);
  for (const options of [
    { refresh: true },
    { refresh: true, poll: 'background' },
    { refresh: true, summary: true },
    {},
  ]) {
    const review = await api.getTurnReviewDiff(options);
    const label = JSON.stringify(options);
    assert.deepEqual(
      review.files.map(({ path, additions, deletions }) => [path, additions, deletions]),
      [['a.txt', 1, 1]],
      label
    );
    assert.doesNotMatch(review.patch, /external/, label);
  }
});

test('a live turn review answers a matching tag with the unchanged reply', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = seedRepo('repo');

  const sessionId = 'sess_live_review';
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp1' });
  const api = createRuntimeReviewApi({ getCwd: () => repo, getSessionId: () => sessionId });

  writeFileSync(join(repo, 'a.txt'), 'changed a\n');
  recordTurnDiffChanges(sessionId, [
    {
      path: join(repo, 'a.txt'),
      displayPath: 'a.txt',
      before: 'original a\n',
      after: 'changed a\n',
      additions: 1,
      deletions: 1,
    },
  ]);
  // The tool-write signal every builtin mutation sends.
  invalidateBuiltinResultCache([join(repo, 'a.txt')]);
  const first = await api.getTurnReviewDiff({ refresh: true });
  assert.equal(first.snapshotKind, 'worktree');
  assert.match(first.patch, /^\+changed a$/m);
  assert.match(first.etag, /^[a-f0-9]{32}$/);
  assert.equal(first.historyTurns, 0);

  assert.deepEqual(await api.getTurnReviewDiff({ refresh: true, known: first.etag }), {
    unchanged: true,
    etag: first.etag,
  });

  // A summary drops the patch and carries its own tag.
  const summary = await api.getTurnReviewDiff({ refresh: true, summary: true, known: first.etag });
  assert.equal(summary.patch, '');
  assert.equal(summary.patchOmitted, true);
  assert.notEqual(summary.etag, first.etag);

  // A write after the last capture is on the next poll, not the stale tag.
  writeFileSync(join(repo, 'b.txt'), 'new b\n');
  recordTurnDiffChanges(sessionId, [
    { path: join(repo, 'b.txt'), displayPath: 'b.txt', before: null, after: 'new b\n', additions: 1, deletions: 0 },
  ]);
  invalidateBuiltinResultCache([join(repo, 'b.txt')]);
  // A file no own tool wrote never joins the review.
  writeFileSync(join(repo, 'foreign.txt'), 'foreign\n');
  invalidateBuiltinResultCache([join(repo, 'foreign.txt')]);
  const changed = await api.getTurnReviewDiff({ refresh: true, known: first.etag });
  assert.notEqual(changed.unchanged, true);
  assert.deepEqual(
    changed.files.map(({ path }) => path),
    ['a.txt', 'b.txt']
  );
});

test('turn and session reviews list a too-large file with its counts and read its patch on its own', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = seedRepo('large-file-review');
  const sessionId = 'sess_large_file';
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp1' });
  const api = createRuntimeReviewApi({ getCwd: () => repo, getSessionId: () => sessionId });
  const big = `${'x'.repeat(9)}\n`.repeat(120_000);
  writeFileSync(join(repo, 'big.txt'), big);
  writeFileSync(join(repo, 'a.txt'), 'changed a\n');
  recordTurnDiffChanges(sessionId, [
    { path: join(repo, 'big.txt'), displayPath: 'big.txt', before: null, after: big },
    { path: join(repo, 'a.txt'), displayPath: 'a.txt', before: 'original a\n', after: 'changed a\n' },
  ]);
  invalidateBuiltinResultCache([join(repo, 'big.txt'), join(repo, 'a.txt')]);
  const shape = (review) =>
    review.files.map(({ path, additions, patchOmitted, reason }) => [path, additions, patchOmitted, reason]);
  const expected = [
    ['a.txt', 1, undefined, undefined],
    ['big.txt', 120_000, true, 'too_large'],
  ];
  const plusLines = (patch) => patch.match(/^\+x{9}$/gm)?.length ?? 0;
  for (const [review, filePatch] of [
    [await api.getTurnReviewDiff({ refresh: true }), await api.getTurnReviewFilePatch('big.txt')],
    [await api.getSessionReviewDiff(), await api.getSessionReviewFilePatch('big.txt')],
  ]) {
    assert.deepEqual(shape(review), expected);
    assert.match(review.patch, /^\+changed a$/m);
    assert.doesNotMatch(review.patch, /big\.txt/);
    assert.equal(review.diffTooLarge, undefined);
    assert.equal(filePatch.patchOmitted, undefined);
    assert.equal(plusLines(filePatch.patch), 120_000);
  }
});

test('a file read never discloses a file the session does not own, whatever rename source it names', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = seedRepo('unowned-file-repo');
  writeFileSync(join(repo, 'secret.txt'), 'secret base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'secret');
  const sessionId = 'sess_unowned_file';
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp1' });
  const api = createRuntimeReviewApi({ getCwd: () => repo, getSessionId: () => sessionId });
  writeFileSync(join(repo, 'a.txt'), 'changed a\n');
  recordTurnDiffChanges(sessionId, [
    { path: join(repo, 'a.txt'), displayPath: 'a.txt', before: 'original a\n', after: 'changed a\n' },
  ]);
  // Another writer changes a file this session never touched.
  writeFileSync(join(repo, 'secret.txt'), 'secret changed\n');
  invalidateBuiltinResultCache([join(repo, 'a.txt'), join(repo, 'secret.txt')]);
  const review = await api.getSessionReviewDiff();
  assert.deepEqual(
    review.files.map(({ path }) => path),
    ['a.txt']
  );
  for (const read of [
    await api.getSessionReviewFilePatch('secret.txt', 'a.txt'),
    await api.getSessionReviewFilePatch('secret.txt'),
    await api.getTurnReviewFilePatch('secret.txt'),
  ]) {
    assert.equal(read.patch, '');
    assert.doesNotMatch(JSON.stringify(read), /secret (base|changed)/);
  }
  const own = await api.getSessionReviewFilePatch('a.txt', 'secret.txt');
  assert.match(own.patch, /^\+changed a$/m);
  assert.doesNotMatch(own.patch, /secret/);
});

test("deleting a session removes its Delete history marker; another session's stays", async () => {
  const { _runSessionPurgeHooks } = await import('../runtime/agent/orchestrator/session/store/session-observers.mjs');
  const { sessionChangeHistoryCleared } = await import('../runtime/shared/turn-snapshot-store.mjs');
  for (const sessionId of ['purged', 'kept']) {
    await createRuntimeReviewApi({ getCwd: () => root, getSessionId: () => sessionId }).clearSessionChangeHistory();
    assert.equal(await sessionChangeHistoryCleared(sessionId), true);
  }
  _runSessionPurgeHooks('purged');
  for (let tries = 0; tries < 100 && (await sessionChangeHistoryCleared('purged')); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await sessionChangeHistoryCleared('purged'), false);
  assert.equal(await sessionChangeHistoryCleared('kept'), true);
});

test("deleting a Lead session releases its parked worker reviews and bound worker trackers; another Lead's stay", async () => {
  const { _runSessionPurgeHooks } = await import('../runtime/agent/orchestrator/session/store/session-observers.mjs');
  const snapshot = await import('../runtime/shared/turn-snapshot.mjs');
  const leads = ['purged-lead', 'kept-lead'];
  const state = {};
  for (const lead of leads) {
    const dir = join(root, lead);
    mkdirSync(dir, { recursive: true });
    const token = await snapshot.beginTurnSnapshot(dir, lead, { checkpointId: 'cp1' });
    const done = snapshot.beginAgentTurnReview(lead, `${lead}-done`, { agent: 'worker' });
    const running = snapshot.beginAgentTurnReview(lead, `${lead}-running`, { agent: 'worker' });
    await snapshot.completeTurnSnapshot(lead, token);
    for (const name of ['done', 'running']) {
      writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
      snapshot.recordTurnDiffChanges(`${lead}-${name}`, [
        { path: join(dir, `${name}.txt`), displayPath: `${name}.txt`, before: null, after: `${name}\n` },
      ]);
    }
    const runningTracker = snapshot._diffTrackerForTest(`${lead}-running`);
    assert.equal(snapshot.completeAgentTurnReview(done), true);
    state[lead] = { running, runningTracker };
  }
  _runSessionPurgeHooks('purged-lead');

  assert.deepEqual(snapshot._parkedWorkerReviewsForTest('purged-lead'), []);
  assert.equal(snapshot._diffTrackerForTest('purged-lead'), undefined);
  assert.equal(snapshot._diffTrackerForTest('purged-lead-running'), undefined);
  assert.equal(state['purged-lead'].runningTracker.chains.size, 0);
  assert.equal(snapshot.completeAgentTurnReview(state['purged-lead'].running), false);
  assert.deepEqual(snapshot._parkedWorkerReviewsForTest('purged-lead'), []);

  assert.deepEqual(
    snapshot._parkedWorkerReviewsForTest('kept-lead').map((review) => review.key),
    ['kept-lead-done']
  );
  assert.equal(snapshot._diffTrackerForTest('kept-lead-running'), state['kept-lead'].runningTracker);
  assert.equal(snapshot.completeAgentTurnReview(state['kept-lead'].running), true);
});
