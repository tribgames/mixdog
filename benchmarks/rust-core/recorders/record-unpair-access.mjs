// Records, from Node's real stack, what a paired phone's connection gets across an unpair: the desktop service's unpair handler
// (`remoteAccessRevokeClient`, what Settings > Connection calls) over the real relay leg, client table, screen-access publisher and
// remote method table, with a scripted relay and a real E2EE phone. Per method group the same call is made before the unpair and
// after it, over the same phone connection, and every decrypted frame is kept whole.
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

// The values that differ between two Node runs of this script, by exact path in a scenario: [kind, path]. `--vary a b` (two `--raw`
// runs) proves the list: the paths whose values differ between the runs are exactly these. No time is among them: the clock below is
// the recorder's own, so every time Node reads or computes is the same in every run. A random id is replaced by `<kind#n>`, numbered
// by first appearance of the value over the whole recording (scenarios in order, paths in this order), so equal values share one token
// and different values never do; this run's temporary directory, alone or as the head of a path, by `<dir>`.
const REMAP = [
  ['webPushKey', 'before.webPush.value'],
  ['webPushKey', 'after.webPush.value'],
  ['grantId', 'before.files.grant.value.grantId'],
  ['version', 'before.files.grant.value.version'],
  ['transferId', 'before.files.transfer.value.transferId'],
  ['version', 'before.files.transfer.value.version'],
  ['assetId', 'before.files.transfer.value.media.assetId'],
  ['grantId', 'before.files.unbegun.value.grantId'],
  ['version', 'before.files.unbegun.value.version'],
  ['accessToken', 'before.link.resolve.value.0.accessToken'],
  ['dir', 'before.link.resolve.value.0.absolutePath'],
  ['dir', 'before.link.resolve.value.0.projectPath'],
  ['dir', 'before.chat.value.0.cwd'],
  ['dir', 'before.chat.value.0.projectPath'],
  ['dir', 'after.chat.value.0.cwd'],
  ['dir', 'after.chat.value.0.projectPath'],
];

const args = parseArgs();
if (args.get('vary')) {
  // Which leaf paths differ between two raw runs of the same scenario; the exit code says whether they are exactly REMAP's.
  const [first, second] = [args.get('vary'), args.get('against')].map((file) => JSON.parse(readFileSync(file, 'utf8')));
  const leaves = (node, path, into) => {
    if (Array.isArray(node)) node.forEach((item, index) => leaves(item, `${path}.${index}`, into));
    else if (node !== null && typeof node === 'object') for (const [key, value] of Object.entries(node)) leaves(value, `${path}.${key}`, into);
    else into.set(path.slice(1), JSON.stringify(node));
    return into;
  };
  const listed = new Set(REMAP.map(([, path]) => path));
  let exact = true;
  first.forEach((run, index) => {
    const [x, y] = [leaves(run.body, '', new Map()), leaves(second[index].body, '', new Map())];
    const differing = [...new Set([...x.keys(), ...y.keys()])].filter((path) => x.get(path) !== y.get(path));
    const unlisted = differing.filter((path) => !listed.has(path));
    const unvaried = [...listed].filter((path) => !differing.includes(path));
    console.log(`scenario ${index}: ${differing.length} paths differ between the runs; differ but not remapped: ${JSON.stringify(unlisted)}; remapped but equal: ${JSON.stringify(unvaried)}`);
    for (const path of differing) console.log(`  ${path}`);
    if (unlisted.length || unvaried.length) exact = false;
  });
  process.exit(exact ? 0 : 1);
}
const tree = resolveTree(args);

// The clock Node's stack reads (`Date.now`, `new Date()`), installed before any of it loads so what it captures is this one. It moves only
// when the recorder moves it (a second per call the phone makes), so the order of the times and the distance between them (a grant
// expires a fixed time after the clock it was made at) are the same in every run.
const CLOCK_START = Date.UTC(2031, 0, 1);
const RealDate = globalThis.Date;
let clock = CLOCK_START;
globalThis.Date = class extends RealDate {
  constructor(...given) {
    super(...(given.length ? given : [clock]));
  }

  static now() {
    return clock;
  }
};
// The downloaded file's modification time, in seconds: part of the file's identity Node versions a download by.
const MTIME_S = Math.floor(CLOCK_START / 1000) - 86_400;
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

const at = (root, path) => path.split('.').reduce((node, key) => node?.[key], root);
// One token per distinct value over the whole recording, numbered per kind by first appearance.
const tokens = new Map();
const counts = new Map();
function remapped(body, dir) {
  const out = structuredClone(body);
  for (const [kind, path] of REMAP) {
    const parts = path.split('.');
    const holder = at(out, parts.slice(0, -1).join('.'));
    const value = holder?.[parts.at(-1)];
    if (typeof value !== 'string') throw new Error(`remapped path ${path} holds no string in the recording`);
    if (kind === 'dir') {
      if (!value.startsWith(dir)) throw new Error(`remapped path ${path} does not start with the temporary directory`);
      holder[parts.at(-1)] = `<dir>${value.slice(dir.length)}`;
      continue;
    }
    if (!tokens.has(value)) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      tokens.set(value, `<${kind}#${counts.get(kind) - 1}>`);
    }
    holder[parts.at(-1)] = tokens.get(value);
  }
  // Nothing else may carry this run's directory or a token: the list above is all that is replaced.
  const stray = (node, path) => {
    if (typeof node === 'string' && (node.includes(dir) || /^<[A-Za-z]+(#\d+)?>/u.test(node)) && !REMAP.some(([, listed]) => listed === path)) throw new Error(`${path} holds a value the remap list does not name: ${node}`);
    if (node !== null && typeof node === 'object') for (const [key, value] of Object.entries(node)) stray(value, path ? `${path}.${key}` : key);
  };
  stray(out, '');
  return out;
}
async function scenario(name, relayConfirms) {
  clock = CLOCK_START;
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
        clock += 1000;
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
          return phone.messages.find((m) => m.id === callId) ?? { id: callId, unanswered: true };
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
    await utimes(download, MTIME_S, MTIME_S);
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
    return args.get('raw') ? { dir, body } : remapped(body, dir);  } finally {
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
writeJson(join(stage, 'unpair-access.json'), { domain: 'unpair-access', recorder, credential: CRED, token: TOKEN, remapped: REMAP.map(([kind, path]) => ({ kind, path })), scenarios: out });
writeSetManifest(stage, {
  set: 'unpair-access',
  recorder,
  command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <exact archive> --commit ${identity.commit}`,
  identity,
});
commitStage(stage, finalDir);
console.log(`recorded ${out.length} scenarios`);
process.exit(0);