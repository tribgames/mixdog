// The replay of record-terminal-lane-reach.mjs against a built mixdogd: per recorded world a freshly started core that dials a scripted relay,
// a desktop connection (loopback) that opens a tab and types into it, and two paired phones behind the relay, each the phone's own terminal
// adapter (apps/desktop/src/renderer/remote-protocol-terminal.ts) and lane feeds (apps/mobile/src/phone-lanes.ts) over its protocol client,
// reading the terminal lane. The same steps as the recording; each world's values are computed the recording's way (lib/terminal-lane-reach.mjs)
// and compared whole with Node's.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REPO_ROOT } from './common.mjs';
import { endCore } from './core-stop.mjs';
import { startCore } from './phone-files-replay.mjs';
import { assertNoPowerShellProfile, isolatedProfile } from './shell-isolation.mjs';
import { LANE_REACH_CREDENTIALS, LANE_REACH_MARKS, LANE_REACH_TABS, reachOf } from './terminal-lane-reach.mjs';

const here = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
/** One wait for something the core sends. */
const DEADLINE_MS = 60_000;

/** `promise`, or a failure naming `what` once DEADLINE_MS passed. */
function within(promise, what) {
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`the replay waited ${DEADLINE_MS} ms for ${what}, which did not happen`)), DEADLINE_MS)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A relay the core dials: the desktop leg, the roster of the two devices, an unpair refused or confirmed (a confirmed one removes the device
 *  from the roster; the phone's socket stays open, as the recording held it). The phones are the app's own end of the E2EE channel. */
async function startRelay(E2EE) {
  const { WebSocketServer } = createRequire(join(REPO_ROOT, 'apps', 'desktop', 'package.json'))('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await within(new Promise((resolve) => server.once('listening', resolve)), 'the relay to listen');
  const state = { socket: null, confirms: false, roster: new Set(), phones: new Map(), legWaiters: [] };
  server.on('connection', (socket) => {
    state.socket = socket;
    socket.send(JSON.stringify({ type: 'relay-capabilities', textFrames: 1, maxFrameBytes: 1048576 }));
    for (const waiter of state.legWaiters.splice(0)) waiter();
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString('utf8'));
      if (frame.type === 'list-clients') {
        return socket.send(JSON.stringify({ type: 'clients-list', requestId: frame.requestId, clients: [...state.roster].map((id) => ({ id, name: id, browser: 'Chrome' })) }));
      }
      if (frame.type === 'revoke-client') {
        if (state.confirms) state.roster.delete(frame.clientId);
        return socket.send(JSON.stringify({ type: 'client-revoked', requestId: frame.requestId, ok: state.confirms, ...(state.confirms ? {} : { error: 'The relay could not unpair the device.' }) }));
      }
      if (frame.type === 'frame' || frame.type === 'close-client') state.phones.get(frame.clientId)?.arrived(frame);
    });
  });
  async function openPhone(clientId, credential, pairing) {
    const inbox = [];
    const waiting = [];
    const phone = {
      closedByDesktop: null,
      arrived(frame) {
        if (frame.type === 'close-client') phone.closedByDesktop = frame.reason ?? '';
        const next = waiting.shift();
        if (next) next(frame);
        else inbox.push(frame);
      },
    };
    const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiting.push(resolve)));
    state.phones.set(clientId, phone);
    state.socket.send(JSON.stringify({ type: 'client-open', clientId, browserClientId: credential }));
    const challenge = JSON.parse((await within(next(), `the challenge to the phone ${clientId}`)).data);
    const { hello, channel } = await E2EE.createRelayE2EEClientHandshake(pairing, challenge);
    state.socket.send(JSON.stringify({ type: 'frame', clientId, data: JSON.stringify(hello) }));
    const ready = await channel.decryptJson((await within(next(), `the phone ${clientId}'s e2ee-ready`)).data);
    if (ready?.type !== 'e2ee-ready') throw new Error(`the core did not answer the hello with e2ee-ready: ${JSON.stringify(ready)}`);
    let sending = Promise.resolve();
    const connector = {
      async open(_target, sink) {
        // Frames are sealed and opened in order, one at a time: the channel's sequence numbers are the order.
        let receiving = Promise.resolve();
        void (async () => {
          for (;;) {
            const frame = await next();
            if (frame.type === 'close-client') return sink.closed(1000, frame.reason ?? '');
            receiving = receiving.then(async () => sink.frame(JSON.stringify(await channel.decryptJson(frame.data))));
          }
        })();
        return {
          send(text) {
            sending = sending.then(async () => state.socket.send(JSON.stringify({ type: 'frame', clientId, data: await channel.encryptJson(JSON.parse(text)) })));
          },
          close() {},
        };
      },
    };
    return { connector, phone };
  }
  return {
    port: server.address().port,
    world(confirms, roster) {
      state.confirms = confirms;
      state.roster = new Set(roster);
    },
    leg: () => (state.socket ? Promise.resolve() : within(new Promise((resolve) => state.legWaiters.push(resolve)), 'the core to dial the relay')),
    openPhone,
    close: () => server.close(),
  };
}

