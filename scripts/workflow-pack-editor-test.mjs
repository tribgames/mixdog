// Workflow/agent editor contracts that the desktop Workflows page depends on:
// user-authored roles must reach the SPAWNED agent (not just Lead), agents are
// GLOBAL (no per-pack rosters), and a `delegation: none` pack stays
// delegation-free across a round trip (legacy empty `agents:` maps the same).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-workflow-editor-'));
const require = createRequire(import.meta.url);
const { buildLeadRoleContent } = require('../src/lib/rules-builder.cjs');
// Both roots are env-resolved at call time; point the data dir at a scratch
// tree so the test never reads or writes the real ~/.mixdog install.
process.env.MIXDOG_ROOT = SRC_ROOT;
process.env.MIXDOG_DATA_DIR = DATA_DIR;

const { loadScopedRoleInstructions } = await import('../src/runtime/agent/orchestrator/context/collect.mjs');
const { createWorkflowHelpers } = await import('../src/session-runtime/workflow.mjs');
const { createWorkflowAgentsApi } = await import('../src/session-runtime/workflow-agents-api.mjs');
const { agentDefinitionExists } = await import('../src/standalone/agent-tool/helpers.mjs');
const { readMarkdownDocument, normalizeAgentPermissionOrNone, serializeFrontmatterDoc } =
  await import('../src/runtime/shared/markdown-frontmatter.mjs');

const helpers = createWorkflowHelpers({
  rootDir: SRC_ROOT,
  dataDir: DATA_DIR,
  readMarkdownDocument,
  normalizeAgentPermissionOrNone,
});

function writeUserAgent(id, name, body) {
  const dir = join(DATA_DIR, 'agents', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENT.md'), serializeFrontmatterDoc({ name }, body));
}

function writeUserWorkflow(id, meta, body) {
  const dir = join(DATA_DIR, 'workflows', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'WORKFLOW.md'), serializeFrontmatterDoc({ id, ...meta }, body));
}

function deletionApi(config = {}) {
  let currentConfig = config;
  return createWorkflowAgentsApi({
    getConfig: () => currentConfig,
    cfgMod: { getPluginData: () => DATA_DIR },
    STANDALONE_DATA_DIR: DATA_DIR,
    listWorkflowPacks: helpers.listWorkflowPacks,
    loadAgentDefinition: helpers.loadAgentDefinition,
    agentRouteFromConfig: () => null,
    saveConfigAndAdopt: (next) => { currentConfig = next; },
  });
}

test.after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

