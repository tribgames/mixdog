#!/usr/bin/env node
// Golden twin of the boot pass `ensureDefaultsSeparated` (shared/defaults-separation.mjs, with
// `separateStoredAgent` of orchestrator/config.mjs) and of the born-current stamp of a first write
// (shared/config.mjs `updateConfig`): `mixdog-core-config` `config/separation.rs`, `Config::update_on`.
//
// Each case is a config file as an older or current install left it. `loadConfig({ secrets: false })`
// runs the pass first (that is where Node runs it); the fixture keeps the file afterwards, the copies
// the pass backed up, and the roster of switched-off agents the loaded config holds. A `write` case
// updates a missing config instead. Every folder is a fresh temp one before any Mixdog module is imported.
//
//   node benchmarks/rust-core/recorders/record-defaults-separation.mjs --tree <dir with node_modules>
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'defaults-separation');
const stage = stageSet(outDir);

const work = mkdtempSync(join(tmpdir(), 'defaults-separation-'));
const dir = (name) => {
  const path = join(work, name);
  mkdirSync(path, { recursive: true });
  return path;
};
const home = dir('home');
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_BACKUP_DIR = dir('backup');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = dir('appdata');
process.env.LOCALAPPDATA = dir('localappdata');
for (const name of Object.keys(process.env)) if (/^ANTHROPIC_DEFAULT_.*_MODEL$/.test(name)) delete process.env[name];

// `loadConfig` rewrites the file again after the pass (its own storage canonicalisation: `providers: {}`,
// `webSearchRoute: null`, …), which is not part of the pass. The pass publishes its file by renaming a
// temp file over the config, so the content of the first such rename is what the pass wrote.
const published = [];
const nativeRename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to).endsWith('mixdog-config.json') && !String(to).includes('backups')) published.push(fs.readFileSync(from, 'utf8'));
  return nativeRename(from, to);
};
syncBuiltinESMExports();

const { loadConfig } = await importFrom(tree, 'src/runtime/agent/orchestrator/config.mjs');
const { updateConfig } = await importFrom(tree, 'src/runtime/shared/config.mjs');

const route = { provider: 'openai', model: 'gpt-x' };
const SHIPPED_HAIKU = { id: 'haiku', name: 'HAIKU', type: 'agent', provider: 'anthropic-oauth', model: 'claude-haiku-4-5-20251001', tools: 'full' };
const CUSTOM_PRESET = { id: 'mine', name: 'Mine', type: 'agent', provider: 'openai', model: 'gpt-x', effort: 'high', tools: 'full' };

