import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLifecycleApi, resolveResumeCwd } from './lifecycle-api.mjs';

test('project resume prefers canonical session cwd over stale desktop metadata', () => {
  assert.equal(resolveResumeCwd({
    cwd: 'C:\\Project\\mixdog',
    desktopSession: {
      classification: 'project',
      projectPath: 'C:\\Project\\GamerScroll',
    },
  }, 'C:\\fallback'), 'C:\\Project\\mixdog');
});

test('unclassified desktop task resume stays in its host-managed workspace', () => {
  assert.equal(resolveResumeCwd({
    cwd: 'C:\\old-transient',
    desktopSession: { classification: 'task', projectPath: null },
  }, 'C:\\task-workspace'), 'C:\\task-workspace');
});

test('lifecycle listSessions applies durable child visibility at the public catalog boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-lifecycle-visibility-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    const calls = [];
    const rows = [
      {
        id: 'ordinary-user',
        owner: 'user',
        preview: 'ordinary prompt',
        messageCount: 1,
      },
      {
        id: 'ordinary-schedule',
        owner: 'mixdog',
        sourceType: 'schedule',
        preview: 'scheduled prompt',
        messageCount: 1,
      },
      {
        id: 'explicit-child',
        owner: 'user',
        ownerSessionId: 'root-lead',
        agent: 'reviewer',
        visibility: 'agent-only',
        preview: 'must stay in Agent UI',
        messageCount: 1,
      },
      {
        id: 'legacy-child',
        owner: 'agent',
        parentSessionId: 'root-lead',
        agent: 'reviewer',
        preview: 'legacy Agent child',
        messageCount: 1,
      },
      {
        id: 'root-lead',
        owner: 'agent',
        agent: 'lead',
        preview: 'root Lead prompt',
        messageCount: 1,
      },
      {
        id: 'self-parent-lead',
        owner: 'agent',
        ownerSessionId: 'self-parent-lead',
        agent: 'lead',
        preview: 'recovered Lead prompt',
        messageCount: 1,
      },
    ];
    const api = createLifecycleApi({
      mgr: {
        listSessions(options) {
          calls.push(options);
          return rows;
        },
      },
    });

    const listed = api.listSessions({ refreshFromStorage: true });
    assert.deepEqual(
      listed.map((row) => row.id),
      ['ordinary-user', 'ordinary-schedule', 'root-lead', 'self-parent-lead'],
    );
    assert.deepEqual(calls, [{ refreshFromStorage: true }]);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical child close uses the ordinary durable tombstone barrier', () => {
  const calls = [];
  let current = { id: 'sess_agent_child', remoteAttached: false };
  let invalidations = 0;
  const api = createLifecycleApi({
    getSession: () => current,
    setSession: (session) => { current = session; },
    invalidateContextStatusCache: () => { invalidations += 1; },
    mgr: {
      closeSession(...args) {
        calls.push(args);
        return true;
      },
    },
  });

  assert.equal(api.closeCanonicalSession('cli-agent-close'), true);
  assert.deepEqual(calls, [[
    'sess_agent_child',
    'cli-agent-close',
    { tombstone: true },
  ]]);
  assert.equal(current, null);
  assert.equal(invalidations, 1);
});
