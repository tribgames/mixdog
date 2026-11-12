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
import { scriptUuids } from './lib/scripted-uuid.mjs';
import { within } from './lib/recorder-error.mjs';
import { virtualTimers } from './lib/virtual-timers.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'proxy-trust-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const scriptedUuids = scriptUuids();
const set = openSet('model-proxy-host-trust-cases', import.meta.url);
const A = 'apps/desktop/src/main/';
const R = 'src/runtime/';
const { createModelProxyHost, MODEL_PROXY_CALLBACKS, withoutAttachmentReferences } = await set.load(`${A}model-proxy-host.ts`);
const { MODEL_PROXY_REQUEST_EVENT, ModelProxyChannel, encodeModelProxyWire } = await set.load(`${R}agent/orchestrator/providers/model-proxy-channel.mjs`);
const { ModelProxyProvider } = await set.load(`${R}agent/orchestrator/providers/model-proxy-provider.mjs`);
const { readAttachmentBase64, storeInlineImagePart } = await set.load(`${R}attachments/store.mjs`);
const { registerProviderAccount, changeProviderAccounts, readProviderAccountPool, removeProviderAccount } = await set.load(`${R}shared/provider-accounts.mjs`);
const { createAccountPoolProvider } = await set.load(`${R}agent/orchestrator/providers/account-pool.mjs`);
const { buildAntigravityRequest } = await set.load(`${R}agent/orchestrator/providers/antigravity-request.mjs`);

