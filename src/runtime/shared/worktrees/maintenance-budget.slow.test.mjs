// The automatic worktree cleanup against real git: the count, age and archive
// removals of one pass share one budget.
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { configureWorktreeManager } from './manager.mjs';
import { runWorktreeCleanup, setArchivedSessionWorktrees } from './maintenance.mjs';
import { getRecord, putRecord } from './registry.mjs';
import { cleanupTempDirs, createTestWorktree as create, makeRepo, useTempDataDir } from './test-support.mjs';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
let restore = () => {};

function configure(settings = {}, extra = {}) {
  restore();
  restore = configureWorktreeManager({
    settings,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    processAlive: () => false,
    ...extra,
  });
}

beforeEach(() => {
  useTempDataDir();
  configure();
});
afterEach(() => restore());
after(() => cleanupTempDirs());

async function backdate(entry, ageMs) {
  await putRecord({ ...(await getRecord(entry.id)), createdAt: Date.now() - ageMs });
}

/** Worktrees whose owners stay stored, with their sessions' last activity `idle` ago. */
async function setup(repo, names) {
  const made = {};
  for (const [name, { idleMs = 10 * DAY, ageMs = idleMs } = {}] of Object.entries(names)) {
    made[name] = await create(repo, { nameHint: name });
    await backdate(made[name].entry, ageMs);
    made[name].idleMs = idleMs;
  }
  const now = Date.now();
  return {
    made,
    options: (extra = {}) => ({
      listSessionIds: async () => Object.values(made).map((item) => item.sessionId),
      readActivity: async () =>
        Object.fromEntries(Object.values(made).map((item) => [item.sessionId, { lastActiveAt: now - item.idleMs }])),
      readFavorites: async () => [],
      listJobs: async () => [],
      ...extra,
    }),
  };
}

test('one budget per pass: 21 eligible archived worktrees, 20 removed', async () => {
  const repo = makeRepo();
  const names = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`arch-${i}`, { idleMs: 2 * HOUR }]));
  const { made, options } = await setup(repo, names);
  configure({ maxWorktrees: 0, unusedDays: 0 });
  await setArchivedSessionWorktrees(
    Object.values(made).map((item) => item.sessionId),
    true
  );
  const report = await runWorktreeCleanup(options());
  assert.equal(report.removed.length, 20);
  assert.equal(report.kept.filter((item) => item.reason === 'budget').length, 1);
  const second = await runWorktreeCleanup(options());
  assert.equal(second.removed.length, 1, 'the rest goes in the next pass');
});
