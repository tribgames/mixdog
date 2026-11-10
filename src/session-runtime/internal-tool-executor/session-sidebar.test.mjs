import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerSessionSidebarHost } from '../../runtime/shared/session-sidebar-host.mjs';
import { createWorkspaceToolHandlers } from './workspace-tools.mjs';

function handlers() {
  const rt = { session: { id: 'sess-1' }, currentCwd: process.cwd() };
  return createWorkspaceToolHandlers({ rt, applyResolvedCwd: () => assert.fail('cwd must not change') });
}

const run = (args, callerCtx = {}) => handlers().session(args, { callerCtx, callerCwd: process.cwd() });

test('favorite and archive reach the registered desktop host for the current session', async () => {
  const seen = [];
  const unregister = registerSessionSidebarHost(async (sessionId, change) => seen.push([sessionId, change]));
  try {
    assert.deepEqual(JSON.parse(await run({ action: 'favorite', value: true })), {
      action: 'favorite',
      sessionId: 'sess-1',
      favorite: true,
    });
    await run({ action: 'archive', value: false });
    assert.deepEqual(seen, [
      ['sess-1', { favorite: true }],
      ['sess-1', { archived: false }],
    ]);

    await assert.rejects(run({ action: 'favorite' }), /value \(boolean\) is required/);
    await assert.rejects(run({ action: 'archive', value: 'yes' }), /value \(boolean\) is required/);
    await assert.rejects(run({ action: 'set-sidebar-project', path: '' }), /unknown action "set-sidebar-project"/);
    for (const args of [
      { action: 'favorite', value: true },
      { action: 'archive', value: true },
    ]) {
      await assert.rejects(run(args, { callerSessionId: 'worker-1' }), /belongs to the Lead session/);
    }
    assert.equal(seen.length, 2, 'refused calls never reach the host');
  } finally {
    unregister();
  }
});

test('the sidebar actions report a missing desktop host and surface its failures', async () => {
  await assert.rejects(run({ action: 'favorite', value: true }), /favorite failed \(no desktop app is attached/);
  const unregister = registerSessionSidebarHost(async () => {
    throw new TypeError('session id is invalid.');
  });
  try {
    await assert.rejects(run({ action: 'archive', value: true }), /archive failed \(session id is invalid/);
  } finally {
    unregister();
  }
});
