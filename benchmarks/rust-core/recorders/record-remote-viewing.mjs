#!/usr/bin/env node
// Node's "remote viewing": whether a paired phone shows a session's visualize panel
// (`viewsSessionLane(sessionId, REMOTE_VISUALIZE_LANE)`, desktop-service `visualizeRemoteViewing`).
//
// Two recordings, both from the committed product:
//  * `table`: the per-client rule `clientViewsSessionLane` (remote-relay-clients.ts) over every
//    combination of channel / background / reported panels / lanes / visible sessions.
//  * `scenarios`: the real `startRemoteRelay` against a local `ws` server that plays the relay,
//    with TEST PEERS that complete the real E2EE handshake and speak the phone's own calls
//    (`setForeground`, `setVisualizePanels`), a second phone, a client-close and a lost relay leg.
//    After every step the relay handle's own `viewsSessionLane` is read for each session id.
// The Rust core replays the same steps as `ui/screenSessions/changed` notifications of relay
// connections and compares the sessions its `hostState.remoteViewing` publishes.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-remote-viewing.mjs --tree <git checkout with node_modules>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const { WebSocketServer } = await import(pathToFileURL(join(tree, 'node_modules/ws/wrapper.mjs')).href);
const work = mkdtempSync(join(tmpdir(), 'mixdog-remote-viewing-'));
const userData = join(work, 'userData');
mkdirSync(userData, { recursive: true });
// Nothing the product reads or writes may resolve outside `work`: the real desktop profile and Mixdog data are never touched.
for (const [name, dir] of Object.entries({
  APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', HOME: 'home-dir', USERPROFILE: 'home-dir', MIXDOG_DESKTOP_USER_DATA: 'userData',
  MIXDOG_DATA_DIR: 'data', MIXDOG_HOME: 'home', MIXDOG_CONFIG_DIR: 'config', MIXDOG_RUNTIME_ROOT: 'runtime',
})) {
  process.env[name] = join(work, dir);
  mkdirSync(process.env[name], { recursive: true });
}
process.env.MIXDOG_REMOTE_METER = '0';
const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const e2ee = await importFrom(tree, 'apps/desktop/src/shared/remote-e2ee.ts');
const { REMOTE_VISUALIZE_LANE } = await importFrom(tree, 'apps/desktop/src/shared/visualize.ts');
const { clientViewsSessionLane } = await main('remote-relay-clients');
const { startRemoteRelay } = await main('remote-relay');

// ---- the per-client rule, over its whole input domain ------------------------------------------
const SESSIONS = ['s1', 's2'];
const table = [];
for (const channel of [false, true]) {
  for (const background of [false, true]) {
    for (const panels of [null, [], ['s1'], ['s2'], ['s1', 's2']]) {
      for (const lanes of [null, [], [REMOTE_VISUALIZE_LANE], ['terminal']]) {
        for (const visible of [[], ['s1']]) {
          for (const sessionId of SESSIONS) {
            const state = {
              channel: channel ? {} : null,
              background,
              lanes: lanes === null ? null : new Set(lanes),
              visibleSessionIds: new Set(visible),
              ...(panels === null ? {} : { visualizePanelSessionIds: new Set(panels) }),
            };
            table.push({ channel, background, panels, lanes, visible, sessionId, views: clientViewsSessionLane(state, sessionId, REMOTE_VISUALIZE_LANE) });
          }
        }
      }
    }
  }
}

// ---- the relay stand-in ------------------------------------------------------------------------
const inbox = [];
const waiters = [];
let socket = null;
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
wss.on('connection', (ws) => {
  socket = ws;
  ws.on('message', (raw, binary) => {
    if (binary) return;
    const entry = JSON.parse(String(raw));
    const waiter = waiters.findIndex((w) => w.match(entry));
    if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(entry);
    else inbox.push(entry);
  });
});
await new Promise((r) => wss.once('listening', r));
const port = wss.address().port;
const next = (match, what, ms = 8000) => {
  const at = inbox.findIndex(match);
  if (at >= 0) return Promise.resolve(inbox.splice(at, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve };
    waiters.push(waiter);
    setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) {
        waiters.splice(i, 1);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, ms);
  });
};
const sendJson = (envelope) => socket.send(JSON.stringify(envelope));
const until = async (what, ready, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const host = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : /^(subscribe|on|watch)/.test(String(prop)) ? () => () => {} : async () => (prop === 'listSessions' ? [] : null)) });
const handle = await startRemoteRelay({
  relayUrl: `ws://127.0.0.1:${port}`, userDataPath: userData, host, appVersion: '0.0.0-fixture', hostName: () => 'FIXTURE-PC',
  onClientClaim: async () => ({ approved: false }),
});
await next((e) => e.type === 'set-client-token', 'set-client-token');
sendJson({ type: 'relay-capabilities', textFrames: 1, maxFrameBytes: 64 * 1024 * 1024, uplinkCapacityBytes: 8 * 1024 * 1024, uplinkBinaryCeilingBytes: 1000, uplinkTextCeilingBytes: 1000 });

