#!/usr/bin/env node
// What a room call does to the session catalog in Node, with the catalog loaded and not loaded (`session-host.ts:353-356`
// `republishCatalog`: loaded, `publishSessionCatalog(sessionCatalog())` inside the call; not loaded, `void publishCatalogs()`, a whole
// listing whose failure is dropped, `session-host-catalog.ts:217-238`, and which marks the catalog loaded, `session-host.ts:807`).
//
// Node's own product runs unchanged from the exact export of b6f10295a: its daemon (`session-client.mjs` ensureDaemon) in an isolated
// environment, and its SessionHost (`session-host.ts`) attached to it, whose room service (`agent-rooms.ts`) the room calls go through
// (`agentRoomAction`, and `forgetMember` as the agent deletion calls it, `session-host.ts:253`). Each scenario is a fresh environment, a
// fresh daemon and a fresh host. Per call the recording holds: whether the catalog was loaded when the call began, what was published
// while the call ran and after it (each publication with its origin), how the call ended, and whether the catalog was loaded after.
//
// Observation only: a session catalog listener (`host.subscribeSessions`, what a client is handed: a catalog it already holds is
// not handed again) records each publication, and `catalog.publishCatalogs` (the background listing) is wrapped to see each call and
// its origin (an AsyncLocalStorage context set when the room call starts the
// listing); the store-change refresh (`scheduleCatalogRefresh`, a real file watch on a 400 ms / 2 s timer) is recorded with its own
// origin. The one injected fault is the daemon's answer to `session.list` (the host's listing) in the failing scenarios.
//
//   (cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs \
//        <repo>/benchmarks/rust-core/recorders/record-room-catalog-states.mjs --tree <tree> --harness <real-turn-harness dir> [--only <scenario>]
// Output: native/core/fixtures/room-catalog-states/{<scenario>.json,MANIFEST.json}
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, REPO_ROOT, exactProductIdentity, parseArgs, recordingProvenance, resolveTree, writeSetManifest } from './lib/common.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const harness = args.get('harness');
if (!harness) throw new Error('--harness <real-turn-harness dir> is required (its lib/env.mjs, lib/deadline.mjs are pinned in the manifest)');
const identity = exactProductIdentity(tree, COMMIT);
const out = join(FIXTURES_ROOT, 'room-catalog-states');
const PINNED = ['env.mjs', 'deadline.mjs', 'scenarios.mjs'];
const DIFFERENCES = 'benchmarks/rust-core/recorders/room-catalog-core-differences.json';
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

const hload = (name) => import(pathToFileURL(join(harness, 'lib', name)).href);
const load = (path) => import(pathToFileURL(join(tree, path)).href);

