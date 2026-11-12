#!/usr/bin/env node
// Records Node's tool-call id resolution for the k1 UNTESTED tool-call-ids.test.mjs (gaps-tools.md row 17, section 3
// `mixdog-agent`).
//
// The resolver cases run the test's histories and batches through Node's real `createToolCallIdResolver` and record the
// ids every round ends with (a streamed call and its final-batch copy end on one id, which is the id recorded); the reuse
// case runs the test's provider through Node's `agentLoop` and records the last request it built. Each scenario is data
// (the history's rounds, then the rounds the model answers) so the Rust replay drives the same calls through the loop.
//
//   node benchmarks/rust-core/recorders/record-tool-call-id-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/tool-call-id-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-tool-call-id-cases.mjs';
const SESSION = 'src/runtime/agent/orchestrator/session';
const TEST = `${SESSION}/tool-call-ids.test.mjs`;

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-tool-call-id-cases-'));

const { agentLoop } = await importFrom(tree, `${SESSION}/agent-loop.mjs`);
const { createToolCallIdResolver } = await importFrom(tree, `${SESSION}/loop/tool-call-ids.mjs`);

const call = (id) => ({ id, name: 't', arguments: {} });
const turnOf = (ids) => [
  { role: 'assistant', content: '', toolCalls: ids.map(call) },
  ...ids.map((id) => ({ role: 'tool', toolCallId: id, content: 'r' })),
];
const historyOf = (rounds) => [{ role: 'user', content: 'x' }, ...rounds.flatMap(turnOf)];

const cases = [];
const excluded = {};

/**
 * One scenario: `history` rounds already answered, then `rounds` the model asks in turn, each resolved against the
 * history so far (streamed one by one when `streamed`, then the final batch), its resolved ids appended as a round.
 */
function resolveRounds(name, history, rounds, { streamed = false } = {}) {
  const messages = historyOf(history);
  const resolved = [];
  for (const ids of rounds) {
    const resolve = createToolCallIdResolver(messages);
    const streamedIds = streamed ? ids.map((id) => resolve(call(id)).id) : null;
    const batch = ids.map(call);
    resolve.all(batch);
    const finalIds = batch.map((c) => c.id);
    if (streamedIds && JSON.stringify(streamedIds) !== JSON.stringify(finalIds)) throw new Error(`${name}: streamed ${streamedIds} != final ${finalIds}`);
    resolved.push(finalIds);
    messages.push(...turnOf(finalIds));
  }
  cases.push({ case: name, kind: 'rounds', history, rounds, recorded: resolved });
}

resolveRounds('resolver: only ids the history already carries are renamed, consistently within a round', [['a'], ['a-2']], [['a', 'b']], { streamed: true });
excluded[`${TEST} :: resolver: only ids the history already carries are renamed, consistently within a round :: a call without an id`] =
  'not representable: a Rust stream call always carries an id (the codec gives one to a call the provider sent without), so the id-less call has no replay';
excluded[`${TEST} :: resolver: history {a}, batch {a, a-2} yields two distinct ids`] =
  "difference: Node resolves a batch it did not see streamed as a whole, keeping the unclaimed a-2 and moving the clash past it ([a-3, a-2]); Rust resolves every call as it streams, which gives [a-2, a-2-2] (what Node's streamed path gives for the same calls)";
resolveRounds('resolver: batch {a-2, a} in either order stays distinct (history {a})', [['a']], [['a-2', 'a']]);
resolveRounds('resolver: batch {a-2, a} in either order stays distinct (no history)', [], [['a-2', 'a']]);
resolveRounds('resolver: batch {a, a} gets two distinct ids, with and without history (no history)', [], [['a', 'a']]);
resolveRounds('resolver: batch {a, a} gets two distinct ids, with and without history (history {a})', [['a']], [['a', 'a']]);
resolveRounds('resolver: streamed calls (clones) and the final batch agree and stay distinct', [['a']], [['a', 'a-2', 'a']], { streamed: true });
// The test's shared object: the streamed call resolved first, then the batch holding it and a fresh copy.
{
  const resolve = createToolCallIdResolver(historyOf([['a']]));
  const shared = resolve(call('a'));
  const batch = [shared, call('a')];
  resolve.all(batch);
  cases.push({
    case: 'resolver: a streamed object that is also in the final batch keeps its renamed id',
    kind: 'rounds',
    history: [['a']],
    rounds: [['a', 'a']],
    recorded: [batch.map((c) => c.id)],
  });
}
resolveRounds('resolver: repeated rounds that all answer the same id never collide (batch)', [], Array.from({ length: 5 }, () => ['call_1', 'call_1']));
resolveRounds('resolver: repeated rounds that all answer the same id never collide (streamed)', [], Array.from({ length: 5 }, () => ['call_1', 'call_1-2']), { streamed: true });

// The provider that answers `call_1` on two turns, through the loop.
{
  const requests = [];
  const results = [];
  let sends = 0;
  const provider = {
    async send(messages) {
      sends += 1;
      requests.push(JSON.parse(JSON.stringify(messages)));
      if (sends > 6) return { content: 'runaway', toolCalls: [], stopReason: 'end_turn' };
      if (sends <= 2) return { content: '', toolCalls: [{ id: 'call_1', name: 'definitely_missing_dup_id_tool', arguments: {} }] };
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const session = { id: 'dup-tool-call-id-test', owner: 'agent', agent: 'worker', contextWindow: 200_000, rawContextWindow: 200_000, compaction: { auto: false } };
  const result = await agentLoop(provider, [{ role: 'user', content: 'go' }], 'fake-model', [], null, process.cwd(), {
    session,
    sessionId: session.id,
    onToolResult: (message) => results.push(message.toolCallId),
  });
  cases.push({
    case: 'a provider that reuses a tool call id across turns still gets every result back',
    kind: 'loop',
    script: [['call_1'], ['call_1']],
    tool: 'definitely_missing_dup_id_tool',
    recorded: {
      content: result.content,
      sends,
      lastRequest: requests.at(-1).map((m) => ({
        role: m.role,
        callIds: (m.toolCalls || []).map((c) => c.id),
        toolCallId: m.toolCallId ?? null,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      results: [...new Set(results)],
    },
  });
}

const finalDir = join(FIXTURES_ROOT, 'tool-call-id-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's tool-call id resolution at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'tool-call-id-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "resolver cases: the ids every round the model asks ends with; the reuse case: the final text, the number of sends, every message of the last request (role, call ids, result id, text) and the distinct ids onToolResult saw, in order (Node calls it twice per result; the Rust replay reads the results from the transcript)",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`tool-call-id-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
