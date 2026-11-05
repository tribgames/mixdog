#!/usr/bin/env node
// xAI Responses stateless continuation slot (WP-AI-COMPAT): the REAL Node send
// path `sendXaiResponses` runs against a scripted client, and the socket path's
// `normalizeXaiResponsesWebSocket` against a scripted result. No server, no
// credential; `Date.now` is fixed so `updatedAt` is stable.
//
//   node benchmarks/rust-core/recorders/record-xai-responses-continuation.mjs [--tree <dir>]
//
// Output: native/core/fixtures/providers/oracles/xai-responses-continuation.json
// (turn1 -> turn2 carrying turn1's state, an imported `previous_response_id`
// slot, and the socket turn). It lives inside `providers/`, so record-providers.mjs
// calls `recordXaiResponsesContinuation` before its manifest write; run standalone
// it leaves the manifest alone.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const P = 'src/runtime/agent/orchestrator/providers';
const FIXED_NOW = 1700000000000;

const stream = (events) => ({
  async *[Symbol.asyncIterator]() {
    for (const event of events) yield event;
  },
});
const reasoning = (n) => ({ type: 'reasoning', id: `rs_${n}`, encrypted_content: `enc-${n}`, summary: [] });
const call = (n, name) => ({ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name, arguments: '{"path":"a"}' });
const answer = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] };
const TOOLS = [{ name: 'read', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];

// A client whose one response carries `output`; every request body it receives is kept.
function scriptedProvider(id, output, bodies) {
  return {
    name: 'xai',
    config: {},
    client: {
      responses: {
        create: async (params) => {
          bodies.push(JSON.parse(JSON.stringify(params)));
          return stream([
            { type: 'response.created', response: { id, model: 'grok-4.5-build' } },
            { type: 'response.output_text.delta', delta: 'ok' },
            { type: 'response.completed', response: { id, model: 'grok-4.5-build', status: 'completed', output, usage: { input_tokens: 3, output_tokens: 1 } } },
          ]);
        },
      },
    },
  };
}

export async function recordXaiResponsesContinuation(tree, outFile) {
  const { sendXaiResponses } = await importFrom(tree, `${P}/openai-compat-xai-send.mjs`);
  const { normalizeXaiResponsesWebSocket } = await importFrom(tree, `${P}/openai-compat-response-normalization.mjs`);
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const bodies = [];
    const m1 = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read a' }];
    const r1 = await sendXaiResponses(scriptedProvider('resp_1', [reasoning(1), call(1, 'read')], bodies), m1, 'grok-4.5', TOOLS, { sessionId: 's1' });
    const m2 = [
      ...m1,
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }] },
      { role: 'tool', toolCallId: 'call_1', content: 'contents' },
    ];
    const prior2 = { other: { keep: 1 }, ...r1.providerState };
    const r2 = await sendXaiResponses(scriptedProvider('resp_2', [reasoning(2), answer], bodies), m2, 'grok-4.5', TOOLS, { sessionId: 's1', providerState: prior2 });
    const imported = { xaiResponses: { previousResponseId: 'resp_old', store: true, seenMessageCount: 2, model: 'grok-4.5' } };
    const r3 = await sendXaiResponses(scriptedProvider('resp_3', [answer], bodies), m2, 'grok-4.5', TOOLS, { sessionId: 's1', providerState: imported });
    const wsPrior = { other: { keep: 1 } };
    const ws = normalizeXaiResponsesWebSocket({
      messages: m1,
      useModel: 'grok-4.5',
      tools: TOOLS,
      opts: { sessionId: 's1', providerState: wsPrior },
      result: { responseId: 'resp_ws', content: '', toolCalls: [], model: 'grok-4.5-build', stopReason: 'stop', usage: null, providerReplay: { items: [reasoning(9)] } },
      params: { model: 'grok-4.5', input: [] },
      cacheRouting: {},
      previousResponseId: null,
      startIndex: 0,
      continuationResetReason: null,
      cacheLane: {},
    });
    // A socket turn that resumes an imported `previous_response_id` and whose response
    // carries no id keeps the resumed id as the slot's `responseId`.
    const wsResumed = normalizeXaiResponsesWebSocket({
      messages: m2,
      useModel: 'grok-4.5',
      tools: TOOLS,
      opts: { sessionId: 's1', providerState: imported },
      result: { responseId: null, content: '', toolCalls: [], model: 'grok-4.5-build', stopReason: 'stop', usage: null, providerReplay: { items: [] } },
      params: { model: 'grok-4.5', input: [] },
      cacheRouting: {},
      previousResponseId: 'resp_old',
      startIndex: 2,
      continuationResetReason: null,
      cacheLane: {},
    });
    writeJson(outFile, {
      _doc: 'Recorded from src/runtime/agent/orchestrator/providers/openai-compat-xai-send.mjs (sendXaiResponses, real send path with a fake client) and normalizeXaiResponsesWebSocket; Date.now fixed to 1700000000000.',
      recorder: 'benchmarks/rust-core/recorders/record-xai-responses-continuation.mjs',
      turn1: { messages: m1, request: bodies[0], providerState: r1.providerState },
      turn2: { messages: m2, priorState: prior2, request: bodies[1], providerState: r2.providerState },
      imported: { messages: m2, priorState: imported, request: bodies[2], providerState: r3.providerState },
      websocket: { messages: m1, priorState: wsPrior, providerState: ws.providerState },
      websocketResumed: { messages: m2, priorState: imported, providerState: wsResumed.providerState },
    });
  } finally {
    Date.now = realNow;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tree = resolveTree(parseArgs());
  await recordXaiResponsesContinuation(tree, join(FIXTURES_ROOT, 'providers', 'oracles', 'xai-responses-continuation.json'));
  console.log('recorded xai-responses-continuation; providers/MANIFEST.json is regenerated by record-providers.mjs');
}
