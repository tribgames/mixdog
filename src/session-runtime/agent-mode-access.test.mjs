// Agent mode's access rules: every agent-mode Lead hands work to a contact
// agent (never itself, never one already in its chain), and only Mixy (or the
// user's own UI) creates, edits or deletes agents.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// A private data dir: the representative's display name reads agents/lead/.
const dataRoot = mkdtempSync(join(tmpdir(), 'mixdog-agent-access-'));
const savedDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
test.after(() => {
  if (savedDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = savedDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});
const leadDir = join(dataRoot, 'agents', 'lead');
const rename = (name) => {
  mkdirSync(leadDir, { recursive: true });
  writeFileSync(join(leadDir, 'agent.json'), `${JSON.stringify({ name, created: true })}\n`);
};

const { createSpawnPlanner } = await import('./services/agent-tool/spawn-flow/spawn-plan.mjs');
const { createSetupToolExecutor } = await import('./setup-tool/executor.mjs');
const { SETUP_EXTENDED_PROPERTIES } = await import('./setup-tool/settings-contract.mjs');
const { TOOL_DEFS: MEMORY_TOOL_DEFS } = await import('../runtime/memory/tool-defs.mjs');
const { mixyDisplayName } = await import('../runtime/agent/orchestrator/session/mixy-name.mjs');

const SESSIONS = new Map(
  [
    { id: 'sess_home_lead' },
    { id: 'sess_home_sample', agent: 'sample' },
    { id: 'sess_task', owner: 'user', sourceType: 'lead', agent: 'lead' },
    // Bot "sample" handed work to bot "other": a delegated worker under sample's chat.
    {
      id: 'sess_worker_other',
      owner: 'agent',
      visibility: 'agent-only',
      agent: 'other',
      parentSessionId: 'sess_home_sample',
    },
    { id: 'sess_run', owner: 'user', sourceType: 'schedule', ownerAgentId: 'sample', agent: 'sample' },
  ].map((session) => [session.id, session])
);

function contactSpawner(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-contact-spawn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', 'worker.md'), '---\ndescription: worker\n---\nWork.\n');
  writeFileSync(join(root, 'agents', 'other.md'), '---\ndescription: a contact\nkind: bot\n---\nPlan trips.\n');
  writeFileSync(join(root, 'agents', 'sample.md'), '---\ndescription: a contact\nkind: bot\n---\nRead news.\n');
  // Made on the Workflows page: a sub-agent every Lead may delegate to.
  writeFileSync(join(root, 'agents', 'triage.md'), '---\ndescription: sorts issues\nkind: agent\n---\nSort.\n');
  // Made before bots existed: no marker, a sub-agent as in v1.2.6.
  writeFileSync(join(root, 'agents', 'legacy.md'), '---\ndescription: an old role\n---\nHelp.\n');
  const { resolveSpawnPlan } = createSpawnPlanner({
    mgr: { getSession: (id) => SESSIONS.get(id) || null },
    cfgMod: { loadConfig: () => ({}) },
    dataDir: join(root, 'data'),
    STANDALONE_SOURCE_ROOT: root,
    defaultCwd: root,
    nextTag: () => 'tag1',
    resolveTag: () => null,
    wantsSessionScan: () => false,
  });
  return (agent, callerSessionId) =>
    resolveSpawnPlan({ agent, provider: 'p', model: 'm', prompt: 'do it' }, root, { callerSessionId });
}

test('every agent-mode Lead delegates to a contact agent and to the sub-agents', async (t) => {
  const spawn = contactSpawner(t);
  for (const caller of ['sess_home_sample', 'sess_run']) {
    assert.equal((await spawn('other', caller)).agent, 'other', 'a bot hands work to another bot');
    assert.equal((await spawn('worker', caller)).agent, 'worker');
    assert.equal((await spawn('triage', caller)).agent, 'triage', 'a kind: agent role is no contact');
    assert.equal((await spawn('legacy', caller)).agent, 'legacy', 'an unmarked role is no contact');
  }
  for (const caller of ['sess_home_lead', 'sess_task']) assert.equal((await spawn('other', caller)).agent, 'other');
});

test('a bot cannot hand work to itself', async (t) => {
  const spawn = contactSpawner(t);
  await assert.rejects(spawn('sample', 'sess_home_sample'), /contact agent "sample" cannot hand work to itself/);
  await assert.rejects(spawn('sample', 'sess_run'), /cannot hand work to itself/);
  assert.equal((await spawn('worker', 'sess_home_sample')).agent, 'worker', 'sub-agents are unaffected');
});

test('a delegation chain cannot revisit a bot already in it (A → B → A)', async (t) => {
  const spawn = contactSpawner(t);
  await assert.rejects(
    spawn('sample', 'sess_worker_other'),
    /contact agent "sample" is already in this delegation chain \(sample → other → sample\)/
  );
  assert.equal((await spawn('worker', 'sess_worker_other')).agent, 'worker');
  assert.equal((await spawn('other', 'sess_home_sample')).agent, 'other', 'A → B itself is allowed');
});

function editorExecutor() {
  const defined = [];
  const routes = [];
  const rt = {
    listAgents: async () => [{ id: 'sample' }],
    saveAgentDefinition: async (definition) => {
      defined.push(definition);
      return definition;
    },
    getAgentDefinition: async (id) => ({ id, name: id, description: '', body: 'Body' }),
    deleteAgentDefinition: async (id) => ({ deleted: id }),
    setAgentRoute: async (agent, route) => {
      routes.push([agent, route]);
      return route;
    },
  };
  const executor = createSetupToolExecutor({
    getApi: () => rt,
    getSessionId: () => 'sess_home_lead',
    getCallerSession: (id) => SESSIONS.get(id) || null,
  });
  return { executor, defined, routes };
}
const create = {
  action: 'create_definition',
  definitionKind: 'agent',
  definition: { id: 'helper', name: 'Helper', body: 'Help.' },
};

test('only Mixy creates, edits or deletes agents from a chat; other agents set only their own route', async () => {
  const { executor, defined, routes } = editorExecutor();
  const save = { action: 'save_definition', definitionKind: 'agent', definition: { id: 'sample', body: 'New body' } };
  const remove = { action: 'delete_definition', definitionKind: 'agent', name: 'sample' };
  for (const args of [create, save, remove]) {
    await assert.rejects(
      executor.execute(args, { callerSessionId: 'sess_home_sample' }),
      /Only Mixy \(the representative agent\) can create, edit or delete agents/,
      args.action
    );
  }
  await assert.rejects(executor.execute(create, { callerSessionId: 'sess_run' }), /background run/);
  await executor.execute(create, { callerSessionId: 'sess_home_lead' });
  await executor.execute(create, { callerSessionId: 'sess_task' });
  assert.deepEqual(
    defined.map((definition) => definition.id),
    ['helper', 'helper']
  );
  // Every creation writes an explicit marker: Mixy's chat makes a bot, a
  // coding Lead a workflow agent; an explicit kind wins.
  assert.deepEqual(
    defined.map((definition) => definition.kind),
    ['bot', 'agent']
  );
  await executor.execute(
    { ...create, definition: { ...create.definition, kind: 'agent' } },
    { callerSessionId: 'sess_home_lead' }
  );
  assert.equal(defined.at(-1).kind, 'agent');
  // An edit never carries the stored kind back into the save.
  await executor.execute(
    { action: 'save_definition', definitionKind: 'agent', definition: { id: 'sample', body: 'New' } },
    { callerSessionId: 'sess_home_lead' }
  );
  assert.equal('kind' in defined.at(-1), false);
  const route = (agent) => ({ action: 'set_agent_route', agent, route: { provider: 'openai', model: 'gpt-5' } });
  await assert.rejects(
    executor.execute(route('other'), { callerSessionId: 'sess_home_sample' }),
    /manages only its own agent's settings/
  );
  await executor.execute(route('sample'), { callerSessionId: 'sess_home_sample' });
  await executor.execute(route('other'), { callerSessionId: 'sess_home_lead' });
  assert.deepEqual(
    routes.map(([agent]) => agent),
    ['sample', 'other']
  );
});

test('renamed to Momo, no model-facing string names Mixy', async (t) => {
  t.after(() => rmSync(leadDir, { recursive: true, force: true }));
  rename('Momo');
  assert.equal(mixyDisplayName(), 'Momo');
  const said = [];
  const spawnError = await contactSpawner(t)('sample', 'sess_home_sample').catch((error) => error.message);
  said.push(spawnError);
  assert.match(spawnError, /cannot hand work to itself/);
  const editorError = await editorExecutor()
    .executor.execute(create, { callerSessionId: 'sess_home_sample' })
    .catch((error) => error.message);
  said.push(editorError);
  assert.match(editorError, /Only Momo \(the representative agent\).*with Momo or in the Agents settings/);
  // Shared text (tool schemas, rule files) never carries the name at all.
  said.push(JSON.stringify(SETUP_EXTENDED_PROPERTIES), JSON.stringify(MEMORY_TOOL_DEFS));
  const rulesDir = join(process.cwd(), 'src', 'rules');
  for (const entry of readdirSync(rulesDir, { recursive: true })) {
    if (String(entry).endsWith('.md')) said.push(readFileSync(join(rulesDir, String(entry)), 'utf8'));
  }
  for (const text of said) assert.doesNotMatch(text, /Mixy/);
  // A blank name falls back to Mixy.
  rename('  ');
  assert.equal(mixyDisplayName(), 'Mixy');
});
