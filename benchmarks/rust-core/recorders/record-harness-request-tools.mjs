#!/usr/bin/env node
// The tool array one real-turn harness request carried to the provider, as the Node daemon sent it, with the route
// and the denials of the Lead thread that sent it (its stored header). The definitions are the stored header's own
// (name, description bound to the model, inputSchema): the request carries exactly those, which this script checks by
// name and by description against the request body. The Rust replay seats a new Lead thread on the same route and
// compares its stored tools and the array its request would carry (`surface_host/tests.rs`).
//
// The harness (`real-turn-harness`, `run.mjs --node-only`, scenario `read`) runs the Node daemon of its `node-tree`; for this
// recording that tree is the export of b6f10295a with the Node fix applied (`--tree` it, `--patch` the file), as every other
// recording of this branch, so the tool array carries the agent tool as the patched Node sends it. `--request`/`--header` are the
// harness's `out/compare` sections of that run (`recompare.mjs read`). The tree's identity is checked and written into the file,
// and the tool-resolution manifest names it.
//
//   node benchmarks/rust-core/recorders/record-harness-request-tools.mjs --tree <the harness's node-tree> --patch <node-patches file>
//        --request <out/compare/provider-chat-requests.node.json> --header <out/compare/stored-header.node.json>
//
// Output: native/core/fixtures/tool-resolution/harness-request.json. No position is decided here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, nodeTreeIdentity, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const arg = (flag) => {
  const at = process.argv.indexOf(flag);
  if (at < 0 || !process.argv[at + 1]) throw new Error(`${flag} <path> is required`);
  return process.argv[at + 1];
};
const args = parseArgs();
const { patch, commit, baseCommit } = nodeTreeIdentity(args, resolveTree(args), 'b6f10295a2f698afc85332467192de28500bd146');
if (!patch) throw new Error('record from the export with --patch benchmarks/rust-core/recorders/node-patches/node-fix-spawn-model-settings.patch');
const requests = JSON.parse(readFileSync(arg('--request'), 'utf8'));
const header = JSON.parse(readFileSync(arg('--header'), 'utf8'));
const body = requests[0].body;
const tools = header.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
const sent = body.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description }));
if (JSON.stringify(sent) !== JSON.stringify(tools.map(({ name, description }) => ({ name, description })))) throw new Error('the request does not carry the stored header tools');
writeJson(join(FIXTURES_ROOT, 'tool-resolution', 'harness-request.json'), {
  recorder: 'benchmarks/rust-core/recorders/record-harness-request-tools.mjs',
  node: { commit, baseCommit, patch: { file: patch.file, sha256: patch.sha256, paths: patch.paths } },
  provider: header.provider,
  model: body.model,
  toolSpec: header.toolSpec,
  disallowedTools: header.disallowedTools,
  tools,
});