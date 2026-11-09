// Records, from Node's real stack, what a paired phone's connection gets across an unpair: the desktop service's unpair handler
// (`remoteAccessRevokeClient`, what Settings > Connection calls) over the real relay leg, client table, screen-access publisher and
// remote method table, with a scripted relay and a real E2EE phone. Per method group the same call is made before the unpair and
// after it, over the same phone connection, and every decrypted frame is kept whole.
import { EventEmitter, once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, args.get('commit') ?? (() => { throw new Error('--commit is required'); })());
const recorder = 'benchmarks/rust-core/recorders/record-unpair-access.mjs';
const finalDir = join(FIXTURES_ROOT, 'unpair-access');
const stage = stageSet(finalDir);
const { WebSocketServer } = createRequire(join(tree, 'package.json'))('ws');

const { createDesktopService } = await importFrom(tree, 'apps/desktop/src/main/desktop-service.ts');
const { activateRemote } = await importFrom(tree, 'apps/desktop/src/main/remote-activation.ts');
const { loadOrCreateRelayE2EEIdentity } = await importFrom(tree, 'apps/desktop/src/main/remote-e2ee.ts');
const { relayE2EEPairingMaterial, createRelayE2EEClientHandshake } = await importFrom(tree, 'apps/desktop/src/shared/remote-e2ee.ts');
const { viewSyncHost } = await importFrom(tree, 'apps/desktop/src/main/test-support/view-sync-host.mjs');

const CRED = 'aaaaaaa1';
const TOKEN = 'fcm-token-'.padEnd(40, 'x');
const PUBLIC_KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
// Resolves when predicate holds, re-checked each time a frame arrives on either side; a condition that never comes is the caller's hang.
const changes = new EventEmitter();
const until = (predicate) =>
  new Promise((resolve) => {
    const check = () => {
      if (!predicate()) return;
      changes.off('change', check);
      resolve();
    };
    changes.on('change', check);
    check();
  });

