import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  ModelProxyChannel,
  MODEL_PROXY_OPERATIONS,
  decodeModelProxyWire,
  encodeModelProxyWire,
  getModelProxyChannel,
  modelProxyErrorToWire,
} from './model-proxy-channel.mjs';
import {
  ModelProxyProvider,
  _resetModelProxyProviderConfigForTest,
  createModelProxyProvider,
} from './model-proxy-provider.mjs';
import { ProviderAdmissionScheduler, wrapProviderAdmission } from './admission-scheduler.mjs';
import { closeUsageLedgers, getUsageLedger } from '../../../shared/llm/usage-ledger.mjs';
import { getAgentApiKey, hasAgentApiKey } from '../../../shared/provider-api-key.mjs';
import { replaceProviderAuthBindings } from '../../../shared/provider-auth-binding.mjs';
import { oauthCredentialProbeState } from './oauth-credential-probes.mjs';
import { loadCredentials, refreshOAuthCredentials } from './anthropic-oauth-credentials.mjs';
import { loadTokens as loadOpenAIOAuthTokens } from './openai-oauth-tokens.mjs';
import { getProvider, initProviders, providerInputExcludesCache, providerNativePdf } from './registry.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function useEnv(t, values) {
  const prior = {};
  for (const [key, value] of Object.entries(values)) {
    prior[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Stand-in for the desktop client: sees every published snapshot and
 *  answers each new request through the channel's operations. */
function attachPc(channel, onRequest, snapshots = []) {
  const handled = new Set();
  return channel.attachPublisher((snapshot) => {
    snapshots.push(snapshot);
    for (const request of snapshot.requests) {
      if (handled.has(request.id)) continue;
      handled.add(request.id);
      queueMicrotask(() => onRequest(request));
    }
  });
}

const op = (channel, name, ...args) => channel.handleOperation(MODEL_PROXY_OPERATIONS[name], args);

test('a proxied send streams every callback, settles with the PC result and is accounted on the daemon', async (t) => {
  const ledgerPath = join(tempDir('mixdog-model-proxy-ledger-'), 'ledger.sqlite');
  useEnv(t, { MIXDOG_USAGE_LEDGER_PATH: ledgerPath });
  t.after(() => closeUsageLedgers());
  const channel = new ModelProxyChannel();
  const scheduler = new ProviderAdmissionScheduler({ concurrency: 2 });
  t.after(() => scheduler.shutdown());
  const provider = wrapProviderAdmission(
    createModelProxyProvider('anthropic-oauth', { modelProxy: { inputExcludesCache: true } }, channel),
    'anthropic-oauth',
    scheduler
  );
  let call = null;
  let replies = null;
  let secondClaim;
  t.after(
    attachPc(channel, async ({ id, provider: name, method, model }) => {
      assert.deepEqual({ name, method, model }, { name: 'anthropic-oauth', method: 'send', model: 'claude-test' });
      call = decodeModelProxyWire(op(channel, 'claim', id).payload);
      secondClaim = op(channel, 'claim', id);
      const reply = await op(
        channel,
        'event',
        id,
        encodeModelProxyWire([
          { name: 'onStageChange', args: ['streaming'] },
          { name: 'onTextDelta', args: ['Hel'] },
          { name: 'onTextDelta', args: ['lo'] },
          { name: 'onTextReset', args: [{ chars: 5 }] },
        ])
      );
      assert.equal(reply.cancelled, false);
      replies = decodeModelProxyWire(reply.results);
      op(
        channel,
        'resolve',
        id,
        true,
        encodeModelProxyWire({
          content: 'Hello',
          model: 'claude-test',
          responseId: 'proxy-response-1',
          usage: { inputTokens: 100, outputTokens: 10 },
        }),
        null
      );
    })
  );

  const seen = [];
  const result = await provider.send(
    [{ role: 'user', content: 'hi', bytes: Buffer.from([1, 2, 3]) }],
    'claude-test',
    undefined,
    {
      sessionId: 'proxy-session',
      effort: 'high',
      _stallRetryBudget: { allowStallRetry() {} },
      sleepFn: () => {},
      onStageChange: (stage) => {
        seen.push(['stage', stage]);
      },
      onTextDelta: (text) => {
        seen.push(['text', text]);
      },
      onTextReset: async ({ chars }) => {
        seen.push(['reset', chars]);
        return true;
      },
    }
  );

  assert.equal(result.content, 'Hello');
  assert.deepEqual(seen, [
    ['stage', 'requesting'],
    ['stage', 'streaming'],
    ['text', 'Hel'],
    ['text', 'lo'],
    ['reset', 5],
  ]);
  // The PC receives the callback's own answer (onTextReset's acknowledgement).
  assert.deepEqual(
    replies.map((reply) => reply.value),
    [null, null, null, true]
  );
  assert.equal(secondClaim, null, 'a claimed call cannot be claimed twice');
  // Signal, process-local `_` seams and non-callback functions stay on the daemon.
  assert.deepEqual(call.options, { sessionId: 'proxy-session', effort: 'high' });
  assert.deepEqual(call.callbacks, ['onStageChange', 'onTextDelta', 'onTextReset']);
  assert.ok(Buffer.isBuffer(call.messages[0].bytes));
  assert.deepEqual([...call.messages[0].bytes], [1, 2, 3]);
  assert.equal(call.tools, null);
  // Usage accounting on the daemon recorded the PC-reported usage.
  const rows = getUsageLedger()
    .db.prepare("SELECT provider, model, input, output FROM events WHERE session_id = 'proxy-session'")
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ provider: 'anthropic-oauth', model: 'claude-test', input: 100, output: 10 }]);
  assert.deepEqual(channel.snapshot(), { requests: [], cancelled: [] });
});

