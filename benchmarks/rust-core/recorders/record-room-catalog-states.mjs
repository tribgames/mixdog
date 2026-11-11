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
import crypto from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, REPO_ROOT, exactProductIdentity, parseArgs, resolveTree, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { RecorderError } from './lib/recorder-error.mjs';

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
  // The reset's daemon read against its room call's publication (see `RESET_READ`): each scenario in both orders.
  loaded: { listFirst: true, failing: () => false, calls: ROOM_CALLS, resetRead: 'before-publication', resetRefresh: 'after-answer' },
  'loaded-read-after-answer': { listFirst: true, failing: () => false, calls: ROOM_CALLS, resetRead: 'after-answer', resetRefresh: 'after-answer' },
  'loaded-reset-refresh-in-io': { listFirst: true, failing: () => false, calls: ROOM_CALLS, resetRead: 'before-publication', resetRefresh: 'in-io' },
  'loaded-reset-refresh-in-io-read-after-answer': { listFirst: true, failing: () => false, calls: ROOM_CALLS, resetRead: 'after-answer', resetRefresh: 'in-io' },
  'loaded-reset-listing-first': { listFirst: true, failing: () => false, calls: ROOM_CALLS, resetListings: 'listing-first', resetRefresh: 'after-answer' },
  // The flag's lifetime: loaded, then the daemon connection is lost (`onFatal` → `handleSessionTransportLoss`, `session-host.ts:421`)
  // and a renderer that reloaded subscribes again; the next room call shows whether the host still counts its catalog loaded.
  // The other order of the store watcher's refresh and a room call's own listing (see `FORCED.storeRefresh`): the call's listing is held
  // until the refresh has published, so the refresh's publication comes inside the call. Only the calls that rename.
  'loaded-refresh-before-answer': { listFirst: true, failing: () => false, calls: ['create', 'update'], storeRefresh: 'before-answer' },
  'loaded-reconnect': { listFirst: true, reconnect: true, failing: () => false, calls: ['create'] },
  'not-loaded': { listFirst: false, failing: () => false, calls: ['create', 'update'] },
  'not-loaded-failing': { listFirst: false, failing: () => true, calls: ['create', 'update'] },
  // The failing listing also fails the host's session deletions (they read the daemon's list), which the room calls that delete
  // sessions (member removal, remove) then report; those are recorded in the loaded scenario only.
  // Its reset's store refresh is forced into the reset's I/O (`resetRefresh: 'in-io'`, see `FORCED`); its own listing fails at once, so no
  // daemon read races (no `resetRead`).
  'loaded-failing': { listFirst: true, failing: (step) => step !== 'list', calls: ['create', 'update', 'reset'], resetRefresh: 'in-io' },
  'not-loaded-large': { listFirst: false, failing: (step) => step < LARGE, calls: [...Array(LARGE).fill('create'), 'update-rounds'] },
  'pruned-at-load': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'restart-after-agent-deletion', 'update-rounds', 'restart-and-list'] },
  'prune-held': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'restart-held-at-save', 'update-rounds-and-list-while-held'] },
  'prune-failed-then-update': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'restart-save-fails', 'update-rounds', 'restart-and-list'] },
  'prune-failed': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'restart-save-fails', 'list-sessions', 'restart-and-list'] },
  // The start-up's recovery against a room update that awaited the same first load (see `STARTUP`), each way the two meet in both orders:
  // the update registered first (it starts the first load), the recovery joining a first load another call (a member forgotten) started,
  // and the recovery with an interrupted room to mark (a `continue` held in its exchange, then the host made again).
  'startup-update-before-recovery': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'restart-and-update'], startup: 'update-before-recovery', startupOrder: 'recovery-first' },
  'startup-update-before-recovery-update-first': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'restart-and-update'], startup: 'update-before-recovery', startupOrder: 'update-first' },
  'startup-recovery-joins': { listFirst: false, failing: (step) => step === 0, spare: true, calls: ['create', 'restart-and-update'], startup: 'recovery-joins', startupOrder: 'recovery-first' },
  'startup-recovery-joins-update-first': { listFirst: false, failing: (step) => step === 0, spare: true, calls: ['create', 'restart-and-update'], startup: 'recovery-joins', startupOrder: 'update-first' },
  'startup-interrupted': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'continue-held', 'restart-and-update'], startup: 'interrupted', startupOrder: 'recovery-first' },
  'startup-interrupted-update-first': { listFirst: false, failing: (step) => step === 0, calls: ['create', 'continue-held', 'restart-and-update'], startup: 'interrupted', startupOrder: 'update-first' },
};
// How a scenario's reset forces the order of its catalog publications, each order its own scenario, forced, never sampled. A room
// reset starts the room log's own listing without awaiting it (`session-host-lifecycle.ts:401`, inside `startOver`,
// `agent-rooms.ts:379`), then after the records' save publishes the room call's catalog (`agent-rooms.ts:388`; with the catalog
// loaded, the rows in hand, `session-host.ts:354`): the listing publishes before or after the room call's catalog, by daemon I/O
// against file I/O. Then the store watcher's refresh, a 400 ms / 2 s timer after the log's clear (`session-host-catalog.ts:170-180`),
// fires while the reset awaits its member checks (`agent-rooms.ts:391`) or after it answers.
const FORCED = {
  resetListings: {
    'listing-first': "the reset's read of the archived copy (agent-home-sessions.ts:73, startOver's last await before the room's record changes, agent-rooms.ts:379-385) is held until the reset's own listing has ended; that listing is held at its daemon call until the clear's summary flush has landed",
  },
  resetRefresh: {
    'after-answer': "the store refresh's start is gated from the reset's start until its answer is recorded",
    'in-io': "the reset is held at its first member check (daemon I/O) until the reset's own listing and then the store refresh have run to their end (loaded-failing: the daemon's session.list fails, so the reset's own listing ends at once and only the store refresh is awaited)",
  },
};
// The race of a reset with the catalog loaded, which Node leaves to timing: the reset's own listing (`void publishCatalogs()`,
// `session-host-lifecycle.ts:401`, numbered at `session-host-catalog.ts:229`) has the daemon load the summary index
// (`store-summary-reader.mjs:305` listJsonSummariesAsync → `store-summary-catalog.mjs:918` loadIndexAsync → `:650-653` the index's stamps,
// then, the stamps having moved, `:672` readLogBytesStep, `:623-625`, reading `session-summaries.log`) and then reconcile the cleared room
// log, reading `sessions/<room>.log.jsonl` (`:945` refreshAsync → `:853` reconcileSessionFileSteps → `store/session-log-reader.mjs:260` →
// `:141` readSessionLog), while the host saves the room records and publishes the room call's catalog, its cached rows
// (`agent-rooms.ts:387-388` persist, `republishCatalog` → `session-host.ts:353-354`). Two holds, each released on an event: the daemon's
// index load of that listing, at its first stat (`:652`; a cached index whose stamps did not move is not read again), by
// lib/daemon-read-hold.cjs, armed for the reset's own listing alone: on the session.list path (`session-action.mjs:160`
// listSessionCatalog), once the listings sent before it have answered; and the room call's publication, held at the room records' save,
// the last await before it (`agent-rooms.ts:387`). In both orders the index load goes on only after the clear's summary flush has landed
// (`roomLogFlushed`), so the listing reads the cleared log.
const RESET_READ = {
  daemonRead:
    "store-summary-reader.mjs:305 (listJsonSummariesAsync) → store-summary-catalog.mjs:918 (loadIndexAsync) → :650-653 (stamps of session-summaries.json/.log) → :672/:623-625 (readLogBytesStep of session-summaries.log), then :945 (refreshAsync) → :853 (reconcileSessionFileSteps) → store/session-log-reader.mjs:260 → :141 (readSessionLog of sessions/<room>.log.jsonl); the session.list of the reset's own listing (session-host-lifecycle.ts:401, session-host-catalog.ts:217-238)",
  hostPublication: 'agent-rooms.ts:387-388 (persist, then deps.republishCatalog) → session-host.ts:353-354 (publishSessionCatalog(sessionCatalog()))',
  orders: {
    'before-publication':
      "both holds reached, the clear's summary flush and the index rebuild landed: the daemon's index read is released, the reset's own listing (its read of the cleared log included) runs to its end, published or dropped, and only then the room records' save goes on to the room call's publication",
    'after-answer':
      "both holds reached, the clear's summary flush and the index rebuild landed: the room records' save goes on to the room call's publication and the reset answers; once its answer is recorded the daemon's index read is released and the reset's own listing (its read of the cleared log included) runs to its end, before the store refresh may start (resetRefresh in-io: the store refresh fires and starts while the reset awaits its member check, and its listing, answered by the daemon behind the held one, ends after the reset's own listing)",
  },
};
// The start-up's recovery against a room update, which Node leaves to I/O. `SessionHost.create` starts `recover` and does not await it
// (`session-host.ts:430-432`); it reads the room records (`agent-rooms.ts:466` loadRecords, `agent-room-records.ts:31-43`), awaits the first
// load (`agent-rooms.ts:469` ready, `:354-361`: records, names, `pruneDeleted`), marks each room a dead process left running interrupted
// (`:470-478`: `running` cleared, the interrupted row posted through the daemon, `:474`, the records saved, `:478`) and republishes the
// catalog (`:479` → `session-host.ts:353-356`; after a restart the catalog is not loaded: a whole listing, `session-host-catalog.ts:217-238`,
// whose rows are read when its daemon answer lands, `session-host.ts:789-812`). A room update awaits the same first load (`agent-rooms.ts:294`),
// refreshes the names (`:302`, listAgents: daemon I/O), changes the record (`:308-309`), saves it (`:310`) and republishes (`:312`). Whichever
// registered first on the first load (a promise runs its reactions in order), the update's change comes after a daemon round trip, and the
// recovery's listing (with an interrupted room, its post and save first) is daemon and file I/O too: the recovery's catalog is read before
// or after the update's change. Each order is forced by holds released on events.
const RECOVER_FRAME = /\brecover \(/;
const STARTUP = {
  recovery: "agent-rooms.ts:465-480 (recover: loadRecords :466, ready :469, the interrupted rooms :470-478, deps.republishCatalog :479), started by session-host.ts:430-432; republishCatalog → session-host.ts:353-356 (not loaded: void publishCatalogs, session-host-catalog.ts:217-238, rows read at session-host.ts:806-809)",
  update: 'agent-rooms.ts:293-320 (update: ready :294, refreshNames :302, the change :308-309, persist :310, deps.republishCatalog :312)',
  waiters: {
    'update-before-recovery':
      "the start-up's read of the room records (fs/promises.readFile of agent-rooms.json under loadRecords, agent-rooms.ts:466) is held; the update is called: its ready() starts the first load (agent-rooms.ts:355) and registers on it first; the read is released, and the recovery joins (agent-rooms.ts:469)",
    'recovery-joins':
      "the start-up's read of the room records is held; a bot in no room is forgotten (forgetMember, agent-rooms.ts:339-341, as the agent deletion calls it, session-host.ts:253): its ready() starts the first load; the read is released and the recovery joins it; the update is called while the first load is held at its member check (agentDefinitionPresence under pruneDeleted, agent-room-membership.ts:67) and registers after the recovery",
    interrupted:
      "a continue (agent-rooms.ts:408-414) starts the room's exchange, held at its read of the room's rows (agent-room-exchange.ts:186) after its start saved the room running (:135-137); the host is made again over those files, so its recovery has the room to mark interrupted; the update is called while the first load is held at its member check and registers after the recovery",
  },
  orders: {
    'recovery-first':
      "the update's names refresh (listAgents under refreshNames, agent-rooms.ts:302) is held until the recovery's republish (agent-rooms.ts:479) has run to its end (its listing published): the recovery's catalog is read before the update's change",
    'update-first':
      "update-before-recovery, recovery-joins: the recovery's listing is held at its daemon call (session.list) until the update's save of its change (agent-rooms.ts:310, the room records' temp file open) is reached, then runs to its end, and the save goes on: the recovery's catalog is read after the update's change. interrupted: the recovery's post of the interrupted row (appendRoomRows, agent-rooms.ts:474) is held until the update has answered and its own listing (agent-rooms.ts:312, the catalog not loaded) has run to its end; then the recovery saves and republishes",
  },
};
// The store watcher's refresh against a room call's own listing, for every call but a reset (whose two orders are `resetRefresh`). The
// refresh is a 400 ms / 2 s debounce after the store change the call made; the call's own listing (the rename's, `session-host-lifecycle.ts:225-233`)
// is a daemon round trip. Which publishes the changed catalog first, and so which origin the recording shows, depends on whether the call
// outlasts the debounce: Node does not order them, so a client cannot rely on either, and each order is recorded forced.
const FORCED_STORE_REFRESH = {
  'after-answer': "the default of every scenario: the store refresh's start is gated from the call's start until its answer is recorded, so the call's own listing publishes first (a call shorter than the debounce)",
  'before-answer': "the call's own listing is not started until the store refresh has fired and run to its end, so the refresh publishes inside the call (a call longer than the debounce)",
};
// Time and ids the product takes from its own process, fixed at the source. The room service reads `Date.now` once, when the host is made
// (`agent-rooms.ts:185`, `deps.now ?? Date.now`), and names a room `now().toString(36)` + `randomBytes(4)` (`:188`); the host passes no
// `now` or `newId` (`session-host.ts:227`). So the host is made while `Date.now` is this virtual clock (each step advances it by a minute), and
// `randomBytes` answers a counter to the calls that come from agent-rooms.ts, whatever the stack. Nothing else is changed: the daemon's own
// clock and ids are not in any recorded value.
const CLOCK_BASE_MS = Date.UTC(2026, 5, 7, 8, 9, 10);
const roomClock = { ms: CLOCK_BASE_MS };
// This machine's clock, which the daemon stamps with too, taken before the host's creation swaps `Date.now`.
const wallClock = Date.now.bind(Date);
{
  const randomBytes = crypto.randomBytes;
  let counter = 0;
  crypto.randomBytes = function (size, ...rest) {
    if (size === 4 && (new Error().stack ?? '').includes('agent-rooms.ts')) {
      counter += 1;
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(counter);
      return bytes;
    }
    return randomBytes.call(this, size, ...rest);
  };
  (await import('node:module')).syncBuiltinESMExports();
}
// The text of the injected save failure (an I/O error of the room records' file).
const SAVE_FAILURE = 'the room records could not be saved';
const only = args.get('only');
if (only && !SCENARIOS[only]) throw new Error(`--only ${only}: unknown scenario; known: ${Object.keys(SCENARIOS).join(', ')}`);
const names = only ? [only] : Object.keys(SCENARIOS);

const { daemonEnv, isolatedPaths } = await hload('env.mjs');
const { createDeadline, HangError, latch } = await hload('deadline.mjs');
/** A hold a step arms: `arrived` resolves when the held call reaches it, which goes on once the step calls `release`. */
const gateOf = () => {
  const reached = latch();
  const released = latch();
  return { reached, released, arrived: reached.promise, release: () => released.resolve() };
};
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
let roomsRead = null;
{
  const fsPromises = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { basename } = await import('node:path');
  // The start-up's read of the room records (`readJsonState` → `readFile` of `agent-rooms.json`), held when a step arms it.
  const readFile = fsPromises.readFile;
  fsPromises.readFile = async function (path, ...rest) {
    const hook = roomsRead;
    if (hook && basename(String(path)) === 'agent-rooms.json') {
      roomsRead = null;
      hook.reached.resolve();
      await hook.released.promise;
    }
    return readFile.call(this, path, ...rest);
  };
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
// The daemon's read hold (lib/daemon-read-hold.cjs, see its header): the daemon is forked with this process's flags
// (`session-client.mjs` ensureDaemon, `execArgv: process.execArgv`), so it loads the hold and connects here. Each scenario's daemon is
// the one connection its start awaits.
const DAEMON_READ_HOLD = 'benchmarks/rust-core/recorders/lib/daemon-read-hold.cjs';
process.execArgv = ['--require', join(REPO_ROOT, DAEMON_READ_HOLD)];
let daemonHello = null;
const holdServer = (await import('node:net')).createServer((socket) => {
  socket.setEncoding('utf8');
  const link = { socket, hold: null, watching: null, onAppended: null, rebuild: null, settled: null };
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.ev === 'hello') {
        if (!daemonHello) throw new RecorderError(`a process (pid ${message.pid}) loaded the daemon read hold while no daemon was starting`);
        daemonHello.resolve(link);
        daemonHello = null;
      } else if (message.ev === 'watching') link.watching.resolve();
      else if (message.ev === 'appended') link.onAppended?.(message.text);
      else if (message.ev === 'settled') {
        if (message.ok) link.settled.resolve();
        else link.settled.reject(new RecorderError(`the daemon's summary index writes did not settle: ${message.error ?? 'abandoned'}`));
      } else if (message.ev === 'rebuild-armed') link.rebuild?.armed.resolve();
      else if (message.ev === 'rebuild-reached') link.rebuild?.reached.resolve();
      else if (message.ev === 'rebuild-landed') {
        // Rebuilds nothing armed are the daemon's own business; the armed one's answer is awaited.
        if (!link.rebuild?.released) continue;
        if (message.ok) link.rebuild.landed.resolve();
        else link.rebuild.landed.reject(new RecorderError("the daemon's summary index rebuild failed"));
        link.rebuild = null;
      } else link.hold[message.ev].resolve();
    }
  });
  socket.on('error', (error) => {
    const failed = new RecorderError(`the daemon read hold's connection failed: ${error.message}`);
    link.hold?.armed.reject(failed);
    link.watching?.reject(failed);
    link.settled?.reject(failed);
    for (const part of ['armed', 'reached', 'landed']) link.rebuild?.[part].reject(failed);
  });
});
await new Promise((resolve) => holdServer.listen(0, '127.0.0.1', resolve));
holdServer.unref();
const parentEnv = { ...process.env };

