// The replay of record-terminal-lane-reach.mjs against a built mixdogd (`--features "terminal-lease-clock replay-controls"`): per recorded
// world a freshly started core whose tabs run the framed scripted shell (MIXDOG_TERMINAL_SCRIPTED_SHELL, the program Node's recording ran in
// place of node-pty, one whole frame per output) and that dials a scripted relay, a desktop connection (loopback) that opens tabs and types into them, and three paired phones
// behind the relay, each the page's own terminal adapter (apps/desktop/src/renderer/remote-protocol-terminal.ts) and lane feeds
// (apps/mobile/src/phone-lanes.ts) over its protocol client. The same steps as the recording, with the same waits; each phone's
// termData, termActivity and termSizeOwner events are recorded the recording's way, in one order, and each world is compared whole with Node's.
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { REPO_ROOT } from './common.mjs';
import { endCore } from './core-stop.mjs';
import { exact } from './exact.mjs';
import { startCore } from './phone-files-replay.mjs';
import { assertNoPowerShellProfile, isolatedProfile } from './shell-isolation.mjs';
import {
  CONTROLS,
  CONTROLS_ESCAPED,
  DANGLING_LEAD,
  FILL_BYTES,
  LANE_REACH_CREDENTIALS,
  SPLIT_CHARS,
  SPLIT_CHARS_TEXT,
  LANE_REACH_TABS,
  MARK_DONE,
  MARK_START,
  chunks,
  echoed,
  fill,
  filled,
  normaliseKilledExit,
  pushesOf,
  typed,
} from './terminal-lane-reach.mjs';

