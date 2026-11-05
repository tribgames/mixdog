// Two real Mixdog processes on one data dir, each holding the same session:
// without a per-session writer claim the later save would record over the
// other process's records and silently discard its messages.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bumpSessionGeneration,
  deleteSession,
  drainSessionStore,
  getSessionSaveError,
  loadSession,
  releaseIdleSessionWriter,
  saveSession,
  saveSessionDurably,
  saveSessionAsync,
} from '../store.mjs';
import { resolveSessionRecordSync } from './session-log-reader.mjs';
import { loadLegacySession } from './legacy-session.mjs';
import { _sessionLogIoForTest } from './session-log-writer.mjs';
import { SAVE_OUTCOME_DROPPED } from './live-state.mjs';
import { claimSessionWriter, releaseIdleSessionWriterClaim } from './session-writer-claim.mjs';
import { acquireOsExclusiveLockSync } from '../../../../shared/os-exclusive-lock.mjs';
import { settleAndOpenTurn, settleTurnBase } from '../manager/ask-turn-open.mjs';
import { TurnPersistenceError } from '../manager/turn-durability.mjs';

const sessionLogIo = _sessionLogIoForTest();
const realLogWrite = sessionLogIo.writeSync;
// Every session-log batch write of this process fails while armed.
function setSessionSaveFault(armed) {
  sessionLogIo.writeSync = armed
    ? () => {
        throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
      }
    : realLogWrite;
}

// The session as its record says (the log, or the legacy json without one).
function storedSession(root, id) {
  const dir = join(root, 'sessions');
  const outcome = resolveSessionRecordSync({
    jsonPath: join(dir, `${id}.json`),
    logPath: join(dir, `${id}.log.jsonl`),
    loadLegacy: loadLegacySession,
  });
  return outcome.session;
}

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
    record: () => storedSession(root, id),
    onDisk: () => storedSession(root, id).messages.map((m) => m.content),
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
  await saveSessionDurably(f.session);
  const peer = startPeer(t, f.root);
  await peer.send({ op: 'load', id: f.id });
  const peerSave = await peer.send({ op: 'append', id: f.id, text: 'peer-1' });
  f.session.messages.push({ role: 'assistant', content: 'parent-2' });
  await saveSessionDurably(f.session);

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
  await saveSessionDurably(f.session);
  const peer = startPeer(t, f.root);
  await peer.send({ op: 'load', id: f.id });
  f.session.messages.push({ role: 'assistant', content: 'parent-2' });
  await saveSessionDurably(f.session);
  // Detach: this process stops writing the session and lets go of it.
  assert.equal(typeof (await bumpSessionGeneration(f.id, 'detach')), 'number');

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

  saveSession(parked('refused'), { expectedGeneration: loaded.generation });
  drainSessionStore();
  assert.deepEqual(f.onDisk(), ['peer-1']);
  assert.match(getSessionSaveError(f.id)?.message ?? '', /is open in another Mixdog process/);

  // Once the peer let go, the drain takes the lock itself and writes.
  await peer.exit();
  saveSession(parked('drained'), { expectedGeneration: loaded.generation });
  drainSessionStore();
  assert.deepEqual(f.onDisk(), ['peer-1', 'drained']);
});

