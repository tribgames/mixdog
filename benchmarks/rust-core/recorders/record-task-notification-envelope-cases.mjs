#!/usr/bin/env node
// Recording of runtime/shared/task-notification-envelope.test.mjs (b6f10295a), the agent-completion cases whose behaviour stays in
// the product: the one tagged block with a verbatim result, a large result that wrapping and re-enqueue leave whole, and the legacy
// quoted rows that still classify and dedupe against the current envelope by task identity. Node's own functions run unchanged.
//
//   node benchmarks/rust-core/recorders/record-task-notification-envelope-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('task-notification-envelope-cases', import.meta.url);
const envelope = await set.load('src/runtime/shared/task-notification-envelope.mjs');
const contract = await set.load('src/runtime/shared/tool-execution-contract.mjs');
const delivered = await set.load('src/runtime/agent/orchestrator/session/manager/delivered-completions.mjs');
const pending = await set.load('src/runtime/agent/orchestrator/session/manager/pending-message-entry.mjs');
const ingest = await set.load('src/runtime/memory/lib/session-ingest.mjs');

const classify = (text) => ({
  parsed: envelope.parseTaskNotification(text),
  wrapper: contract.isModelVisibleToolCompletionWrapper(text),
  internal: contract.isInternalRuntimeNotificationText(text),
  headerStatus: contract.backgroundTaskHeaderStatus(text),
  ingestExcluded: ingest.shouldExcludeIngestMessage({ role: 'user', content: text }),
  modelVisible: contract.modelVisibleToolCompletionMessage(text),
});
const entryOf = (text) => pending.markCompletionEntry(text);

await set.run('agent completion is exactly one tagged block with verbatim result and no usage', () => {
  const input = { id: 'task_agent_1', tag: 'tidy-skill', status: 'completed', result: '  **Done**\r\n<result>literal nested tag</result>\n' };
  const text = envelope.renderAgentCompletionEnvelope(input);
  return { input, text, ...classify(text) };
});
await set.run('failure without a result carries its error, not a synthetic result or usage', () => {
  const failed = { id: 'task_agent_2', status: 'failed', error: 'quota <limit> & retry' };
  const cancelled = { id: 'task_agent_3', tag: 'review', status: 'cancelled', error: 'cancelled' };
  const text = envelope.renderAgentCompletionEnvelope(failed);
  return { failed, text, ...classify(text), cancelled, cancelledText: envelope.renderAgentCompletionEnvelope(cancelled) };
});
await set.run('large results are not truncated by wrapping or re-enqueue', () => {
  const input = { id: 'task_agent_large', status: 'completed', result: `start\n${'x'.repeat(40_000)}\nend` };
  const text = envelope.renderAgentCompletionEnvelope(input);
  const visible = contract.modelVisibleToolCompletionMessage(text);
  const entry = pending.markCompletionEntry(visible);
  return { input, text, visibleIsText: visible === text, entry, entryContentIsText: entry.content === text, entryResult: envelope.parseTaskNotification(entry.content).result };
});
await set.run('legacy quoted rows still classify and dedupe against new rows by task identity', () => {
  const legacy = 'Async agent task task_agent_legacy (completed) finished.\n\nResult:\n> background task\n> task_id: task_agent_legacy\n> surface: agent\n> status: completed\n> \n> done';
  const input = { id: 'task_agent_legacy', status: 'completed', result: 'done' };
  const current = envelope.renderAgentCompletionEnvelope(input);
  delivered._clearDeliveredCompletions();
  let recorded; let deliveredCurrent;
  try {
    recorded = delivered.recordDeliveredCompletion({ text: legacy });
    deliveredCurrent = delivered.isDeliveredCompletion({ text: current });
  } finally { delivered._clearDeliveredCompletions(); }
  return {
    legacy, input, current,
    legacyWrapper: contract.isModelVisibleToolCompletionWrapper(legacy),
    legacyIngestExcluded: ingest.shouldExcludeIngestMessage({ role: 'user', content: legacy }),
    legacyModelVisible: contract.modelVisibleToolCompletionMessage(legacy),
    legacyTaskId: envelope.taskNotificationId(legacy),
    legacyEntry: entryOf(legacy), currentEntry: entryOf(current),
    recorded, deliveredCurrent,
  };
});

await set.run('the task_id line names the task before the async header, and the header names it when no line does', () => {
  const texts = {
    headerOnly: 'Async agent task task_header_only (completed) finished.\n\nResult:\n> done',
    lineAndHeader: 'Async agent task task_header_id (completed) finished.\n\nResult:\n> task_id: task_line_id\n> status: completed\n> \n> done',
    agentTaskLine: 'agent task: task_agent_line\n\nbody',
    none: 'finished with nothing that names a task',
  };
  const out = {};
  for (const [name, text] of Object.entries(texts)) out[name] = { text, taskId: envelope.taskNotificationId(text), entry: entryOf(text) };
  return out;
});

await set.finish({
  entry: {
    runs: 'task-notification-envelope.mjs renderAgentCompletionEnvelope, parseTaskNotification, taskNotificationId; tool-execution-contract.mjs isModelVisibleToolCompletionWrapper, isInternalRuntimeNotificationText, backgroundTaskHeaderStatus, modelVisibleToolCompletionMessage; session-ingest.mjs shouldExcludeIngestMessage; manager/pending-message-entry.mjs markCompletionEntry; manager/delivered-completions.mjs',
    notRun: 'the two shell cases of the Node test (closed elsewhere); entry enqueuedAt is the held clock (golden.clock.dateNow)',
  },
  replay: { entry: 'render_agent_completion for each recorded input and compare the text; the classifiers over the recorded texts; completions::entry and DeliveredCompletions over the legacy and current texts', normalised: {} },
  exclusions: { modelVisibleOfLegacy: 'modelVisibleToolCompletionMessage turns a legacy quoted wrapper into the current envelope: the core queues only envelopes it rendered itself (agent_registry/flow.rs model_visible), so no Rust function converts a legacy row; the recorded value is kept and not replayed' },
});
process.exit(0);
