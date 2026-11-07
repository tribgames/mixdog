#!/usr/bin/env node
// Golden twin of a failed turn's live end, from Node's REAL code:
//  - `cases`: `turnFailureRecord` (session/turn-failure.mjs, what `failedTurnCompletion` of
//    manager/ask-turn-failure.mjs spreads into `meta.transcript.completion`) for provider errors that carry the
//    facts the Rust run reads off a `ProviderError` (code, retryAfterMs, resetAt, quotaExhausted) and for a
//    first-byte timeout, on a fixed route.
//  - `live`: the real `createRunTurn` (tui/session/turn.mjs) whose `runtime.ask` throws a quota-exhausted
//    error: what the transcript shows, in which order, and what the shared state holds at the moment
//    `beginQuotaSettlement` and the Goal settlement run. `streamed` and `estimated` drive the real stream
//    handlers (reasoning and text deltas, usage deltas, a tool call) on a fixed clock before the failure, so the
//    live turndone's `outputTokens`, `thinkingElapsedMs`, `toolCount`, `elapsedMs` and `at` are recorded with
//    the script that produced them (`script`: offsets in ms from the turn's start).
// Isolated env (temp data dir / home), no user data.
//
//   node benchmarks/rust-core/recorders/record-turn-failure.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const work = mkdtempSync(join(tmpdir(), 'record-turn-failure-'));
for (const d of ['data', 'home', 'appdata', 'localappdata', 'backups']) mkdirSync(join(work, d), { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: join(work, 'data'),
  MIXDOG_HOME: join(work, 'home'),
  HOME: join(work, 'home'),
  USERPROFILE: join(work, 'home'),
  APPDATA: join(work, 'appdata'),
  LOCALAPPDATA: join(work, 'localappdata'),
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  MIXDOG_USER_DATA_BACKUP_ROOT: join(work, 'backups'),
  TZ: 'UTC',
});
const tree = resolveTree(parseArgs());
const { turnFailureRecord } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/turn-failure.mjs');
const { createSessionFlow } = await importFrom(tree, 'src/tui/session/session-flow.mjs');
const { createRunTurn } = await importFrom(tree, 'src/tui/session/turn.mjs');
const { createActiveToolTracker } = await importFrom(tree, 'src/tui/session/active-tool-summary.mjs');

const RESET = 1_900_000_000_000;
const named = (message, fields) => Object.assign(new Error(message), fields);
const scenarios = [
  ['quota with a provider-named reset', named('Usage limit reached', { status: 429, code: 'usage_limit_reached', resetAt: RESET }), { provider: 'anthropic-oauth', model: 'm' }],
  ['quota proven by the pool', named('All connected accounts have exhausted their quota.', { code: 'provider_accounts_exhausted', quotaExhausted: { provider: 'openai-oauth', model: 'gpt-x', resetAt: RESET } }), { provider: 'anthropic-oauth', model: 'm' }],
  ['quota proven by the pool, no reset', named('All connected accounts have exhausted their quota.', { code: 'provider_accounts_exhausted', quotaExhausted: {} }), { provider: 'anthropic-oauth', model: 'm' }],
  ['typed quota code, no reset', named('Usage limit reached', { status: 429, code: 'usage_limit_reached' }), { provider: 'anthropic-oauth', model: 'm' }],
  ['rate limited with advice', named('Rate limit reached', { status: 429, code: 'rate_limit_exceeded', retryAfterMs: 4000 }), { provider: 'anthropic-oauth', model: 'm' }],
  ['rate limited with a window reset', named('slow', { status: 429, code: 'rate_limit_error', resetAt: RESET }), { provider: 'anthropic-oauth', model: 'm' }],
  ['overloaded', named('busy', { status: 529, code: 'overloaded_error', retryAfterMs: 2000 }), { provider: 'anthropic-oauth', model: 'm' }],
  ['billing', named('Payment required', { status: 402 }), { provider: 'openai-oauth', model: 'm' }],
  ['first byte timeout, named provider', named('first byte timed out after 30000ms', { name: 'ProviderTimeoutError', timeoutPhase: 'first-chunk', waitedMs: 30000, attempts: 2 }), { provider: 'anthropic-oauth', model: 'm' }],
  ['first byte timeout, headers phase', named('first byte timed out after 45000ms', { name: 'ProviderTimeoutError', timeoutPhase: 'headers', waitedMs: 45000 }), { provider: 'openai', model: 'm' }],
  ['first byte timeout, unknown provider id', named('first byte timed out after 30000ms', { name: 'ProviderTimeoutError', timeoutPhase: 'first-chunk', waitedMs: 30000 }), { provider: 'my-gateway', model: 'm' }],
  ['first byte timeout, no route provider', named('first byte timed out after 30000ms', { name: 'ProviderTimeoutError', timeoutPhase: 'first-chunk', waitedMs: 30000 }), { model: 'm' }],
];
const cases = scenarios.map(([name, error, route]) => {
  const fields = {};
  for (const key of ['name', 'status', 'code', 'retryAfterMs', 'resetAt', 'quotaExhausted', 'timeoutPhase', 'waitedMs', 'attempts']) {
    if (key === 'name' ? error.name !== 'Error' : error[key] !== undefined) fields[key] = error[key];
  }
  const { errorKind, quota, detail, errorDetails } = turnFailureRecord(error, route);
  return { name, message: error.message, fields, route, errorKind, quota, detail, errorDetails };
});

