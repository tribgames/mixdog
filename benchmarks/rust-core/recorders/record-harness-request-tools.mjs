#!/usr/bin/env node
// The tool array one real-turn harness request carried to the provider, as the Node daemon sent it, with the route
// and the denials of the Lead thread that sent it (its stored header). The definitions are the stored header's own
// (name, description bound to the model, inputSchema): the request carries exactly those, which this script checks by
// name and by description against the request body. The Rust replay seats a new Lead thread on the same route and
// compares its stored tools and the array its request would carry (`surface_host/tests.rs`).
//
//   node benchmarks/rust-core/recorders/record-harness-request-tools.mjs --request <out/compare/provider-chat-requests.node.json> --header <out/compare/stored-header.node.json>
//
// Output: native/core/fixtures/tool-resolution/harness-request.json. No position is decided here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, writeJson } from './lib/common.mjs';

const arg = (flag) => {
  const at = process.argv.indexOf(flag);
  if (at < 0 || !process.argv[at + 1]) throw new Error(`${flag} <path> is required`);
  return process.argv[at + 1];
};
const requests = JSON.parse(readFileSync(arg('--request'), 'utf8'));
const header = JSON.parse(readFileSync(arg('--header'), 'utf8'));
const body = requests[0].body;
const tools = header.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
const sent = body.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description }));
if (JSON.stringify(sent) !== JSON.stringify(tools.map(({ name, description }) => ({ name, description })))) throw new Error('the request does not carry the stored header tools');
writeJson(join(FIXTURES_ROOT, 'tool-resolution', 'harness-request.json'), {
  recorder: 'benchmarks/rust-core/recorders/record-harness-request-tools.mjs',
  provider: header.provider,
  model: body.model,
  toolSpec: header.toolSpec,
  disallowedTools: header.disallowedTools,
  tools,
});