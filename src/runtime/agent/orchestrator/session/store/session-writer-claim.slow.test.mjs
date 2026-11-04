// Two real Mixdog processes on one data dir, each holding the same session:
// every save replaces the whole record, so without a per-session writer claim
// the later save silently discards the other process's messages.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bumpSessionGeneration,
  drainSessionStore,
  getSessionSaveError,
  loadSession,
  parkSessionSnapshotForDrain,
  releaseIdleSessionWriter,
  saveSession,
  saveSessionAsync,
  setSessionSaveFault,
} from '../store.mjs';
import { SAVE_OUTCOME_DROPPED } from './live-state.mjs';
import { claimSessionWriter, releaseIdleSessionWriterClaim } from './session-writer-claim.mjs';
import { acquireWriteCommit, guardedSaveOptions, releaseWriteCommit } from './write-guards.mjs';
import { acquireOsExclusiveLockSync } from '../../../../shared/os-exclusive-lock.mjs';
import { settleAndOpenTurn, settleTurnBase } from '../manager/ask-turn-open.mjs';
import { TurnPersistenceError } from '../manager/turn-durability.mjs';

// Read when a fault is armed (setSessionSaveFault), not at import.
process.env.MIXDOG_SESSION_SAVE_FAULT_HOOKS = '1';

const PEER = fileURLToPath(new URL('./session-writer-claim.fixture.mjs', import.meta.url));

let sequence = 0;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-writer-claim-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'));
  const id = `sess_writer_claim_${process.pid}_${++sequence}`;
  t.after(() => {
    drainSessionStore();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    id,
    session: { id, generation: 0, closed: false, messages: [{ role: 'user', content: 'parent-1' }] },
    record: () => JSON.parse(readFileSync(join(root, 'sessions', `${id}.json`), 'utf8')),
    onDisk: () => JSON.parse(readFileSync(join(root, 'sessions', `${id}.json`), 'utf8')).messages.map((m) => m.content),
    lockPath: join(root, 'session-writer-locks', `${id}.lock`),
  };
}

function startPeer(t, root) {
  const child = spawn(process.execPath, [PEER], {
    env: { ...process.env, MIXDOG_DATA_DIR: root, MIXDOG_USER_DATA_BACKUP_ROOT: join(root, 'backups') },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const waiters = [];
  createInterface({ input: child.stdout }).on('line', (line) => waiters.shift()?.resolve(JSON.parse(line)));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  void exited.then((code) => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`peer exited (${code}): ${stderr}`));
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  return {
    send: (command) =>
      new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        child.stdin.write(`${JSON.stringify(command)}\n`);
      }),
    exit: async () => {
      child.stdin.end(`${JSON.stringify({ op: 'exit' })}\n`);
      assert.equal(await exited, 0, stderr);
    },
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
    },
  };
}

test('a second process cannot overwrite a session another live process holds', async (t) => {
  const f = fixture(t);
  saveSession(f.session, { sync: true });
  const peer = startPeer(t, f.root);
  await peer.send({ op: 'load', id: f.id });
  const peerSave = await peer.send({ op: 'append', id: f.id, text: 'peer-1' });
  f.session.messages.push({ role: 'assistant', content: 'parent-2' });
  saveSession(f.session, { sync: true });

  const onDisk = f.onDisk();
  assert.ok(!peerSave.saved || onDisk.includes('peer-1'), `the peer's landed save was lost: ${JSON.stringify(onDisk)}`);
  assert.equal(peerSave.code, 'ESESSIONCLAIMED');
  assert.match(peerSave.message, /is open in another Mixdog process/);
  assert.deepEqual(onDisk, ['parent-1', 'parent-2']);
  // Nor delete it from under this process.
  assert.deepEqual(await peer.send({ op: 'delete', id: f.id }), { deleted: false, code: 'ESESSIONCLAIMED' });
  assert.deepEqual(f.onDisk(), ['parent-1', 'parent-2']);
  // The claim is per session: the peer still writes a session of its own.
  assert.deepEqual(await peer.send({ op: 'create', id: `${f.id}_peer`, text: 'peer-own' }), { saved: true });
  await peer.exit();
});

