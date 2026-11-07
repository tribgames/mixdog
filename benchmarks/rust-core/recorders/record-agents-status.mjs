#!/usr/bin/env node
// Golden twin of the setup tool's `status` reader for the `agents` domain: what Node's real
// `createSetupToolExecutor` answers for `{ action: 'status', domain: 'agents' }` over the real
// agent catalog (`workflow-agents-api` `listAgents`). The worlds are the recorded agent-definition
// worlds (`desktop/settings/agent-definitions-twin.json`: shipped and user definitions, tombstones,
// the bot store, disabled agents, routes), rebuilt in temp dirs, each with an orchestration mode
// and a bot order the runtime facade answers. The text is recorded raw: its key order is part of
// the answer. The live-session fallback positions (`routePositionsStatus`) are the route owner's
// state: no session is held in this recording (`sessions` is empty); the Rust test gives the
// reader held sessions through its seam and checks them as placed.
//
//   node benchmarks/rust-core/recorders/record-agents-status.mjs --tree <dir>
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'agents-status-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
const tree = resolveTree(parseArgs());
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');
const { createWorkflowAgentsApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api.mjs');
const workflow = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
const { normalizeAgentPermissionOrNone, readMarkdownDocument } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');
const { homeThreadEvidence } = await importFrom(tree, 'src/runtime/shared/agent-kind.mjs');

const twin = JSON.parse(readFileSync(join(FIXTURES_ROOT, 'desktop', 'settings', 'agent-definitions-twin.json'), 'utf8'));
const MODES = ['none', 'focused', 'balanced', 'swarm'];
const ORDERS = [[], ['alpha'], ['zeta', 'alpha', 'bot-one'], ['worker', 'writer']];
const GREETING = '[mixdog-runtime] The user just created you as a new agent named "x".';

function putFiles(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(base, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function editorOf(world, dirs, config) {
  const state = { config };
  const helpers = workflow.createWorkflowHelpers({ rootDir: dirs.shipped, dataDir: dirs.data, readMarkdownDocument, normalizeAgentPermissionOrNone });
  const { agentRouteFromConfig } = workflow.createWorkflowRouteHelpers({ findPreset: () => null });
  return createWorkflowAgentsApi({
    ...helpers,
    rootDir: dirs.shipped,
    getConfig: () => state.config,
    displayConfig: () => state.config,
    cfgMod: { getPluginData: () => dirs.data },
    STANDALONE_DATA_DIR: dirs.data,
    resolveRoute: (_config, requested) => (Object.keys(requested).length ? { ...requested } : world.main ? { ...world.main } : null),
    agentRouteFromConfig,
    saveConfigAndAdopt: (value) => {
      state.config = value;
    },
    lookupModelMeta: async () => ({}),
    ensureProvidersReady: async () => {},
    refreshEmptySessionToolPolicy: async () => ({ appliedToCurrentSession: true }),
    invalidateContextStatusCache() {},
  });
}

const recorded = [];
let skipped = 0;
for (const [index, world] of twin.worlds.entries()) {
  const root = mkdtempSync(join(tmpdir(), 'agents-status-world-'));
  const dirs = { shipped: join(root, 'shipped'), data: join(root, 'data') };
  mkdirSync(dirs.shipped, { recursive: true });
  mkdirSync(dirs.data, { recursive: true });
  putFiles(dirs.shipped, world.shipped);
  putFiles(dirs.data, world.data);
  // The home threads the definitions' kinds rest on, rebuilt from the evidence the world recorded.
  for (const [id, seen] of Object.entries(world.evidence)) {
    if (!seen.greeted && !seen.chatted) continue;
    const messages = [];
    if (seen.greeted) messages.push({ role: 'user', content: GREETING });
    if (seen.chatted) messages.push({ role: 'user', content: '안녕' });
    mkdirSync(join(dirs.data, 'sessions'), { recursive: true });
    writeFileSync(join(dirs.data, 'sessions', `sess_home_${id}.json`), JSON.stringify({ id: `sess_home_${id}`, provider: 'x', model: 'y', profile: { homeAgent: id }, messages }));
  }
  workflow.clearAgentDefinitionCache();
  const rebuilt = Object.entries(world.evidence).every(([id, seen]) => {
    const now = homeThreadEvidence(dirs.data, id);
    return now.greeted === seen.greeted && now.chatted === seen.chatted;
  });
  if (!rebuilt) {
    skipped += 1;
    rmSync(root, { recursive: true, force: true });
    continue;
  }
  const mode = MODES[index % MODES.length];
  const order = ORDERS[Math.floor(index / MODES.length) % ORDERS.length];
  const detail = index % 5 === 0;
  const config = { workflow: { active: 'default' }, ...world.config, ...(order.length ? { botOrder: order } : {}) };
  const editor = editorOf(world, dirs, config);
  const executor = createSetupToolExecutor({
    getApi: () => ({ ...editor, getOrchestrationMode: () => mode, getBotOrder: () => ({ order }) }),
    getConfig: () => config,
    getSessionId: () => 'sess_a',
    notifySessionUi: () => false,
  });
  const text = await executor.execute({ action: 'status', domain: 'agents', ...(detail ? { detail: true } : {}) }, {});
  recorded.push({ world: world.name, mode, botOrder: order, detail, text });
  rmSync(root, { recursive: true, force: true });
}

writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/agents-status-twin.json`,
  `${JSON.stringify({ domain: 'agents-status-twin', recorder: 'benchmarks/rust-core/recorders/record-agents-status.mjs', worlds: 'desktop/settings/agent-definitions-twin.json', skippedWorlds: skipped, cases: recorded }, null, 1)}\n`
);
console.log(`recorded ${recorded.length} worlds, skipped ${skipped}`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
