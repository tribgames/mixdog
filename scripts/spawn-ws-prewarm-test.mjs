import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenAIOAuthProvider } from '../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { buildStableProviderPromptCacheKey } from '../src/runtime/agent/orchestrator/agent-runtime/cache-strategy.mjs';

const FAKE_AUTH = { type: 'openai-oauth', access_token: 'tok', account_id: 'acct' };

function makeProvider() {
  // Prototype-only instance: the real constructor preconnects to the live
  // endpoint and reads token storage, which a unit test must not do.
  const provider = Object.create(OpenAIOAuthProvider.prototype);
  provider.ensureAuth = async () => FAKE_AUTH;
  return provider;
}

const noopSeams = () => {
  const calls = { acquire: [], release: [] };
  return {
    calls,
    seams: {
      _warmVersion: async () => '0.147.0',
      _hasPooled: () => false,
      _acquire: async (args) => {
        calls.acquire.push(args);
        return { entry: { fake: true }, reused: false };
      },
      _release: (args) => { calls.release.push(args); },
    },
  };
};

test('spawn prewarm opens and pools a socket keyed exactly like the first send', async () => {
  const provider = makeProvider();
  const { calls, seams } = noopSeams();
  const sessionId = 'sess_171_1786404371995_1786404372146_63e97c273d90357f826048d1b96c1670';
  const ok = await provider.prewarmWsTransportForSession({ sessionId }, seams);
  assert.equal(ok, true);
  assert.equal(calls.acquire.length, 1);
  const acquire = calls.acquire[0];
  assert.equal(acquire.poolKey, sessionId);
  // cacheKey parity with buildRequestBody's thread-scoped prompt_cache_key —
  // a mismatch would make the pooled socket incompatible at first acquire.
  assert.equal(acquire.cacheKey, buildStableProviderPromptCacheKey('openai-oauth', { sessionId }));
  assert.equal(acquire.auth, FAKE_AUTH);
  assert.ok(acquire.codexHeaders && typeof acquire.codexHeaders === 'object');
  assert.deepEqual(calls.release, [{ entry: { fake: true }, poolKey: sessionId, keep: true }]);
});

test('spawn prewarm skips without a session id and when a socket is already pooled', async () => {
  const provider = makeProvider();
  const { calls, seams } = noopSeams();
  assert.equal(await provider.prewarmWsTransportForSession({}, seams), false);
  assert.equal(calls.acquire.length, 0);
  const pooled = await provider.prewarmWsTransportForSession(
    { sessionId: 'sess_pooled' },
    { ...seams, _hasPooled: () => true },
  );
  assert.equal(pooled, true);
  assert.equal(calls.acquire.length, 0);
});

test('spawn prewarm honors forced-HTTP and disabled thread cache key gates', async () => {
  const provider = makeProvider();
  const { calls, seams } = noopSeams();
  process.env.MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK = '1';
  try {
    assert.equal(await provider.prewarmWsTransportForSession({ sessionId: 'sess_http' }, seams), false);
  } finally {
    delete process.env.MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK;
  }
  process.env.MIXDOG_OAI_CODEX_THREAD_CACHE_KEY = '0';
  try {
    assert.equal(await provider.prewarmWsTransportForSession({ sessionId: 'sess_nothread' }, seams), false);
  } finally {
    delete process.env.MIXDOG_OAI_CODEX_THREAD_CACHE_KEY;
  }
  assert.equal(calls.acquire.length, 0);
});

test('spawn prewarm swallows handshake failures as a best-effort no-op', async () => {
  const provider = makeProvider();
  const { seams } = noopSeams();
  const ok = await provider.prewarmWsTransportForSession({ sessionId: 'sess_fail' }, {
    ...seams,
    _acquire: async () => { throw new Error('handshake 502'); },
  });
  assert.equal(ok, false);
});
