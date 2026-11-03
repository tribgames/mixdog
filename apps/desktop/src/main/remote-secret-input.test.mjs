// A handoff secret typed on a paired phone: the relay leg hands the decrypted
// call to the window process's one-shot slot for the runtime-minted request id
// (the slot the PC card fills), answers only whether it was taken, and leaves
// the value in no response, error, log or stat.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateRelayE2EEServerIdentity, relayE2EEPairingMaterial } from '../shared/remote-e2ee.ts';
import { createRelayClientLifecycle } from './remote-relay-client-lifecycle.ts';
import { createRelayClientCallDispatch } from './remote-relay-client-calls.ts';
import { createRelayClientRegistry } from './remote-relay-clients.ts';
import { createRemoteMethods, executeRemoteFrame, redactRemoteError } from './remote-methods.ts';
import { createSecretInputs } from './secret-input.ts';

const REQUEST_ID = 'secret_p10123456789';
const CODE = '482190';

/** The window process: its registry takes the value as index.ts's
 *  browser-remote-request handler does for `provideSecretInput`. */
function windowProcess() {
  const registry = createSecretInputs();
  const requests = [];
  const hostRequest = async (method, args) => {
    requests.push(method);
    if (method !== 'provideSecretInput') throw new Error(`unexpected window request ${method}`);
    return registry.provide(String(args[0] || ''), typeof args[1] === 'string' ? args[1] : '');
  };
  return { registry, requests, hostRequest };
}

test('a phone secret lands in the same one-shot slot the PC card fills, with the same refusals', async () => {
  const pc = windowProcess();
  const methods = createRemoteMethods({ host: {}, hostRequest: pc.hostRequest });
  assert.equal(await methods.provideSecretInput([REQUEST_ID, CODE]), true);
  assert.equal(pc.registry.has(REQUEST_ID), true);
  assert.equal(pc.registry.take(REQUEST_ID), CODE, 'the fill takes it once, for the id the runtime minted');
  assert.equal(pc.registry.take(REQUEST_ID), '', 'one-shot');
  // The PC card's refusals are the phone's: a malformed id, no value, a non-string.
  for (const params of [
    ['not-a-request', CODE],
    [REQUEST_ID, ''],
    [REQUEST_ID, 42],
  ]) {
    assert.equal(await methods.provideSecretInput(params), false, JSON.stringify(params));
    assert.equal(pc.registry.has(REQUEST_ID), false);
  }
  await assert.rejects(async () => methods.provideSecretInput([7, CODE]), /secret request id/);
});

test('a refused or failed secret call answers without the value', async () => {
  const frame = JSON.stringify({ id: 4, method: 'provideSecretInput', params: [REQUEST_ID, CODE] });
  // No window answers: the call fails, naming nothing of the value.
  const none = await executeRemoteFrame(createRemoteMethods({ host: {} }), frame);
  assert.equal(none.ok, false);
  assert.equal(JSON.stringify(none).includes(CODE), false);
  // An upstream failure that echoes the value is redacted like a capability secret.
  const echoing = createRemoteMethods({
    host: {},
    hostRequest: async () => {
      throw new Error(`the window could not hold ${CODE}`);
    },
  });
  const failed = await executeRemoteFrame(echoing, frame);
  assert.equal(failed.ok, false);
  assert.equal(JSON.stringify(failed).includes(CODE), false);
  assert.equal(redactRemoteError(`bad ${CODE}`, 'provideSecretInput', [REQUEST_ID, CODE]).includes(CODE), false);
});

test('only an attached, authenticated leg can submit; the value reaches no log, stat or reply', async (t) => {
  const logged = [];
  for (const level of ['log', 'info', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => logged.push(args.map(String).join(' ')));
  }
  const pc = windowProcess();
  const methods = createRemoteMethods({ host: {}, hostRequest: pc.hostRequest });
  const sent = [];
  const recorded = [];
  let attached = true;
  const dispatch = createRelayClientCallDispatch({
    host: {},
    methods,
    attached: () => attached,
    live: () => attached,
    sendEncryptedFrame: async (_clientId, payload) => sent.push(payload),
    acknowledgePaintProbe: () => null,
    resyncClient() {},
    recordCall: (method, _ms, bytes) => recorded.push([method, bytes]),
  });
  const client = { pendingFrames: 0, callQueue: { run: (_key, task) => task() } };
  const call = (id, params) => ({ id, method: 'provideSecretInput', params });

  const { execution } = await dispatch('phone-1', client, call(1, [REQUEST_ID, CODE]), 200);
  await execution;
  assert.deepEqual(sent, [{ id: 1, ok: true, value: true }], 'only whether it was taken');
  assert.equal(pc.registry.take(REQUEST_ID), CODE);
  assert.equal(recorded[0][0], 'provideSecretInput', 'counted by method name alone');

  // The leg was unpaired or expired before the call ran: nothing reaches the PC.
  attached = false;
  sent.length = 0;
  pc.requests.length = 0;
  const late = await dispatch('phone-1', client, call(2, [REQUEST_ID, CODE]), 200);
  await late.execution;
  assert.deepEqual(pc.requests, [], 'the window was never asked');
  assert.equal(pc.registry.has(REQUEST_ID), false);
  assert.deepEqual(sent, []);

  const everything = JSON.stringify([sent, recorded, logged]);
  assert.equal(everything.includes(CODE), false);
});

test('the host advertises secretInput in its encryption challenge', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const envelopes = [];
  const clients = createRelayClientRegistry({
    host: { setVisibleSessionsForSource: async () => true },
    sendEnvelope: (payload) => envelopes.push(payload),
    frameBudgetBytes: 1 << 20,
    onClientCountChanged: () => {},
    onEmpty: () => {},
  });
  const lifecycle = createRelayClientLifecycle({
    clients,
    e2eeIdentity: identity,
    pairing: relayE2EEPairingMaterial(identity),
    relayBinaryFrames: () => false,
    viewSyncSupported: () => false,
    relayRoutingCapsPayload: () => ({}),
    sendEnvelope: (payload) => envelopes.push(payload),
    sendEncryptedFrame: async () => {},
    dispatchClientCall: async () => ({}),
    resyncClient: () => {},
  });
  lifecycle.open('client-1', 'phone-credential');
  const challenge = JSON.parse(envelopes.find((entry) => entry.type === 'frame').data);
  assert.equal(challenge.secretInput, 1);
  clients.clear();
});
