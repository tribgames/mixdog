// Records, from Node's real download service (apps/desktop/src/main/file-downloads.ts) behind its real phone method table
// (`fileDownloadRemoteMethods`) and wire executor (`executeRemoteFrame`), what a paired phone's five download calls answer: the
// authorization (a grant that expires), the begin that consumes it once, the range reads, finish, abort, the limits, and what an
// unpair (`revokeDevice`) does to an unused grant, a begun transfer and a call in flight.
//
// Time is the recorder's own and moves only by an explicit `advance` step: the service reads the clock it is given (`now`), and every timer
// it arms (the 15 s sweeper) goes to a virtual queue that runs due timers in due-time then registration order, one at a time, with the
// microtasks drained between them. Nothing waits on a real timer.
//
// The recording is a script: each step is a file operation, a clock advance, a revoke, or a phone call with the whole frame the phone got.
// The random ids and the file versions (they hold the file's inode) are replaced by `<kind#n>`, numbered by first appearance over the whole
// recording; every other value is Node's.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
// `--replay <mixdogd>`: the phone's calls of the recording sent through the adapter to a real core (no Node tree is read).
if (args.get('replay')) {
  const { replayDownloads } = await import('./lib/file-downloads-replay.mjs');
  const { readFileSync } = await import('node:fs');
  const recording = JSON.parse(readFileSync(join(FIXTURES_ROOT, 'file-downloads', 'file-downloads.json'), 'utf8'));
  process.exit((await replayDownloads({ exe: args.get('replay'), recording, only: args.get('only') ?? null })).code);
}
// `--only <scenario name>`: the whole recording is made (each scenario's code runs in order, and the tokens are numbered over all of it), and
// only that scenario is printed; nothing is staged or committed. The full run, without it, is what produces the fixture.
const only = args.get('only') ?? null;
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, args.get('commit') ?? (() => { throw new Error('--commit is required'); })());
const recorder = 'benchmarks/rust-core/recorders/record-file-downloads.mjs';
const finalDir = join(FIXTURES_ROOT, 'file-downloads');
const stage = stageSet(finalDir);

// ── the virtual clock and timer queue ──
const CLOCK_START = Date.UTC(2031, 0, 1);
const clock = { now: CLOCK_START, seq: 0, timers: new Map() };
const real = { setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout, clearInterval: globalThis.clearInterval, clearTimeout: globalThis.clearTimeout };
const arm = (fn, ms, every) => {
  const id = ++clock.seq;
  const timer = { id, fn, due: clock.now + Math.max(0, ms || 0), seq: id, every, unref() { return timer; }, ref() { return timer; } };
  clock.timers.set(id, timer);
  return timer;
};
globalThis.setTimeout = (fn, ms) => arm(fn, ms);
globalThis.setInterval = (fn, ms) => arm(fn, ms, ms);
globalThis.clearTimeout = globalThis.clearInterval = (timer) => void (timer && clock.timers.delete(timer.id));
/** A wait on something the recorder must see happen (a call's answer, a call reaching its gate, a release): it ends the recorder, after `ms` of
 *  real time, with a message naming what did not happen. It ends the process rather than rejecting: a rejection inside a hook the service
 *  awaits would reach the service as the call's own failure and be recorded as Node's answer. The virtual queue never runs a real deadline, so
 *  this is the one real timer of the recorder. */
const within = (promise, what, ms = 20_000) =>
  new Promise((resolve, reject) => {
    const timer = real.setTimeout(() => {
      console.error(`the recorder waited ${ms} ms for ${what}, which did not happen`);
      process.exit(1);
    }, ms);
    promise.then(
      (value) => (real.clearTimeout(timer), resolve(value)),
      (error) => (real.clearTimeout(timer), reject(error))
    );
  });
/** The closes the service has started and Node has not completed: a close is a file-system request finished by the loop, not by a timer. It is
 *  the only work the service leaves running after a call has answered or a timer has fired (a sweep and a revoke close handles and do
 *  nothing else asynchronous), so waiting for exactly these is waiting for the work itself. */
const closing = new Set();
const settle = async () => {
  while (closing.size) await within(Promise.allSettled([...closing]), 'the closes the service started to complete');
};
const advance = async (ms) => {
  const target = clock.now + ms;
  await settle();
  for (;;) {
    let next;
    for (const timer of clock.timers.values()) {
      if (timer.due <= target && (!next || timer.due < next.due || (timer.due === next.due && timer.seq < next.seq))) next = timer;
    }
    if (!next) break;
    clock.now = Math.max(clock.now, next.due);
    if (next.every) {
      next.due += next.every;
      next.seq = ++clock.seq;
    } else clock.timers.delete(next.id);
    next.fn();
    await settle();
  }
  clock.now = target;
  await settle();
};

const { createFileDownloadService, fileDownloadRemoteMethods, fileDownloadTestHooks } = await importFrom(tree, 'apps/desktop/src/main/file-downloads.ts');
const { executeRemoteFrame } = await importFrom(tree, 'apps/desktop/src/main/remote-methods.ts');

const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'file-downloads-record-')));
const PROJECT = join(dir, 'project');
const TASK = join(dir, 'task');
const OUTSIDE = join(dir, 'outside');
for (const folder of [PROJECT, join(PROJECT, 'sub'), TASK, OUTSIDE]) mkdirSync(folder, { recursive: true });
// The service stages a folder's zip or an attachment's bytes in a `mixdog-download-*` folder of the system temp folder (`os.tmpdir()`,
// read at each call): the recorder's own, so what is staged is what it counts.
const STAGING = realpathSync.native(mkdtempSync(join(tmpdir(), 'file-downloads-staging-')));
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = STAGING;

// The host's conversations: s1 is a project conversation, s2 a task conversation (no project).
const allSessions = [
  { id: 's1', classification: 'project', projectPath: PROJECT, cwd: PROJECT },
  { id: 's2', classification: 'task', projectPath: null, cwd: TASK },
];
const sessions = [...allSessions];
/** The host's media store: asset id -> the file it resolves to (Node's `invokeCapability('resolveMediaFile', [id, { variant: 'original' }])`). An
 *  asset the store does not know resolves to `null`; one whose bytes are gone is `available: false`. */
const assets = new Map();
// The registered projects: Node's own registry (`DesktopProjectRegistry` over the core's `projects.mjs` store) in this run's folder. The
// host's `projectDirectory` is the session host's (`session-host.ts:715-718`: `projectScope` -> `knownPath`, then `canonicalDirectory`);
// this world has no managed worktrees, so `projectScope`'s worktree fallback finds none.
process.env.MIXDOG_PROJECTS_FILE = join(dir, 'registry', 'projects.json');
const projectsStore = await importFrom(tree, 'src/runtime/shared/projects.mjs');
const { DesktopProjectRegistry } = await importFrom(tree, 'apps/desktop/src/main/desktop-project-registry.ts');
const registry = new DesktopProjectRegistry({ loadProjectsModule: async () => projectsStore, userDataRoot: () => join(dir, 'registry') });
await registry.register(PROJECT);
const host = {
  listSessions: async () => sessions,
  projectDirectory: async (path) => {
    const canonical = realpathSync.native(await registry.knownPath(path));
    if (!(await fsPromises.stat(canonical)).isDirectory()) throw new TypeError('Session workspace is not a directory.');
    return canonical;
  },
  invokeCapability: async (name, [assetId] = []) => {
    if (name !== 'resolveMediaFile' || !assets.has(assetId)) return { value: null };
    const { file, mime } = assets.get(assetId);
    return { value: existsSync(file) ? { path: file, mime } : { available: false } };
  },
  // The conversations' rows that name attachments (`sessionAttachments` reads a user row's `attachments`): the transcript window, and the
  // whole stored history the window may not hold; and the content-addressed store's bytes by id (base64, as the host answers).
  readSessionTranscript: async (sessionId) => ({ items: (transcripts.get(sessionId) ?? []).filter((row) => row.window) }),
  readSessionHistory: async (sessionId) => ({ items: transcripts.get(sessionId) ?? [] }),
  readAttachmentImage: async (id) => blobs.get(id) ?? null,
};
/** Per conversation, the user rows naming attachments (`window`: also in the transcript window, else only in the history). */
const transcripts = new Map();
/** The attachment store: id -> base64 bytes. */
const blobs = new Map();

