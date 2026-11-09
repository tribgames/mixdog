#!/usr/bin/env node
// When Node tells a client to read the review again, and what the client then reads (`noteTurnReviewChanged`,
// turn-worktree-snapshot.mjs lines 175, 197, 1416, turn-boundary-signal.mjs).
//
//   node --import <file URL of <tree>/apps/desktop/scripts/test-env.mjs> --import <file URL of <tree>/apps/desktop/scripts/test-tsx.mjs> \
//     benchmarks/rust-core/recorders/record-turn-review-signal.mjs --tree <tree of b6f10295a with node_modules> --patch-bin <mixdog-patch binary>
// (the two preloads are the desktop package's own test setup: the desktop service is TypeScript.)
// Output: native/core/fixtures/turn-review-signal/scenarios.json (the turn scenarios) and listeners.json (the listener registry)
//
// Every trigger runs through the entry point the product uses: the edit and apply_patch tools (their cache invalidation reaches
// `runtime-review-api.mjs`'s listener), the git command tool through `executeTool` (its `finally` notes the settle), the turn
// begin/complete of the turn snapshot, and Undo/Reapply. The desktop's one consumer is the real chain: `desktop-service.ts:1058`
// forwards each delivery as the data-less `turn-review-changed` event to the main process's `DesktopServiceClient`, whose
// desktop events reach each window's `DesktopStateBridge`, which sends them to the window's preload, which `TurnReviewBar`
// (`use-turn-review-reads.ts:292-306`) subscribes to. Each scenario `client` is such a window; what is recorded is what the windows
// do: per operation, how many deliveries were made, every capability request the windows made (which window, after how many
// deliveries, the whole request, the whole answer the runtime's `getTurnReviewDiff` gave) and what each bar shows. The windows
// answer one request at a time, in the order they asked, and an answer may raise the next delivery, a microtask behind it.
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, sha256, stageSet, writeSetManifest, writeText } from './lib/common.mjs';
import { drainDeliveries } from './lib/delivery-wait.mjs';
import { ReviewWindows, loadWindowKit } from './lib/review-windows.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const patchBin = resolve(args.get('patch-bin') ?? '');
if (!args.get('patch-bin')) throw new Error('pass --patch-bin <a mixdog-patch binary built from this checkout>');
process.env.MIXDOG_PATCH_NATIVE_BIN = patchBin;
const work = realpathSync.native(mkdtempSync(join(resolve(args.get('work') ?? tmpdir()), 'turn-review-signal-')));
process.env.GIT_CEILING_DIRECTORIES = work;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const snapshot = await importFrom(tree, 'src/runtime/shared/turn-snapshot.mjs');
const store = await importFrom(tree, 'src/runtime/shared/turn-snapshot-store.mjs');
const worktrees = await importFrom(tree, 'src/runtime/shared/turn-worktree-snapshot.mjs');
const boundary = await importFrom(tree, 'src/runtime/shared/turn-boundary-signal.mjs');
const replyMod = await importFrom(tree, 'src/runtime/shared/turn-review-reply.mjs');
const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const { executePatchTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/patch.mjs');
const { executeTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/loop/tool-exec.mjs');
// Importing it registers the two wirings under test (a command settling, a cache invalidation) exactly as the runtime does.
await importFrom(tree, 'src/session-runtime/runtime-review-api.mjs');

// The desktop app, piece by piece as the product wires it: the service (`createDesktopService`, as its own tests boot it)
// emits to the main process's `DesktopServiceClient`, whose desktop events reach each window's `DesktopStateBridge`, which
// sends them over IPC to that window's preload, which the window's `TurnReviewBar` subscribes to. Only the process and IPC
// boundaries are stand-ins (an event emitter each); every module on either side of them is the product's.
const { createDesktopService } = await importFrom(tree, 'apps/desktop/src/main/desktop-service.ts');
const { viewSyncHost } = await importFrom(tree, 'apps/desktop/src/main/test-support/view-sync-host.mjs');
const { DesktopServiceClient } = await importFrom(tree, 'apps/desktop/src/main/desktop-service-client.ts');
const { DesktopStateBridge } = await importFrom(tree, 'apps/desktop/src/main/ipc-state-bridge.ts');
const { DESKTOP_IPC } = await importFrom(tree, 'apps/desktop/src/shared/contract.ts');
const treeRequire = createRequire(join(tree, 'apps/desktop/package.json'));
const { build } = await import(pathToFileURL(treeRequire.resolve('esbuild')).href);
// The preload is the product's own file, bundled the way its tests load it, and run once per window.
const preload = (
  await build({ entryPoints: [join(tree, 'apps/desktop/src/preload/index.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'] })
).outputFiles[0].text;
const windowKit = await loadWindowKit(tree);

const host = await viewSyncHost();
const transport = new EventEmitter();
transport.postMessage = (message) => {
  if (message.kind === 'init') queueMicrotask(() => transport.emit('message', { kind: 'ready' }));
};
transport.close = async () => {};
const serviceClient = new DesktopServiceClient({ connect: () => transport, sessionOptions: () => ({ userDataPath: work, packaged: false }), startupTimeoutMs: 10_000 });
await serviceClient.start();
// What the running scenario's windows count, and what the service sent during the running operation.
let current = null;
let sent = [];
const service = await createDesktopService({
  options: host.options,
  runtime: { ...host.runtime, loadConfig: async () => ({ readConfig: () => ({}) }) },
  emit: (message) => {
    sent.push(message);
    if (message.kind === 'desktop-event' && message.name === 'turn-review-changed' && current) current.windows.deliveries += 1;
    transport.emit('message', message);
  },
});

const T = (text) => ({ text });
const lines = (...rows) => `${rows.join('\n')}\n`;

async function runScenario(scenario) {
  const dir = mkdtempSync(join(work, 'sc-'));
  const roots = { base: dir, w1: join(dir, 'w1'), w2: join(dir, 'w2'), ng: join(dir, 'plain') };
  for (const root of [roots.w1, roots.w2, roots.ng]) mkdirSync(root, { recursive: true });
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  process.env.MIXDOG_DATA_DIR = data;
  store._setTurnSnapshotStoreRootForTest(join(data, 'turn-snapshots'));
  snapshot._resetTurnSnapshotForTest();
  worktrees._resetTurnWorktreeSnapshotsForTest();
  const tokens = new Map();
  const revisions = new Map();
  // Each client is a window of its own showing one session: its end of the IPC and its bridge in the main process.
  const clients = new Map();
  const results = [];
  const where = (spec) => (spec.path ? join(roots[spec.ws], spec.path) : roots[spec.ws]);
  // The scenario's directories as tokens, in every spelling Node may hand back.
  const tokenize = (value) => {
    if (typeof value === 'string') {
      for (const [name, root] of Object.entries(roots)) {
        for (const form of [root, root.replace(/\\/g, '/'), root.toLowerCase(), root.toLowerCase().replace(/\\/g, '/')]) value = value.split(form).join(`<${name}>`);
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(tokenize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, tokenize(item)]));
    return value;
  };
  let toolCalls = 0;
  const options = (spec) => ({ sessionId: spec.session, toolCallId: `call-${(toolCalls += 1)}` });
  // The runtime's `getTurnReviewDiff(options)` (`runtime-review-api.mjs`) for the session the window shows.
  const respond = async ({ session, request }) => {
    const client = clients.get(session);
    if (request.capability !== 'getTurnReviewDiff') throw new Error(`the window of ${session} asked for ${JSON.stringify(request)}`);
    const reply = await replyMod.turnReviewReply((reviewOptions) => snapshot.getTurnReviewDiff(roots[client.ws], session, reviewOptions), request.args?.[0] ?? {});
    return tokenize(JSON.parse(JSON.stringify(reply)));
  };
  const windows = new ReviewWindows(windowKit, respond);
  current = { windows };
  const openWindow = async ({ session, ws, checkpoint }) => {
    const ipc = new EventEmitter();
    ipc.send = () => {};
    ipc.invoke = (channel, request) => {
      if (channel !== DESKTOP_IPC.invokeCapability) throw new Error(`the window of ${session} invoked ${channel}`);
      return windows.invoke(request);
    };
    let api;
    runInNewContext(preload, {
      process: { argv: [], env: {} },
      window: { addEventListener() {} },
      require: (specifier) => {
        if (specifier !== 'electron') throw new Error(`the preload required ${specifier}`);
        return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => (api = value) }, sharedTexture: { setSharedTextureReceiver() {} }, webUtils: {} };
      },
    });
    const bridge = new DesktopStateBridge({
      window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, value) => ipc.emit(channel, {}, value) } },
      host: serviceClient,
      ipcMain: new EventEmitter(),
      handle: () => {},
    });
    clients.set(session, { session, ws, bridge });
    await windows.open({ session, checkpoint, api });
  };
  const run = async (op) => {
    switch (op.op) {
      case 'git':
        execFileSync('git', ['init', '-q'], { cwd: roots[op.ws] });
        return {};
      case 'file':
      case 'external':
        // `external`: a write no boundary reported.
        mkdirSync(dirname(where(op)), { recursive: true });
        writeFileSync(where(op), op.content.text);
        return {};
      case 'client':
        await openWindow(op);
        return {};
      case 'begin': {
        tokens.set(op.session, await snapshot.beginTurnSnapshot(roots[op.ws], op.session, { checkpointId: op.checkpoint }));
        return {};
      }
      case 'complete':
        return { completed: await snapshot.completeTurnSnapshot(op.session, tokens.get(op.session) ?? null) };
      case 'edit':
        return { text: tokenize(String(await executeBuiltinTool('edit', { path: op.path, old_string: op.old, new_string: op.new }, roots[op.ws], options(op)))) };
      case 'patch':
        return { text: tokenize(String(await executePatchTool('apply_patch', { base_path: roots[op.ws], patch: op.patch }, roots[op.ws], options(op)))) };
      case 'gitTool': {
        const reply = await executeTool('git', { command: op.command }, roots[op.ws], op.session, {}, options(op));
        return { text: tokenize(String(typeof reply === 'string' ? reply : JSON.stringify(reply))) };
      }
      case 'sessionReview': {
        const reply = await snapshot.getSessionReviewDiff(roots[op.ws], op.session);
        return { answer: tokenize(JSON.parse(JSON.stringify(reply))) };
      }
      case 'revert': {
        const outcome = await (op.file ? snapshot.revertTurnReviewFile(roots[op.ws], op.session, op.file, op.checkpoint) : snapshot.revertTurnReview(roots[op.ws], op.session, op.checkpoint)).then(
          () => true,
          () => false
        );
        return { ok: outcome };
      }
      case 'changes': {
        const reply = await snapshot.getTurnChanges(op.session, { checkpointId: op.checkpoint });
        revisions.set(op.checkpoint, reply.revision);
        return {};
      }
      case 'undo':
      case 'redo': {
        const step = op.op === 'undo' ? snapshot.revertTurnChanges : snapshot.reapplyTurnChanges;
        const outcome = await step(op.session, op.checkpoint, op.file ?? null, revisions.get(op.checkpoint)).then(
          (reply) => {
            revisions.set(op.checkpoint, reply.revision);
            return true;
          },
          () => false
        );
        return { ok: outcome };
      }
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  };
  for (const [index, op] of scenario.ops.entries()) {
    sent = [];
    windows.startOperation();
    const result = await run(op);
    // The windows answer in the order they asked; an answer may raise the next delivery, which is a microtask behind it.
    await null;
    await windows.settle();
    results.push({ op: index, ...result, notifications: sent, ...windows.trace() });
  }
  for (const { bridge } of clients.values()) bridge.dispose();
  await windows.close();
  current = null;
  worktrees._resetTurnWorktreeSnapshotsForTest();
  return { name: scenario.name, platform: process.platform, ops: scenario.ops, results };
}

