// What the windows of THIS checkout do when the core tells them to read their reviews again: the replay half of
// `record-turn-review-signal.mjs`, through the production delivery path and nothing substituted but the socket:
//
//   the core's app-feed frames (`app/snapshot`, then each `review/diff/updated`)
//   -> the client library over its mock connector (`packages/protocol-client`, `connect`)
//   -> the main process's `createProtocolConnection` (its section relay, one push per change)
//   -> each window's `registerProtocolWindowIpc` -> that window's preload (the checkout's own file, bundled and run per window)
//   -> the renderer's section store and the `TurnReviewBar` panes.
//
// The relay runs with its production scheduling. Tells that are apart (the default: each is folded, flushed and rendered before
// the next) reach the panes as the separate pushes they are. Tells of an operation listed in `input.bursts` are sent before any
// is flushed, so the relay may hand them to the windows as one push: the Rust test states what that may change. A
// `coreReconnect` operation drops the connection and dials again with the core's snapshot as it is then. Windows attach in the
// order the recording opened them and panes mount in its order.
//
//   node --import <test-env> --import <test-tsx> review-reread-replay.mjs <checkout> <input.json>
//
// The input comes from the Rust test: the app feed's snapshot frame and, per operation, the deliveries the core made (each the
// frames it published) and after how many answered requests each was made. The requests the bars send are answered with the
// answers Node's recording holds for the same request; one the recording lacks fails the replay by name. Every wait has a
// deadline and names what it waited for. The output is the trace per operation.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
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
const { createProtocolConnection } = await fromTree('apps/desktop/src/main/protocol/connection.ts');
const { registerProtocolWindowIpc } = await fromTree('apps/desktop/src/main/protocol/window-ipc.ts');
const { createPhoneSections } = await fromTree('apps/mobile/src/phone-sections.ts');
const { sectionsSourceFromFoldStore } = await fromTree('apps/desktop/src/renderer/section-store.ts');
const { DESKTOP_IPC } = await fromTree('apps/desktop/src/shared/contract.ts');
const { SECTIONS_IPC } = await fromTree('apps/desktop/src/shared/contract-sections.ts');
const { build } = await import(pathToFileURL(createRequire(join(tree, 'apps/desktop/package.json')).resolve('esbuild')).href);
const preload = (await build({ entryPoints: [join(tree, 'apps/desktop/src/preload/index.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'] })).outputFiles[0].text;
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
// The device (the Electron windows share the desktop's connection; a phone page has its own) each session's pane belongs to.
const deviceOf = new Map();
const counts = new Map();
const windows = new ReviewWindows(kit, async ({ session, request, told }) => {
  const at = unanswered.findIndex((recorded) => recorded.client === session && canonical(recorded.request) === canonical(request));
  if (at < 0) throw new Error(`the window of ${session} asked ${canonical(request)}, which the recording never saw at this point (${where}; recorded for this operation: ${unanswered.map((r) => r.client + ' ' + canonical(r.request.args)).join(' | ')})`);
  toldAtRead.push(told);
  return unanswered.splice(at, 1)[0].answer;
}, (session) => counts.get(deviceOf.get(session)) ?? 0);

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

// The desktop's connection to the core: the socket is the only stand-in. The relay runs with its production scheduling
// (`setImmediate`): whatever reaches it before that callback is one push, whatever reaches it after is another. `relayTick` lets
// the callbacks queued so far run (the relay's was queued first), inside `act` so the panes' effects are flushed with it.
const network = new MockNetwork();
const connection = createProtocolConnection({
  open: () =>
    connect({
      target: { id: 'core' },
      connector: network,
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
      threadReducer: sessionReducer,
      // A reconnect's ladder wait is the only sleep; it ends at once so the reconnect is driven by the frames alone.
      clock: { sleep: () => Promise.resolve() },
      random: () => options.jitterUnit,
    }),
});
const relayTick = () => kit.act(async () => void (await new Promise((resolve) => setImmediate(resolve))));

// A window that only watches what main pushes: it counts the pushes that carry a `reviewDiff` change and tells when a replace of
// the whole store has been committed (the relay's chunks are one deferral each, so that is an event, not a number of ticks).
let pushes = 0;
let commitWaiters = [];
const awaitCommit = () => new Promise((resolve) => commitWaiters.push(resolve));
registerProtocolWindowIpc({
  connection,
  handle: () => {},
  send: (channel, push) => {
    if (channel !== SECTIONS_IPC.push) return true;
    if (push.kind === 'sections' && push.changes.some((change) => change.section === 'reviewDiff')) pushes += 1;
    if (push.kind === 'replace' && push.stage === 'commit') {
      for (const resolve of commitWaiters.splice(0)) resolve();
    }
    return true;
  },
  removeHandler: () => {},
});
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

// Every connection that frames of the core reach: the desktop's (all its windows share it) and one per phone page. A frame goes to
// a live connection only if the connection's snapshot did not already hold it, and in the order the connections were made.
const main = { socket: null, seq: 0, live: true, folds: counter() };
const started = connection.start();
main.socket = await within('the client dialing the core', network.accept());
await attachApp(main.socket, input.snapshot, true);
main.seq = input.snapshot.feed.seq;
await within('the connection folding the core\'s app snapshot', Promise.all([started, connection.whenSynced()]));
connection.watchSection('reviewDiff', () => main.folds.bump());
await relayTick();

/** The core drops the desktop's connection (the windows stay), and later the client dials again; the core answers with its snapshot as it is then. */
const dropMain = () => {
  main.live = false;
  main.socket.serverClose(1006);
};
const reconnectMain = async (snapshot) => {
  const committed = awaitCommit();
  main.socket = await within('the client dialing the core again', network.accept());
  await attachApp(main.socket, snapshot, false);
  main.seq = snapshot.feed.seq;
  main.live = true;
  await within('the relay committing the replaced store', committed);
  await relayTick();
};

// A phone page: its own client of the core, the phone's section source (`createPhoneSections`) over that client's fold store, and no
// relay in between. The page's own events (`mixdog:remote-reconnected`, dispatched by the phone's boot once its leg is synced again)
// are not part of what is replayed: the replay raises them the way the recording does.
const phones = new Map();
const connectPhone = async (name, snapshot) => {
  const net = new MockNetwork();
  const connecting = connect({
    target: { id: 'core' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => options.jitterUnit,
  });
  const phone = { net, socket: await within(`the phone ${name} dialing the core`, net.accept()), seq: snapshot.feed.seq, live: true, folds: counter(), client: null };
  // A phone page subscribes to the app feed itself once it is connected (phone-view.ts `attach`), unlike the desktop connection.
  await handshake(phone.socket, true);
  phone.client = await within(`the phone ${name} syncing with the core`, connecting);
  const subscribed = phone.client.subscribeApp();
  const subscribe = await readSubscribe(phone.socket);
  phone.socket.serverSend({ id: subscribe.id, result: { subscription: { id: 'app', mode: 'snapshot', epoch: snapshot.feed.epoch, startSeq: snapshot.feed.seq + 1 } } });
  phone.socket.serverSend(snapshot);
  await within(`the phone ${name} subscribing to the app feed`, subscribed);
  phone.client.store.subscribe((change) => {
    if (change.type === 'section' && change.section === 'reviewDiff') phone.folds.bump();
  });
  phones.set(name, phone);
  return phone;
};
const dropPhone = (name) => {
  const phone = phones.get(name);
  phone.live = false;
  phone.socket.serverClose(1006);
};
const reconnectPhone = async (name, snapshot) => {
  const phone = phones.get(name);
  const synced = new Promise((resolve) => {
    const stop = phone.client.store.subscribe((change) => {
      if (change.type === 'appSnapshot') (stop(), resolve());
    });
  });
  phone.socket = await within(`the phone ${name} dialing the core again`, phone.net.accept());
  await attachApp(phone.socket, snapshot, false);
  phone.seq = snapshot.feed.seq;
  phone.live = true;
  await within(`the phone ${name} folding the core's snapshot`, synced);
  await kit.act(async () => {});
};
const phoneApi = (phone) => ({
  sections: createPhoneSections({ start: async () => ({ client: phone.client }) }, sectionsSourceFromFoldStore),
  invokeCapability: (request) => windows.invoke(request),
});

/** One window of the connection per recorded window name: its IPC, its handlers and its preload. */
const appWindows = new Map();
const attachWindow = (name) => {
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.send = () => {};
  ipc.invoke = (channel, ...args) => {
    if (channel === DESKTOP_IPC.invokeCapability) return windows.invoke(args[0]);
    return Promise.resolve().then(() => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`the window ${name} invoked ${channel}, which main does not handle`);
      return handler({}, ...args);
    });
  };
  registerProtocolWindowIpc({
    connection,
    handle: (channel, handler) => handlers.set(channel, handler),
    send: (channel, value) => ipc.emit(channel, {}, value),
    removeHandler: (channel) => handlers.delete(channel),
  });
  let api;
  runInNewContext(preload, {
    process: { argv: [], env: {} },
    window: { addEventListener() {} },
    require: (specifier) => {
      if (specifier !== 'electron') throw new Error(`the preload required ${specifier}`);
      return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => (api = value) }, sharedTexture: { setSharedTextureReceiver() {} }, webUtils: {} };
    },
  });
  return api;
};
const open = async ({ session, checkpoint, window, kind }, rust) => {
  deviceOf.set(session, kind === 'phone' ? window : 'desktop');
  if (kind === 'phone') {
    if (phones.has(window)) throw new Error(`the phone ${window} is already open`);
    await windows.open({ session, checkpoint, window, api: phoneApi(await connectPhone(window, rust.snapshot)) });
    return;
  }
  if (!appWindows.has(window)) appWindows.set(window, attachWindow(window));
  await windows.open({ session, checkpoint, window, api: appWindows.get(window) });
};

