// Records Node's composed screen-access decision: the real relay's `screenDisplays` (apps/desktop/src/main/remote-webrtc/relay.ts) asking the
// real screen-access publisher (apps/desktop/src/main/remote-screen/screen-access-publisher.ts `allowed`) over a client table, as
// remote-relay.ts composes them (`screenAuthorized: (clientId, origin) => screenAccessPublisher.allowed(clientId, origin)`). Each scenario
// records the complete observation of one request for the display list and how many times the host was asked for it.
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
const { createScreenAccessPublisher } = await importFrom(tree, 'apps/desktop/src/main/remote-screen/screen-access-publisher.ts');

const DISPLAYS = [{ id: 'display-1', label: 'Display 1', primary: true, width: 1920, height: 1080 }];

async function scenario(name, act) {
  const table = new Map();
  const unpaired = new Set();
  let asked = 0;
  const publisher = createScreenAccessPublisher({
    client: (clientId) => table.get(clientId),
    clients: () => table.entries(),
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
  const admit = (clientId, client) => {
    table.set(clientId, client);
    publisher.admitted(client);
    return client;
  };
  const observe = async (clientId, origin) => {
    const before = asked;
    let observation;
    try {
      observation = { ok: true, value: JSON.parse(JSON.stringify(await relay.screenDisplays(clientId, origin))) };
    } catch (error) {
      observation = { ok: false, error: error instanceof Error ? error.message : String(error), errorType: error?.constructor?.name };
    }
    return { observation, hostAsked: asked - before };
  };
  scenarios.push({ name, ...(await act({ admit, observe, publisher, unpaired })) });
}
const scenarios = [];

await scenario('a paired, E2EE-established phone is allowed and gets the host\'s display list', async ({ admit, observe }) => {
  const phone = admit('p1', { credentialId: 'cred-1', channel: true });
  return await observe('p1', phone);
});

await scenario('a local client, which is no relay connection, is refused and the host is not asked', async ({ admit, observe }) => {
  admit('p1', { credentialId: 'cred-1', channel: true });
  return await observe('local-1', { credentialId: '', channel: false });
});

await scenario('a device whose unpair is in force is refused and the host is not asked', async ({ admit, observe, unpaired }) => {
  unpaired.add('cred-1');
  const phone = admit('p1', { credentialId: 'cred-1', channel: true });
  return await observe('p1', phone);
});

await scenario('a paired phone is allowed, then its credential is unpaired and it is refused', async ({ admit, observe, publisher, unpaired }) => {
  const phone = admit('p1', { credentialId: 'cred-1', channel: true });
  const before = await observe('p1', phone);
  unpaired.add('cred-1');
  publisher.revokeCredential('cred-1');
  return { before, ...(await observe('p1', phone)) };
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