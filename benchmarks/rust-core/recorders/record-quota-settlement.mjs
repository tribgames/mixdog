#!/usr/bin/env node
// Golden twin of the quota-settlement guard (tui/session/quota-resume.mjs): the transcript turn
// keys (runtime/shared/transcript-turn-keys.mjs), `latestQuotaFailure`, and the settlement /
// cancel-epoch protocol of `createQuotaResumeLane` — `beginQuotaSettlement` records
// {sessionId, turnKey, epoch}, every superseding cancel raises the epoch, and
// `finishQuotaSettlement` records the suspended Goal only when the epoch is unchanged. Node's real
// lane runs scripted sequences over an isolated quota-resume store; each step records its answer
// and the Goal note the store holds for the failed turn afterwards.
//
//   node benchmarks/rust-core/recorders/record-quota-settlement.mjs --tree <dir>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const dir = mkdtempSync(join(tmpdir(), 'mixdog-quota-settlement-twin-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_CONFIG_DIR = dir;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const store = await importFrom(tree, 'src/runtime/shared/quota-resume-store.mjs');
const lane = await importFrom(tree, 'src/tui/session/quota-resume.mjs');
const { transcriptTurnKeys } = await importFrom(tree, 'src/runtime/shared/transcript-turn-keys.mjs');

let seed = 0x5e771e;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const quotas = [
  { provider: 'anthropic', model: 'm', resetAt: 1000 },
  { provider: 'openai', resetAt: 5.5 },
  { provider: 'x', model: 5, resetAt: null },
  { provider: 'x', model: 'y', resetAt: '7' },
  { provider: 5 },
  {},
  null,
  0,
  'text',
];
function row() {
  const kind = pick(['user', 'turndone', 'turndone', 'assistant', 'tool', 'notice', 'item', undefined]);
  const r = { kind };
  if (chance(0.6)) r.id = pick(['a', 'b1', 7, 0, '', true, null, 'a']);
  if (chance(0.4)) r.text = pick(['hi', '', 0, 'ok']);
  if (chance(0.2)) r.label = pick(['lab', '']);
  if (kind === 'turndone') {
    if (chance(0.85)) r.status = pick(['failed', 'FAILED', 'Failed', 'ok', '', 'cancelled']);
    if (chance(0.8)) r.quota = pick(quotas);
    if (chance(0.3)) r.attemptId = pick(['att1', '', 5]);
    if (chance(0.3)) r.checkpointId = pick(['cp1', '', 9]);
  }
  if (chance(0.1)) r.archived = pick([true, false, 'true']);
  return r;
}
function transcript() {
  const items = [];
  if (chance(0.3)) items.push(row());
  const turns = 1 + Math.floor(rnd() * 3);
  for (let t = 0; t < turns; t += 1) {
    if (chance(0.85)) items.push({ kind: 'user', id: pick(['u1', 'u2', 'u3', undefined]), text: 'p' });
    const n = Math.floor(rnd() * 3);
    for (let i = 0; i < n; i += 1) items.push(row());
    if (chance(0.8)) {
      items.push({
        kind: 'turndone',
        id: chance(0.5) ? `d${t}` : undefined,
        status: chance(0.8) ? 'failed' : 'ok',
        quota: chance(0.85) ? pick(quotas.slice(0, 4)) : pick(quotas),
        ...(chance(0.25) ? { attemptId: 'att' + t } : {}),
        ...(chance(0.25) ? { checkpointId: 'cp' + t } : {}),
        ...(chance(0.1) ? { archived: true } : {}),
      });
    }
  }
  return items;
}

const keyCases = [];
const failureCases = [];
for (let i = 0; i < 400; i += 1) {
  const items = plain(transcript());
  keyCases.push({ items, keys: transcriptTurnKeys(items) });
  failureCases.push({ items, failure: plain(lane.latestQuotaFailure(items)) });
}