/** Replays `golden` (apps/mobile/fixtures/terminal-lane-reach/golden.json) on the core `exe`; resolves with each world's differences. */
export async function replayLaneReach({ exe, golden }) {
  const root = mkdtempSync(join(tmpdir(), 'terminal-lane-reach-'));
  const differences = [];
  try {
    const E2EE = await here('apps/desktop/src/shared/remote-e2ee.ts');
    const { connect, sessionReducer } = await here('packages/protocol-client/src/index.ts');
    const { createWsConnector } = await here('apps/desktop/src/main/protocol/ws-connector.ts');
    globalThis.window ??= { setTimeout: () => 0, clearTimeout() {} };
    const { createProtocolRouter } = await here('apps/desktop/src/renderer/remote-shim-protocol.ts');
    const { adapter } = await here('apps/desktop/src/renderer/remote-protocol-terminal.ts');
    const { createLaneFeeds } = await here('apps/mobile/src/phone-lanes.ts');
    const base = (connector, kind, name) => ({
      target: { id: 'core' },
      connector,
      clientInfo: { name, title: name, version: '1.4.5', kind },
      capabilities: { optOutNotificationMethods: [], experimentalApi: false },
      threadReducer: sessionReducer,
      clock: { sleep: () => Promise.reject(new Error('the replay dropped its connection')) },
      random: Math.random,
    });
    for (const [n, recorded] of golden.worlds.entries()) {
      const relay = await startRelay(E2EE);
      const clients = [];
      const profile = join(root, `profile-${n}`);
      const env = isolatedProfile(profile);
      assertNoPowerShellProfile({ ...process.env, ...env });
      const cwd = join(root, `cwd-${n}`);
      mkdirSync(cwd, { recursive: true });
      relay.world(recorded.relayConfirms, Object.values(LANE_REACH_CREDENTIALS));
      const core = await startCore(exe, join(root, `core-${n}`), relay, true, env);
      try {
        await relay.leg();
        const desktop = await within(connect(base(createWsConnector(async () => core.endpoint), 'desktop', 'mixdog-replay-desktop')), 'the desktop connection');
        clients.push(desktop);
        const ask = (method, params) => within(desktop.call(method, params), `the core's answer to the desktop's ${method}`);
        let opId = 0;
        const op = () => `018f0000-0000-7000-8000-${(n * 1000 + ++opId).toString(16).padStart(12, '0')}`;
        const pairing = E2EE.relayE2EEPairingMaterial(JSON.parse(readFileSync(join(core.dataDir, 'relay-e2ee.json'), 'utf8')));
        const waiters = new Set();
        const changed = () => waiters.forEach((look) => look());
        const until = (predicate, what) =>
          within(
            new Promise((resolve) => {
              const look = () => predicate() && (waiters.delete(look), resolve());
              waiters.add(look);
              look();
            }),
            what
          );
        /** A phone reading the terminal lane: its adapter, its lanes, and the text each tab's output gave its page. */
        const openPhone = async (name, credential) => {
          const { connector, phone } = await relay.openPhone(`${name}-${n}`, credential, pairing);
          const client = await within(connect(base(connector, 'phone', 'mixdog-phone')), `the phone ${name}'s connection`);
          clients.push(client);
          // The lanes' subscriptions, so the replay goes on once the core has answered them (the recording waited for `setRemoteLanes`'s answer).
          const subscribed = [];
          const call = client.call.bind(client);
          client.call = (method, params) => {
            const answer = call(method, params);
            if (method === 'feed/subscribe') subscribed.push(answer);
            return answer;
          };
          const lanes = createLaneFeeds(client);
          const text = {};
          const ctx = {
            activeLanes: new Set(['terminal']),
            termListeners: new Set([(event) => ((text[event.id] = (text[event.id] ?? '') + event.data), changed())]),
            termActivityListeners: new Set(),
            termSizeOwnerListeners: new Set(),
            folderChangeListeners: new Set(),
            terminalRunListeners: new Set(),
            fanOut: (listeners, value) => listeners.forEach((listener) => listener(value)),
            phone: { start: async () => undefined },
          };
          const host = { ctx, client: () => client, declareLane: lanes.declare, onClient: (listener) => (listener(client), () => undefined) };
          const router = createProtocolRouter([adapter], { host, started: async () => undefined, synced: async () => undefined, probe() {}, silentSince: () => false });
          router.install();
          lanes.use(['terminal']);
          await within(Promise.all(subscribed), `the phone ${name}'s lane subscriptions`);
          return { router, phone, text: (tab) => text[tab] ?? '' };
        };
        const p1 = await openPhone('p1', LANE_REACH_CREDENTIALS.p1);
        const p2 = await openPhone('p2', LANE_REACH_CREDENTIALS.p2);
        const both = (tab, seen) => until(() => [p1, p2].every((phone) => phone.text(tab).includes(seen)), `both phones to get ${seen} on ${tab}`);
        const reach = async (tab, seen) => {
          // The desktop's attach answers the tab's replay buffer, Node's `termSnapshot` text.
          const { replay } = await ask('terminal/attach', { tabId: tab });
          return { p1: reachOf(replay, p1.text(tab), seen), p2: reachOf(replay, p2.text(tab), seen) };
        };

        await ask('terminal/ensure', { tabId: LANE_REACH_TABS.desktop, options: { cwd } });
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.desktop, data: LANE_REACH_MARKS.desktop.typed });
        await both(LANE_REACH_TABS.desktop, LANE_REACH_MARKS.desktop.seen);
        const desktopTab = await reach(LANE_REACH_TABS.desktop, LANE_REACH_MARKS.desktop.seen);

        await within(p2.router.call('termEnsure', [LANE_REACH_TABS.phone, cwd, null]), "the answer to the second phone's termEnsure");
        p2.router.fire('termWrite', [LANE_REACH_TABS.phone, LANE_REACH_MARKS.phone.typed]);
        await both(LANE_REACH_TABS.phone, LANE_REACH_MARKS.phone.seen);
        const phoneTab = await reach(LANE_REACH_TABS.phone, LANE_REACH_MARKS.phone.seen);

        await ask('remoteAccess/revokeClient', { opId: op(), clientId: LANE_REACH_CREDENTIALS.p1 }).catch(() => undefined);
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.desktop, data: LANE_REACH_MARKS.unpair.typed });
        const seen = LANE_REACH_MARKS.unpair.seen;
        await until(() => p2.text(LANE_REACH_TABS.desktop).includes(seen), `the second phone to get ${seen}`);
        // Node's unpaired phone got it (its frame went with the second phone's); one that did not is read once a call of it is answered.
        const got = recorded.unpair.unpairedPhoneGotOutput
          ? await until(() => p1.text(LANE_REACH_TABS.desktop).includes(seen), `the unpaired phone to get ${seen}, as Node's did`).then(() => true, () => false)
          : await within(p1.router.call('termProfiles', []), "the answer to the unpaired phone's termProfiles").then(() => p1.text(LANE_REACH_TABS.desktop).includes(seen));
        const unpair = { unpairedPhoneGotOutput: got, desktopClosedUnpairedPhone: p1.phone.closedByDesktop };
        for (const tab of Object.values(LANE_REACH_TABS)) await ask('terminal/dispose', { tabId: tab });
        const replayed = { name: recorded.name, relayConfirms: recorded.relayConfirms, desktopTab, phoneTab, unpair };
        if (!isDeepStrictEqual(replayed, recorded)) differences.push(`${recorded.name}: Node ${JSON.stringify(recorded)}, core ${JSON.stringify(replayed)}`);
      } finally {
        for (const client of clients) client.close?.();
        relay.close();
        await endCore(core);
      }
    }
    return differences;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