const rejected = async (promise) => { try { return { resolved: await promise }; } catch (e) { return { rejected: e }; } };
const disposers = [];
/** Every message that crosses the JSON hop between the PC host and the daemon channel, as the text that crossed (the hop stands for the session connection: JSON over HTTP). */
let wireLog = [];
const deliveries = [];
function connect(runtime, { channel = new ModelProxyChannel(), ...hostOptions } = {}) {
  const host = createModelProxyHost({
    invoke: async (operation, args) => {
      const argsText = JSON.stringify(args);
      wireLog.push({ direction: 'pc->daemon', operation, text: argsText });
      const replyText = JSON.stringify((await channel.handleOperation(operation, JSON.parse(argsText))) ?? null);
      wireLog.push({ direction: 'daemon->pc', operation, text: replyText });
      return JSON.parse(replyText);
    },
    loadRuntime: async () => runtime,
    ...hostOptions,
  });
  const detach = channel.attachPublisher((snapshot) => {
    const text = JSON.stringify(snapshot);
    wireLog.push({ direction: 'daemon->pc event', operation: MODEL_PROXY_REQUEST_EVENT, text });
    const value = JSON.parse(text);
    // The delivery is the connection's: a later turn, as in the Node test; the handler having been called is recorded and awaited (see run).
    deliveries.push(new Promise((resolve) => setImmediate(() => { host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, value); wireLog.push({ direction: 'host handled event', operation: MODEL_PROXY_REQUEST_EVENT }); resolve(); })));
  });
  disposers.push(() => { detach(); host.dispose(); });
  return { channel, host };
}
const fakeRuntime = (providers) => ({ provider: async (name) => providers[name], providerConfig: async () => ({ providers: { openai: { enabled: true } }, ready: true }), finalizeTools: (tools) => tools });
const okProvider = (seen = []) => ({ async send(messages, _model, _tools, options) { seen.push({ messages, options }); return { content: 'ok' }; } });
async function run(name, fn) {
  await set.run(name, async () => {
    const virtual = virtualTimers({ ordered: () => wireLog });
    wireLog = [];
    try { const observed = await fn(virtual); while (deliveries.length) await within('the daemon->PC event to reach the host handler', Promise.all(deliveries.splice(0))); return { ...observed, wire: wireLog, timers: { armed: virtual.armed, fired: virtual.fired, advances: virtual.advances, pending: virtual.pending() } }; } finally { while (disposers.length) disposers.pop()(); virtual.restore(); }
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
// `admitPayload` (model-proxy-host.ts:969) sizes the claimed string as `payload.length` (UTF-16 units) before decoding it. Each payload is a
// call as the daemon encodes it (`encodeModelProxyWire`, JSON.stringify of the wire value); the host runs with `maxRequestBytes` at the payload's
// own length (served) and one below (refused as too large), so what is recorded is where Node's limit falls for that string.
await run('the size of a payload is the length of the string the server claimed', async () => {
  const call = (content, options = {}) => ({ provider: 'openai', method: 'send', model: 'gpt', messages: [{ role: 'user', content }], options, callbacks: [] });
  const payloads = {
    ascii: call('x'.repeat(2_000)),
    escapes: call('tab\t quote" back\\ newline\n control\u0001 \u001f solidus/ bell\u0007 é ü ß'),
    nonBmp: call('😀 𝄞 \u{1F600}𠀀 mixed é😀'),
    numberForms: call('n', { temperature: 0.7, a: 0, b: -0, c: 1.5, d: 1e-7, e: 123456789012, f: 0.1 + 0.2, g: 5e-324, h: 2 ** 53 + 2, i: -1.25e-10, j: 100, k: 1e20 }),
    // JavaScript spells these numbers its own way (an exponent with a plus, a whole 1e20 in full); the Rust count follows it.
    exponentWithPlus: call('n', { big: 1e21, huge: 1.7976931348623157e308 }),
  };
  const verdict = async (text, maxRequestBytes) => {
    const resolved = Promise.withResolvers();
    const reached = [];
    const host = createModelProxyHost({
      invoke: async (operation, args) => { if (operation === 'modelProxyClaim') return { payload: text }; if (operation === 'modelProxyResolve') resolved.resolve(args); return null; },
      loadRuntime: async () => fakeRuntime({ openai: { async send() { reached.push('send'); return { content: 'ok' }; } } }),
      maxRequestBytes,
    });
    disposers.push(() => host.dispose());
    host.handleDesktopEvent(MODEL_PROXY_REQUEST_EVENT, { requests: [{ id: 'r1', method: 'send' }] });
    const args = await within('the claimed call to be resolved', resolved.promise);
    return { reachedProvider: reached.length > 0, resolveArgs: args };
  };
  const out = {};
  for (const [name, value] of Object.entries(payloads)) {
    const text = encodeModelProxyWire(value);
    out[name] = { text, length: text.length, served: await verdict(text, text.length), refusedOneBelow: await verdict(text, text.length - 1) };
  }
  return { payloads: out };
});
await run('a burst of sends all run, with no rate or concurrency refusal', async () => {
  const { channel, host } = connect(fakeRuntime({ openai: okProvider() }));
  const sends = Array.from({ length: 30 }, () => new ModelProxyProvider('openai', {}, channel).send([], 'gpt', undefined, {}));
  const results = await within('the burst', Promise.all(sends));
  return { sends: 30, results, hostRunningAfter: host.running };
});
await run('callbacks reach the server only allowlisted and projected; account ids stay on this PC', async () => {
  // The order is Node's own: the real account pool (account-pool.mjs createAccountPoolProvider, over the real account store) walks two
  // accounts of `antigravity-oauth`, and each account's send builds its request with the real Antigravity request builder
  // (antigravity-request.mjs buildAntigravityRequest, which reports the tools it leaves out through `onToolExcluded`). Only the
  // network end is replaced: the first account's request is refused with the quota error the gateway answers (429
  // usage_limit_reached), the second's streams its answer. The pool then raises `reconnecting` (account-pool.mjs:625) between the
  // attempts and `account-changed` (account-pool.mjs:586) once the answer is in; the recorder scripts none of the callbacks.
  const providerName = 'antigravity-oauth';
  const accounts = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2'];
  for (const row of readProviderAccountPool(providerName).accounts) await removeProviderAccount(providerName, row.id);
  for (const id of accounts) await registerProviderAccount(providerName, id, { label: id });
  await changeProviderAccounts(providerName, { selectedId: accounts[0], auto: true, useCredits: false });
  const bogus = { name: 'mcp__x__key-sk-DUMMY-abcdefghijklmnopqrstuv', description: 'a tool.', inputSchema: { type: 'object', properties: { a: { type: 'bogus-type' } } } };
  const read = { name: 'read', description: 'read tool.', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };
  const networkAttempts = [];
  const provider = createAccountPoolProvider(providerName, () => ({
    async send(messages, model, tools, options) {
      const secretHookKnown = options.onSecretHook !== undefined;
      buildAntigravityRequest(messages, model, tools, { onToolExcluded: options.onToolExcluded }, 'proj');
      networkAttempts.push(secretHookKnown);
      if (networkAttempts.length === 1) throw Object.assign(new Error('Quota exhausted'), { code: 'usage_limit_reached', status: 429 });
      options.onStreamDelta('x'.repeat(200));
      return { content: 'ok', secretHookKnown };
    },
  }));
  const { channel } = connect(fakeRuntime({ [providerName]: provider }));
  const stages = []; const deltas = []; const excluded = []; let secretHookCalled = false;
  const result = await within('the send', new ModelProxyProvider(providerName, {}, channel).send([{ role: 'user', content: 'hi' }], 'gemini-3.8-flash', [bogus, read], {
    onStageChange: (stage, detail) => { stages.push([stage, detail]); },
    onStreamDelta: (kind) => { deltas.push(kind); },
    onToolExcluded: (info) => { excluded.push(info); },
    onSecretHook: () => { secretHookCalled = true; },
  }));
  return { providerName, accounts, tools: [bogus, read], networkAttempts, result, stages, deltas, excluded, secretHookCalled, allowlistedCallbacks: [...MODEL_PROXY_CALLBACKS.keys()], secretShapedInput: 'the secret-shaped test string carries the sk-DUMMY- marker (the fixture secret scan refuses the original sk-abc… shape); the redactor treats both alike' };
});

await set.finish({
  entry: { hops: "Same hop as model-proxy-host-cases (the session connection, JSON over HTTP): every crossing message is recorded as its text under each case's `wire`.",
    runs: 'apps/desktop/src/main/model-proxy-host.ts (createModelProxyHost, withoutAttachmentReferences, MODEL_PROXY_CALLBACKS) over the real ModelProxyChannel and ModelProxyProvider and the PC\'s real attachment store (a temp data dir)',
    notRun: 'no real provider (scripted send functions)',
    scripted: { source: scriptedUuids.source, why: 'the request ids (mp_<32 hex>) are generated by the host: a recorded input, not a per-run value' },
  },
  replay: {
    entry: 'mixdog-core run_host/model_proxy_pc.rs: the same requests/ callbacks against the PC host; compare each case\'s fields whole (what the provider saw, claims named, refusal codes, resolve args, projected callbacks)',
    replayTests: 'mixdog-core/src/run_host/model_proxy_trust_replay_tests.rs drives `modelProxy/run` on ModelProxyService (mixdog-core-domains/src/domains/ai_admin/model_proxy_service.rs, the service compose_flip.rs registers) over ProxyRunner (model_proxy.rs:864) with a scripted provider, and reads the typed `modelProxy/run/event` notifications; mixdog-app-server tests/admission.rs `the_recorded_burst_and_refusal_reach_the_real_model_proxy_service_from_the_wire` sends the recorded burst and the recorded refusal as JSON-RPC frames through the server\'s admission to the real ModelProxyService; mixdog-ai/src/service/model_proxy_trust_replay_tests.rs replays "inline attachment data passes untouched, and nesting is bounded" through without_attachment_references (mixdog-ai/src/service/model_proxy.rs:76), which request_in applies to every free-form JSON field (model_proxy.rs part_in/message_in -> plain_json).',
    declaredExclusions: [
      { case: 'the size of a payload is the length of the string the server claimed', keys: ['resolveArgs'], reason: "Node's refusal travels in a resolve operation of the replaced protocol; the K1 refusal is the failure answer of modelProxy/run, whose code, status and words are compared with the refusal of the aggregate-limit case" },
    ],
    replaced: {
      protocol: "Node's claim/event/resolve host (modelProxyClaim/Event/Resolve, the heartbeat and its snapshot event) is replaced by the typed modelProxy/run request and its modelProxy/run/event notifications: mixdog-app-protocol/src/inventory.rs:848-858 marks the three operations Deleted",
      keys: ['wire', 'timers'],
      reason: "every case's `wire` lines and `timers` are the envelope and heartbeat of the replaced protocol; what each case pins is compared through fieldMap",
    },
    fieldMap: {
      'a stored-attachment reference from a server never reads this PC’s attachment store': {
        'request.messages[0].content[0] (text)': 'ProxyPart::Text -> providerSaw[0].content[0], compared',
        'request.messages[0].content[1] (image with attachmentRef)': 'unrepresentable: ProxyImage (mixdog-app-protocol/src/v2/model_proxy.rs:55) is base64, url or file id; the three typed forms are sent and reach the provider unchanged',
        'request.messages[0].content[2].content[0] (file with attachmentRef, filename)': "a tool message's ProxyPart::File { source: Unavailable (v2/model_proxy.rs:67), filename } -> the provider's text part, compared with providerSaw[0].content[2].content[0].text",
        'pcSecretBase64 / readBackHere / stored': "the PC's own store: ProxyRunner (model_proxy.rs:864) holds no attachment store; asserted absent from what the provider saw",
        'request.provider / method / model': 'ProxyCall::Send { provider: "openai" } with model "gpt"',
      },
      '1,000 advertised ids never produce more claims than one snapshot may name': {
        'maxSnapshotEntries / advertised / rounds / claims': "no snapshot exists on the typed protocol: each call is its own modelProxy/run request (mixdog-app-protocol/src/methods.rs:4338); the server does not count them against its class cap (mixdog-app-server/src/server.rs, the cap of modelProxy/run), as Node's host has none: the recorded burst of case 4 is admitted whole (mixdog-app-server tests/admission.rs the_recorded_burst_and_refusal_reach_the_real_model_proxy_service_from_the_wire); each call is one frame of at most maxInboundFrameBytes, tested by a_peer_holds_at_most_its_in_flight_runs_each_one_bounded_frame",
      },
      'payloads past the aggregate in-flight limit are refused, and so are oversized event replies': {
        'maxInflightBytes / payloadChars / secondCall': "ModelProxyService (mixdog-core-domains ai_admin/model_proxy_service.rs admit) refuses as Node's admitPayload does: a call whose payload (the UTF-16 length of the call's JSON as claimed, `payload.length`: claimed_chars) would take the data held by the calls in flight past maxInflightBytes (recorded as 3,000; the service's default is Node's 256 MiB) is the failure MODEL_PROXY_BUSY, status 429, with Node's words, before any provider is looked up, and a call past 128 MiB is MODEL_PROXY_REQUEST_TOO_LARGE (413); replayed from the wire through the server's admission by the_recorded_burst_and_refusal_reach_the_real_model_proxy_service_from_the_wire and by a_call_that_would_take_the_data_held_past_its_bound_is_refused_as_busy; a frame past maxInboundFrameBytes is refused before it is parsed (mixdog-app-protocol/src/rpc.rs:142), tested by a_peer_holds_at_most_its_in_flight_runs_each_one_bounded_frame",
        'oversizedReply / hostOperations': 'a run sends notifications and asks the peer nothing (model_proxy_service.rs RunEvents::emit), so there is no peer reply to bound; any inbound frame is under the same frame bound',
      },
      'a burst of sends all run, with no rate or concurrency refusal': {
        'sends / results[].content': '30 concurrent modelProxy/run calls on ModelProxyService; each answers `sent` and its textDelta events fold to the content',
        hostRunningAfter: 'ModelProxyService::close returns at once: no run left',
      },
      'callbacks reach the server only allowlisted and projected; account ids stay on this PC': {
        'result.providerMetadata': "carried as ProxyEvent::AccountRouting { provider, accountId, sessionAccountId } (v2/model_proxy.rs) by a pool that stamps it, and back on the history as ProxyMessage.accountRouting: without the history carry the next turn of a conversation through the proxy would not be kept on the account that served the last (Node's pool reads it from the history, account-pool.mjs sessionAccountId / customKeyServedBy) and would land on another key, with its cache and quota. The typed completion has no other provider metadata. The provider of this case is scripted and raises no AccountRouting, so the replay's event list is only the recorded callbacks and the account id of the roster's switch stays on this PC; the history carry is tested by the_account_that_served_an_answer_rides_on_the_history (model_proxy_tests.rs) and the key binding by the recorded gateway cases (registry/gateway_replay.rs)",
        'stages[account-changed] {provider, at}': 'ProxyEvent::AccountChanged { provider, at } (v2/model_proxy.rs:646): the account id is not a field of the event',
        'stages[reconnecting].message': 'ProxyEvent::AccountSwitching { message }, redacted (redacted_text, 2,000)',
        'providerName / accounts / tools / networkAttempts': "the recorder's inputs: the provider and its two accounts, the two tools it was sent (the first has an invalid schema, its name carries the credential-shaped text) and, per network attempt, whether the server's secret hook was known; the replay reads the tools and the second account's id from them",
        'excluded[] {name, index, pointer, reason, message}': 'ProxyEvent::ToolExcluded (v2/model_proxy.rs:653), each string redacted',
        'deltas (onStreamDelta of a 200-char string)': "unrepresentable: onStreamDelta's kind is the ProxyProgress enum (v2/model_proxy.rs:596), never free text",
        'result.content': "the textDelta events of the run, folded; the provider is scripted with the recorder's own 'ok', and the run's whole ordered event list is compared in the order Node's wire recorded the callbacks, which is the order a real send raises them (see the recorder's comment: the request body's tool report at each account attempt, the switch between attempts, the committed change last): tool excluded, account switching, tool excluded, account changed (onStreamDelta has no typed event); the text and the scripted stream's completed event close the list",
        'result.secretHookKnown / secretHookCalled': 'unrepresentable: a typed request (ProxyOptions, v2/model_proxy.rs:194) carries no callback, so a provider cannot learn of one',
        allowlistedCallbacks: 'the CALLBACKS table of the replay test: each Node callback and the ProxyEvent variants that carry it, keys compared in order',
        secretShapedInput: 'a note of the recorder',
      },
    },
    normalised: { heartbeats: 'the heartbeat interval runs on the virtual clock (armed/fired/pending recorded per case under timers); no heartbeat operation fires unless advanced', dataDir: '<data> wherever it occurs (paths listed in normalised.paths)' } },
});
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
