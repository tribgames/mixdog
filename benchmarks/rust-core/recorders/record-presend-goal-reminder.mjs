#!/usr/bin/env node
// Records the Goal and todo reminder a pre-send compaction gives the kept latest request
// (`pre-send-compact.mjs`: the savings preview's `markPendingGoalReminder` + `snapshotPendingGoalReminder` on a copy of
// the session, the pass's mark and read on the session itself, `goalReminderText` → `latestUserPrefix`, and
// `acknowledgePendingGoalReminder` once the result is adopted), through Node's own `runPreSendCompactPass` over a
// session with an active Goal, open todos, both, neither, only closed todos, and a paused Goal. The Goal is created by
// Node's own Goal runtime (`createGoalRuntime(...).control(id, {action: 'create'})`) and its turn started
// (`archiveCompletedOnUserInput`, `startTurn`) as a turn's start does, on a fixed clock.
//
//   node benchmarks/rust-core/recorders/record-presend-goal-reminder.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/presend-goal-reminder/golden.json (+ MANIFEST.json). The data dir is written `<DATA>`
// and the separators of a path under it `/`.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-presend-goal-reminder.mjs';
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);

// The fixed clock: the Goal is created at CREATED_AT, the turn and its pass run at NOW.
const CREATED_AT = 1_767_000_000_000;
const NOW = CREATED_AT + 754_321;
let clock = CREATED_AT;
Date.now = () => clock;

// A fixed relative data root: the archive paths appear in the messages, so in what the pass measures; the replay
// writes under the same string.
const DATA_ROOT = 'mixdog-gr-data';
rmSync(DATA_ROOT, { recursive: true, force: true });
mkdirSync(DATA_ROOT);
process.env.MIXDOG_DATA_DIR = DATA_ROOT;

