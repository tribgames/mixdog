// The count/age choice of the automatic worktree cleanup (pure: no git).
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectWorktreeCleanup, WORKTREE_CLEANUP_MAX_REMOVALS, WORKTREE_CLEANUP_MIN_AGE_MS } from './maintenance.mjs';
import { WORKTREE_SETTINGS_DEFAULTS } from './settings.mjs';

const DAY = 24 * 60 * 60_000;
const NOW = 1_000 * DAY;

/** A clean, merged, idle worktree created `ageDays` ago whose owner last ran `idleDays` ago. */
function row(id, { ageDays = 60, idleDays = ageDays, ...extra } = {}) {
  return {
    id,
    kind: undefined,
    state: 'ready',
    ownerSessionId: `s-${id}`,
    sharedSessionIds: [],
    createdAt: NOW - ageDays * DAY,
    ownerLive: false,
    dirty: 0,
    unmerged: 0,
    ...extra,
    _idle: NOW - idleDays * DAY,
  };
}
const activityOf = (rows) => Object.fromEntries(rows.map((r) => [r.ownerSessionId, { lastActiveAt: r._idle }]));
const pick = (rows, settings, favoriteSessionIds = []) =>
  selectWorktreeCleanup(rows, {
    settings: { ...WORKTREE_SETTINGS_DEFAULTS, ...settings },
    now: NOW,
    activity: activityOf(rows),
    favoriteSessionIds,
  });

test('defaults: on, at most 15, 30 days unused, archive cleanup on, branches kept', () => {
  assert.equal(WORKTREE_SETTINGS_DEFAULTS.autoCleanup, true);
  assert.equal(WORKTREE_SETTINGS_DEFAULTS.maxWorktrees, 15);
  assert.equal(WORKTREE_SETTINGS_DEFAULTS.unusedDays, 30);
  assert.equal(WORKTREE_SETTINGS_DEFAULTS.cleanupArchived, true);
  assert.equal(WORKTREE_SETTINGS_DEFAULTS.deleteBranch, false);
  assert.equal(WORKTREE_CLEANUP_MIN_AGE_MS, 60 * 60_000);
  assert.equal(WORKTREE_CLEANUP_MAX_REMOVALS, 20);
});

test('age: worktrees unused longer than the limit, by the newest of their sessions', () => {
  const rows = [
    row('old', { idleDays: 40 }),
    row('recent', { ageDays: 40, idleDays: 2 }),
    row('edge', { idleDays: 29 }),
  ];
  assert.deepEqual(
    pick(rows, { maxWorktrees: 0 }).map((r) => [r.id, r.reason]),
    [['old', 'age']]
  );
  assert.deepEqual(pick(rows, { maxWorktrees: 0, unusedDays: 0 }), [], 'unusedDays 0 never ages out');
});

test('count: the oldest by last activity go until the limit holds; ineligible ones still count', () => {
  const rows = [
    row('a', { idleDays: 5 }),
    row('b', { idleDays: 9 }),
    row('c', { idleDays: 7 }),
    row('dirty', { idleDays: 20, dirty: 3 }),
  ];
  // 4 worktrees, keep 2: the dirty one is never chosen, so the two oldest eligible go.
  assert.deepEqual(
    pick(rows, { maxWorktrees: 2, unusedDays: 0 }).map((r) => [r.id, r.reason]),
    [
      ['b', 'count'],
      ['c', 'count'],
    ]
  );
  assert.deepEqual(pick(rows, { maxWorktrees: 4, unusedDays: 0 }), []);
  assert.deepEqual(pick(rows, { maxWorktrees: 0, unusedDays: 0 }), [], 'maxWorktrees 0 keeps any number');
});

test('never chosen: dirty, unmerged, unknown state, live, in use, shared, favorite, young, not ready, snapshots', () => {
  const rows = [
    row('dirty', { dirty: 1 }),
    row('unmerged', { unmerged: 2 }),
    row('unknown', { dirty: null, unmerged: null }),
    row('live', { ownerLive: true }),
    row('jobs', { inUse: true }),
    row('shared', { sharedSessionIds: ['other'] }),
    row('favorite'),
    row('young', { ageDays: 0.5 / 24 }),
    row('deleting', { state: 'deleting' }),
    row('snap', { kind: 'snapshot' }),
  ];
  assert.deepEqual(pick(rows, { maxWorktrees: 1, unusedDays: 1 }, ['s-favorite']), []);
});

test('off selects nothing; one pass removes at most 20, oldest first', () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(`w${String(i).padStart(2, '0')}`, { idleDays: 100 - i }));
  assert.deepEqual(pick(rows, { autoCleanup: false }), []);
  const chosen = pick(rows, { maxWorktrees: 1 });
  assert.equal(chosen.length, WORKTREE_CLEANUP_MAX_REMOVALS);
  assert.equal(chosen[0].id, 'w00');
  assert.ok(chosen.every((r, i) => i === 0 || chosen[i - 1].lastActiveAt <= r.lastActiveAt));
});

test("preview (unverified): an over-limit worktree that might be dirty never displaces another repository's candidate", async () => {
  const { previewWorktreeCleanup } = await import('./maintenance.mjs');
  // Real cleanup: A's older worktree is dirty (skipped), so B's is the one that goes.
  const rows = [row('repoA-old', { idleDays: 50 }), row('repoB', { idleDays: 40 })];
  const settings = { ...WORKTREE_SETTINGS_DEFAULTS, maxWorktrees: 1, unusedDays: 0 };
  const options = { settings, now: NOW, activity: activityOf(rows), favoriteSessionIds: [] };
  assert.deepEqual(
    selectWorktreeCleanup(rows, options).map((r) => r.id),
    ['repoA-old']
  );
  assert.deepEqual(
    selectWorktreeCleanup(rows, { ...options, potential: true })
      .map((r) => r.id)
      .sort(),
    ['repoA-old', 'repoB']
  );
  let asked;
  const manager = {
    listManagedWorktrees: async () => rows.map(({ _idle, dirty, unmerged, ...rest }) => rest),
    previewManagedWorktreeCleanup: async (input) => {
      asked = input;
      return { ids: input.removeEntryIds.filter((id) => id === 'repoB'), stale: [] };
    },
  };
  const result = await previewWorktreeCleanup({
    manager,
    settings,
    now: NOW,
    repoCommonDir: '/repoB/.git',
    listSessionIds: async () => [],
    listJobs: async () => [],
    readFavorites: async () => [],
    readActivity: async () => activityOf(rows),
  });
  assert.deepEqual(asked.removeEntryIds.sort(), ['repoA-old', 'repoB']);
  assert.equal(result.hasCandidates, true);
});
