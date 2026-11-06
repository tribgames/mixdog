#!/usr/bin/env node
// Gateway wire routing (WP-AI-COMPAT): the REAL Node `resolveWireRoute`
// (wire-route.mjs) over a grid of (provider, model, context). Every dimension
// value combination is run in nested order (the last dimension varies fastest)
// and each answer is stored as two letters, wire then source (`-`: not
// routable). The Rust test replays the same grid against `resolve_wire`.
//
//   node benchmarks/rust-core/recorders/record-wire-route.mjs [--tree <dir>]
//
// Output: native/core/fixtures/providers/oracles/wire-route.json. It lives
// inside `providers/`, so record-providers.mjs calls `recordWireRoute` before
// its manifest write; run standalone it leaves the manifest alone.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const P = 'src/runtime/agent/orchestrator/providers';

const MODELS = {
  openrouter: [
    'anthropic/claude-opus-4.8',
    '~anthropic/claude-opus-latest',
    'openai/gpt-6.1-sol',
    'openai/o3',
    '~openai/gpt-sol-latest',
    'openrouter/auto',
    'google/gemini-4-argon',
  ],
  'opencode-go': [
    'claude-haiku-5-5',
    'minimax-m3',
    'Qwen3.7-max',
    'gpt-6-luna',
    'Grok-4.7',
    'muse-spark-1.3',
    'gemini-4-argon',
    'glm-5.2',
  ],
  'command-code-oauth': [
    'claude-sonnet-5',
    'anthropic/claude-sonnet-5',
    'gpt-5.5',
    'openai/gpt-5.5',
    'muse-spark-1.3',
    'grok-4.7',
    'glm-5',
    'deepseek/deepseek-v4-flash',
  ],
  deepseek: ['deepseek-v4-pro', 'DeepSeek-V4-Flash', 'other-model'],
  // A user-defined provider: protocol wire, the wires its endpoint serves, no family table.
  'custom-chat': ['m1', 'anthropic/claude-x'],
  'custom-responses': ['m1', 'anthropic/claude-x'],
};

// models.dev `provider.npm` per OpenCode Go model (null: a row without a package).
const GO_PACKAGES = {
  'go-chat': '@ai-sdk/openai-compatible',
  'go-responses': '@ai-sdk/openai',
  'go-messages': '@ai-sdk/anthropic',
  'go-gemini': '@ai-sdk/google',
  'go-other-package': '@x/y',
  'go-no-package': null,
  'gpt-6-luna': '@ai-sdk/openai-compatible',
  'claude-haiku-5-5': null,
  'minimax-m3': '@ai-sdk/openai',
  'unlisted-model': undefined,
};
// `supported_endpoints` shapes of a Command Code /models row (undefined: not declared).
const CC_ENDPOINTS = {
  undeclared: undefined,
  none: [],
  chat: ['/chat/completions'],
  messages: ['/provider/v1/messages'],
  responses: ['v1/responses'],
  chat_responses: ['/chat/completions', '/responses'],
  messages_responses: ['/messages', '/responses'],
  messages_chat: ['/messages', '/chat/completions'],
  unknown_path: ['/embeddings'],
};

const GRIDS = [
  {
    name: 'context',
    dimensions: {
      override: [null, 'chat', 'messages'],
      catalogWire: [null, 'chat', 'messages', 'gemini'],
      endpoints: [null, [], ['chat'], ['messages'], ['chat', 'responses'], ['messages', 'responses']],
      known: [true, false],
      agent: [false, true],
      legacy: [false, true],
    },
    models: (all) => all,
  },
  {
    name: 'keep-and-exclude',
    dimensions: {
      keep: [null, 'chat', 'messages', 'responses', 'gemini'],
      exclude: [[], ['chat'], ['messages'], ['responses'], ['chat', 'messages']],
      known: [true, false],
      endpoints: [null, ['chat', 'responses']],
      agent: [true],
    },
    models: (all) => all.slice(0, 2),
  },
];

const WIRE = { chat: 'c', messages: 'm', responses: 'r', gemini: 'g' };
const SOURCE = { pinned: 'p', override: 'o', catalog: 'c', endpoints: 'e', family: 'f', default: 'd', legacy: 'l', unknown: 'u' };