// ── the gates a call in flight is held at ──
const gates = new Map();
const gate = (name) => {
  let release;
  let reached;
  const held = new Promise((resolve) => (release = resolve));
  const arrived = new Promise((resolve) => (reached = resolve));
  gates.set(name, { hold: async () => { reached(); await within(held, `the release of the ${name} gate`); }, arrived: within(arrived, `a call to reach the ${name} gate`), release });
  return gates.get(name);
};
/** The handles the service has opened and not closed: what a grant or a transfer holds (the service closes them when it drops one). */
const openHandles = new Set();
const trackHandle = (handle) => {
  openHandles.add(handle);
  const close = handle.close.bind(handle);
  handle.close = (...given) => {
    const done = close(...given).finally(() => {
      openHandles.delete(handle);
      closing.delete(done);
    });
    closing.add(done);
    return done;
  };
};
const wrapHandle = (handle) => {
  for (const method of ['read', 'stat']) {
    const original = handle[method].bind(handle);
    handle[method] = async (...given) => {
      const armed = gates.get(method);
      if (armed) {
        gates.delete(method);
        await armed.hold();
      }
      return original(...given);
    };
  }
};
fileDownloadTestHooks.opened = (handle) => {
  trackHandle(handle);
  wrapHandle(handle);
};
fileDownloadTestHooks.afterResolve = async () => {
  const armed = gates.get('afterResolve');
  if (armed) {
    gates.delete('afterResolve');
    await armed.hold();
  }
};

// The service's `fs/promises` calls the recorder must see: a staged folder's removal (`dropExport`'s `rm`, not awaited by the service) is
// work it leaves running, so `settle` waits for it as for a close; and the zip's open of a listed file is where the `zipOpen` gate holds
// a call (after the walk listed the folder, before the file is read). Builtin bindings are live once synced.
const realRm = fsPromises.rm;
fsPromises.rm = (...given) => {
  const done = realRm(...given).finally(() => closing.delete(done));
  closing.add(done);
  return done;
};
const realOpen = fsPromises.open;
fsPromises.open = async (target, ...given) => {
  const armed = gates.get('zipOpen');
  if (armed && String(target).startsWith(dir)) {
    gates.delete('zipOpen');
    await armed.hold();
  }
  return realOpen(target, ...given);
};
// `stageTemporaryDownload` writes its payload after the staging record is added: the `stageWrite` gate holds a call there.
const realWriteFile = fsPromises.writeFile;
fsPromises.writeFile = async (target, ...given) => {
  const armed = gates.get('stageWrite');
  if (armed && String(target).startsWith(STAGING)) {
    gates.delete('stageWrite');
    await armed.hold();
  }
  return realWriteFile(target, ...given);
};
syncBuiltinESMExports();

const devices = { phone: { deviceId: 'aaaaaaa1' }, tablet: { deviceId: 'bbbbbbb2' }, 'connection:c1': { deviceId: 'connection:c1' }, 'connection:c2': { deviceId: 'connection:c2' } };
let service;
let tables;
/** What the method table asked of the service, in order, with the arguments it passed (less the requester): the five calls the service
 *  serves. A call whose arguments the table refuses never reaches it. This is Node's own statement of what each phone call means to the
 *  service, which the core's replays derive their expected requests from. */
const SERVICE_CALLS = ['authorize', 'begin', 'readRange', 'finish', 'abort'];
let reached = [];
const watched = (inner) =>
  Object.fromEntries(
    Object.entries(inner).map(([name, member]) => [name, SERVICE_CALLS.includes(name) ? (requester, ...given) => (reached.push({ method: name, args: given }), member(requester, ...given)) : member])
  );
const stagedNow = () => readdirSync(STAGING).filter((name) => name.startsWith('mixdog-download-'));
/** What earlier scenarios' services left staged (their timers no longer run): a scenario counts only its own. */
let stagedBefore = new Set();
/** Each scenario runs on a service of its own, at the start of the clock, with no timer of an earlier one armed. */
const fresh = () => {
  stagedBefore = new Set(stagedNow());
  clock.timers.clear();
  clock.now = CLOCK_START;
  openHandles.clear();
  closing.clear();
  assets.clear();
  transcripts.clear();
  blobs.clear();
  reached = [];
  sessions.splice(0, sessions.length, ...allSessions);
  service = watched(createFileDownloadService({ host, mediaLane: true, now: () => clock.now }));
  tables = Object.fromEntries(Object.entries(devices).map(([name, requester]) => [name, fileDownloadRemoteMethods(service, () => requester)]));
};

let nextId = 1;
const pending = new Map();
/** The whole frame the phone gets for one call (the wire executor of the relay's method table). */
const wire = (device, method, params) => {
  const id = nextId++;
  const from = reached.length;
  const frame = executeRemoteFrame(tables[device], JSON.stringify({ id, method, params }));
  return { id, frame, from };
};