const flows = [];
for (let c = 0; c < 120; c += 1) {
  store.reloadQuotaResumeStore();
  rmSync(join(dir, store.QUOTA_RESUME_FILE), { force: true });
  store.reloadQuotaResumeStore();
  store.setQuotaAutoResumeEnabled(true);
  const state = { sessionId: 'sess_a', items: [], busy: false, commandBusy: false };
  const notices = [];
  // What the session's runtime offers `hasResumeInput` and `sessionRoute`; a begin step sets it.
  const runtime = {};
  const bag = {
    runtime,
    flags: { disposed: false },
    getState: () => state,
    set: () => {},
    pending: [],
    pushNotice: (text, level, options) => notices.push([text, level, options]),
  };
  const guard = lane.createQuotaResumeLane(bag);
  const steps = [];
  for (let s = 0; s < 16; s += 1) {
    const op = pick(['items', 'items', 'begin', 'begin', 'begin', 'finish', 'finish', 'userInput', 'supersede', 'cancel', 'session', 'auto']);
    const step = { op };
    let answer = null;
    notices.length = 0;
    if (op === 'items') {
      state.items = plain(transcript());
      step.items = state.items;
    } else if (op === 'session') {
      state.sessionId = step.sessionId = pick(['sess_a', 'sess_b', '']);
    } else if (op === 'auto') {
      step.enabled = chance(0.8);
      store.setQuotaAutoResumeEnabled(step.enabled);
    } else if (op === 'begin') {
      const retained = chance(0.3);
      const goalReactivatable = chance(0.4);
      step.context = {
        autoResume: store.quotaAutoResumeEnabled(),
        retainedRetry: retained,
        goalReactivatable,
        routeProvider: pick(['anthropic', 'openai', '']),
        routeModel: pick(['m1', 'm2', '']),
      };
      runtime.readModelMessages = () => ({
        messages: retained
          ? [{ role: 'user', content: 'c', meta: { transcript: { messageId: 'm', completion: { status: 'failed', attemptId: 'a' } } } }]
          : [],
      });
      runtime.goalStatus = () => (goalReactivatable ? { id: 'g' } : {});
      runtime.reactivateUsageLimitedGoal = () => {};
      runtime.sessionProvider = step.context.routeProvider;
      runtime.sessionModel = step.context.routeModel;
      answer = plain(guard.beginQuotaSettlement());
    } else if (op === 'finish') {
      step.goalId = pick(['goal-1', 'goal-2', '']);
      answer = guard.finishQuotaSettlement({ suspendedGoalId: step.goalId });
    } else if (op === 'userInput') {
      guard.cancelQuotaResumeOnUserInput();
    } else if (op === 'supersede') {
      step.sessionId = pick(['sess_a', 'sess_b', '']);
      guard.supersedeQuotaResume(step.sessionId);
    } else if (op === 'cancel') {
      step.sessionId = pick(['sess_a', 'sess_b']);
      try {
        answer = guard.cancelQuotaResume(step.sessionId);
      } catch (error) {
        answer = { error: String(error?.message) };
      }
    }
    step.answer = answer;
    step.notices = notices.map((n) => plain(n));
    step.notes = ['sess_a', 'sess_b'].map((id) => plain(store.listQuotaResumeEntries().find((e) => e.sessionId === id) ?? null));
    step.suspended = ['sess_a', 'sess_b'].flatMap((id) =>
      (transcriptTurnKeys(state.items).concat(['turn:u1'])).map((key) => store.quotaSuspendedGoal(id, key)),
    );
    steps.push(step);
  }
  flows.push({ steps });
}

const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'ai-admin');
writeJson(join(outDir, 'quota-settlement-twin.json'), {
  domain: 'quota-settlement-twin',
  recorder: 'benchmarks/rust-core/recorders/record-quota-settlement.mjs',
  keyCases,
  failureCases,
  flows,
});
writeSetManifest(outDir, {
  set: 'ai-admin',
  recorder: 'benchmarks/rust-core/recorders/record-quota-settlement.mjs',
  command: 'node benchmarks/rust-core/recorders/record-quota-settlement.mjs --tree <tree>',
  identityTree: tree,
});
rmSync(dir, { recursive: true, force: true });
const all = flows.flatMap((f) => f.steps);
const queued = all.filter((s) => s.op === 'begin' && s.answer).length;
const populated = all.filter((s) => s.notes.some(Boolean)).length;
const cleared = all.filter((s) => ['userInput', 'supersede', 'cancel'].includes(s.op) && s.notes.every((n) => !n)).length;
console.log(
  `recorded ${keyCases.length} key cases, ${failureCases.filter((c) => c.failure).length} failures, ${flows.length} flows; ` +
    `${queued} resumes queued, ${populated} steps with an entry, ${cleared} cancels leaving none, ` +
    `${all.filter((s) => s.notices.length).length} not-resumable notices`,
);