test('a PC-side failure keeps every error property the recovery path reads', async (t) => {
  const channel = new ModelProxyChannel();
  const provider = new ModelProxyProvider('openai', {}, channel);
  t.after(
    attachPc(channel, ({ id }) => {
      op(channel, 'claim', id);
      const error = Object.assign(new Error('stream stalled'), {
        name: 'StreamStalledError',
        status: 529,
        partialContent: 'par',
        liveTextEmitted: true,
        partialUsage: { inputTokens: 3 },
      });
      op(channel, 'resolve', id, false, null, encodeModelProxyWire(modelProxyErrorToWire(error)));
    })
  );
  const error = await provider.send([], 'gpt-test', undefined, {}).then(
    () => null,
    (failure) => failure
  );
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'StreamStalledError');
  assert.equal(error.message, 'stream stalled');
  assert.equal(error.status, 529);
  assert.equal(error.partialContent, 'par');
  assert.equal(error.liveTextEmitted, true);
  assert.deepEqual(error.partialUsage, { inputTokens: 3 });
});

test('a daemon-side abort rejects at once and cancels the PC-side call', async (t) => {
  const channel = new ModelProxyChannel();
  const provider = new ModelProxyProvider('openai', {}, channel);
  const claimed = Promise.withResolvers();
  const snapshots = [];
  t.after(
    attachPc(
      channel,
      ({ id }) => {
        op(channel, 'claim', id);
        claimed.resolve(id);
      },
      snapshots
    )
  );
  const deltas = [];
  const controller = new AbortController();
  const sending = provider.send([], 'gpt-test', undefined, {
    signal: controller.signal,
    onTextDelta: (text) => deltas.push(text),
  });
  const id = await claimed.promise;
  controller.abort(new Error('user stop'));
  await assert.rejects(sending, /user stop/);
  // Published so the PC aborts its provider call; every channel answer agrees.
  assert.deepEqual(snapshots.at(-1), { requests: [], cancelled: [id] });
  const late = await op(channel, 'event', id, encodeModelProxyWire([{ name: 'onTextDelta', args: ['late'] }]));
  assert.equal(late.cancelled, true);
  assert.deepEqual(deltas, [], 'no callback runs after the daemon gave up');
  assert.deepEqual(op(channel, 'heartbeat', [id]).cancelled, [id]);
  assert.equal(
    op(channel, 'resolve', id, false, null, encodeModelProxyWire(modelProxyErrorToWire(new Error('x')))),
    true
  );
  assert.deepEqual(channel.snapshot(), { requests: [], cancelled: [] });

  // Aborted before any client claimed it: the call is simply withdrawn.
  const early = new AbortController();
  const idle = new ModelProxyChannel();
  const published = [];
  t.after(idle.attachPublisher((snapshot) => published.push(snapshot)));
  const pending = new ModelProxyProvider('openai', {}, idle).send([], 'gpt-test', undefined, { signal: early.signal });
  const pendingId = published.at(-1).requests[0].id;
  early.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(op(idle, 'claim', pendingId), null);
  assert.deepEqual(published.at(-1), { requests: [], cancelled: [] });
});

