#!/usr/bin/env node
// Golden twin of the agent definition loader: what Node's real `createWorkflowAgents`
// (runtime-core/workflow/agents.mjs) and the agent editor's read side (workflow-agents-api/
// agent-editor.mjs: listAgents, agentDefinitionPresence, archivedAgentIdentities,
// getLeadStatus, getLeadHomeRoute) answer over many generated profiles: shipped plus user
// definitions, tombstones, entry overrides, the bot store, Mixy's identity folder, disabled
// agents and routes. Each world is written to a temp dir, read by the real functions, and
// recorded as files in -> answers out. The home-thread evidence (`greeted`, `chatted`) and
// whether Mixy owns a routine are recorded as inputs: the loader takes them from the sessions
// and the automation store.
//
//   node benchmarks/rust-core/recorders/record-agent-definitions.mjs --tree <dir>
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'agent-definitions-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
const tree = resolveTree(parseArgs());
const { createWorkflowAgentsApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api.mjs');
const workflow = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
const { normalizeAgentPermissionOrNone, readMarkdownDocument } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');
const { isContactAgentId } = await importFrom(tree, 'src/runtime/shared/agent-route-config.mjs');
const { homeThreadEvidence } = await importFrom(tree, 'src/runtime/shared/agent-kind.mjs');
const { mixyExists } = await importFrom(tree, 'src/runtime/shared/mixy-presence.mjs');
const hiddenNames = JSON.parse(readFileSync(join(tree, 'src/defaults/agents.json'), 'utf8')).agents.map((a) => a.agent);

// A small deterministic generator: the fixture must record the same worlds every run.
let seed = 0x2f6e2b1;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const chance = (p) => next() < p;
const pick = (list) => list[Math.floor(next() * list.length)];

const MAINS = [null, { provider: 'anthropic-oauth', model: 'claude-opus-5' }, { provider: 'openai', model: 'gpt-6', effort: 'high' }];
const ROUTES = [
  { provider: 'openai', model: 'gpt-6' },
  { provider: 'anthropic-oauth', model: 'claude-opus-5', effort: 'high' },
  { provider: 'openai', model: ' ' },
  { provider: 'openai' },
  'gpt',
];
const SHIPPED_IDS = ['worker', 'reviewer', 'advisor', 'writer', 'security', 'front-worker', 'heavy-worker', 'maintainer', 'explore', 'zeta', 'shipped-bot', hiddenNames[0]];
const USER_DIRS = ['alpha', 'beta-bot', 'Gamma', 'delta_x', 'eps.1', '.hidden', 'a b', 'worker', 'writer', 'maintainer', 'lead', 'mixy', 'zeta', 'shipped-bot', 'bot-one', 'bot-two', 'moved-bot', hiddenNames[0]];
const KINDS = [undefined, undefined, 'bot', 'Bot', ' agent ', '', 'weird'];
const PERMS = [undefined, undefined, 'read', 'READ-ONLY', 'write', 'full', 'mcp', 'bogus', ' '];
const DIALOG_TAIL = [
  '- Help the user in a natural, friendly conversation, in the language they write in.',
  '- Ask a short question when a request is unclear, and say plainly when something is outside what you do.',
  '- Keep replies as short or as detailed as the moment needs.',
];

function agentMd({ name, description, kind, permission, crlf }, body) {
  const fm = ['---'];
  if (name !== undefined) fm.push(`name: ${name}`);
  if (description !== undefined) fm.push(`description: "${description}"`);
  if (kind !== undefined) fm.push(`kind: ${kind}`);
  if (permission !== undefined) fm.push(`permission: ${permission}`);
  fm.push('---', '', body);
  return fm.join(crlf ? '\r\n' : '\n');
}

function definitionFiles(id, { shipped }) {
  const files = {};
  const body = pick(['You are an agent.', `You are ${id}.\nSecond line.`, '', '   ', DIALOG_TAIL.join('\n'), `Intro.\n${DIALOG_TAIL.join('\r\n')}`, `Intro.\n${DIALOG_TAIL.slice(1).join('\n')}`]);
  const fm = {
    name: chance(0.7) ? `Name ${id}` : undefined,
    description: chance(0.5) ? `does ${id}` : undefined,
    kind: pick(KINDS),
    permission: pick(PERMS),
    crlf: chance(0.2),
  };
  const manifestKind = pick(['none', 'none', 'plain', 'plain', 'avatar', 'entry', 'entry-out', 'nul', 'array', 'bom', 'broken']);
  let entry = 'AGENT.md';
  const manifest = {};
  if (chance(0.5)) manifest.name = pick([`Manifest ${id}`, '  spaced   name  ', '']);
  if (chance(0.4)) manifest.description = `manifest ${id}`;
  if (manifestKind === 'avatar') manifest.avatar = pick([{ kind: 'mascot', species: 'corgi', color: '#5b9bff' }, { kind: 'mascot', species: 'mixy', accessory: 'bow', color: '#ef6fb0' }, { kind: 'mascot', color: '#5b9bff' }, { kind: 'mascot', color: 'nope' }, { kind: 'custom', states: { idle: 'idle-0123456789abcdef.png' } }, { kind: 'custom', states: {} }, 'plain']);
  if (manifestKind === 'entry') {
    manifest.entry = 'docs/MAIN.md';
    entry = 'docs/MAIN.md';
  }
  if (manifestKind === 'entry-out') manifest.entry = '../outside.md';
  if (manifestKind !== 'none') {
    const text = JSON.stringify(manifest);
    if (manifestKind === 'nul') files['agent.json'] = '\0\0\0';
    else if (manifestKind === 'array') files['agent.json'] = '[1,2]';
    else if (manifestKind === 'bom') files['agent.json'] = `\ufeff${text}`;
    else if (manifestKind === 'broken') files['agent.json'] = '{"name": ';
    else files['agent.json'] = text;
  }
  const entryText = agentMd(fm, body);
  files[entry] = shipped && chance(0.2) ? `${entryText}\n` : entryText;
  if (manifestKind === 'entry-out') files['../outside.md'] = agentMd({ name: 'Outside' }, 'Outside body.');
  if (chance(0.3)) files['PERSONA.md'] = pick(['Warm and brief.\n', '\0\0', '  ', 'Formal.']);
  return files;
}

function putFiles(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(base, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function makeWorld(index) {
  const shipped = {};
  const data = {};
  const put = (target, dir, id, files) => {
    for (const [rel, content] of Object.entries(files)) target[`${dir}/${id}/${rel}`] = content;
  };
  for (const id of SHIPPED_IDS) if (chance(0.4)) put(shipped, 'agents', id, definitionFiles(id, { shipped: true }));
  const store = chance(0.4);
  const migrated = [];
  for (const dir of USER_DIRS) {
    if (!chance(0.25)) continue;
    const files = definitionFiles(dir, { shipped: false });
    if (chance(0.15)) files['.deleted'] = 'deleted';
    put(data, 'agents', dir, files);
    if (store && chance(0.3)) migrated.push(dir);
  }
  if (store) {
    for (const dir of USER_DIRS) if (chance(0.25)) put(data, 'bots', dir, definitionFiles(dir, { shipped: false }));
    put(data, 'bots', 'moved-bot', chance(0.5) ? definitionFiles('moved-bot', { shipped: false }) : {});
    data['bots/migration.json'] = JSON.stringify({ version: chance(0.9) ? 1 : 2, bots: [...migrated, 'moved-bot'] });
    if (chance(0.7)) {
      const mixy = { created: pick([true, false, undefined, 'yes']), name: pick(['', 'Aria', '  Aria  Two  ', undefined]) };
      if (chance(0.5)) mixy.route = pick(ROUTES);
      data['bots/mixy/agent.json'] = JSON.stringify(mixy);
    }
  } else if (chance(0.5)) {
    data['agents/lead/agent.json'] = JSON.stringify({ created: pick([true, false, 'no']), name: pick(['', 'Old Mixy']) });
  }
  if (store && chance(0.2)) data['agents/lead/agent.json'] = JSON.stringify({ created: true });
  const config = {};
  if (chance(0.5)) config.disabledAgents = ['worker', 'Heavy_Worker', 'alpha', 'bot-one', 'lead'].filter(() => chance(0.5));
  config.agents = {};
  for (const id of ['worker', 'alpha', 'zeta', 'beta-bot', 'bot-one', 'maintainer', 'explore', 'mixy', 'lead']) {
    if (chance(0.4)) config.agents[id] = pick(ROUTES);
  }
  const evidence = {};
  const threads = {};
  for (const dir of USER_DIRS) {
    if (chance(0.15)) {
      const greeting = '[mixdog-runtime] The user just created you as a new agent named "x".';
      const messages = pick([
        [{ role: 'user', content: greeting }],
        [{ role: 'user', content: '안녕' }],
        [{ role: 'user', content: '[mixdog-runtime] tick' }, { role: 'assistant', content: 'hi' }],
        [{ role: 'user', content: [{ text: greeting }, { text: 'more' }] }],
      ]);
      threads[dir] = messages;
    }
  }
  if (chance(0.3)) threads.lead = [{ role: 'user', content: 'hello Mixy' }];
  return { name: `world-${index}`, shipped, data, config, main: pick(MAINS), owns: chance(0.3), threads, evidence };
}

function api(world, dirs) {
  const state = { config: { workflow: { active: 'default' }, ...world.config } };
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

const dirNamesOf = (map) => [...new Set(Object.keys(map).map((key) => key.split('/')[1]))];

async function record(world) {
  const root = mkdtempSync(join(tmpdir(), 'agent-world-'));
  const dirs = { shipped: join(root, 'shipped'), data: join(root, 'data') };
  mkdirSync(dirs.shipped, { recursive: true });
  mkdirSync(dirs.data, { recursive: true });
  putFiles(dirs.shipped, world.shipped);
  putFiles(dirs.data, world.data);
  for (const [id, messages] of Object.entries(world.threads)) {
    mkdirSync(join(dirs.data, 'sessions'), { recursive: true });
    writeFileSync(join(dirs.data, 'sessions', `sess_home_${id}.json`), JSON.stringify({ id: `sess_home_${id}`, provider: 'x', model: 'y', profile: { homeAgent: id }, messages }));
  }
  workflow.clearAgentDefinitionCache();
  try {
    const editor = api(world, dirs);
    const helpers = workflow.createWorkflowHelpers({ rootDir: dirs.shipped, dataDir: dirs.data, readMarkdownDocument, normalizeAgentPermissionOrNone });
    const queries = [...new Set([...dirNamesOf(world.shipped), ...dirNamesOf(world.data), 'lead', 'mixy', 'ghost', 'Worker', 'worker', 'maintainer', 'maint', 'explore', 'a-b', 'delta-x', 'gamma', 'weird id', ''])];
    const evidence = Object.fromEntries(queries.map((id) => [id, (({ greeted, chatted }) => ({ greeted, chatted }))(homeThreadEvidence(dirs.data, id))]));
    const definitions = {};
    for (const id of queries) {
      const def = helpers.loadAgentDefinition(dirs.data, id);
      definitions[id] = def && { id: def.id, name: def.name, description: def.description, permission: def.permission, frontmatter: def.frontmatter, kind: def.kind, body: def.body, persona: def.persona };
    }
    const rows = editor.listAgents().map((row) => ({
      id: row.id,
      label: row.label,
      description: row.description,
      fixed: row.locked === true,
      userOverride: row.userOverride,
      route: row.route ?? null,
      routeConfigured: row.routeConfigured,
      kind: row.kind ?? null,
      disabled: row.disabled,
      avatar: row.avatar ?? null,
      hasDefinition: Boolean(row.definition),
    }));
    const contacts = editor
      .listAgents()
      .filter((row) => row.custom === true && row.disabled !== true && isContactAgentId(row.id, row.kind))
      .map((row) => ({ id: row.id, route: row.route ?? null }));
    const status = editor.getLeadStatus();
    const lead = { created: status.created, name: status.name, avatar: status.avatar ?? null, route: status.route };
    return {
      name: world.name,
      shipped: world.shipped,
      data: world.data,
      config: world.config,
      main: world.main,
      owns: world.owns,
      queries,
      evidence,
      expect: {
        customIds: helpers.listCustomAgentIds(dirs.data),
        delegatable: helpers.delegatableAgentIds(state(world), dirs.data),
        definitions,
        rows,
        contacts,
        presence: editor.agentDefinitionPresence(queries),
        archived: Object.fromEntries(Object.entries(editor.archivedAgentIdentities(queries)).map(([id, who]) => [id, who ? { name: who.name, avatar: who.avatar ?? null } : null])),
        lead,
        leadHomeRoute: editor.getLeadHomeRoute() ?? null,
        mixyExists: await mixyExists({ created: status.created, name: status.name, homeChatted: evidence.lead.chatted }, async () => world.owns),
      },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const state = (world) => ({ workflow: { active: 'default' }, ...world.config });

const worlds = [];
for (let index = 0; index < Number(process.env.WORLDS || 80); index += 1) {
  worlds.push(await record(makeWorld(index)));
  if (process.env.WORLDS) console.log('world', index);
}

const setDir = `${FIXTURES_ROOT}/desktop/settings`;
writeJson(`${setDir}/agent-definitions-twin.json`, {
  domain: 'agent-definitions-twin',
  recorder: 'benchmarks/rust-core/recorders/record-agent-definitions.mjs',
  worlds,
});
console.log(`recorded ${worlds.length} agent-definition worlds`);
rmSync(sandbox, { recursive: true, force: true });
// The bot store watches its files; nothing else is left to wait for.
process.exit(0);