const path = (name) => join(dir, name);
const scenarios = [];
let steps;
const begin = (name, note) => {
  fresh();
  steps = [];
  scenarios.push({ name, note, steps });
};
const step = (entry) => void steps.push(entry);
const fileOps = {
  write: ({ file, text }) => writeFileSync(path(file), text),
  append: ({ file, text }) => appendFileSync(path(file), text),
  size: ({ file, bytes }) => truncateSync(path(file), bytes),
  remove: ({ file }) => rmSync(path(file), { force: true }),
  mkdir: ({ file }) => mkdirSync(path(file), { recursive: true }),
  rename: ({ file, to }) => renameSync(path(file), path(to)),
  // The folder `file` is replaced by a junction (a symlink off Windows) to the folder `target`: an ancestor swapped for a link.
  junction: ({ file, target }) => {
    rmSync(path(file), { recursive: true, force: true });
    symlinkSync(path(target), path(file), 'junction');
  },
};
const file = (op, entry) => {
  fileOps[op](entry);
  step({ op, ...entry });
};
const call = async (device, method, params, { key } = {}) => {
  const sent = wire(device, method, params);
  const promise = sent.frame;
  if (key) {
    const sending = { op: 'send', key, device, method, params };
    pending.set(key, { id: sent.id, promise, from: sent.from, sending });
    step(sending);
    return null;
  }
  const frame = await within(promise, `the answer to ${method}`);
  step({ op: 'call', device, method, params, service: reached.slice(sent.from), frame });
  return frame;
};
const answer = async (key) => {
  const held = pending.get(key);
  pending.delete(key);
  const frame = await within(held.promise, `the answer to the held ${key} call`);
  held.sending.service = reached.slice(held.from);
  step({ op: 'answer', key, frame });
  return frame;
};
/** An asset the host's media store holds: a file of `assets/<name>` in the store, with the type the store states for it. */
const media = ({ id, name, mime, text }) => {
  const file = path(`media/assets/${name}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  assets.set(id, { file, mime });
  step({ op: 'media', id, name, mime, text });
};
/** An index entry whose stored file is empty: Node's store resolves it to the assets folder itself (`storedAssetPath`, `store.mjs:173`:
 *  `resolve(root, '') === root` is accepted, and the folder exists), so `resolveMediaFile` hands the service the folder. */
const mediaRoot = (id) => {
  const root = path('media/assets');
  mkdirSync(root, { recursive: true });
  assets.set(id, { file: root, mime: '' });
  step({ op: 'mediaRoot', id });
};
const unmedia = (id) => {
  rmSync(assets.get(id).file);
  step({ op: 'unmedia', id });
};
const wait = async (ms) => {
  step({ op: 'advance', ms });
  await advance(ms);
};
const revokeDevice = (device) => {
  service.revokeDevice(devices[device].deviceId);
  step({ op: 'revokeDevice', device, deviceId: devices[device].deviceId });
};
const revokeAll = () => {
  service.revokeAll();
  step({ op: 'revokeAll' });
};
/** The host's catalog is published listing exactly `ids` (the relay's `onSessions` -> `retainSessions`): a conversation it no longer lists is deleted. */
const catalog = (ids) => {
  sessions.splice(0, sessions.length, ...allSessions.filter((row) => ids.includes(row.id)));
  service.retainSessions(ids);
  step({ op: 'sessions', ids });
};
/** How many handles the service holds open now, after everything that can run without a timer has run. */
const handles = async () => {
  await settle();
  step({ op: 'handles', open: openHandles.size });
};
/** How many staged downloads are on disk now (the service's `mixdog-download-*` folders), after every removal it started has ended. */
const staged = async () => {
  await settle();
  step({ op: 'staged', count: stagedNow().filter((name) => !stagedBefore.has(name)).length });
};
const release = async (name, held) => {
  step({ op: 'release', gate: name });
  held.release();
};
const request = (kind, extra, purpose = 'save') => ({ source: { kind, sessionId: 's1', ...extra }, purpose });
const session = (name, sessionId = 's1') => ({ source: { kind: 'session', sessionId, path: path(name) }, purpose: 'save' });
const grantOf = (frame) => frame.value.grantId;
const transferOf = (frame) => frame.value.transferId;
const versionOf = (frame) => frame.value.version;
const WRONG_VERSION = 'A'.repeat(43);
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

// ── 1. the two stages ──
begin('authorize then begin', 'the grant, its single use, what a second begin and an unknown grant answer');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
let grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
let lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadBegin', [MISSING_ID]);
await call('phone', 'fileDownloadBegin', ['not-an-id']);
await call('phone', 'fileDownloadBegin', []);
await call('tablet', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);

// ── 2. range reads ──
begin('range reads', 'windows, the end of the file, the arguments, a wrong version');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
const [id, version] = [transferOf(lease), versionOf(lease)];
await call('phone', 'fileDownloadRange', [id, 0, 4, version]);
await call('phone', 'fileDownloadRange', [id, 4, 4, version]);
await call('phone', 'fileDownloadRange', [id, 12, 100, version]);
await call('phone', 'fileDownloadRange', [id, 0, 16, version]);
await call('phone', 'fileDownloadRange', [id, 16, 4, version]);
await call('phone', 'fileDownloadRange', [id, 17, 4, version]);
await call('phone', 'fileDownloadRange', [id, 0, 0, version]);
await call('phone', 'fileDownloadRange', [id, 0, 4 * 1024 * 1024 + 1, version]);
await call('phone', 'fileDownloadRange', [id, -1, 4, version]);
await call('phone', 'fileDownloadRange', [id, 1.5, 4, version]);
await call('phone', 'fileDownloadRange', [id, 256 * 1024 * 1024 + 1, 4, version]);
await call('phone', 'fileDownloadRange', ['0', 0, 4, version]);
await call('phone', 'fileDownloadRange', [id, 0, 4, 'short']);
await call('phone', 'fileDownloadRange', [id, 0, 4, WRONG_VERSION]);
await call('phone', 'fileDownloadRange', [MISSING_ID, 0, 4, version]);
await call('phone', 'fileDownloadRange', [id, '0', 4, version]);
await call('phone', 'fileDownloadRange', [id, 0, 4, version]);
begin('range of an empty file', 'size 0: the one window, at offset 0');
file('write', { file: 'empty.bin', text: '' });
grant = await call('phone', 'fileDownloadAuthorize', [session('empty.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 1, 4, versionOf(lease)]);
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);

// ── 3. finish and abort ──
begin('finish and abort', 'finish ends the transfer, abort releases a transfer or an unbegun grant and says whether it did');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await call('phone', 'fileDownloadFinish', ['x']);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('tablet', 'fileDownloadAbort', [transferOf(lease)]);
await call('phone', 'fileDownloadAbort', [transferOf(lease)]);
await call('phone', 'fileDownloadAbort', [transferOf(lease)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('tablet', 'fileDownloadAbort', [grantOf(grant)]);
await call('phone', 'fileDownloadAbort', [grantOf(grant)]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadAbort', [MISSING_ID]);
await call('phone', 'fileDownloadAbort', ['x']);
await call('phone', 'fileDownloadAbort', []);

// ── 4. the grant's lifetime ──
begin('grant expiry', 'a grant lives 60 000 ms from the clock at authorize: begin 1 ms before the limit succeeds, at the limit it is gone');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await wait(59_999);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await wait(60_000);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await wait(60_001);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await wait(30_000);
const second = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await wait(30_000);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadBegin', [grantOf(second)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await wait(60_000);
await call('phone', 'fileDownloadAbort', [grantOf(grant)]);

begin('lease idle and absolute lifetime', 'a transfer ends 120 000 ms after its last read, and 1 800 000 ms after begin however active');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await wait(119_999);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await wait(119_999);
await call('phone', 'fileDownloadRange', [transferOf(lease), 4, 4, versionOf(lease)]);
await wait(120_000);
await call('phone', 'fileDownloadRange', [transferOf(lease), 8, 4, versionOf(lease)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
for (let read = 0; read < 17; read += 1) {
  await wait(100_000);
  await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
}
await wait(99_999);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await wait(1);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);

// ── 5. limits ──
begin('grants per device', 'a device holds 8 unbegun grants: the 9th authorize drops the oldest; another device is unaffected');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
const grants = [];
for (let n = 0; n < 9; n += 1) grants.push(await call('phone', 'fileDownloadAuthorize', [session('a.bin')]));
const other = await call('tablet', 'fileDownloadAuthorize', [session('a.bin')]);
await call('phone', 'fileDownloadBegin', [grantOf(grants[0])]);
await call('phone', 'fileDownloadBegin', [grantOf(grants[1])]);
await call('phone', 'fileDownloadBegin', [grantOf(grants[8])]);
await call('phone', 'fileDownloadBegin', [grantOf(other)]);
await call('tablet', 'fileDownloadBegin', [grantOf(other)]);

begin('transfers per device', 'a device runs 4 transfers; the 5th begin is busy and its grant is spent; a finished one frees a place');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
const leases = [];
for (let n = 0; n < 4; n += 1) {
  const g = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
  leases.push(await call('phone', 'fileDownloadBegin', [grantOf(g)]));
}
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
grant = await call('tablet', 'fileDownloadAuthorize', [session('a.bin')]);
await call('tablet', 'fileDownloadBegin', [grantOf(grant)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('phone', 'fileDownloadFinish', [transferOf(leases[0])]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);

begin('file size', 'exactly 256 MiB is allowed; one byte more is too large');
file('write', { file: 'exact.bin', text: '' });
file('size', { file: 'exact.bin', bytes: 256 * 1024 * 1024 });
file('write', { file: 'over.bin', text: '' });
file('size', { file: 'over.bin', bytes: 256 * 1024 * 1024 + 1 });
grant = await call('phone', 'fileDownloadAuthorize', [session('exact.bin')]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadAuthorize', [session('over.bin')]);
file('remove', { file: 'exact.bin' });
file('remove', { file: 'over.bin' });

// ── 6. what a request names ──
begin('sources', 'a project file by its relative path, a session path inside and outside the project, and what is refused');
file('write', { file: 'project/out.bin', text: 'project bytes' });
file('write', { file: 'project/sub/deep.txt', text: 'deep' });
file('write', { file: 'outside/note.md', text: 'outside bytes' });
file('write', { file: 'task/work.txt', text: 'task bytes' });
file('mkdir', { file: 'project/folder' });
await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: 'out.bin' }, 'save')]);
await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: 'sub/deep.txt' }, 'share')]);
await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: 'sub/../out.bin' }, 'open')]);
await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: '../outside/note.md' })]);
await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: 'missing.bin' })]);
await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: 'folder' })]);
await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: path('outside/note.md') })]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'project', sessionId: 's2', relPath: 'work.txt' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'project', sessionId: 's9', relPath: 'work.txt' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [session('project/out.bin')]);
await call('phone', 'fileDownloadAuthorize', [session('outside/note.md')]);
await call('phone', 'fileDownloadAuthorize', [session('task/work.txt', 's2')]);
await call('phone', 'fileDownloadAuthorize', [session('outside/missing.md')]);
await call('phone', 'fileDownloadAuthorize', [session('project/folder')]);
await call('phone', 'fileDownloadAuthorize', [session('outside')]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: '//server/share/x.txt' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [session('outside/note.md', 's9')]);

begin('request arguments', 'what the method table refuses before any file is touched');
await call('phone', 'fileDownloadAuthorize', []);
await call('phone', 'fileDownloadAuthorize', [null]);
await call('phone', 'fileDownloadAuthorize', [[]]);
await call('phone', 'fileDownloadAuthorize', [{ purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: path('a.bin') } }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: path('a.bin') }, purpose: 'keep' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'zip', sessionId: 's1' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 5, path: 'x' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 'a b', path: 'x' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: '' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: 'a\0b' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: 'x'.repeat(4097) }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'project', sessionId: 's1', relPath: path('a.bin') }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'project', sessionId: 's1', relPath: '  ' }, purpose: 'save' }]);

// ── 7. the file changing ──
begin('the file changes', 'before begin the grant is spent and refused; during the transfer the next read refuses and the transfer is gone; finish refuses and ends it');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
file('append', { file: 'a.bin', text: 'x' });
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
file('append', { file: 'a.bin', text: 'x' });
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
file('append', { file: 'a.bin', text: 'x' });
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
file('remove', { file: 'a.bin' });
await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);

// ── 8. who a grant belongs to, and what a reconnect sees ──
begin('the device', 'a grant and a transfer belong to the paired device, not to a connection: another device cannot use them, a connection without a credential is its own device');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('tablet', 'fileDownloadBegin', [grantOf(grant)]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('tablet', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await call('tablet', 'fileDownloadFinish', [transferOf(lease)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
grant = await call('connection:c1', 'fileDownloadAuthorize', [session('a.bin')]);
await call('connection:c2', 'fileDownloadBegin', [grantOf(grant)]);
await call('connection:c1', 'fileDownloadBegin', [grantOf(grant)]);

// ── 9. unpair ──
begin('unpair', 'revoking a device ends its unbegun grants and its transfers at once, whatever connection asks; another device keeps its own');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
const unbegun = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
grant = await call('tablet', 'fileDownloadAuthorize', [session('a.bin')]);
const tabletLease = await call('tablet', 'fileDownloadBegin', [grantOf(grant)]);
const tabletUnbegun = await call('tablet', 'fileDownloadAuthorize', [session('a.bin')]);
revokeDevice('phone');
await handles();
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await call('phone', 'fileDownloadBegin', [grantOf(unbegun)]);
await call('phone', 'fileDownloadAbort', [transferOf(lease)]);
await call('tablet', 'fileDownloadRange', [transferOf(tabletLease), 0, 4, versionOf(tabletLease)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await handles();
await call('tablet', 'fileDownloadBegin', [grantOf(tabletUnbegun)]);
await call('tablet', 'fileDownloadRange', [transferOf(tabletLease), 0, 4, versionOf(tabletLease)]);

begin('revoke all', 'revoking every device (the relay closing, or every pairing revoked) ends all unbegun grants and all transfers at once');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
const phoneGrant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
grant = await call('tablet', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('tablet', 'fileDownloadBegin', [grantOf(grant)]);
await handles();
revokeAll();
await handles();
await call('phone', 'fileDownloadBegin', [grantOf(phoneGrant)]);
await call('tablet', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);

// ── 10. an unpair while a call is in flight ──
begin('unpair during a read', 'a read held at the file when the device is revoked answers expired, never bytes');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
const reading = gate('read');
step({ op: 'hold', gate: 'read' });
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)], { key: 'read' });
await reading.arrived;
revokeDevice('phone');
await release('read', reading);
await answer('read');
await handles();
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);

begin('relay close during a read', 'a read held at the file when the relay closes (every download revoked) answers expired, never bytes, and the file is let go: it can be removed');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
const relayClosing = gate('read');
step({ op: 'hold', gate: 'read' });
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)], { key: 'read' });
await relayClosing.arrived;
revokeAll();
await release('read', relayClosing);
await answer('read');
await handles();
file('remove', { file: 'a.bin' });
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);

begin('unpair during begin', 'a begin held while the file is checked, revoked meanwhile, leaves no transfer behind');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
const checking = gate('stat');
step({ op: 'hold', gate: 'stat' });
await call('phone', 'fileDownloadBegin', [grantOf(grant)], { key: 'begin' });
await checking.arrived;
revokeDevice('phone');
await release('stat', checking);
await answer('begin');
await handles();
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);

begin('unpair during authorize', 'an authorize held between resolving the file and opening it, revoked meanwhile, leaves no grant behind');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
const resolving = gate('afterResolve');
step({ op: 'hold', gate: 'afterResolve' });
await call('phone', 'fileDownloadAuthorize', [session('a.bin')], { key: 'authorize' });
await resolving.arrived;
revokeDevice('phone');
await release('afterResolve', resolving);
await answer('authorize');
await handles();
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);

// ── 11. the sweeper: handles close at its ticks, with no call ──
// Node's sweeper starts when the first grant or transfer is held and ticks every 15 000 ms from then; a grant is dropped at the first tick at or
// after `expiresAt`. `handles` counts what the service holds open after each advance.
begin('sweeper ticks', 'an expired grant is dropped at the first 15 s tick at or after its expiry, with no call: a grant held from 5 000 ms goes at 75 000 ms');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await wait(5_000);
const later = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await handles();
await wait(54_999);
await handles();
await wait(1);
await handles();
await wait(14_999);
await handles();
await wait(1);
await handles();
await call('phone', 'fileDownloadBegin', [grantOf(later)]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);

begin('sweeper restarts', 'the ticks are counted from the first thing held after nothing was: aborted at 10 000 ms, a new grant at 22 000 ms goes at 82 000 ms');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await wait(10_000);
await call('phone', 'fileDownloadAbort', [grantOf(grant)]);
await handles();
await wait(12_000);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await wait(59_999);
await handles();
await wait(1);
await handles();
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);

begin('sweeper and transfers', 'a transfer unread for 120 000 ms is dropped at its tick, one read every 100 000 ms is dropped at 1 800 000 ms; a read renews the idle time');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await handles();
await wait(119_999);
await handles();
await wait(1);
await handles();
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
for (let read = 0; read < 17; read += 1) {
  await wait(100_000);
  await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
}
await handles();
await wait(99_999);
await handles();
await wait(1);
await handles();
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);

// ── 12. a conversation deleted ──
// The host publishes its catalog (`catalog`); a conversation an earlier publication listed and this one does not is deleted, and what it held
// ends at once (`retainSessions`). Another conversation keeps its own.
const taskFile = () => session('task/work.txt', 's2');
begin('session deleted before begin', 'a grant of a deleted conversation is gone, a new authorize is unavailable, the other conversation is untouched');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
file('write', { file: 'task/work.txt', text: 'task bytes' });
catalog(['s1', 's2']);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
const kept = await call('phone', 'fileDownloadAuthorize', [taskFile()]);
await handles();
catalog(['s2']);
await handles();
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(kept)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await handles();

begin('session deleted between ranges', 'a transfer of a deleted conversation answers expired to the next range, finish and abort; its handle is closed when it is deleted');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
catalog(['s1', 's2']);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
catalog(['s2']);
await handles();
await call('phone', 'fileDownloadRange', [transferOf(lease), 4, 4, versionOf(lease)]);
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);
await call('phone', 'fileDownloadAbort', [transferOf(lease)]);

begin('session deleted during authorize', 'an authorize held between resolving the file and opening it, its conversation deleted meanwhile, answers unavailable and leaves no grant');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
catalog(['s1', 's2']);
const authorizing = gate('afterResolve');
step({ op: 'hold', gate: 'afterResolve' });
await call('phone', 'fileDownloadAuthorize', [session('a.bin')], { key: 'authorize' });
await authorizing.arrived;
catalog(['s2']);
await release('afterResolve', authorizing);
await answer('authorize');
await handles();

begin('session deleted during begin', 'a begin held while the file is checked, its conversation deleted meanwhile, answers unavailable and leaves no transfer');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
catalog(['s1', 's2']);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
const verifying = gate('stat');
step({ op: 'hold', gate: 'stat' });
await call('phone', 'fileDownloadBegin', [grantOf(grant)], { key: 'begin' });
await verifying.arrived;
catalog(['s2']);
await release('stat', verifying);
await answer('begin');
await handles();
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);

begin('session deleted during a range read', 'a read held at the file when its conversation is deleted answers expired, never bytes; the handle is closed at the deletion');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
catalog(['s1', 's2']);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
const deleting = gate('read');
step({ op: 'hold', gate: 'read' });
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)], { key: 'read' });
await deleting.arrived;
catalog(['s2']);
await release('read', deleting);
await answer('read');
await handles();
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);

begin('file truncated during a range read', 'a read held at the file when the file is cut short answers changed (the file ended before the window did), and the transfer is dropped with its handle');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
const cutting = gate('read');
step({ op: 'hold', gate: 'read' });
await call('phone', 'fileDownloadRange', [transferOf(lease), 8, 8, versionOf(lease)], { key: 'read' });
await cutting.arrived;
file('size', { file: 'a.bin', bytes: 10 });
await release('read', cutting);
await answer('read');
await handles();
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);

begin('session never listed', 'a conversation no published catalog listed is not gone: a publication that omits it ends nothing, but a new authorize needs the conversation in the catalog');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
catalog(['s2']);
await handles();
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('phone', 'fileDownloadAuthorize', [session('a.bin', 'never-existed')]);
await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: 'a.bin' })]);

// ── 13. the file moving, and the path being swapped under the open ──
begin('ancestor swapped between resolving and opening', 'a folder above the file replaced by a junction after the path was resolved opens another file: changed, and no handle is left');
file('write', { file: 'project/sub/a.bin', text: 'inside bytes' });
file('write', { file: 'outside/a.bin', text: 'outside bytes' });
const swapping = gate('afterResolve');
step({ op: 'hold', gate: 'afterResolve' });
await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: 'sub/a.bin' })], { key: 'authorize' });
await swapping.arrived;
file('junction', { file: 'project/sub', target: 'outside' });
await release('afterResolve', swapping);
await answer('authorize');
await handles();
await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: 'sub/a.bin' })]);
await call('phone', 'fileDownloadAuthorize', [session('project/sub/a.bin')]);
await handles();

begin('file moved', 'a file renamed or removed after authorize: begin, range and finish answer changed; renamed away and back it is the file that was authorized');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
file('rename', { file: 'a.bin', to: 'moved.bin' });
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await handles();
file('rename', { file: 'moved.bin', to: 'a.bin' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
file('rename', { file: 'a.bin', to: 'moved.bin' });
file('rename', { file: 'moved.bin', to: 'a.bin' });
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
file('rename', { file: 'a.bin', to: 'moved.bin' });
await call('phone', 'fileDownloadRange', [transferOf(lease), 4, 4, versionOf(lease)]);
await handles();
await call('phone', 'fileDownloadRange', [transferOf(lease), 4, 4, versionOf(lease)]);
file('rename', { file: 'moved.bin', to: 'a.bin' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
file('rename', { file: 'a.bin', to: 'moved.bin' });
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);
await handles();
file('rename', { file: 'moved.bin', to: 'a.bin' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
file('remove', { file: 'a.bin' });
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
file('remove', { file: 'a.bin' });
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await handles();

begin('session paths', 'a session path may be relative to the conversation\'s folder; a leading double separator is a network path');
file('write', { file: 'project/rel.bin', text: 'relative bytes' });
file('write', { file: 'outside/note.md', text: 'outside bytes' });
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: 'rel.bin' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: 'sub/../rel.bin' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: '../outside/note.md' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: 'missing.bin' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: '\\\\server\\share\\x.txt' }, purpose: 'save' }]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'session', sessionId: 's1', path: '/\\server/share/x.txt' }, purpose: 'save' }]);
await handles();

// ── 14. a media asset ──
// The host's media store resolves an asset id to a file and, when it states one, a type: the offer is named for the file, and typed by the
// store's type if it gave one, else by the file's own extension. The conversation must be in the catalog; the asset is the store's, whichever
// conversation asks.
begin('links', 'a link the conversation shows is decoded as the desktop decodes it (location, query, trailing punctuation and percent escapes dropped, a file: URL unwrapped) and opened as a path the conversation names; a web link, an anchor and a network path name nothing');
file('write', { file: 'project/rel.bin', text: 'relative bytes' });
file('write', { file: 'project/rel space.bin', text: 'spaced bytes' });
file('write', { file: 'outside/note.md', text: 'outside bytes' });
file('write', { file: 'task/t.txt', text: 'task bytes' });
const link = (href, sessionId = 's1', itemId = 'item-1') => ({ source: { kind: 'link', sessionId, itemId, href }, purpose: 'open' });
const forwardDir = dir.replaceAll('\\', '/');
grant = await call('phone', 'fileDownloadAuthorize', [link('rel.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 8, versionOf(lease)]);
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);
for (const href of [
  'rel.bin:12',
  'rel.bin:12:4-9',
  'rel.bin#L3-L5',
  'rel.bin#l0',
  './rel.bin).',
  'rel.bin?x=1#top',
  'rel%20space.bin',
  'rel%E0%A4%A.bin',
  `file:///${forwardDir}/project/rel.bin`,
  `file://localhost/${forwardDir}/project/rel.bin`,
  path('outside/note.md'),
  '../outside/note.md',
  'https://example.com/x.bin',
  'mailto:a@b.c',
  '#section',
  '?q=1',
  '//server/share/x.txt',
  '\\\\server\\share\\x.txt',
  'missing.bin',
  'sub/',
]) {
  await call('phone', 'fileDownloadAuthorize', [link(href)]);
}
await call('phone', 'fileDownloadAuthorize', [link('t.txt', 's2')]);
await call('phone', 'fileDownloadAuthorize', [link('rel.bin', 's9')]);
await call('phone', 'fileDownloadAuthorize', [link('rel.bin', 's1', '')]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'link', sessionId: 's1', href: 'rel.bin' }, purpose: 'open' }]);
await call('phone', 'fileDownloadAuthorize', [link('', 's1')]);
await call('phone', 'fileDownloadAuthorize', [link('x'.repeat(4_097), 's1')]);
await call('phone', 'fileDownloadAuthorize', [link('rel.bin', 's1', 'i'.repeat(257))]);
await handles();

