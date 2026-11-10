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
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
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
const turn = () => new Promise((resolve) => setImmediate(resolve));
/** Runs every promise continuation that can run without a timer. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await turn();
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

// The host's conversations: s1 is a project conversation, s2 a task conversation (no project).
const sessions = [
  { id: 's1', classification: 'project', projectPath: PROJECT, cwd: PROJECT },
  { id: 's2', classification: 'task', projectPath: null, cwd: TASK },
];
const host = {
  listSessions: async () => sessions,
  projectDirectory: async (path) => realpathSync.native(path),
  invokeCapability: async () => ({ value: null }),
  readSessionTranscript: async () => ({}),
  readSessionHistory: async () => ({}),
  readAttachmentImage: async () => null,
};

// ── the gates a call in flight is held at ──
const gates = new Map();
const gate = (name) => {
  let release;
  let reached;
  const held = new Promise((resolve) => (release = resolve));
  const arrived = new Promise((resolve) => (reached = resolve));
  gates.set(name, { hold: async () => { reached(); await held; }, arrived, release });
  return gates.get(name);
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
fileDownloadTestHooks.opened = wrapHandle;
fileDownloadTestHooks.afterResolve = async () => {
  const armed = gates.get('afterResolve');
  if (armed) {
    gates.delete('afterResolve');
    await armed.hold();
  }
};

const devices = { phone: { deviceId: 'aaaaaaa1' }, tablet: { deviceId: 'bbbbbbb2' }, 'connection:c1': { deviceId: 'connection:c1' }, 'connection:c2': { deviceId: 'connection:c2' } };
let service;
let tables;
/** Each scenario runs on a service of its own, at the start of the clock, with no timer of an earlier one armed. */
const fresh = () => {
  clock.timers.clear();
  clock.now = CLOCK_START;
  service = createFileDownloadService({ host, mediaLane: true, now: () => clock.now });
  tables = Object.fromEntries(Object.entries(devices).map(([name, requester]) => [name, fileDownloadRemoteMethods(service, () => requester)]));
};

let nextId = 1;
const pending = new Map();
/** The whole frame the phone gets for one call (the wire executor of the relay's method table). */
const wire = (device, method, params) => {
  const id = nextId++;
  const frame = executeRemoteFrame(tables[device], JSON.stringify({ id, method, params }));
  return { id, frame };
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
};
const file = (op, entry) => {
  fileOps[op](entry);
  step({ op, ...entry });
};
const call = async (device, method, params, { key } = {}) => {
  const sent = wire(device, method, params);
  const promise = sent.frame;
  if (key) {
    pending.set(key, { id: sent.id, promise });
    step({ op: 'send', key, device, method, params });
    return null;
  }
  const frame = await promise;
  step({ op: 'call', device, method, params, frame });
  return frame;
};
const answer = async (key) => {
  const held = pending.get(key);
  pending.delete(key);
  const frame = await held.promise;
  step({ op: 'answer', key, frame });
  return frame;
};
const wait = async (ms) => {
  step({ op: 'advance', ms });
  await advance(ms);
};
const revokeDevice = (deviceId) => {
  service.revokeDevice(deviceId);
  step({ op: 'revokeDevice', deviceId });
};
const revokeAll = () => {
  service.revokeAll();
  step({ op: 'revokeAll' });
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
begin('unpair', 'revoking a device ends its unbegun grants and its transfers at once, whatever connection asks; another device keeps its own; revoking everything ends all');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
const unbegun = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
grant = await call('tablet', 'fileDownloadAuthorize', [session('a.bin')]);
const tabletLease = await call('tablet', 'fileDownloadBegin', [grantOf(grant)]);
const tabletUnbegun = await call('tablet', 'fileDownloadAuthorize', [session('a.bin')]);
revokeDevice('aaaaaaa1');
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);
await call('phone', 'fileDownloadBegin', [grantOf(unbegun)]);
await call('phone', 'fileDownloadAbort', [transferOf(lease)]);
await call('tablet', 'fileDownloadRange', [transferOf(tabletLease), 0, 4, versionOf(tabletLease)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
revokeAll();
await call('tablet', 'fileDownloadBegin', [grantOf(tabletUnbegun)]);
await call('tablet', 'fileDownloadRange', [transferOf(tabletLease), 0, 4, versionOf(tabletLease)]);

// ── 10. an unpair while a call is in flight ──
begin('unpair during a read', 'a read held at the file when the device is revoked answers expired, never bytes');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
lease = await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
const reading = gate('read');
step({ op: 'hold', gate: 'read' });
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)], { key: 'read' });
await reading.arrived;
revokeDevice('aaaaaaa1');
await release('read', reading);
await answer('read');
await call('phone', 'fileDownloadRange', [transferOf(lease), 0, 4, versionOf(lease)]);

begin('unpair during begin', 'a begin held while the file is checked, revoked meanwhile, leaves no transfer behind');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
const checking = gate('stat');
step({ op: 'hold', gate: 'stat' });
await call('phone', 'fileDownloadBegin', [grantOf(grant)], { key: 'begin' });
await checking.arrived;
revokeDevice('aaaaaaa1');
await release('stat', checking);
await answer('begin');
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);

begin('unpair during authorize', 'an authorize held between resolving the file and opening it, revoked meanwhile, leaves no grant behind');
file('write', { file: 'a.bin', text: '0123456789abcdef' });
const resolving = gate('afterResolve');
step({ op: 'hold', gate: 'afterResolve' });
await call('phone', 'fileDownloadAuthorize', [session('a.bin')], { key: 'authorize' });
await resolving.arrived;
revokeDevice('aaaaaaa1');
await release('afterResolve', resolving);
await answer('authorize');
grant = await call('phone', 'fileDownloadAuthorize', [session('a.bin')]);
await call('phone', 'fileDownloadBegin', [grantOf(grant)]);

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
    // A path of this run's folder: `<dir>` and forward slashes, so a replay on any system joins its own folder to it.
    if (node.includes(dir)) return node.split(dir).join('<dir>').replaceAll('\\', '/');
    return node;
  }
  if (Array.isArray(node)) return node.map(swap);
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, swap(value)]));
  return node;
};
const remapped = swap(scenarios);
const text = JSON.stringify(remapped);
if (text.includes(dir)) throw new Error('the recording still holds this run\'s temporary directory');
// A frame that is not a reply or an error is a recorder fault.
for (const { steps: all } of remapped) for (const entry of all) if (entry.frame && !(typeof entry.frame.id === 'number' && typeof entry.frame.ok === 'boolean')) throw new Error(`not a reply frame: ${JSON.stringify(entry.frame)}`);

Object.assign(globalThis, real);
rmSync(dir, { recursive: true, force: true });
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
