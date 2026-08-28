import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_COMPLETED_GOAL_TTL_MS,
  listStoredActiveGoalSessionIds,
  readStoredGoalSnapshot,
} from '../session-runtime/goal-runtime.mjs';
import { createSessionService } from './session-service.mjs';

function writeGoal(dataDir, sessionId, status, {
  archivedAt = null,
  completedAt = undefined,
  clock = 2_200_000_000_000,
} = {}) {
  const root = join(dataDir, 'goals');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${sessionId}.json`), JSON.stringify({
    version: 1,
    goal: {
      id: `goal-${status}-${sessionId}`,
      sessionId,
      objective: `Keep ${status} Goal`,
      title: `${status} Goal`,
      status,
      tasks: [
        { id: 'task_1', text: 'Keep progress', status: 'in_progress', kind: 'work' },
        { id: 'task_2', text: 'Verify recovery', status: 'pending', kind: 'verification' },
      ],
      blocker: status === 'blocked' ? 'External service unavailable' : '',
      failureReason: '',
      failureCount: 0,
      timeLimitMs: 0,
      timeUsedMs: 5_000,
      createdAt: clock - 10_000,
      updatedAt: clock - 5_000,
      lastStartedAt: status === 'active' ? clock - 5_000 : null,
      completedAt: completedAt === undefined
        ? status === 'complete' ? clock - 5_000 : null
        : completedAt,
      archivedAt,
    },
  }));
}

function fakeRuntimeFactory({ dataDir, storedSessions, created, resumed, clock }) {
  return async () => {
    created.push(true);
    const listeners = new Set();
    let state = {
      sessionId: '',
      items: [],
      queued: [],
      busy: false,
      commandBusy: false,
    };
    return {
      isWireSafe: true,
      getState: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async resume(sessionId) {
        resumed.push(sessionId);
        const stored = storedSessions.get(sessionId);
        if (!stored) return false;
        state = {
          ...stored,
          sessionId,
          goal: readStoredGoalSnapshot({
            dataDir,
            sessionId,
            now: () => clock,
          }),
        };
        for (const listener of listeners) listener();
        return true;
      },
      async dispose() {},
    };
  };
}

test('recreated session service projects every unexpired Goal cold and resumes only active Goals', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-session-goal-restart-'));
  const clock = 2_200_000_000_000;
  const ids = {
    active: 'sess_goal_restart_active',
    paused: 'sess_goal_restart_paused',
    blocked: 'sess_goal_restart_blocked',
    complete: 'sess_goal_restart_complete',
    archived: 'sess_goal_restart_archived',
    expired: 'sess_goal_restart_expired',
  };
  for (const [status, sessionId] of Object.entries(ids)) {
    writeGoal(dataDir, sessionId, ['archived', 'expired'].includes(status) ? 'complete' : status, {
      archivedAt: status === 'archived' ? clock - 1_000 : null,
      completedAt: status === 'expired' ? clock - DEFAULT_COMPLETED_GOAL_TTL_MS : undefined,
      clock,
    });
  }
  const storedSessions = new Map(Object.values(ids).map((sessionId) => [
    sessionId,
    {
      sessionId,
      provider: 'openai-oauth',
      model: 'test-model',
      items: [{ id: `item-${sessionId}`, kind: 'assistant', text: 'Persisted transcript' }],
      queued: [],
    },
  ]));
  const created = [];
  const resumed = [];
  const readGoal = async (sessionId) => readStoredGoalSnapshot({
    dataDir,
    sessionId,
    now: () => clock,
  });
  const service = createSessionService({
    createSessionRuntime: fakeRuntimeFactory({
      dataDir,
      storedSessions,
      created,
      resumed,
      clock,
    }),
    sessionExists: async (sessionId) => storedSessions.has(sessionId),
    readStoredSession: async (sessionId) => storedSessions.get(sessionId) || null,
    readStoredGoal: readGoal,
    listStoredActiveGoalSessionIds: async () => listStoredActiveGoalSessionIds({
      dataDir,
      now: () => clock,
    }),
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
  try {
    for (const status of ['active', 'paused', 'blocked', 'complete']) {
      const result = await service.subscribeSession(
        { sessionId: ids[status] },
        { clientToken: `viewer-${status}` },
      );
      assert.equal(result.projection, true);
      assert.equal(result.full.goal.status, status);
      assert.equal(result.full.goal.tasks[0].status, 'in_progress');
      if (status === 'active') assert.equal(result.full.goal.timeUsedMs, 10_000);
    }
    const archived = await service.subscribeSession(
      { sessionId: ids.archived },
      { clientToken: 'viewer-archived' },
    );
    assert.equal(archived.full.goal, null);
    assert.equal(created.length, 0);

    const recovery = await service.recoverActiveGoals();
    assert.deepEqual(recovery, { found: 1, resumed: 1, skipped: 0, failed: 0 });
    assert.equal(created.length, 1);
    assert.deepEqual(resumed, [ids.active]);
    assert.equal(service.status.live, 1);
    const expired = await service.subscribeSession(
      { sessionId: ids.expired },
      { clientToken: 'viewer-expired' },
    );
    assert.equal(expired.full.goal, null);
    assert.equal(
      existsSync(join(dataDir, 'goals', `${ids.expired}.json`)),
      false,
    );
  } finally {
    await service.stop('test complete');
    rmSync(dataDir, { recursive: true, force: true });
  }
});
