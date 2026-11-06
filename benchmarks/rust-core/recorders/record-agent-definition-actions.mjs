#!/usr/bin/env node
// Golden twin of the agent definition setup actions: what Node's real handlers
// (setup-tool/extended-actions.mjs create/save/delete/read_definition and
// agent-settings-actions.mjs restore_definition) answer, and the files and config they leave,
// over the worlds of agent-definitions-twin.json. Each world is written to a temp dir, a
// deterministic list of calls runs against the real agent editor (workflow-agents-api), and
// after every call the data folder, the disabled list and the route keys are recorded. Run
// record-agent-definitions.mjs first: its worlds are this recorder's starting points.
//
//   node benchmarks/rust-core/recorders/record-agent-definition-actions.mjs --tree <dir>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'agent-actions-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
const tree = resolveTree(parseArgs());
const { createWorkflowAgentsApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api.mjs');
const workflow = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
const { normalizeAgentPermissionOrNone, readMarkdownDocument } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');
const { isAgentDisabled } =await importFrom(tree, 'src/runtime/shared/agent-route-config.mjs');
const { EXTENDED_SETUP_HANDLERS } = await importFrom(tree, 'src/session-runtime/setup-tool/extended-actions.mjs');
const { AGENT_SETTINGS_HANDLERS } = await importFrom(tree, 'src/session-runtime/setup-tool/agent-settings-actions.mjs');
const handlers = { ...EXTENDED_SETUP_HANDLERS, ...AGENT_SETTINGS_HANDLERS };
const hidden = JSON.parse(readFileSync(join(tree, 'src/defaults/agents.json'), 'utf8')).agents.map((a) => a.agent);

const twin = JSON.parse(readFileSync(`${FIXTURES_ROOT}/desktop/settings/agent-definitions-twin.json`, 'utf8'));

let seed = 0x51ed270b;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const chance = (p) => next() < p;
const pick = (list) => list[Math.floor(next() * list.length)];

// The sessions the calls come from: Mixy's chat (agent mode), a coding task, a contact's chat.
const CALLERS = { mixy: { id: 'sess_home_lead' }, coding: { id: 'sess_task_1' }, contact: { id: 'sess_home_ada' } };
const BODIES = ['You are careful.', 'Line one.\nLine two.\n', 'Body\r\nwith CRLF', 'Another body.', ' padded  ', '   ', ''];
const NAMES = ['Nova', 'Écrivain  du soir', 'a/b c', '', 'ünï', '日本語', 'worker', 'Bot One'];
const IDS = ['fresh-one', 'Fresh_Two', 'bad id!', '', '.dot', hidden[0], 'maintainer', 'worker'];

function createArgs() {
  const definition = {};
  if (chance(0.7)) definition.name = pick(NAMES);
  if (chance(0.4)) definition.id = pick(IDS);
  if (chance(0.92)) definition.body = pick(BODIES);
  if (chance(0.5)) definition.description = pick(['', 'does things', 'multi\nline']);
  if (chance(0.35)) definition.kind = pick(['bot', 'agent', 'weird', 7]);
  if (chance(0.06)) definition.extra = 1;
  return { action: 'create_definition', definitionKind: 'agent', definition };
}

function saveArgs(known) {
  const definition = {};
  const target = pick(known);
  const how = next();
  if (how < 0.5) definition.id = target;
  else if (how < 0.75) definition.name = target;
  else if (how < 0.9) definition.originalName = target;
  if (chance(0.5)) definition.body = pick(BODIES);
  if (chance(0.4)) definition.description = pick(['', 'changed', 'x']);
  if (chance(0.3)) definition.name = pick(NAMES);
  if (chance(0.12)) definition.kind = pick(['bot', 'agent']);
  return { action: 'save_definition', definitionKind: 'agent', definition };
}

function makeCalls(known) {
  const calls = [];
  const count = 4 + Math.floor(next() * 5);
  for (let i = 0; i < count; i += 1) {
    const roll = next();
    let args;
    if (roll < 0.28) args = createArgs();
    else if (roll < 0.52) args = saveArgs(known);
    else if (roll < 0.72) args = { action: 'delete_definition', definitionKind: 'agent', name: pick(known) };
    else if (roll < 0.9) args = { action: 'restore_definition', definitionKind: 'agent', name: pick(known) };
    else args = { action: 'read_definition', definitionKind: 'agent', name: pick(known) };
    calls.push({ caller: pick(Object.keys(CALLERS)), args });
  }
  return calls;
}

function putFiles(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(base, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

// The data folder as text, in a stable order; timestamps in backup names are masked.
function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const file = join(current, name);
      if (statSync(file).isDirectory()) {
        walk(file);
        continue;
      }
      const rel = relative(dir, file).split('\\').join('/').replace(/defaults-separation-[^/]+/, 'defaults-separation-<ts>');
      files[rel] = readFileSync(file, 'utf8');
    }
  };
  walk(dir);
  return files;
}

