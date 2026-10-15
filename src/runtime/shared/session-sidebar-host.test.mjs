import assert from 'node:assert/strict';
import test from 'node:test';
import { applySessionSidebarChange, registerSessionSidebarHost } from './session-sidebar-host.mjs';

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
