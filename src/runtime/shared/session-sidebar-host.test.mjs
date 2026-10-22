import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySessionSidebarChange,
  readSessionSidebarState,
  registerSessionSidebarHost,
} from './session-sidebar-host.mjs';

test('the flags come from the active host, null without one or without a state reader', async () => {
  assert.equal(await readSessionSidebarState(), null);
  const unregisterPlain = registerSessionSidebarHost(async () => {});
  const unregister = registerSessionSidebarHost(async () => {}, {
    state: async () => ({ archived: { 'sess-1': 5 } }),
  });
  try {
    assert.deepEqual(await readSessionSidebarState(), { archived: { 'sess-1': 5 } });
    unregister();
    assert.equal(await readSessionSidebarState(), null, 'an older desktop without a reader answers nothing');
  } finally {
    unregister();
    unregisterPlain();
  }
});

test('a sidebar change reaches exactly one host: the most recently registered', async () => {
  const seen = [];
  const host = (name) => async (sessionId, change) => seen.push([name, sessionId, change]);
  const unregisterFirst = registerSessionSidebarHost(host('first'));
  const unregisterSecond = registerSessionSidebarHost(host('second'));
  try {
    await applySessionSidebarChange('sess-1', { favorite: true });
    assert.deepEqual(seen, [['second', 'sess-1', { favorite: true }]], 'never broadcast');

    unregisterSecond();
    unregisterSecond(); // idempotent: must not drop another host
    await applySessionSidebarChange('sess-1', { archived: true });
    assert.deepEqual(seen.at(-1), ['first', 'sess-1', { archived: true }]);
    assert.equal(seen.length, 2);
  } finally {
    unregisterSecond();
    unregisterFirst();
  }
  await assert.rejects(applySessionSidebarChange('sess-1', { favorite: true }), /no desktop app is attached/);
});