// ---- the live end of a failed turn --------------------------------------------------------------------------
const START = 1_700_000_000_000;
const realNow = Date.now;
let clock = null;
Date.now = () => clock ?? realNow();
const volatileOf = (script) => new Set(script ? ['id', 'checkpointId', 'attemptId'] : ['id', 'at', 'elapsedMs', 'checkpointId', 'attemptId']);
const shape = (item, volatile) => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, volatile.has(key) ? `<${typeof value}>` : value]));

// What the real handlers take: `options.on*` as `runtime.ask` is handed them. The last step is the failure.
async function drive(script, options) {
  for (const step of script) {
    clock = START + step.at;
    if (step.reasoning) options.onReasoningDelta(step.reasoning);
    if (step.text) options.onTextDelta(step.text);
    if (step.usage !== undefined) options.onUsageDelta({ deltaOutput: step.usage });
    if (step.tool) await options.onToolCall(1, [step.tool]);
  }
}

async function liveFailure(error, script = null) {
  const state = { busy: true, commandBusy: false, queued: [], items: [], toasts: [], promptHistoryList: [], stats: { turns: 0, inputTokens: 0, outputTokens: 0 } };
  const toasts = [];
  const events = [];
  let sequence = 0;
  const runtime = {
    id: 'live',
    session: { id: 'live', messages: [], provider: 'anthropic-oauth', model: 'm' },
    toolMode: 'auto',
    async ask(_text, options) {
      if (script) await drive(script, options);
      throw error;
    },
    abort: () => false,
  };
  const bag = {
    runtime,
    flags: { leadTurnEpoch: 0 },
    pending: [],
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `live-item-${++sequence}`,
    appendItems: (items, extra) => Object.assign(state, { items: [...state.items, ...items] }, extra),
    pushItem: (item) => state.items.push(item),
    pushUserOrSyntheticItem: (text, id, _kind, extra) => state.items.push({ text, id, kind: 'user', ...extra }),
    patchItem: (id, patch) => Object.assign(state.items.find((item) => item.id === id) || {}, patch),
    replaceItems: (items) => items,
    tuiDebug() {},
    pushNotice: (...args) => toasts.push(args),
    syncContextStats() {},
    routeState: () => ({}),
    agentStatusState: () => ({}),
    denyAllToolApprovals() {},
    clearActiveToolSummary() {},
    flushDeferredExecutionPendingResumeKick() {},
    flushToolResults() {},
    itemIndexById: new Map(),
  };
  Object.assign(bag, createActiveToolTracker(bag), createSessionFlow(bag));
  const snapshot = (event) => events.push({ event, busy: state.busy, items: state.items.map((item) => item.kind) });
  bag.beginQuotaSettlement = () => snapshot('beginQuotaSettlement');
  bag.onGoalTurnSettled = async () => {
    snapshot('onGoalTurnSettled');
    return null;
  };
  bag.finishQuotaSettlement = () => snapshot('finishQuotaSettlement');
  bag.runTurn = createRunTurn(bag);
  clock = script ? START : null;
  await bag.enqueue('write the report', { id: 'live-prompt', awaitPersistence: true });
  state.busy = false;
  await bag.drain();
  clock = null;
  const end = state.items.findLast((item) => item.kind === 'turndone');
  return {
    ...(script ? { start: START, script } : {}),
    kinds: state.items.map((item) => item.kind),
    turndone: end ? shape(end, volatileOf(script)) : null,
    turndoneKeys: end ? Object.keys(end) : null,
    toasts: toasts.map(([text, tone, options]) => ({ text, tone, options })),
    events,
    busyAfter: state.busy,
  };
}

const live = {
  quota: await liveFailure(named('Usage limit reached', { status: 429, code: 'usage_limit_reached', resetAt: RESET })),
  plain: await liveFailure(new Error('boom')),
  // The spinner's tokens (9 + 4) beat the text estimate (round((15 + 13) / 4) = 7); the thinking segment closes at
  // the first text; the call opens one card.
  streamed: await liveFailure(named('Usage limit reached', { status: 429, code: 'usage_limit_reached', resetAt: RESET }), [
    { at: 100, reasoning: 'plan the work' },
    { at: 400, text: 'Working on it. ' },
    { at: 500, usage: 9 },
    { at: 600, tool: { id: 'call-1', name: 'read', arguments: { path: 'a.txt' } } },
    { at: 700, usage: 4 },
    { at: 1000 },
  ]),
  // No usage: the estimate round((10 + 2) / 4) = 3 stands; the thinking segment is still open at the failure.
  estimated: await liveFailure(new Error('boom'), [{ at: 50, text: 'abcdefghij' }, { at: 60, reasoning: 'xy' }, { at: 200 }]),
};

writeJson(join(FIXTURES_ROOT, 'turn-failure', 'golden.json'), { resetAt: RESET, cases, live });
writeSetManifest(join(FIXTURES_ROOT, 'turn-failure'), {
  set: 'turn-failure',
  recorder: 'benchmarks/rust-core/recorders/record-turn-failure.mjs',
  command: 'node benchmarks/rust-core/recorders/record-turn-failure.mjs --tree <tree>',
  identityTree: tree,
});
Date.now = realNow;
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${cases.length} failure records and ${Object.keys(live).length} live failures`);
process.exit(0);