// ── the scenarios ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// `loaded`: a listing first (a window's first list), then every room call; `not-loaded`: a room call before any listing, then the next
// call (Node's own background listing has loaded the catalog by then); `not-loaded-failing`: the listing fails, so the catalog stays
// unloaded through both calls and the failures are dropped; `loaded-failing`: loaded first, then the listing fails and the calls go on;
// `not-loaded-large`: more rooms than one page of the core's listing (`DEFAULT_PAGE_LIMIT`, 50) are made while the listing fails, so
// the catalog stays unloaded; then an update of the rounds alone (it renames nothing, so no listing of its own runs before it answers:
// `agent-rooms.ts:311-312`) starts the background listing, which answers and publishes them all after the call.
// `pruned-at-load`: a room is made while the listing fails (the catalog stays unloaded); then one member's definition is deleted at the
// daemon, as a chat's setup tool deletes it, past the host (`deleteAgentDefinition` as a control call, not the host's capability, which
// would take the member out itself, `session-host-lifecycle.ts:1169`), and the host restarts: its start-up `recover` loads the rooms
// (`agent-rooms.ts:465-469`), whose first load prunes the member (`ready`, `:353-361`; `pruneDeleted`, `agent-room-membership.ts:64-76`:
// saved, `republishCatalog`, its room conversation deleted); then an update of the rounds.
// The start-up prune is a background recovery in Node (`session-host.ts:430-432`: `recover` started, not awaited, its rejection logged)
// whose `ready` every room mutation awaits (`agent-rooms.ts:354-362`; a failed preparation is forgotten, so the next mutation tries
// again). The prune's save is Node's own persist (`createAgentRoomFileStore` → `writeJsonAtomicAsync`), held or failed at the open of
// its temp file (`atomic-file.mjs:328`, the save's first file operation):
// `prune-held`: the restart's prune is held at its save; a room update (it awaits `ready`) is started and a listing (it does not:
// `listSessions` → `withRooms`) runs to its answer; then the save goes on, and the update answers.
// `prune-failed-then-update`: the restart's prune fails its save once (logged, the host is up); a room update then calls `ready` again.
// `prune-failed`: the restart's prune fails its save; nothing mutates after it; a listing shows what the host holds.
// `restart-and-list` (the last step of the three above): the host made again over the files the one before wrote (no definition
// deleted this time), its start-up's first load awaited, then a listing: what the room records on disk hold after the scenario.
// `failing(step)`: whether the daemon's `session.list` fails while that step runs (`list` for the first listing, else the call's index);
// each step records it as `listingFails`, which the replay sets.
const ROOM_CALLS = ['create', 'update', 'reset', 'forget-member', 'remove'];
const LARGE = 51;
const SCENARIOS = {
  loaded: { listFirst: true, failing: () => false, calls: ROOM_CALLS, resetListings: 'room-call-first', resetRefresh: 'after-answer' },
  'loaded-reset-refresh-in-io': { listFirst: true, failing: () => false, calls: ROOM_CALLS, resetListings: 'room-call-first', resetRefresh: 'in-io' },
  'loaded-reset-listing-first': { listFirst: true, failing: () => false, calls: ROOM_CALLS, resetListings: 'listing-first', resetRefresh: 'after-answer' },
  // The flag's lifetime: loaded, then the daemon connection is lost (`onFatal` → `handleSessionTransportLoss`, `session-host.ts:421`)
  // and a renderer that reloaded subscribes again; the next room call shows whether the host still counts its catalog loaded.
  'loaded-reconnect': { listFirst: true, reconnect: true, failing: () => false, calls: ['create'] },
  'not-loaded': { listFirst: false, failing: () => false, calls: ['create', 'update'] },
  'not-loaded-failing': { listFirst: false, failing: () => true, calls: ['create', 'update'] },
  // The failing listing also fails the host's session deletions (they read the daemon's list), which the room calls that delete
  // sessions (member removal, remove) then report; those are recorded in the loaded scenario only.
  'loaded-failing': { listFirst: true, failing: (step) => step !== 'list', calls: ['create', 'update', 'reset'] },
  'not-loaded-large': { listFirst: false, failing: (step) => step < LARGE, calls: [...Array(LARGE).fill('create'), 'update-rounds'] },
  'pruned-at-load': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'restart-after-agent-deletion', 'update-rounds', 'restart-and-list'] },
  'prune-held': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'restart-held-at-save', 'update-rounds-and-list-while-held'] },
  'prune-failed-then-update': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'restart-save-fails', 'update-rounds', 'restart-and-list'] },
  'prune-failed': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'restart-save-fails', 'list-sessions', 'restart-and-list'] },
};
// How a scenario's reset forces the order of its catalog publications, each order its own scenario, forced, never sampled. A room
// reset starts the room log's own listing without awaiting it (`session-host-lifecycle.ts:401`, inside `startOver`,
// `agent-rooms.ts:379`), then after the records' save publishes the room call's catalog (`agent-rooms.ts:388`; with the catalog
// loaded, the rows in hand, `session-host.ts:354`): the listing publishes before or after the room call's catalog, by daemon I/O
// against file I/O. Then the store watcher's refresh, a 400 ms / 2 s timer after the log's clear (`session-host-catalog.ts:170-180`),
// fires while the reset awaits its member checks (`agent-rooms.ts:391`) or after it answers.
const FORCED = {
  resetListings: {
    'room-call-first': "the reset's own listing is held at its daemon call until the room call's catalog is published and the store watcher has reported the cleared log",
    'listing-first': "the room records' save is held until the reset's own listing has ended; that listing is held at its daemon call until the store watcher has reported the cleared log",
  },
  resetRefresh: {
    'after-answer': "the store refresh's start is gated from the reset's start until its answer is recorded",
    'in-io': "the reset is held at its first member check (daemon I/O) until the reset's own listing and then the store refresh have run to their end",
  },
};
// The text of the injected save failure (an I/O error of the room records' file).
const SAVE_FAILURE = 'the room records could not be saved';
const only = args.get('only');
if (only && !SCENARIOS[only]) throw new Error(`--only ${only}: unknown scenario; known: ${Object.keys(SCENARIOS).join(', ')}`);
const names = only ? [only] : Object.keys(SCENARIOS);

