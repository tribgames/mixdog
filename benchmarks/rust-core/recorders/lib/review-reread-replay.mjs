// What the windows of THIS checkout do when the core tells them to read their reviews again: the replay half of
// `record-turn-review-signal.mjs`, through the production delivery path and nothing substituted but the socket:
//
//   the core's app-feed frames (`app/snapshot`, then each `review/diff/updated`)
//   -> the window's own client of the core (`packages/protocol-client`, `connect`, over a mock connector)
//   -> the renderer's connection to the core (`createRendererConnection`) and its `sections` API (`createSectionsApi`)
//   -> the renderer's section store and the `TurnReviewBar` panes.
//
// Every window of an Electron app has its own connection to the core, as a phone page has: nothing is relayed through the main
// process, so each window folds each tell itself and a pane reads when its own store says the review changed. A pane may read
// fewer times than in Node when tells reach it together (checked by the Rust test as a burst). A `coreReconnect` operation drops
// the desktop windows' connections and dials again with the core's snapshot as it is then. Windows attach in the order the
// recording opened them and panes mount in its order.
//
//   node --import <test-env> --import <test-tsx> review-reread-replay.mjs <checkout> <input.json>
//
// The input comes from the Rust test: the app feed's snapshot frame and, per operation, the deliveries the core made (each the
// frames it published) and after how many answered requests each was made. The requests the bars send are answered with the
// answers Node's recording holds for the same request; one the recording lacks fails the replay by name. Every wait has a
// deadline and names what it waited for. The output is the trace per operation.
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReviewWindows, loadWindowKit } from './review-windows.mjs';

const [tree, inputPath] = process.argv.slice(2);
if (!tree || !inputPath) throw new Error('usage: review-reread-replay.mjs <checkout> <input.json>');
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const fromTree = (rel) => import(pathToFileURL(join(tree, rel)).href);
// The checkout's own protocol package: a workspace link in node_modules may point at another checkout's copy, and the client
// library reads its method table (which notifications are section updates) from it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@mixdog/protocol') return { url: pathToFileURL(join(tree, 'packages/protocol/src/index.ts')).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const kit = await loadWindowKit(tree);
const { connect, sessionReducer, MockNetwork } = await fromTree('packages/protocol-client/src/index.ts');
const { createRendererConnection } = await fromTree('apps/desktop/src/renderer/core-direct/renderer-connection.ts');
const { createDirectContext } = await fromTree('apps/desktop/src/renderer/core-direct/context.ts');
const { createSectionsApi } = await fromTree('apps/desktop/src/renderer/core-direct/sections.ts');
const { createPhoneSections } = await fromTree('apps/mobile/src/phone-sections.ts');
const { sectionsSourceFromFoldStore } = await fromTree('apps/desktop/src/renderer/section-store.ts');
const options = JSON.parse(readFileSync(join(tree, 'packages/protocol-client/conformance/options.json'), 'utf8'));

