// Records Node's composed screen-access decision as the phone receives it: the real relay-client call dispatch
// (apps/desktop/src/main/remote-relay-client-calls.ts, `browserRemoteScreenDisplays`) over the real relay's `screenDisplays`
// (apps/desktop/src/main/remote-webrtc/relay.ts) asking the real screen-access publisher (apps/desktop/src/main/remote-screen/screen-access-publisher.ts `allowed`) over a client table, as
// remote-relay.ts composes them (`screenAuthorized: (clientId, origin) => screenAccessPublisher.allowed(clientId, origin)`). Each scenario
// records the complete frame sent to the phone for one request for the display list (`{ id, ok, value }` or `{ id, ok, error }`, the
// whole payload, or null when none is sent) and how many times the host was asked for it. The client table is the real one
// (remote-relay-clients.ts), so a phone's connection stays attached after an unpair until the relay reports it gone
// (\client-close\, remote-relay.ts onClientClose), exactly as in Node; every envelope the desktop sent the relay is recorded.
// The relay closes a phone only when it removed the pairing (apps/relay/lib/relay-legs.mjs revokeClient: closeQuietly 4003 only
// \if (removed)\), and the desktop closes none itself, so the two unpair outcomes are an unconfirmed unpair (the connection stays
// open) and a confirmed one (the relay's client-close follows).
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-screen-access.mjs --tree <exact git archive of b6f10295a with node_modules> --commit b6f10295a2f698afc85332467192de28500bd146
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, args.get('commit') ?? (() => { throw new Error('--commit is required'); })());
const recorder = 'benchmarks/rust-core/recorders/record-screen-access.mjs';
const finalDir = join(FIXTURES_ROOT, 'screen-access');
const stage = stageSet(finalDir);

const { createRemoteWebrtcRelay } = await importFrom(tree, 'apps/desktop/src/main/remote-webrtc/relay.ts');
const { createRelayClientCallDispatch } = await importFrom(tree, 'apps/desktop/src/main/remote-relay-client-calls.ts');
const { createRelayClientRegistry } = await importFrom(tree, 'apps/desktop/src/main/remote-relay-clients.ts');
const { createScreenAccessPublisher } = await importFrom(tree, 'apps/desktop/src/main/remote-screen/screen-access-publisher.ts');

const DISPLAYS = [{ id: 'display-1', label: 'Display 1', primary: true, width: 1920, height: 1080 }];

async function scenario(name, act) {
  const envelopes = [];
  const registry = createRelayClientRegistry({
    host: {},
    sendEnvelope: (envelope) => envelopes.push(JSON.parse(JSON.stringify(envelope))),
    frameBudgetBytes: 1 << 20,
    onClientCountChanged: () => undefined,
    onEmpty: () => undefined,
  });
  const unpaired = new Set();
  let asked = 0;
  const publisher = createScreenAccessPublisher({
    client: (clientId) => registry.get(clientId),
    clients: () => registry.clients.entries(),
    unpaired: (credentialId) => unpaired.has(credentialId),
    label: () => 'Paired phone',
    send: () => Promise.resolve(),
  });
  const relay = createRemoteWebrtcRelay({
    subscribed: () => false,
    awaitingFit: () => false,
    screenAuthorized: async (clientId, origin) => publisher.allowed(clientId, origin),
    setImages: () => undefined,
    resolveIceServers: async () => null,
    forward: async () => undefined,
    viewerLeft: async () => undefined,
    screenDisplays: () => {
      asked += 1;
      return DISPLAYS;
    },
    send: async () => undefined,
  });
  // A client-open the relay announced, E2EE established (the handshake's outcome is the channel).
  const admit = (clientId, credentialId) => {
    const client = registry.open(clientId, {}, credentialId);
    client.channel = {};
    publisher.admitted(client);
    return client;
  };
  // The relay reports the phone's leg gone (remote-relay.ts onClientClose).
  const relayClosed = (clientId) => registry.remove(clientId, true);
  const frames = [];
  const dispatch = createRelayClientCallDispatch({
    acknowledgePaintProbe: () => null,
    attached: (clientId, client) => registry.attached(clientId, client),
    webrtc: relay,
    sendEncryptedFrame: async (_clientId, payload) => {
      frames.push(JSON.parse(JSON.stringify(payload)));
    },
  });
  const CALL_ID = 7;
  const observe = async (clientId, origin) => {
    const before = asked;
    frames.length = 0;
    const outcome = await dispatch(clientId, origin, { id: CALL_ID, method: 'browserRemoteScreenDisplays', params: [] }, 0);
    await outcome.execution;
    if (frames.length > 1) throw new Error('the phone is sent at most one frame, got ' + frames.length);
    return { reply: frames[0] ?? null, hostAsked: asked - before };
  };
  scenarios.push({ name, ...(await act({ admit, observe, publisher, unpaired, envelopes, relayClosed })) });
}
const scenarios = [];

await scenario('a paired, E2EE-established phone is allowed and gets the host\'s display list', async ({ admit, observe }) => {
  const phone = admit('p1', 'cred-1');
  return await observe('p1', phone);
});

await scenario('a local client, which is no relay connection, is refused and the host is not asked', async ({ admit, observe }) => {
  admit('p1', 'cred-1');
  const local = admit('local-1', '');
  local.channel = null;
  return await observe('local-1', local);
});

await scenario('a device whose unpair is in force is refused and the host is not asked', async ({ admit, observe, unpaired, envelopes }) => {
  unpaired.add('cred-1');
  const phone = admit('p1', 'cred-1');
  return { ...(await observe('p1', phone)), envelopes: structuredClone(envelopes) };
});

// The unpair of a paired phone the relay did not confirm: the phone's connection stays attached and its next call is refused.
await scenario('a paired phone is allowed, then unpaired with the relay not removing the pairing: the connection stays and is refused', async ({ admit, observe, publisher, unpaired, envelopes }) => {
  const phone = admit('p1', 'cred-1');
  const before = await observe('p1', phone);
  envelopes.length = 0;
  unpaired.add('cred-1');
  publisher.revokeCredential('cred-1');
  const afterUnpair = structuredClone(envelopes);
  return { before, envelopesAtUnpair: afterUnpair, ...(await observe('p1', phone)) };
});

// The unpair the relay confirmed: it closes the phone's leg and reports it gone, then the connection is not attached and nothing is sent.
await scenario('a paired phone is allowed, then unpaired with the relay removing the pairing: the relay ends the connection and nothing is sent', async ({ admit, observe, publisher, unpaired, envelopes, relayClosed }) => {
  const phone = admit('p1', 'cred-1');
  const before = await observe('p1', phone);
  envelopes.length = 0;
  unpaired.add('cred-1');
  publisher.revokeCredential('cred-1');
  const afterUnpair = structuredClone(envelopes);
  relayClosed('p1');
  return { before, envelopesAtUnpair: afterUnpair, ...(await observe('p1', phone)), envelopesAfter: structuredClone(envelopes) };
});
writeJson(join(stage, 'screen-access.json'), { domain: 'screen-access', recorder, displays: DISPLAYS, scenarios });
writeSetManifest(stage, {
  set: 'screen-access',
  recorder,
  command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <exact archive> --commit ${identity.commit}`,
  identity,
});
commitStage(stage, finalDir);
console.log(`recorded ${scenarios.length} scenarios`);