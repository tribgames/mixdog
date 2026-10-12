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
const { beginTurnSnapshot } = await import('../runtime/shared/turn-snapshot.mjs');
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

test('foreground reads capture unreported edits; only background polls are gated', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async (t) => {
  const repo = seedRepo('poll-repo');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.after(() => t.mock.timers.reset());
  const sessionId = 'sess_poll_kinds';
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp1' });
  const api = createRuntimeReviewApi({ getCwd: () => repo, getSessionId: () => sessionId });
  const paths = (review) => review.files.map(({ path }) => path);
  await api.getTurnReviewDiff({ refresh: true });

  // An external editor: nothing reports these writes.
  writeFileSync(join(repo, 'a.txt'), 'edited a\n');
  const collapsed = await api.getTurnReviewDiff({ refresh: true, summary: true, poll: 'background' });
  assert.deepEqual(paths(collapsed), [], 'a collapsed background poll is gated');
  assert.deepEqual(paths(await api.getTurnReviewDiff({ refresh: true, poll: 'background' })), []);

  // An open review polls every 6 s; that poll captures.
  t.mock.timers.tick(6_000);
  assert.deepEqual(paths(await api.getTurnReviewDiff({ refresh: true, poll: 'background' })), ['a.txt']);

  // A collapsed poll 6 s after that capture stays gated…
  writeFileSync(join(repo, 'b.txt'), 'new b\n');
  t.mock.timers.tick(6_000);
  const gated = await api.getTurnReviewDiff({ refresh: true, summary: true, poll: 'background' });
  assert.deepEqual(paths(gated), ['a.txt']);
  // …a foreground read (open, manual or tool-boundary refresh) is not.
  assert.deepEqual(paths(await api.getTurnReviewDiff({ refresh: true, summary: true })), ['a.txt', 'b.txt']);

  // A request without the option (older desktop, TUI, mobile) captures too.
  writeFileSync(join(repo, 'c.txt'), 'new c\n');
  assert.deepEqual(paths(await api.getTurnReviewDiff({})), ['a.txt', 'b.txt', 'c.txt']);
});

test('a live turn review answers a matching tag with the unchanged reply', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  const repo = seedRepo('repo');

  const sessionId = 'sess_live_review';
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp1' });
  const api = createRuntimeReviewApi({ getCwd: () => repo, getSessionId: () => sessionId });

  writeFileSync(join(repo, 'a.txt'), 'changed a\n');
  // The tool-write signal every builtin mutation sends.
  invalidateBuiltinResultCache([join(repo, 'a.txt')]);
  const first = await api.getTurnReviewDiff({ refresh: true });
  assert.equal(first.snapshotKind, 'worktree');
  assert.match(first.patch, /^\+changed a$/m);
  assert.match(first.etag, /^[a-f0-9]{32}$/);

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
  invalidateBuiltinResultCache([join(repo, 'b.txt')]);
  const changed = await api.getTurnReviewDiff({ refresh: true, known: first.etag });
  assert.notEqual(changed.unchanged, true);
  assert.deepEqual(
    changed.files.map(({ path }) => path),
    ['a.txt', 'b.txt']
  );
});
