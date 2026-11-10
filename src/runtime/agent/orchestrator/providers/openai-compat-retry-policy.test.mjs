// Loop level: a profile's limits are final. A profiled provider that spent its
// ladder (or hit a profile stop) surfaces the failure instead of the agent loop
// re-running it through the 15/30/60s recovery cycles.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-compat-retry-policy-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_TRANSPORT_RETRY_BACKOFF_MS = '0,0,0';
process.env.MIXDOG_CONNECTION_RETRY_BACKOFF_MS = '0,0,0,0';
process.env.MIXDOG_RECOVERY_RETRY_BACKOFF_MS = '0,0,0,0,0';
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { sendWithRecovery } = await import('../session/send-with-recovery.mjs');
const { withRetry } = await import('./retry-classifier.mjs');
const { compatRetryOptions, withCompatRetryProfile } = await import('./openai-compat-retry-profile.mjs');
const { OpenAICompatProvider } = await import('./openai-compat.mjs');
const { GrokOAuthProvider } = await import('./grok-oauth.mjs');
const { MuseCodeOAuthProvider } = await import('./muse-code-oauth.mjs');
const { MimoOAuthProvider } = await import('./mimo-oauth.mjs');
const { CommandCodeOAuthProvider } = await import('./command-code-oauth.mjs');

const baseCtx = {
  messages: [],
  model: 'test-model',
  sendTools: [],
  tools: [],
  sessionId: 'sess-compat-retry-policy',
  nextIteration: 1,
};

const compat = (name) => new OpenAICompatProvider(name, { apiKey: 'fixture', preconnect: false });

// A send that runs the provider's real profile around an always-503 attempt.
function profiledSend(provider, counter) {
  return async () => {
    await withRetry(
      withCompatRetryProfile(provider.name, async () => {
        counter.attempts += 1;
        throw Object.assign(new Error('HTTP 503'), { status: 503 });
      }),
      { ...compatRetryOptions(provider.name), sleepFn: () => {} }
    );
  };
}

test('every profiled compat provider disables the loop recovery cycles', () => {
  for (const provider of [
    compat('deepseek'),
    new MuseCodeOAuthProvider({}),
    new MimoOAuthProvider({}),
    new CommandCodeOAuthProvider({}),
  ]) {
    assert.deepEqual({ ...provider.retryPolicy }, { recoveryCycles: false }, provider.name);
  }
  // Only the xAI providers treat an in-band invalid-request error as retryable.
  for (const provider of [compat('xai'), new GrokOAuthProvider({})]) {
    assert.deepEqual(
      { ...provider.retryPolicy },
      { recoveryCycles: false, inBandInvalidRequestRetryable: true },
      provider.name
    );
  }
  assert.equal(compat('custom-gw').retryPolicy, undefined);
});

test('a spent profile ladder is surfaced by the loop, not re-run through recovery cycles', async () => {
  for (const name of ['xai', 'deepseek']) {
    const counter = { attempts: 0 };
    const provider = compat(name);
    const send = profiledSend(provider, counter);
    await assert.rejects(
      sendWithRecovery({
        ...baseCtx,
        provider: { retryPolicy: provider.retryPolicy, send },
        opts: {},
        transportRetriesUsed: 0,
      }),
      /HTTP 503/
    );
    assert.equal(counter.attempts, name === 'xai' ? 15 : 6, name);
  }
});

test('an unprofiled provider still parks on the recovery cycles after its ladder', async () => {
  const counter = { attempts: 0 };
  const provider = compat('custom-gw');
  const parked = await sendWithRecovery({
    ...baseCtx,
    provider: {
      retryPolicy: provider.retryPolicy,
      send: async () => {
        counter.attempts += 1;
        await withRetry(
          async () => {
            throw Object.assign(new Error('HTTP 503'), { status: 503 });
          },
          { sleepFn: () => {} }
        );
      },
    },
    opts: {},
    transportRetriesUsed: 0,
  });
  assert.equal(parked.action, 'retry_transport');
});

test('a provider-terminal stream failure is not re-issued as a non-streaming request', async () => {
  const { recoverCompatNonStreaming } = await import('./openai-compat-chat-send.mjs');
  const { markProviderRecoveryExhausted } = await import('./retry-classifier.mjs');
  const failure = () => Object.assign(new Error('HTTP 503'), { status: 503 });
  for (const [terminal, expectedCalls] of [
    [true, 0],
    [false, 1],
  ]) {
    let calls = 0;
    const provider = {
      name: 'xai',
      client: {
        chat: {
          completions: {
            create: async () => {
              calls += 1;
              return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
            },
          },
        },
      },
    };
    await recoverCompatNonStreaming(provider, {
      streamErr: markProviderRecoveryExhausted(failure(), { terminal }),
      params: { model: 'm', messages: [] },
      opts: {},
      signal: null,
      useModel: 'm',
    });
    assert.equal(calls, expectedCalls, `terminal=${terminal}`);
  }
});

test('a profile stop is final at the loop level', async () => {
  for (const [name, status] of [
    ['xai', 429],
    ['command-code-oauth', 429],
    ['mimo-oauth', 501],
  ]) {
    const provider = compat(name);
    const counter = { attempts: 0 };
    await assert.rejects(
      sendWithRecovery({
        ...baseCtx,
        provider: {
          retryPolicy: provider.retryPolicy,
          send: async () => {
            await withRetry(
              withCompatRetryProfile(name, async () => {
                counter.attempts += 1;
                throw Object.assign(new Error(`HTTP ${status}`), { status });
              }),
              { ...compatRetryOptions(name), sleepFn: () => {} }
            );
          },
        },
        opts: {},
        transportRetriesUsed: 0,
      }),
      new RegExp(`HTTP ${status}`)
    );
    assert.ok(counter.attempts <= 2, name);
  }
});
