import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeDiscoveryChanged } from '../bridge-discovery.mjs';

test('deleting a session forgets its browser bookkeeping, so a later turn start tells the desktop nothing', async (t) => {
  const requests = [];
  t.mock.module('../bridge-discovery.mjs', {
    namedExports: {
      readBridgeDiscovery: () => ({ port: 12345, token: 'test-only-token' }),
      readBridgeDiscoveryDetail: () => ({ reason: 'missing' }),
      bridgeDiscoveryChanged,
    },
  });
  t.mock.module('./timing.mjs', { namedExports: { traceBrowserTiming() {} } });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, value: { text: 'ok' } }), { status: 200 });
  });
  const { executeBrowserTool, beginBrowserTurn, finishBrowserTurn } = await import('./client.mjs');
  await import('../agent/orchestrator/session/manager/runtime-liveness.mjs');
  const { _runSessionPurgeHooks } = await import('../agent/orchestrator/session/store/session-observers.mjs');
  const begins = (id) => requests.filter((r) => r.session_id === id && r.action === 'begin_turn').length;

  for (const id of ['kept', 'deleted']) {
    await executeBrowserTool({ action: 'status' }, { sessionId: id, turnId: 3 });
    await beginBrowserTurn(id, 4);
    assert.equal(begins(id), 1, 'a session that used the browser announces its turns');
  }
  _runSessionPurgeHooks('deleted');
  await beginBrowserTurn('deleted', 5);
  await beginBrowserTurn('kept', 5);
  assert.equal(begins('deleted'), 1, 'a deleted session is no longer a browser session');
  assert.equal(begins('kept'), 2, 'other sessions are untouched');
  const seen = requests.length;
  await finishBrowserTurn('deleted', 4);
  assert.equal(requests.length, seen, 'a deleted session has no turn left to finish');
});