async function scenario(name, relayConfirms) {
  const f = await viewSyncHost();
  const dir = f.options.userDataPath;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const previousUrl = process.env.MIXDOG_RELAY_URL;
  process.env.MIXDOG_RELAY_URL = `ws://127.0.0.1:${server.address().port}`;
  let leg = null;
  const fromDesktop = [];
  server.on('connection', (socket) => {
    leg = socket;
    socket.send(JSON.stringify({ type: 'relay-capabilities', nativePush: 1, nativePushPlatforms: ['fcm'], webPush: 1 }));
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      fromDesktop.push(frame);
      changes.emit('change');
      if (frame.type === 'revoke-client') {
        socket.send(JSON.stringify({ type: 'client-revoked', requestId: frame.requestId, ok: relayConfirms }));
        if (relayConfirms) socket.send(JSON.stringify({ type: 'client-close', clientId: 'p1' }));
      }
      if (frame.type === 'list-clients') {
        socket.send(JSON.stringify({ type: 'clients-list', requestId: frame.requestId, clients: [{ id: CRED, name: 'Pixel', browser: 'Chrome' }] }));
      }
    });
  });
  let service;
  try {
    await activateRemote(dir);
    service = await createDesktopService({
      options: f.options,
      runtime: { ...f.runtime, loadConfig: async () => ({ readConfig: () => ({}) }) },
      emit: () => undefined,
    });
    const invoke = (operation, ...a) => service.invoke('invokeDesktopOperation', [operation, a]);
    await invoke('remoteAccessStart');
    await until(() => fromDesktop.some((frame) => frame.type === 'set-client-token'), 'the desktop leg is up');
    const pairing = relayE2EEPairingMaterial(await loadOrCreateRelayE2EEIdentity(dir));
    const phones = new Map();
    leg.on('message', (raw) => {
      const envelope = JSON.parse(String(raw));
      const phone = phones.get(envelope.clientId);
      if (!phone) return;
      if (envelope.type === 'close-client') phone.closedByDesktop = envelope.reason;
      if (envelope.type !== 'frame') return;
      phone.queue = phone.queue.then(async () => {
        if (!phone.channel) {
          const handshake = await createRelayE2EEClientHandshake(pairing, JSON.parse(envelope.data));
          phone.channel = handshake.channel;
          leg.send(JSON.stringify({ type: 'frame', clientId: phone.id, data: JSON.stringify(handshake.hello) }));
          return;
        }
        phone.messages.push(await phone.channel.decryptJson(envelope.data));
        changes.emit('change');
      });
    });
    let next = 100;
    const openPhone = async (id) => {
      const phone = { id, messages: [], channel: null, queue: Promise.resolve(), closedByDesktop: null };
      phones.set(id, phone);
      leg.send(JSON.stringify({ type: 'client-open', clientId: id, browserClientId: CRED }));
      await until(() => phone.messages.length > 0, 'the phone is established');
      const send = async (method, params) => {
        const callId = next++;
        leg.send(JSON.stringify({ type: 'frame', clientId: id, data: await phone.channel.encryptJson({ id: callId, method, params }) }));
        return callId;
      };
      const call = async (method, params) => {
        const callId = await send(method, params);
        await until(() => phone.messages.some((m) => m.id === callId), `reply to ${method}`);
        return phone.messages.find((m) => m.id === callId);
      };
      return {
        phone,
        call,
        // No window answers the display list here, so an allowed phone's ask stays pending; only a refusal is a frame. A phone's calls are
        // handled in order, so once the next call is answered a refusal of this one would already have been sent.
        screen: async () => {
          const callId = await send('browserRemoteScreenDisplays', []);
          await call('listSessions', []);
          return phone.messages.find((m) => m.id === callId) ?? null;
        },
      };
    };
    const download = join(dir, 'unpair-download.txt');
    const first = await openPhone('p1');
    const { phone, call, screen } = first;
    const groups = [
      ['chat', 'listSessions', []],
      ['terminal', 'termProfiles', []],
      ['settings', 'readSettings', []],
      ['notifications', 'getNotificationPreferences', []],
      ['webPush', 'pushPublicKey', []],
    ];
    const setup = {
      setNotificationPreferences: await call('setNotificationPreferences', [CRED, { scope: 'off' }]),
      registerNativePush: await call('registerNativePush', [{ platform: 'fcm', token: TOKEN, publicKey: PUBLIC_KEY }]),
      registerPushSubscription: await call('registerPushSubscription', [{ endpoint: 'https://push.example/x', p256dh: PUBLIC_KEY, auth: 'AAAAAAAAAAAAAAAAAAAAAA', clientId: CRED }]),
    };
    f.put('s1', 'before');
    await call('setVisibleSessions', [['s1']]);
    const before = {};
    for (const [group, method, params] of groups) before[group] = await call(method, params);
    // Files: a granted one-file download, begun into a transfer, and a second grant not yet begun; both are the device's own.
    await writeFile(download, 'unpair download');
    const request = { source: { kind: 'session', sessionId: 's1', path: download }, purpose: 'save' };
    const grant = await call('fileDownloadAuthorize', [request]);
    const transfer = await call('fileDownloadBegin', [grant.value.grantId]);
    const unbegun = await call('fileDownloadAuthorize', [request]);
    before.files = { granted: grant.ok && transfer.ok && unbegun.ok };
    fromDesktop.length = 0;
    let revokeOutcome = 'resolved';
    await invoke('remoteAccessRevokeClient', CRED).catch((error) => { revokeOutcome = `rejected: ${error.message}`; });
    // A confirmed unpair has the desktop re-read the roster; a refused one has nothing more to send.
    if (relayConfirms) await until(() => fromDesktop.some((frame) => frame.type === 'list-clients'), 'the roster is re-read');
    const envelopesAtUnpair = fromDesktop.map((frame) => frame.type);
    // A frame whose body depends on this machine is kept as whether it changed; a refusal is kept whole.
    // The bodies depend on this machine (names, paths, times), so a group is kept as whether the same call answered the same,
    // and as what it answered when it did not; the device lists are kept as ids only.
    const project = (group, m) => {
      if (!m.ok) return { ok: false, error: m.error };
      if (group === 'notifications') return { ok: true, devices: m.value.devices.map((d) => d.id), preferences: Object.keys(m.value.preferences) };
      return { ok: true, value: JSON.parse(JSON.stringify(m.value, (k, v) => (k === 'updatedAt' || k === 'activityAt' ? undefined : v))) };
    };
    const shape = (group, b, a) => {
      const [pb, pa] = [project(group, b), project(group, a)];
      return { before: group === 'notifications' ? pb : pb.ok, after: JSON.stringify(pb) === JSON.stringify(pa) ? 'same' : pa };
    };
    const connected = !relayConfirms;
    const second = await openPhone('p2');
    const ask = relayConfirms ? second.call : call;
    const after = {};
    for (const [group, method, params] of groups) after[group] = shape(group, before[group], await ask(method, params));
    // Files: the transfer and the grant the device held end with its unpair, for the same device on any connection.
    after.files = {
      range: project('files', await ask('fileDownloadRange', [transfer.value.transferId, 0, 4, transfer.value.version])),
      begin: project('files', await ask('fileDownloadBegin', [unbegun.value.grantId])),
    };
    after.screen = await (relayConfirms ? second.screen : screen)();
    after.secondConnection = { screen: await second.screen() };
    const prefs = await ask('getNotificationPreferences', []);
    after.notificationsAfterForget = { ok: prefs.ok, scope: prefs.value.preferences[CRED]?.scope ?? null };
    after.removeNativePush = await ask('removeNativePush', [TOKEN]);
    after.removePushSubscription = await ask('removePushSubscription', ['https://push.example/x']);
    let feedEvent = null;
    if (!relayConfirms) {
      const seen = phone.messages.length;
      f.put('s1', 'after');
      await until(() => phone.messages.length > seen, 'the session feed reaches the phone');
      await call('listSessions', []);
      feedEvent = phone.messages.slice(seen).filter((m) => m.id === undefined).map((m) => Object.keys(m).sort().join(','));
    }
    return { name, relayConfirms, revokeOutcome, envelopesAtUnpair, desktopClosedPhone: phone.closedByDesktop, phoneStillAttached: connected, after, feedEvent };
  } finally {
    await service?.dispose();
    leg?.terminate();
    await new Promise((r) => server.close(r));
    if (previousUrl === undefined) delete process.env.MIXDOG_RELAY_URL; else process.env.MIXDOG_RELAY_URL = previousUrl;
    await f.close?.();
  }
}

const out = [];
out.push(await scenario('the relay did not remove the pairing', false));
out.push(await scenario('the relay removed the pairing', true));
writeJson(join(stage, 'unpair-access.json'), { domain: 'unpair-access', recorder, credential: CRED, token: TOKEN, scenarios: out });
writeSetManifest(stage, {
  set: 'unpair-access',
  recorder,
  command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <exact archive> --commit ${identity.commit}`,
  identity,
});
commitStage(stage, finalDir);
console.log(`recorded ${out.length} scenarios`);
process.exit(0);