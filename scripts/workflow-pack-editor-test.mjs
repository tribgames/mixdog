// Workflow/agent editor contracts that the desktop Workflows page depends on:
// user-authored roles must reach the SPAWNED agent (not just Lead), and an
// explicit empty `agents:` list must stay delegation-free across a round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-workflow-editor-'));
// Both roots are env-resolved at call time; point the data dir at a scratch
// tree so the test never reads or writes the real ~/.mixdog install.
process.env.MIXDOG_ROOT = SRC_ROOT;
process.env.MIXDOG_DATA_DIR = DATA_DIR;

const { loadScopedRoleInstructions } = await import('../src/runtime/agent/orchestrator/context/collect.mjs');
const { createWorkflowHelpers } = await import('../src/session-runtime/workflow.mjs');
const { createWorkflowAgentsApi } = await import('../src/session-runtime/workflow-agents-api.mjs');
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

test('built-in roles without an override still load their shipped contract', () => {
  const text = loadScopedRoleInstructions('reviewer');
  assert.match(text, /^## reviewer$/m);
  assert.doesNotMatch(text, /ZZ_OVERRIDDEN_WORKER_MARKER/);
});

test('an explicit empty agents list keeps a workflow delegation-free', () => {
  writeUserWorkflow('zz-solo-like', { name: 'ZZ Solo Like', agents: '' }, '# ZZ Solo\n\nLead handles everything.');
  const pack = helpers.loadWorkflowPack(DATA_DIR, 'zz-solo-like');
  assert.equal(pack.agentsConfigured, true);
  assert.deepEqual(pack.agents, []);
  const block = helpers.workflowContextBlock({ workflow: { active: 'zz-solo-like' } }, DATA_DIR);
  assert.doesNotMatch(block, /# Available Agents/);
});

test('hidden solo-bench loads explicitly without exposing an approval gate', () => {
  const pack = helpers.loadWorkflowPack(DATA_DIR, 'solo-bench');
  assert.equal(pack.id, 'solo-bench');
  assert.equal(pack.hidden, true);
  assert.equal(pack.agentsConfigured, true);
  assert.deepEqual(pack.agents, []);
  assert.ok(!helpers.listWorkflowPacks(DATA_DIR).some((item) => item.id === 'solo-bench'));
  assert.doesNotMatch(pack.body, /consult the user and build the plan|approves? the latest plan|read-only investigation|on approval|approved plan/i);
  assert.match(pack.body, /lead executes all work itself — never spawn, send, or delegate to agents/i);
  assert.match(pack.body, /complete in-scope fixes without reapproval/i);
  assert.match(pack.body, /build, deploy, commit, and push happen only on an explicit\s+user request/i);
  assert.match(pack.body, /on direction change, pause and re-consult the user/i);
});

test('omitting the agents key keeps every default agent available', () => {
  writeUserWorkflow('zz-fanout', { name: 'ZZ Fanout' }, '# ZZ Fanout\n\nDelegate broadly.');
  const pack = helpers.loadWorkflowPack(DATA_DIR, 'zz-fanout');
  assert.equal(pack.agentsConfigured, false);
  const block = helpers.workflowContextBlock({ workflow: { active: 'zz-fanout' } }, DATA_DIR);
  assert.match(block, /# Available Agents/);
});

test('custom agent ids are discovered without shadowing the fixed roles', () => {
  const ids = helpers.listCustomAgentIds(DATA_DIR);
  assert.ok(ids.includes('zz-release-scribe'));
  assert.ok(!ids.includes('worker'));
});

// Hidden roles ship agents/<id>/AGENT.md exactly like user roles, so the
// data source must drop them or every listing surface (TUI /agents included)
// exposes internal roles and lets a user re-route them.
test('internal hidden roles never surface as custom agents', () => {
  const ids = helpers.listCustomAgentIds(DATA_DIR);
  assert.ok(!ids.includes('scheduler-task'));
  assert.ok(!ids.includes('webhook-handler'));
});

test('a pack naming a hidden role keeps it out of the agent catalog', () => {
  writeUserWorkflow('zz-hidden-claim', { name: 'ZZ Hidden Claim', agents: 'worker, scheduler-task' },
    '# ZZ Hidden Claim\n\nDelegate to worker only.');
  const block = helpers.workflowContextBlock({ workflow: { active: 'zz-hidden-claim' } }, DATA_DIR);
  assert.match(block, /\(worker\)/);
  assert.doesNotMatch(block, /scheduler-task/);
});

test('a custom agent referenced by a workflow cannot be deleted', async () => {
  writeUserAgent('zz-used-agent', 'ZZ Used Agent', 'ZZ_USED_AGENT_MARKER');
  writeUserWorkflow('zz-uses-agent', {
    name: 'ZZ Uses Agent',
    agents: 'zz-used-agent',
  }, '# ZZ Uses Agent\n\nDelegate to the custom role.');
  await assert.rejects(
    deletionApi().deleteAgentDefinition('zz-used-agent'),
    /agent "zz-used-agent" is used by workflow: ZZ Uses Agent/,
  );
  assert.equal(existsSync(join(DATA_DIR, 'agents', 'zz-used-agent', 'AGENT.md')), true);
});