function* product(dimensions) {
  const names = Object.keys(dimensions);
  const walk = function* (index, ctx) {
    if (index === names.length) return yield { ...ctx };
    for (const value of dimensions[names[index]]) yield* walk(index + 1, { ...ctx, [names[index]]: value });
  };
  yield* walk(0, {});
}

export async function recordWireRoute(tree, outFile) {
  const { resolveWireRoute, customWireProfile, registerWireProfile } = await importFrom(tree, `${P}/wire-route.mjs`);
  registerWireProfile('custom-chat', customWireProfile({ protocolWire: 'chat', wires: ['chat', 'responses'] }));
  registerWireProfile('custom-responses', customWireProfile({ protocolWire: 'responses' }));
  const code = (route) => (route ? `${WIRE[route.wire]}${SOURCE[route.source]}` : '-');
  const grids = GRIDS.map((grid) => ({
    name: grid.name,
    order: Object.keys(grid.dimensions),
    dimensions: grid.dimensions,
    rows: Object.entries(MODELS).flatMap(([provider, models]) =>
      grid.models(models).map((model) => ({
        provider,
        model,
        results: [...product(grid.dimensions)].map((ctx) => code(resolveWireRoute(provider, model, ctx))).join(','),
      }))
    ),
  }));
  // OpenCode Go: the wire the models.dev package names narrows the offered endpoints
  // (`resolveOpenCodeGoWireRoute`). The catalog is the real module's, warmed from a
  // disk copy in a scratch data dir.
  const dataDir = mkdtempSync(join(tmpdir(), 'wire-route-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  const catalogRows = Object.fromEntries(
    Object.entries(GO_PACKAGES).filter(([, npm]) => npm !== undefined).map(([id, npm]) => [id, npm === null ? { id } : { id, provider: { npm } }])
  );
  writeFileSync(
    join(dataDir, 'modelsdev-catalog.json'),
    `{"fetchedAt":${Date.now()},"data":${JSON.stringify({ 'opencode-go': { models: catalogRows } })}}\n`
  );
  const catalog = await importFrom(tree, 'src/runtime/shared/llm/model-catalog.mjs');
  await catalog.warmCatalogFromDisk();
  const go = await importFrom(tree, `${P}/opencode-go.mjs`);
  const goDimensions = {
    override: [null, 'chat', 'messages', 'responses', 'gemini'],
    agent: [false, true],
    legacy: [false, true],
  };
  const goRows = Object.keys(GO_PACKAGES).map((model) => ({
    model,
    results: [...product(goDimensions)].map((ctx) => code(go.resolveOpenCodeGoWireRoute(model, ctx))).join(','),
  }));
  // Command Code: the wire a /models row is served on from its declared endpoints.
  const cc = await importFrom(tree, `${P}/command-code-oauth.mjs`);
  const ccRows = [];
  for (const [name, declared] of Object.entries(CC_ENDPOINTS)) {
    for (const model of MODELS['command-code-oauth']) {
      const item = declared === undefined ? { id: model } : { id: model, supported_endpoints: declared };
      const wire = cc.modelWire(item);
      ccRows.push({ model, declared: name, item, wire: wire ?? null });
    }
  }
  rmSync(dataDir, { recursive: true, force: true });
  writeJson(outFile, {
    openCodeGo: { packages: GO_PACKAGES, dimensions: goDimensions, order: Object.keys(goDimensions), rows: goRows },
    commandCode: ccRows,
    _doc: 'Recorded from src/runtime/agent/orchestrator/providers/wire-route.mjs resolveWireRoute. `results` lists the answer for every combination of `dimensions` (nested in key order, the last varies fastest): wire letter (c chat, m messages, r responses, g gemini) then source letter (p pinned, o override, c catalog, e endpoints, f family, d default, l legacy, u unknown); `-` is not routable. `custom-chat` is customWireProfile({protocolWire:chat, wires:[chat,responses]}), `custom-responses` customWireProfile({protocolWire:responses}).',
    recorder: 'benchmarks/rust-core/recorders/record-wire-route.mjs',
    grids,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tree = resolveTree(parseArgs());
  await recordWireRoute(tree, join(FIXTURES_ROOT, 'providers', 'oracles', 'wire-route.json'));
  console.log('recorded wire-route; providers/MANIFEST.json is regenerated by record-providers.mjs');
}
