#!/usr/bin/env node
// What the MCP sign-in (`beginMcpOAuthLogin`) and sign-out (`signOutMcpServer`) calls do when the notice
// they post fails, or when the session they address goes away during the awaited runtime action. Node's real
// layers, loaded from the tree under test and run together as the daemon runs them:
//   POST /call            src/standalone/session-transport/call-route.mjs  `createCallRoute` (the 200 {result|error} envelope)
//   session.configure     src/standalone/session-service/session-calls/session-action.mjs  `configureSession`
//   entries               src/standalone/session-service/entries/lifecycle.mjs + disposal.mjs  (`createEntry`, `release`,
//                         `settleTeardown`, `assertAvailable`)
//   the session object    src/tui/session/session-api/extensions.mjs  `createSessionExtensionsApi` over the real notice surface
// The MCP runtime under them answers as each case scripts it, parked on a signal the driver releases. Records, per case and
// method, the ordered events (runtime call, notice, release, teardown, creation, reply), the envelope the client got, and the
// final state (toasts, commandBusy, disposed, pending teardowns).
//
//   node benchmarks/rust-core/recorders/record-mcp-login-notice-failures.mjs --tree <git archive of b6f10295a with node_modules>
//
// Output: native/core/fixtures/mcp-login-notice-failures/golden.json.
process.env.TZ = 'UTC';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const finalDir = join(FIXTURES_ROOT, 'mcp-login-notice-failures');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-mcp-login-notice-failures.mjs';

const { createSessionExtensionsApi } = await importFrom(tree, 'src/tui/session/session-api/extensions.mjs');
const { createNoticeSurface } = await importFrom(tree, 'src/tui/session/notice-surface.mjs');
const { createSessionActionCalls } = await importFrom(tree, 'src/standalone/session-service/session-calls/session-action.mjs');
const { createEntryLifecycle } = await importFrom(tree, 'src/standalone/session-service/entries/lifecycle.mjs');
const { createCallRoute } = await importFrom(tree, 'src/standalone/session-transport/call-route.mjs');
const { createSessionTurnGate } = await importFrom(tree, 'src/standalone/session-service/session-calls/turn-gate.mjs');

const SESSION = 'sess_mcp_1';
const PENDING = { flowId: 'mcp_oauth_1', state: 'pending', url: 'https://auth.example/authorize?state=abc' };
const SIGNED_OUT = { servers: [{ name: 'linear', status: 'connected' }], revoked: true };
const METHODS = {
  beginMcpOAuthLogin: { args: ['linear'], result: PENDING },
  signOutMcpServer: { args: ['linear'], result: SIGNED_OUT },
};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/** One case: a fresh service (entries, lifecycle, action calls, call route) and the incarnations it creates. */
function world({ method, post = 'posts' }) {
  const events = [];
  const incarnations = [];
  let closed = false;
  const sessions = new Set();
  const sessionsById = new Map();
  const pendingDisposals = new Set();
  const live = new Map();
  const teardown = { gate: null };
  const spec = METHODS[method];

  // One session object per incarnation: the real extensions API over the real notice surface, over the scripted runtime.
  function createRuntime() {
    const label = String.fromCharCode(65 + incarnations.length);
    const state = { commandBusy: false, toasts: [], items: [], stats: {}, sessionId: SESSION, busy: false };
    const set = (patch) => Object.assign(state, patch);
    const surface = createNoticeSurface({ getState: () => state, set, isDisposed: () => false, pushItem: (item) => state.items.push(item), replaceItems: (items) => items });
    const action = { started: deferred(), gate: deferred() };
    const runtime = {
      [method]: async () => {
        events.push({ runtime: method, incarnation: label });
        action.started.resolve();
        await action.gate.promise;
        return clone(spec.result);
      },
    };
    const api = createSessionExtensionsApi({
      runtime,
      getState: () => state,
      set,
      pushNotice: (text, tone) => {
        events.push({ notice: { text, tone }, incarnation: label });
        if (post === 'returns false') return false;
        if (post === 'returns null') return null;
        if (post === 'throws') throw new Error('toast sink failed');
        return surface.pushNotice(text, tone);
      },
      resetStatsAndSyncContext: () => {},
      routeState: () => ({}),
    });
    const session = Object.assign(api, {
      getState: () => state,
      subscribe: () => () => {},
      dispose: async (reason) => {
        events.push({ dispose: reason, incarnation: label });
        surface.clearToastTimers();
        if (teardown.gate && label === 'A') await teardown.gate.promise;
        events.push({ disposed: reason, incarnation: label });
      },
    });
    const incarnation = { label, state, surface, action, session, entry: null };
    incarnations.push(incarnation);
    return session;
  }

  const lifecycle = createEntryLifecycle({
    createRuntime: async () => createRuntime(),
    revisionEpoch: 1,
    sessions,
    sessionsById,
    pendingDisposals,
    desktopServices: { notifySessionRuntimeReleased: (id, reason) => events.push({ released: id, reason }) },
    onFrame: (frame) => events.push({ frame: frame.type, sessionId: frame.sessionId, reason: frame.reason }),
    log: () => {},
    isClosed: () => closed,
    indexSessionEntry: (entry, id) => {
      entry.indexedSessionId = String(id || '');
      if (id) sessionsById.set(id, entry);
    },
    schedulePublish: () => {},
    subscriberToken: () => null,
    addSubscriber: () => {},
    updateEntryBusy: () => {},
    releaseProjection: () => {},
    idleStateChanged: () => {},
  });

  async function open() {
    const entry = await lifecycle.createEntry({ sessionId: SESSION, cwd: '/work' });
    incarnations[incarnations.length - 1].entry = entry;
    live.set(SESSION, entry);
    events.push({ created: incarnations[incarnations.length - 1].label });
    return entry;
  }

  const calls = createSessionActionCalls({
    isClosed: () => closed,
    log: () => {},
    turnGate: createSessionTurnGate(),
    projection: { bodyForClient: () => ({}), sessionOwner: () => null },
    retention: { retainUnwatched() {}, awaitingApprovalSessionKinds: () => new Map(), roomHandoffQuestions: () => new Map(), stateBusy: () => false },
    entries: {
      assertAvailable: lifecycle.assertAvailable,
      hostedEntryForSession: async (id) => live.get(id) ?? null,
      entryForSession: async (id) => live.get(id) ?? (await open()),
      settleTeardown: lifecycle.settleTeardown,
    },
    advanceForCaller: () => ({}),
    responseSessionId: (_entry, id) => id,
  });

  const route = createCallRoute({
    handleCall: (name, args, ctx) => {
      if (name !== 'session.configure') throw new Error(`unscripted call ${name}`);
      return calls.configureSession(args, ctx);
    },
    clients: new Map([['tok', { leadPid: null, cwd: '/work', revision: 1, lastSeen: 0 }]]),
    lanes: { dispatch: (_owner, run) => Promise.resolve().then(run) },
    callCache: { get: () => null, track: () => {} },
    nowMs: () => 0,
    onCallStarted: () => {},
    onCallSettled: () => {},
  });

  /** POST /call session.configure for `method`: the envelope the client got (status, parsed body). */
  async function call() {
    const response = {};
    const res = {
      writeHead: (status) => {
        response.status = status;
      },
      end: (body) => {
        response.body = JSON.parse(body);
      },
    };
    await route({ token: 'tok', name: 'session.configure', args: { sessionId: SESSION, action: method, args: spec.args } }, res);
    events.push({ reply: clone(response.body) });
    return response;
  }

  const close = () => {
    closed = true;
  };
  const finish = (response) => ({
    envelope: response,
    events,
    state: {
      service: { sessions: sessions.size, pendingDisposals: pendingDisposals.size },
      incarnations: incarnations.map(({ label, state, entry }) => ({
        label,
        commandBusy: state.commandBusy,
        toasts: state.toasts.map(({ id, ...toast }) => toast),
        entryDisposed: entry?.disposed ?? null,
      })),
    },
  });
  return { events, incarnations, lifecycle, open, call, close, teardown, finish, deferred };
}

