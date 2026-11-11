#!/usr/bin/env node
// Recording of apps/desktop/src/main/model-proxy-host-trust.test.mjs (b6f10295a): the PC side of the model proxy treats the
// server as untrusted. Real model-proxy-host.ts (createModelProxyHost, withoutAttachmentReferences, MODEL_PROXY_CALLBACKS) with the
// daemon side's real ModelProxyChannel / ModelProxyProvider and this PC's real attachment store; the PC providers are scripted.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-model-proxy-host-trust-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';
import { realDeadline, virtualTimers } from './lib/virtual-timers.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'proxy-trust-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const set = openSet('model-proxy-host-trust-cases', import.meta.url);
const A = 'apps/desktop/src/main/';
const R = 'src/runtime/';
const { createModelProxyHost, MODEL_PROXY_CALLBACKS, withoutAttachmentReferences } = await set.load(`${A}model-proxy-host.ts`);
const { MODEL_PROXY_REQUEST_EVENT, ModelProxyChannel, encodeModelProxyWire } = await set.load(`${R}agent/orchestrator/providers/model-proxy-channel.mjs`);
const { ModelProxyProvider } = await set.load(`${R}agent/orchestrator/providers/model-proxy-provider.mjs`);
const { readAttachmentBase64, storeInlineImagePart } = await set.load(`${R}attachments/store.mjs`);

const DEADLINE_MS = 10_000;
const rejected = async (promise) => { try { return { resolved: await promise }; } catch (e) { return { rejected: e }; } };
/** Waits for the event that ends a step, with a deadline on the real clock (the clock the code under test sees is virtual). */
const within = (label, promise, limitMs = DEADLINE_MS) => realDeadline(label, promise, limitMs);
const disposers = [];
function connect(runtime, { channel = new ModelProxyChannel(), ...hostOptions } = {}) {
  const host = createModelProxyHost({
    invoke: async (operation, args) => {
      const wireArgs = JSON.parse(JSON.stringify(args));
      return JSON.parse(JSON.stringify((await channel.handleOperation(operation, wireArgs)) ?? null));
    },
    loadRuntime: async () => runtime,
    ...hostOptions,
  });
  const detach = channel.attachPublisher((snapshot) => {
    const value = JSON.parse(JSON.stringify(snapshot));
    setImmediate(() => host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, value));
  });
  disposers.push(() => { detach(); host.dispose(); });
  return { channel, host };
}
const fakeRuntime = (providers) => ({ provider: async (name) => providers[name], providerConfig: async () => ({ providers: { openai: { enabled: true } }, ready: true }), finalizeTools: (tools) => tools });
const okProvider = (seen = []) => ({ async send(messages, _model, _tools, options) { seen.push({ messages, options }); return { content: 'ok' }; } });
async function run(name, fn) {
  await set.run(name, async () => {
    const virtual = virtualTimers();
    try { const observed = await fn(virtual); return { ...observed, timers: { armed: virtual.armed, fired: virtual.fired, pending: virtual.pending() } }; } finally { while (disposers.length) disposers.pop()(); virtual.restore(); }
  });
}

