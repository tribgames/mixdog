#!/usr/bin/env node
// Golden of the session side of a scheduler fire (`native/core/fixtures/quota-resume-fire/golden.json`):
// what Node's real `fireQuotaResume({ generation })` (tui/session/quota-resume.mjs
// `createQuotaResumeLane`, over the real quota-resume store in a temp data dir) answers for each
// session state, and what it leaves: the queued entry, the suspended-Goal note, the turn it
// enqueued, the notices it pushed, the Goal resume it asked for. `ResumeHost::fire` of the Rust
// scheduler (`SessionResumeHost`) must decide the same.
//
//   node <repo>/benchmarks/rust-core/recorders/record-quota-resume-fire.mjs --tree <tree>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const sandbox = mkdtempSync(join(tmpdir(), 'quota-resume-fire-'));
// Every user directory the product reads is a fresh temp directory before any Mixdog module loads.
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  mkdirSync(join(sandbox, key));
  process.env[key] = join(sandbox, key);
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
delete process.env.MIXDOG_OWNER_SESSION_ID;
const at = (p) => import(pathToFileURL(join(repo, p)).href);

const { createQuotaResumeLane, transcriptTurnKeys } = await at('src/tui/session/quota-resume.mjs');
const store = await at('src/runtime/shared/quota-resume-store.mjs');

const RESET_AT = 2_000_000_000_000;
const quota = { provider: 'openai-oauth', model: 'gpt-x', resetAt: RESET_AT };
/** A transcript whose last turn failed on quota (the shape quota-resume.test.mjs uses). */
const failedTurn = ({ sampled = false, text = 'build the parser', images = null, user = true } = {}) => [
  { id: 'u0', kind: 'user', text: 'earlier' },
  { id: 'a0', kind: 'assistant', text: 'earlier answer' },
  { id: 'd0', kind: 'turndone', status: 'done' },
  ...(user ? [{ id: 'u1', kind: 'user', text, ...(images ? { images } : {}) }] : []),
  ...(sampled ? [{ id: 'a1', kind: 'assistant', text: 'partial work' }] : []),
  { id: 'n1', kind: 'notice', text: 'limit reached' },
  { id: 'd1', kind: 'turndone', status: 'failed', quota, attemptId: 'att-1' },
];
const keyOf = (items) => transcriptTurnKeys(items)[items.length - 1];
/** The retained failed message `retainedRetryInput()` resends. */
const retainedMessages = [
  { role: 'system', content: 'rules' },
  { role: 'user', content: [{ type: 'text', text: 'build the parser' }], meta: { transcript: { messageId: 'u1', completion: { status: 'failed', attemptId: 'att-1' } } } },
];

/**
 * `items`: the transcript; `entry`: queue an entry for the failure (`turnKey` overrides its key);
 * `generation`: 'entry' fires the queued generation, a number fires that one; `goal`: the
 * suspended Goal noted for the entry's turn and how its revival answers (`active`, another
 * status, or `throw`); `messages`: the model context; `state` / `pending` / `enqueue`: the lane's
 * state; `twice`: fire again after the first answer.
 */
const scenarios = [
  { name: 'no entry', items: failedTurn(), entry: false, generation: 7 },
  { name: 'another generation', items: failedTurn(), generation: 'other' },
  { name: 'busy turn', items: failedTurn(), state: { busy: true } },
  { name: 'busy command', items: failedTurn(), state: { commandBusy: true } },
  { name: 'queued input', items: failedTurn(), pending: [{ id: 'q1' }] },
  { name: 'a later turn began', items: [...failedTurn(), { id: 'u2', kind: 'user', text: 'next' }] },
  { name: 'the entry is for another turn', items: failedTurn(), turnKey: 'turn:u0' },
  { name: 'attachment-only prompt', items: failedTurn({ text: '', images: [{ token: 'img' }] }) },
  { name: 'prompt replayed', items: failedTurn(), twice: true },
  { name: 'sampled turn continues', items: failedTurn({ sampled: true }) },
  { name: 'retained message resent', items: failedTurn(), messages: retainedMessages },
  { name: 'enqueue refused', items: failedTurn(), enqueue: false },
  { name: 'goal revived with the replay', items: failedTurn(), goal: 'active' },
  { name: 'goal revived without a user turn', items: failedTurn({ user: false }), goal: 'active' },
  { name: 'goal not revived', items: failedTurn(), goal: 'usage_limited' },
  { name: 'goal revival failed', items: failedTurn(), goal: 'throw' },
  { name: 'attachment-only prompt with a goal', items: failedTurn({ text: '', images: [{ token: 'img' }] }), goal: 'active' },
];

