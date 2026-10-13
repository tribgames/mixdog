// A server spends this PC's model accounts only under a grant this PC opened
// from a trusted action in the server's window; nothing the server sends can
// open or renew one.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { ConnectionPool, WindowRouteRegistry, createDesktopConnection } from './connections/index.ts';
import { registerConnectionLinkIpc } from './connections/link-ipc.ts';
import { TrustedActionClient } from './connections/trusted-action-client.ts';
import {
  MODEL_PROXY_GRANT_DEFAULTS,
  MODEL_USE_TRUSTED_CAPABILITIES,
  MODEL_USE_TRUSTED_REQUESTS,
  createModelProxyGrants,
  modelProxyGrantPolicy,
  usageTokens,
} from './model-proxy-grants.ts';
import { createModelProxyHost } from './model-proxy-host.ts';
import { parseHostSettings } from './ssh/ssh-host-store.ts';
import { createSnapshotDeltaEncoder } from './state-delta.ts';
import {
  MODEL_PROXY_REQUEST_EVENT,
  ModelProxyChannel,
} from '../../../../src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import { ModelProxyProvider } from '../../../../src/runtime/agent/orchestrator/providers/model-proxy-provider.mjs';

const MINUTE = 60_000;
const policyWith = (overrides = {}) => () => ({ ...MODEL_PROXY_GRANT_DEFAULTS, ...overrides });

