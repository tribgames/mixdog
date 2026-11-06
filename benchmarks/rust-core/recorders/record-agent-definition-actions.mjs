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
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

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
const IDS = ['fresh-one', 'Fresh_Two', 'bad id!', '', '.dot', hidden[0], 'maintainer', 'worker', 'lead'];

// Image uploads as data URLs: a PNG header (optionally animated), a GIF, and broken ones.
const chunk = (type, data) => Buffer.concat([Buffer.from([0, 0, 0, data.length]), Buffer.from(type), data, Buffer.alloc(4)]);
function png(width, height, animated = false) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header)];
  if (animated) parts.push(chunk('acTL', Buffer.alloc(8)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return `data:image/png;base64,${Buffer.concat(parts).toString('base64')}`;
}
function gif(width, height) {
  const bytes = Buffer.alloc(32);
  bytes.write('GIF89a', 0, 'latin1');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return `data:image/gif;base64,${bytes.toString('base64')}`;
}
const AVATARS = [
  null,
  { kind: 'mascot', species: 'corgi', accessory: 'bow', expression: 'happy', color: '#F06A5F' },
  { kind: 'mascot', species: 'dalmatian', accessory: 'headset', color: '#5b9bff' },
  { kind: 'mascot', variant: 'floppy-happy-collar', color: '#e6e6e6' },
  { kind: 'mascot', species: 'dragon', color: '#e6e6e6' },
  { kind: 'mascot', species: 'shiba', color: '#123456' },
  { kind: 'custom', states: { idle: { data: png(16, 16) } } },
  { kind: 'custom', states: { idle: { data: png(16, 16) }, typing: { data: png(32, 32) } } },
  { kind: 'image', data: png(16, 16) },
  { kind: 'custom', states: { idle: { data: gif(16, 16), poster: png(16, 16) } } },
  { kind: 'custom', states: { idle: { data: gif(16, 16) } } },
  { kind: 'custom', states: { idle: { data: png(16, 16, true), poster: png(16, 16, true) } } },
  { kind: 'custom', states: { idle: { data: png(16, 8) } } },
  { kind: 'custom', states: { idle: { data: png(600, 600) } } },
  { kind: 'custom', states: { idle: { data: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } } },
  { kind: 'custom', states: { idle: { data: gif(16, 16).replace('image/gif', 'image/png') } } },
  { kind: 'custom', states: { idle: 'idle-0123456789ab.png' } },
  { kind: 'custom', states: { typing: { data: png(16, 16) } } },
  { kind: 'nothing' },
  'mascot',
];
const CONNECTORS = [
  null,
  { off: ['gmail'] },
  { off: [' b ', 'a', 'b'], tools: { gmail: { send: 'disabled', read: 'auto', bad: 'x' }, 'gmail-2': { read: 'needs_approval' } } },
  { off: [] },
  { off: [], tools: { gmail: { send: 'auto' } } },
  { tools: { zeta: { run: 'disabled' } } },
  [],
  [{ id: 'x', enabled: true }],
  { off: 'z' },
  { tools: [] },
  { other: 1 },
  'text',
];

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

// A save that goes to the editor itself, with the inputs the setup tool does not give.
function editorCall(known) {
  const payload = {};
  const how = next();
  if (how < 0.6) payload.id = pick(known);
  else if (how < 0.8) payload.name = pick(NAMES);
  else payload.id = pick(IDS);
  if (chance(0.4)) payload.name = pick(NAMES);
  payload.body = chance(0.9) ? pick(BODIES.slice(0, 5)) : pick(BODIES);
  if (chance(0.4)) payload.description = pick(['', 'edited']);
  if (chance(0.15)) payload.kind = pick(['bot', 'agent']);
  if (chance(0.35)) payload.persona = pick(['Warm and brief.', '', '  padded  ', null, 7]);
  if (chance(0.45)) payload.avatar = pick(AVATARS);
  if (chance(0.45)) payload.connectors = pick(CONNECTORS);
  if (chance(0.25)) payload.expectedRevision = pick(['$current', '$current', 'stale']);
  // `route` goes to the route setter (a separate service with its own twin); a unit test checks the call.
  const options = chance(0.4) ? { noWiden: chance(0.7) } : undefined;
  return { editor: { payload, ...(options ? { options } : {}) }, args: { action: 'save_agent_definition' } };
}

function makeCalls(known) {
  const calls = [];
  const count = 4 + Math.floor(next() * 5);
  for (let i = 0; i < count; i += 1) {
    const roll = next();
    let args;
    if (chance(0.3)) {
      calls.push({ caller: 'mixy', ...editorCall(known) });
      continue;
    }
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
      // Images are bytes; everything else is text.
      files[rel] = rel.startsWith('bots/') || rel.startsWith('agents/') ? (/(^|\/)avatar\/|\.png$/.test(rel) ? `b64:${readFileSync(file).toString('base64')}` : readFileSync(file, 'utf8')) : readFileSync(file, 'utf8');
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
    setAgentRoute: async (id, route) => {
      state.routeCalls.push({ id, route });
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
  const state = { config: { workflow: { active: 'default' }, ...world.config }, routeCalls: [] };
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
        let result;
        if (call.editor) {
          // `$current` stands for the stored definition's revision as the caller loaded it.
          const payload = { ...call.editor.payload };
          if (payload.expectedRevision === '$current') {
            payload.expectedRevision = await Promise.resolve()
              .then(() => api.getAgentDefinition(String(payload.id ?? '')))
              .then((definition) => definition.revision, () => 'missing');
          }
          result = await api.saveAgentDefinition(payload, call.editor.options);
        } else {
          result = await handlers[call.args.action](api, call.args, { caller: CALLERS[call.caller] });
        }
        outcome = { ok: mask(result, dirs.data) };
      } catch (error) {
        outcome = { error: mask(String(error?.message ?? error), dirs.data) };
      }
      steps.push({
        ...call,
        ...outcome,
        files: snapshot(dirs.data),
        routeCalls: JSON.parse(JSON.stringify(state.routeCalls)),
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

// Not `writeJson`: it sorts object keys, and the order of a connector policy's tools is a
// stored byte the twin pins.
writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/agent-definition-actions-twin.json`,
  `${JSON.stringify({ domain: 'agent-definition-actions-twin', recorder: 'benchmarks/rust-core/recorders/record-agent-definition-actions.mjs', callers: CALLERS, worlds }, null, 1)}\n`
);
console.log(`recorded ${worlds.length} worlds, ${worlds.reduce((n, w) => n + w.steps.length, 0)} calls`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
