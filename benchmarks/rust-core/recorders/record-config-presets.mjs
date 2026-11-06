#!/usr/bin/env node
// Golden twin of the stored `presets` and `webSearchRoute` of the agent config: what Node's
// save (`saveConfig`, through `buildAgentSaveBuilder` → `canonicalizeAgentStorage` →
// `normalizePreset` / `normalizeWebSearchRoute`) writes into a fresh config file for 120
// deterministic (fake) agent configs. `modelParameters`, `fast: false` and `fast` on a provider
// without a fast mode never reach the file.
//
//   node benchmarks/rust-core/recorders/record-config-presets.mjs --tree <dir>
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const dir = mkdtempSync(join(tmpdir(), 'config-presets-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_HOME = dir; // the config-write backups go under the home
const { saveConfig } = await importFrom(tree, 'src/runtime/agent/orchestrator/config.mjs');

let seed = 0x1c0ffee5;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;

const PROVIDERS = ['anthropic', 'anthropic-oauth', 'openai', 'openai-api', 'openai-oauth', 'cursor-api', 'gemini', 'gemini-api', 'xai-api', 'xai', ' openai ', '', undefined, 7];
const MODELS = ['m-1', ' m-2 ', 'big-model', '', undefined, null, 5];

function randomPreset(i) {
  const preset = {};
  if (chance(0.8)) preset.id = pick([`p${i}`, ` p${i} `, `id-${i}`]);
  if (chance(0.8)) preset.name = pick([`Name ${i}`, ` n${i} `, `p${i}`]);
  if (chance(0.9)) preset.provider = pick(PROVIDERS);
  if (chance(0.9)) preset.model = pick(MODELS);
  if (chance(0.5)) preset.type = pick(['agent', 'other', 1]);
  if (chance(0.5)) preset.effort = pick(['low', ' high ', '', 'medium', 3]);
  if (chance(0.5)) preset.fast = pick([true, false, 'yes', 1, null]);
  if (chance(0.4)) preset.autoEffort = pick([true, false, 0, null]);
  if (chance(0.5)) preset.tools = pick(['full', 'readonly', 'mcp', 'bogus', null, 1]);
  if (chance(0.4)) preset.modelParameters = pick([{ temperature: 0.2 }, {}, { top_p: 1, fast: false }, null]);
  if (chance(0.3)) preset.fallbacks = pick([[], [{ provider: 'openai', model: 'x' }], 'x', [{ model: 'y' }]]);
  if (chance(0.2)) preset.extra = { keep: false };
  return preset;
}

function randomRoute() {
  if (chance(0.15)) return pick([undefined, null, 'x', ['a'], 3]);
  const route = {};
  if (chance(0.85)) route.provider = pick(PROVIDERS);
  if (chance(0.85)) route.model = pick(MODELS);
  if (chance(0.5)) route.effort = pick(['low', ' high ', '', 2]);
  if (chance(0.5)) route.fast = pick([true, false, 'yes', null]);
  if (chance(0.5)) route.toolType = pick(['web_search', ' search ', '', 4]);
  if (chance(0.2)) route.extra = 1;
  return route;
}

const entries = [];
for (let i = 0; i < 120; i += 1) {
  const config = { providers: { openai: { enabled: true } } };
  const count = Math.floor(rnd() * 5);
  config.presets = Array.from({ length: count }, (_, k) => randomPreset(i * 10 + k));
  if (chance(0.7)) config.default = pick([null, '', config.presets[0]?.id, 'missing']);
  const route = randomRoute();
  if (route !== undefined) config.webSearchRoute = route;
  rmSync(join(dir, 'mixdog-config.json'), { force: true }); // each save starts from a fresh file
  saveConfig(structuredClone(config));
  const file = JSON.parse(readFileSync(join(dir, 'mixdog-config.json'), 'utf8'));
  const agent = file.agent ?? {};
  entries.push({
    config,
    presets: agent.presets ?? null,
    webSearchRoute: Object.hasOwn(agent, 'webSearchRoute') ? agent.webSearchRoute : '__absent__',
  });
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'config-presets-twin.json'), {
  domain: 'config-presets-twin',
  recorder: 'benchmarks/rust-core/recorders/record-config-presets.mjs',
  entries,
});
console.log(`recorded ${entries.length} stored preset configs`);