const { daemonEnv, isolatedPaths } = await hload('env.mjs');
const { createDeadline } = await hload('deadline.mjs');
const sessionClient = await load('src/standalone/session-client.mjs');
const { createSessionProtocolClient } = await load('src/standalone/session-protocol.mjs');
const { createDesktopRuntime } = await load('src/standalone/daemon-desktop-runtime.mjs');
const { roomMemberSessionId } = await load('src/runtime/agent/orchestrator/session/agent-room.mjs');

// In production the host runs inside the daemon and reaches it through the daemon-local bridge, which the daemon reads as revision 0
// (session-action.mjs:221); this recorder's client registers over TCP as revision 0 too, the one digit of its register body
// (session-client.mjs:577). Every Node module runs unchanged.
{
  const http = (await import('node:http')).default;
  const request = http.request;
  http.request = function (...rest) {
    const req = request.apply(this, rest);
    if (rest.find((a) => a && typeof a === 'object' && a.path)?.path === '/client/register') {
      const write = req.write;
      req.write = (chunk, ...more) => write.call(req, String(chunk).replace('"revision":6', '"revision":0'), ...more);
    }
    return req;
  };
}
// The room records' save (`atomic-file.mjs` `writeFileDurableAsync` opens the temp file `agent-rooms.json.mixdog-tmp-<hex>` first):
// when a step arms it, the next such open says it was reached and then fails, or waits until the step releases it. The ESM bindings
// of `node:fs/promises` follow the patched export (`syncBuiltinESMExports`).
let roomSave = null;
{
  const fsPromises = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { basename } = await import('node:path');
  const open = fsPromises.open;
  fsPromises.open = async function (path, ...rest) {
    const hook = roomSave;
    if (hook && basename(String(path)).startsWith('agent-rooms.json.mixdog-tmp-')) {
      roomSave = null;
      hook.reached();
      if (hook.fail) throw Object.assign(new Error(SAVE_FAILURE), { code: 'EIO' });
      await hook.released;
    }
    return open.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
}
/** The next room save, held (`fail` false) or failed: `reached` resolves when it is. */
function armRoomSave(fail) {
  let reached;
  let release;
  const hook = { fail, reached: null, released: new Promise((resolve) => (release = resolve)) };
  const arrived = new Promise((resolve) => (reached = resolve));
  hook.reached = reached;
  roomSave = hook;
  return { arrived, release };
}
// The rooms' log (`agent-rooms.ts:190` and `session-host.ts:432`: `console.warn('[mixdog-rooms] …')`): each line is an event, and a
// step can await the next one.
let roomLogged = null;
let logEvents = null;
{
  const warn = console.warn;
  console.warn = (...parts) => {
    if (typeof parts[0] === 'string' && parts[0].startsWith('[mixdog-rooms]') && logEvents) {
      // The line's text, and an error part by its message (its stack is the recording process's).
      const logged = parts.map((part) => (part instanceof Error ? { error: part.message } : part));
      logEvents.push({ kind: 'logged', parts: plain(logged) });
      const waiter = roomLogged;
      roomLogged = null;
      waiter?.();
    }
    return warn.apply(console, parts);
  };
}
const nextRoomLog = () => new Promise((resolve) => (roomLogged = resolve));
// The daemon is forked with this process's flags; it runs as a plain script.
process.execArgv = [];
const parentEnv = { ...process.env };

async function record(name) {
  const scenario = SCENARIOS[name];
  const envRoot = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:\\mixdog-build\\tmp', `room-catalog-${name}-`));
  const paths = isolatedPaths(envRoot);
  for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
  // A route the bots name; no turn runs, so nothing is ever sent to it.
  const route = { provider: 'custom-harness', model: 'harness-model' };
  writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: 'http://127.0.0.1:9/v1', auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
  const isolated = daemonEnv(paths);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, isolated);
  const deadline = createDeadline(60_000, () => `room catalog states, scenario ${name}`);
  let discovery = null;
  let host = null;
  let finished = false;
  try {
    discovery = await deadline.race(sessionClient.ensureDaemon({ cwd: paths.workspace, attempts: 2, readyTimeoutMs: 60_000 }), 'the Node daemon');
    // The daemon's answer to the host's listing; it fails while the running step's `failing` says so.
    let listingFails = false;
    // The reset's listing order (see `FORCED`): `resetListings` is armed by the reset; `listingHold` holds the daemon's answer to the
    // reset's own listing, `joinedL1` releases it once the room call's catalog is published.
    let resetListings = null;
    let listingHold = null;
    let joinedL1 = null;
    let resetListing = null;
    // The reset's own listing also waits for the store watcher's report of the cleared log (`session-host-catalog.ts:87-93`): the
    // daemon lists a session it holds live in its live form until its changed file is read (`session-crud.mjs:65-67`), and that
    // read would otherwise race the daemon's write.
    let storeChanged = null;
    let logWritten = null;
    const runtime = {
      ...createDesktopRuntime({ getLocalSessionBridge: () => null }),
      attachSessionClient: async (options) => {
        const attached = await sessionClient.attachSession({ discovery, cwd: paths.workspace, onFrame: options.onFrame, onFatal: options.onFatal });
        return createSessionProtocolClient({
          call: (method, params, callOptions) => {
            if (method === 'session.list' && listingFails) return Promise.reject(new Error('the session listing failed'));
            // The reset's own listing held in flight until the room call's catalog is published (`resetListings: 'room-call-first'`).
            if (method === 'session.list' && listingHold) {
              const hold = listingHold;
              listingHold = null;
              return hold.promise.then(() => attached.call(method, params, callOptions));
            }
            return attached.call(method, params, callOptions);
          },
          close: (reason) => attached.close(reason),
        });
      },
    };
    const { SessionHost } = await load('apps/desktop/src/main/session-host.ts');
    const origin = new AsyncLocalStorage();
    const events = [];
    logEvents = events;
    const background = [];
    // The store watcher's refresh (`scheduleCatalogRefresh`, `session-host-catalog.ts:170-180`) runs on a real timer, 400 ms to 2 s after
    // a store change: left pending at a step's end, it would publish inside whichever later step its timer happens to meet. Each step
    // ends once no refresh is pending: the timer's firing is awaited (an event, under a deadline), then its refresh to its end, so its
    // publication is the step's that made the change, after the step's answer.
    let refreshFired = null;
    // The next store refresh to fire: resolves with its run.
    const nextRefresh = () => {
      if (!refreshFired) {
        let resolve;
        refreshFired = { promise: new Promise((r) => (resolve = r)), resolve: (done) => resolve(done) };
      }
      return refreshFired.promise;
    };
    // The refreshes that fired and have not been awaited to their end; while `refreshGate` is set, a fired refresh starts only
    // once it resolves (the gate on the refresh's start that forces the reset's two orders).
    const refreshesInFlight = [];
    let refreshGate = null;
    // A refresh the step's store change owes (the reset's: the daemon's summary write of the cleared log is the store change the
    // watcher reports, after the reset's own writes): the step ends only once it has fired, then run to its end.
    let owedRefresh = null;
    const refreshes = async (what) => {
      if (owedRefresh) {
        const fired = owedRefresh;
        owedRefresh = null;
        await deadline.race(fired, `the store refresh of ${what}'s store change to fire`);
      }
      for (;;) {
        if (refreshesInFlight.length) {
          await deadline.race(Promise.all(refreshesInFlight.splice(0)), `the store refresh of ${what}`);
          continue;
        }
        if (!host.catalog.storeRefreshTimer) break;
        await deadline.race(nextRefresh(), `the store refresh pending at the end of ${what} to fire`);
      }
    };
    // A host, observed. Its start-up `recover` (`session-host.ts:430-432`) is started inside `create` and not awaited; the
    // observation is in place before it can reach a publication, which its first awaited file read (`loadRecords`) comes before.
    const open = async () => {
      host = await SessionHost.create({ userDataPath: paths.appData, resourcesPath: paths.workspace, appPath: paths.workspace, packaged: false }, runtime);
      // The client's side: a catalog listener on the host's channel, as the desktop's (`ipc-state-bridge.ts:99-101`) and the
      // relay's (`remote-relay-session-wiring.ts:195`) subscribe, handed only what it does not hold yet (`CatalogChannel.publish`,
      // `session-host-publication.ts:128-149`). The channel calls it inside the publication, so its context and stack are the
      // publication's. It subscribes to the channel itself (`session-host-publication.ts:269`), not through the host's
      // `subscribeSessions` (`session-host.ts:444-447`), which would also start the store watcher: an observer does not add the
      // watcher's timer publications to what it observes.
      host.publication.subscribeSessions((sessions) => {
        const stack = new Error().stack ?? '';
        const from = origin.getStore() ?? (stack.includes('republishCatalog') ? 'room-call' : stack.includes('scheduleCatalogRefresh') || stack.includes('Timeout') ? 'store-refresh' : 'listing');
        events.push({ kind: 'published', origin: from, sessions: plain(sessions) });
      });
      // The room call's catalog (`session-host.ts:354`) has gone to the channel, published or skipped as equal to the last one
      // (`session-host-publication.ts:109-146`): a reset's own listing held for it may answer now (`resetListings: 'room-call-first'`).
      const publishSessionCatalog = host.publishSessionCatalog.bind(host);
      host.publishSessionCatalog = (sessions) => {
        const fromRoomCall = (new Error().stack ?? '').includes('republishCatalog');
        publishSessionCatalog(sessions);
        if (fromRoomCall) {
          joinedL1?.();
          joinedL1 = null;
        }
      };
      // A room's title goes through the host's rename (`session-host.ts:316`), which awaits a whole listing of its own
      // (`session-host-lifecycle.ts:225-233`): what that listing publishes is the rename's.
      // The rooms' first load's member check (`pruneDeleted`, `agent-room-membership.ts:67`, through `agentPresence`,
      // `session-host.ts:296`): each check is an event with the ids it asks about, so a step shows whether a first load ran in it.
      const invokeControl = host.transport.invokeControl.bind(host.transport);
      host.transport.invokeControl = (name, params, ...rest) => {
        if (name === 'agentDefinitionPresence' && (new Error().stack ?? '').includes('pruneDeleted')) {
          events.push({ kind: 'prune-checked', ids: plain(params[0]) });
        }
        return invokeControl(name, params, ...rest);
      };
      const renameSession = host.lifecycle.renameSession.bind(host.lifecycle);
      host.lifecycle.renameSession = (sessionId, title) => origin.run('room-rename', () => renameSession(sessionId, title));
      // The store watcher's refresh (`session-host-catalog.ts:170-180`, a debounced timer per store change) publishes after its
      // listing's await, where the stack no longer names the timer: its timer is set in its own origin, which the timer keeps.
      const scheduleCatalogRefresh = host.catalog.scheduleCatalogRefresh.bind(host.catalog);
      host.catalog.scheduleCatalogRefresh = () => {
        storeChanged?.();
        storeChanged = null;
        return origin.run('store-refresh', scheduleCatalogRefresh);
      };
      const publishCatalogs = host.catalog.publishCatalogs.bind(host.catalog);
      host.catalog.publishCatalogs = () => {
        // The store refresh's timer fired (its context is the one `scheduleCatalogRefresh` set): its refresh is handed to the step
        // end that waits for it.
        if (origin.getStore() === 'store-refresh') {
          const gate = refreshGate;
          const done = gate ? gate.then(() => publishCatalogs()) : publishCatalogs();
          refreshesInFlight.push(done);
          const waiting = refreshFired;
          refreshFired = null;
          waiting?.resolve(done);
          return done;
        }
        const stack = new Error().stack ?? '';
        // The room log's own reset listing (`session-host-lifecycle.ts:401`, `void publishCatalogs()` inside the reset's `startOver`,
        // `agent-rooms.ts:379`), forced to answer after the room call's catalog or to end before the room records' save (`FORCED`).
        if (resetListings && stack.includes('resetSessionConversation')) {
          const mode = resetListings;
          resetListings = null;
          if (mode === 'room-call-first') {
            let release;
            listingHold = { promise: Promise.all([logWritten, new Promise((resolve) => (release = resolve))]) };
            joinedL1 = release;
            resetListing = publishCatalogs();
            return resetListing;
          }
          const save = armRoomSave(false);
          listingHold = { promise: logWritten };
          resetListing = publishCatalogs();
          resetListing.finally(() => save.release());
          return resetListing;
        }
        const fromRoomCall = stack.includes('republishCatalog');
        if (!fromRoomCall) return publishCatalogs();
        events.push({ kind: 'background-listing-started' });
        const done = origin.run('room-call-background-listing', () => publishCatalogs());
        background.push(done);
        return done;
      };
    };
    await open();

    const saveBot = async (label) => (await deadline.race(host.invokeCapability('saveAgentDefinition', [{ kind: 'bot', name: label, description: `${label} bot`, body: `You are ${label}.`, route }]), `saving ${label}`)).value;
    const bots = [];
    // Each bot's name as its saved definition answers it: a replay names the agents with it, also one no room summary names.
    const botNames = {};
    for (const label of ['Alpha', 'Beta', 'Gamma']) {
      const saved = await saveBot(label);
      bots.push(saved.id);
      botNames[saved.id] = saved.name;
    }
    events.splice(0);
    const steps = [];
    if (scenario.listFirst) {
      listingFails = scenario.failing('list');
      const listed = plain(await deadline.race(host.listSessions(), 'the first listing'));
      await refreshes('the first listing');
      steps.push({ step: 'list', listingFails, loadedAfter: host.sessionCatalogLoaded, sessions: listed, events: events.splice(0) });
    }
    if (scenario.reconnect) {
      host.publication.handleSessionTransportLoss();
      const unsubscribe = host.subscribeSessions(() => {});
      unsubscribe();
      await refreshes('the reload');
      steps.push({ step: 'transport-loss-and-renderer-reload', loadedAfter: host.sessionCatalogLoaded, events: events.splice(0) });
    }
    let room = null;
    const CALLS = {
      create: () => host.agentRoomAction('create', [{ name: 'Room One', members: bots }]),
      update: () => host.agentRoomAction('update', [room.roomId, { name: 'Room Renamed' }]),
      'update-rounds': () => host.agentRoomAction('update', [room.roomId, { maxRounds: 4 }]),
      // The reset's store refresh (its room log's clear changes the store, `session-host-lifecycle.ts:389`; the watcher's timer,
      // `session-host-catalog.ts:170-180`) is forced to one side of the reset's answer (`resetRefresh`, see `FORCED`).
      reset: async () => {
        resetListings = scenario.resetListings;
        logWritten = new Promise((resolve) => (storeChanged = resolve));
        if (scenario.resetRefresh === 'after-answer') {
          owedRefresh = nextRefresh();
          let open;
          refreshGate = new Promise((resolve) => (open = resolve));
          afterAnswer = () => {
            refreshGate = null;
            open();
          };
          return await host.agentRoomAction('reset', [room.roomId]);
        }
        // `in-io`: the reset held at its first member check (`agent-rooms.ts:391`, `deps.sessionExists` → `readSession`,
        // `session-host.ts:299-301`, daemon I/O) until the refresh has fired and run to its end.
        const fired = nextRefresh();
        const check = holdMemberCheck();
        const resetting = host.agentRoomAction('reset', [room.roomId]);
        await deadline.race(check.arrived, "the reset's first member check");
        // The reset's own listing to its end first, so the refresh lists on its own.
        await deadline.race(resetListing, "the reset's own listing");
        const done = await deadline.race(fired, 'the store refresh to fire while the reset awaits its member check');
        await deadline.race(done, 'the store refresh while the reset awaits its member check');
        check.release();
        return await resetting;
      },
      'forget-member': () => host.agentRooms.forgetMember(bots[2]),
      remove: () => host.agentRoomAction('remove', [room.roomId]),
      // No client call: the start-up's own end is the rooms' first load (`ready`, the promise `recover` awaits), which the
      // recorder awaits as `recover` does; `recover` goes on with no await when no exchange was cut off (`agent-rooms.ts:470-479`).
      'restart-after-agent-deletion': async () => {
        await restart();
        await host.agentRooms.ready();
        return null;
      },
      // The restart's prune held at its save: the step ends when the save is reached (the prune's `ready` is still pending).
      'restart-held-at-save': async () => {
        held = armRoomSave(false);
        await restart();
        await deadline.race(held.arrived, 'the prune reaching its save');
        events.push({ kind: 'save-held' });
        return null;
      },
      // The restart's prune fails its save: the step ends at the start-up's own end, its rejection logged (`session-host.ts:432`).
      'restart-save-fails': async () => {
        const failed = armRoomSave(true);
        const logged = nextRoomLog();
        await restart();
        await deadline.race(failed.arrived, 'the prune reaching its save');
        await deadline.race(logged, 'the start-up logging its failure');
        return null;
      },
      // While the prune is held: an update (it awaits `ready`) is started, then a listing (it does not) runs to its answer; whether
      // the update had ended by then is recorded; then the save goes on and the update answers.
      'update-rounds-and-list-while-held': async () => {
        let ended = false;
        const updating = CALLS['update-rounds']().finally(() => {
          ended = true;
        });
        events.push({ kind: 'listed', sessions: plain(await deadline.race(host.listSessions(), 'the listing while the save is held')) });
        events.push({ kind: 'update-ended-before-the-save', ended });
        // The prune goes on past its save to its member's room conversation deletion (`agent-room-membership.ts:74`), held there:
        // the first load is still pending, so whether the update had ended by then shows whether it awaits the first load.
        const deletion = holdDeletion();
        held.release();
        events.push({ kind: 'save-released' });
        await deadline.race(deletion.arrived, "the prune reaching its member's deletion");
        events.push({ kind: 'update-ended-before-the-deletion', ended });
        deletion.release();
        return await updating;
      },
      'list-sessions': () => host.listSessions(),
      'restart-and-list': async () => {
        await restart(false);
        await deadline.race(host.agentRooms.ready(), 'the first load after the restart');
        return await host.listSessions();
      },
    };
    let held = null;
    // Run once the step's answer is recorded (the `after-answer` reset opens its refresh gate there).
    let afterAnswer = null;
    // The host's next existence check of a room member's session (`sessionExists` reads it, `session-host.ts:299-301`), held until
    // released: `arrived` resolves when it is reached.
    const holdMemberCheck = () => {
      const readSession = host.readSession;
      let reached;
      let release;
      const arrived = new Promise((resolve) => (reached = resolve));
      const released = new Promise((resolve) => (release = resolve));
      host.readSession = async (sessionId, ...rest) => {
        if (bots.some((id) => roomMemberSessionId(room.roomId, id) === sessionId)) {
          host.readSession = readSession;
          reached();
          await released;
        }
        return readSession.call(host, sessionId, ...rest);
      };
      return { arrived, release };
    };
    // The host's next session deletion (`session-host-lifecycle.ts:514`, what the rooms' `deleteSession` calls,
    // `session-host.ts:342-343`), held until released: `arrived` resolves when it is reached.
    const holdDeletion = () => {
      const lifecycle = host.lifecycle;
      const deleteSession = lifecycle.deleteSession;
      let reached;
      let release;
      const arrived = new Promise((resolve) => (reached = resolve));
      const released = new Promise((resolve) => (release = resolve));
      lifecycle.deleteSession = async (sessionId) => {
        lifecycle.deleteSession = deleteSession;
        reached();
        await released;
        return deleteSession.call(lifecycle, sessionId);
      };
      return { arrived, release };
    };
    const restart = async (deleteDefinition = true) => {
      if (deleteDefinition) await host.transport.invokeControl('deleteAgentDefinition', [bots[2]]);
      await host.dispose();
      host = null;
      await open();
    };
    for (const [index, call] of scenario.calls.entries()) {
      listingFails = scenario.failing(index);
      const loadedBefore = host.sessionCatalogLoaded;
      let answer;
      try {
        const value = plain(await deadline.race(CALLS[call](), `the room call ${call}`));
        if (call === 'create') room = value;
        answer = { kind: 'answered', value };
      } catch (error) {
        answer = { kind: 'threw', message: String(error?.message ?? error) };
      }
      events.push(answer);
      afterAnswer?.();
      afterAnswer = null;
      // The listing the call started in the background, to its end: what it published (or that it published nothing) is the call's.
      await deadline.race(Promise.all(background.splice(0)), `the background listing of ${call}`);
      await refreshes(call);
      steps.push({ step: call, listingFails, loadedBefore, loadedAfter: host.sessionCatalogLoaded, events: events.splice(0) });
    }
    finished = true;
    // The host's task workspace, where a room log is made (`agent-rooms.ts:284`), as the host itself names it.
    const taskWorkspace = await deadline.race(host.taskWorkspace(), 'the task workspace');
    const { failing: _, ...shape } = scenario;
    return { scenario: name, ...shape, taskWorkspace, bots, botNames, room, steps };
  } finally {
    logEvents = null;
    roomSave = null;
    deadline.clear();
    if (host) await host.dispose().catch(() => {});
    if (discovery) await sessionClient.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 }).catch(() => {});
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, parentEnv);
    // A failed run keeps its environment (the daemon's crash captures and logs) and names it.
    if (!finished) console.error(`scenario ${name} failed; its environment is kept at ${envRoot}`);
    else {
      try {
        rmSync(envRoot, { recursive: true, force: true });
      } catch (error) {
        // A process of the daemon's still holding a file of it: the recording stands, the environment is left and named.
        console.error(`scenario ${name}: its environment ${envRoot} could not be removed (${error.code}); remove it once its processes have ended`);
      }
    }
  }
}

