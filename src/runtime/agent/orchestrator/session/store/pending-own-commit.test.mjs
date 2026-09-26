// A peer realm announces the scratch identity before renaming it onto the
// canonical path. A read-only lifecycle check landing between the rename and
// the commit announcement adopts it without a whole-file read; a withdrawn
// (failed) rename, a foreign replacement and every write-authority check read
// strictly. The peer is simulated deterministically on a MessageChannel.
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MessageChannel } from 'node:worker_threads';

const root = mkdtempSync(join(tmpdir(), 'mixdog-pending-own-commit-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));

const { readSessionLifecycleStateFromDisk } = await import('../store.mjs');
const { _shouldDrop } = await import('./write-admission.mjs');
const { connectOwnCommitPeer, stampSessionScratch, lifecycleOfSessionDocument } = await import('./canonical-reader.mjs');

const channel = new MessageChannel();
connectOwnCommitPeer(channel.port1);
const peer = channel.port2;

test.after(() => {
  connectOwnCommitPeer(null);
  peer.close();
  rmSync(root, { recursive: true, force: true });
});

const fileOf = (id) => join(root, 'sessions', `${id}.json`);
const doc = (id, generation) => ({ id, closed: false, generation, messages: [{ role: 'user', content: 'x'.repeat(2048) }] });
const place = (id, value) => {
  writeFileSync(`${fileOf(id)}.first`, JSON.stringify(value));
  renameSync(`${fileOf(id)}.first`, fileOf(id));
};
function scratchFor(id, value) {
  const tmp = `${fileOf(id)}.scratch`;
  writeFileSync(tmp, JSON.stringify(value));
  return { tmp, stamp: stampSessionScratch(tmp), lifecycle: lifecycleOfSessionDocument(value) };
}
function countReads(t, path) {
  const original = fs.readFileSync;
  let count = 0;
  fs.readFileSync = function (file, ...rest) {
    if (String(file) === path) count++;
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  });
  return () => count;
}

test('a check between the peer rename and its commit announcement adopts the announced identity', (t) => {
  const id = 'sess_pending_between';
  place(id, doc(id, 1));
  const next = scratchFor(id, doc(id, 1));
  peer.postMessage({ target: fileOf(id), pending: { stamp: next.stamp, value: next.lifecycle } });
  renameSync(next.tmp, fileOf(id)); // the rename landed; no commit message yet
  const reads = countReads(t, fileOf(id));
  assert.deepEqual(readSessionLifecycleStateFromDisk(id), { state: 'open', generation: 1 });
  assert.equal(reads(), 0, 'no whole-file read');
  assert.equal(_shouldDrop(id, { expectedGeneration: 1 }), false);
  assert.equal(reads(), 1, 'write authority still reads strictly');
});

test('a withdrawn (failed) rename clears the pending identity: the next check reads strictly', (t) => {
  const id = 'sess_pending_withdrawn';
  place(id, doc(id, 1));
  const next = scratchFor(id, doc(id, 1));
  peer.postMessage({ target: fileOf(id), pending: { stamp: next.stamp, value: next.lifecycle } });
  peer.postMessage({ target: fileOf(id), withdraw: next.stamp });
  // Even a file that later carries that very identity is no longer vouched for.
  renameSync(next.tmp, fileOf(id));
  const reads = countReads(t, fileOf(id));
  assert.deepEqual(readSessionLifecycleStateFromDisk(id), { state: 'open', generation: 1 });
  assert.equal(reads(), 1);
});

test('a foreign replacement never matches an announced identity and is read strictly', (t) => {
  const id = 'sess_pending_foreign';
  place(id, doc(id, 1));
  const ours = scratchFor(id, doc(id, 1));
  peer.postMessage({ target: fileOf(id), pending: { stamp: ours.stamp, value: ours.lifecycle } });
  rmSync(ours.tmp);
  place(id, doc('sess_pending_someone_else', 1));
  const reads = countReads(t, fileOf(id));
  assert.equal(readSessionLifecycleStateFromDisk(id).state, 'unreadable');
  assert.equal(reads(), 1);
});
