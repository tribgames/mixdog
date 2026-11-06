#!/usr/bin/env node
// Golden twin of Mixy's heartbeat tick (`session-runtime/mixy-heartbeat.mjs` createMixyHeartbeat):
// scripted timelines over fake sources, each step's outcome and the state file it left. Rust
// `mixdog_services::bots::beat` must answer every step the same.
//
//   node benchmarks/rust-core/recorders/record-heartbeat.mjs --tree <dir>
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const beat = await importFrom(tree, 'src/session-runtime/mixy-heartbeat.mjs');
const { HEARTBEAT_LIMITS, createMixyHeartbeat, heartbeatStateSettled } = beat;

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 0, 1, 9);
const INTERVAL = HEARTBEAT_LIMITS.intervalMs;
const facts = (extra = {}) => ({ sessions: [], tasks: [], approvals: 0, routines: [], ...extra });
const activity = facts({ sessions: [{ id: 'sess_lead_1', bot: '', title: 'Report', preview: 'Draft done' }] });
const failing = (failures) => facts({ routines: [{ kind: 'schedule', name: 'daily-news', enabled: true, failures }] });

/** A heartbeat over fakes, as the Node test harness builds one. */
function rig({ facts: initial = activity, routeKey = 'fake/tiny/', decide = () => ({ action: 'nothing' }), wake, state: seed, release } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'record-heartbeat-'));
  const path = join(dir, 'heartbeat.json');
  if (seed) writeFileSync(path, JSON.stringify(seed));
  let clock = T0;
  const s = { facts: initial, routeKey, userTurnAt: 0, enabled: true, mixy: true };
  const calls = { collect: [], decide: 0, wake: [], notify: [] };
  const deps = (extra = {}) => ({
    now: () => clock, path,
    isEnabled: async () => s.enabled, mixyExists: async () => s.mixy, intervalMs: async () => INTERVAL,
    userTurnAt: () => s.userTurnAt, appInputAt: () => 0,
    collect: async (input) => { calls.collect.push(input.since); if (typeof s.facts === 'function') return s.facts(); return structuredClone(s.facts); },
    routeKey: async () => s.routeKey,
    decide: async (input) => { calls.decide += 1; return decide(input); },
    review: async () => ({ action: 'unmanaged' }),
    readTail: async () => ({ rows: [], head: '' }),
    wake: async (input, hooks) => { calls.wake.push(input.items); return wake ? wake(input, hooks) : { quiet: false, text: 'Reported.' }; },
    notify: async (text) => calls.notify.push(text),
    log: () => {},
    ...(release ? { release } : {}),
    ...extra,
  });
  const heartbeat = createMixyHeartbeat(deps());
  const steps = [];
  const read = async () => { await heartbeatStateSettled(path); try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
  return {
    s, calls, steps,
    advance: (ms = INTERVAL) => (clock += ms),
    at: () => clock,
    async tick(label) {
      const outcome = await heartbeat.tick();
      steps.push({ label, at: clock, outcome, state: await read() });
      return outcome;
    },
    done() { rmSync(dir, { recursive: true, force: true }); },
  };
}

const scenarios = {};

// A failing routine with the Maintainer off: arm, wake, then an empty digest.
{
  const h = rig({ routeKey: '', facts: failing(3) });
  await h.tick('arm'); h.advance();
  await h.tick('wake'); h.advance();
  await h.tick('empty'); h.advance(1);
  await h.tick('waiting');
  scenarios.routineWake = { steps: h.steps, wakes: h.calls.wake, collects: h.calls.collect };
  h.done();
}

// The idle gate: 29 quiet minutes defer, 30 run.
{
  const h = rig({ facts: activity });
  await h.tick('arm'); h.advance();
  h.s.userTurnAt = h.at() - 29 * MINUTE;
  await h.tick('29 minutes');
  h.s.userTurnAt = h.at() - 30 * MINUTE;
  await h.tick('30 minutes');
  scenarios.idleGate = { steps: h.steps, collects: h.calls.collect };
  h.done();
}

// A failed collection keeps the watermark and waits for the next interval.
{
  let broken = true;
  const h = rig({ facts: () => { if (broken) throw new Error('catalog unavailable'); return structuredClone(activity); } });
  await h.tick('arm'); h.advance();
  await h.tick('broken');
  await h.tick('same minute');
  broken = false; h.advance();
  await h.tick('fixed');
  scenarios.failedCollection = { steps: h.steps, collects: h.calls.collect };
  h.done();
}