// Paths and timestamps in an answer are the sandbox's: the twin compares them masked.
const mask = (value, dir) =>
  JSON.parse(JSON.stringify(value ?? null, (_k, v) => (typeof v === 'string' ? v.split('\\').join('/').split(dir.split('\\').join('/')).join('<data>') : v)));

function apiFor(world, dirs, state) {
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

async function record(world, index) {
  const root = mkdtempSync(join(tmpdir(), 'agent-action-world-'));
  const dirs = { shipped: join(root, 'shipped'), data: join(root, 'data') };
  mkdirSync(dirs.shipped, { recursive: true });
  mkdirSync(dirs.data, { recursive: true });
  putFiles(dirs.shipped, world.shipped);
  putFiles(dirs.data, world.data);
  workflow.clearAgentDefinitionCache();
  const state = { config: { workflow: { active: 'default' }, ...world.config } };
  try {
    const api = apiFor(world, dirs, state);
    // Mostly agents that exist (or sit archived), with a few that do not or are internal.
    const archived = world.queries.filter((q) => world.expect.archived[q]);
    const real = [...new Set([...world.expect.customIds, ...archived])];
    const known = real.length ? [...real, ...real, ...real, 'ghost', 'maintainer', hidden[0]] : ['ghost', 'maintainer'];
    const calls = makeCalls(known);
    const steps = [];
    for (const call of calls) {
      let outcome;
      try {
        const handler = handlers[call.args.action];
        const result = await handler(api, call.args, { caller: CALLERS[call.caller] });
        outcome = { ok: mask(result, dirs.data) };
      } catch (error) {
        outcome = { error: mask(String(error?.message ?? error), dirs.data) };
      }
      steps.push({
        ...call,
        ...outcome,
        files: snapshot(dirs.data),
        disabled: Object.fromEntries(world.queries.map((q) => [q, isAgentDisabled(state.config, q)])),
        // The saved config keeps complete routes only; the stub here stores what it is given.
        routes: Object.entries(state.config.agents ?? {})
          .filter(([, route]) => String(route?.provider || '').trim() && String(route?.model || '').trim())
          .map(([id]) => id)
          .sort(),
      });
    }
    return { name: `actions-${index}`, world: world.name, shipped: world.shipped, data: world.data, config: world.config, main: world.main, steps };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const worlds = [];
for (const [index, world] of twin.worlds.entries()) worlds.push(await record({ ...world }, index));

writeJson(`${FIXTURES_ROOT}/desktop/settings/agent-definition-actions-twin.json`, {
  domain: 'agent-definition-actions-twin',
  recorder: 'benchmarks/rust-core/recorders/record-agent-definition-actions.mjs',
  callers: CALLERS,
  worlds,
});
console.log(`recorded ${worlds.length} worlds, ${worlds.reduce((n, w) => n + w.steps.length, 0)} calls`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