test('without a connected client every call fails fast and never falls back', async (t) => {
  const unavailable = { code: 'MODEL_PROXY_UNAVAILABLE', message: /model proxy unavailable/ };
  const channel = new ModelProxyChannel();
  const provider = new ModelProxyProvider('anthropic', {}, channel);
  const startedAt = Date.now();
  await assert.rejects(provider.send([], 'm', undefined, {}), unavailable);
  await assert.rejects(provider.listModels(), unavailable);
  assert.ok(Date.now() - startedAt < 1_000);

  // The client disconnects while it runs a call.
  const claimed = Promise.withResolvers();
  const detach = attachPc(channel, ({ id }) => {
    op(channel, 'claim', id);
    claimed.resolve(id);
  });
  const running = provider.send([], 'm', undefined, {});
  await claimed.promise;
  detach();
  await assert.rejects(running, unavailable);
  await assert.rejects(provider.send([], 'm', undefined, {}), unavailable);

  // Transport hook: the last client left although its service stays loaded.
  t.after(channel.attachPublisher(() => {}));
  const parked = provider.send([], 'm', undefined, {});
  channel.setClientPresent(false);
  await assert.rejects(parked, unavailable);
  await assert.rejects(provider.send([], 'm', undefined, {}), unavailable);
  channel.setClientPresent(true);

  // A client that never picks a call up, or goes silent while running one.
  let now = 1_000;
  const timed = new ModelProxyChannel({ now: () => now, claimTimeoutMs: 100, leaseMs: 200, sweepMs: 60_000 });
  const ids = [];
  t.after(timed.attachPublisher((snapshot) => ids.push(...snapshot.requests.map((request) => request.id))));
  const unclaimed = new ModelProxyProvider('openai', {}, timed).send([], 'm', undefined, {});
  now += 150;
  timed.sweep();
  await assert.rejects(unclaimed, { code: 'MODEL_PROXY_UNAVAILABLE', message: /did not pick up/ });
  const silent = new ModelProxyProvider('openai', {}, timed).send([], 'm', undefined, {});
  op(timed, 'claim', ids.at(-1));
  now += 150;
  op(timed, 'heartbeat', [ids.at(-1)]);
  now += 150;
  timed.sweep();
  assert.deepEqual(timed.snapshot(), { requests: [], cancelled: [] });
  now += 250;
  timed.sweep();
  await assert.rejects(silent, { code: 'MODEL_PROXY_UNAVAILABLE', message: /stopped responding/ });
});

test('proxy mode never looks up a server-side model credential', async (t) => {
  const dir = tempDir('mixdog-model-proxy-creds-');
  const anthropicPath = join(dir, 'anthropic.json');
  writeFileSync(
    anthropicPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'server-access',
        refreshToken: 'server-refresh',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference'],
      },
    })
  );
  const openaiPath = join(dir, 'openai.json');
  writeFileSync(openaiPath, JSON.stringify({ access_token: 'server-access', refresh_token: 'server-refresh' }));
  t.after(() => closeUsageLedgers());
  useEnv(t, {
    MIXDOG_USAGE_LEDGER_PATH: join(dir, 'ledger.sqlite'),
    MIXDOG_MODEL_PROXY: undefined,
    OPENAI_API_KEY: 'sk-server-key',
    ANTHROPIC_OAUTH_CREDENTIALS_PATH: anthropicPath,
    OPENAI_OAUTH_CREDENTIALS_PATH: openaiPath,
  });
  // Pin the OAuth stores to the fixtures: never this machine's real accounts.
  t.after(replaceProviderAuthBindings({ 'anthropic-oauth': anthropicPath, 'openai-oauth': openaiPath }));
  // Sanity: the same fixtures ARE credentials outside proxy mode. Compared
  // without echoing a value, so a failure can never print a credential.
  assert.ok(getAgentApiKey('openai') === 'sk-server-key', 'fixture API key not read');
  assert.equal(oauthCredentialProbeState('anthropic-oauth'), 'present');
  assert.ok(loadCredentials()?.accessToken === 'server-access', 'fixture Anthropic credential not read');
  assert.ok(loadOpenAIOAuthTokens()?.access_token === 'server-access', 'fixture OpenAI credential not read');

  process.env.MIXDOG_MODEL_PROXY = 'client';
  assert.equal(getAgentApiKey('openai'), null);
  assert.equal(hasAgentApiKey('openai'), false);
  assert.equal(oauthCredentialProbeState('anthropic-oauth'), 'absent');
  assert.equal(oauthCredentialProbeState('openai-oauth'), 'absent');
  assert.equal(loadCredentials(), null);
  assert.equal(loadOpenAIOAuthTokens(), null);
  await assert.rejects(refreshOAuthCredentials({ path: anthropicPath, refreshToken: 'server-refresh' }), {
    code: 'MODEL_CREDENTIALS_DISABLED',
  });

  // The registry takes provider availability and config from the PC, builds
  // credential-free stand-ins and never self-heals a server OAuth provider.
  _resetModelProxyProviderConfigForTest();
  const channel = getModelProxyChannel();
  const sent = [];
  t.after(
    attachPc(channel, async ({ id }) => {
      const call = decodeModelProxyWire(op(channel, 'claim', id).payload);
      sent.push(call);
      const value =
        call.method === 'providerConfig'
          ? {
              providers: {
                'anthropic-oauth': {
                  enabled: true,
                  apiKey: 'must-not-arrive',
                  headers: { Authorization: 'Bearer x' },
                  modelProxy: { inputExcludesCache: true, nativePdf: false },
                },
                gemini: { enabled: false },
              },
            }
          : { content: 'from the PC', usage: { inputTokens: 1, outputTokens: 1 } };
      op(channel, 'resolve', id, true, encodeModelProxyWire(value), null);
    })
  );
  // The server's own config is ignored in this mode.
  await initProviders({ openai: { enabled: true, apiKey: 'server-config-key' } });
  const proxied = getProvider('anthropic-oauth');
  assert.ok(proxied instanceof ModelProxyProvider);
  assert.equal(proxied.config.apiKey, undefined);
  assert.equal(proxied.config.headers, undefined);
  assert.equal(providerInputExcludesCache('anthropic-oauth'), true);
  assert.equal(providerNativePdf('anthropic-oauth'), false);
  assert.equal(getProvider('openai'), undefined);
  assert.equal(getProvider('gemini'), undefined);
  assert.equal(getProvider('openai-oauth'), undefined);
  const result = await proxied.send([{ role: 'user', content: 'hi' }], 'claude-test', undefined, { sessionId: 's' });
  assert.equal(result.content, 'from the PC');
  assert.deepEqual(
    sent.map((call) => [call.method, call.provider]),
    [
      ['providerConfig', ''],
      ['send', 'anthropic-oauth'],
    ]
  );
});