const CASES = [
  // The environment the real-turn harness starts both daemons from.
  { name: 'harness-config', root: { agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: 'http://127.0.0.1:1/v1', auth: 'none', enabled: true } } } } },
  {
    name: 'full-list-and-defaults',
    root: {
      agent: {
        disabledAgents: ['worker', 'reviewer', 'custom'],
        presets: [SHIPPED_HAIKU, CUSTOM_PRESET],
        maintenance: { webhook: { provider: 'anthropic-oauth', model: 'claude-haiku-4-5-20251001' }, memory: { provider: 'openai', model: 'gpt-x' } },
        default: 1,
        autoClear: { enabled: true, minContextPercent: 10, idleMs: 120000.4, providers: { OpenAI: 'never', Slow: '30000', Bad: -1 } },
        compaction: { auto: true, enabled: false, semanticModel: 'm', recallLimit: 3 },
        modules: { memory: { enabled: true }, webSearch: false, extra: { enabled: true } },
        update: { auto: true },
        recap: { enabled: true },
        memoryTools: { enabled: true },
        workflow: { active: 'default' },
        orchestrationMode: 'balanced',
        agents: { worker: route, explore: route, mine: route },
        builtins: { git: { installed: true, firstUseApproval: true }, memory: 'odd' },
      },
      channels: { webhook: { enabled: true, port: 3333 } },
      outputStyle: ' simple ',
      desktop: { zoom: 1 },
    },
  },
  { name: 'swarm-workflow-and-grandfathered-builtins', root: { agent: { workflow: { active: 'review' }, orchestrationMode: 'none', providers: { openai: { enabled: true } } }, channels: { webhook: { enabled: false, port: 3333 }, other: 1 } } },
  { name: 'numeric-default', root: { agent: { default: '0', presets: [CUSTOM_PRESET] } } },
  { name: 'numeric-default-out-of-range', root: { agent: { default: 99, presets: [CUSTOM_PRESET] } } },
  { name: 'version-one', root: { defaultsVersion: 1, agent: { enabledAgents: ['worker'], disabledAgents: ['custom'], builtins: { git: { installed: true, firstUseApproval: true } }, agents: { debugger: route, mine: route }, presets: [SHIPPED_HAIKU], maintenance: { webhook: { provider: 'anthropic-oauth', model: 'claude-haiku-4-5-20251001' } } } } },
  { name: 'retired-route-with-own-definition', files: { 'agents/explore/AGENT.md': '# Explore\n\nMine.\n' }, root: { defaultsVersion: 1, agent: { agents: { explore: route, 'web-researcher': route } } } },
  { name: 'version-one-nothing-to-change', root: { defaultsVersion: 1, agent: { providers: { openai: { enabled: true } } } } },
  {
    name: 'canonical-storage',
    root: {
      defaultsVersion: 2,
      agent: {
        providers: { ollama: { enabled: true }, lmstudio: {}, openai: { enabled: true } },
        presets: [{ id: 'local', name: 'Local', provider: 'ollama', model: 'm' }, { id: 'workflow-agent-x', name: 'x', provider: 'openai', model: 'gpt-x' }, { id: 'mine', name: 'Mine', provider: 'openai', model: 'gpt-x', fast: true }, { name: '' }],
        default: 'local',
        agents: { worker: route, partial: { provider: 'openai' }, maintenance: route, local: { provider: 'lmstudio', model: 'z' } },
        maintenance: { memory: route, other: { provider: 'ollama', model: 'q' } },
        modelSettings: { 'ollama/x': { a: 1 }, 'openai/gpt-x': { effort: 'high' } },
        workflowRoutes: { lead: route },
        shell: { path: ' /bin/zsh ', other: 1 },
        profile: { language: 'ko', stray: 1 },
        skills: { disabled: ['b', 'a', ' a ', ''] },
        extensionScopes: { skills: { s: [] }, mcp: {}, plugins: {} },
        webSearchRoute: { provider: 'openai-api', model: ' gpt-x ', fast: false },
        guide: { x: 1 },
        runtime: { y: 2 },
        disabledAgents: ['Custom_One', 'custom-one'],
      },
    },
  },
  {
    name: 'superseded-codex-routes',
    files: {
      'openai-oauth-models.json': JSON.stringify({
        version: 7,
        fetchedAt: 1,
        models: [
          { id: 'gpt-old', upgrade: { model: 'gpt-new', retirementAt: '2020-01-01T00:00:00.000Z' } },
          { id: 'gpt-later', upgrade: { model: 'gpt-new', retirementAt: '2999-01-01T00:00:00.000Z' } },
          { id: 'gpt-new', priority: 2 },
          { id: 'gpt-blue', accessPrograms: ['daybreak_blue'] },
          { id: 'gpt-5', accessPrograms: ['standard', 'daybreak_blue'], priority: 1 },
          { id: 'gpt-hidden', hidden: true, accessPrograms: ['standard', 'daybreak_blue'], priority: 0 },
        ],
      }),
    },
    root: {
      defaultsVersion: 2,
      agent: {
        agents: { a: { provider: 'openai-oauth', model: 'gpt-old', effort: 'low' }, b: { provider: 'openai-oauth', model: 'gpt-blue', modelParameters: { k: 1 } }, c: { provider: 'openai-oauth', model: 'gpt-later' }, d: { provider: 'openai', model: 'gpt-old' } },
        modelSettings: { 'openai-oauth/gpt-old': { x: 1 }, 'openai-oauth/gpt-new': { x: 2 } },
      },
    },
  },
  { name: 'current-version', root: { defaultsVersion: 2, agent: { enabledAgents: ['worker'], autoClear: { enabled: true } } } },
  { name: 'empty-file', root: {} },
];

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
const results = [];
for (const [index, item] of CASES.entries()) {
  const data = dir(`data-${index}`);
  process.env.MIXDOG_DATA_DIR = data;
  for (const [rel, text] of Object.entries(item.files ?? {})) {
    mkdirSync(dirname(join(data, rel)), { recursive: true });
    writeFileSync(join(data, rel), text);
  }
  const file = join(data, 'mixdog-config.json');
  const input = JSON.stringify(item.root, null, 2);
  writeFileSync(file, input);
  published.length = 0;
  const config = loadConfig({ secrets: false });
  const passText = published[0] ?? null;
  const backups = existsSync(join(data, 'backups'))
    ? readdirSync(join(data, 'backups')).map((name) => ({ name: name.replace(/\d{4}-\d{2}-\d{2}T[\d-]+Z/, '<iso>'), text: read(join(data, 'backups', name, 'mixdog-config.json')) }))
    : [];
  const lastText = published.at(-1) ?? null;
  results.push({ name: item.name, files: item.files ?? {}, input: item.root, inputText: input, output: passText === null ? item.root : JSON.parse(passText), final: lastText === null ? item.root : JSON.parse(lastText), backups, disabledAgents: config.disabledAgents ?? [] });
}

// The first write into a missing config stamps the marker (`withFreshDefaultsVersion`).
const born = dir('data-born');
process.env.MIXDOG_DATA_DIR = born;
updateConfig((current) => ({ ...current, agent: { recap: { enabled: false } } }));
const bornFile = JSON.parse(read(join(born, 'mixdog-config.json')));
const bornAgain = dir('data-born-twice');
process.env.MIXDOG_DATA_DIR = bornAgain;
updateConfig((current) => ({ ...current }));
const bornEmpty = JSON.parse(read(join(bornAgain, 'mixdog-config.json')));

writeJson(join(stage, 'twin.json'), { cases: results, born: { written: bornFile, empty: bornEmpty } });
writeSetManifest(stage, {
  set: 'defaults-separation',
  recorder: 'benchmarks/rust-core/recorders/record-defaults-separation.mjs',
  command: 'node benchmarks/rust-core/recorders/record-defaults-separation.mjs --tree <tree>',
  identityTree: cli.get('identity-tree') ?? tree,
});
commitStage(stage, outDir);
rmSync(work, { recursive: true, force: true });
console.log(`defaults-separation: ${results.length} cases -> ${outDir}`);