await run('a stored-attachment reference from a server never reads this PC’s attachment store', async () => {
  const pcSecret = Buffer.from('this PC only').toString('base64');
  const stored = storeInlineImagePart({ type: 'image', data: pcSecret, mimeType: 'image/png' });
  const resolvedHere = readAttachmentBase64(stored);
  const seen = [];
  const { channel } = connect(fakeRuntime({ openai: okProvider(seen) }));
  const request = {
    provider: 'openai', method: 'send', model: 'gpt',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', attachmentRef: stored.attachmentRef, mimeType: 'image/png' }, { type: 'tool_result', content: [{ type: 'file', attachmentRef: stored.attachmentRef, filename: 'C:\\x\\a.pdf' }] }] }],
    options: {},
  };
  await within('the send', channel.request(request));
  return { stored, readBackHere: resolvedHere, pcSecretBase64: pcSecret, request, providerSaw: seen[0].messages };
});
await run('inline attachment data passes untouched, and nesting is bounded', async () => {
  const messages = [{ role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }];
  let deep = {};
  for (let index = 0; index < 500; index += 1) deep = { content: [deep] };
  let thrown;
  try { withoutAttachmentReferences([deep]); } catch (e) { thrown = e; }
  return { inlineMessages: messages, inlineReturnedSameObject: withoutAttachmentReferences(messages) === messages, nestingDepth: 500, deepThrew: thrown };
});
await run('1,000 advertised ids never produce more claims than one snapshot may name', async () => {
  const claims = [];
  const fourClaims = Promise.withResolvers();
  const host = createModelProxyHost({ invoke: (operation, args) => { if (operation === 'modelProxyClaim') { claims.push(args[0]); if (claims.length === 4) fourClaims.resolve(); } return new Promise(() => {}); }, loadRuntime: async () => fakeRuntime({}), maxSnapshotEntries: 4, claimTimeoutMs: 60_000 });
  disposers.push(() => host.dispose());
  const requests = Array.from({ length: 1_000 }, (_, index) => ({ id: `call-${index}`, method: 'send' }));
  for (let round = 0; round < 3; round += 1) host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, { requests, cancelled: requests.map((row) => row.id) });
  await within('the host to claim the first snapshot entries', fourClaims.promise);
  return { maxSnapshotEntries: 4, advertised: 1_000, rounds: 3, claims };
});
await run('payloads past the aggregate in-flight limit are refused, and so are oversized event replies', async () => {
  const started = Promise.withResolvers();
  const hanging = { send(_m, _model, _t, options) { started.resolve(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))); } };
  const { channel } = connect(fakeRuntime({ openai: hanging }), { maxInflightBytes: 3_000 });
  const big = [{ role: 'user', content: 'x'.repeat(2_000) }];
  const first = new ModelProxyProvider('openai', {}, channel).send(big, 'gpt', undefined, {});
  first.catch(() => {});
  await within('the first call to start', started.promise);
  const second = await rejected(within('the second call', new ModelProxyProvider('openai', {}, channel).send(big, 'gpt', undefined, {})));
  const resolved = Promise.withResolvers();
  const hostOps = [];
  const host = createModelProxyHost({
    invoke: async (operation, args) => {
      hostOps.push(operation);
      if (operation === 'modelProxyClaim') return { payload: encodeModelProxyWire({ provider: 'openai', method: 'send', messages: [], options: {}, callbacks: ['onTextDelta'] }) };
      if (operation === 'modelProxyEvent') return { results: 'x'.repeat(2 * 1024 * 1024) };
      if (operation === 'modelProxyResolve') resolved.resolve(args);
      return null;
    },
    loadRuntime: async () => fakeRuntime({ openai: { send(_m, _model, _t, options) { options.onTextDelta('hi'); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))); } } }),
  });
  disposers.push(() => host.dispose());
  host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, { requests: [{ id: 'r1', method: 'send' }] });
  const args = await within('the oversized reply to settle the call', resolved.promise);
  return { maxInflightBytes: 3_000, payloadChars: 2_000, secondCall: second, oversizedReply: { resolveArgs: args }, hostOperations: hostOps };
});
await run('a burst of sends all run, with no rate or concurrency refusal', async () => {
  const { channel, host } = connect(fakeRuntime({ openai: okProvider() }));
  const sends = Array.from({ length: 30 }, () => new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {}));
  const results = await within('the burst', Promise.all(sends));
  return { sends: 30, results, hostRunningAfter: host.running };
});
await run('callbacks reach the server only allowlisted and projected; account ids stay on this PC', async () => {
  const provider = {
    async send(_m, _model, _t, options) {
      const secretHookKnown = options.onSecretHook !== undefined;
      await options.onStageChange('account-changed', { provider: 'openai', accountId: 'pc-acct-42', at: 7 });
      await options.onStageChange('reconnecting', { attempt: 2, max: 3, message: 'retry with key sk-DUMMY-abcdefghijklmnopqrstuv', nested: { accountEmail: 'me@pc' }, userEmail: 'me@pc' });
      options.onStreamDelta('x'.repeat(200));
      await options.onToolExcluded({ name: 'bad_tool', index: 3, pointer: '/properties/x/type', reason: 'invalid type', message: 'gemini tool "bad_tool" excluded; key sk-DUMMY-abcdefghijklmnopqrstuv', accountId: 'pc-acct-42', schema: { type: 'bogus' } });
      return { content: 'ok', secretHookKnown };
    },
  };
  const { channel } = connect(fakeRuntime({ openai: provider }));
  const stages = []; const deltas = []; const excluded = []; let secretHookCalled = false;
  const result = await within('the send', new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {
    onStageChange: (stage, detail) => { stages.push([stage, detail]); },
    onStreamDelta: (kind) => { deltas.push(kind); },
    onToolExcluded: (info) => { excluded.push(info); },
    onSecretHook: () => { secretHookCalled = true; },
  }));
  return { result, stages, deltas, excluded, secretHookCalled, allowlistedCallbacks: [...MODEL_PROXY_CALLBACKS.keys()].sort(), secretShapedInput: 'the secret-shaped test string carries the sk-DUMMY- marker (the fixture secret scan refuses the original sk-abc… shape); the redactor treats both alike' };
});

await set.finish({
  entry: {
    runs: 'apps/desktop/src/main/model-proxy-host.ts (createModelProxyHost, withoutAttachmentReferences, MODEL_PROXY_CALLBACKS) over the real ModelProxyChannel and ModelProxyProvider and the PC\'s real attachment store (a temp data dir)',
    notRun: 'no real provider (scripted send functions)',
  },
  replay: { entry: 'mixdog-core run_host/model_proxy_pc.rs: the same requests/ callbacks against the PC host; compare each case\'s fields whole (what the provider saw, claims named, refusal codes, resolve args, projected callbacks)', normalised: { heartbeats: 'the heartbeat interval runs on the virtual clock (armed/fired/pending recorded per case under timers); no heartbeat operation fires unless advanced', dataDir: '<data> wherever it occurs (paths listed in normalised.paths)' } },
  replaceInText: [[dataDir, '<data>']],
});
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
