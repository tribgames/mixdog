#!/usr/bin/env node
// The three store reads the task-report re-arm host needs, through Node's real functions:
//   1. the pending-message queue read (`_getPendingMessagesForSession`) and the agent results
//      owed from it (`owedAgentResults` of agent-task-sessions.mjs, exported for the recording
//      by a module-load hook that appends one export line);
//   2. `completionIsDelivered` over the real delivered-completions registry;
//   3. the TUI steering persist (`appendTuiSteeringPersist` / `readTuiSteeringPersist`).
// Clock and entropy are frozen (`Date.now` is a variable the script moves; `randomBytes` counts);
// nothing is masked: the output keeps every duplicate copy Node's three-source queue returns.
// Rust `mixdog-core-session` `pending_read` must answer the same for the same session state.
//
//   node benchmarks/rust-core/recorders/record-pending-queue.mjs [--tree <dir>]
//
// Output: native/core/fixtures/pending-queue/golden.json.
process.env.TZ = 'UTC';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { register, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const FROZEN = 1_700_000_000_000;
let clock = FROZEN;
Date.now = () => clock;
let entropy = 0;
crypto.randomBytes = (length) => Buffer.alloc(length, ++entropy);
syncBuiltinESMExports();
register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
    const loaded = await next(url, context);
    if (!url.endsWith('/src/session-runtime/agent-task-sessions.mjs')) return loaded;
    return { ...loaded, source: String(loaded.source) + '\\nexport { owedAgentResults as __owedAgentResults };\\n' };
  }`)}`
);
const dataDir = args.get('data') ?? mkdtempSync(join(tmpdir(), 'pending-queue-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const at = (path) => importFrom(tree, path);
const manager = 'src/runtime/agent/orchestrator/session/manager';
const pending = await at(`${manager}/pending-messages.mjs`);
const sessions = await at('src/session-runtime/agent-task-sessions.mjs');

const SESSION = 'sess_a';
// A new process over the spool the first one left: nothing is in memory, only the spool rows.
if (args.get('phase') === 'restart') {
  console.log(JSON.stringify({ pending: pending._getPendingMessagesForSession(SESSION), owed: await sessions.__owedAgentResults(SESSION) }));
  process.exit(0);
}
const envelope = (id, status, summary, result) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n<result>\n${result}\n</result>\n</task-notification>`;
const AGENT = envelope('task_agent_1', 'completed', 'Agent "worker" completed', 'the agent result');
const SHELL = envelope('job-7', 'failed', 'Shell task failed (exit 2)', 'boom');
const PARTS = [
  { type: 'text', text: 'look at this' },
  { type: 'image', data: 'AA==', mimeType: 'image/png' },
];

// What the queue is fed, in order. `prompt`: a message queued behind a running turn;
// `completion`: a detached job's completion (`markCompletionEntry` with the execution meta).
const INPUTS = [
  { kind: 'prompt', value: '  first prompt  ' },
  { kind: 'completion', surface: 'agent', taskId: 'task_agent_1', status: 'completed', text: AGENT },
  { kind: 'prompt', value: PARTS },
  { kind: 'completion', surface: 'shell', taskId: 'job-7', status: 'failed', text: SHELL },
  { kind: 'prompt', value: '   ' },
  { kind: 'completion', surface: 'agent', taskId: 'task_agent_1', status: 'completed', text: AGENT },
  { kind: 'completion', surface: 'shell', taskId: '', status: 'completed', text: 'plain note without a task id' },
  { kind: 'prompt', value: 'last prompt' },
];

// A completion with no execution id never settles `completionExecutionId` (it reads its own
// normalized text, which normalizes the entry again, without end): Node throws a RangeError
// instead of queueing or judging it, and the throw is part of the recording.
const attempt = (run) => {
  try {
    return { value: run() };
  } catch (error) {
    return { threw: `${error.name}: ${error.message}` };
  }
};
const feed = (sessionId, input) =>
  pending.enqueuePendingMessage(
    sessionId,
    input.kind === 'prompt'
      ? Array.isArray(input.value)
        ? { content: input.value }
        : input.value
      : pending.markCompletionEntry(input.text, {
          executionId: input.taskId,
          meta: { execution_surface: input.surface, execution_id: input.taskId, status: input.status },
        })
  );

const queue = { inputs: INPUTS, session: SESSION, returned: INPUTS.map((input) => attempt(() => feed(SESSION, input))) };
queue.beforeFlush = pending._getPendingMessagesForSession(SESSION);
queue.owedBeforeFlush = await sessions.__owedAgentResults(SESSION);
await pending.settlePendingMessageWrites();
queue.afterFlush = pending._getPendingMessagesForSession(SESSION);
queue.owedAfterFlush = await sessions.__owedAgentResults(SESSION);
// A session id the spool refuses reads as empty.
queue.invalidSession = pending._getPendingMessagesForSession('bad id!');
queue.unknownSession = pending._getPendingMessagesForSession('sess_none');

queue.afterRestart = JSON.parse(
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--tree', tree, '--phase', 'restart', '--data', dataDir], {
    encoding: 'utf8',
    env: { ...process.env, MIXDOG_DATA_DIR: dataDir },
  })
    .trim()
    .split('\n')
    .at(-1)
);

// completionIsDelivered over the real registry, the clock moved per step. Entries are literal
// pending-queue entries (the persisted form and the in-memory form both appear).
const { completionIsDelivered } = await at(`${manager}/pending-message-entry.mjs`);
const { recordDeliveredCompletion } = await at(`${manager}/delivered-completions.mjs`);
const HOUR = 3_600_000;
const completion = (extra) => ({ notificationKind: 'completion_notification', mode: 'task-notification', enqueuedAt: FROZEN, ...extra });
const ENV2 = envelope('task_agent_2', 'completed', 'Agent "w2" completed', 'second');
const TTL = 6 * HOUR;
const DELIVERED_STEPS = [
  { at: 0, op: 'check', entry: completion({ message: 'A', executionId: 'ex1' }) },
  { at: 0, op: 'record', executionId: 'ex1' },
  { at: 0, op: 'check', entry: completion({ message: 'other text', executionId: 'ex1' }) },
  { at: 0, op: 'check', entry: completion({ message: 'A', executionId: 'ex2' }) },
  { at: 0, op: 'check', entry: { message: 'A', executionId: 'ex1' } },
  { at: 0, op: 'record', text: ENV2 },
  { at: 0, op: 'check', entry: completion({ message: ENV2 }) },
  { at: 0, op: 'check', entry: completion({ message: 'no id at all' }) },
  { at: 0, op: 'check', entry: completion({ message: ENV2, executionId: 'zzz' }) },
  { at: 0, op: 'check', entry: completion({ message: 'something else', executionId: 'task_agent_2' }) },
  { at: 0, op: 'record', text: 'plain text' },
  { at: 0, op: 'check', entry: completion({ message: ' plain text ', executionId: 'pt1' }) },
  { at: 0, op: 'check', entry: completion({ message: 'plain text 2', executionId: 'pt1' }) },
  { at: 0, op: 'check', entry: completion({ content: 'plain text', text: 'plain text', executionId: 'pt1' }) },
  { at: 0, op: 'check', entry: completion({ message: '   ', executionId: 'pt2' }) },
  { at: 0, op: 'record', executionId: 'ex5' },
  { at: 0, op: 'check', entry: completion({ message: 'x', execution: { id: 'ex5' } }) },
  { at: 0, op: 'check', entry: completion({ message: 'x', executionId: '  ex5  ' }) },
  { at: 1000, op: 'record', executionId: 'ex_ttl' },
  { at: 1000 + TTL - 1, op: 'check', entry: completion({ message: 'x', executionId: 'ex_ttl' }) },
  { at: 1000 + 2 * TTL - 3, op: 'check', entry: completion({ message: 'x', executionId: 'ex_ttl' }) },
  { at: 1000 + 3 * TTL - 2, op: 'check', entry: completion({ message: 'x', executionId: 'ex_ttl' }) },
  { at: 1000 + 3 * TTL - 1, op: 'check', entry: completion({ message: 'x', executionId: 'ex_ttl' }) },
  { at: 4 * TTL, op: 'record', executionId: 'ex_exp' },
  { at: 5 * TTL, op: 'check', entry: completion({ message: 'x', executionId: 'ex_exp' }) },
  { at: 5 * TTL, op: 'check', entry: completion({ message: 'x', executionId: 'ex1' }) },
  ...Array.from({ length: 513 }, (_, n) => ({ at: 5 * TTL + 1, op: 'record', executionId: `bnd${n}` })),
  ...['bnd0', 'bnd1', 'bnd2', 'bnd512', 'ex_exp'].map((id) => ({ at: 5 * TTL + 2, op: 'check', entry: completion({ message: 'x', executionId: id }) })),
];
const delivered = { steps: [] };
for (const step of DELIVERED_STEPS) {
  clock = FROZEN + step.at;
  if (step.op === 'record') {
    const recorded = recordDeliveredCompletion({ executionId: step.executionId, text: step.text });
    delivered.steps.push({ ...step, recorded });
  } else {
    const { value, threw } = attempt(() => completionIsDelivered(step.entry));
    delivered.steps.push({ ...step, ...(threw ? { threw } : { delivered: value }) });
  }
}
clock = FROZEN;

// The TUI steering persist: what a restarted watch reads back as the submissions still queued.
const { appendTuiSteeringPersist, readTuiSteeringPersist, flushTuiSteeringPersist } = await at('src/tui/session/tui-steering-persist.mjs');
const MINUTE = 60_000;
const LEAD = 'lead1';
const STEERING_STEPS = [
  { at: 0, op: 'append', entry: { id: 'sub-1', text: 'steer one' } },
  { at: 0, op: 'append', entry: { id: '  sub-2  ', text: ' two ' } },
  { at: 0, op: 'append', entry: { text: 'no id' } },
  { at: 0, op: 'append', entry: { id: 'sub-4', text: '   ' } },
  { at: 0, op: 'read', session: LEAD },
  { at: 20 * MINUTE, op: 'append', entry: { id: 'sub-5', text: 'later' } },
  { at: 30 * MINUTE, op: 'read', session: LEAD },
  { at: 30 * MINUTE + 1, op: 'read', session: LEAD },
  { at: 30 * MINUTE + 1, op: 'read', session: 'bad id!' },
  { at: 30 * MINUTE + 1, op: 'read', session: 'lead_none' },
];
const steering = { session: LEAD, steps: [] };
for (const step of STEERING_STEPS) {
  clock = FROZEN + step.at;
  if (step.op === 'append') {
    await appendTuiSteeringPersist(LEAD, { ...step.entry });
    steering.steps.push(step);
  } else {
    await flushTuiSteeringPersist();
    const rows = await readTuiSteeringPersist(step.session);
    steering.steps.push({ ...step, rows, submissionIds: rows.map((row) => row?.submissionId).filter(Boolean) });
  }
}
clock = FROZEN;

const finalDir = join(FIXTURES_ROOT, 'pending-queue');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-pending-queue.mjs';
writeJson(join(stage, 'golden.json'), { frozenNow: FROZEN, queue, delivered, steering });
writeSetManifest(stage, { set: 'pending-queue', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
