#!/usr/bin/env node
// What Node's Responses request does with a freeform tool (`apply_patch`): the REAL
// `buildRequestBody` (src/runtime/agent/orchestrator/providers/openai-responses-payload.mjs) over the
// real `apply_patch` definition and a few shaped tools, on the Codex route (`openai-oauth`) and the
// public API route (`openai`, with and without native tool search). Recorded per case: the tools
// array of the request body and what `onToolExcluded` was told. Rust's OpenAI request builder must
// send the same `tools`.
//
//   node benchmarks/rust-core/recorders/record-custom-tool-wire.mjs --tree <tree>
// Output: native/core/fixtures/custom-tool-wire/golden.json.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const sandbox = mkdtempSync(join(tmpdir(), 'mixdog-custom-tool-wire-'));
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(sandbox, dir), { recursive: true });
  process.env[name] = join(sandbox, dir);
}
process.env.MIXDOG_HOME = join(sandbox, 'mixdog-home');
process.env.MIXDOG_DATA_DIR = join(sandbox, 'mixdog-home', 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const finalDir = join(FIXTURES_ROOT, 'custom-tool-wire');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-custom-tool-wire.mjs';
const { buildRequestBody } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/openai-responses-payload.mjs');
const { openAiPublicSupportsToolSearch } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/openai-model-capabilities.mjs');
const { PATCH_TOOL_DEFS } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs');

const applyPatch = PATCH_TOOL_DEFS.find((tool) => tool.name === 'apply_patch');
const objectSchema = (properties = {}) => ({ type: 'object', properties, required: [], additionalProperties: false });
const grammar = { type: 'grammar', syntax: 'lark', definition: 'start: /.+/s\n' };
// A schema the OpenAI rule refuses even after lowering (an unknown `type`).
const refused = { type: 'object', properties: { a: { type: 'nope' } } };
const tools = [
  { name: 'read', description: 'Read a file', inputSchema: objectSchema({ path: { type: 'string' } }) },
  applyPatch,
  { name: 'load_tool', description: 'Load deferred tools', inputSchema: objectSchema({ names: { type: 'array', items: { type: 'string' } } }) },
  // freeform, no freeformDescription (the tool's own description is the custom description), and a
  // JSON schema the wire would refuse: a freeform tool is not checked against it.
  { name: 'raw_text', description: 'Raw text in', freeform: grammar, inputSchema: refused },
  // the same schema without a grammar: left out of the request and reported
  { name: 'broken', description: 'Broken schema', inputSchema: refused },
  // not a grammar (no definition): an ordinary function tool
  { name: 'half', description: 'Half a grammar', freeform: { type: 'grammar', syntax: 'lark' }, inputSchema: objectSchema() },
  // an empty freeformDescription falls back to the description
  { name: 'blank_note', description: 'Described', freeformDescription: '', freeform: grammar, inputSchema: objectSchema() },
];
const messages = [
  { role: 'system', content: 'You are a fixture assistant.' },
  { role: 'user', content: 'Patch the file.' },
];
const routes = [
  { name: 'codex route', provider: 'openai-oauth', model: 'gpt-5.5' },
  { name: 'public API, native tool search', provider: 'openai', model: 'gpt-5.5' },
  { name: 'public API, before native tool search', provider: 'openai', model: 'gpt-4.1' },
];
const cases = [];
for (const route of routes) {
  const excluded = [];
  const body = buildRequestBody(messages, route.model, tools, {
    promptCacheProvider: route.provider,
    onToolExcluded: (info) => excluded.push({ name: info?.name, index: info?.index, pointer: info?.pointer, reason: info?.reason, message: info?.message }),
  });
  // Whether the route declares native tool search (the public API by model, the Codex route always).
  const nativeToolSearch = route.provider === 'openai-oauth' || openAiPublicSupportsToolSearch(route.model);
  cases.push({ ...route, nativeToolSearch, tools: body.tools, excluded });
}
rmSync(sandbox, { recursive: true, force: true });
writeJson(join(stage, 'golden.json'), { inputs: tools, cases });
writeSetManifest(stage, { set: 'custom-tool-wire', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
console.log(`recorded ${cases.length} routes over ${tools.length} tools`);