const DEADLINE_MS = 30_000;
/** A wait that fails by name instead of hanging; the timer is only the failure path. */
const within = (what, wait) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not happen within ${DEADLINE_MS} ms`)), DEADLINE_MS);
    wait.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error))
    );
  });

const canonical = (value) => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));

let unanswered = [];
let where = '';
// What the replay alone can measure, per answered request in the order the windows asked: how many review frames the connection of
// the asking window had folded when the pane invoked the read (not when the read was answered).
let toldAtRead = [];
// The device (the window, with its own connection to the core) each session's pane belongs to.
const deviceOf = new Map();
const counts = new Map();
const windows = new ReviewWindows(kit, async ({ session, request, told }) => {
  const at = unanswered.findIndex((recorded) => recorded.client === session && canonical(recorded.request) === canonical(request));
  if (at < 0) throw new Error(`the window of ${session} asked ${canonical(request)}, which the recording never saw at this point (${where}; recorded for this operation: ${unanswered.map((r) => r.client + ' ' + canonical(r.request.args)).join(' | ')})`);
  toldAtRead.push(told);
  return unanswered.splice(at, 1)[0].answer;
}, (session) => counts.get(deviceOf.get(session)) ?? 0);

// The renderer's sections API hands a burst of store changes to the panes in one push, drained from a zero-delay timer (sections.ts
// `schedule`): a tick lets that timer run, inside `act` so the panes' effects are flushed with it.
const tick = () => kit.act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

/** A count that can be waited on: `reach(n)` settles once `bump` has made it at least `n`. */
const counter = () => {
  let n = 0;
  const waiting = [];
  return {
    get n() {
      return n;
    },
    bump() {
      n += 1;
      for (const check of waiting.splice(0)) check();
    },
    reach: (target) =>
      new Promise((resolve) => {
        const check = () => (n >= target ? resolve() : waiting.push(check));
        check();
      }),
  };
};

// Every window of the app has its own connection to the core: the socket is the only stand-in. The renderer's connection
// (`createRendererConnection`) opens the client and subscribes the app feed itself; a phone page is the client library over its
// own mock connector and subscribes by itself (phone-view.ts `attach`).
const handshake = async (conn, first) => {
  const initialize = JSON.parse(await within('the client sending initialize', conn.nextSent()));
  conn.serverSend({ id: initialize.id, result: { ...options.initializeResult, serverInstanceId: first ? 'replay' : 'replay-again' } });
  await within('the client sending initialized', conn.nextSent());
};
const readSubscribe = async (conn) => JSON.parse(await within('the client sending app/subscribe', conn.nextSent()));
/** The core accepts the app subscription on `sock` with `snapshot` (the core's own snapshot frame, whole). */
const attachApp = async (sock, snapshot, first) => {
  await handshake(sock, first);
  const subscribe = await readSubscribe(sock);
  const feed = snapshot.feed;
  sock.serverSend({ id: subscribe.id, result: { subscription: { id: 'app', mode: 'snapshot', epoch: feed.epoch, startSeq: feed.seq + 1 } } });
  sock.serverSend(snapshot);
};


// Every connection that frames of the core reach: one per Electron window and one per phone page ("devices", named by their window).
// A frame goes to a live device only if the device's snapshot did not already hold it, in the order the devices were made.
const devices = new Map();
const clientOf = (name) => ({
  target: { id: 'core' },
  connector: devices.get(name).net,
  clientInfo: options.clientInfo,
  capabilities: options.capabilities,
  threadReducer: sessionReducer,
  // A reconnect's ladder wait is the only sleep; it ends at once so the reconnect is driven by the frames alone.
  clock: { sleep: () => Promise.resolve() },
  random: () => options.jitterUnit,
});
/** A device's count of review tells folded, raised once its client folded one. */
const watchTells = (device, onStoreChange) =>
  onStoreChange((change) => {
    if (change.type === 'section' && change.section === 'reviewDiff') device.folds.bump();
  });

/** An Electron window: the renderer's connection to the core, and the `sections` API its panes read. */
const connectDesktop = async (name, snapshot) => {
  const device = { kind: 'desktop', net: new MockNetwork(), seq: snapshot.feed.seq, live: true, folds: counter(), socket: null, connection: null, sections: null, client: null };
  devices.set(name, device);
  const connection = createRendererConnection({ open: () => connect(clientOf(name)) });
  device.connection = connection;
  const started = connection.start();
  device.socket = await within(`the window ${name} dialing the core`, device.net.accept());
  await attachApp(device.socket, snapshot, true);
  await within(`the window ${name} folding the core's app snapshot`, Promise.all([started, connection.whenSynced()]));
  watchTells(device, (listener) => connection.onStoreChange(listener));
  device.sections = createSectionsApi(createDirectContext(connection)).sections;
  device.onSnapshot = (listener) => connection.onStoreChange(listener);
  return device;
};

/** A phone page: its own client of the core and the phone's section source (`createPhoneSections`) over that client's fold store. The
 *  page's own events (`mixdog:remote-reconnected`, dispatched by the phone's boot once its leg is synced again) are not part of what is
 *  replayed: the replay raises them the way the recording does. */
const connectPhone = async (name, snapshot) => {
  const device = { kind: 'phone', net: new MockNetwork(), seq: snapshot.feed.seq, live: true, folds: counter(), socket: null, client: null, sections: null };
  devices.set(name, device);
  const connecting = connect(clientOf(name));
  device.socket = await within(`the phone ${name} dialing the core`, device.net.accept());
  // A phone page subscribes to the app feed itself once it is connected (phone-view.ts `attach`), unlike the renderer's connection.
  await handshake(device.socket, true);
  device.client = await within(`the phone ${name} syncing with the core`, connecting);
  const subscribed = device.client.subscribeApp();
  const subscribe = await readSubscribe(device.socket);
  device.socket.serverSend({ id: subscribe.id, result: { subscription: { id: 'app', mode: 'snapshot', epoch: snapshot.feed.epoch, startSeq: snapshot.feed.seq + 1 } } });
  device.socket.serverSend(snapshot);
  await within(`the phone ${name} subscribing to the app feed`, subscribed);
  watchTells(device, (listener) => device.client.store.subscribe(listener));
  device.sections = createPhoneSections({ start: async () => ({ client: device.client }) }, sectionsSourceFromFoldStore);
  device.onSnapshot = (listener) => device.client.store.subscribe(listener);
  return device;
};