test('a copy loaded before another process wrote is refused after that writer lets go', async (t) => {
  const f = fixture(t);
  saveSession(f.session, { sync: true });
  const peer = startPeer(t, f.root);
  await peer.send({ op: 'load', id: f.id });
  f.session.messages.push({ role: 'assistant', content: 'parent-2' });
  saveSession(f.session, { sync: true });
  // Detach: this process stops writing the session and lets go of it.
  assert.equal(typeof bumpSessionGeneration(f.id, 'detach'), 'number');

  const stale = await peer.send({ op: 'append', id: f.id, text: 'peer-stale' });
  assert.ok(f.onDisk().includes('parent-2'), `the parent's landed save was lost: ${JSON.stringify(f.onDisk())}`);
  assert.equal(stale.saved, false);
  assert.equal(stale.code, 'ESESSIONCHANGED');

  // Loaded again after the handoff, the peer is the session's writer.
  await peer.send({ op: 'load', id: f.id });
  assert.deepEqual(await peer.send({ op: 'append', id: f.id, text: 'peer-fresh' }), { saved: true });
  assert.deepEqual(f.onDisk(), ['parent-1', 'parent-2', 'peer-fresh']);
  await peer.exit();
});

test('an exit-drain snapshot is written only as the session writer', async (t) => {
  const f = fixture(t);
  const peer = startPeer(t, f.root);
  assert.deepEqual(await peer.send({ op: 'create', id: f.id, text: 'peer-1' }), { saved: true });
  const loaded = loadSession(f.id);
  const parked = (content) => ({ ...loaded, messages: [...loaded.messages, { role: 'assistant', content }] });

  parkSessionSnapshotForDrain(parked('refused'), { expectedGeneration: loaded.generation });
  drainSessionStore();
  assert.deepEqual(f.onDisk(), ['peer-1']);
  assert.match(getSessionSaveError(f.id)?.message ?? '', /is open in another Mixdog process/);

  // Once the peer let go, the drain takes the lock itself and writes.
  await peer.exit();
  parkSessionSnapshotForDrain(parked('drained'), { expectedGeneration: loaded.generation });
  drainSessionStore();
  assert.deepEqual(f.onDisk(), ['peer-1', 'drained']);
});

test('a late save of a copy this process let go writes nothing, not even through the save worker', async (t) => {
  const f = fixture(t);
  saveSession(f.session, { sync: true });
  const old = loadSession(f.id);
  assert.equal(bumpSessionGeneration(f.id, 'detach'), 1);
  old.messages.push({ role: 'assistant', content: 'late' });
  const late = saveSessionAsync(old);
  // Another holder takes the session the moment this process let it go.
  const other = acquireOsExclusiveLockSync(f.lockPath, { namespace: 'session-writer' });
  try {
    assert.equal(other.held, true);
    assert.equal(await late, SAVE_OUTCOME_DROPPED);
    assert.equal(f.record().generation, 1, 'the late save rolled the detach back');
    assert.deepEqual(f.onDisk(), ['parent-1']);
  } finally {
    other.release();
  }
});

test('a turn that fails to open gives back the claim it took', async (t) => {
  const f = fixture(t);
  const peer = startPeer(t, f.root);
  assert.deepEqual(await peer.send({ op: 'create', id: f.id, text: 'peer-1' }), { saved: true });
  await peer.exit();
  // The transcript the turn opens on cannot be saved here.
  setSessionSaveFault({ ids: f.id });
  try {
    await assert.rejects(settleTurnBase(f.id, { recoverCheckpoint: false }), TurnPersistenceError);
  } finally {
    setSessionSaveFault(null);
  }
  const next = startPeer(t, f.root);
  await next.send({ op: 'load', id: f.id });
  assert.deepEqual(await next.send({ op: 'append', id: f.id, text: 'peer-2' }), { saved: true });
  await next.exit();
});

test('an idle session lets its writer lock go and takes it again', async (t) => {
  const f = fixture(t);
  saveSession(f.session, { sync: true });
  const pending = saveSessionAsync(f.session);
  assert.equal(await releaseIdleSessionWriter(f.id), false, 'released with a write outstanding');
  await pending;
  assert.equal(await releaseIdleSessionWriter(f.id), true);

  const peer = startPeer(t, f.root);
  await peer.send({ op: 'load', id: f.id });
  assert.deepEqual(await peer.send({ op: 'append', id: f.id, text: 'peer-1' }), { saved: true });
  await peer.exit();
  // The copy still kept here is behind the record now: refused, not written over it.
  f.session.messages.push({ role: 'assistant', content: 'parent-stale' });
  assert.throws(() => saveSession(f.session, { sync: true }), { code: 'ESESSIONCHANGED' });
  assert.deepEqual(f.onDisk(), ['parent-1', 'peer-1']);

  // Opened again here, it reads what the peer wrote and writes as before.
  const session = loadSession(f.id);
  session.messages.push({ role: 'assistant', content: 'parent-2' });
  saveSession(session, { sync: true });
  assert.deepEqual(f.onDisk(), ['parent-1', 'peer-1', 'parent-2']);
});