mkdirSync(out, { recursive: true });
for (const name of names) {
  const recorded = await record(name);
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(recorded, null, 2)}\n`);
  console.error(`recorded ${name}: ${recorded.steps.length} steps`);
}
if (!only) {
  const rel = 'benchmarks/rust-core/recorders/record-room-catalog-states.mjs';
  writeSetManifest(out, {
    set: 'room-catalog-states',
    recorder: rel,
    command: `(cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs <repo>/${rel} --tree <tree> --harness <real-turn-harness dir>`,
    identity,
    extra: {
      exact: true,
      ...recordingProvenance('benchmarks/rust-core/recorders/record-room-catalog-states.mjs', ['benchmarks/rust-core/recorders/lib/common.mjs', DIFFERENCES]),
      // What the core sends differently from these recordings, each part named with its owner: the replay holds the core to it.
      coreDifferences: JSON.parse(readFileSync(join(REPO_ROOT, DIFFERENCES), 'utf8')),
      // Per scenario whose reset's listings could fall in either order: how the recorded order was forced.
      forcedOrders: Object.fromEntries(
        Object.entries(SCENARIOS)
          .filter(([, s]) => s.resetRefresh)
          .map(([n, s]) => [n, { resetListings: { order: s.resetListings, how: FORCED.resetListings[s.resetListings] }, resetRefresh: { order: s.resetRefresh, how: FORCED.resetRefresh[s.resetRefresh] } }])
      ),
      harness: Object.fromEntries(PINNED.map((n) => [`lib/${n}`, sha256(join(harness, 'lib', n))])), scenarios: names },
  });
}
process.exit(0);