/** A composed core's feed also carries sections that are not the subject; only the review tells are counted. */
const isTell = (frame) => frame.method === 'review/diff/updated';

/** Frames sent one after the other to every live connection that does not hold them yet, nothing run between them but the client
 *  folding each; the desktop's relay flushes once after the last. A device's count of told frames is raised once its client folded them. */
const deliverFrames = async (frames) => {
  const fresh = main.live ? frames.filter((frame) => frame.feed.seq > main.seq) : [];
  if (fresh.length) {
    const tells = fresh.filter(isTell).length;
    const folded = main.folds.reach(main.folds.n + tells);
    for (const frame of fresh) main.socket.serverSend(frame);
    main.seq = fresh.at(-1).feed.seq;
    await within(`the client folding ${tells} review/diff/updated frame(s) (from seq ${fresh[0].feed.seq})`, folded);
    counts.set('desktop', (counts.get('desktop') ?? 0) + tells);
    await relayTick();
  }
  for (const [name, phone] of phones) {
    const mine = phone.live ? frames.filter((frame) => frame.feed.seq > phone.seq) : [];
    if (!mine.length) continue;
    const tells = mine.filter(isTell).length;
    const folded = phone.folds.reach(phone.folds.n + tells);
    for (const frame of mine) phone.socket.serverSend(frame);
    phone.seq = mine.at(-1).feed.seq;
    await within(`the phone ${name} folding ${tells} review/diff/updated frame(s) (from seq ${mine[0].feed.seq})`, folded);
    counts.set(name, (counts.get(name) ?? 0) + tells);
    await kit.act(async () => {});
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
  pushes = 0;
  toldAtRead = [];
  counts.clear();
  if (op.op === 'client') await open(op, rust);
  if (op.op === 'phoneLink' && op.state === 'down') dropPhone(op.window);
  if (op.op === 'coreReconnect') dropMain();
  if (op.coreLinkDown) dropMain();
  let delivered = 0;
  if (op.coreLinkDown) {
    // The tells the core made while the link was down reach the desktop as the one tell its snapshot carries (a newer revision of
    // `reviewDiff` than the store holds), not as frames: Node's deliveries of the operation are that one.
    windows.deliveries += Math.min(1, rust.deliveries.length);
    counts.set('desktop', rust.deliveries.flat().filter(isTell).length);
    delivered = rust.deliveries.length;
  }
  if (op.op === 'coreReconnect' || op.coreLinkDown) await reconnectMain(rust.snapshot);
  if (op.op === 'phoneLink' && op.state === 'up') {
    await reconnectPhone(op.window, rust.snapshot);
    await windows.reconnected(op.window);
  }
  await relayTick();
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
  traces.push({ op: index, ...windows.trace(), pushes });
  told.push(toldAtRead);
}
await windows.close();
await connection.close();
// The client library's liveness ticker would keep the process open; the trace is written, so leave once it is flushed.
process.stdout.write(JSON.stringify({ traces, told }), () => process.exit(0));