let serial = 0;
const cases = [];
for (const scenario of scenarios) {
  serial += 1;
  const sessionId = `sess_fire_${serial}`;
  const items = scenario.items;
  const failureKey = keyOf(items);
  let entry = null;
  if (scenario.entry !== false) {
    entry = store.scheduleQuotaResumeEntry({
      sessionId,
      turnKey: scenario.turnKey ?? failureKey,
      ...quota,
      routeProvider: 'openai-oauth',
      routeModel: 'gpt-x',
    });
  }
  if (scenario.goal) store.noteQuotaSuspendedGoal(sessionId, entry.turnKey, 'goal-1');
  const enqueued = [];
  const notices = [];
  const effects = [];
  const reactivations = [];
  let nextId = 0;
  const bag = {
    runtime: {
      id: sessionId,
      sessionProvider: 'openai-oauth',
      sessionModel: 'gpt-x',
      readModelMessages: () => ({ messages: scenario.messages ?? [{ role: 'system', content: 'rules' }] }),
      ...(scenario.goal
        ? {
            goalStatus: () => ({ id: 'goal-1' }),
            // The Goal runtime revives only an `active` answer, through the lane's admission.
            reactivateUsageLimitedGoal: async (goalId, { isCurrent, accept }) => {
              if (scenario.goal === 'throw') {
                reactivations.push({ goalId, admitted: false });
                throw new Error('Goal store unavailable');
              }
              const admitted = scenario.goal === 'active' && isCurrent() && accept();
              reactivations.push({ goalId, admitted });
              return { id: goalId, status: admitted ? 'active' : 'usage_limited' };
            },
          }
        : {}),
    },
    flags: { admission: 'open', disposed: false },
    pending: [...(scenario.pending ?? [])],
    getState: () => ({ sessionId, items, busy: false, commandBusy: false, quotaResume: null, ...(scenario.state ?? {}) }),
    set: () => {},
    nextId: () => `id-${++nextId}`,
    enqueue: (content, options) => {
      enqueued.push({ content, options });
      return scenario.enqueue ?? true;
    },
    pushNotice: (text, tone, options) => notices.push({ text, tone, options: options ?? null }),
    drain: () => effects.push('drain'),
    scheduleGoalContinuation: () => effects.push('goal-continuation'),
  };
  Object.assign(bag, createQuotaResumeLane(bag));
  const generation = scenario.generation === 'other' ? entry.generation + 100 : typeof scenario.generation === 'number' ? scenario.generation : entry?.generation;
  const fire = async () => {
    try {
      return { outcome: await bag.fireQuotaResume({ generation }) };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  };
  const answers = [await fire()];
  if (scenario.twice) answers.push(await fire());
  bag.disposeQuotaResume();
  const left = store.quotaResumeEntry(sessionId);
  cases.push({
    name: scenario.name,
    sessionId,
    items,
    failureKey,
    entry: entry ? { turnKey: entry.turnKey, generation: entry.generation } : null,
    firedGeneration: generation,
    suspendedGoal: scenario.goal ? 'goal-1' : '',
    messages: scenario.messages ?? [{ role: 'system', content: 'rules' }],
    state: { busy: scenario.state?.busy === true, commandBusy: scenario.state?.commandBusy === true, pending: (scenario.pending ?? []).length },
    goalAnswer: scenario.goal ?? null,
    enqueueAnswer: scenario.enqueue ?? true,
    answers,
    after: {
      entry: left ? { turnKey: left.turnKey, generation: left.generation } : null,
      suspendedGoal: entry ? store.quotaSuspendedGoal(sessionId, entry.turnKey) : '',
      enqueued,
      notices,
      reactivations,
      effects,
    },
  });
}

rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const set = join(FIXTURES_ROOT, 'quota-resume-fire');
writeJson(join(set, 'golden.json'), { cases });
writeSetManifest(set, {
  set: 'quota-resume-fire',
  recorder: 'benchmarks/rust-core/recorders/record-quota-resume-fire.mjs',
  command: 'node <repo>/benchmarks/rust-core/recorders/record-quota-resume-fire.mjs --tree <tree>',
  identityTree: repo,
});
console.log(`recorded ${cases.length} cases`);
process.exit(0);
