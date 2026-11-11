#!/usr/bin/env node
// Golden twin of `src/runtime/agent/orchestrator/session/store/session-sequence.test.mjs`: the order of one session's
// lifecycle operations (saves, debounced saves, close, detach, delete) through the real store (`store.mjs`
// saveSession / saveSessionAsync / markSessionClosed / bumpSessionGeneration / deleteSession / drainSessionStore) and
// `manager/session-close.mjs` closeSession, on a temp data dir.
//
// Failure injection is the filesystem's: `fs.unlinkSync` of `<id>.log.jsonl` throws EACCES when the plan says so
// (the case's `unlinkPlan`, one entry per unlink the delete issues, in order). The debounce timer runs on node:test's
// mock clock (`mock.timers`, setTimeout only) and is NEVER advanced: every `setTimeout` the store arms is recorded
// (delay), and `drainSessionStore()` is the only flush. The 60 random scenarios are generated here by the test's
// seeded mulberry32 (input generator only); the recording keeps their ops.
//
//   node benchmarks/rust-core/recorders/record-session-sequence.mjs --tree <dir>
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exact } from './lib/exact.mjs';
import { DETERMINISM, DEADLINE_MS, installDeterminism, realClearTimeout, realSetTimeout } from './lib/session-wire-harness.mjs';
import { cleanup, runSessionRecorder } from './lib/session-rec.mjs';

const determinism = installDeterminism();