test('a PC-side wire reroute is adopted by the daemon session and not repeated', async () => {
  const { ModelProxyProvider } = await import('./model-proxy-provider.mjs');
  const pin = {
    provider: 'command-code-oauth',
    model: 'gpt-5.5',
    wire: 'responses',
    profileId: 'command-code-oauth:responses',
  };
  const rerouted = {
    ...pin,
    wire: 'chat',
    profileId: 'command-code-oauth:chat',
    source: 'reroute',
    reroutedFrom: 'responses',
  };
  const calls = [];
  const channel = {
    request: async (call, options) => {
      calls.push(call);
      return { content: 'ok', wireReroute: calls.length === 1 ? rerouted : undefined };
    },
  };
  const provider = new ModelProxyProvider('command-code-oauth', {}, channel);
  const session = { provider: 'command-code-oauth', model: 'gpt-5.5', wireRoute: pin, messages: [] };
  await provider.send([{ role: 'user', content: 'q' }], 'gpt-5.5', [], { session });
  assert.equal(session.wireRoute, rerouted);
  // The next proxied turn carries the new pin to the PC.
  await provider.send([{ role: 'user', content: 'q' }], 'gpt-5.5', [], { session });
  assert.equal(calls[1].options.session.wireRoute.wire, 'chat');
  // A route for another model never replaces the pin.
  const other = { provider: 'command-code-oauth', model: 'x', wire: 'chat', wireRoute: { ...pin, model: 'x' } };
  const foreign = { ...rerouted, model: 'y' };
  channel.request = async () => ({ content: 'ok', wireReroute: foreign });
  await provider.send([], 'x', [], { session: other });
  assert.equal(other.wireRoute.wire, 'responses');
});

test('the proxied provider forwards the PC’s first-response budget, model-specific first', async () => {
  const { ModelProxyProvider } = await import('./model-proxy-provider.mjs');
  const providerBudget = { transportMs: 130_000, semanticMs: 250_000 };
  const argonBudget = { transportMs: 577_000, semanticMs: 1_147_000 };
  const channel = {
    request: async () => ({
      models: ['gemini-4-argon', 'plain'],
      modelInfo: {
        'gemini-4-argon': { id: 'gemini-4-argon', firstResponseBudget: argonBudget },
        plain: { id: 'plain' },
        broken: { firstResponseBudget: { transportMs: 'soon', semanticMs: -1 } },
      },
    }),
  };
  const provider = new ModelProxyProvider(
    'antigravity-oauth',
    { modelProxy: { firstResponseBudget: providerBudget } },
    channel
  );
  // Before any catalog: the adapter's own figure from the provider config.
  assert.deepEqual(provider.firstResponseBudget('gemini-4-argon'), providerBudget);
  await provider.listModels();
  assert.deepEqual(provider.firstResponseBudget('gemini-4-argon'), argonBudget);
  assert.deepEqual(provider.firstResponseBudget('plain'), providerBudget);
  assert.deepEqual(provider.firstResponseBudget('unlisted'), providerBudget);
  // A malformed figure is ignored; a PC that reports none leaves the watchdog default.
  assert.deepEqual(provider.firstResponseBudget('broken'), providerBudget);
  assert.equal(new ModelProxyProvider('openai', {}, channel).firstResponseBudget('plain'), null);
});
