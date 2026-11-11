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
import { cleanup, runSessionRecorder } from './lib/session-rec.mjs';

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
  exclusions: [
    'session ids drop the test\'s process id (sess_sequence_<tag>_<n>)',
    'log file text: epoch uuids -> <uuid>, the random 24-hex logId -> <logid>, 13-digit millisecond timestamps -> <ms>; every other byte kept',
    'the unlink plan is computed by the test\'s `predict` oracle (copied here only to place the injected failures); the recorded outcomes are Node\'s own',
    'timers of 1000 ms are not recorded: the derived summary index (store-summary-index.mjs:446,518) re-arms a retry when two of its flushes overlap in real time, so their presence is not deterministic; the summary log is retired in the Rust core (decisions: derived data, MIG/src/stores.rs:102-103). The only store timer recorded is the 150 ms save debounce (pending-writes.mjs:24)',
    'the random op lists come from the test\'s seeded generator (seed * 7919), recorded as inputs',
  ],
}, async ({ imp }) => {
  const store = await imp('src/runtime/agent/orchestrator/session/store.mjs');
  const { readDurableSessionRecord } = await imp('src/runtime/agent/orchestrator/session/store/transcript-durability.mjs');
  const { closeSession } = await imp('src/runtime/agent/orchestrator/session/manager/session-close.mjs');
  const { bumpSessionGeneration, deleteSession, drainSessionStore, getSessionLifecycleCommitError, markSessionClosed, saveSession, saveSessionAsync } = store;

  const sessions = join(root, 'data', 'sessions');
  const logPath = (id) => join(sessions, `${id}.log.jsonl`);
  const turns = async (count) => { for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve)); };

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
  const mockSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function (fn, delay, ...rest) {
    // 1000 ms is the derived summary index's retry (store-summary-index.mjs SUMMARY_RETRY_DELAY_MS), armed only when two index flushes overlap in real time: not recorded (see exclusions).
    if (delay !== 1000) armed.push(delay ?? 1);
    return mockSetTimeout.call(this, fn, delay, ...rest);
  };

  const normLog = (text) => text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>').replace(/\b1[0-9]{12}\b/g, '<ms>').replace(/"logId":"[0-9a-f]{24}"/g, '"logId":"<logid>"');
  const state = (id) => {
    const stored = readDurableSessionRecord(id);
    return {
      stored: stored ? { messages: stored.messages.map((m) => m.content), generation: stored.generation, closed: stored.closed === true } : null,
      logFile: existsSync(logPath(id)) ? normLog(readFileSync(logPath(id), 'utf8')) : null,
      sessionFiles: readdirSync(sessions).filter((n) => n.includes(id)).sort(),
    };
  };

  let sequence = 0;
  const label = (tag) => `sess_sequence_${tag}_${++sequence}`;
  async function newSession(tag) {
    const id = label(tag);
    const message = { role: 'user', content: 'm0' };
    const first = await saveSessionAsync({ id, generation: 0, closed: false, messages: [message] });
    return { id, message, first };
  }

  const cases = [];
  try {
    // test line 64
    for (const fails of [false, true]) {
      const { id, first } = await newSession(fails ? 'detach_fail' : 'detach_ok');
      unlinks.length = 0; armed.length = 0;
      failing = (candidate) => fails && candidate === id;
      const deleting = deleteSession(id);
      const closing = closeSession(id, 'desktop-context-switch', { tombstone: false });
      const deleted = await deleting;
      const closed = await closing;
      failing = () => false;
      cases.push({
        name: `detach-accepted-while-a-delete-${fails ? 'fails' : 'succeeds'}`,
        testLine: 64,
        input: { id, initialSave: { messages: ['m0'], generation: 0, closed: false }, ops: [{ op: 'deleteSession' }, { op: 'closeSession', reason: 'desktop-context-switch', options: { tombstone: false } }], unlinkPlan: [fails] },
        result: { firstSave: first, deleted, closed, commitError: getSessionLifecycleCommitError(id), unlinks: unlinks.slice(), timersArmed: armed.slice(), ...state(id) },
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
      const results = await Promise.all(pending);
      await turns(5);
      drainSessionStore();
      failing = () => false;
      cases.push({
        name: `random-seed-${seed}`,
        testLine: 168,
        input: { id, seed, initialSave: { messages: ['m0'], generation: 0, closed: false }, ops: ops.map((kind, index) => ({ kind, content: `m${index + 1}` })), unlinkPlan: plan },
        result: { results: results.map((r) => (r === undefined ? null : r)), commitError: getSessionLifecycleCommitError(id), unlinkPlanLeft: queue.slice(), unlinks: unlinks.slice(), timersArmed: armed.slice(), ...state(id) },
      });
    }
  } finally {
    globalThis.setTimeout = mockSetTimeout;
    mock.timers.reset();
    fs.unlinkSync = realUnlink;
    syncBuiltinESMExports();
    drainSessionStore();
  }
  return { cases };
});
cleanup(root);
