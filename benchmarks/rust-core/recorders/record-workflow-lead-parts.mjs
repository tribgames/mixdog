#!/usr/bin/env node
// Golden of `leadPromptParts(config, dir, { agentMode, agentId })` (`runtime-core/workflow/
// context.mjs`) with its agent catalogs, and of `leadPartsFor(session, leadPromptParts)`
// (`session-runtime/tool-policy/surface-helpers.mjs`): `native/core/fixtures/workflow-surface/
// lead-parts.json`.
//
// A world is an install root and a data dir (files as text) plus the config; the real
// `createWorkflowHelpers` scans its agents and reads its orchestration texts. Recorded per world:
// `leadPromptParts` for each mode and caller (the coding Lead, agent-mode Leads Mixy, a bot and
// one with no id), and `leadPartsFor` for a list of session records.
//
//   node benchmarks/rust-core/recorders/record-workflow-lead-parts.mjs --tree <tree>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const sandbox = mkdtempSync(join(tmpdir(), 'mixdog-lead-parts-'));
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(sandbox, dir), { recursive: true });
  process.env[name] = join(sandbox, dir);
}
process.env.MIXDOG_HOME = join(sandbox, 'mixdog-home');
process.env.MIXDOG_DATA_DIR = join(sandbox, 'mixdog-home', 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const { createWorkflowHelpers } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
const { normalizeAgentPermissionOrNone, readMarkdownDocument } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');
const { leadPartsFor } = await importFrom(tree, 'src/session-runtime/tool-policy/surface-helpers.mjs');

const ORCHESTRATION = Object.fromEntries(['none', 'focused', 'balanced', 'swarm'].map((mode) => [`orchestration/${mode}.md`, `Orchestration text of ${mode}.\r\nSecond line.\n`]));
const agent = (id, { name, description, kind, body = 'Agent body.' } = {}) => {
  const manifest = { ...(name ? { name } : {}), ...(description ? { description } : {}) };
  return {
    [`agents/${id}/AGENT.md`]: kind ? `---\nkind: ${kind}\n---\n${body}` : body,
    ...(Object.keys(manifest).length ? { [`agents/${id}/agent.json`]: JSON.stringify(manifest) } : {}),
  };
};
const WORKER = agent('worker', { name: 'Worker', description: 'Does the work' });
const REVIEWER = agent('reviewer', { name: 'Reviewer', description: 'Reviews the diff' });
const BOTTY = agent('botty', { name: 'Botty', description: 'Chats with the user', kind: 'bot' });

// `root` holds the shipped agents, `data` the user's; both folders also get the mode texts (root).
const WORLDS = [
  { name: 'no-agents', root: {}, data: {}, config: {} },
  { name: 'shipped-agents', root: { ...WORKER, ...REVIEWER }, data: {}, config: {} },
  { name: 'one-agent-switched-off', root: { ...WORKER, ...REVIEWER }, data: {}, config: { disabledAgents: ['reviewer'] } },
  { name: 'only-a-bot', root: {}, data: { ...BOTTY }, config: {} },
  { name: 'only-a-bot-switched-off', root: {}, data: { ...BOTTY }, config: { disabledAgents: ['Botty'] } },
  { name: 'only-an-agent-without-a-definition', root: {}, data: { 'agents/ghost/AGENT.md': '  \n' }, config: {} },
  {
    name: 'mixed-agents-and-a-renamed-mixy',
    root: { ...WORKER, ...agent('maintainer', { description: 'built-in slot' }) },
    data: {
      ...agent('mine', { name: 'Mine Agent' }),
      ...agent('aaa', { description: 'sorted by name, after the starters' }),
      ...agent('writer', { name: 'Writer', description: 'Writes' }),
      ...BOTTY,
      ...agent('botty2', { name: 'Botty Two', kind: 'bot' }),
      ...agent('lead', { name: 'Not an agent', description: 'the lead folder' }),
      ...agent('plain', { description: 'kind agent', kind: 'agent' }),
      'agents/ghost/AGENT.md': ' ',
      'agents/lead/agent.json': JSON.stringify({ name: '  Mimi   Lead ' }),
    },
    config: {},
  },
  {
    name: 'starter-bot-ids-stay-workflow-agents',
    root: {},
    data: { ...agent('worker', { name: 'Worker', description: 'a starter id marked bot', kind: 'bot' }), ...agent('zed', { name: 'Zed', description: 'plain' }) },
    config: {},
  },
];

const VARIANTS = [
  { options: undefined, modes: ['none', 'focused', 'balanced', 'swarm'] },
  { options: { agentMode: false, agentId: 'ignored' }, modes: ['balanced'] },
  { options: { agentMode: true, agentId: 'lead' }, modes: ['balanced'] },
  { options: { agentMode: true, agentId: 'botty' }, modes: ['balanced'] },
  { options: { agentMode: true, agentId: '' }, modes: ['none'] },
  { options: { agentMode: true, agentId: 'zed' }, modes: ['swarm'] },
];

const SESSIONS = [
  { id: 'sess_task' },
  { id: 'sess_home_lead' },
  { id: 'sess_home_botty' },
  { id: 'sess_home_botty2', sessionMode: 'agent' },
  { id: 'sess_rmem_abcdef_botty' },
  { id: 'sess_x', ownerAgentId: 'botty' },
  { id: 'sess_x', ownerAgentId: 'Botty ' },
  { id: 'sess_x', owner: 'agent', ownerAgentId: 'botty' },
  { id: 'sess_x', visibility: 'agent-only' },
  { id: 'sess_home_botty', sessionMode: 'coding' },
  { id: 'sess_x', sessionMode: 'agent' },
  { id: 'sess_x', sessionMode: 'agent', ownerAgentId: 'zed' },
  { id: 'sess_x', sessionMode: 'bogus', ownerAgentId: 'botty' },
  {},
];

function lay(folder, files) {
  for (const [path, text] of Object.entries(files)) {
    const file = join(folder, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

const recorded = [];
for (const [index, world] of WORLDS.entries()) {
  const root = join(sandbox, `world-${index}`, 'root');
  const data = join(sandbox, `world-${index}`, 'data');
  mkdirSync(root, { recursive: true });
  mkdirSync(data, { recursive: true });
  process.env.MIXDOG_DATA_DIR = data;
  process.env.MIXDOG_ROOT = root;
  const rootFiles = { ...ORCHESTRATION, ...world.root };
  lay(root, rootFiles);
  lay(data, world.data);
  const helpers = createWorkflowHelpers({ rootDir: root, dataDir: () => data, readMarkdownDocument, normalizeAgentPermissionOrNone });
  const parts = [];
  for (const variant of VARIANTS) {
    for (const mode of variant.modes) {
      const config = { ...world.config, orchestrationMode: mode };
      const { leadPromptParts } = helpers.activeWorkflowContext(config, data);
      parts.push({ mode, options: variant.options ?? null, parts: leadPromptParts(variant.options) });
    }
  }
  const { leadPromptParts } = helpers.activeWorkflowContext({ ...world.config, orchestrationMode: 'balanced' }, data);
  recorded.push({
    name: world.name,
    root: rootFiles,
    data: world.data,
    config: world.config,
    delegatable: helpers.delegatableAgentIds(world.config, data),
    parts,
    sessions: SESSIONS.map((session) => ({ session, parts: leadPartsFor(session, leadPromptParts) })),
  });
}
rmSync(sandbox, { recursive: true, force: true });
writeJson(join(FIXTURES_ROOT, 'workflow-surface', 'lead-parts.json'), { worlds: recorded });
console.log(`recorded ${recorded.length} worlds`);
