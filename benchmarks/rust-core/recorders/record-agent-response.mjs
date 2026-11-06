#!/usr/bin/env node
// Genuine 1.4.5 live agent-response cards: completions as `notifySessionCompletion` emits them
// ({content, meta}) delivered through the TUI's own `pushAsyncAgentResponse`
// (`transcript-intake.mjs`, with `buildExecutionResponseToolItem` and `appendAgentResponseTail`),
// and the transcript items after each step. The Rust builder (`transcript_response.rs`,
// `agent_response`) must give the same items (`agent_response_equals_nodes`).
//
//   node benchmarks/rust-core/recorders/record-agent-response.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/migration/agent-response/cases.json
import { join } from 'node:path';
import {
  FIXTURES_ROOT,
  commitStage,
  importFrom,
  parseArgs,
  resolveTree,
  stageSet,
  writeJson,
  writeSetManifest,
} from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const { createTranscriptIntake } = await importFrom(tree, 'src/tui/session/transcript-intake.mjs');
const { resolveTuiRuntimeNotificationDelivery } = await importFrom(tree, 'src/tui/session/notification-plan.mjs');
const { parseAgentJob } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/transcript-restore/agent-envelope.mjs');
const { renderAgentCompletionEnvelope, renderTaskCompletionEnvelope } = await importFrom(
  tree,
  'src/runtime/shared/task-notification-envelope.mjs'
);

const agent = (id, status = 'completed') => ({ execution_id: id, execution_surface: 'agent', status });
const preview = (id) => ({ content: `agent task: ${id}\nstatus: running\ntype: result`, meta: agent(id, 'running') });
const body = (id, result, tag = 'reviewer') => ({
  content: renderAgentCompletionEnvelope({ id, tag, status: 'completed', result }),
  meta: agent(id),
});
const failed = (id) => ({
  content: `agent task: ${id}\nstatus: failed\ntype: result`,
  meta: agent(id, 'failed'),
});
const shell = (id) => ({
  content: renderTaskCompletionEnvelope({ surface: 'shell', id, status: 'completed', result: 'ls output' }),
  meta: { execution_id: id, execution_surface: 'shell', status: 'completed' },
});

const cases = [
  { name: 'a bodyless preview, then its body replaces it', completions: [preview('t1'), body('t1', 'All good')] },
  { name: 'two bodies of different executions are one aggregate card', completions: [body('t1', 'one'), body('t2', 'two')] },
  { name: 'a body for the same execution again is one entry', completions: [body('t1', 'one'), body('t1', 'one again')] },
  { name: 'a bodyless failure stays apart from a later body', completions: [failed('t1'), body('t2', 'two')] },
  { name: 'a shell card is no agent card and is never appended to', completions: [body('t1', 'one'), shell('s1'), body('t2', 'two')] },
  { name: 'a preview alone', completions: [preview('t9')] },
  { name: 'a surface with an unparseable text is a card of that surface', completions: [{ content: 'plain words', meta: agent('x1') }] },
  { name: 'text that is no card at all', completions: [{ content: 'hello', meta: {} }] },
].map((c) => {
  const items = [];
  const intake = createTranscriptIntake({
    getState: () => ({ items }),
    flags: {},
    pushItem: (item) => items.push(item),
    patchItem: (id, patch) => {
      const at = items.findIndex((item) => item.id === id);
      items[at] = { ...items[at], ...patch };
    },
    transcriptRouteMetadata: () => ({}),
  });
  const realNow = Date.now;
  const steps = c.completions.map((completion, index) => {
    const now = 1_000_000 + index * 1000;
    Date.now = () => now;
    const text = completion.content.trim();
    const delivery = resolveTuiRuntimeNotificationDelivery({ meta: completion.meta }, text);
    if (delivery.action === 'execution-ui') {
      const parsed = parseAgentJob(text);
      const executionId = String(completion.meta.execution_id || parsed?.taskId || '').trim();
      intake.pushAsyncAgentResponse(text, `c${index + 1}`, 'injected', { responseKey: executionId, ...delivery.executionMeta });
    }
    Date.now = realNow;
    return { id: `c${index + 1}`, now, action: delivery.action, items: JSON.parse(JSON.stringify(items)) };
  });
  return { name: c.name, completions: c.completions, steps };
});

const finalOut = join(FIXTURES_ROOT, 'migration', 'agent-response');
const stage = stageSet(finalOut);
writeJson(join(stage, 'cases.json'), { note: 'completions and the live transcript items after each', cases });
writeSetManifest(stage, {
  set: 'migration/agent-response',
  recorder: 'benchmarks/rust-core/recorders/record-agent-response.mjs',
  command: 'node benchmarks/rust-core/recorders/record-agent-response.mjs --tree <tree>',
  extra: { cases: cases.length },
});
commitStage(stage, finalOut);
console.log(`cases=${cases.length}`);
