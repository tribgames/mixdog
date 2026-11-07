#!/usr/bin/env node
// The tool array one real-turn harness request carried to the provider, as the Node daemon sent it, with the route
// and the denials of the Lead thread that sent it (its stored header). The Rust replay seats a new Lead thread on the
// same route and compares the array the request would carry (`surface_host/tests.rs`).
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
writeJson(join(FIXTURES_ROOT, 'tool-resolution', 'harness-request.json'), {
  recorder: 'benchmarks/rust-core/recorders/record-harness-request-tools.mjs',
  provider: header.provider,
  model: body.model,
  toolSpec: header.toolSpec,
  disallowedTools: header.disallowedTools,
  tools: body.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description })),
});