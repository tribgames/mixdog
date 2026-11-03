// The runtime stamps the session's life mark on every browser command, so the
// desktop can bind "allow for this session" to it (never taken from model arguments).
import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeDiscoveryChanged } from '../bridge-discovery.mjs';

test('a browser command carries the session life mark, which changes when the session is cleared', async (t) => {
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
  const { executeBrowserTool } = await import('./client.mjs');
  const { setLiveSession } = await import('../agent/orchestrator/session/store.mjs');
  const id = 'sess_home_stamp';
  const run = async () => {
    await executeBrowserTool(
      { action: 'navigate', input: { url: 'https://example.test', background: true } },
      { sessionId: id, turnId: 1 }
    );
    return requests.at(-1).session_life;
  };
  setLiveSession({ id, owner: 'cli', agent: 'lead', createdAt: 9 });
  const first = await run();
  assert.equal(first, '9:0');
  setLiveSession({ id, owner: 'cli', agent: 'lead', createdAt: 9, compaction: { lastClearAt: 50 } });
  assert.equal(await run(), '9:50');
  assert.equal(
    'session_life' in
      (await (async () => {
        await executeBrowserTool(
          { action: 'navigate', input: { url: 'https://example.test' } },
          { sessionId: 'sess_unknown_zzz', turnId: 1 }
        );
        return requests.at(-1);
      })()),
    false
  );
});
