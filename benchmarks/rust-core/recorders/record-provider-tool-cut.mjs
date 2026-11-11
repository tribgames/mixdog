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
import { exact } from './lib/exact.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
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

// The request as it arrived (method, path, every header in arrival order, the body bytes as text): what the server receives is part of the recording.
const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    requests.push({ method: req.method, path: req.url, headers: req.rawHeaders.reduce((all, v, i) => (i % 2 ? all : [...all, [v, req.rawHeaders[i + 1]]]), []), body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
});
// One deadline per awaited thing, and a message naming it.
class Expired extends Error {}
const withDeadline = (promise, label) => {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Expired(`${label}: not done after 30000 ms`)), 30_000);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
};
const dispatched = [];
let error = null;
try {
  await withDeadline(new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve)), 'the local server listening');
  try {
    const sent = new AnthropicProvider({ apiKey: 'fixture-key-not-a-credential', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 }).send(MESSAGES, 'claude-sonnet-4-6', TOOLS, {
      onToolCall: (call) => dispatched.push(call),
    });
    await withDeadline(sent, "the adapter's send");
  } catch (thrown) {
    // The recording's own deadline is its failure, never the adapter's error.
    if (thrown instanceof Expired) throw thrown;
    error = thrown;
  }
} finally {
  server.closeAllConnections();
  await withDeadline(new Promise((resolve) => server.close(resolve)), 'the local server closing');
}
if (!error) throw new Error('the adapter accepted a cut stream');

const finalDir = join(FIXTURES_ROOT, 'provider-tool-cut');
const stage = stageSet(finalDir);
writeText(join(stage, 'response.sse'), body);
// Values through the shared exact encoder; the three host-dependent SDK headers and the random loopback port are written as markers at exactly those header names (declared in the manifest).
const hostMarked = requests.map((request) => ({ ...request, headers: request.headers.map(([name, value]) => [name, /^x-stainless-(os|arch|runtime-version)$/i.test(name) ? `<recording host ${name.toLowerCase()}>` : /^host$/i.test(name) ? '127.0.0.1:<port>' : value]) }));
writeJson(join(stage, 'result.json'), exact({ requests: hostMarked, dispatchedToolCalls: dispatched, error }));
writeSetManifest(stage, { set: 'provider-tool-cut', recorder, command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`, identity, extra: { ...recorderProvenance(import.meta.url), values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs): the dispatched calls and the error are stored whole through the shared encoder (the error with its name, message and every own property)', exclusions: ['requests[].headers: the VALUES of x-stainless-os, x-stainless-arch and x-stainless-runtime-version (the SDK writes the recording host) are replaced by `<recording host <header name>>`; the value of host (random loopback port) is `127.0.0.1:<port>`; every other header, in arrival order, and the body are recorded and compared as they arrived'] } });
commitStage(stage, finalDir);
console.log(JSON.stringify({ dispatched, error }));