test('a turn whose runtime claim fails after its base settled gives back the writer claim', async (t) => {
  const f = fixture(t);
  const peer = startPeer(t, f.root);
  assert.deepEqual(await peer.send({ op: 'create', id: f.id, text: 'peer-1' }), { saved: true });
  await peer.exit();
  const refused = new Error('the runtime claim was refused');
  await assert.rejects(
    settleAndOpenTurn(f.id, { recoverCheckpoint: false }, () => {
      throw refused;
    }),
    refused
  );
  const next = startPeer(t, f.root);
  await next.send({ op: 'load', id: f.id });
  assert.deepEqual(await next.send({ op: 'append', id: f.id, text: 'peer-2' }), { saved: true });
  await next.exit();
});

test('letting a writer lock go never blocks the thread while a rename is in flight', async (t) => {
  const f = fixture(t);
  saveSession(f.session, { sync: true });
  // A rename holds the session's commit lock, as the save worker's does mid-commit.
  const rename = acquireWriteCommit(guardedSaveOptions(f.id));
  assert.ok(rename);
  let ticked = false;
  setImmediate(() => {
    ticked = true;
  });
  const started = performance.now();
  const released = releaseIdleSessionWriter(f.id);
  assert.ok(performance.now() - started < 1000, 'the release waited for the rename on the thread');
  await new Promise(setImmediate);
  assert.equal(ticked, true);

  // The lock stays this process's until that rename lands.
  const peer = startPeer(t, f.root);
  await peer.send({ op: 'load', id: f.id });
  assert.equal((await peer.send({ op: 'append', id: f.id, text: 'peer-early' })).code, 'ESESSIONCLAIMED');
  releaseWriteCommit(rename);
  assert.equal(await released, true);
  assert.equal((await peer.send({ op: 'append', id: f.id, text: 'peer-1' })).saved, true);
  await peer.exit();
});

test('a released tenure is remembered however many sessions were let go since', async (t) => {
  const f = fixture(t);
  saveSession(f.session, { sync: true });
  assert.equal(await releaseIdleSessionWriter(f.id), true);
  // More released tenures than any cap on remembering them would keep.
  for (let i = 0; i < 4200; i++) {
    const id = `${f.id}_other_${i}`;
    writeFileSync(join(f.root, 'sessions', `${id}.json`), JSON.stringify({ id, generation: 0, messages: [] }));
    assert.equal(claimSessionWriter(id).held, true);
    assert.equal(await releaseIdleSessionWriterClaim(id), true);
  }
  const peer = startPeer(t, f.root);
  await peer.send({ op: 'load', id: f.id });
  assert.deepEqual(await peer.send({ op: 'append', id: f.id, text: 'peer-1' }), { saved: true });
  await peer.exit();
  // The copy kept here (built in memory, never parsed from a record) is behind it.
  f.session.messages.push({ role: 'assistant', content: 'parent-stale' });
  assert.throws(() => saveSession(f.session, { sync: true }), { code: 'ESESSIONCHANGED' });
  assert.deepEqual(f.onDisk(), ['parent-1', 'peer-1']);
});

test('a holder killed outright frees its session at once', async (t) => {
  const f = fixture(t);
  const peer = startPeer(t, f.root);
  assert.deepEqual(await peer.send({ op: 'create', id: f.id, text: 'peer-1' }), { saved: true });
  const loaded = loadSession(f.id);
  const refused = { ...loaded, messages: [...loaded.messages, { role: 'assistant', content: 'refused' }] };
  assert.throws(() => saveSession(refused, { sync: true }), { code: 'ESESSIONCLAIMED' });

  // SIGKILL / TerminateProcess: no exit handler runs, the kernel drops the lock.
  await peer.kill();
  const session = loadSession(f.id);
  session.messages.push({ role: 'assistant', content: 'parent-2' });
  saveSession(session, { sync: true });
  assert.deepEqual(f.onDisk(), ['peer-1', 'parent-2']);
});
