#!/usr/bin/env node
// What a failed-turn retry rewinds from the model history (manager/failed-turn-rewind.mjs):
// `trailingUnansweredPromptIndex` for a resubmitted prompt and `retainedFailedTurnInput` for a
// retry that names the failed message. Rust `run_host::failed_turn_rewind` must give the same
// index, the same retained row and the same refusal text for the same history.
//
//   node benchmarks/rust-core/recorders/record-failed-turn-rewind.mjs [--tree <dir>]
//
// Output: native/core/fixtures/failed-turn-rewind/golden.json.
process.env.TZ = 'UTC';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'failed-turn-rewind');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-failed-turn-rewind.mjs';
const at = (path) => importFrom(tree, path);
const { trailingUnansweredPromptIndex, retainedFailedTurnInput } = await at(
  'src/runtime/agent/orchestrator/session/manager/failed-turn-rewind.mjs'
);

const sys = { role: 'system', content: 'rules' };
const user = (content, meta) => ({ role: 'user', content, ...(meta ? { meta } : {}) });
const reply = { role: 'assistant', content: 'done' };
const failedMeta = (attemptId) => ({ transcript: { messageId: 'm1', completion: { status: 'failed', ...(attemptId ? { attemptId } : {}) } } });

const REWIND = [
  { name: 'the tail is the prompt', messages: [sys, user('first'), reply, user('fix the bug')], prompt: 'fix the bug' },
  { name: 'the prompt is trimmed on both sides', messages: [user('  fix the bug \n')], prompt: 'fix the bug  ' },
  { name: 'a system row after the prompt is skipped', messages: [user('fix the bug'), sys], prompt: 'fix the bug' },
  { name: 'an answered tail is kept', messages: [user('fix the bug'), reply], prompt: 'fix the bug' },
  { name: 'another prompt is not removed', messages: [user('other')], prompt: 'fix the bug' },
  { name: 'an empty resubmission rewinds nothing', messages: [user('')], prompt: '  ' },
  { name: 'a media prompt is not text only', messages: [user([{ type: 'text', text: 'fix' }, { type: 'image', data: 'x' }])], prompt: 'fix' },
  { name: 'text parts join by a newline', messages: [user([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])], prompt: 'a\nb' },
  {
    name: 'the runtime context around the prompt is not the prompt',
    messages: [user('<ctx>fix the bug</ctx>', { runtimeUserContext: { prefix: '<ctx>', suffix: '</ctx>' } })],
    prompt: 'fix the bug',
  },
  {
    name: 'a stale runtime context boundary is kept',
    messages: [user('fix the bug', { runtimeUserContext: { prefix: '<ctx>', suffix: '</ctx>' } })],
    prompt: 'fix the bug',
  },
  {
    name: 'block runtime context is stripped',
    messages: [user([{ type: 'text', text: '<ctx>' }, { type: 'text', text: 'fix' }, { type: 'text', text: '</ctx>' }], { runtimeUserContext: { prefix: '<ctx>', suffix: '</ctx>' } })],
    prompt: 'fix',
  },
  { name: 'no messages', messages: [], prompt: 'fix' },
];
const retained = [
  { name: 'the failed user message', messages: [sys, user('go', failedMeta()) ], id: 'm1', attempt: undefined },
  { name: 'the attempt matches', messages: [user('go', failedMeta('a1'))], id: 'm1', attempt: 'a1' },
  { name: 'another attempt is refused', messages: [user('go', failedMeta('a1'))], id: 'm1', attempt: 'a2' },
  { name: 'another message is refused', messages: [user('go', failedMeta())], id: 'm2', attempt: undefined },
  { name: 'a completed message is refused', messages: [user('go', { transcript: { messageId: 'm1', completion: { status: 'completed' } } })], id: 'm1', attempt: undefined },
  { name: 'no id is refused', messages: [user('go', failedMeta())], id: '', attempt: undefined },
  { name: 'a failed assistant tail is not a user row', messages: [{ role: 'assistant', content: 'x', meta: failedMeta() }], id: 'm1', attempt: undefined },
];

const out = { rewind: [], retained: [] };
for (const spec of REWIND) {
  out.rewind.push({ ...spec, index: trailingUnansweredPromptIndex(spec.messages, spec.prompt) });
}
for (const spec of retained) {
  let result;
  try {
    const found = retainedFailedTurnInput(spec.messages, spec.id, spec.attempt);
    result = { index: found ? found.index : null };
  } catch (error) {
    result = { error: error.message };
  }
  out.retained.push({ ...spec, ...result });
}
writeJson(join(stage, 'golden.json'), out);
writeSetManifest(stage, { set: 'failed-turn-rewind', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
