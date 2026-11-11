// Checkpoints of a session log across processes: what each interleaving of a
// scan that publishes a checkpoint and a redaction (or delete) that retires
// the log's checkpoints guarantees, and the tests that force the cells that
// needed a design (session-scan-checkpoint.mjs holds the invariant).
//
// Scan steps: S1 read the log; S2 publish = take the log's OS lock without
// waiting, check the log is still the file S1 read (identity, length, first and
// last bytes), write the checkpoint (temp file, rename), release.
// Redaction/delete steps: R1 take the lock (waiting for a publisher), R2 remove
// every file of the log's checkpoints, R3 rewrite or delete the log, R4 release.
// Crash points: a process killed at any step; the OS drops its lock.
//
// | scan                        | redaction                      | outcome, and what guarantees it                          | test |
// |-----------------------------|--------------------------------|----------------------------------------------------------|------|
// | S1 S2 complete              | R1 after it                    | R2 removes the file                                      | summary-rebuild-redaction, session-scan-checkpoint |
// | S2 holds the lock           | R1 meanwhile                   | R1 waits for S2's release, then R2 removes the file      | killed publisher (below) |
// | S1                          | R1..R4 holds the lock, S2 tries| S2 cannot take the lock: no checkpoint                   | scanned during the rewrite |
// | S1 on the old log           | R1..R4 done, then S2           | S2's check fails: the first bytes (log id) are new       | scanned before, published after |
// | S1 on the old log           | delete R1..R4 done, then S2    | S2's check fails: the log is gone (or another file)      | same, delete |
// | S dies in S2 (lock, temp)   | R1 later                       | the OS freed the lock; R2 removes the dead temp file     | killed publisher |
// | no scan                     | R dies after R1 (before R3/R4) | R2 had removed everything and nothing was publishable    | killed retirement |
// | a checkpoint of the log exists | R2 cannot remove it (EACCES)  | throws (ESCANCHECKPOINT, naming the file) before R3; the log is unchanged; a delete returns false | unlink fails |
// | a checkpoint of the log exists | R2 cannot list the directory  | same, naming the directory                                | enumeration fails |
// | any                         | R1 cannot take the lock (the lock file cannot be opened, or another process holds it for the whole wait) | throws before R2, naming the lock file; the log is unchanged | lock unobtainable |
// | S1 on the old log           | S2 after R4 with the old descriptor's state | S2's check fails (new identity, first bytes): a scan that adopted a checkpoint as R2 removed it can persist nothing | adopted the old log |
// | S2 written by another build | any                            | out of reach: adoption (log id, identity, bytes) refuses it, the sweep removes it |   |
// No cell leaves a checkpoint of the old log on disk once the rewrite or delete has returned,
// and no cell lets the rewrite or delete go on while one cannot be removed.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-scan-checkpoint-processes-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'), { recursive: true });

const { deleteSession, drainSessionStore, saveSessionDurably } = await import('../store.mjs');
const { readSessionLogSync } = await import('./session-log-reader.mjs');
const { rememberSensitiveValues } = await import('../sensitive-values.mjs');
const { sessionLogPath, sessionScanCheckpointDir } = await import('./session-paths.mjs');
const { _sessionLogIoForTest } = await import('./session-log-writer.mjs');
const checkpoint = await import('./session-scan-checkpoint.mjs');

const DEADLINE_MS = 30_000;
const CODE = '482913';
const fill = { name: 'browser', arguments: { action: 'fill', input: { sensitive: true, text: CODE } } };
const msg = (text) => ({ role: 'user', content: text });
const checkpoints = sessionScanCheckpointDir();
// The epoch tokens hold a path and a random value, nothing of a log.
const left = () => {
  try {
    return readdirSync(checkpoints).filter((name) => !name.endsWith('.epoch'));
  } catch {
    return [];
  }
};

test.beforeEach(() => rmSync(checkpoints, { recursive: true, force: true }));
test.after(() => {
  drainSessionStore();
  rmSync(root, { recursive: true, force: true });
});