async function record(name) {
  const scenario = SCENARIOS[name];
  // A fixed folder per scenario (it is in the recording: the task workspace and the sessions' cwd), made empty here.
  const envRoot = join(process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:\\mixdog-build\\tmp', `room-catalog-${name}`);
  rmSync(envRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  mkdirSync(envRoot, { recursive: true });
  roomClock.ms = CLOCK_BASE_MS;
  const paths = isolatedPaths(envRoot);
  for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
  // A route the bots name; no turn runs, so nothing is ever sent to it.
  const route = { provider: 'custom-harness', model: 'harness-model' };
  writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: 'http://127.0.0.1:9/v1', auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
  const isolated = daemonEnv(paths);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, isolated, { MIXDOG_RECORDER_READ_HOLD_PORT: String(holdServer.address().port) });
  const deadline = createDeadline(60_000, () => `room catalog states, scenario ${name}`);
  let discovery = null;
  let host = null;
  let finished = false;
  daemonHello = latch();
  const connected = daemonHello.promise;
  try {
    discovery = await deadline.race(sessionClient.ensureDaemon({ cwd: paths.workspace, attempts: 2, readyTimeoutMs: 60_000 }), 'the Node daemon');
    const daemonLink = await deadline.race(connected, "the daemon's read hold connecting to the recorder");
    // The daemon's next `fs/promises.<call>` of `file` on a stack naming `marker`, held once it is reached: resolves once the daemon has
    // armed it.
    const armDaemonRead = async (call, file, marker) => {
      const hold = { armed: latch(), reached: latch(), ended: latch() };
      daemonLink.hold = hold;
      daemonLink.socket.write(`${JSON.stringify({ op: 'arm', call, file, marker })}\n`);
      await deadline.race(hold.armed.promise, `the daemon arming the hold on its read of ${file}`);
      return { reached: hold.reached.promise, ended: hold.ended.promise, release: () => daemonLink.socket.write('{"op":"release"}\n') };
    };
    // The reset's clear reaching the summary index: resolves once the daemon's summary flush (`store-summary-index.mjs:529`
    // _scheduleSummaryFlush → `:619-622` appendFile of session-summaries.log) has appended a row of the room's log stamped at or after
    // this call (the daemon's clock is this machine's; every earlier row of the log was stamped before the reset began).
    const roomLogFlushed = async () => {
      const startedAt = wallClock();
      const flushed = latch();
      daemonLink.onAppended = (text) => {
        const ops = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
        if (!ops.some((op) => op.u?.id === room.sessionId && op.u.updatedAt >= startedAt)) return;
        daemonLink.onAppended = null;
        flushed.resolve();
      };
      daemonLink.watching = latch();
      daemonLink.socket.write('{"op":"watch","file":"session-summaries.log"}\n');
      await deadline.race(daemonLink.watching.promise, "the daemon watching its summary index's appends");
      return { landed: deadline.race(flushed.promise, "the reset's clear reaching the summary index") };
    };
    // The daemon's next summary index rebuild (`store/listing.mjs:111-142`, spawned by a cold listing while the index has no base,
    // `:378-380`), held before it runs: its scan of the session files and its base write (which empties the delta log) would otherwise
    // land on either side of the reset's clear and of the reset's own listing. Resolves once armed.
    const armRebuild = async () => {
      const rebuild = { armed: latch(), reached: latch(), landed: latch(), released: false };
      daemonLink.rebuild = rebuild;
      daemonLink.socket.write('{"op":"arm-rebuild"}\n');
      await deadline.race(rebuild.armed.promise, "the daemon arming its summary index rebuild hold");
      return {
        reached: rebuild.reached.promise,
        release: () => {
          rebuild.released = true;
          daemonLink.socket.write('{"op":"release-rebuild"}\n');
          return rebuild.landed.promise;
        },
      };
    };
    // Every summary index op the daemon has queued so far, landed (`settleSummaryIndexWrites`, store-summary-index.mjs:495). While any
    // is queued or in flight the daemon's listing answers its in-memory rows and reads no index (`store/listing.mjs:276`): the reset's
    // own listing is sent only once the clear's ops (queued before the clear answered) have landed, so it reads the index.
    const summaryIndexSettled = async () => {
      daemonLink.settled = latch();
      daemonLink.socket.write('{"op":"settle"}\n');
      await deadline.race(daemonLink.settled.promise, "the daemon's summary index writes to settle");
    };
    // The host's session.list calls not answered yet: the reset's own listing is sent once those before it have answered, so the
    // daemon's next index read on the session.list path after its hold is armed is that listing's.
    const listingsInFlight = new Set();
    // The daemon's answer to the host's listing; it fails while the running step's `failing` says so.
    let listingFails = false;
    // The reset's listing order (see `FORCED`, `RESET_READ`): `resetListings` is armed by the reset; `listingHold` holds the daemon's
    // answer to the reset's own listing (`listing-first`); `resetListingRead` is the context of the reset's own listing, whose
    // session.list arms the daemon read hold first and hands it to the reset by `resetReadArmed`.
    let resetListings = null;
    let listingHold = null;
    let resetListing = null;
    const resetListingRead = new AsyncLocalStorage();
    let resetReadArmed = null;
    let callHold = null;
    let memberListingGate = null;
    let releaseMemberListings = null;
    // The reset's own listing reads the cleared log only once the clear has reached the summary index (`store-summary-catalog.mjs:827-830`:
    // the index row that changed is what the listing re-reconciles, `:851-853`); before that its answer is the log's earlier row, and the
    // log is read by the next listing. Every recorded reset's own listing loads the index after the clear's summary flush (`roomLogFlushed`).
    let resetFlushed = null;
    // The start-up race (`STARTUP`): the recovery's listing runs in `recoveryListing`'s context, and its daemon call is held while
    // `recoveryListingHold` is set; `recoveryRepublished` is told the recovery's republish (its listing's run, or null when the catalog
    // was loaded and published from the rows in hand). The host's control calls held: the first load's member check (`presenceHold`),
    // the update's names refresh (`namesHold`) and the recovery's post of an interrupted row (`recoveryPostHold`).
    const recoveryListing = new AsyncLocalStorage();
    let recoveryListingHold = null;
    let recoveryRepublished = null;
    let presenceHold = null;
    let namesHold = null;
    let recoveryPostHold = null;
    const recoveryReported = (listing) => {
      const told = recoveryRepublished;
      recoveryRepublished = null;
      // Boxed: a latch resolved with the listing's promise would wait for the listing.
      told?.resolve({ listing });
    };
    const runtime = {
      ...createDesktopRuntime({ getLocalSessionBridge: () => null }),
      attachSessionClient: async (options) => {
        const attached = await sessionClient.attachSession({ discovery, cwd: paths.workspace, onFrame: options.onFrame, onFatal: options.onFatal });
        // `SessionHost.create` makes the host in the continuation of this await, synchronously: the clock is the virtual one for it alone.
        const realNow = Date.now;
        Date.now = () => roomClock.ms;
        setImmediate(() => {
          Date.now = realNow;
        });
        return createSessionProtocolClient({
          call: (method, params, callOptions) => {
            if (method !== 'session.list') return attached.call(method, params, callOptions);
            if (listingFails) return Promise.reject(new Error('the session listing failed'));
            let asked;
            if (resetListingRead.getStore()) {
              // The reset's own listing: the daemon's read of the summary index in it is armed before it is asked (`RESET_READ`).
              const armed = resetReadArmed;
              resetReadArmed = null;
              const before = [...listingsInFlight];
              asked = (async () => {
                try {
                  await deadline.race(Promise.allSettled(before), "the listings sent before the reset's own listing");
                  await summaryIndexSettled();
                  armed.resolve(await armDaemonRead('stat', 'session-summaries.json', 'listSessionCatalog'));
                } catch (error) {
                  armed.reject(error);
                  throw error;
                }
                return attached.call(method, params, callOptions);
              })();
            } else if (recoveryListingHold && recoveryListing.getStore()) {
              // The recovery's listing, held at its daemon call (`STARTUP`, update-first).
              const hold = recoveryListingHold;
              recoveryListingHold = null;
              hold.reached.resolve();
              asked = hold.released.promise.then(() => attached.call(method, params, callOptions));
            } else if (listingHold) {
              // The reset's own listing held until the clear has reached the summary index (`listing-first`).
              const hold = listingHold;
              listingHold = null;
              asked = hold.promise.then(() => attached.call(method, params, callOptions));
            } else asked = attached.call(method, params, callOptions);
            listingsInFlight.add(asked);
            const settled = () => listingsInFlight.delete(asked);
            asked.then(settled, settled);
            return asked;
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
    // The next store refresh's timer firing, without waiting for its run (`refreshFired` resolves with the run, which it then follows).
    let refreshStarted = null;
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
      // A room's title goes through the host's rename (`session-host.ts:316`), which awaits a whole listing of its own
      // (`session-host-lifecycle.ts:225-233`): what that listing publishes is the rename's.
      // The rooms' first load's member check (`pruneDeleted`, `agent-room-membership.ts:67`, through `agentPresence`,
      // `session-host.ts:296`): each check is an event with the ids it asks about, so a step shows whether a first load ran in it.
      const invokeControl = host.transport.invokeControl.bind(host.transport);
      // The start-up race's holds (`STARTUP`) are on the same calls: the member check, the update's names refresh, the recovery's post.
      host.transport.invokeControl = (name, params, ...rest) => {
        let hold = null;
        if (name === 'agentDefinitionPresence' && (new Error().stack ?? '').includes('pruneDeleted')) {
          events.push({ kind: 'prune-checked', ids: plain(params[0]) });
          hold = presenceHold;
          presenceHold = null;
        } else if (name === 'listAgents' && namesHold && (new Error().stack ?? '').includes('refreshNames')) {
          hold = namesHold;
          namesHold = null;
        } else if (name === 'appendRoomRows' && recoveryPostHold && RECOVER_FRAME.test(new Error().stack ?? '')) {
          hold = recoveryPostHold;
          recoveryPostHold = null;
        }
        if (!hold) return invokeControl(name, params, ...rest);
        hold.reached.resolve();
        return hold.released.promise.then(() => invokeControl(name, params, ...rest));
      };
      // The recovery's republish with the catalog loaded publishes the rows in hand (`session-host.ts:354`).
      const publishSessionCatalog = host.publishSessionCatalog.bind(host);
      host.publishSessionCatalog = (sessions) => {
        if (recoveryRepublished && RECOVER_FRAME.test(new Error().stack ?? '')) recoveryReported(null);
        return publishSessionCatalog(sessions);
      };
      const renameSession = host.lifecycle.renameSession.bind(host.lifecycle);
      host.lifecycle.renameSession = (sessionId, title) => origin.run('room-rename', () => renameSession(sessionId, title));
      // The store watcher's refresh (`session-host-catalog.ts:170-180`, a debounced timer per store change) publishes after its
      // listing's await, where the stack no longer names the timer: its timer is set in its own origin, which the timer keeps.
      const scheduleCatalogRefresh = host.catalog.scheduleCatalogRefresh.bind(host.catalog);
      host.catalog.scheduleCatalogRefresh = () => {
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
          refreshStarted?.resolve();
          refreshStarted = null;
          const waiting = refreshFired;
          refreshFired = null;
          waiting?.resolve(done);
          return done;
        }
        // The room call's own listing (the rename's) is not started until the store refresh has published (storeRefresh: 'before-answer'): a refresh
        // can only come first if it starts before the call's listing does, a listing in flight takes the refresh in behind it.
        if (callHold && origin.getStore() === 'room-rename') return callHold.then(() => publishCatalogs());
        const stack = new Error().stack ?? '';
        // The room log's own reset listing (`session-host-lifecycle.ts:401`, `void publishCatalogs()` inside the reset's `startOver`,
        // `agent-rooms.ts:379`): its daemon read ordered against the room call's publication (`RESET_READ`), or ended before the room
        // records' save (`FORCED`).
        if (resetListings && stack.includes('resetSessionConversation')) {
          const mode = resetListings;
          resetListings = null;
          if (mode === 'read') {
            resetListing = resetListingRead.run(true, () => publishCatalogs());
            return resetListing;
          }
          // `startSessionOver`'s read of the archived copy (`agent-home-sessions.ts:73`), the last await of `startOver` before the
          // reset changes the room's record (`agent-rooms.ts:379-385`, `room.lastAt`, which the catalog's room row carries), held
          // until this listing has ended: its publication is of the record before the reset's change.
          const readSession = host.readSession;
          let ended;
          const listingEnded = new Promise((resolve) => (ended = resolve));
          host.readSession = async (sessionId, ...rest) => {
            if (sessionId !== room.sessionId && !bots.some((id) => roomMemberSessionId(room.roomId, id) === sessionId)) {
              host.readSession = readSession;
              await deadline.race(listingEnded, "the reset's own listing to its end, before the archived copy's read");
            }
            return readSession.call(host, sessionId, ...rest);
          };
          listingHold = { promise: resetFlushed.landed.then(summaryIndexSettled) };
          resetListing = publishCatalogs();
          resetListing.finally(() => ended());
          return resetListing;
        }
        // The listings the reset of each member's own session starts and does not await (session-host-lifecycle.ts:401, one per member that
        // has a session): held until the reset's answer is recorded, so each one's publication is after the answer.
        if (stack.includes('resetSessionConversation') && memberListingGate) {
          const done = memberListingGate.then(() => publishCatalogs());
          background.push(done);
          return done;
        }
        const fromRoomCall = stack.includes('republishCatalog');
        if (!fromRoomCall) return publishCatalogs();
        events.push({ kind: 'background-listing-started' });
        const run = () => origin.run('room-call-background-listing', () => publishCatalogs());
        // The start-up recovery's listing (`agent-rooms.ts:479`) runs in its own context, which its daemon call's hold reads.
        const recovery = RECOVER_FRAME.test(stack);
        const done = recovery ? recoveryListing.run(true, run) : run();
        background.push(done);
        if (recovery) recoveryReported(done);
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
    // A bot in no room, which `recovery-joins` forgets at start-up (its first load's starter).
    let spareBot = null;
    if (scenario.spare) {
      const saved = await saveBot('Delta');
      spareBot = saved.id;
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
        if (scenario.resetRead) return await resetInReadOrder();
        resetListings = scenario.resetListings;
        if (resetListings === 'listing-first') resetFlushed = await roomLogFlushed();
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
        // `in-io` with the listing failing (`loaded-failing`: the daemon's session.list is never asked, so its read cannot race): the
        // reset held at its first member check (`agent-rooms.ts:391`, `deps.sessionExists` → `readSession`, `session-host.ts:299-301`,
        // daemon I/O) until the refresh has fired and run to its end.
        if (scenario.resetRefresh !== 'in-io') throw new RecorderError(`scenario ${name}: its reset declares no order of its store refresh`);
        if (!listingFails) throw new RecorderError(`scenario ${name}: a reset with the store refresh in its I/O and a listing that lists is recorded in a read order only`);
        const fired = nextRefresh();
        const check = holdMemberCheck();
        const resetting = host.agentRoomAction('reset', [room.roomId]);
        await deadline.race(check.arrived, "the reset's first member check");
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
      // The room's exchange started (`proceed`, `agent-rooms.ts:408-414`) and held at its read of the room's rows
      // (`agent-room-exchange.ts:186`), after its start saved the room running (`:135-137`); it never goes on (its host is made again next).
      'continue-held': async () => {
        const read = holdRoomLogRead();
        const answer = await host.agentRoomAction('continue', [room.roomId]);
        await deadline.race(read.arrived, "the room's exchange reading the room's rows after its start's save");
        events.push({ kind: 'exchange-held' });
        return answer;
      },
      // The host made again (no definition deleted), its start-up's recovery against a room update (`STARTUP`).
      'restart-and-update': () => startupRace(scenario.startup, scenario.startupOrder),
      'restart-and-list': async () => {
        await restart(false);
        await deadline.race(host.agentRooms.ready(), 'the first load after the restart');
        return await host.listSessions();
      },
    };
    let held = null;
    // Run once the step's answer is recorded (the `after-answer` reset opens its refresh gate there), and awaited.
    let afterAnswer = null;
    // A reset whose daemon read is ordered against its room call's publication (`RESET_READ`), its store refresh after its answer
    // (`after-answer`) or while it awaits its first member check (`in-io`: `agent-rooms.ts:391`, `deps.sessionExists` → `readSession`,
    // `session-host.ts:299-301`, daemon I/O, held until the refresh has fired and run to its end).
    const resetInReadOrder = async () => {
      resetListings = 'read';
      const read = latch();
      resetReadArmed = read;
      const flush = await roomLogFlushed();
      const rebuild = await armRebuild();
      // The room call's publication, held at the room records' save before it (`agent-rooms.ts:387`).
      const save = armRoomSave(false);
      let openRefresh;
      refreshGate = new Promise((resolve) => (openRefresh = resolve));
      const inIo = scenario.resetRefresh === 'in-io';
      const fired = inIo ? nextRefresh() : null;
      const started = inIo ? (refreshStarted = latch()) : null;
      if (!inIo) owedRefresh = nextRefresh();
      const check = inIo ? holdMemberCheck() : null;
      const resetting = host.agentRoomAction('reset', [room.roomId]);
      // Its rejection is the step's answer, taken below; the holds are awaited first.
      resetting.catch(() => {});
      const hold = await deadline.race(read.promise, "the reset's own listing arming the daemon's read of the summary index");
      await deadline.race(hold.reached, "the daemon's read of the summary index in the reset's own listing");
      // Both holds reached: the room records are changed (the save follows them), and the reset's own listing is at its index load.
      await deadline.race(save.arrived, "the room records' save of the reset");
      await flush.landed;
      // The index's rebuild, spawned by the reset's clear (its cold listing), runs once the clear has reached the summary index and
      // lands before the listing loads the index: the listing's index is the rebuilt base.
      await deadline.race(rebuild.reached, "the daemon's summary index rebuild during the reset");
      await deadline.race(rebuild.release(), "the daemon's summary index rebuild to land");
      const listingEnded = async () => {
        await deadline.race(hold.ended, "the daemon's read of the summary index to its end");
        await deadline.race(resetListing, "the reset's own listing to its end");
      };
      if (scenario.resetRead === 'before-publication') {
        hold.release();
        await listingEnded();
        save.release();
      } else {
        save.release();
        afterAnswer = async () => {
          hold.release();
          await listingEnded();
        };
      }
      if (inIo) {
        await deadline.race(check.arrived, "the reset's first member check");
        refreshGate = null;
        openRefresh();
        if (scenario.resetRead === 'before-publication') {
          const done = await deadline.race(fired, 'the store refresh to fire while the reset awaits its member check');
          await deadline.race(done, 'the store refresh while the reset awaits its member check');
        } else {
          // The refresh's listing cannot end while the reset's own listing is held in the daemon (the daemon answers it behind that
          // one): it fires and starts while the reset awaits its member check, and runs to its end after the reset's answer, behind the
          // reset's own listing (the step end awaits it).
          await deadline.race(started.promise, 'the store refresh to fire while the reset awaits its member check');
        }
        check.release();
      } else {
        const ordered = afterAnswer;
        afterAnswer = async () => {
          await ordered?.();
          refreshGate = null;
          openRefresh();
        };
      }
      return await resetting;
    };
    // The start-up's recovery and a room update that awaited the same first load, in `order` (`STARTUP`): the update's answer.
    const startupRace = async (waiters, order) => {
      const read = gateOf();
      roomsRead = read;
      const presence = gateOf();
      presenceHold = presence;
      await restart(false);
      await deadline.race(read.arrived, "the start-up's read of the room records");
      // The daemon's summary writes of the earlier host's sessions (its disposal's) landed before any call of the new host reads
      // the catalog: the update's listing reads them whichever order it runs in.
      await summaryIndexSettled();
      const update = () => {
        const call = CALLS['update-rounds']();
        call.catch(() => {});
        return call;
      };
      // `agentRoomAction` reaches `ready()` synchronously; a forgotten member reaches it in the room writes' queue (`writer`,
      // `agent-rooms.ts:198-203`), the job of a promise already settled, which runs before this function's next continuation.
      let updating = waiters === 'update-before-recovery' ? update() : null;
      let forgetting = null;
      if (waiters === 'recovery-joins') {
        forgetting = host.agentRooms.forgetMember(spareBot);
        forgetting.catch(() => {});
        await null;
      }
      read.release();
      await deadline.race(presence.arrived, "the first load's member check");
      updating ??= update();
      const recovered = latch();
      recoveryRepublished = recovered;
      if (order === 'recovery-first') {
        const names = gateOf();
        namesHold = names;
        presence.release();
        await deadline.race(names.arrived, "the update's names refresh");
        const { listing } = await deadline.race(recovered.promise, "the recovery's republish");
        if (listing) await deadline.race(listing, "the recovery's listing to its end");
        names.release();
      } else if (waiters !== 'interrupted') {
        const list = gateOf();
        recoveryListingHold = list;
        const save = armRoomSave(false);
        presence.release();
        await deadline.race(save.arrived, "the update's save of its change");
        const { listing } = await deadline.race(recovered.promise, "the recovery's republish");
        if (!listing) throw new RecorderError("the recovery published the rows in hand: the catalog was loaded before it");
        await deadline.race(list.arrived, "the recovery's listing at its daemon call");
        list.release();
        await deadline.race(listing, "the recovery's listing to its end");
        save.release();
      } else {
        const post = gateOf();
        recoveryPostHold = post;
        presence.release();
        await deadline.race(post.arrived, "the recovery's post of the interrupted row");
        const ordered = afterAnswer;
        afterAnswer = async () => {
          await deadline.race(Promise.all(background.splice(0)), "the update's own listing");
          // The post's write is the store change the watcher reports (its refresh timer is set only once the report arrives, after the
          // post answered): the step owes that refresh, so it ends only once it has fired and run to its end.
          owedRefresh = nextRefresh();
          post.release();
          const { listing } = await deadline.race(recovered.promise, "the recovery's republish");
          if (listing) await deadline.race(listing, "the recovery's listing to its end");
          await ordered?.();
        };
      }
      if (forgetting) await deadline.race(forgetting, 'the member forgotten');
      return await updating;
    };
    // The host's next read of the room log's session (the exchange's rows, `agent-room-exchange.ts:186` → `readItems`,
    // `session-host.ts:325`), held until released.
    const holdRoomLogRead = () => {
      const readSession = host.readSession;
      const gate = gateOf();
      host.readSession = async (sessionId, ...rest) => {
        if (sessionId === room.sessionId) {
          host.readSession = readSession;
          gate.reached.resolve();
          await gate.released.promise;
        }
        return readSession.call(host, sessionId, ...rest);
      };
      return gate;
    };
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
      roomClock.ms = CLOCK_BASE_MS + (index + 1) * 60_000;
      if (call !== 'reset') {
        if (scenario.storeRefresh === 'before-answer') {
          callHold = nextRefresh();
        } else {
          let open;
          refreshGate = new Promise((resolve) => (open = resolve));
          afterAnswer = () => {
            refreshGate = null;
            open();
          };
        }
      }
      if (call === 'reset') memberListingGate = new Promise((resolve) => (releaseMemberListings = resolve));
      let answer;
      try {
        const value = plain(await deadline.race(CALLS[call](), `the room call ${call}`));
        if (call === 'create') room = value;
        answer = { kind: 'answered', value };
      } catch (error) {
        // A wait of the recorder's that failed is not Node's answer.
        if (error instanceof RecorderError) throw error;
        if (error instanceof HangError) throw new RecorderError(error.message);
        answer = { kind: 'threw', message: String(error?.message ?? error) };
      }
      events.push(answer);
      const ordered = afterAnswer;
      afterAnswer = null;
      await ordered?.();
      releaseMemberListings?.();
      memberListingGate = null;
      releaseMemberListings = null;
      // The listing the call started in the background, to its end: what it published (or that it published nothing) is the call's.
      await deadline.race(Promise.all(background.splice(0)), `the background listing of ${call}`);
      callHold = null;
      await refreshes(call);
      steps.push({ step: call, listingFails, loadedBefore, loadedAfter: host.sessionCatalogLoaded, events: events.splice(0) });
    }
    finished = true;
    // The host's task workspace, where a room log is made (`agent-rooms.ts:284`), as the host itself names it.
    const taskWorkspace = await deadline.race(host.taskWorkspace(), 'the task workspace');
    const { failing: _, ...shape } = scenario;
    return { scenario: name, ...shape, taskWorkspace, bots, ...(spareBot ? { spareBot } : {}), botNames, room, steps };
  } finally {
    logEvents = null;
    roomSave = null;
    daemonHello = null;
    deadline.clear();
    if (host) await host.dispose().catch(() => {});
    if (discovery) await sessionClient.shutdownDaemon(discovery, { waitForExit: true, timeoutMs: 30_000 }).catch(() => {});
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, parentEnv);
    // A failed run keeps its environment (the daemon's crash captures and logs) and names it.
    if (!finished) console.error(`scenario ${name} failed; its environment is kept at ${envRoot}`);
    else {
      try {
        rmSync(envRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch (error) {
        // A process of the daemon's still holding a file of it: the recording stands, the environment is left and named.
        console.error(`scenario ${name}: its environment ${envRoot} could not be removed (${error.code}); remove it once its processes have ended`);
      }
    }
  }
}

// The daemon stamps a session row with its own process's clock (`createdAt`, `updatedAt`, `activityAt` of a session summary: the store's
// write times), which no injection reaches (the room service's own `createdAt`/`lastAt` are the virtual clock above and stay as they are).
// Each distinct stamp of a scenario becomes CLOCK_BASE_MS + 1000 * its order of first appearance in the recording: what the recording keeps
// of a stamp is which rows share it, not its value (the core's replay names them the same way, by first appearance). Declared in the manifest.
const DAEMON_STAMPS = ['createdAt', 'updatedAt', 'activityAt'];
function fixDaemonStamps(value, table = new Map()) {
  if (Array.isArray(value)) value.forEach((item) => fixDaemonStamps(item, table));
  else if (value && typeof value === 'object') {
    if ('messageCount' in value && 'cwd' in value) {
      for (const key of DAEMON_STAMPS) {
        if (typeof value[key] !== 'number') continue;
        if (!table.has(value[key])) table.set(value[key], CLOCK_BASE_MS + 1000 * table.size);
        value[key] = table.get(value[key]);
      }
    }
    for (const item of Object.values(value)) fixDaemonStamps(item, table);
  }
  return value;
}

mkdirSync(out, { recursive: true });
for (const name of names) {
  const recorded = fixDaemonStamps(await record(name));
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
      // The daemon read hold is loaded by the daemon (`--require`), not imported: listed as an input.
      ...recorderProvenance(import.meta.url, [DIFFERENCES, DAEMON_READ_HOLD]),
      // What the core sends differently from these recordings, each part named with its owner: the replay holds the core to it.
      coreDifferences: JSON.parse(readFileSync(join(REPO_ROOT, DIFFERENCES), 'utf8')),
      // Per scenario whose reset's listings could fall in either order: how the recorded order was forced.
      forcedOrders: Object.fromEntries(
        Object.entries(SCENARIOS).map(([n, s]) => [
          n,
          {
            storeRefresh: { order: s.storeRefresh ?? 'after-answer', how: FORCED_STORE_REFRESH[s.storeRefresh ?? 'after-answer'], appliesTo: 'every call but a reset' },
            ...(s.resetRead ? { resetRead: { order: s.resetRead, how: RESET_READ.orders[s.resetRead] } } : {}),
            ...(s.resetListings ? { resetListings: { order: s.resetListings, how: FORCED.resetListings[s.resetListings] } } : {}),
            ...(s.resetRefresh ? { resetRefresh: { order: s.resetRefresh, how: FORCED.resetRefresh[s.resetRefresh] } } : {}),
            ...(s.startupOrder ? { startupOrder: { waiters: s.startup, order: s.startupOrder, how: `${STARTUP.waiters[s.startup]}; ${STARTUP.orders[s.startupOrder]}` } } : {}),
          },
        ])
      ),
      // The start-up's recovery against a room update (`STARTUP`): its Node source lines, and per scenario how its order was forced.
      startupRace: {
        recovery: STARTUP.recovery,
        update: STARTUP.update,
        holds: {
          recordsRead: "fs/promises.readFile of agent-rooms.json (readJsonState, atomic-file.mjs:551-553, under loadRecords)",
          memberCheck: "the host's control call agentDefinitionPresence on a stack through pruneDeleted (agent-room-membership.ts:67)",
          namesRefresh: "the host's control call listAgents on a stack through refreshNames (agent-room-records.ts:56-59), armed after the first load's own refresh",
          recoveryListing: "the daemon call session.list of the listing the recovery's republish starts (its publishCatalogs on a stack through recover)",
          recoveryPost: "the host's control call appendRoomRows on a stack through recover (agent-room-log.ts:61)",
          updateSave: "the room records' save (atomic-file.mjs temp open of agent-rooms.json), agent-rooms.ts:310",
          exchange: "the host's read of the room log's session (readItems, session-host.ts:325) from the exchange's rows (agent-room-exchange.ts:186)",
        },
        cases: Object.fromEntries(Object.entries(SCENARIOS).filter(([, s]) => s.startupOrder).map(([n, s]) => [n, { waiters: s.startup, order: s.startupOrder }])),
      },
      // The race a reset with the catalog loaded leaves to timing, its Node source lines, and the holds that order it (`RESET_READ`).
      resetReadRace: {
        daemonRead: RESET_READ.daemonRead,
        hostPublication: RESET_READ.hostPublication,
        holds: {
          daemonRead: `${DAEMON_READ_HOLD}, loaded by the daemon: the reset's own listing's first fs/promises.stat of session-summaries.json (the start of its index load) on a stack through listSessionCatalog, armed over the recorder's TCP connection before that listing's session.list is sent (once the session.list calls sent before it have answered)`,
          summarySettle: `${DAEMON_READ_HOLD}: the reset's own listing is sent only once the daemon's settleSummaryIndexWrites (store-summary-index.mjs:495) has answered after the clear; while an op is queued or in flight the daemon answers a listing from its in-memory rows and reads no index (store/listing.mjs:276)`,
          clearFlush: "observed, not held: the daemon's fs/promises.appendFile of session-summaries.log carrying the room log's row stamped at or after the reset's start (store-summary-index.mjs:529, :619-622), reported over the same connection",
          indexRebuild: `${DAEMON_READ_HOLD}: the summary index rebuild worker the reset's clear spawns (store/listing.mjs:378-380 → :111-142, summary-rebuild-worker.mjs) started on a bootstrap that runs it when the recorder releases it, once the clear has reached the summary index; its answer is awaited before the reset's own listing loads the index. Unheld, its base write (store-summary-index.mjs:382-404, which empties the delta log) lands before or after that listing: before, the listing's index rows describe the room log (rows carry incomingTail and compactCount, store-summary-index.mjs:288-290); after, the index has no base and no rows (store-summary-catalog.mjs:742-745), so the listing reads the log and its row has neither (store-summary-catalog.mjs:315-346 rowFromSession, :433-441)`,
          hostPublication: "the room records' save (atomic-file.mjs temp open of agent-rooms.json), the last await before republishCatalog (agent-rooms.ts:387-388)",
        },
        cases: Object.fromEntries(Object.entries(SCENARIOS).filter(([, s]) => s.resetRead).map(([n, s]) => [n, { order: s.resetRead, resetRefresh: s.resetRefresh, how: RESET_READ.orders[s.resetRead] }])),
        // What the replay compares for the after-answer read order.
        core: "The core has no daemon read to race: a reset publishes its room's row in its room pass, at a fixed point before its answer (native/core/crates/mixdog-core-session/src/session/thread_list.rs:545), and its own listing reads the core's index, not a daemon. Its order is the read-before-publication one, with nothing published after the answer, which Node also produces: the reset's own listing (session-host-lifecycle.ts:401, its daemon read store-summary-catalog.mjs:623-625 from reconcileSessionFile :377) ending before the room call's publication (agent-rooms.ts:387-388), the store refresh inside the reset's I/O (loaded-reset-refresh-in-io). So for the two -read-after-answer cases the replay compares the core's reset, after the answer, whole with loaded-reset-refresh-in-io's same step and part (coreDifferences entries with compareWith), and every other part with the case's own recording.",
      },
      // Normalised after the run, the one place (see fixDaemonStamps).
      normalized: {
        paths: `every object with messageCount and cwd (a session summary), keys ${DAEMON_STAMPS.join(', ')}`,
        reason: 'stamped by the daemon process with its real clock, which nothing injects',
        how: 'CLOCK_BASE_MS + 1000 * order of first appearance of the distinct value in the scenario',
      },
      // Fixed at the source, not normalised: the folder of each scenario, the clock and the ids the room service takes (see CLOCK_BASE_MS).
      fixedAtSource: {
        envFolder: 'room-catalog-<scenario> under the scratch root, emptied before the run',
        clock: `the host is made while Date.now is ${new Date(CLOCK_BASE_MS).toISOString()} + one minute per step`,
        roomIds: "randomBytes(4) from agent-rooms.ts answers 1, 2, ... (big-endian), so a room's id is the clock's base 36 and the counter",
      },
      harness: Object.fromEntries(PINNED.map((n) => [`lib/${n}`, sha256(join(harness, 'lib', n))])), scenarios: names },
  });
}
process.exit(0);
