#!/usr/bin/env node
// Genuine 1.4.5 held requests, end to end: which runs hold an approval and which do not, what a hold posts and pushes, how it is
// answered, what the audit and the grants store hold afterwards, and what Mixy's heartbeat counts while it waits.
//
// The entry is Node's own tool-call gate, `applyBeforeToolHook` (loop/tool-exec/before-hook.mjs): the PreToolUse hook, the human
// gate (`humanGateDecision`), `resolvePreToolAskApproval` over the unattended port that session-runtime/held-requests.mjs installs,
// the process's held-request registry, `resolveHeldRequest` (the call a client's answer ends in, lifecycle.mjs `resolveToolApproval`)
// and `collectHeartbeatFacts` (mixy-heartbeat.mjs) with its default `pendingHeldRequests`. The runs are Node's: a room member's own
// session, a schedule and a webhook run marked with `markUnattendedRun`, and an ordinary session; each with and without the approval
// UI (`toolApprovalHook`).
//
// Seams of the recorder (lib/held-runs-hooks.mjs): the row a hold posts is recorded instead of queued (`deliverHeldRequest`), and the
// audit writes run in call order and are awaited through their own promises. Time is a virtual clock plus a virtual timer queue
// (due time, then registration order, one callback at a time, microtasks drained between): `Date.now`, `setTimeout`, `clearTimeout`.
// Ids are a seeded `randomUUID`. A request is "held" when Node's own push (`registerHeldRequestNotifier`) fires before the call settles;
// nothing sleeps or polls.
//
//   node benchmarks/rust-core/recorders/record-held-runs.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/held-runs/golden.json (+ MANIFEST.json, identity exact at the commit). The `script` of each scenario is
// the recorder's input; the Rust replay drives the composed gate with the same script and compares its whole trace.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import nodeCrypto from 'node:crypto';
import { register, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-held-runs.mjs';

// Every user directory points at a fresh temp dir before any Mixdog module loads.
const sandbox = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'rec-held-runs-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(sandbox, name.toLowerCase());
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
register(new URL('./lib/held-runs-hooks.mjs', import.meta.url));

const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);

