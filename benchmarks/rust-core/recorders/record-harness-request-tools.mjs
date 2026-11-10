#!/usr/bin/env node
// The tool array one real-turn harness request carried to the provider, as the Node daemon sent it, with the route
// and the denials of the Lead thread that sent it (its stored header). The definitions are the stored header's own
// (name, description bound to the model, inputSchema): the request carries exactly those, which this script checks by
// name and by description against the request body. The Rust replay seats a new Lead thread on the same route and
// compares its stored tools and the array its request would carry (`surface_host/tests.rs`).
//
//   node benchmarks/rust-core/recorders/record-harness-request-tools.mjs --request <out/compare/provider-chat-requests.node.json> --header <out/compare/stored-header.node.json> --tree <the daemon's product tree>
//
// Output: native/core/fixtures/harness-request/ (harness-request.json and its MANIFEST.json); the directory is this
// recorder's alone. No position is decided here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exactProductIdentity, FIXTURES_ROOT, writeJson, writeSetManifest } from './lib/common.mjs';

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
const recorder = 'benchmarks/rust-core/recorders/record-harness-request-tools.mjs';
const dir = join(FIXTURES_ROOT, 'harness-request');
writeJson(join(dir, 'harness-request.json'), {
  recorder,
  provider: header.provider,
  model: body.model,
  toolSpec: header.toolSpec,
  disallowedTools: header.disallowedTools,
  tools,
});
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
writeSetManifest(dir, {
  set: 'harness-request',
  recorder,
  command: `node ${recorder} --request <request> --header <header> --tree <tree>`,
  extra: { inputs: { request: sha256(arg('--request')), header: sha256(arg('--header')) } },
  identity: exactProductIdentity(arg('--tree'), 'b6f10295a2f698afc85332467192de28500bd146'),
});