// A wake that rejects keeps the digest and the routine report.
{
  let reject = true;
  const h = rig({ routeKey: '', facts: failing(3), wake: () => { if (reject) throw new Error('no Lead model is chosen'); return { quiet: false, text: 'Reported.' }; } });
  await h.tick('arm'); h.advance();
  await h.tick('rejected');
  reject = false; h.advance();
  await h.tick('woke'); h.advance();
  await h.tick('empty');
  scenarios.rejectedWake = { steps: h.steps, wakes: h.calls.wake };
  h.done();
}

// A routine wake after a failed Maintainer call commits only the routine warning.
{
  let down = true;
  const h = rig({
    facts: facts({ ...failing(3), sessions: activity.sessions }),
    decide: () => { if (down) throw new Error('503 overloaded'); return { action: 'wake', items: ['The report draft is ready'] }; },
  });
  await h.tick('arm'); h.advance();
  await h.tick('routine only');
  down = false; h.advance();
  await h.tick('judged');
  scenarios.failedGate = { steps: h.steps, wakes: h.calls.wake, collects: h.calls.collect };
  h.done();
}

// Three unusable replies trip the breaker: one notice, then the routine rule.
{
  const h = rig({ decide: () => null });
  await h.tick('arm'); h.advance();
  for (let i = 1; i <= 4; i += 1) { await h.tick(`unusable ${i}`); h.advance(); }
  h.s.routeKey = 'fake/other/'; h.s.facts = facts({ approvals: 1 });
  await h.tick('new model');
  scenarios.parseBreaker = { steps: h.steps, decides: h.calls.decide, notices: h.calls.notify };
  h.done();
}

// Five provider failures trip it; a failing routine still wakes Mixy.
{
  const h = rig({ decide: () => { throw new Error('503 overloaded'); } });
  await h.tick('arm'); h.advance();
  for (let i = 1; i <= 5; i += 1) { await h.tick(`failed ${i}`); h.advance(); }
  h.s.facts = failing(3);
  await h.tick('routine');
  scenarios.providerBreaker = { steps: h.steps, decides: h.calls.decide, notices: h.calls.notify, wakes: h.calls.wake };
  h.done();
}

// A close that did not land is kept, retried first on the next tick; twenty block new checks.
{
  const closes = [];
  const h = rig({
    routeKey: '', facts: failing(3),
    release: async (id) => { closes.push(id); return closes.length > 1; },
    wake: async (_input, hooks) => { await hooks.unreleased('sess_hidden_1'); return { quiet: false, text: 'Reported.' }; },
  });
  await h.tick('arm'); h.advance();
  await h.tick('wake');
  await h.tick('retry');
  scenarios.retryRelease = { steps: h.steps, closes };
  h.done();
}
{
  const ids = Array.from({ length: 20 }, (_, i) => `sess_daemon_left${i}`);
  const h = rig({ routeKey: '', facts: failing(3), state: { unreleased: ids }, release: async () => false });
  await h.tick('arm'); h.advance();
  await h.tick('blocked');
  scenarios.blocked = { ids, steps: h.steps, wakes: h.calls.wake, decides: h.calls.decide };
  h.done();
}
{
  const ids = Array.from({ length: 19 }, (_, i) => `sess_daemon_left${i}`);
  const closes = [];
  const h = rig({ routeKey: '', facts: failing(3), state: { unreleased: ids }, release: async (id) => { closes.push(id); return false; } });
  await h.tick('arm'); h.advance();
  await h.tick('under the cap');
  scenarios.underCap = { ids, steps: h.steps, closes, wakes: h.calls.wake };
  h.done();
}

writeJson(join(FIXTURES_ROOT, 'heartbeat', 'heartbeat-twin.json'), { T0, interval: INTERVAL, scenarios });
writeSetManifest(join(FIXTURES_ROOT, 'heartbeat'), {
  set: 'heartbeat',
  recorder: 'benchmarks/rust-core/recorders/record-heartbeat.mjs',
  command: 'node benchmarks/rust-core/recorders/record-heartbeat.mjs --tree <tree>',
  identityTree: tree,
});
console.log(`recorded ${Object.keys(scenarios).length} heartbeat scenarios`);