// ---- a phone: the real browser-side handshake, then the phone's own calls ----------------------
let callId = 0;
async function openPhone() {
  const clientId = crypto.randomUUID();
  sendJson({ type: 'client-open', clientId, browserClientId: crypto.randomUUID().replaceAll('-', '') });
  const mine = (e) => e.type === 'frame' && e.clientId === clientId;
  const challenge = JSON.parse((await next(mine, 'challenge')).data);
  const { hello, channel } = await e2ee.createRelayE2EEClientHandshake(handle.pairing, challenge, {});
  sendJson({ type: 'frame', clientId, data: JSON.stringify(hello) });
  const ready = await channel.decryptJson((await next(mine, 'e2ee-ready')).data);
  if (ready.type !== 'e2ee-ready') throw new Error(`unexpected first frame ${JSON.stringify(ready)}`);
  const phone = {
    clientId,
    // The relay handles one client's frames in decode order, so the answer to a later request
    // proves every earlier call of this phone has been applied.
    async settle() {
      const id = ++callId;
      sendJson({ type: 'frame', clientId, data: await channel.encryptJson({ id, method: 'listSessions', params: [] }) });
      for (;;) {
        const payload = await channel.decryptJson((await next(mine, `answer ${id}`)).data);
        if (payload.id === id) return;
      }
    },
    async call(method, params) {
      sendJson({ type: 'frame', clientId, data: await channel.encryptJson({ method, params }) });
      await phone.settle();
    },
  };
  return phone;
}

const viewed = () => Object.fromEntries(['s1', 's2', 'bad id!', ''].map((id) => [id, handle.viewsSessionLane(id, REMOTE_VISUALIZE_LANE)]));
const scenarios = [];
const record = (step) => scenarios.push({ ...step, views: viewed() });

const phones = new Map();
const open = async (name) => {
  phones.set(name, await openPhone());
  await until(`${name} attached`, () => handle.clientCount === phones.size);
  record({ op: 'open', client: name });
};
const panels = async (name, ids) => {
  await phones.get(name).call('setVisualizePanels', [ids]);
  record({ op: 'panels', client: name, ids });
};
const foreground = async (name, visible, browserId) => {
  await phones.get(name).call('setForeground', [visible, browserId]);
  record({ op: 'foreground', client: name, visible, browserId });
};
const close = async (name) => {
  sendJson({ type: 'client-close', clientId: phones.get(name).clientId });
  phones.delete(name);
  await until(`${name} gone`, () => handle.clientCount === phones.size);
  record({ op: 'close', client: name });
};

await open('A');
await panels('A', ['s1']);
await foreground('A', false, 'browser-a');
await foreground('A', true, 'browser-a');
await panels('A', ['s2']);
await panels('A', ['bad id!', 's1', 's1']);
await panels('A', []);
await panels('A', ['s1']);
await open('B');
await panels('B', ['s2']);
await foreground('A', false, 'browser-a');
await foreground('B', false, 'browser-b');
await foreground('A', true, 'browser-a');
await close('A');
await foreground('B', true, 'browser-b');
await close('B');
await open('C');
await panels('C', ['s1', 's2']);
// The relay leg itself is lost: no client survives it.
for (const c of wss.clients) c.terminate();
await until('the lost leg removed its clients', () => handle.clientCount === 0);
phones.clear();
record({ op: 'leg-lost' });

await handle.close();
for (const c of wss.clients) c.terminate();
await new Promise((r) => wss.close(r));

const finalOut = join(FIXTURES_ROOT, 'remote-viewing');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'Node viewsSessionLane (the visualize lane): the per-client rule over its input domain, and the real relay handle after each phone call.',
  lane: REMOTE_VISUALIZE_LANE,
  table,
  scenarios,
});
writeSetManifest(out, {
  set: 'remote-viewing',
  recorder: 'benchmarks/rust-core/recorders/record-remote-viewing.mjs',
  command: 'node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-remote-viewing.mjs --tree <git checkout of b6f10295a2f698afc85332467192de28500bd146 with node_modules>',
  identityTree: tree,
  identityRef: REF,
  extra: { table: table.length, scenarios: scenarios.length },
});
commitStage(out, finalOut);
rmSync(work, { recursive: true, force: true });
console.log(`remote-viewing: ${table.length} table rows, ${scenarios.length} scenario steps`);
process.exit(0);