test('a data-dir custom agent reaches the spawned role catalog', () => {
  writeUserAgent('zz-release-scribe', 'ZZ Release Scribe', 'ZZ_CUSTOM_ROLE_MARKER — release notes only.');
  const text = loadScopedRoleInstructions('zz-release-scribe');
  assert.match(text, /ZZ_CUSTOM_ROLE_MARKER/);
  assert.match(text, /^## zz-release-scribe$/m);
});

test('a data-dir override replaces the built-in role body exactly once', () => {
  writeUserAgent('worker', 'Worker', 'ZZ_OVERRIDDEN_WORKER_MARKER — edited contract.');
  const text = loadScopedRoleInstructions('worker');
  assert.match(text, /ZZ_OVERRIDDEN_WORKER_MARKER/);
  assert.equal(text.match(/^## worker$/gm)?.length, 1);
});

test('shipped starter roles without an override still load their contract', () => {
  const text = loadScopedRoleInstructions('reviewer');
  assert.match(text, /^## reviewer$/m);
  assert.doesNotMatch(text, /ZZ_OVERRIDDEN_WORKER_MARKER/);
});

test('legacy empty agents frontmatter maps to delegation none', () => {
  writeUserWorkflow('zz-solo-like', { name: 'ZZ Solo Like', agents: '' }, '# ZZ Solo\n\nLead handles everything.');
  const pack = helpers.loadWorkflowPack(DATA_DIR, 'zz-solo-like');
  assert.equal(pack.delegatesAgents, false);
  const block = helpers.workflowContextBlock({ workflow: { active: 'zz-solo-like' } }, DATA_DIR);
  assert.doesNotMatch(block, /# Available Agents/);
});

test('delegation none keeps a workflow delegation-free', () => {
  writeUserWorkflow('zz-solo-flag', { name: 'ZZ Solo Flag', delegation: 'none' }, '# ZZ Solo Flag\n\nLead handles everything.');
  const pack = helpers.loadWorkflowPack(DATA_DIR, 'zz-solo-flag');
  assert.equal(pack.delegatesAgents, false);
  const block = helpers.workflowContextBlock({ workflow: { active: 'zz-solo-flag' } }, DATA_DIR);
  assert.doesNotMatch(block, /# Available Agents/);
});

test('lead brief surface follows delegation capability, not workflow id', () => {
  const delegating = buildLeadRoleContent({
    PLUGIN_ROOT: SRC_ROOT,
    DATA_DIR,
    includeLeadBrief: true,
  });
  const delegationFree = buildLeadRoleContent({
    PLUGIN_ROOT: SRC_ROOT,
    DATA_DIR,
    includeLeadBrief: false,
  });
  assert.match(delegating, /# Lead Brief/);
  assert.doesNotMatch(delegationFree, /# Lead Brief/);
  assert.match(delegationFree, /# General/);
});

test('hidden solo-bench loads explicitly without exposing an approval gate', () => {
  const pack = helpers.loadWorkflowPack(DATA_DIR, 'solo-bench');
  assert.equal(pack.id, 'solo-bench');
  assert.equal(pack.hidden, true);
  assert.equal(pack.delegatesAgents, false);
  assert.ok(!helpers.listWorkflowPacks(DATA_DIR).some((item) => item.id === 'solo-bench'));
  assert.doesNotMatch(pack.body, /consult the user and build the plan|approves? the latest plan|read-only investigation|on approval|approved plan/i);
  assert.match(pack.body, /lead executes all work itself — never spawn, send, or delegate to agents/i);
  assert.match(pack.body, /complete in-scope fixes without reapproval/i);
  assert.match(pack.body, /build, deploy, commit, and push happen only on an explicit\s+user request/i);
  assert.match(pack.body, /on direction change, pause and re-consult the user/i);
});

test('a delegating pack lists every active starter and custom agent', () => {
  writeUserWorkflow('zz-fanout', { name: 'ZZ Fanout' }, '# ZZ Fanout\n\nDelegate broadly.');
  const pack = helpers.loadWorkflowPack(DATA_DIR, 'zz-fanout');
  assert.equal(pack.delegatesAgents, true);
  const block = helpers.workflowContextBlock({ workflow: { active: 'zz-fanout' } }, DATA_DIR);
  assert.match(block, /# Available Agents/);
  assert.match(block, /\(worker\)/);
  assert.match(block, /\(zz-release-scribe\)/);
  // Slot-backed built-ins stay out of the catalog.
  assert.doesNotMatch(block, /\(explore\)|\(maintainer\)/);
});

test('starter agents are custom while fixed services stay protected', () => {
  const ids = helpers.listCustomAgentIds(DATA_DIR);
  assert.ok(ids.includes('zz-release-scribe'));
  assert.ok(ids.includes('worker'));
  assert.ok(ids.includes('heavy-worker'));
  assert.ok(ids.includes('reviewer'));
  assert.ok(!ids.includes('explore'));
  assert.ok(!ids.includes('maintainer'));
});

test('deleting a custom agent removes it from every surface at once', async () => {
  writeUserAgent('zz-used-agent', 'ZZ Used Agent', 'ZZ_USED_AGENT_MARKER');
  writeUserWorkflow('zz-uses-agent', {
    name: 'ZZ Uses Agent',
    agents: 'zz-used-agent',
  }, '# ZZ Uses Agent\n\nDelegate to the custom role.');
  const before = helpers.workflowContextBlock({ workflow: { active: 'zz-fanout' } }, DATA_DIR);
  assert.match(before, /\(zz-used-agent\)/);
  const result = await deletionApi().deleteAgentDefinition('zz-used-agent');
  assert.equal(result.deleted, true);
  assert.equal(existsSync(join(DATA_DIR, 'agents', 'zz-used-agent', 'AGENT.md')), false);
  const after = helpers.workflowContextBlock({ workflow: { active: 'zz-fanout' } }, DATA_DIR);
  assert.doesNotMatch(after, /\(zz-used-agent\)/);
});

test('deleting a shipped starter persists until the agent is recreated', async () => {
  const api = deletionApi({ agents: { worker: { provider: 'test', model: 'starter' } } });
  const result = await api.deleteAgentDefinition('worker');
  assert.equal(result.deleted, true);
  assert.equal(result.revertedToBuiltIn, false);
  assert.equal(existsSync(join(DATA_DIR, 'agents', 'worker', '.deleted')), true);
  assert.equal(helpers.listCustomAgentIds(DATA_DIR).includes('worker'), false);
  assert.equal(helpers.loadAgentDefinition(DATA_DIR, 'worker'), null);
  assert.equal(agentDefinitionExists('worker', DATA_DIR, SRC_ROOT), false);

  const restored = await api.saveAgentDefinition({
    id: 'worker',
    name: 'Worker',
    description: 'Restored starter',
    body: '# Worker\n\nRestored starter role.',
  });
  assert.equal(restored.custom, true);
  assert.equal(existsSync(join(DATA_DIR, 'agents', 'worker', '.deleted')), false);
  assert.equal(helpers.listCustomAgentIds(DATA_DIR).includes('worker'), true);
  assert.equal(agentDefinitionExists('worker', DATA_DIR, SRC_ROOT), true);
});