const cases = [];
/** Runs `drive(w)` over a fresh world for each method; `drive` answers the call's envelope. */
async function recordCase(name, options, drive) {
  for (const method of Object.keys(METHODS)) {
    const w = world({ method, ...options });
    await w.open();
    const response = await drive(w);
    for (const { surface } of w.incarnations) surface.clearToastTimers();
    cases.push({ name, method, post: options.post ?? 'posts', ...w.finish(response) });
  }
}

/** The call, parked in the runtime action; `release` lets the action answer; resolves the envelope. */
async function parked(w, between) {
  const first = w.incarnations[0];
  const pending = w.call();
  await first.action.started.promise;
  await between?.(w);
  first.action.gate.resolve();
  return pending;
}

await recordCase('a notice posting that returns false', { post: 'returns false' }, (w) => parked(w));
await recordCase('a notice posting that returns null', { post: 'returns null' }, (w) => parked(w));
await recordCase('a notice posting that throws', { post: 'throws' }, (w) => parked(w));
await recordCase('the session disposed during the action', {}, (w) =>
  parked(w, async (x) => {
    await x.lifecycle.release(x.incarnations[0].entry, 'closing');
  })
);
await recordCase('the service closed during the action', {}, (w) => parked(w, (x) => x.close()));
await recordCase('the service closed before the call starts', {}, async (w) => {
  w.close();
  return w.call();
});
await recordCase('the session reopened while the previous teardown is pending', {}, async (w) => {
  w.teardown.gate = w.deferred();
  const first = w.incarnations[0];
  const pending = w.call();
  await first.action.started.promise;
  const disposal = w.lifecycle.release(first.entry, 'idle-evict');
  const reopened = w.open();
  first.action.gate.resolve();
  const oldReply = await pending;
  w.teardown.gate.resolve();
  await disposal;
  await reopened;
  w.incarnations[1].action.gate.resolve();
  const newReply = await w.call();
  return { oldIncarnation: oldReply, newIncarnation: newReply };
});

writeJson(join(stage, 'golden.json'), { cases });
writeSetManifest(stage, { set: 'mcp-login-notice-failures', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree, identityRef: NODE_COMMIT });
commitStage(stage, finalDir);
process.exit(0);
