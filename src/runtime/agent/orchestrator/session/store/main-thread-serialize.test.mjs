// A session save never serializes the whole record on the main thread: a
// durable save of a multi-MB session and the save every open runtime makes
// when a bot profile changes hand the record to the save worker, which
// projects and stringifies it there, and the bytes on disk are the record.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-main-serialize-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));

const { saveSessionDurably } = await import('../store.mjs');
const { subscribeSessionPersistence } = await import('./session-persistence-events.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');
const { followAgentProfileChanges } = await import('../../../../../session-runtime/boot/apis.mjs');
const { publishAgentProfileChange } = await import('../../../../../session-runtime/agent-profile-changes.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  (await import('./session-writer-claim.mjs')).releaseHeldSessionWriters();
  rmSync(root, { recursive: true, force: true });
});

const RECORD_BYTES = 2 * 1024 * 1024;
const onDisk = (id) => JSON.parse(readFileSync(join(root, 'sessions', `${id}.json`), 'utf8'));

/** A session record of about RECORD_BYTES. */
function largeSession(id) {
  const messages = Array.from({ length: 400 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `${index} `.padEnd(RECORD_BYTES / 400, 'x'),
  }));
  return { id, owner: 'user', generation: 0, closed: false, messages };
}

/** Lengths of every main-thread JSON.stringify result at least half a record. */
function spyWholeRecordStringify(t) {
  const original = JSON.stringify;
  const whole = [];
  JSON.stringify = function (...args) {
    const text = original.apply(this, args);
    if (typeof text === 'string' && text.length >= RECORD_BYTES / 2) whole.push(text.length);
    return text;
  };
  t.after(() => {
    JSON.stringify = original;
  });
  return whole;
}

// The debounce timer is unref'd: the bound keeps the loop alive meanwhile.
function landed(id) {
  return new Promise((resolve, reject) => {
    const bound = setTimeout(() => reject(new Error(`${id} never landed`)), 10_000);
    const unsubscribe = subscribeSessionPersistence((sessionId, event) => {
      if (sessionId !== id || event !== 'landed') return;
      clearTimeout(bound);
      unsubscribe();
      resolve();
    });
  });
}

test('a durable save of a multi-MB session runs no whole-record stringify on the main thread', async (t) => {
  const session = largeSession('sess_serialize_durable');
  const whole = spyWholeRecordStringify(t);
  await saveSessionDurably(session);
  assert.deepEqual(whole, [], 'whole-record stringify on the main thread');
  // Durable when it resolved, and byte-for-byte the record.
  assert.equal(readFileSync(join(root, 'sessions', `${session.id}.json`), 'utf8'), JSON.stringify(session));
});

test('a profile change saves only the open sessions it changed, none serialized on the main thread', async (t) => {
  const ids = ['sess_serialize_open_a', 'sess_serialize_open_b', 'sess_serialize_open_c', 'sess_serialize_open_d'];
  const runtimes = ids.map((id) => ({ session: largeSession(id), changed: id !== 'sess_serialize_open_d' }));
  for (const { session } of runtimes) await saveSessionDurably(session);
  const saved = new Set();
  const unsubscribe = subscribeSessionPersistence((sessionId, event) => {
    if (event === 'landed') saved.add(sessionId);
  });
  t.after(unsubscribe);
  for (const runtime of runtimes) {
    const boot = {
      rt: runtime,
      // The rebuilt prompt of a thread the change reached.
      refreshAgentProfile: async () => {
        if (!runtime.changed) return false;
        runtime.session.systemPrompt = `rebuilt for ${runtime.session.id}`;
        return true;
      },
      invalidateContextStatusCache() {},
    };
    t.after(followAgentProfileChanges(boot));
  }
  const whole = spyWholeRecordStringify(t);
  const changed = runtimes.filter((runtime) => runtime.changed);
  const allLanded = Promise.all(changed.map(({ session }) => landed(session.id)));
  await publishAgentProfileChange();
  await allLanded;
  assert.deepEqual(whole, [], 'whole-record stringify on the main thread');
  for (const { session } of changed) assert.equal(onDisk(session.id).systemPrompt, `rebuilt for ${session.id}`);
  assert.equal(saved.has('sess_serialize_open_d'), false, 'a session the change left alone is not saved');
  assert.equal(onDisk('sess_serialize_open_d').systemPrompt, undefined);
});