// `promise`, or a failure naming `what` when it has not settled in time.
function within(promise, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: nothing within ${DEADLINE_MS} ms`)), DEADLINE_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// The code of the other process: a scan of a log in the shared data dir that
// publishes a checkpoint after every read (stride 1), stopped where `MODE` says.
const CHILD = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const { readSessionLog } = await import(process.env.READER_URL);
const checkpoint = await import(process.env.CHECKPOINT_URL);
const { LOG_PATH, CHECKPOINTS, MODE } = process.env;
checkpoint._setScanCheckpointStrideForTest(1);
const waits = {};
const arrived = (name) => (waits[name] ??= Promise.withResolvers());
process.on('message', (message) => arrived(message).resolve());
const say = (message) => process.send(message);
if (MODE === 'retire') {
  say('ready');
  await arrived('retire').promise;
  await checkpoint.withScanCheckpointsRetired(CHECKPOINTS, LOG_PATH, async () => {
    say('retiring');
    await new Promise(() => {});
  });
}
if (MODE === 'scan-then-pause') {
  // After the scan has closed the log and before it publishes.
  const open = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await open.apply(fs.promises, args);
    if (String(args[0]) !== LOG_PATH) return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      say('scanned');
      await arrived('publish').promise;
    };
    return handle;
  };
  syncBuiltinESMExports();
}
if (MODE === 'die-publishing') {
  // Inside the publication, its temporary file written: stops there for good.
  const stop = (src, dst) => {
    if (!String(src).includes('.mixdog-tmp-') || !String(dst).startsWith(CHECKPOINTS)) return false;
    say('publishing');
    return true;
  };
  const renameSync = fs.renameSync;
  fs.renameSync = (src, dst) => {
    if (stop(src, dst)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
    return renameSync(src, dst);
  };
  const rename = fs.promises.rename;
  fs.promises.rename = (src, dst) => (stop(src, dst) ? new Promise(() => {}) : rename(src, dst));
  syncBuiltinESMExports();
}
say('ready');
await arrived('scan').promise;
await readSessionLog(LOG_PATH, { messages: false, checkpoints: CHECKPOINTS });
process.send('done', () => process.exit(0));
`;

function startChild(mode, logPath) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
    env: {
      ...process.env,
      MODE: mode,
      LOG_PATH: logPath,
      CHECKPOINTS: checkpoints,
      READER_URL: new URL('./session-log-reader.mjs', import.meta.url).href,
      CHECKPOINT_URL: new URL('./session-scan-checkpoint.mjs', import.meta.url).href,
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const seen = new Map();
  child.on('message', (message) => (seen.get(message) ?? seen.set(message, Promise.withResolvers()).get(message)).resolve());
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.on('error', (error) => assert.fail(`the child could not start: ${error.message}`));
  return {
    heard: (message) => within((seen.get(message) ?? seen.set(message, Promise.withResolvers()).get(message)).promise, `the child never said '${message}'`),
    tell: (message) => child.send(message),
    kill: async () => {
      child.kill('SIGKILL');
      await within(exited, 'the killed child never exited');
    },
    exited: () => within(exited, 'the child never exited'),
  };
}

async function openedSession(id, pad) {
  const session = { id, owner: 'agent', messages: [msg(`pin ${CODE} ${pad.repeat(2000)}`), msg('two'), msg('three')] };
  await saveSessionDurably(session);
  assert.ok(readFileSync(sessionLogPath(id), 'utf8').includes(CODE));
  return session;
}

// A redaction whose rewrite waits behind a write held at its fsync: the
// retirement has run (the removal listed the directory), the log is not rewritten yet.
async function redactionInFlight(t, session) {
  const io = _sessionLogIoForTest();
  const fsync = io.fsync;
  const readdirSync = fs.readdirSync;
  let atFsync;
  const reached = new Promise((resolve) => (atFsync = resolve));
  let letGo;
  const gate = new Promise((resolve) => (letGo = resolve));
  io.fsync = (fd, callback) => {
    atFsync();
    gate.then(() => fsync(fd, callback));
  };
  let retired;
  const retirementRan = new Promise((resolve) => (retired = resolve));
  fs.readdirSync = (path, ...rest) => {
    if (String(path) === checkpoints) retired();
    return readdirSync(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    io.fsync = fsync;
    fs.readdirSync = readdirSync;
    syncBuiltinESMExports();
  });
  const first = saveSessionDurably({ ...session, messages: [...session.messages, msg('four')] });
  await within(reached, 'the write before the redaction never reached its fsync');
  rememberSensitiveValues(session.id, [fill]);
  const redaction = saveSessionDurably({ ...session, messages: [...session.messages, msg('four'), msg('five')] });
  await within(retirementRan, 'the redaction never retired the checkpoints');
  return {
    finish: async () => {
      letGo();
      await within(Promise.all([first, redaction]), 'the redaction never returned');
    },
  };
}

test('a scan in another process during a redaction leaves no checkpoint of the old log', async (t) => {
  const id = 'sess_cp_during_redaction';
  const session = await openedSession(id, 'a');
  const logPath = sessionLogPath(id);
  const child = startChild('plain', logPath);
  await child.heard('ready');
  const redaction = await redactionInFlight(t, session);
  child.tell('scan');
  await child.heard('done');
  await redaction.finish();
  await child.exited();
  assert.equal(readFileSync(logPath, 'utf8').includes(CODE), false, 'the log was redacted');
  assert.deepEqual(left(), [], 'the scan that read the old log published nothing');
});

test('a scan that read the log before its redaction and publishes after it leaves no checkpoint', async () => {
  const id = 'sess_cp_after_redaction';
  const session = await openedSession(id, 'b');
  const logPath = sessionLogPath(id);
  const child = startChild('scan-then-pause', logPath);
  await child.heard('ready');
  child.tell('scan');
  await child.heard('scanned');
  rememberSensitiveValues(id, [fill]);
  await within(saveSessionDurably({ ...session, messages: [...session.messages, msg('four')] }), 'the redaction never returned');
  child.tell('publish');
  await child.heard('done');
  await child.exited();
  assert.equal(readFileSync(logPath, 'utf8').includes(CODE), false, 'the log was redacted');
  assert.deepEqual(left(), []);
});

test('a scan that read the log before its delete and publishes after it leaves no checkpoint', async () => {
  const id = 'sess_cp_after_delete';
  await openedSession(id, 'c');
  const logPath = sessionLogPath(id);
  const child = startChild('scan-then-pause', logPath);
  await child.heard('ready');
  child.tell('scan');
  await child.heard('scanned');
  assert.equal(await within(deleteSession(id), 'the delete never returned'), true);
  child.tell('publish');
  await child.heard('done');
  await child.exited();
  assert.deepEqual(left(), []);
});

test('a publisher killed in its publication leaves nothing once the redaction has returned', async () => {
  const id = 'sess_cp_killed_publisher';
  const session = await openedSession(id, 'd');
  const logPath = sessionLogPath(id);
  const child = startChild('die-publishing', logPath);
  await child.heard('ready');
  child.tell('scan');
  await child.heard('publishing');
  assert.ok(left().length > 0, 'the dead publisher leaves its temporary file');
  rememberSensitiveValues(id, [fill]);
  // The redaction starts with the publisher holding the lock: it waits for the
  // kernel to drop it with the process.
  const redaction = saveSessionDurably({ ...session, messages: [...session.messages, msg('four')] });
  await child.kill();
  await within(redaction, 'the redaction never returned after the publisher died');
  assert.equal(readFileSync(logPath, 'utf8').includes(CODE), false, 'the log was redacted');
  assert.deepEqual(left(), [], 'neither a checkpoint nor the dead publisher\'s temporary file stays');
});

test('a retirement killed before its rewrite leaves no checkpoint, and the lock goes with it', async () => {
  const id = 'sess_cp_killed_retirement';
  await openedSession(id, 'e');
  const logPath = sessionLogPath(id);
  const child = startChild('retire', logPath);
  await child.heard('ready');
  child.tell('retire');
  await child.heard('retiring');
  let reader = await import('./session-log-reader.mjs?held');
  checkpoint._setScanCheckpointStrideForTest(1);
  try {
    reader.readSessionLogSync(logPath, { messages: false, checkpoints });
    assert.deepEqual(left(), [], 'nothing is published while a retirement holds the lock');
    await child.kill();
    reader = await import('./session-log-reader.mjs?freed');
    reader.readSessionLogSync(logPath, { messages: false, checkpoints });
    assert.equal(left().length, 1, 'the lock went with the process: a scan publishes again');
  } finally {
    checkpoint._setScanCheckpointStrideForTest(null);
  }
});

test('retirements of one log that overlap in a process do not wait for each other', async () => {
  const logPath = join(root, 'sessions', 'sess_cp_overlap.log.jsonl');
  const order = [];
  await within(
    Promise.all([
      checkpoint.withScanCheckpointsRetired(checkpoints, logPath, async () => {
        order.push('a in');
        await checkpoint.withScanCheckpointsRetired(checkpoints, logPath, async () => order.push('b in'));
        order.push('a out');
      }),
      checkpoint.withScanCheckpointsRetired(checkpoints, logPath, async () => order.push('c in')),
    ]),
    'two retirements of one log in a process waited for each other'
  );
  assert.deepEqual(order.sort(), ['a in', 'a out', 'b in', 'c in']);
  readSessionLogSync(logPath, { messages: false });
});
// ---- a retirement that cannot remove what it must fails before the log is touched ----

// `fs[name]` throws EACCES for the paths `matches` accepts, until restored or the test ends.
function failing(t, name, matches) {
  const original = fs[name];
  fs[name] = (path, ...rest) => {
    if (matches(String(path))) throw Object.assign(new Error('injected'), { code: 'EACCES' });
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  const restore = () => {
    fs[name] = original;
    syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
}

// A checkpoint of the log, as a scan leaves it.
function leaveCheckpoint(logPath) {
  checkpoint._setScanCheckpointStrideForTest(1);
  try {
    readSessionLogSync(logPath, { messages: false, checkpoints });
  } finally {
    checkpoint._setScanCheckpointStrideForTest(null);
  }
  assert.equal(left().length, 1, 'a scan left its checkpoint');
}

async function refusedRedaction(session, named) {
  const logPath = sessionLogPath(session.id);
  const before = readFileSync(logPath);
  rememberSensitiveValues(session.id, [fill]);
  await assert.rejects(
    within(saveSessionDurably({ ...session, messages: [...session.messages, msg('four')] }), 'the redaction never settled'),
    (error) => error?.code === 'ESCANCHECKPOINT' && error.message.includes(named)
  );
  assert.ok(readFileSync(logPath).equals(before), 'the log is exactly as it was');
}

test('a checkpoint that cannot be removed fails the redaction and the delete before the log is touched', async (t) => {
  const id = 'sess_cp_unlink_fails';
  const session = await openedSession(id, 'u');
  const logPath = sessionLogPath(id);
  leaveCheckpoint(logPath);
  const [name] = left();
  const restore = failing(t, 'unlinkSync', (path) => path.endsWith(name));
  await refusedRedaction(session, name);
  assert.equal(await within(deleteSession(id), 'the delete never settled'), false, 'the delete did not happen');
  assert.ok(readFileSync(logPath).includes(CODE), 'the log is still there, unchanged');
  restore();
  await within(saveSessionDurably({ ...session, messages: [...session.messages, msg('four')] }), 'the retry never settled');
  assert.equal(readFileSync(logPath, 'utf8').includes(CODE), false, 'the redaction goes through once the checkpoint can be removed');
  assert.deepEqual(left(), []);
});

test('a checkpoint directory that cannot be listed fails the redaction before the log is touched', async (t) => {
  const id = 'sess_cp_list_fails';
  const session = await openedSession(id, 'l');
  leaveCheckpoint(sessionLogPath(id));
  failing(t, 'readdirSync', (path) => path === checkpoints);
  await refusedRedaction(session, checkpoints);
});

test('a lock that cannot be opened fails the redaction before the log is touched', async (t) => {
  const id = 'sess_cp_lock_fails';
  const session = await openedSession(id, 'k');
  // The lock directory is a file: no lock file can be made in it.
  rmSync(`${checkpoints}.locks`, { recursive: true, force: true });
  fs.writeFileSync(`${checkpoints}.locks`, 'not a directory');
  t.after(() => rmSync(`${checkpoints}.locks`, { force: true }));
  await refusedRedaction(session, '.lock');
});

test('a lock another process holds fails the redaction after the wait, before the log is touched', async (t) => {
  const id = 'sess_cp_lock_held';
  const session = await openedSession(id, 'h');
  const logPath = sessionLogPath(id);
  const child = startChild('retire', logPath);
  await child.heard('ready');
  child.tell('retire');
  await child.heard('retiring');
  try {
    checkpoint._setRetirementWaitForTest(200);
    t.after(() => checkpoint._setRetirementWaitForTest(null));
    await refusedRedaction(session, '.lock');
  } finally {
    await child.kill();
  }
});

test('a scan that adopted the old log cannot publish it', async () => {
  const id = 'sess_cp_adopted_old';
  await openedSession(id, 'o');
  const logPath = sessionLogPath(id);
  // What a scan that holds the old log's descriptor has: the state it reached.
  const fd = fs.openSync(logPath, 'r');
  const { ino, size } = fs.fstatSync(fd, { bigint: true });
  const bytes = fs.readFileSync(logPath);
  fs.closeSync(fd);
  const offset = Number(size);
  const state = {
    ino,
    offset,
    first: bytes.subarray(0, 1024),
    guard: bytes.subarray(offset - 1024, offset),
    replay: { base: {}, count: 2, length: 1, lastCompacted: 0, skipped: [], project: null, messages: null },
  };
  rememberSensitiveValues(id, [fill]);
  await within(saveSessionDurably({ id, owner: 'agent', messages: [msg('one'), msg('two'), msg('three'), msg('four')] }), 'the redaction never returned');
  checkpoint.saveScanCheckpointSync(checkpoints, logPath, state);
  assert.deepEqual(left(), [], 'the rewritten log is another file: nothing of the old one is published');
});
