import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeDiscoveryChanged } from '../bridge-discovery.mjs';

test('success, failure and cancellation request cleanup for the exact turn without replay or cancelled signals', async t => {
  const discovery = { port: 12345, token: 'test-only-token' };
  const requests = [];
  let failCleanup = false;
  t.mock.module('../bridge-discovery.mjs', { namedExports: {
    readBridgeDiscovery: () => discovery,
    readBridgeDiscoveryDetail: () => ({ reason: 'missing' }),
    bridgeDiscoveryChanged,
  } });
  t.mock.module('./timing.mjs', { namedExports: { traceBrowserTiming() {} } });
  t.mock.module('../agent/orchestrator/session/store.mjs', { namedExports: {
    publishHeartbeat() {}, deleteHeartbeat() {},
  } });
  t.mock.module('../agent/orchestrator/session/manager/usage-metrics.mjs', { namedExports: {
    configureUsageMetricsRuntime() {}, dropMetricSeenState() {},
    bumpUsageMetricsTurnId(session) { session.usageMetricsTurnId++; },
  } });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const input = JSON.parse(options.body);
    requests.push({ ...input, aborted: options.signal.aborted });
    if (options.signal.aborted) throw new DOMException('aborted', 'AbortError');
    return new Response(JSON.stringify(input.action === 'finish_turn' && failCleanup
      ? { ok: false, error: 'cleanup refused' } : { ok: true, value: { text: 'ok' } }),
    { status: input.action === 'finish_turn' && failCleanup ? 500 : 200 });
  });
  const { executeBrowserTool, finishBrowserTurn } = await import('./client.mjs');
  const { configureRuntimeLiveness, markSessionAskStart, markSessionDone, markSessionError,
    markSessionCancelled } = await import('../agent/orchestrator/session/manager/runtime-liveness.mjs');
  const sessions = new Map();
  configureRuntimeLiveness({ loadSession: id => sessions.get(id) });
  for (const [id, finish] of [['success', markSessionDone], ['failure', markSessionError], ['cancel', markSessionCancelled]]) {
    sessions.set(id, { usageMetricsTurnId: 6 });
    markSessionAskStart(id);
    const controller = new AbortController();
    if (id === 'cancel') controller.abort();
    await executeBrowserTool({ action: 'navigate', input: { url: 'https://example.test', background: true } },
      { sessionId: id, turnId: 7, signal: controller.signal });
    finish(id);
    await new Promise(resolve => setImmediate(resolve));
    const cleanup = requests.filter(request => request.session_id === id && request.action === 'finish_turn');
    assert.deepEqual(cleanup, [{ action: 'finish_turn', session_id: id, turn_id: 7, aborted: false }]);
    await finishBrowserTurn(id, 7);
    assert.equal(requests.filter(request => request.session_id === id && request.action === 'finish_turn').length, 1);
  }
  const count = requests.length;
  markSessionDone('no-browser');
  assert.equal(requests.length, count, 'a non-browser turn does not contact the desktop');
  await executeBrowserTool({ action: 'status' }, { sessionId: 'cleanup-error', turnId: 9 });
  failCleanup = true;
  await assert.rejects(finishBrowserTurn('cleanup-error', 9), /cleanup refused/);
  const failedCount = requests.length;
  await finishBrowserTurn('cleanup-error', 9);
  assert.equal(requests.length, failedCount, 'unknown cleanup effects are not retried');
});