begin('attachments', 'an attachment the conversation names (in its transcript window or only in its stored history) is staged from the content-addressed store as the download, named to preview by its type; one it does not name, one no longer stored and bytes that do not hash to the id are refused');
const attach = ({ sessionId = 's1', name, mimeType, text, window = true, stored = true, storedText = text }) => {
  const id = createHash('sha256').update(text).digest('hex');
  if (!transcripts.has(sessionId)) transcripts.set(sessionId, []);
  transcripts.get(sessionId).push({ kind: 'user', window, attachments: [{ id, name, mimeType, size: text.length }] });
  if (stored) blobs.set(id, Buffer.from(storedText).toString('base64'));
  step({ op: 'attachment', sessionId, name, mimeType, text, window, stored, storedText, id });
  return id;
};
const attachmentOf = (attachmentId, sessionId = 's1') => ({ source: { kind: 'attachment', sessionId, attachmentId }, purpose: 'save' });
const report = attach({ name: 'report', mimeType: 'application/pdf', text: 'report bytes' });
grant = await call('phone', 'fileDownloadAuthorize', [attachmentOf(report)]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 6, versionOf(lease)]);
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);
await call('phone', 'fileDownloadAuthorize', [attachmentOf(attach({ name: 'notes.txt', mimeType: 'text/markdown', text: 'named bytes' }))]);
await call('phone', 'fileDownloadAuthorize', [attachmentOf(attach({ name: 'a<b>:c', mimeType: 'image/png', text: 'png bytes' }))]);
await call('phone', 'fileDownloadAuthorize', [attachmentOf(attach({ name: '', mimeType: '', text: 'unnamed bytes' }))]);
await call('phone', 'fileDownloadAuthorize', [attachmentOf(attach({ name: 'old.bin', mimeType: 'application/octet-stream', text: 'history bytes', window: false }))]);
await call('phone', 'fileDownloadAuthorize', [attachmentOf(attach({ sessionId: 's2', name: 'other.bin', mimeType: 'application/octet-stream', text: 'other bytes' }))]);
await call('phone', 'fileDownloadAuthorize', [attachmentOf(attach({ name: 'gone.bin', mimeType: 'application/octet-stream', text: 'gone bytes', stored: false }))]);
await call('phone', 'fileDownloadAuthorize', [attachmentOf(attach({ name: 'bad.bin', mimeType: 'application/octet-stream', text: 'claimed bytes', storedText: 'other bytes!' }))]);
await call('phone', 'fileDownloadAuthorize', [attachmentOf(report, 's9')]);
await call('phone', 'fileDownloadAuthorize', [attachmentOf(report.toUpperCase())]);
await call('phone', 'fileDownloadAuthorize', [attachmentOf(report.slice(1))]);
await call('phone', 'fileDownloadAuthorize', [attachmentOf(12)]);
await handles();