async function within(promise, limitMs = 3_000) {
  let timer;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${limitMs}ms`)), limitMs);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

function fakeRuntime(provider) {
  return {
    provider: async (name) => (name === 'openai' ? provider : undefined),
    providerConfig: async () => ({ providers: { openai: { enabled: true } }, ready: true }),
    finalizeTools: (tools) => tools,
  };
}

/** A provider reporting `tokens` of usage per send. */
function usageProvider(tokens = 100) {
  const provider = {
    sends: 0,
    async send() {
      provider.sends += 1;
      return { content: 'ok', usage: { inputTokens: tokens, outputTokens: 0 } };
    },
    async listModels() {
      return ['gpt'];
    },
  };
  return provider;
}

/** A host over an in-process daemon channel. */
function connect(t, provider, hostOptions) {
  const channel = new ModelProxyChannel();
  const host = createModelProxyHost({
    invoke: async (operation, args) =>
      JSON.parse(JSON.stringify((await channel.handleOperation(operation, JSON.parse(JSON.stringify(args)))) ?? null)),
    loadRuntime: async () => fakeRuntime(provider),
    ...hostOptions,
  });
  const detach = channel.attachPublisher((snapshot) => {
    const value = JSON.parse(JSON.stringify(snapshot));
    setImmediate(() => host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, value));
  });
  t.after(() => {
    detach();
    host.dispose();
  });
  const send = () => within(new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {}));
  return { channel, host, send };
}

// ── The grant itself ─────────────────────────────────────────────────────────

test('a trusted action opens a grant that lasts grantMinutes after the last one', () => {
  let now = 0;
  const grants = createModelProxyGrants({ policy: policyWith({ grantMinutes: 10 }), now: () => now });
  assert.deepEqual(grants.admit(), { ok: false, reason: 'none' });
  assert.equal(grants.trust(), true, 'opened');
  const first = grants.admit();
  assert.equal(first.ok, true);
  first.settle(0);
  now += 9 * MINUTE;
  assert.equal(grants.trust(), false, 'extended, not reopened');
  now += 9 * MINUTE;
  const second = grants.admit();
  assert.equal(second.lane, 'grant', 'still inside 10 minutes of the last action');
  second.settle(0);
  assert.deepEqual(grants.view(), { active: true, expiresAt: 19 * MINUTE, calls: 2, tokens: 0, reserved: 0 });
  now += MINUTE;
  assert.deepEqual(grants.admit(), { ok: false, reason: 'expired' });
  assert.equal(grants.view().active, false);
  assert.equal(grants.trust(), true, 'an expired grant is replaced by a fresh one');
  assert.deepEqual(grants.view(), { active: true, expiresAt: 29 * MINUTE, calls: 0, tokens: 0, reserved: 0 });
});

test('a grant ends once its calls or tokens are used up; a cancelled call does not count', () => {
  const grants = createModelProxyGrants({ policy: policyWith({ grantCalls: 2, grantTokens: 1_000 }), now: () => 0 });
  grants.trust();
  const first = grants.admit();
  first.cancel();
  first.settle(500);
  assert.deepEqual(grants.view(), { ...grants.view(), calls: 0, tokens: 0, reserved: 0 }, 'cancelled, then settling is ignored');
  grants.admit().settle(0);
  grants.admit().settle(0);
  assert.deepEqual(grants.admit(), { ok: false, reason: 'calls' });

  grants.trust();
  const spender = grants.admit();
  spender.settle(1_000);
  spender.settle(5);
  assert.deepEqual(grants.admit(), { ok: false, reason: 'tokens' });
  assert.equal(grants.view().tokens, 1_000, 'only the first settle counts');
});

test('each call holds a token reservation, so 8 concurrent calls near the limit cannot overshoot it', () => {
  const grants = createModelProxyGrants({
    policy: policyWith({ grantTokens: 1_000_000 }),
    now: () => 0,
    reservation: { perCall: 250_000, minimum: 4_096 },
  });
  grants.trust();
  grants.admit().settle(400_000);
  const calls = Array.from({ length: 8 }, () => grants.admit());
  assert.deepEqual(
    calls.map((call) => (call.ok ? call.reserved : call.reason)),
    [250_000, 250_000, 100_000, 'tokens', 'tokens', 'tokens', 'tokens', 'tokens'],
    'what remains is held, then refused'
  );
  assert.deepEqual(grants.view(), { active: true, expiresAt: 120 * MINUTE, calls: 4, tokens: 400_000, reserved: 600_000 });
  // Settled to the actual usage: the unused part is released.
  calls[0].settle(50_000);
  calls[1].settle(50_000);
  assert.deepEqual(grants.view(), { ...grants.view(), tokens: 500_000, reserved: 100_000 });
  // More than reserved is charged in full; no reported usage charges the reservation.
  calls[2].settle(undefined);
  assert.equal(grants.view().tokens, 600_000);
  const over = grants.admit();
  assert.equal(over.reserved, 250_000);
  over.settle(300_000);
  assert.deepEqual(grants.view(), { ...grants.view(), tokens: 900_000, reserved: 0 });
  const last = grants.admit();
  assert.equal(last.reserved, 100_000, 'never more than remains');
  last.settle(100_000);
  assert.deepEqual(grants.admit(), { ok: false, reason: 'tokens' });
  assert.equal(grants.view().tokens, 1_000_000);
});

test('the background budget holds reservations the same way', () => {
  const grants = createModelProxyGrants({
    policy: policyWith({ allowBackground: true, backgroundCallsPerHour: 100, backgroundTokensPerDay: 600_000 }),
    now: () => 0,
    reservation: { perCall: 250_000, minimum: 4_096 },
  });
  const calls = Array.from({ length: 8 }, () => grants.admit());
  assert.deepEqual(
    calls.map((call) => (call.ok ? call.reserved : call.reason)),
    [250_000, 250_000, 100_000, 'background-tokens', 'background-tokens', 'background-tokens', 'background-tokens', 'background-tokens']
  );
  calls[0].cancel();
  assert.equal(grants.admit().reserved, 250_000, 'a cancelled call frees its reservation');
  calls[1].settle(undefined);
  calls[2].settle(10_000);
  assert.equal(grants.admit().reserved, 90_000, 'charged 250k + 10k, the new call holds 250k: 90k remain');
});

test('a grant still in force but fully held refuses instead of falling back to the background budget', () => {
  const grants = createModelProxyGrants({
    policy: policyWith({ grantTokens: 1_000, allowBackground: true }),
    now: () => 0,
  });
  grants.trust();
  const running = grants.admit();
  assert.equal(running.lane, 'grant');
  assert.deepEqual(grants.admit(), { ok: false, reason: 'tokens' });
  running.settle(0);
  assert.equal(grants.admit().lane, 'grant');
});

test('without a grant the background budget applies only when the host allows it', () => {
  let now = 0;
  let allowBackground = false;
  const grants = createModelProxyGrants({
    policy: () => ({ ...MODEL_PROXY_GRANT_DEFAULTS, allowBackground, backgroundCallsPerHour: 2, backgroundTokensPerDay: 500 }),
    now: () => now,
  });
  assert.deepEqual(grants.admit(), { ok: false, reason: 'none' }, 'setting off: refused');
  allowBackground = true;
  const call = grants.admit();
  assert.equal(call.lane, 'background');
  call.settle(0);
  grants.admit().settle(0);
  assert.deepEqual(grants.admit(), { ok: false, reason: 'background-calls' });
  now += 60 * MINUTE;
  grants.admit().settle(500);
  assert.deepEqual(grants.admit(), { ok: false, reason: 'background-tokens' });
  now += 24 * 60 * MINUTE;
  assert.equal(grants.admit().ok, true, 'the day’s tokens roll off');
  assert.equal(grants.view().active, false, 'the background lane is no grant');
});

test('tokens come from the provider’s usage, cache added back only where input excludes it', () => {
  const usage = { inputTokens: 100, outputTokens: 20, cachedTokens: 1_000, cacheWriteTokens: 50, raw: 'x' };
  assert.equal(usageTokens(usage, false), 120);
  assert.equal(usageTokens(usage, true), 1_170);
  assert.equal(usageTokens({ inputTokens: -5, outputTokens: 'NaN' }, true), 0);
  assert.equal(usageTokens({ outputTokens: 7 }, false), 7);
  // Nothing reported: the caller charges the call's reservation instead.
  assert.equal(usageTokens(undefined, false), undefined);
  assert.equal(usageTokens({ cachedTokens: 9 }, true), undefined);
});

test('host settings carry the grant policy, validated', () => {
  assert.deepEqual(modelProxyGrantPolicy(undefined), MODEL_PROXY_GRANT_DEFAULTS);
  const settings = parseHostSettings({ grantMinutes: '30', allowBackgroundModelUse: true, backgroundCallsPerHour: 10, grantTokens: '' });
  assert.deepEqual(settings, { grantMinutes: 30, allowBackgroundModelUse: true, backgroundCallsPerHour: 10 });
  assert.deepEqual(modelProxyGrantPolicy(settings), {
    ...MODEL_PROXY_GRANT_DEFAULTS,
    grantMinutes: 30,
    allowBackground: true,
    backgroundCallsPerHour: 10,
  });
  assert.throws(() => parseHostSettings({ grantMinutes: 5 }), /10 to 1440/);
  assert.throws(() => parseHostSettings({ grantMinutes: 1_441 }), /10 to 1440/);
  assert.throws(() => parseHostSettings({ grantCalls: 1.5 }), /whole number/);
});

// ── The host's gate ──────────────────────────────────────────────────────────

test('sends need a grant; provider lists and availability do not; each refusal is told', async (t) => {
  const provider = usageProvider(100);
  const notices = [];
  const { channel, host, send } = connect(t, provider, {
    grantPolicy: policyWith({ grantTokens: 250 }),
    tokenReservation: { perCall: 100, minimum: 1 },
    onLimited: (limit, reason) => notices.push([limit, reason]),
  });
  await assert.rejects(send(), { code: 'MODEL_PROXY_NOT_AUTHORIZED', status: 403 });
  await assert.rejects(send(), { code: 'MODEL_PROXY_NOT_AUTHORIZED' });
  assert.equal(provider.sends, 0);
  assert.deepEqual(notices, [['not-authorized', 'none']], 'told once until something is admitted');
  assert.deepEqual(await within(channel.request({ provider: 'openai', method: 'listModels' })), {
    models: ['gpt'],
    modelInfo: {},
  });
  assert.equal(await within(channel.request({ provider: 'openai', method: 'isAvailable' })), true);

  host.trust();
  await send();
  await send();
  await send();
  assert.equal(host.grant().tokens, 300, 'counted from the results');
  await assert.rejects(send(), { code: 'MODEL_PROXY_NOT_AUTHORIZED' });
  assert.deepEqual(notices, [
    ['not-authorized', 'none'],
    ['not-authorized', 'tokens'],
  ]);
  assert.equal(provider.sends, 3);
});

test('8 concurrent sends near the token limit: only what reservations cover runs, settled to actual usage', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = {
    sends: 0,
    async send() {
      provider.sends += 1;
      await gate;
      return { content: 'ok', usage: { inputTokens: 250, outputTokens: 50 } };
    },
  };
  const { host, send } = connect(t, provider, {
    grantPolicy: policyWith({ grantTokens: 1_000 }),
    tokenReservation: { perCall: 400, minimum: 100 },
  });
  host.trust();
  const done = [];
  const outcomes = Array.from({ length: 8 }, () =>
    send().then(
      () => 'ok',
      (error) => error.code
    ).then((outcome) => (done.push(outcome), outcome))
  );
  // Five are refused while the first three hold 400 + 400 + 200.
  await within(
    (async () => {
      while (done.length < 5 || provider.sends < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    })()
  );
  assert.deepEqual(done, Array(5).fill('MODEL_PROXY_NOT_AUTHORIZED'));
  assert.deepEqual(host.grant(), { ...host.grant(), calls: 3, tokens: 0, reserved: 1_000 });
  release();
  const settled = await within(Promise.all(outcomes));
  assert.deepEqual(settled.filter((outcome) => outcome === 'ok').length, 3);
  assert.deepEqual(settled.filter((outcome) => outcome === 'MODEL_PROXY_NOT_AUTHORIZED').length, 5);
  assert.equal(provider.sends, 3);
  assert.deepEqual(host.grant(), { ...host.grant(), calls: 3, tokens: 900, reserved: 0 }, 'never past the 1000 budget');
  // 100 remain: one more call fits.
  assert.equal(await send().then(() => 'ok'), 'ok');
});

test('a send whose provider reports no usage is charged its reservation', async (t) => {
  const provider = { async send() {
    return { content: 'ok' };
  } };
  const { host, send } = connect(t, provider, {
    grantPolicy: policyWith(),
    tokenReservation: { perCall: 777, minimum: 1 },
  });
  host.trust();
  await send();
  assert.deepEqual(host.grant(), { ...host.grant(), calls: 1, tokens: 777, reserved: 0 });
});

test('a failed send without usage: charged nothing if it sent no output, its reservation if it streamed', async (t) => {
  let streamFirst = false;
  const provider = {
    async send(_messages, _model, _tools, options) {
      if (streamFirst) await options.onTextDelta?.('partial');
      throw Object.assign(new Error('upstream failed'), { status: 500 });
    },
  };
  const { channel, host } = connect(t, provider, {
    grantPolicy: policyWith(),
    tokenReservation: { perCall: 777, minimum: 1 },
  });
  const failingSend = () =>
    within(new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, { onTextDelta: () => {} }));
  host.trust();
  await assert.rejects(failingSend(), /upstream failed/);
  assert.deepEqual(host.grant(), { ...host.grant(), calls: 1, tokens: 0, reserved: 0 }, 'released, still a call');
  streamFirst = true;
  await assert.rejects(failingSend(), /upstream failed/);
  assert.deepEqual(host.grant(), { ...host.grant(), calls: 2, tokens: 777, reserved: 0 });
});

test('a failed send that reported partial usage is charged that usage', async (t) => {
  const provider = {
    async send() {
      throw Object.assign(new Error('cut off'), { partialUsage: { inputTokens: 40, outputTokens: 2 } });
    },
  };
  const { host, send } = connect(t, provider, {
    grantPolicy: policyWith(),
    tokenReservation: { perCall: 777, minimum: 1 },
  });
  host.trust();
  await assert.rejects(send(), /cut off/);
  assert.deepEqual(host.grant(), { ...host.grant(), calls: 1, tokens: 42, reserved: 0 });
});

test('an expired grant refuses until the next trusted action', async (t) => {
  let now = 1_000_000;
  const provider = usageProvider();
  const notices = [];
  const { host, send } = connect(t, provider, {
    grantPolicy: policyWith({ grantMinutes: 10 }),
    now: () => now,
    onLimited: (limit, reason) => notices.push(reason),
  });
  host.trust();
  await send();
  now += 10 * MINUTE;
  await assert.rejects(send(), { code: 'MODEL_PROXY_NOT_AUTHORIZED' });
  host.trust();
  await send();
  assert.deepEqual(notices, ['expired']);
});

test('background work: refused with the setting off, on its own budget with it on', async (t) => {
  let allowBackground = false;
  const provider = usageProvider();
  const notices = [];
  const { send } = connect(t, provider, {
    grantPolicy: () => ({ ...MODEL_PROXY_GRANT_DEFAULTS, allowBackground, backgroundCallsPerHour: 1 }),
    onLimited: (limit, reason) => notices.push(reason),
  });
  await assert.rejects(send(), { code: 'MODEL_PROXY_NOT_AUTHORIZED' });
  allowBackground = true;
  assert.deepEqual(await send(), { content: 'ok', usage: { inputTokens: 100, outputTokens: 0 } });
  await assert.rejects(send(), { code: 'MODEL_PROXY_NOT_AUTHORIZED' });
  assert.deepEqual(notices, ['none', 'background-calls']);
});

test('a rate-limited send does not use up the grant', async (t) => {
  const { channel, host, send } = connect(t, usageProvider(), {
    grantPolicy: policyWith({ grantCalls: 1 }),
    rateLimit: { perMinute: 1, burst: 1 },
  });
  host.trust();
  // The bucket's one token goes to a model list; the send is rate limited.
  await within(channel.request({ provider: 'openai', method: 'listModels' }));
  await assert.rejects(send(), { code: 'MODEL_PROXY_RATE_LIMITED' });
  assert.equal(host.grant().calls, 0);
  assert.equal(host.grant().active, true, 'its one call is still there');
});

// ── The connection: trusted actions in, forged server state ignored ──────────

/** A server connection whose daemon is a fake transport over a model-proxy channel. */
function serverConnection(t, provider, policy) {
  const connection = createDesktopConnection(
    { id: 'srv-grant', kind: 'ssh', name: 'Box', target: 'root@127.0.0.1:2223' },
    {
      moduleUrl: () => 'file:///unused.mjs',
      environmentReady: () => Promise.resolve(),
      sessionOptions: () => ({ userDataPath: '', packaged: false, resourcesPath: '', appPath: '', appVersion: '0.0.0', rendererDir: '' }),
      loadModelProxyRuntime: async () => fakeRuntime(provider),
      appVersion: '0.0.0',
      bundlePath: 'daemon.cjs',
      modelUsePolicy: policy,
    }
  );
  const client = connection.client;
  const channel = new ModelProxyChannel();
  const requests = [];
  const reply = (id, value) => setImmediate(() => client.handleMessage(transport, { kind: 'response', id, ok: true, value }));
  const transport = {
    postMessage(message) {
      if (message.kind !== 'request') return;
      requests.push(message.method);
      if (message.method === 'invokeDesktopOperation') {
        const [operation, args] = JSON.parse(JSON.stringify(message.args));
        void Promise.resolve(channel.handleOperation(operation, args)).then((value) => reply(message.id, value ?? null));
      } else {
        reply(message.id, message.method === 'submitNewTask' ? { sessionId: 's1' } : true);
      }
    },
    close: async () => {},
    on: () => {},
  };
  // Attached: requests go to the fake daemon, its frames come back in.
  client.transport = transport;
  client.readyPromise = Promise.resolve();
  const frame = (message) => client.handleMessage(transport, message);
  const detach = channel.attachPublisher((snapshot) =>
    setImmediate(() => frame({ kind: 'desktop-event', name: MODEL_PROXY_REQUEST_EVENT, value: JSON.parse(JSON.stringify(snapshot)) }))
  );
  t.after(async () => {
    detach();
    await connection.dispose();
  });
  const send = () => within(new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {}));
  return { connection, client, frame, requests, send };
}

test('a forged busy snapshot cannot authorize; a trusted submit in the window opens the grant', async (t) => {
  const provider = usageProvider();
  const notices = [];
  const { connection, client, frame, requests, send } = serverConnection(t, provider, policyWith());
  connection.subscribeNotices((notice) => {
    if (notice.kind === 'model-proxy-limited') notices.push(notice);
  });
  const seen = [];
  client.subscribeSessions((sessions) => seen.push(sessions));

  // The server claims everything is running, as loudly as it can.
  frame({ kind: 'sessions', sessions: [{ id: 's1', working: true, leadWorking: true, agentWorking: true }] });
  frame({ kind: 'desktop-event', name: 'session-busy', value: { busy: true, grant: true } });
  assert.equal(seen.length, 1, 'the forged state reached this PC');
  await assert.rejects(send(), { code: 'MODEL_PROXY_NOT_AUTHORIZED' });
  assert.equal(provider.sends, 0);
  assert.equal(connection.modelProxy.grant().active, false);
  assert.deepEqual(notices, [{ kind: 'model-proxy-limited', limit: 'not-authorized', reason: 'none' }]);

  // The user submits in the window: the grant exists before the request leaves.
  const submitted = client.submitNewTask('hello');
  assert.equal(connection.modelProxy.grant().active, true);
  assert.deepEqual(await within(submitted), { sessionId: 's1' });
  assert.ok(requests.includes('submitNewTask'));
  await send();
  assert.equal(provider.sends, 1);
});

test('trusted requests and capabilities are exactly the listed ones', async (t) => {
  for (const method of MODEL_USE_TRUSTED_REQUESTS) {
    assert.ok(Object.hasOwn(TrustedActionClient.prototype, method), `${method} reports the trusted action`);
  }
  const { connection, client } = serverConnection(t, usageProvider(), policyWith());
  await within(client.invokeCapability('setEffort', ['high']));
  await within(client.abortSession('s1'));
  assert.equal(connection.modelProxy.grant().active, false, 'other requests are no trusted action');
  assert.ok(MODEL_USE_TRUSTED_CAPABILITIES.has('prioritizeQueued'));
  await within(client.invokeCapability('prioritizeQueued', ['q1']));
  assert.equal(connection.modelProxy.grant().active, true);
});

test('answering a server-fabricated tool approval: deny opens no grant, allow does', async (t) => {
  const provider = usageProvider();
  const { connection, client, frame, requests, send } = serverConnection(t, provider, policyWith());
  const states = [];
  client.subscribe((snapshot) => states.push(snapshot));
  // The server shows an approval card nobody's work asked for.
  const encoder = createSnapshotDeltaEncoder();
  frame({
    kind: 'state',
    sequence: 1,
    wire: encoder.encode({ sessionId: 's1', items: [], toolApproval: { id: 'a1', toolName: 'shell', summary: 'rm -rf ~' } }),
  });
  assert.equal(states.at(-1)?.toolApproval?.id, 'a1', 'the fabricated approval reached this PC');

  assert.equal(await within(client.resolveToolApprovalForSession('s1', 'a1', { approved: false, reason: 'no' })), true);
  assert.equal(requests.filter((method) => method === 'resolveToolApprovalForSession').length, 1, 'the denial still reaches the server');
  assert.equal(connection.modelProxy.grant().active, false, 'a denial is no trusted action');
  await assert.rejects(send(), { code: 'MODEL_PROXY_NOT_AUTHORIZED' });

  await within(client.resolveToolApprovalForSession('s1', 'a1', { approved: true }));
  assert.equal(connection.modelProxy.grant().active, true, 'allowing the tool is');
  await send();
  assert.equal(provider.sends, 1);
});

test('a denial (or anything but an explicit allow) does not extend an open grant', async () => {
  let now = 0;
  const grants = createModelProxyGrants({ policy: policyWith({ grantMinutes: 10 }), now: () => now });
  const client = Object.create(TrustedActionClient.prototype);
  Object.defineProperty(client, 'onTrusted', { value: () => grants.trust() });
  client.invoke = async () => true;
  grants.trust();
  now += 5 * MINUTE;
  await client.resolveToolApprovalForSession('s1', 'a1', { approved: false });
  await client.resolveToolApprovalForSession('s1', 'a1', { approved: 'true' });
  await client.resolveToolApprovalForSession('s1', 'a1', undefined);
  assert.equal(grants.view().expiresAt, 10 * MINUTE, 'not extended');
  await client.resolveToolApprovalForSession('s1', 'a1', { approved: true });
  assert.equal(grants.view().expiresAt, 15 * MINUTE);
});

test('“Keep allowing” opens a grant only from the server window’s own main frame', async () => {
  const host = createModelProxyHost({
    invoke: async () => null,
    loadRuntime: async () => fakeRuntime(usageProvider()),
    grantPolicy: policyWith(),
  });
  const pool = new ConnectionPool();
  pool.add({ id: 'srv-a', kind: 'ssh', link: null, reconnect: async () => {}, modelProxy: host });
  pool.add({ id: 'local', kind: 'local', link: null, reconnect: async () => {}, modelProxy: host });
  const routes = new WindowRouteRegistry();
  routes.register({ id: 11, once: () => {} }, 'srv-a');
  routes.register({ id: 1, once: () => {} }, 'local');
  const handlers = new Map();
  registerConnectionLinkIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: () => {} },
    routes,
    pool,
    restore: { isEnabled: () => true, setEnabled: () => true, progress: () => null },
    closeWindow: () => {},
    showConnectionSettings: () => {},
    requestSignIn: () => {},
  });
  const allow = handlers.get(DESKTOP_IPC.connectionAllowModelUse);
  const mainFrame = { name: 'main' };
  const childFrame = { name: 'preview' };
  await assert.rejects(allow({ sender: { id: 11, mainFrame }, senderFrame: childFrame }), /server window itself/);
  await assert.rejects(allow({ sender: { id: 11, mainFrame }, senderFrame: null }), /server window itself/);
  await assert.rejects(allow({ sender: { id: 99, mainFrame }, senderFrame: mainFrame }));
  await assert.rejects(allow({ sender: { id: 1, mainFrame }, senderFrame: mainFrame }), /Only a server window/);
  assert.equal(host.grant().active, false);
  await allow({ sender: { id: 11, mainFrame }, senderFrame: mainFrame });
  assert.equal(host.grant().active, true);
  host.dispose();
});
