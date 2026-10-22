import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySessionSidebarChange,
  registerSessionSidebarHost,
} from '../../../../src/runtime/shared/session-sidebar-host.mjs';
import { sessionSidebarActions, sessionSidebarChangeHandler } from './session-sidebar-actions.ts';

const SESSION = `sess_desktop_${'a'.repeat(64)}`;

function fakeHost() {
  const calls = [];
  return {
    calls,
    host: {
      setSessionFavorite: async (...args) => calls.push(['favorite', ...args]),
      setSessionArchived: async (...args) => calls.push(['archived', ...args]),
      setSessionProject: async (...args) => calls.push(['project', ...args]),
      forgetSessionMetadata: async (...args) => calls.push(['forgotten', ...args]),
    },
  };
}

test('a session the store deleted on its own reaches the host as a forgotten change', async () => {
  const { host, calls } = fakeHost();
  const apply = sessionSidebarChangeHandler(host);
  await apply(SESSION, { forgotten: true });
  await assert.rejects(apply(SESSION, { forgotten: false }), /change is invalid/);
  await assert.rejects(apply('bad id', { forgotten: true }), /session id is invalid/);
  assert.deepEqual(calls, [['forgotten', SESSION]]);
});

test('a runtime sidebar change reaches the desktop host methods through the shared channel', async () => {
  const { host, calls } = fakeHost();
  const unregister = registerSessionSidebarHost(sessionSidebarChangeHandler(host));
  try {
    await applySessionSidebarChange(SESSION, { favorite: true });
    await applySessionSidebarChange(SESSION, { archived: false });
    // A project move is a working-folder change, never a sidebar change.
    await assert.rejects(applySessionSidebarChange(SESSION, { project: '' }), /change is invalid/);
    assert.deepEqual(calls, [
      ['favorite', SESSION, true],
      ['archived', SESSION, false],
    ]);
  } finally {
    unregister();
  }
  await assert.rejects(applySessionSidebarChange(SESSION, { favorite: true }), /no desktop app is attached/);
});

test('the runtime channel applies the same validation as the window IPC', async () => {
  const { host, calls } = fakeHost();
  const apply = sessionSidebarChangeHandler(host);
  await assert.rejects(apply(SESSION, { favorite: 1 }), /favorite must be a boolean/);
  await assert.rejects(apply(SESSION, { archived: 'yes' }), /archived must be a boolean/);
  await assert.rejects(apply('bad id', { favorite: true }), /session id is invalid/);
  await assert.rejects(apply(SESSION, { other: true }), /change is invalid/);
  assert.equal(calls.length, 0);
});

test('a project move takes a project path or "" (no project), nothing else', async () => {
  const { host, calls } = fakeHost();
  const actions = sessionSidebarActions(host);
  for (const projectPath of [null, undefined, 3]) {
    assert.throws(() => actions.setSessionProject(SESSION, projectPath), /projectPath must be a string/);
  }
  await actions.setSessionProject(SESSION, 'C:\\Work\\Alpha');
  await actions.setSessionProject(SESSION, '');
  assert.deepEqual(calls, [
    ['project', SESSION, 'C:\\Work\\Alpha'],
    ['project', SESSION, ''],
  ]);
});