begin('folders', 'a folder the conversation names is served as a zip of its work files, named for its real folder: generated folders left out and counted, entries in name order, each stored when deflating is not smaller; a file, a missing path, a network path, a project folder that leaves through a link and a folder past a cap are refused');
for (const folder of ['project/docs/sub', 'project/docs/node_modules', 'outside/target', 'outside/empty', 'outside/big', 'task/kept']) file('mkdir', { file: folder });
file('write', { file: 'task/kept/k.txt', text: 'kept' });
file('write', { file: 'project/docs/b.txt', text: 'bravo' });
file('write', { file: 'project/docs/a.txt', text: 'alpha' });
file('write', { file: 'project/docs/Zeta.txt', text: 'zeta' });
file('write', { file: 'project/docs/sub/c.txt', text: 'charlie' });
file('write', { file: 'project/docs/node_modules/x.js', text: 'x' });
file('write', { file: 'outside/target/o.txt', text: 'outside' });
const folderOf = (text, sessionId = 's1', purpose = 'save') => ({ source: { kind: 'folder', sessionId, path: text }, purpose });
grant = await call('phone', 'fileDownloadAuthorize', [folderOf('docs')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, grant.value.size, versionOf(lease)]);
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);
await handles();
await call('phone', 'fileDownloadAuthorize', [folderOf(path('project/docs'), 's1', 'share')]);
grant = await call('phone', 'fileDownloadAuthorize', [folderOf(path('project/docs/node_modules'))]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, grant.value.size, versionOf(lease)]);
await call('phone', 'fileDownloadAbort', [transferOf(lease)]);
grant = await call('phone', 'fileDownloadAuthorize', [folderOf(path('outside/empty'))]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, grant.value.size, versionOf(lease)]);
await call('phone', 'fileDownloadAbort', [transferOf(lease)]);
await call('phone', 'fileDownloadAuthorize', [folderOf('kept', 's2')]);
await call('phone', 'fileDownloadAuthorize', [folderOf(path('outside/target'))]);
await call('phone', 'fileDownloadAuthorize', [folderOf('docs/a.txt')]);
await call('phone', 'fileDownloadAuthorize', [folderOf(path('outside/missing'))]);
await call('phone', 'fileDownloadAuthorize', [folderOf('//server/share/x')]);
await call('phone', 'fileDownloadAuthorize', [folderOf('docs', 's9')]);
await call('phone', 'fileDownloadAuthorize', [{ source: { kind: 'folder', sessionId: 's1' }, purpose: 'save' }]);
file('junction', { file: 'project/linked', target: 'outside/target' });
await call('phone', 'fileDownloadAuthorize', [folderOf('linked')]);
file('write', { file: 'outside/big/huge.bin', text: '' });
file('size', { file: 'outside/big/huge.bin', bytes: 64 * 1024 * 1024 + 1 });
await call('phone', 'fileDownloadAuthorize', [folderOf(path('outside/big'))]);
file('remove', { file: 'outside/big/huge.bin' });
await handles();

