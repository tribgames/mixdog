import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { drainSessionStore, loadSession, readSessionLifecycleStateFromDisk, saveSession } from '../store.mjs';
import { currentPendingLifecycleToken, pendingLifecycleInvalidated } from '../manager/pending-lifecycle-epoch.mjs';
import { _sessionWriteAuthorityRefusal, _shouldDrop } from './write-admission.mjs';
import { _clearSessionSaveState, _liveSessions } from './live-state.mjs';

let sequence = 0;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-write-admission-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'));
  const id = `sess_write_admission_${process.pid}_${++sequence}a`;
  const path = join(root, 'sessions', `${id}.json`);
  const session = { id, generation: 1, closed: false, messages: [{ role: 'user', content: 'own conversation' }] };
  // Another process's writer: scratch file + rename onto the canonical path.
  const foreignReplace = (text) => {
    writeFileSync(`${path}.foreign`, text);
    renameSync(`${path}.foreign`, path);
  };
  t.after(() => {
    drainSessionStore();
    _liveSessions.delete(id);
    _clearSessionSaveState(id);
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { id, path, session, foreignReplace };
}

// Counts readFileSync calls on exactly one path, through the ESM bindings the
// store modules imported.
function countReads(t, path) {
  const original = fs.readFileSync;
  let count = 0;
  fs.readFileSync = function (file, ...rest) {
    if (String(file) === path) count++;
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  const restore = () => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  };
  t.after(restore);
  return {
    get count() {
      return count;
    },
    restore,
  };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('checks after own writes reuse the commit stamp and never read the session file', (t) => {
  const f = fixture(t);
  saveSession(f.session, { sync: true });
  const reads = countReads(t, f.path);
  for (let round = 0; round < 3; round++) {
    assert.equal(_shouldDrop(f.id, {}), false);
    assert.equal(_shouldDrop(f.id, { expectedGeneration: 1 }), false);
    assert.equal(_shouldDrop(f.id, { expectedGeneration: 0 }), true);
    assert.equal(_sessionWriteAuthorityRefusal(f.id), null);
    assert.deepEqual(readSessionLifecycleStateFromDisk(f.id), { state: 'open', generation: 1 });
    const token = currentPendingLifecycleToken(f.id);
    assert.equal(token, 'open:1');
    assert.equal(pendingLifecycleInvalidated(f.id, token), false);
    assert.equal(loadSession(f.id), f.session);
  }
  // A further own save: its pre-admission and all three drop checks are
  // stamp-served, and the new commit is stamped in turn.
  f.session.messages.push({ role: 'assistant', content: 'own reply' });
  saveSession(f.session, { sync: true, expectedGeneration: 1 });
  assert.equal(_shouldDrop(f.id, { expectedGeneration: 1 }), false);
  assert.equal(loadSession(f.id), f.session);
  assert.equal(reads.count, 0);
  reads.restore();
  assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).messages.length, 2);
});

test('a same-size foreign replacement misses the stamp and keeps the strict verdicts', (t) => {
  const f = fixture(t);
  saveSession(f.session, { sync: true });
  const own = readFileSync(f.path, 'utf8');
  const reads = countReads(t, f.path);

  // Ownership moved on: generation 1 → 2, byte length unchanged.
  const bumped = own.replace('"generation":1', '"generation":2');
  assert.equal(bumped.length, own.length);
  f.foreignReplace(bumped);
  assert.equal(_shouldDrop(f.id, { expectedGeneration: 1 }), true);
  assert.equal(_shouldDrop(f.id, {}), false);
  assert.deepEqual(readSessionLifecycleStateFromDisk(f.id), { state: 'open', generation: 2 });
  assert.ok(reads.count >= 2);

  // Another session's record, byte length unchanged.
  const foreignId = f.id.replace(/a$/, 'b');
  const foreign = own.replace(JSON.stringify(f.id), JSON.stringify(foreignId));
  assert.equal(foreign.length, own.length);
  f.foreignReplace(foreign);
  const before = reads.count;
  assert.equal(_shouldDrop(f.id, {}), true);
  assert.equal(_sessionWriteAuthorityRefusal(f.id), 'foreign');
  assert.deepEqual(readSessionLifecycleStateFromDisk(f.id), { state: 'unreadable', generation: 0 });
  assert.equal(currentPendingLifecycleToken(f.id), 'unreadable:0');
  assert.equal(loadSession(f.id), null);
  assert.ok(reads.count > before);
  // The save is dropped: the foreign bytes stay.
  saveSession(f.session, { sync: true });
  reads.restore();
  assert.equal(readFileSync(f.path, 'utf8'), foreign);
});

test('a settled record strictly parsed by a load answers the authority check; a foreign replacement is still read', async (t) => {
  const f = fixture(t);
  // Written by another process: no own-commit stamp exists for it.
  const own = JSON.stringify(f.session);
  f.foreignReplace(own);
  await new Promise((resolve) => setTimeout(resolve, 2100)); // past the racy-stamp window
  const reads = countReads(t, f.path);
  assert.equal(loadSession(f.id).messages[0].content, 'own conversation');
  assert.equal(reads.count, 1);
  assert.equal(_sessionWriteAuthorityRefusal(f.id), null);
  assert.equal(reads.count, 1, 'the verdict the load parsed is reused for the unchanged stamp');
  // The final drop verdict never uses it.
  assert.equal(_shouldDrop(f.id, { expectedGeneration: 1 }), false);
  assert.equal(reads.count, 2);
  const foreign = own.replace(JSON.stringify(f.id), JSON.stringify(f.id.replace(/a$/, 'b')));
  assert.equal(foreign.length, own.length);
  f.foreignReplace(foreign);
  assert.equal(_sessionWriteAuthorityRefusal(f.id), 'foreign');
  assert.equal(reads.count, 3, 'a foreign replacement is read strictly');
  assert.equal(_shouldDrop(f.id, {}), true);
});

test('an in-place same-size rewrite of our own inode misses the stamp', (t) => {
  const f = fixture(t);
  saveSession(f.session, { sync: true });
  const own = readFileSync(f.path, 'utf8');
  assert.equal(_shouldDrop(f.id, { expectedGeneration: 1 }), false);
  // Past one filesystem timestamp tick, rewrite the SAME inode in place.
  sleepMs(50);
  writeFileSync(f.path, own.replace('"closed":false', '"closed":true '));
  assert.equal(_shouldDrop(f.id, { expectedGeneration: 1 }), true);
  assert.deepEqual(readSessionLifecycleStateFromDisk(f.id), { state: 'closed', generation: 1 });
});
