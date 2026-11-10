#!/usr/bin/env node
// A provider stream cut while a tool call's arguments were still arriving, parsed by Node's real Anthropic adapter (b6f10295a): two
// complete `tool_use` blocks, a third whose `input_json_delta` stopped mid-value, and the connection closed without `message_stop`. A
// local server serves the bytes; the adapter's `onToolCall` dispatches and the error it throws are recorded. The core's decoder is
// replayed against the same bytes by `mixdog-ai` `providers::anthropic::tests::a_cut_tool_stream_dispatches_the_complete_calls_as_node_does`.
//
//   node benchmarks/rust-core/recorders/record-provider-tool-cut.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/provider-tool-cut/{response.sse,result.json,MANIFEST.json}.
import http from 'node:http';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest, writeText } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-provider-tool-cut.mjs';
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { AnthropicProvider } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/anthropic.mjs');

const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const toolBlock = (index, id, name, parts) => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  ...parts.map((partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
];
const body = [
  { type: 'message_start', message: { id: 'msg_cut', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
  ...toolBlock(0, 'toolu_1', 'lookup', ['{"key":', '"a"}']),
  { type: 'content_block_stop', index: 0 },
  ...toolBlock(1, 'toolu_2', 'lookup', ['{"key":"b"}']),
  { type: 'content_block_stop', index: 1 },
  ...toolBlock(2, 'toolu_3', 'lookup', ['{"key":"c']),
]
  .map(frame)
  .join('');
const TOOLS = [{ name: 'lookup', description: 'Read a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }];
const MESSAGES = [{ role: 'user', content: 'Look up three values.' }];

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const dispatched = [];
let error = null;
try {
  await new AnthropicProvider({ apiKey: 'fixture-key-not-a-credential', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 }).send(MESSAGES, 'claude-sonnet-4-6', TOOLS, {
    onToolCall: (call) => dispatched.push({ id: call.id, name: call.name, arguments: call.arguments }),
  });
} catch (thrown) {
  error = {
    code: thrown?.code ?? null,
    truncatedStream: thrown?.truncatedStream ?? null,
    pendingToolUse: thrown?.pendingToolUse ?? null,
    partialToolCalls: (thrown?.partialToolCalls ?? []).map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
  };
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
if (!error) throw new Error('the adapter accepted a cut stream');

const finalDir = join(FIXTURES_ROOT, 'provider-tool-cut');
const stage = stageSet(finalDir);
writeText(join(stage, 'response.sse'), body);
writeJson(join(stage, 'result.json'), { dispatchedToolCalls: dispatched, error });
writeSetManifest(stage, { set: 'provider-tool-cut', recorder, command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`, identity });
commitStage(stage, finalDir);
console.log(JSON.stringify({ dispatched, error }));