begin('folder file removed before it is read', 'a file the walk listed and that is gone when the zip opens it fails the zip with the open\'s error; nothing is staged and no handle is left');
file('mkdir', { file: 'outside/vanishing' });
file('write', { file: 'outside/vanishing/a.txt', text: 'alpha' });
file('write', { file: 'outside/vanishing/b.txt', text: 'bravo' });
const vanishing = gate('zipOpen');
step({ op: 'hold', gate: 'zipOpen' });
await call('phone', 'fileDownloadAuthorize', [folderOf(path('outside/vanishing'))], { key: 'authorize' });
await vanishing.arrived;
file('remove', { file: 'outside/vanishing/a.txt' });
await release('zipOpen', vanishing);
await answer('authorize');
await handles();
await staged();

begin('staged lifetime', 'a staged download (a folder\'s zip) stays 10 minutes from staging whatever its transfer does, keeps the 15 s sweeper ticking from the first thing held, and goes at the first tick at or after its time once nothing reads it; its grant is spent once; the sweeper stops when nothing is left');
file('mkdir', { file: 'outside/zipped' });
file('write', { file: 'outside/zipped/z.txt', text: 'zipped' });
file('write', { file: 'a.bin', text: '0123456789abcdef' });
const zipped = () => folderOf(path('outside/zipped'));
grant = await call('phone', 'fileDownloadAuthorize', [zipped()]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, grant.value.size, versionOf(lease)]);
await call('phone', 'fileDownloadFinish', [transferOf(lease)]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await handles();
await staged();
await wait(22_000);
const plain = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await wait(60_000);
await handles();
await wait(8_000);
await handles();
await call('phone', 'fileDownloadBegin', [grantOf(plain)]);
grant = await call('phone', 'fileDownloadAuthorize', [zipped()]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, grant.value.size, versionOf(lease)]);
await wait(120_000);
await handles();
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, grant.value.size, versionOf(lease)]);
await staged();
await wait(389_999);
await staged();
await wait(1);
await staged();
await wait(90_000);
await staged();
await wait(10_000);
const after = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await wait(60_000);
await handles();
await call('phone', 'fileDownloadBegin', [grantOf(after)]);