const S = 'src/runtime/agent/orchestrator/session';
const { runPreSendCompactPass } = await importFrom(tree, `${S}/pre-send-compact.mjs`);
const { stampCompactionMessageIds } = await importFrom(tree, `${S}/compaction-archive-capture.mjs`);
const { createGoalRuntime } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/goal-runtime.mjs');
const { snapshotPendingGoalReminder } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/goal-reminder.mjs');

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function normalize(value) {
  const forms = [DATA_ROOT.replaceAll('\\', '\\\\'), DATA_ROOT];
  const walk = (v) => {
    if (typeof v === 'string') {
      let out = v;
      for (const form of forms) out = out.replace(new RegExp(escapeRe(form), 'g'), '<DATA>');
      return out.replace(/<DATA>(?:(?:\\\\|\\|\/)[A-Za-z0-9_.-]+)+/g, (path) => path.replace(/\\\\|\\/g, '/'));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

const OPEN_TODO = {
  phases: [
    { name: 'Investigate', tasks: [{ content: 'Read the parser', status: 'completed' }, { content: 'Find the failing input', status: 'in_progress', note: 'start with the fixtures' }] },
    { name: 'Fix', tasks: [{ content: 'Patch the tokenizer', status: 'pending' }, { content: 'Old approach', status: 'abandoned' }] },
  ],
  updatedAt: CREATED_AT,
};
const CLOSED_TODO = {
  phases: [{ name: 'Tasks', tasks: [{ content: 'Read the parser', status: 'completed' }, { content: 'Old approach', status: 'abandoned' }] }],
  updatedAt: CREATED_AT,
};

const KEYS = ['goalReminderRevision', 'pendingGoalReminder', 'goalStalledNotice'];
const cases = [];
async function record(name, { goal = null, todo = null }) {
  clock = CREATED_AT;
  const sessionId = `sess_goal_reminder_${name.replaceAll('-', '_')}`;
  const runtime = createGoalRuntime({ dataDir: DATA_ROOT, now: () => clock });
  let goalFile = null;
  if (goal) {
    await runtime.control(sessionId, { action: 'create', objective: 'Ship the parser fix', duration: '2h' });
    if (goal === 'paused') await runtime.control(sessionId, { action: 'pause' });
    goalFile = readFileSync(join(DATA_ROOT, 'goals', `${sessionId}.json`), 'utf8');
  }
  const header = { id: sessionId, owner: 'user', provider: 'stub', model: 'stub-model', contextWindow: 40_000, compaction: {}, tools: [], ...(todo ? { todo } : {}) };
  const messages = [
    { role: 'user', content: 'Start the parser task.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'read-1', name: 'read', arguments: '{"path":"parser.mjs"}' }] },
    { role: 'tool', toolCallId: 'read-1', content: 'Original recoverable output.\n'.repeat(8_000) },
    { role: 'assistant', content: 'The parser is read.' },
    { role: 'user', content: 'Continue the approved task.' },
  ];
  stampCompactionMessageIds(messages, sessionId);
  const input = structuredClone(messages);
  const session = { ...header, messages };
  // The turn starts as a user turn does: a completed Goal is archived, the turn's own reminder is read
  // (`ask-turn-prepare.mjs`), and the Goal's turn begins.
  clock = NOW;
  await runtime.archiveCompletedOnUserInput(sessionId);
  const turnReminder = snapshotPendingGoalReminder(session, { includePaused: true });
  runtime.startTurn(sessionId);
  const events = [];
  const state = { sessionRef: session, sessionId, messages: messages.slice(), requestTools: [], opts: { onCompactEvent: (event) => events.push(event) } };
  const result = await runPreSendCompactPass(state);
  const compacted = events.find((event) => event.stage === 'pre_send' && event.targetBudgetTokens !== undefined);
  const after = Object.fromEntries(KEYS.filter((key) => key in session).map((key) => [key, session[key]]));
  cases.push(normalize({
    name,
    sessionId,
    header,
    goalFile,
    createdAt: CREATED_AT,
    now: NOW,
    input,
    turnReminder: turnReminder?.content ?? null,
    budget: compacted?.targetBudgetTokens ?? null,
    contextWindow: compacted ? { boundaryTokens: compacted.boundaryTokens, reserveTokens: compacted.reserveTokens, triggerTokens: compacted.triggerTokens } : null,
    compactChanged: result.compactChanged,
    output: state.messages,
    after,
  }));
  await runtime.close();
}

await record('goal', { goal: 'active' });
await record('todos', { todo: OPEN_TODO });
await record('goal-and-todos', { goal: 'active', todo: OPEN_TODO });
await record('neither', {});
await record('closed-todos', { goal: 'active', todo: CLOSED_TODO });
await record('paused-goal', { goal: 'paused', todo: OPEN_TODO });

rmSync(DATA_ROOT, { recursive: true, force: true });
const finalDir = join(FIXTURES_ROOT, 'presend-goal-reminder');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's pre-send compaction Goal reminder at ${NODE_COMMIT}`, cases });
writeSetManifest(stage, {
  set: 'presend-goal-reminder',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    tests: ['src/runtime/agent/orchestrator/session/pre-send-compact.mjs (compactBeforeSend, preSendCompactDecision)', 'src/runtime/agent/orchestrator/runtime-core/goal-reminder.mjs'],
    exclusions: {
      header: `of the session after the pass only ${KEYS.join(', ')} are recorded: the rest is the pass's telemetry and the turn's own bookkeeping, which other recordings cover; updatedAt follows each side's clock`,
      archive: "the execution dump the pass writes is reached through the recovery reminder's path and hash in the output and is compared by the execution-tail replay",
      clock: `Date.now is fixed: the Goal is created at ${CREATED_AT} and the pass runs at ${NOW}`,
    },
  },
});
commitStage(stage, finalDir);
console.log(`cases=${cases.length}`, cases.map((c) => `${c.name}:${c.compactChanged}:${JSON.stringify(c.after)}`).join(' '));
if (existsSync(DATA_ROOT)) throw new Error('data root left behind');
