// Checkpoints of a session log across processes: what each interleaving of a
// scan that publishes a checkpoint and a delete (or, in the next patch, a
// redaction) that retires the log's checkpoints guarantees, and the tests that force the cells that
// needed a design (session-scan-checkpoint.mjs holds the invariant).
//
// Scan steps: S1 read the log; S2 publish = take the log's OS lock without
// waiting, check the log is still the file S1 read (identity, length, first and
// last bytes), write the checkpoint (temp file, rename), release.
// Retirement steps: R1 take the lock (waiting for a publisher), R2 remove
// every file of the log's checkpoints, R3 delete (or rewrite) the log, R4 release.
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
// | S2 written by another build | any                            | out of reach: adoption (log id, identity, bytes) refuses it, the sweep removes it |   |
// No cell leaves a checkpoint of the old log on disk once the rewrite or delete has returned.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-scan-checkpoint-processes-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'), { recursive: true });

const { deleteSession, drainSessionStore, saveSessionDurably } = await import('../store.mjs');
const { readSessionLogSync } = await import('./session-log-reader.mjs');
const { sessionLogPath, sessionScanCheckpointDir } = await import('./session-paths.mjs');
const checkpoint = await import('./session-scan-checkpoint.mjs');

const DEADLINE_MS = 30_000;
const CODE = '482913';
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

test('a publisher killed in its publication leaves nothing once the delete has returned', async () => {
  const id = 'sess_cp_killed_publisher';
  await openedSession(id, 'd');
  const logPath = sessionLogPath(id);
  const child = startChild('die-publishing', logPath);
  await child.heard('ready');
  child.tell('scan');
  await child.heard('publishing');
  assert.ok(left().length > 0, 'the dead publisher leaves its temporary file');
  // The delete starts with the publisher holding the lock: it waits for the
  // kernel to drop it with the process.
  const deletion = deleteSession(id);
  await child.kill();
  assert.equal(await within(deletion, 'the delete never returned after the publisher died'), true);
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