begin('staged downloads per device', 'a device holds 8 staged downloads: a ninth drops its oldest that no transfer reads, with the unbegun grant reading it; another device keeps its own; an unpair removes the device\'s');
for (let n = 0; n <= 8; n += 1) {
  file('mkdir', { file: `outside/f${n}` });
  file('write', { file: `outside/f${n}/f.txt`, text: `folder ${n}` });
}
const stagedFolder = (n) => folderOf(path(`outside/f${n}`));
const reading8 = [];
for (let n = 0; n < 4; n += 1) reading8.push(await call('phone', 'fileDownloadBegin', [grantOf(await call('phone', 'fileDownloadAuthorize', [stagedFolder(n)]))]));
const unbegun8 = [];
for (let n = 4; n < 8; n += 1) unbegun8.push(await call('phone', 'fileDownloadAuthorize', [stagedFolder(n)]));
await staged();
await call('phone', 'fileDownloadAuthorize', [stagedFolder(8)]);
await staged();
await handles();
await call('phone', 'fileDownloadFinish', [transferOf(reading8[0])]);
await call('phone', 'fileDownloadBegin', [grantOf(unbegun8[0])]);
await call('phone', 'fileDownloadBegin', [grantOf(unbegun8[1])]);
await call('tablet', 'fileDownloadAuthorize', [stagedFolder(0)]);
await staged();
revokeDevice('phone');
await staged();
await handles();

begin('unpair while staging', 'an unpair that meets a staged download whose record is added and whose payload is not yet written removes its folder; the write then fails the authorize, nothing is left staged and no handle is open');
file('mkdir', { file: 'outside/staging' });
file('write', { file: 'outside/staging/s.txt', text: 'staging' });
const staging = gate('stageWrite');
step({ op: 'hold', gate: 'stageWrite' });
await call('phone', 'fileDownloadAuthorize', [folderOf(path('outside/staging'))], { key: 'authorize' });
await staging.arrived;
revokeDevice('phone');
// The unpair's removal of the folder (`dropExport`'s `rm`, not awaited by the service) ends before the write goes on.
await settle();
await release('stageWrite', staging);
await answer('authorize');
await staged();
await handles();

begin('media assets','a media asset is offered by the store\'s file name and type (the extension\'s when the store states none); an unknown asset, one whose bytes are gone and a conversation not in the catalog are refused');
const png = (id, name, mime, text = `${name} bytes`) => media({ id, name, mime, text });
png('m-typed', 'a1.png', 'image/png');
png('m-custom', 'a2.png', 'application/x-custom');
png('m-stated-by-extension', 'a3.png', '');
png('m-unknown-extension', 'a4.zzz', '');
png('m-upper-extension', 'A5.PNG', '');
png('m-document', 'a6.PDF', '');
const mediaOf = (assetId, sessionId = 's1') => ({ source: { kind: 'media', sessionId, assetId }, purpose: 'save' });
for (const id of ['m-typed', 'm-custom', 'm-stated-by-extension', 'm-unknown-extension', 'm-upper-extension', 'm-document']) {
  grant = await call('phone', 'fileDownloadAuthorize', [mediaOf(id)]);
  lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
  await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
  await call('phone', 'fileDownloadFinish', [transferOf(lease)]);
}
await call('phone', 'fileDownloadAuthorize', [mediaOf('m-typed', 's2')]);
await call('phone', 'fileDownloadAuthorize', [mediaOf('m-typed', 's9')]);
await call('phone', 'fileDownloadAuthorize', [mediaOf('m-unknown')]);
unmedia('m-typed');
await call('phone', 'fileDownloadAuthorize', [mediaOf('m-typed')]);
await call('phone', 'fileDownloadAuthorize', [mediaOf('a b')]);
await call('phone', 'fileDownloadAuthorize', [mediaOf('')]);
await call('phone', 'fileDownloadAuthorize', [mediaOf('x'.repeat(129))]);
png('m-changes', 'a7.png', 'image/png');
grant = await call('phone', 'fileDownloadAuthorize', [mediaOf('m-changes')]);
file('append', { file: 'media/assets/a7.png', text: 'more' });
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
mediaRoot('m-root');
await call('phone', 'fileDownloadAuthorize', [mediaOf('m-root')]);
await handles();

