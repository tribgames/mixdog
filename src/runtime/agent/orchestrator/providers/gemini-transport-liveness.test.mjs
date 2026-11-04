// Liveness of a Gemini API send as the agent progress watchdog sees it: a
// response the server sent is transport, even when it is a refusal the
// provider's own ladder retries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';

process.env.MIXDOG_DATA_DIR = makeTempDirSync('gemini-transport-liveness');

const { GeminiProvider } = await import('./gemini.mjs');
const { GEMINI_REQUEST_RETRY } = await import('./gemini-retry-policy.mjs');
const { getSessionProgressSnapshot, markSessionStreamDelta, updateSessionStage } = await import(
  '../session/manager/runtime-liveness.mjs'
);
const { runtimeState } = await import('../session/manager/runtime-state.mjs');
const { evaluateAgentWatchdogAbort, resolveAgentWatchdogPolicy } = await import(
  '../agent-runtime/agent-progress-watchdog.mjs'
);

const policy = resolveAgentWatchdogPolicy('writer');

test('a send refused with 429 on every attempt surfaces the 429; the agent watchdog never calls it a stall', async (t) => {
  const id = 'sess_gemini_refused_send';
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000 });
  t.after(() => runtimeState.delete(id));
  const verdicts = [];
  let calls = 0;
  const provider = new GeminiProvider({
    apiKey: 'fixture-key',
    preconnectFn: () => {},
    // Each backoff wait advances the clock the watchdog reads.
    sleepFn: async (ms) => {
      t.mock.timers.tick(ms);
      verdicts.push(evaluateAgentWatchdogAbort(getSessionProgressSnapshot(id), Date.now(), policy));
    },
    fetchFn: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: 'Your project has exceeded its monthly spending cap.',
            status: 'RESOURCE_EXHAUSTED',
          },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      );
    },
  });
  provider._ensureGeminiCache = async () => null;
  const startedAt = Date.now();

  await assert.rejects(
    provider.send([{ role: 'user', content: 'Polish this copy.' }], 'gemini-4-argon', [], {
      onStageChange: (stage) => updateSessionStage(id, stage),
      onStreamDelta: (kind) => markSessionStreamDelta(id, kind),
    }),
    (error) => {
      assert.equal(error.status, 429);
      assert.match(error.message, /monthly spending cap/);
      return true;
    }
  );
  assert.equal(calls, GEMINI_REQUEST_RETRY.maxAttempts);
  assert.ok(Date.now() - startedAt > policy.firstTransportMs, 'the ladder outlasts the first-transport deadline');
  assert.deepEqual(
    verdicts.map((verdict) => verdict?.message ?? null),
    verdicts.map(() => null)
  );
});