const gitTwo = [
  { op: 'git', ws: 'w1' },
  { op: 'file', ws: 'w1', path: 'a.txt', content: T(lines('one', 'two', 'three')) },
  { op: 'file', ws: 'w1', path: 'sub/inner.txt', content: T('inner\n') },
  { op: 'git', ws: 'w2' },
  { op: 'file', ws: 'w2', path: 'b.txt', content: T(lines('bee', 'hive')) },
  { op: 'file', ws: 'ng', path: 'p.txt', content: T(lines('plain')) },
];
// A window's transcript is its session's first turn (`checkpoint`): the bar shows a review only of the turn the transcript is at.
const sessions = [
  { op: 'client', session: 's1', ws: 'w1', checkpoint: 'cp1' },
  { op: 'client', session: 's2', ws: 'w1', checkpoint: 'cp2' },
  { op: 'client', session: 's3', ws: 'w2', checkpoint: 'cp3' },
  { op: 'client', session: 's4', ws: 'ng', checkpoint: 'cp4' },
  { op: 'begin', ws: 'w1', session: 's1', checkpoint: 'cp1' },
  { op: 'begin', ws: 'w1', session: 's2', checkpoint: 'cp2' },
  { op: 'begin', ws: 'w2', session: 's3', checkpoint: 'cp3' },
  { op: 'begin', ws: 'ng', session: 's4', checkpoint: 'cp4' },
];
const patchOf = (...sections) => `*** Begin Patch\n${sections.join('')}*** End Patch\n`;
const scenarios = [
  {
    name: 'command tool, edit and apply_patch calls with two sessions on one worktree, one on another and one in a folder without Git',
    ops: [
      // A client with no turn is told too.
      { op: 'client', session: 's0', ws: 'w1', checkpoint: 'none' },
      { op: 'gitTool', ws: 'w1', session: 's0', command: 'status' },
      ...gitTwo,
      ...sessions,
      { op: 'gitTool', ws: 'w1', session: 's1', command: 'status' },
      { op: 'gitTool', ws: 'w2', session: 's3', command: 'status' },
      { op: 'gitTool', ws: 'ng', session: 's4', command: 'status' },
      { op: 'edit', ws: 'w1', session: 's1', path: 'a.txt', old: 'two', new: '2' },
      { op: 'patch', ws: 'w1', session: 's2', patch: patchOf('*** Update File: a.txt\n@@\n-one\n+ONE\n') },
      { op: 'patch', ws: 'w1', session: 's1', patch: patchOf('*** Update File: a.txt\n@@\n-ONE\n+one\n', '*** Update File: sub/inner.txt\n@@\n-inner\n+INNER\n', '*** Add File: n.txt\n+new\n') },
      { op: 'patch', ws: 'w2', session: 's3', patch: patchOf('*** Delete File: b.txt\n') },
      { op: 'patch', ws: 'w1', session: 's1', patch: patchOf('*** Update File: n.txt\n*** Move to: moved.txt\n@@\n-new\n+newer\n') },
      { op: 'patch', ws: 'w1', session: 's1', patch: patchOf('*** Update File: a.txt\n@@\n-absent\n+x\n') },
      { op: 'external', ws: 'w1', path: 'a.txt', content: T(lines('one', '2', 'four')) },
      { op: 'gitTool', ws: 'w1', session: 's1', command: 'status' },
      { op: 'sessionReview', ws: 'w1', session: 's1' },
      { op: 'external', ws: 'w2', path: 'c.txt', content: T('c\n') },
      { op: 'complete', session: 's3' },
      { op: 'complete', session: 's1' },
      { op: 'external', ws: 'w1', path: 'a.txt', content: T(lines('one', '2', 'five')) },
      { op: 'complete', session: 's2' },
      { op: 'complete', session: 's4' },
      { op: 'begin', ws: 'w1', session: 's1', checkpoint: 'cp5' },
      { op: 'complete', session: 's1' },
    ],
  },
  {
    name: 'Undo of a running turn and of a sealed one',
    // Its own session names: the bar keeps what it read per session for the life of the process.
    ops: [
      { op: 'git', ws: 'w1' },
      { op: 'file', ws: 'w1', path: 'a.txt', content: T(lines('x', 'y')) },
      { op: 'client', session: 'u1', ws: 'w1', checkpoint: 'cp1' },
      { op: 'client', session: 'u2', ws: 'w1', checkpoint: 'cp2' },
      { op: 'begin', ws: 'w1', session: 'u1', checkpoint: 'cp1' },
      { op: 'begin', ws: 'w1', session: 'u2', checkpoint: 'cp2' },
      { op: 'edit', ws: 'w1', session: 'u1', path: 'a.txt', old: 'y', new: 'Y' },
      { op: 'patch', ws: 'w1', session: 'u1', patch: patchOf('*** Add File: n.txt\n+new\n') },
      { op: 'revert', ws: 'w1', session: 'u1', file: 'a.txt', checkpoint: 'cp1' },
      { op: 'revert', ws: 'w1', session: 'u1', checkpoint: 'cp1' },
      { op: 'edit', ws: 'w1', session: 'u1', path: 'a.txt', old: 'x', new: 'Z' },
      { op: 'complete', session: 'u1' },
      { op: 'changes', session: 'u1', checkpoint: 'cp1' },
      { op: 'undo', session: 'u1', checkpoint: 'cp1' },
      { op: 'changes', session: 'u1', checkpoint: 'cp1' },
      { op: 'redo', session: 'u1', checkpoint: 'cp1' },
    ],
  },
];

