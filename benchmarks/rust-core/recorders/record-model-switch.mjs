#!/usr/bin/env node
// Genuine 1.4.5 model-switch display: a session's messages, the boundary `setRoute` records on
// the switch anchor (`recordTranscriptBoundary`, exported from set-route.mjs), and the rows
// `restoreTranscriptItems` then shows. The Rust fold (`transcript_boundary.rs`) must give the
// same anchor and the same rows (`transcript_boundary` golden in mixdog-core).
//
//   node benchmarks/rust-core/recorders/record-model-switch.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/migration/model-switch/cases.json
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
const { restoreTranscriptItems } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs');
const { recordTranscriptBoundary } = await importFrom(tree, 'src/session-runtime/model-route/set-route.mjs');

const user = { role: 'user', content: 'hello' };
const reply = { role: 'assistant', content: 'hi there', meta: { transcript: { messageId: 'm_reply', at: 100 } } };
const second = { role: 'user', content: 'and then' };
const summary = { role: 'user', content: 'A previous model worked on this task and produced the compacted handoff summary below. Build on the work already done.\nmessages=3 sha256=ab', meta: { source: 'compact-summary' } };
const ack = { role: 'assistant', content: '.', meta: { source: 'context-ack' } };
const sameAt ={ provider: 'openai', modelId: 'gpt-next', at: 200 };
const cases = [
  { name: 'anchor is the last answer before a trailing prompt', messages: [user, reply, second], boundary: sameAt },
  { name: 'anchor is the last message', messages: [user, reply], boundary: sameAt },
  { name: 'only prompts: the last non-system message', messages: [user, { role: 'system', content: 's' }], boundary: sameAt },
  { name: 'a second, different switch on the same anchor', messages: [user, reply], boundary: sameAt, again: { provider: 'anthropic', modelId: 'claude-next', at: 300 } },
  { name: 'the same switch recorded twice is recorded once', messages: [user, reply], boundary: sameAt, again: sameAt },
  { name: 'a boundary without a model shows no row', messages: [user, reply], boundary: { provider: 'openai', at: 400 } },
  // Compaction replacement entries: the summary (a user message) and the context ack.
  { name: 'summary anchor: only the summary', messages: [summary], boundary: sameAt },
  { name: 'summary anchor: summary then its context ack', messages: [summary, ack], boundary: sameAt },
  { name: 'summary anchor: summary then a trailing prompt', messages: [summary, second], boundary: sameAt },
  { name: 'summary anchor: a second switch', messages: [summary], boundary: sameAt, again: { provider: 'anthropic', modelId: 'claude-next', at: 300 } },
];

const out = cases.map((c) => {
  const session = { id: 'ms', messages: structuredClone(c.messages) };
  const same = (entry) => entry?.at === c.boundary.at && entry?.modelId === c.boundary.modelId;
  recordTranscriptBoundary(session, 'modelSwitches', c.boundary, same);
  if (c.again) {
    const again = (entry) => entry?.at === c.again.at && entry?.modelId === c.again.modelId;
    recordTranscriptBoundary(session, 'modelSwitches', c.again, again);
  }
  const anchor = session.messages.findIndex((m, i) => m.meta?.modelSwitches);
  return {
    name: c.name,
    messages: c.messages,
    boundaries: [c.boundary, ...(c.again ? [c.again] : [])],
    anchor,
    after: session.messages,
    rows: restoreTranscriptItems(session.messages, { sessionId: 'ms' }),
  };
});

const finalOut = join(FIXTURES_ROOT, 'migration', 'model-switch');
const stage = stageSet(finalOut);
writeJson(join(stage, 'cases.json'), { note: 'model-switch boundary fold + restored rows', cases: out });
writeSetManifest(stage, {
  set: 'migration/model-switch',
  recorder: 'benchmarks/rust-core/recorders/record-model-switch.mjs',
  command: 'node benchmarks/rust-core/recorders/record-model-switch.mjs --tree <tree>',
  extra: { cases: out.length },
});
commitStage(stage, finalOut);
console.log(`cases=${out.length}`);