test('a late save of a copy this process let go writes nothing', async (t) => {
  const f = fixture(t);
  await saveSessionDurably(f.session);
  const old = loadSession(f.id);
  assert.equal(await bumpSessionGeneration(f.id, 'detach'), 1);
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

test('a copy of the session another process recreated after a local delete is refused once that process deletes it', async (t) => {
  const f = fixture(t);
  await saveSessionDurably(f.session);
  assert.equal(await deleteSession(f.id), true);
  const creator = startPeer(t, f.root);
  assert.deepEqual(await creator.send({ op: 'create', id: f.id, text: 'peer-1' }), { saved: true });
  await creator.exit();
  // Read here from the record the other process created, not the one deleted here.
  const copy = loadSession(f.id);
  assert.deepEqual(
    copy.messages.map((m) => m.content),
    ['peer-1']
  );
  const deleter = startPeer(t, f.root);
  assert.deepEqual(await deleter.send({ op: 'delete', id: f.id }), { deleted: true, code: null });
  await deleter.exit();
  copy.messages.push({ role: 'assistant', content: 'parent-late' });
  await assert.rejects(saveSessionDurably(copy), { code: 'ESESSIONCHANGED' });
  assert.equal(f.record(), undefined, 'the copy recreated a session another process deleted');
});

test('a copy saved again behind a delete is judged by the session it was first taken from', async (t) => {
  const f = fixture(t);
  await saveSessionDurably(f.session);
  // A save accepted behind a delete that fails: its accepted copy becomes the live session.
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = function (path, ...rest) {
    if (String(path).includes(f.id))
      throw Object.assign(new Error(`EACCES: injected, unlink '${path}'`), { code: 'EACCES' });
    return realUnlink.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const deleting = deleteSession(f.id);
    f.session.messages = [...f.session.messages, { role: 'assistant', content: 'parent-2' }];
    const saving = saveSessionDurably(f.session);
    assert.deepEqual(await Promise.all([deleting, saving]), [false, 'saved']);
  } finally {
    fs.unlinkSync = realUnlink;
    syncBuiltinESMExports();
  }
  const accepted = loadSession(f.id);
  assert.notEqual(accepted, f.session, 'the live session is not the accepted copy');
  assert.deepEqual(
    accepted.messages.map((m) => m.content),
    ['parent-1', 'parent-2']
  );
  // This process lets go; the session's binding stays with the original.
  assert.equal(await releaseIdleSessionWriter(f.id), true);
  const deleter = startPeer(t, f.root);
  assert.deepEqual(await deleter.send({ op: 'delete', id: f.id }), { deleted: true, code: null });
  await deleter.exit();
  // Saved again behind a delete of the (now absent) record here: a copy of the
  // accepted copy, still a copy of the record the other process deleted.
  const deleting = deleteSession(f.id);
  accepted.messages = [...accepted.messages, { role: 'assistant', content: 'parent-late' }];
  const saving = saveSessionDurably(accepted);
  assert.equal(await deleting, true);
  await assert.rejects(saving, { code: 'ESESSIONCHANGED' });
  assert.equal(f.record(), undefined, 'the copy recreated a session another process deleted');
});

test('a turn that fails to open gives back the claim it took', async (t) => {
  const f = fixture(t);
  const peer = startPeer(t, f.root);
  assert.deepEqual(await peer.send({ op: 'create', id: f.id, text: 'peer-1' }), { saved: true });
  await peer.exit();
  // The transcript the turn opens on cannot be saved here.
  setSessionSaveFault(true);
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
  await saveSessionDurably(f.session);
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
  await assert.rejects(saveSessionDurably(f.session), { code: 'ESESSIONCHANGED' });
  assert.deepEqual(f.onDisk(), ['parent-1', 'peer-1']);

  // Opened again here, it reads what the peer wrote and writes as before.
  const session = loadSession(f.id);
  session.messages.push({ role: 'assistant', content: 'parent-2' });
  await saveSessionDurably(session);
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

test('a released tenure is remembered however many sessions were let go since', async (t) => {
  const f = fixture(t);
  await saveSessionDurably(f.session);
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
  await assert.rejects(saveSessionDurably(f.session), { code: 'ESESSIONCHANGED' });
  assert.deepEqual(f.onDisk(), ['parent-1', 'peer-1']);
});

test('a holder killed outright frees its session at once', async (t) => {
  const f = fixture(t);
  const peer = startPeer(t, f.root);
  assert.deepEqual(await peer.send({ op: 'create', id: f.id, text: 'peer-1' }), { saved: true });
  const loaded = loadSession(f.id);
  const refused = { ...loaded, messages: [...loaded.messages, { role: 'assistant', content: 'refused' }] };
  await assert.rejects(saveSessionDurably(refused), { code: 'ESESSIONCLAIMED' });

  // SIGKILL / TerminateProcess: no exit handler runs, the kernel drops the lock.
  await peer.kill();
  const session = loadSession(f.id);
  session.messages.push({ role: 'assistant', content: 'parent-2' });
  await saveSessionDurably(session);
  assert.deepEqual(f.onDisk(), ['peer-1', 'parent-2']);
});
