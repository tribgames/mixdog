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
// Resolves when predicate holds, re-checked each time a frame arrives on either side. A condition that does not come within
// UNTIL_DEADLINE_MS, or a desktop leg that ends while it waits, rejects with what (the handshake, reply or feed that is missing).
const UNTIL_DEADLINE_MS = 60_000;
const changes = new EventEmitter();
const until = (predicate, what) =>
  new Promise((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      changes.off('change', check);
      changes.off('leg-ended', ended);
    };
    const check = () => {
      if (!predicate()) return;
      settle();
      resolve();
    };
    const ended = () => {
      settle();
      reject(new Error('the desktop leg ended while waiting for: ' + what));
    };
    const timer = setTimeout(() => {
      settle();
      reject(new Error('nothing arrived within ' + UNTIL_DEADLINE_MS + ' ms: ' + what));
    }, UNTIL_DEADLINE_MS);
    changes.on('change', check);
    changes.on('leg-ended', ended);
    check();
  });

// The only values that differ between two Node recordings of this script (proved by running it twice: the two fixtures are
// byte-identical once these are replaced): clock times, ids Node generates, this run's temporary directory (alone, or as the prefix
// of the file's path) and the Web Push key generated per install. A varying value is replaced by `<key#n>`, numbered by first
// appearance among the values of that key, over the frames in `ORDER`; the directory prefix by `<dir>`. Everything else is kept.
const VARYING = {
  time: ['updatedAt', 'activityAt', 'expiresAt', 'mtimeMs'],
  generated: ['grantId', 'transferId', 'assetId', 'version', 'accessToken'],
  directory: ['cwd', 'projectPath'],
  directoryPrefix: ['absolutePath'],
};// The frames of a scenario in the order they were made; `canon` walks them in this order and each object's keys in order.
const ORDER = [
  'setup.setNotificationPreferences', 'setup.registerNativePush', 'setup.registerPushSubscription',
  'before.chat', 'before.terminal', 'before.settings', 'before.notifications', 'before.webPush',
  'before.files.grant', 'before.files.transfer', 'before.files.unbegun', 'before.link.resolve', 'before.link.read',
  'after.chat', 'after.terminal', 'after.settings', 'after.notifications', 'after.webPush',
  'after.files.range', 'after.files.begin', 'after.link.read', 'after.screen', 'after.secondConnection.screen',
  'after.notificationsAfterForget', 'after.removeNativePush', 'after.removePushSubscription',
];
const at = (root, path) => path.split('.').reduce((node, key) => node?.[key], root);
function canon(scenarioBody, dir) {
  const seen = new Map();
  const token = (key, value) => {
    const known = seen.get(key) ?? seen.set(key, []).get(key);
    if (!known.some((held) => held === JSON.stringify(value))) known.push(JSON.stringify(value));
    return `<${key}#${known.indexOf(JSON.stringify(value))}>`;
  };
  const replaced = (path, key, value) => {
    if (VARYING.time.includes(key) && typeof value === 'number') return token(key, value);
    if (VARYING.generated.includes(key) && typeof value === 'string') return token(key, value);
    if (VARYING.directory.includes(key) && value === dir) return '<dir>';
    if (VARYING.directoryPrefix.includes(key) && typeof value === 'string' && value.startsWith(dir)) return `<dir>${value.slice(dir.length)}`;
    // The Web Push public key is generated once per install; the same key answers before and after.
    if (path.endsWith('.webPush') && key === 'value') return token('webPushKey', value);
    return undefined;
  };
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.map((item) => walk(item, path));
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, replaced(path, key, value) ?? walk(value, path)]));
  };
  const out = structuredClone(scenarioBody);
  for (const path of ORDER) {
    const parts = path.split('.');
    const holder = at(out, parts.slice(0, -1).join('.'));
    holder[parts.at(-1)] = walk(at(scenarioBody, path), path);
  }
  out.feedEvents = scenarioBody.feedEvents === null ? null : scenarioBody.feedEvents.map((frame, index) => walk(frame, `feedEvents.${index}`));
  return out;
}
async function scenario(name, relayConfirms) {
  const f = await viewSyncHost();
  const dir = f.options.userDataPath;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const previousUrl = process.env.MIXDOG_RELAY_URL;
  process.env.MIXDOG_RELAY_URL = `ws://127.0.0.1:${server.address().port}`;
  let leg = null;
  let tearingDown = false;
  const fromDesktop = [];
  server.on('connection', (socket) => {
    leg = socket;
    socket.on('close', () => { if (!tearingDown) changes.emit('leg-ended'); });
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
    before.files = { grant, transfer, unbegun };
    // The device's selected-file grant (`resolveLocalPaths`, a file outside every project) and a read through it.
    const resolve = await call('resolveLocalPaths', [[download]]);
    const row = resolve.value[0];
    const readLink = [row.projectPath, row.relPath, row.accessToken];
    before.link = { resolve, read: await call('readProjectFile', readLink) };    fromDesktop.length = 0;
    let revokeOutcome = 'resolved';
    await invoke('remoteAccessRevokeClient', CRED).catch((error) => { revokeOutcome = `rejected: ${error.message}`; });
    // A confirmed unpair has the desktop re-read the roster; a refused one has nothing more to send.
    if (relayConfirms) await until(() => fromDesktop.some((frame) => frame.type === 'list-clients'), 'the roster is re-read');
    const envelopesAtUnpair = fromDesktop.map((frame) => frame.type);
    const connected = !relayConfirms;
    const second = await openPhone('p2');
    const ask = relayConfirms ? second.call : call;
    const after = {};
    for (const [group, method, params] of groups) after[group] = await ask(method, params);
    // Files: the transfer and the grant the device held end with its unpair, for the same device on any connection.
    after.files = {
      range: await ask('fileDownloadRange', [transfer.value.transferId, 0, 4, transfer.value.version]),
      begin: await ask('fileDownloadBegin', [unbegun.value.grantId]),
    };
    after.link = { read: await ask('readProjectFile', readLink) };
    after.screen = await (relayConfirms ? second.screen : screen)();
    after.secondConnection = { screen: await second.screen() };
    after.notificationsAfterForget = await ask('getNotificationPreferences', []);
    after.removeNativePush = await ask('removeNativePush', [TOKEN]);
    after.removePushSubscription = await ask('removePushSubscription', ['https://push.example/x']);
    let feedEvents = null;
    if (!relayConfirms) {
      const seen = phone.messages.length;
      f.put('s1', 'after');
      await until(() => phone.messages.length > seen, 'the session feed reaches the phone');
      await call('listSessions', []);
      // Only the frames that answer no call (no id) are the feed; every one is kept whole.
      feedEvents = phone.messages.slice(seen).filter((m) => m.id === undefined);
    }
    const body = { name, relayConfirms, revokeOutcome, envelopesAtUnpair, desktopClosedPhone: phone.closedByDesktop, phoneStillAttached: connected, setup, before, after, feedEvents };
    // --raw <file>: keep this run's frames exactly as Node produced them (no remapping), to compare two runs.
    return args.get('raw') ? { dir, body } : canon(body, dir);  } finally {
    tearingDown = true;
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
if (args.get('raw')) {
  await writeFile(args.get('raw'), JSON.stringify(out));
  console.log('raw run written');
  process.exit(0);
}
writeJson(join(stage, 'unpair-access.json'), { domain: 'unpair-access', recorder, credential: CRED, token: TOKEN, order: ORDER, remapped: VARYING, scenarios: out });
writeSetManifest(stage, {
  set: 'unpair-access',
  recorder,
  command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <exact archive> --commit ${identity.commit}`,
  identity,
});
commitStage(stage, finalDir);
console.log(`recorded ${out.length} scenarios`);
process.exit(0);