/** The core drops the device's connection (the window stays), and later the client dials again with the core's snapshot as it is then. */
const dropDevice = (name) => {
  const device = devices.get(name);
  device.live = false;
  device.socket.serverClose(1006);
};
const reconnectDevice = async (name, snapshot) => {
  const device = devices.get(name);
  const synced = new Promise((resolve) => {
    const stop = device.onSnapshot((change) => {
      if (change.type === 'appSnapshot') (stop(), resolve());
    });
  });
  device.socket = await within(`the window ${name} dialing the core again`, device.net.accept());
  await attachApp(device.socket, snapshot, false);
  device.seq = snapshot.feed.seq;
  device.live = true;
  await within(`the window ${name} folding the core's snapshot`, synced);
  await tick();
};
const desktops = () => [...devices].filter(([, device]) => device.kind === 'desktop').map(([name]) => name);

/** One pane's window: its sections and the one capability the pane reads, answered by the replay's windows. */
const apiOf = (device) => ({ sections: device.sections, invokeCapability: (request) => windows.invoke(request) });
const open = async ({ session, checkpoint, window, kind }, rust) => {
  deviceOf.set(session, window);
  const snapshot = rust.snapshot ?? input.snapshot;
  if (kind === 'phone') {
    if (devices.has(window)) throw new Error(`the phone ${window} is already open`);
    await windows.open({ session, checkpoint, window, api: apiOf(await connectPhone(window, snapshot)) });
    return;
  }
  const device = devices.get(window) ?? (await connectDesktop(window, snapshot));
  await windows.open({ session, checkpoint, window, api: apiOf(device) });
};

/** A composed core's feed also carries sections that are not the subject; only the review tells are counted. */
const isTell = (frame) => frame.method === 'review/diff/updated';

/** Frames sent one after the other to every live device that does not hold them yet, nothing run between them but the client folding
 *  each. A device's count of told frames is raised once its client folded them. */
const deliverFrames = async (frames) => {
  for (const [name, device] of devices) {
    const mine = device.live ? frames.filter((frame) => frame.feed.seq > device.seq) : [];
    if (!mine.length) continue;
    const tells = mine.filter(isTell).length;
    const folded = device.folds.reach(device.folds.n + tells);
    for (const frame of mine) device.socket.serverSend(frame);
    device.seq = mine.at(-1).feed.seq;
    await within(`the window ${name} folding ${tells} review/diff/updated frame(s) (from seq ${mine[0].feed.seq})`, folded);
    counts.set(name, (counts.get(name) ?? 0) + tells);
    await tick();
  }
};

const traces = [];
const told = [];
for (const [index, op] of input.ops.entries()) {
  const rust = input.rust[index];
  const together = input.bursts.includes(index);
  unanswered = [...input.recorded[index].requests];
  where = `op ${index} ${op.op}, ${together ? 'tells together' : 'tells apart'}`;
  windows.startOperation();
  toldAtRead = [];
  counts.clear();
  if (op.op === 'client') await open(op, rust);
  if (op.op === 'phoneLink' && op.state === 'down') dropDevice(op.window);
  if (op.op === 'coreReconnect' || op.coreLinkDown) for (const name of desktops()) dropDevice(name);
  let delivered = 0;
  if (op.coreLinkDown) {
    // The tells the core made while the link was down reach the windows as the one tell their snapshot carries (a newer revision of
    // `reviewDiff` than the store holds), not as frames: Node's deliveries of the operation are that one.
    // An operation with several deliveries is a burst: the pane meets the snapshot's one tell, so it may read fewer times (checked as a burst).
    windows.deliveries += rust.deliveries.length;
    for (const name of desktops()) counts.set(name, rust.deliveries.flat().filter(isTell).length);
    delivered = rust.deliveries.length;
  }
  if (op.op === 'coreReconnect' || op.coreLinkDown) for (const name of desktops()) await reconnectDevice(name, rust.snapshot);
  if (op.op === 'phoneLink' && op.state === 'up') {
    await reconnectDevice(op.window, rust.snapshot);
    await windows.reconnected(op.window);
  }
  await tick();
  const deliverUpTo = async (count) => {
    if (together) {
      if (count <= delivered) return;
      const frames = rust.deliveries.slice(delivered, count).flat();
      windows.deliveries += count - delivered;
      delivered = count;
      if (frames.length) await deliverFrames(frames);
      return;
    }
    while (delivered < count) {
      windows.deliveries += 1;
      for (const frame of rust.deliveries[delivered++]) await deliverFrames([frame]);
    }
  };
  await deliverUpTo(together ? rust.deliveries.length : rust.before);
  await windows.settle(async (answered) => deliverUpTo(rust.afterAnswer[answered - 1] ?? delivered));
  // Deliveries the windows' answers did not wait for (a window that asked less than the recording): they still reach the windows.
  await deliverUpTo(rust.deliveries.length);
  await windows.settle();
  traces.push({ op: index, ...windows.trace() });
  told.push(toldAtRead);
}
await windows.close();
for (const device of devices.values()) await (device.connection ? device.connection.close() : device.client.close());
// The client library's liveness ticker would keep the process open; the trace is written, so leave once it is flushed.
process.stdout.write(JSON.stringify({ traces, told }), () => process.exit(0));