// ---- virtual time -------------------------------------------------------------------------------------------------------------
let NOW = 0;
const timers = { seq: 0, queue: [], registered: 0, fired: 0 };
Date.now = () => NOW;
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  const timer = { due: NOW + Math.max(0, Number(ms) || 0), seq: timers.seq++, fn, args };
  timers.queue.push(timer);
  timers.registered += 1;
  return Object.assign(timer, { ref: () => timer, unref: () => timer, hasRef: () => true, refresh: () => timer });
};
globalThis.clearTimeout = (timer) => {
  const at = timers.queue.indexOf(timer);
  if (at >= 0) timers.queue.splice(at, 1);
};
async function advance(ms) {
  const target = NOW + ms;
  for (;;) {
    const due = timers.queue.filter((t) => t.due <= target).sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
    if (!due) break;
    timers.queue.splice(timers.queue.indexOf(due), 1);
    NOW = due.due;
    timers.fired += 1;
    due.fn(...due.args);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }
  NOW = target;
}
let uuids = 0;
nodeCrypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`;
syncBuiltinESMExports();

// ---- the product --------------------------------------------------------------------------------------------------------------
const { applyBeforeToolHook } = await imp('src/runtime/agent/orchestrator/session/loop/tool-exec/before-hook.mjs');
const { markUnattendedRun } = await imp('src/session-runtime/held-requests.mjs');
const { collectHeartbeatFacts } = await imp('src/session-runtime/mixy-heartbeat.mjs');
const { roomMemberSessionId } = await imp('src/runtime/agent/orchestrator/session/agent-room.mjs');
const { createHumanGateStore, setHumanGateStore } = await imp('src/runtime/agent/orchestrator/session/human-gate/store.mjs');
const { registerHeldRequestNotifier, resolveHeldRequest } = await imp('src/runtime/shared/held-request-host.mjs');

const dataDir = process.env.MIXDOG_DATA_DIR;
mkdirSync(join(dataDir, 'agents', 'ann'), { recursive: true });
writeFileSync(join(dataDir, 'agents', 'ann', 'AGENT.md'), '---\nkind: bot\n---\nHelp the user.\n');

const ROOM = roomMemberSessionId('room123abc', 'ann');
const SESSIONS = { room: ROOM, schedule: 'sess_run_sched', webhook: 'sess_run_hook', plain: 'sess_plain' };
const COMMENT = { name: 'github', args: { action: 'pr.comment', repo: 'o/r', number: 4, body: 'ARG-SENTINEL-77' } };
const SHELL = { name: 'shell', args: { command: 'echo hi' } };
const HOOK_ASK = { action: 'ask', reason: 'needs approval' };
const APPROVE = { approved: true, response: 'approve', device: 'Pixel' };
const APPROVE_AGENT = { ...APPROVE, remember: 'agent' };
const DENY = { approved: false, response: 'deny', reason: 'not now', device: 'Pixel' };
const ask = (id, session, call, { hook = null, ui = null } = {}) => ({ op: 'ask', id, session, call, hook, ui });

const SCENARIOS = [
  { name: 'a room member with no approval UI holds an outbound comment; it is approved for the agent', script: [ask('a', 'room', COMMENT), { op: 'facts' }, { op: 'answer', ask: 'a', decision: APPROVE_AGENT }, { op: 'facts' }] },
  { name: 'a room member with no approval UI holds an outbound comment; it is denied with a reason', script: [ask('a', 'room', COMMENT), { op: 'answer', ask: 'a', decision: DENY }, { op: 'facts' }] },
  { name: 'a room member with no approval UI holds a hook ask on a tool', script: [ask('a', 'room', SHELL, { hook: HOOK_ASK }), { op: 'facts' }, { op: 'answer', ask: 'a', decision: APPROVE }, { op: 'facts' }] },
  { name: 'a room member with an approval UI is asked there and holds nothing', script: [ask('a', 'room', COMMENT, { ui: APPROVE }), { op: 'facts' }] },
  { name: 'an ordinary session with an approval UI is asked there', script: [ask('a', 'plain', SHELL, { hook: HOOK_ASK, ui: APPROVE }), { op: 'facts' }] },
  { name: 'a schedule run never asks: an outbound comment is allowed without a card', script: [{ op: 'mark', session: 'schedule', kind: 'schedule', agentId: 'ann', name: 'nightly' }, ask('a', 'schedule', COMMENT), { op: 'facts' }] },
  { name: 'a schedule run never asks: a hook ask is allowed without a card', script: [{ op: 'mark', session: 'schedule', kind: 'schedule', agentId: 'ann', name: 'nightly' }, ask('a', 'schedule', SHELL, { hook: HOOK_ASK }), { op: 'facts' }] },
  { name: 'a webhook run never asks, even with an approval UI attached', script: [{ op: 'mark', session: 'webhook', kind: 'webhook', agentId: 'ann', name: 'issues' }, ask('a', 'webhook', COMMENT, { ui: APPROVE }), { op: 'facts' }] },
  { name: 'two room members hold at once; the heartbeat counts both, then one, then none', script: [ask('a', 'room', COMMENT), ask('b', 'room', SHELL, { hook: HOOK_ASK }), { op: 'facts' }, { op: 'answer', ask: 'b', decision: DENY }, { op: 'facts' }, { op: 'answer', ask: 'a', decision: APPROVE }, { op: 'facts' }] },
  // Where the hold decision is made (loop/tool-helpers.mjs resolvePreToolAskApproval): `held = run && typeof toolApprovalHook !== 'function'`,
  // read at each ask. A recognized run with no hook is held; a session that is no run is not, hook or not.
  { name: 'an ordinary session with no approval UI is denied, not held, on a hook ask', script: [ask('a', 'plain', SHELL, { hook: HOOK_ASK }), { op: 'facts' }] },
  { name: 'an ordinary session with no approval UI asks nobody on an outbound comment', script: [ask('a', 'plain', COMMENT), { op: 'facts' }] },
  { name: 'a webhook run with no approval UI never asks and holds nothing', script: [{ op: 'mark', session: 'webhook', kind: 'webhook', agentId: 'ann', name: 'issues' }, ask('a', 'webhook', COMMENT), { op: 'facts' }] },
  {
    name: 'the approval UI is read at each ask: attached, detached, attached; a held request stays held when a UI attaches after it',
    script: [
      ask('a', 'room', COMMENT, { ui: APPROVE }),
      ask('b', 'room', SHELL, { hook: HOOK_ASK }),
      { op: 'facts' },
      ask('c', 'room', SHELL, { hook: HOOK_ASK, ui: DENY }),
      { op: 'facts' },
      { op: 'answer', ask: 'b', decision: APPROVE },
      { op: 'facts' },
    ],
  },
  { name: 'a delivery that never completes holds back neither the push, nor the answer, nor the audit', stallDelivery: true, script: [ask('a', 'room', COMMENT), { op: 'facts' }, { op: 'answer', ask: 'a', decision: APPROVE_AGENT }, { op: 'facts' }] },
  { name: 'a held request never expires: it still waits after a virtual day', script: [ask('a', 'room', COMMENT), { op: 'advance', ms: 86_400_000 }, { op: 'facts' }, { op: 'answer', ask: 'a', decision: APPROVE }, { op: 'facts' }] },
];

const NOW_BASE = 1_800_000_000_000;
const clone = (value) => JSON.parse(JSON.stringify(value));

async function runScenario(index, scenario) {
  NOW = NOW_BASE + index * 1_000_000;
  uuids = 0;
  const store = createHumanGateStore(join(sandbox, `human-gate-${index}`));
  setHumanGateStore(store);
  globalThis.__heldDeliveries = [];
  globalThis.__heldRecords = [];
  globalThis.__stallDelivery = scenario.stallDelivery === true;
  const pushes = [];
  let waiter = null;
  const unregister = registerHeldRequestNotifier((event) => {
    pushes.push(event);
    waiter?.();
  });
  const uiAsks = [];
  const marks = [];
  const asks = new Map();
  const seen = { deliveries: 0, pushes: 0, uiAsks: 0 };
  const fresh = () => {
    const out = {
      deliveries: globalThis.__heldDeliveries.slice(seen.deliveries).map((d) => ({ agentId: d.agentId, held: d.held })),
      pushes: pushes.slice(seen.pushes),
      uiAsks: uiAsks.slice(seen.uiAsks),
    };
    seen.deliveries = globalThis.__heldDeliveries.length;
    seen.pushes = pushes.length;
    seen.uiAsks = uiAsks.length;
    return out;
  };
  const service = { listSessionCatalog: async () => ({ sessions: [], nextCursor: null }), liveSessionAwaitingApproval: () => false };
  // The row a hold (or its answer) posts reaches the recorded delivery after an async import of the delivery module: the stub says so.
  const delivered = (count) =>
    new Promise((resolve) => {
      const check = () => {
        if (globalThis.__heldDeliveries.length < count) return;
        globalThis.__onHeldDelivery = undefined;
        resolve();
      };
      globalThis.__onHeldDelivery = check;
      check();
    });
  const present = (result) => (result.denial !== undefined ? { denial: result.denial } : { allowed: true, name: result.name, args: result.args });
  const trace = [];

  for (const op of scenario.script) {
    if (op.op === 'mark') {
      marks.push(markUnattendedRun(SESSIONS[op.session], { kind: op.kind, agentId: op.agentId, name: op.name }));
      trace.push({ op: 'mark', session: SESSIONS[op.session] });
    } else if (op.op === 'ask') {
      const heldAt = pushes.length;
      const toolApprovalHook = op.ui
        ? async (request) => {
            uiAsks.push({ name: request.name, kind: request.kind ?? null, reason: request.reason, remember: request.remember ?? null });
            return clone(op.ui);
          }
        : undefined;
      const outcome = applyBeforeToolHook({
        name: op.call.name,
        args: clone(op.call.args),
        cwd: dataDir,
        callerSessionId: SESSIONS[op.session],
        executeOpts: { toolCallId: `call_${op.id}` },
        beforeToolHook: op.hook ? async () => clone(op.hook) : null,
        toolApprovalHook,
      });
      const pushed = new Promise((resolve) => {
        waiter = resolve;
        if (pushes.length > heldAt) resolve();
      });
      const first = await Promise.race([outcome.then(() => 'settled'), pushed.then(() => 'held')]);
      waiter = null;
      const entry = { outcome, heldId: null };
      asks.set(op.id, entry);
      const step = { op: 'ask', id: op.id, session: SESSIONS[op.session], state: first };
      if (first === 'held') {
        entry.heldId = pushes[pushes.length - 1].requestId;
        await delivered(seen.deliveries + 1);
      } else step.outcome = present(await outcome);
      trace.push({ ...step, ...fresh() });
    } else if (op.op === 'facts') {
      const facts = await collectHeartbeatFacts({ since: 0, getSessionService: () => service, routines: async () => [], taskWatches: async () => [] });
      trace.push({ op: 'facts', facts });
    } else if (op.op === 'answer') {
      const entry = asks.get(op.ask);
      const accepted = resolveHeldRequest(entry.heldId, clone(op.decision));
      const outcome = present(await entry.outcome);
      await delivered(seen.deliveries + 1);
      await Promise.all(globalThis.__heldRecords);
      trace.push({ op: 'answer', ask: op.ask, requestId: entry.heldId, accepted, outcome, ...fresh() });
    } else if (op.op === 'advance') {
      const firedBefore = timers.fired;
      await advance(op.ms);
      trace.push({ op: 'advance', ms: op.ms, now: NOW, fired: timers.fired - firedBefore });
    } else throw new Error(`unknown op ${op.op}`);
  }
  await Promise.all(globalThis.__heldRecords);
  for (const unmark of marks) unmark();
  unregister();
  setHumanGateStore(null);
  const readLines = (file) => {
    try {
      return readFileSync(join(sandbox, `human-gate-${index}`, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  let grants = [];
  try {
    grants = JSON.parse(readFileSync(join(sandbox, `human-gate-${index}`, 'grants.json'), 'utf8')).grants;
  } catch {}
  return {
    name: scenario.name,
    now: NOW_BASE + index * 1_000_000,
    ...(scenario.stallDelivery ? { stallDelivery: true } : {}),
    script: scenario.script,
    trace,
    audit: readLines('audit.jsonl'),
    grants,
    timers: { registered: timers.registered, pending: timers.queue.length },
  };
}

const scenarios = [];
for (const [index, scenario] of SCENARIOS.entries()) scenarios.push(await runScenario(index, scenario));

const finalDir = join(FIXTURES_ROOT, 'held-runs');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), {
  note: 'applyBeforeToolHook over the unattended port, the held-request registry and collectHeartbeatFacts, at b6f10295a',
  sessions: SESSIONS,
  scenarios,
});
writeSetManifest(stage, { set: 'held-runs', recorder, command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`, identity, extra: { scenarios: scenarios.length } });
commitStage(stage, finalDir);
console.log(`scenarios=${scenarios.length}`);
process.exit(0);