/** The terminal lane's feed (remote-protocol-terminal.ts LANE_FEED): its `process/outputDelta` frames are the phone's termData. */
const LANE_FEED = 'process:relay';

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
      /** The envelope `droppable` of each terminal lane output frame, in order. */
      laneDroppable: [],
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
            receiving = receiving.then(async () => {
              const message = await channel.decryptJson(frame.data);
              if (message?.method === 'process/outputDelta' && message?.feed?.id === LANE_FEED) phone.laneDroppable.push(frame.droppable);
              sink.frame(JSON.stringify(message));
            });
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
      const core = await startCore(exe, join(root, `core-${n}`), relay, true, { ...env, MIXDOG_TERMINAL_SCRIPTED_SHELL: '1' });
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
        /** A phone: its adapter, its lanes, and every terminal-lane event its page got (the recording's `got`). */
        const openPhone = async (name, credential) => {
          const { connector, phone } = await relay.openPhone(`${name}-${n}`, credential, pairing);
          const client = await within(connect(base(connector, 'phone', 'mixdog-phone')), `the phone ${name}'s connection`);
          clients.push(client);
          // The page's view attach (apps/mobile/src/phone-view.ts): the app feed, whose terminalActivity and terminalTabs sections the
          // adapter turns into termActivity and termSizeOwner.
          await within(client.subscribeApp(), `the phone ${name}'s app subscription`);
          // The lanes' (un)subscriptions, so a lane change goes on once the core has answered it (the recording waited for `setRemoteLanes`'s answer).
          let pending = [];
          const call = client.call.bind(client);
          client.call = (method, params) => {
            const answer = call(method, params);
            if (method === 'feed/subscribe' || method === 'feed/unsubscribe') pending.push(answer);
            return answer;
          };
          const lanes = createLaneFeeds(client);
          const pushes = [];
          let data = 0;
          const record = (event) => (payload) => {
            pushes.push(event === 'termData' ? { event, payload, droppable: phone.laneDroppable[data++] } : { event, payload });
            changed();
          };
          const ctx = {
            activeLanes: new Set(),
            termListeners: new Set([record('termData')]),
            termActivityListeners: new Set([record('termActivity')]),
            termSizeOwnerListeners: new Set([record('termSizeOwner')]),
            folderChangeListeners: new Set(),
            terminalRunListeners: new Set(),
            fanOut: (listeners, value) => listeners.forEach((listener) => listener(value)),
            phone: { start: async () => undefined },
          };
          const host = { ctx, client: () => client, declareLane: lanes.declare, onClient: (listener) => (listener(client), () => undefined) };
          const router = createProtocolRouter([adapter], { host, started: async () => undefined, synced: async () => undefined, probe() {}, silentSince: () => false });
          router.install();
          return {
            router,
            phone,
            pushes,
            data: () => data,
            /** The page's `setRemoteLanes`: the lanes it reads now (remote-shim-phone.ts publishLanes). */
            async lanes(read) {
              if (read) ctx.activeLanes.add('terminal');
              else ctx.activeLanes.delete('terminal');
              lanes.use(ctx.activeLanes);
              const answers = pending;
              pending = [];
              await within(Promise.all(answers), `the phone ${name}'s lane ${read ? 'subscription' : 'unsubscription'}`);
            },
            text: (tab) =>
              pushesOf(pushes, 'termData', tab)
                .map((entry) => entry.payload.data)
                .join(''),
          };
        };
        const all = { p1: await openPhone('p1', LANE_REACH_CREDENTIALS.p1), p2: await openPhone('p2', LANE_REACH_CREDENTIALS.p2), p3: await openPhone('p3', LANE_REACH_CREDENTIALS.p3) };
        const reading = new Set();
        const lanes = async (name, read) => {
          await all[name].lanes(read);
          if (read) reading.add(name);
          else reading.delete(name);
        };
        const barrier = (name) => within(all[name].router.call('termProfiles', []), `the answer to ${name}'s termProfiles`);
        /** The recording's `reachedWhen`: `holds` for every phone reading the lane; each other phone has had a call answered after. */
        const reachedWhen = async (holds, what) => {
          await until(() => [...reading].every((name) => holds(all[name])), `${[...reading].join(', ')} to get ${what}`);
          for (const name of Object.keys(all)) if (!reading.has(name)) await barrier(name);
        };
        const reached = (tab, text) => reachedWhen((phone) => phone.text(tab).includes(text), `${JSON.stringify(text)} on ${tab}`);
        const pushed = (kind, tab, wanted, what) => reachedWhen((phone) => pushesOf(phone.pushes, kind, tab).some((push) => wanted(push.payload)), what);
        const desktopTypes = async (tab, line) => {
          desktop.notify('terminal/input', { tabId: tab, data: typed(line) });
          await reached(tab, echoed(line));
        };
        const EXITED = '[process exited with code';
        await lanes('p1', true);
        await lanes('p2', true);
        await lanes('p3', false);

        await ask('terminal/ensure', { tabId: LANE_REACH_TABS.desktop, options: { cwd } });
        await desktopTypes(LANE_REACH_TABS.desktop, 'lane-desk-1');

        await within(all.p2.router.call('termEnsure', [LANE_REACH_TABS.phone, cwd, null]), "the answer to p2's termEnsure");
        all.p2.router.fire('termWrite', [LANE_REACH_TABS.phone, typed('lane-ph-1')]);
        await reached(LANE_REACH_TABS.phone, echoed('lane-ph-1'));

        await lanes('p2', false);
        await desktopTypes(LANE_REACH_TABS.desktop, 'lane-desk-2');
        await lanes('p2', true);
        await desktopTypes(LANE_REACH_TABS.desktop, 'lane-desk-3');

        await lanes('p3', true);
        await desktopTypes(LANE_REACH_TABS.desktop, 'lane-desk-4');

        await ask('terminal/ensure', { tabId: LANE_REACH_TABS.ends, options: { cwd } });
        await desktopTypes(LANE_REACH_TABS.ends, 'lane-end-1');
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.ends, data: typed('@exit 3') });
        await reached(LANE_REACH_TABS.ends, EXITED);
        await ask('terminal/dispose', { tabId: LANE_REACH_TABS.ends });
        for (const name of Object.keys(all)) await barrier(name);

        await ask('terminal/ensure', { tabId: LANE_REACH_TABS.command, options: { cwd } });
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.command, data: chunks(MARK_START, 'lane-cmd-1\\nlane-cmd-2\\n', MARK_DONE) });
        await reached(LANE_REACH_TABS.command, 'lane-cmd-1\r\nlane-cmd-2\r\n');
        await pushed('termActivity', LANE_REACH_TABS.command, (payload) => payload.state === 'finished', 'the command tab finished');
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.command, data: typed('@exit 0') });
        await reached(LANE_REACH_TABS.command, EXITED);
        await ask('terminal/dispose', { tabId: LANE_REACH_TABS.command });
        for (const name of Object.keys(all)) await barrier(name);

        await ask('terminal/ensure', { tabId: LANE_REACH_TABS.split, options: { cwd } });
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.split, data: chunks('lane-sp', 'lit\\n') });
        await reached(LANE_REACH_TABS.split, 'lane-split\r\n');
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.split, data: typed('@exit 0') });
        await reached(LANE_REACH_TABS.split, EXITED);
        await ask('terminal/dispose', { tabId: LANE_REACH_TABS.split });
        for (const name of Object.keys(all)) await barrier(name);

        await ask('terminal/ensure', { tabId: LANE_REACH_TABS.bytes, options: { cwd } });
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.bytes, data: chunks(CONTROLS_ESCAPED) });
        await reached(LANE_REACH_TABS.bytes, CONTROLS);
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.bytes, data: chunks('') });
        await desktopTypes(LANE_REACH_TABS.bytes, 'lane-after-empty');
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.bytes, data: fill(FILL_BYTES) });
        await reached(LANE_REACH_TABS.bytes, filled(FILL_BYTES));
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.bytes, data: typed('@exit 0') });
        await reached(LANE_REACH_TABS.bytes, EXITED);
        await ask('terminal/dispose', { tabId: LANE_REACH_TABS.bytes });
        for (const name of Object.keys(all)) await barrier(name);

        await ask('terminal/ensure', { tabId: LANE_REACH_TABS.chars, options: { cwd } });
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.chars, data: SPLIT_CHARS });
        await reached(LANE_REACH_TABS.chars, SPLIT_CHARS_TEXT);
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.chars, data: typed('@exit 0') });
        await reached(LANE_REACH_TABS.chars, EXITED);
        await ask('terminal/dispose', { tabId: LANE_REACH_TABS.chars });
        for (const name of Object.keys(all)) await barrier(name);

        await ask('terminal/ensure', { tabId: LANE_REACH_TABS.tail, options: { cwd } });
        desktop.notify('terminal/input', { tabId: LANE_REACH_TABS.tail, data: DANGLING_LEAD + typed('@exit 0') });
        await reached(LANE_REACH_TABS.tail, EXITED);
        await ask('terminal/dispose', { tabId: LANE_REACH_TABS.tail });
        for (const name of Object.keys(all)) await barrier(name);

        all.p2.router.fire('termResize', [LANE_REACH_TABS.desktop, 100, 30, true]);
        await pushed('termSizeOwner', LANE_REACH_TABS.desktop, (payload) => payload.cols === 100, "p2's size claim");
        all.p2.router.fire('termResize', [LANE_REACH_TABS.desktop, 0, 0, true]);
        await pushed('termSizeOwner', LANE_REACH_TABS.desktop, (payload) => payload.cols === 0, "p2's release of the size");

        all.p2.router.fire('termWrite', [LANE_REACH_TABS.phone, typed('lane-ph-2')]);
        await reached(LANE_REACH_TABS.phone, echoed('lane-ph-2'));
        await within(all.p2.router.call('termDispose', [LANE_REACH_TABS.phone]), "the answer to p2's termDispose");
        await reached(LANE_REACH_TABS.phone, EXITED);
        for (const name of Object.keys(all)) await barrier(name);

        await ask('remoteAccess/revokeClient', { opId: op(), clientId: LANE_REACH_CREDENTIALS.p1 }).catch(() => undefined);
        reading.delete('p1');
        await desktopTypes(LANE_REACH_TABS.desktop, 'lane-desk-5');

        const phones = normaliseKilledExit(
          Object.fromEntries(Object.entries(all).map(([name, phone]) => [name, { pushes: exact(phone.pushes), closedByDesktop: exact(phone.phone.closedByDesktop) }])),
          LANE_REACH_TABS.phone
        );
        for (const [name, phone] of Object.entries(all)) {
          if (phone.phone.laneDroppable.length !== phone.data()) {
            differences.push(`${recorded.name}: ${name} got ${phone.phone.laneDroppable.length} terminal lane output frame(s) for ${phone.data()} termData event(s)`);
          }
        }
        await ask('terminal/dispose', { tabId: LANE_REACH_TABS.desktop });
        const replayed = { name: recorded.name, relayConfirms: recorded.relayConfirms, phones };
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