begin('media after the conversation was deleted', 'a media grant is the conversation\'s: when the conversation is deleted it is gone, and the conversation is no longer available for another');
png('m-typed', 'a1.png', 'image/png');
catalog(['s1', 's2']);
grant = await call('phone', 'fileDownloadAuthorize', [mediaOf('m-typed')]);
catalog(['s2']);
await handles();
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
await call('phone', 'fileDownloadAuthorize', [mediaOf('m-typed')]);
grant = await call('phone', 'fileDownloadAuthorize', [mediaOf('m-typed', 's2')]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);

// An archive keeps the conversation in the catalog Node publishes, marked archived (roster-steps `archive`, rs-thread-list-rows); a deleted
// agent's home is archived the same way (`agent-delete`). The catalog the service is given lists the same conversations.
begin('archived conversation', 'archiving a conversation leaves it in the catalog: its grant, its transfer and a new authorize all go on');
file('write', { file: 'project/a.bin', text: 'archived bytes' });
const unbegunArchived = await call('phone', 'fileDownloadAuthorize', [session('project/a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(await call('phone', 'fileDownloadAuthorize', [session('project/a.bin')]))]);
sessions.splice(0, sessions.length, ...allSessions.map((row) => (row.id === 's1' ? { ...row, archived: true } : row)));
service.retainSessions(sessions.map((row) => row.id));
step({ op: 'archive', id: 's1' });
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 8, versionOf(lease)]);
await call('phone', 'fileDownloadBegin', [grantOf(unbegunArchived)]);
await call('phone', 'fileDownloadAuthorize', [session('project/a.bin')]);
await handles();

// A project removal (`removeProject` -> `DesktopProjectRegistry.remove`, `session-host.ts:724`) publishes no session catalog: the conversation
// stays, so its grants and transfers go on; only the project's own rule (`projectRoot`, `file-downloads.ts:302-306`) now finds no root.
begin('project removed', 'removing the project keeps its conversation and what it granted; a project path is then outside the project, a path the conversation names is not');
file('write', { file: 'project/p.bin', text: 'project bytes' });
file('mkdir', { file: 'project/sub' });
file('write', { file: 'project/sub/s.txt', text: 'sub bytes' });
const unbegunProject = await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: 'p.bin' })]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: 'p.bin' })]))]);
await registry.remove(PROJECT);
step({ op: 'removeProject' });
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 8, versionOf(lease)]);
await call('phone', 'fileDownloadBegin', [grantOf(unbegunProject)]);
await call('phone', 'fileDownloadAuthorize', [request('project', { relPath: 'p.bin' })]);
await call('phone', 'fileDownloadAuthorize', [session('project/p.bin')]);
await call('phone', 'fileDownloadAuthorize', [link(`${forwardDir}/project/p.bin`)]);
await handles();
await registry.register(PROJECT);

if (process.platform === 'win32') {
  begin('windows path names', 'a stream name, a device name, a namespace prefix and a drive-relative path, as this host\'s realpath and open treat them');
  scenarios.at(-1).platform = 'win32';
  file('write', { file: 'outside/note.md', text: 'outside bytes' });
  const named = (text) => ({ source: { kind: 'session', sessionId: 's1', path: text }, purpose: 'save' });
  await call('phone', 'fileDownloadAuthorize', [named(`${path('outside/note.md')}:alt`)]);
  await call('phone', 'fileDownloadAuthorize', [named(`${path('outside/note.md')}::$DATA`)]);
  await call('phone', 'fileDownloadAuthorize', [named(path('outside/NUL'))]);
  await call('phone', 'fileDownloadAuthorize', [named('NUL')]);
  await call('phone', 'fileDownloadAuthorize', [named(`\\\\?\\${path('outside/note.md')}`)]);
  await call('phone', 'fileDownloadAuthorize', [named(`${path('outside/note.md')}.`)]);
  await call('phone', 'fileDownloadAuthorize', [named(`${path('outside/note.md')} `)]);
  await call('phone', 'fileDownloadAuthorize', [named(path('outside/NOTE.MD'))]);
  await handles();
}

// ── the remap ──
const KINDS = [
  ['grantId', (value) => value?.grantId],
  ['transferId', (value) => value?.transferId],
  ['version', (value) => value?.version],
  ['assetId', (value) => value?.media?.assetId],
];
const tokens = new Map();
const counts = new Map();
const collect = (frame) => {
  if (!frame?.ok) return;
  for (const [kind, pick] of KINDS) {
    const found = pick(frame.value);
    if (typeof found === 'string' && !tokens.has(found)) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      tokens.set(found, `<${kind}#${counts.get(kind) - 1}>`);
    }
  }
};
for (const { steps: all } of scenarios) for (const entry of all) collect(entry.frame);
const swap = (node) => {
  if (typeof node === 'string') {
    if (tokens.has(node)) return tokens.get(node);
    // A staged download's folder (`mkdtemp`'s six random characters): `<staged>` and forward slashes after it.
    const stagedPrefix = join(STAGING, 'mixdog-download-');
    const stagedAt = node.indexOf(stagedPrefix);
    if (stagedAt !== -1) return `${node.slice(0, stagedAt)}<staged>${node.slice(stagedAt + stagedPrefix.length + 6).replaceAll('\\', '/')}`;
    // A path of this run's folder: `<dir>` and forward slashes, so a replay on any system joins its own folder to it.
    if (node.includes(dir)) return node.split(dir).join('<dir>').replaceAll('\\', '/');
    // The same folder written with forward slashes (a `file:` URL of it).
    const forward = dir.replaceAll('\\', '/');
    if (forward !== dir && node.includes(forward)) return node.split(forward).join('<dir>');
    return node;
  }
  if (Array.isArray(node)) return node.map(swap);
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, swap(value)]));
  return node;
};
const remapped = swap(scenarios);
const text = JSON.stringify(remapped);
if (text.includes(dir) || text.includes(STAGING)) throw new Error('the recording still holds this run\'s temporary directory');
// A frame that is not a reply or an error is a recorder fault.
for (const { steps: all } of remapped) for (const entry of all) if (entry.frame && !(typeof entry.frame.id === 'number' && typeof entry.frame.ok === 'boolean')) throw new Error(`not a reply frame: ${JSON.stringify(entry.frame)}`);

Object.assign(globalThis, real);
rmSync(dir, { recursive: true, force: true });
rmSync(STAGING, { recursive: true, force: true });
if (only) {
  const picked = remapped.find((scenario) => scenario.name === only);
  rmSync(stage, { recursive: true, force: true });
  if (!picked) throw new Error(`--only ${only}: no scenario of that name`);
  console.log(JSON.stringify(picked, null, 2));
  process.exit(0);
}
writeJson(join(stage, 'file-downloads.json'), { domain: 'file-downloads', recorder, clockStart: CLOCK_START, remapped: [...counts.keys()], scenarios: remapped });
writeSetManifest(stage, {
  set: 'file-downloads',
  recorder,
  command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <exact archive> --commit ${identity.commit}`,
  identity,
});
commitStage(stage, finalDir);
console.log(`recorded ${remapped.length} scenarios, ${remapped.reduce((n, s) => n + s.steps.length, 0)} steps`);
process.exit(0);