const recorded = [];
for (const scenario of scenarios) recorded.push(await runScenario(scenario));
// The service's own listener goes (`stopTurnReviewPush`), so the listener scenarios see only the listeners they register.
await service.dispose();
await host.close();

// The listener registry itself (`onTurnReviewChanged` / `noteTurnReviewChanged`), on Node's real module. Listeners are named
// functions; one function registered twice is one `Set` entry. What a listener does when called is data:
// `{do:'unsubscribe', handle}`, `{do:'subscribe', fn, handle}`, `{do:'signal'}`, `{do:'throw'}`. Ops run with no `await` between
// them (a signal's delivery is a microtask, so it cannot run inside the run of ops); `drain` yields until nothing is queued.
// Per op the recording holds the listeners that ran during it, in order, and what an unsubscribe answered.
async function runListeners(scenario) {
  const calls = [];
  const handles = new Map();
  const fns = new Map();
  const subscribe = (name, handle) => handles.set(handle, boundary.onTurnReviewChanged(fns.get(name)));
  for (const [name, { does }] of Object.entries(scenario.fns)) {
    fns.set(name, () => {
      calls.push(name);
      for (const action of does) {
        if (action.do === 'unsubscribe') handles.get(action.handle)();
        else if (action.do === 'subscribe') subscribe(action.fn, action.handle);
        else if (action.do === 'signal') boundary.noteTurnReviewChanged();
        else if (action.do === 'throw') throw new Error(`${name} threw`);
        else throw new Error(`unknown action ${action.do}`);
      }
    });
  }
  const results = [];
  for (const [index, op] of scenario.ops.entries()) {
    calls.length = 0;
    let answered;
    if (op.op === 'subscribe') subscribe(op.fn, op.handle);
    else if (op.op === 'unsubscribe') answered = handles.get(op.handle)();
    else if (op.op === 'signal') boundary.noteTurnReviewChanged();
    else if (op.op === 'drain') await drainDeliveries(boundary, `${scenario.name}: op ${index}`);
    else throw new Error(`unknown op ${op.op}`);
    results.push({ op: index, calls: [...calls], ...(answered === undefined ? {} : { answered }) });
  }
  // Leave nothing registered for the next scenario.
  for (const handle of handles.values()) handle();
  return { name: scenario.name, fns: scenario.fns, ops: scenario.ops, results };
}
const none = { does: [] };
const listenerScenarios = [
  {
    name: 'subscribe, signal bursts, unsubscribe and a second unsubscribe',
    fns: { a: none, b: none },
    ops: [
      { op: 'signal' },
      { op: 'drain' },
      { op: 'subscribe', fn: 'a', handle: 'ha' },
      { op: 'subscribe', fn: 'b', handle: 'hb' },
      { op: 'signal' },
      { op: 'signal' },
      { op: 'drain' },
      { op: 'unsubscribe', handle: 'ha' },
      { op: 'unsubscribe', handle: 'ha' },
      { op: 'signal' },
      { op: 'drain' },
      { op: 'subscribe', fn: 'a', handle: 'ha' },
      { op: 'signal' },
      { op: 'unsubscribe', handle: 'hb' },
      { op: 'drain' },
    ],
  },
  {
    name: 'one function registered twice, and an old unsubscribe after it registered again',
    fns: { a: none, b: none },
    ops: [
      { op: 'subscribe', fn: 'a', handle: 'h1' },
      { op: 'subscribe', fn: 'a', handle: 'h2' },
      { op: 'subscribe', fn: 'b', handle: 'hb' },
      { op: 'signal' },
      { op: 'drain' },
      { op: 'unsubscribe', handle: 'h1' },
      { op: 'signal' },
      { op: 'drain' },
      { op: 'unsubscribe', handle: 'h2' },
      { op: 'subscribe', fn: 'a', handle: 'h3' },
      { op: 'unsubscribe', handle: 'h1' },
      { op: 'signal' },
      { op: 'drain' },
    ],
  },
  {
    name: 'listeners removed, added and re-added during a delivery',
    fns: {
      first: { does: [{ do: 'unsubscribe', handle: 'second' }, { do: 'subscribe', fn: 'added', handle: 'added' }] },
      second: none,
      third: { does: [{ do: 'unsubscribe', handle: 'third' }] },
      added: none,
      x: none,
      // Removes `x`, which already ran, and registers it again: it goes to the end, and runs again in this delivery.
      mover: { does: [{ do: 'unsubscribe', handle: 'x' }, { do: 'subscribe', fn: 'x', handle: 'x' }, { do: 'unsubscribe', handle: 'once' }] },
      once: none,
    },
    ops: [
      { op: 'subscribe', fn: 'first', handle: 'first' },
      { op: 'subscribe', fn: 'second', handle: 'second' },
      { op: 'subscribe', fn: 'third', handle: 'third' },
      { op: 'subscribe', fn: 'x', handle: 'x' },
      { op: 'subscribe', fn: 'mover', handle: 'mover' },
      { op: 'subscribe', fn: 'once', handle: 'once' },
      { op: 'signal' },
      { op: 'drain' },
      { op: 'signal' },
      { op: 'drain' },
    ],
  },
  {
    name: 'a listener removed between the signal and its delivery, a late one, and a listener that throws or signals',
    fns: {
      a: none,
      boom: { does: [{ do: 'throw' }] },
      // Runs once, and raises a signal of its own: delivered by the next round, after this one ends.
      echo: { does: [{ do: 'unsubscribe', handle: 'hecho' }, { do: 'signal' }] },
      late: none,
    },
    ops: [
      { op: 'subscribe', fn: 'a', handle: 'ha' },
      { op: 'subscribe', fn: 'boom', handle: 'hboom' },
      { op: 'subscribe', fn: 'echo', handle: 'hecho' },
      { op: 'signal' },
      { op: 'unsubscribe', handle: 'ha' },
      { op: 'subscribe', fn: 'late', handle: 'hlate' },
      { op: 'signal' },
      { op: 'drain' },
      { op: 'unsubscribe', handle: 'hecho' },
      { op: 'signal' },
      { op: 'drain' },
    ],
  },
];
const listeners = [];
for (const scenario of listenerScenarios) listeners.push(await runListeners(scenario));

const finalOut = join(FIXTURES_ROOT, 'turn-review-signal');
const out = stageSet(finalOut);
writeText(join(out, 'scenarios.json'), `${JSON.stringify(recorded, null, 1)}\n`);
writeText(join(out, 'listeners.json'), `${JSON.stringify(listeners, null, 1)}\n`);
writeSetManifest(out, {
  set: 'turn-review-signal',
  recorder: 'benchmarks/rust-core/recorders/record-turn-review-signal.mjs',
  command:
    'node --import <tree>/apps/desktop/scripts/test-env.mjs --import <tree>/apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-turn-review-signal.mjs --tree <tree> --patch-bin <mixdog-patch built from this checkout>',
  extra: { scenarios: recorded.length, listenerScenarios: listeners.length, patchBinarySha256: sha256(readFileSync(patchBin)) },
  identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146'),
});
commitStage(out, finalOut);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${finalOut}`);
