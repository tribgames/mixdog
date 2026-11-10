// A delete is one operation in its session's order (session-sequence.mjs):
// saves, close/detach barriers and deletes accepted after it wait behind it
// and then run on what it actually did — never refused because it runs.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-sequence-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'), { recursive: true });

const {
  bumpSessionGeneration,
  deleteSession,
  drainSessionStore,
  getSessionLifecycleCommitError,
  markSessionClosed,
  saveSession,
  saveSessionAsync,
} = await import('../store.mjs');
const { readDurableSessionRecord } = await import('./transcript-durability.mjs');
const { closeSession } = await import('../manager/session-close.mjs');

test.after(() => {
  drainSessionStore();
  rmSync(root, { recursive: true, force: true });
});

const logPath = (id) => join(root, 'sessions', `${id}.log.jsonl`);
const turns = async (count) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};

// Unlinks of a session's log fail while `failing(id)` says so (EACCES).
function failLogUnlinks(t, failing) {
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = function (path, ...rest) {
    const id = String(path).match(/[\\/]([^\\/]+)\.log\.jsonl$/)?.[1];
    if (id && String(path) === logPath(id) && failing(id)) {
      throw Object.assign(new Error(`EACCES: injected, unlink '${path}'`), { code: 'EACCES' });
    }
    return realUnlink.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.unlinkSync = realUnlink;
    syncBuiltinESMExports();
  });
}

let sequence = 0;
async function newSession(tag) {
  const id = `sess_sequence_${process.pid}_${tag}_${++sequence}`;
  const message = { role: 'user', content: 'm0' };
  assert.equal(await saveSessionAsync({ id, generation: 0, closed: false, messages: [message] }), 'saved');
  return { id, message };
}

for (const failing of [false, true]) {
  test(`a detach accepted while a delete runs that ${failing ? 'fails' : 'succeeds'} closes as after it, without a barrier failure`, async (t) => {
    const { id } = await newSession(failing ? 'detach_fail' : 'detach_ok');
    failLogUnlinks(t, (candidate) => failing && candidate === id);
    const deleting = deleteSession(id);
    const closing = closeSession(id, 'desktop-context-switch', { tombstone: false });
    assert.equal(await deleting, !failing);
    assert.equal(await closing, true, 'the close failed because a delete was running');
    assert.equal(getSessionLifecycleCommitError(id), null);
    const stored = readDurableSessionRecord(id);
    if (failing) assert.equal(stored.generation, 1, 'the detach did not land on the intact session');
    else assert.equal(stored, null, 'the deleted session came back');
  });
}

// mulberry32
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ['save', 'debounced', 'close', 'detach', 'delete', 'deleteFail'];

// A random sequence. A second barrier needs a delete that deletes in between:
// a barrier of an already closed or detached session reads a copy whose own
// save was dropped, which is not what this test is about.
function scenario(random) {
  const ops = [];
  let barrier = false;
  const length = 3 + Math.floor(random() * 6);
  for (let i = 0; i < length; i++) {
    let kind = KINDS[Math.floor(random() * KINDS.length)];
    if ((kind === 'close' || kind === 'detach') && barrier) kind = 'save';
    if (kind === 'close' || kind === 'detach') barrier = true;
    if (kind === 'delete') barrier = false;
    ops.push(kind);
  }
  return ops;
}

// What v1.4.5, whose delete was synchronous, does with the same operations in
// the same order. Every copy the client saves carries generation 0 and
// expectedGeneration 0: a save after a close or detach is dropped, one after
// a delete creates the session anew. A save to an absent session creates its
// log when it is accepted (a debounced one too); an awaited save supersedes
// a debounced copy; a barrier folds the debounced copy in; a delete that
// deletes cancels it.
function predict(ops, firstMessage) {
  let state = { exists: true, messages: [firstMessage], generation: 0, closed: false };
  let slot = null;
  let client = [firstMessage];
  const results = [];
  const unlinkFails = [];
  const dropped = (copy) =>
    state.exists && (state.generation > copy.generation || (state.closed && state.generation >= copy.generation));
  const write = (copy) => {
    if (dropped(copy)) return 'dropped';
    state = { exists: true, messages: copy.messages, generation: copy.generation, closed: false };
    return 'saved';
  };
  ops.forEach((kind, index) => {
    const message = { role: 'user', content: `m${index + 1}` };
    if (kind === 'save') {
      client = [...client, message];
      slot = null;
      results.push(write({ messages: client, generation: 0 }));
    } else if (kind === 'debounced') {
      client = [...client, message];
      slot = { messages: client, generation: 0 };
      if (!state.exists) write(slot);
      results.push(undefined);
    } else if (kind === 'close' || kind === 'detach') {
      const existing = slot ?? (state.exists ? state : null);
      slot = null;
      if (!existing) {
        results.push(null);
        return;
      }
      state = {
        exists: true,
        messages: existing.messages,
        generation: existing.generation + 1,
        closed: kind === 'close' ? true : existing.closed === true,
      };
      results.push(state.generation);
    } else {
      const fails = kind === 'deleteFail' && state.exists;
      if (state.exists) unlinkFails.push(fails);
      if (!fails) {
        state = { exists: false };
        slot = null;
      }
      results.push(!fails);
    }
  });
  if (slot) write(slot);
  return { state, results, unlinkFails };
}

test('random saves, debounced saves, closes, detaches and deletes end as v1.4.5 ends them, none refused because a delete ran', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const plans = new Map(); // id → the unlink outcomes still to come, in order
  failLogUnlinks(t, (id) => plans.get(id)?.shift() === true);
  for (let seed = 1; seed <= 60; seed++) {
    const ops = scenario(seededRandom(seed * 7919));
    const { id, message: first } = await newSession(`random_${seed}`);
    const expected = predict(ops, first);
    plans.set(id, expected.unlinkFails.slice());
    // Every operation is accepted in this one synchronous pass, in order.
    let client = [first];
    const pending = ops.map((kind, index) => {
      if (kind === 'save' || kind === 'debounced') {
        client = [...client, { role: 'user', content: `m${index + 1}` }];
        const copy = { id, generation: 0, closed: false, messages: client };
        if (kind === 'save') return saveSessionAsync(copy, { expectedGeneration: 0 });
        saveSession(copy, { expectedGeneration: 0 });
        return undefined;
      }
      if (kind === 'close') return markSessionClosed(id, 'test');
      if (kind === 'detach') return bumpSessionGeneration(id, 'detach');
      return deleteSession(id);
    });
    const what = `seed ${seed}: ${ops.join(' → ')}`;
    const results = await Promise.all(pending);
    await turns(5);
    drainSessionStore();
    assert.deepEqual(results, expected.results, `${what}: outcomes`);
    assert.equal(getSessionLifecycleCommitError(id), null, `${what}: a barrier failed`);
    assert.deepEqual(plans.get(id), [], `${what}: unlinks`);
    const stored = readDurableSessionRecord(id);
    if (!expected.state.exists) {
      assert.equal(stored, null, `${what}: the session is there`);
      continue;
    }
    assert.ok(stored, `${what}: the session is gone`);
    assert.deepEqual(
      stored.messages.map((m) => m.content),
      expected.state.messages.map((m) => m.content),
      `${what}: messages`
    );
    assert.equal(stored.generation, expected.state.generation, `${what}: generation`);
    assert.equal(stored.closed === true, expected.state.closed, `${what}: closed`);
  }
});