const root = mkdtempSync(join(tmpdir(), 'session-sequence-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_HOME = join(root, 'home');
mkdirSync(join(root, 'data', 'sessions'), { recursive: true });
mkdirSync(join(root, 'home'), { recursive: true });

await runSessionRecorder(import.meta.url, {
  set: 'session-sequence',
  testFile: 'src/runtime/agent/orchestrator/session/store/session-sequence.test.mjs',
  entry: 'Ran the real store.mjs (saveSession, saveSessionAsync, markSessionClosed, bumpSessionGeneration, deleteSession, drainSessionStore, getSessionLifecycleCommitError), store/transcript-durability.mjs (readDurableSessionRecord) and manager/session-close.mjs (closeSession) on a temp MIXDOG_DATA_DIR, with an EACCES injected into fs.unlinkSync of the session log and the debounce timer on the mock clock (never advanced). Did not run the 1.4.5 oracle `predict` as a check: the recording holds what Node did.',
  replay: 'mixdog-core-session actor ordering (S/close.rs detach/close, S/delete.rs delete_session, the item-commit barrier) driven by the same op list per case with the case\'s unlink failures injected in the store writer: compare each op\'s result, the lifecycle commit error, the stored record (messages, generation, closed) and the log file (normalised) whole.',
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: [
    'session ids drop the test\'s process id (sess_sequence_<tag>_<n>)',
    'the unlink plan is computed by the test\'s `predict` oracle (copied here only to place the injected failures); the recorded outcomes are Node\'s own',
    'every timer the store arms is recorded, the derived summary index\'s 1000 ms retry included (store-summary-index.mjs:518). A case ends on events, not on a count of event-loop turns: the recorder waits (10 s deadline) for the product\'s own settleSummaryIndexWrites(), and when the retry timer is armed the recorder ticks the mock clock by its delay (a recorded step in the case\'s clockSteps); the wait runs again after drainSessionStore()',
    'the recorded stored record is the whole readDurableSessionRecord result and the whole directory listing of the sessions dir (the OS\'s order), the log file is its exact text',
    'the random op lists come from the test\'s seeded generator (seed * 7919), recorded as inputs',
    'the temp data dir is a path under the OS temp dir: it is not recorded; a recorded string that holds it is a defect of the recording (the recorder fails on it)',
    ...DETERMINISM,
  ],
}, async ({ imp }) => {
  const store = await imp('src/runtime/agent/orchestrator/session/store.mjs');
  const { readDurableSessionRecord } = await imp('src/runtime/agent/orchestrator/session/store/transcript-durability.mjs');
  const { closeSession } = await imp('src/runtime/agent/orchestrator/session/manager/session-close.mjs');
  const { bumpSessionGeneration, deleteSession, drainSessionStore, getSessionLifecycleCommitError, markSessionClosed, saveSession, saveSessionAsync } = store;
  const { settleSummaryIndexWrites } = await imp('src/runtime/agent/orchestrator/session/store-summary-index.mjs');

  const sessions = join(root, 'data', 'sessions');
  const logPath = (id) => join(sessions, `${id}.log.jsonl`);

  // fs.unlinkSync of a session log fails while `failing(id)` says so (consulted once per unlink call)
  const unlinks = [];
  const realUnlink = fs.unlinkSync;
  let failing = () => false;
  fs.unlinkSync = function (path, ...rest) {
    const id = String(path).match(/[\\/]([^\\/]+)\.log\.jsonl$/)?.[1];
    if (id && String(path) === logPath(id)) {
      const fails = failing(id);
      unlinks.push({ id, fails });
      if (fails) throw Object.assign(new Error(`EACCES: injected, unlink '${path}'`), { code: 'EACCES' });
    }
    return realUnlink.call(this, path, ...rest);
  };
  syncBuiltinESMExports();

  // The mock clock: setTimeout only; each arming is recorded.
  mock.timers.enable({ apis: ['setTimeout'] });
  const armed = [];
  // The summary index's retry (1000 ms) is held here when armed: the recorder fires it itself (a recorded step) so that
  // the other mock timers (the 150 ms save debounce) are NOT advanced, as in the test.
  const retry = { fn: null, waiters: new Set() };
  // The end of a step is an event: the summary index has landed its queued writes. A flush the index refused re-arms its retry
  // on the mock clock; the recorder fires that retry (a recorded clock step) because nothing else would.
  const quiesce = async (clockSteps, label) => {
    let settled = false;
    const settling = settleSummaryIndexWrites().then(() => { settled = true; });
    const deadline = realSetTimeout(() => { throw new Error(`timed out waiting for the summary index to settle: ${label}`); }, DEADLINE_MS);
    try {
      while (!settled) {
        if (retry.fn) {
          const { fn } = retry;
          retry.fn = null;
          clockSteps.push({ fired: 'summary index retry timer (1000 ms)', after: label });
          fn();
          continue;
        }
        await Promise.race([settling, new Promise((resolve) => { retry.waiters.add(resolve); })]);
        retry.waiters.clear();
      }
    } finally { realClearTimeout(deadline); }
  };  const mockSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function (fn, delay, ...rest) {
    armed.push(delay ?? 1);
    if (delay === 1000) { retry.fn = fn; for (const w of [...retry.waiters]) w(); }
    return mockSetTimeout.call(this, fn, delay, ...rest);
  };

  // Whole values: the durable record as readDurableSessionRecord returns it, the log file's exact text and the sessions
  // directory's whole listing in the order the OS returned it.
  const state = (id) => ({
    stored: exact(readDurableSessionRecord(id)),
    logFile: existsSync(logPath(id)) ? readFileSync(logPath(id), 'utf8') : null,
    sessionsDir: readdirSync(sessions),
  });
  let sequence = 0;
  const label = (tag) => `sess_sequence_${tag}_${++sequence}`;
  async function newSession(tag) {
    const id = label(tag);
    const message = { role: 'user', content: 'm0' };
    const first = await saveSessionAsync({ id, generation: 0, closed: false, messages: [message] });
    await quiesce([], 'after the initial save');
    return { id, message, first };
  }

  const cases = [];
  // A case's end: the deferred summary writes landed, the store drained, the summary writes the drain queued landed.
  const finish = async (clockSteps) => {
    await quiesce(clockSteps, 'before drainSessionStore');
    drainSessionStore();
    await quiesce(clockSteps, 'after drainSessionStore');
  };
  try {
    // test line 64
    for (const fails of [false, true]) {
      const { id, first } = await newSession(fails ? 'detach_fail' : 'detach_ok');
      unlinks.length = 0; armed.length = 0;
      failing = (candidate) => fails && candidate === id;
      const deleting = deleteSession(id);
      const closing = closeSession(id, 'desktop-context-switch', { tombstone: false });
      const deleted = exact(await deleting);
      const closed = exact(await closing);
      failing = () => false;
      const clockSteps = [];
      await finish(clockSteps);
      cases.push({
        name: `detach-accepted-while-a-delete-${fails ? 'fails' : 'succeeds'}`,
        testLine: 64,
        input: { id, initialSave: { messages: ['m0'], generation: 0, closed: false }, ops: [{ op: 'deleteSession' }, { op: 'closeSession', reason: 'desktop-context-switch', options: { tombstone: false } }], unlinkPlan: [fails] },
        result: { firstSave: exact(first), deleted, closed, commitError: exact(getSessionLifecycleCommitError(id)), unlinks: unlinks.slice(), timersArmed: armed.slice(), clockSteps, ...state(id) },
      });
    }

    // test line 168: 60 random scenarios
    const seededRandom = (seed) => {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let v = s;
        v = Math.imul(v ^ (v >>> 15), v | 1);
        v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
        return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
      };
    };
    const KINDS = ['save', 'debounced', 'close', 'detach', 'delete', 'deleteFail'];
    const scenario = (random) => {
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
    };
    // Places the injected unlink failures (see exclusions): which deletes meet an existing session.
    const unlinkPlanOf = (ops, firstMessage) => {
      let st = { exists: true, messages: [firstMessage], generation: 0, closed: false };
      let slot = null;
      let client = [firstMessage];
      const plan = [];
      const dropped = (c) => st.exists && (st.generation > c.generation || (st.closed && st.generation >= c.generation));
      const write = (c) => { if (dropped(c)) return; st = { exists: true, messages: c.messages, generation: c.generation, closed: false }; };
      ops.forEach((kind, index) => {
        const message = { role: 'user', content: `m${index + 1}` };
        if (kind === 'save') { client = [...client, message]; slot = null; write({ messages: client, generation: 0 }); }
        else if (kind === 'debounced') { client = [...client, message]; slot = { messages: client, generation: 0 }; if (!st.exists) write(slot); }
        else if (kind === 'close' || kind === 'detach') {
          const existing = slot ?? (st.exists ? st : null);
          slot = null;
          if (!existing) return;
          st = { exists: true, messages: existing.messages, generation: existing.generation + 1, closed: kind === 'close' ? true : existing.closed === true };
        } else {
          const fails = kind === 'deleteFail' && st.exists;
          if (st.exists) plan.push(fails);
          if (!fails) { st = { exists: false }; slot = null; }
        }
      });
      return plan;
    };

    for (let seed = 1; seed <= 60; seed++) {
      const ops = scenario(seededRandom(seed * 7919));
      const { id, message: first } = await newSession(`random_${seed}`);
      const plan = unlinkPlanOf(ops, first);
      const queue = plan.slice();
      failing = () => queue.shift() === true;
      unlinks.length = 0; armed.length = 0;
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
      const results = exact(await Promise.all(pending));
      const clockSteps = [];
      await finish(clockSteps);
      failing = () => false;
      cases.push({
        name: `random-seed-${seed}`,
        testLine: 168,
        input: { id, seed, initialSave: { messages: ['m0'], generation: 0, closed: false }, ops: ops.map((kind, index) => ({ kind, content: `m${index + 1}` })), unlinkPlan: plan },
        result: { results, commitError: exact(getSessionLifecycleCommitError(id)), unlinkPlanLeft: queue.slice(), unlinks: unlinks.slice(), timersArmed: armed.slice(), clockSteps, ...state(id) },
      });
    }
  } finally {
    globalThis.setTimeout = mockSetTimeout;
    mock.timers.reset();
    fs.unlinkSync = realUnlink;
    syncBuiltinESMExports();
    drainSessionStore();
  }
  const text = JSON.stringify(cases);
  for (const leak of [root, root.replaceAll('\\', '\\\\')]) if (text.includes(leak)) throw new Error('the recording holds the temp data dir: ' + leak);
  return { cases };
});
cleanup(root);
