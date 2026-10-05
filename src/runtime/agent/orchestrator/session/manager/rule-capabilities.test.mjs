import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('headless session creation does not mention unregistered Skill or Goal tools', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-rule-capabilities-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
  const { createSession } = await import('./session-lifecycle.mjs');
  const { deleteSession } = await import('../store.mjs');
  const { _withRegisteredProviderForTest } = await import('../../providers/registry.mjs');
  const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
  let session;
  t.after(() => {
    if (session) assert.equal(deleteSession(session.id, { deferSummaryUpdate: true }), true);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });
  session = _withRegisteredProviderForTest(
    'rule-capabilities-test',
    {
      name: 'rule-capabilities-test',
      contextWindow: 128000,
    },
    () =>
      createSession({
        provider: 'rule-capabilities-test',
        model: 'gpt-5.6-sol',
        cwd: root,
        skipSkills: true,
        schemaAllowedTools: modelToolSchemaAllowlist('headless'),
        workflow: { id: 'headless', delegatesAgents: false },
      })
  );
  const prompt = session.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');
  assert.match(prompt, /`read`/);
  assert.doesNotMatch(prompt, /\bSkills?\b|\bGoals?\b|`goal`|goal-management/);
  assert.equal(
    session.tools.some((tool) => ['Skill', 'goal'].includes(tool.name)),
    false
  );
});

test('a hidden role keeps the schema profile it declares; a worker ignores a caller allowlist', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-rule-capabilities-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
  const { createSession } = await import('./session-lifecycle.mjs');
  const { deleteSession } = await import('../store.mjs');
  const { _withRegisteredProviderForTest } = await import('../../providers/registry.mjs');
  const { preDispatchDenyForSession } = await import('../loop/pre-dispatch-deny.mjs');
  const sessions = [];
  t.after(() => {
    for (const session of sessions) assert.equal(deleteSession(session.id, { deferSummaryUpdate: true }), true);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });
  const create = (opts) => {
    const session = _withRegisteredProviderForTest(
      'rule-capabilities-test',
      { name: 'rule-capabilities-test', contextWindow: 128000 },
      () => createSession({ provider: 'rule-capabilities-test', model: 'gpt-5.6-sol', owner: 'agent', ...opts })
    );
    sessions.push(session);
    return session;
  };
  const systemText = (session) =>
    session.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
  const toolNames = (session) => session.tools.map((tool) => tool.name);

  // cycle1-agent declares toolSchemaProfile "none": the provider is sent no
  // tool schema, and the prompt carries its role rules without the tool
  // policy, the worker conduct rules or a skill manifest.
  const cycle = create({ agent: 'cycle1-agent', schemaAllowedTools: [] });
  assert.deepEqual(toolNames(cycle), []);
  assert.match(systemText(cycle), /# Role: cycle1-agent/);
  assert.doesNotMatch(systemText(cycle), /available-skills|# Tool Workflow|# Agent\n|`read`|`shell`/);
  // The schema now agrees with the dispatch gate, which already refused them.
  assert.match(preDispatchDenyForSession(cycle, { name: 'read', arguments: {} }), /schema allowlist/);

  // A public agent shares the one Agent schema whatever its caller allowed,
  // and keeps the tool policy that goes with it.
  const worker = create({ agent: 'worker', schemaAllowedTools: ['read'] });
  const plain = create({ agent: 'worker' });
  assert.deepEqual(toolNames(worker), toolNames(plain));
  assert.ok(toolNames(worker).includes('shell') && toolNames(worker).includes('Skill'));
  assert.match(systemText(worker), /# Tool Workflow/);
});
