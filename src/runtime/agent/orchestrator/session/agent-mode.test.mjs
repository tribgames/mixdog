// Agent mode vs coding mode: resolution, the coding prompt left byte-identical,
// the agent-mode BP3, an owned schedule run acting as its owner, and silent
// compaction.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-mode-'));
const dataDir = join(root, 'data');
const saved = Object.fromEntries(
  ['MIXDOG_DATA_DIR', 'MIXDOG_BOOT_INSTRUCTION_FILES', 'HOME', 'USERPROFILE'].map((key) => [key, process.env[key]])
);
Object.assign(process.env, { MIXDOG_DATA_DIR: dataDir, HOME: root, USERPROFILE: root });
delete process.env.MIXDOG_BOOT_INSTRUCTION_FILES;
const sampleDir = join(dataDir, 'agents', 'sample');
mkdirSync(sampleDir, { recursive: true });
writeFileSync(join(sampleDir, 'AGENT.md'), '---\nname: Sample\nkind: bot\n---\n# Sample\n\nSAMPLE_ROLE_BODY');
writeFileSync(
  join(sampleDir, 'agent.json'),
  JSON.stringify({
    name: 'Sample',
    description: 'reads the news for the user.',
    connectors: [{ id: 'alpha', enabled: true, tools: { read_it: 'auto', drop_it: 'disabled' } }],
  })
);
writeFileSync(join(sampleDir, 'PERSONA.md'), 'SAMPLE_PERSONA_TEXT');
// A second contact agent: its prompt shares everything up to the tail.
const otherDir = join(dataDir, 'agents', 'other');
mkdirSync(otherDir, { recursive: true });
writeFileSync(join(otherDir, 'AGENT.md'), '---\nname: Other\nkind: bot\n---\n# Other\n\nOTHER_ROLE_BODY');
writeFileSync(join(otherDir, 'agent.json'), JSON.stringify({ name: 'Other', description: 'plans trips.' }));
const leadDir = join(dataDir, 'agents', 'lead');
mkdirSync(leadDir, { recursive: true });
// Project instruction files the coding Lead picks up and agent mode must not.
writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { instructionFiles: 'all' } }));
mkdirSync(join(root, '.codex'), { recursive: true });
writeFileSync(join(root, '.codex', 'AGENTS.md'), 'INSTRUCTION_FILE_SENTINEL');
// A stable project root: its startup listing rides the environment block.
const project = join(root, 'project');
mkdirSync(project, { recursive: true });
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const { invalidateConfigReadCache } = await import('../../../shared/config.mjs');
invalidateConfigReadCache();
const { resolveSessionMode, sessionModeOf } = await import('./agent-mode.mjs');
const { composeSessionSystem } = await import('./manager/session-prompt-composition.mjs');
const { _buildLeadRules } = await import('./manager/rules-cache.mjs');
const { createWorkflowHelpers } = await import('../runtime-core/workflow.mjs');
const { readMarkdownDocument, normalizeAgentPermissionOrNone } = await import(
  '../../../shared/markdown-frontmatter.mjs'
);
const { createSession } = await import('./manager/session-lifecycle.mjs');
const { deleteSession } = await import('./store.mjs');
const { _withRegisteredProviderForTest } = await import('../providers/registry.mjs');
const { _registerMcpServerForTest, disconnectAll } = await import('../mcp/client.mjs');
const { preDispatchDenyForSession } = await import('./loop/pre-dispatch-deny.mjs');
const { injectedMemoryAgentId, memoryCallerScope } = await import(
  '../../../../session-runtime/services/memory-access.mjs'
);
const { resolveWorkerCompactPolicy } = await import('./loop/compact-policy.mjs');
const { compactionSegmentItems } = await import('./compaction-archive-capture.mjs');
const { buildAgentLoopOptions } = await import('./manager/ask-turn-loop-options.mjs');

const helpers = createWorkflowHelpers({
  rootDir: join(process.cwd(), 'src'),
  dataDir,
  readMarkdownDocument,
  normalizeAgentPermissionOrNone,
});
const config = { workflow: { active: 'default' }, orchestrationMode: 'balanced' };
const workflow = helpers.activeWorkflowContext(config, dataDir);
const LEAD_MD = readFileSync(join(process.cwd(), 'src', 'rules', 'lead', 'LEAD.md'), 'utf8');
const SEP = '\n\n---\n\n';

function compose({ agent = 'lead', sessionMode, legacy = false, sourceType } = {}) {
  const agentMode = sessionMode === 'agent';
  const leadWorkflowParts = workflow.leadPromptParts({ agentMode, agentId: agent });
  const surface = {
    ownerIsAgent: false,
    resolvedAgent: agent,
    skills: [],
    ruleOmitTools: [],
    schemaAllowedTools: null,
    agentRulesProfile: undefined,
    toolsForRouting: [],
  };
  const opts = {
    cwd: project,
    systemPrompt: '',
    workflowContext: workflow.packContext,
    leadWorkflowParts,
    coreMemoryContext: 'CORE_MEMORY_POOL',
    ...(sourceType ? { sourceType } : {}),
  };
  const route = { profile: null, providerName: 'test', modelName: 'm', surface };
  // `legacy`: the exact pre-agent-mode call shape (no sessionMode at all).
  return composeSessionSystem(opts, legacy ? route : { ...route, sessionMode });
}

test("Mixy's persona rides only Mixy's own thread: never a coding Lead; a bot keeps its own", async (t) => {
  const { agentProfileRevision } = await import('../context/role-instructions.mjs');
  const persona = join(leadDir, 'PERSONA.md');
  t.after(() => rmSync(persona, { force: true }));
  const codingBefore = JSON.stringify(compose({ sessionMode: 'coding' }));
  const codingStamp = agentProfileRevision('lead', { mixy: false });
  const mixyStamp = agentProfileRevision('lead', { mixy: true });
  writeFileSync(persona, 'MIXY_PERSONA_TEXT');
  const coding = JSON.stringify(compose({ sessionMode: 'coding' }));
  assert.doesNotMatch(coding, /MIXY_PERSONA_TEXT/, 'a coding Lead never carries Mixy');
  assert.equal(coding, codingBefore, "a coding Lead's prompt does not move when Mixy is edited");
  assert.doesNotMatch(JSON.stringify(compose({ legacy: true })), /MIXY_PERSONA_TEXT/);
  assert.match(JSON.stringify(compose({ sessionMode: 'agent' })), /MIXY_PERSONA_TEXT/, "Mixy's own thread");
  const bot = JSON.stringify(compose({ agent: 'sample', sessionMode: 'agent' }));
  assert.match(bot, /SAMPLE_PERSONA_TEXT/, 'a bot thread carries its own persona');
  assert.doesNotMatch(bot, /MIXY_PERSONA_TEXT/);
  // The coding Lead's profile stamp never follows Mixy's files (no refresh,
  // no cache break); Mixy's own thread's does.
  assert.equal(agentProfileRevision('lead', { mixy: false }), codingStamp);
  assert.notEqual(agentProfileRevision('lead', { mixy: true }), mixyStamp);
});

test('mode resolution for each session kind', () => {
  const agent = (args) => resolveSessionMode(args);
  assert.deepEqual(agent({ sessionId: 'sess_home_lead' }), { mode: 'agent', agentId: 'lead' });
  assert.deepEqual(agent({ sessionId: 'sess_home_sample', profile: { homeAgent: 'sample' } }), {
    mode: 'agent',
    agentId: 'sample',
  });
  assert.deepEqual(agent({ sessionId: 'sess_rmem_abcdef_sample', profile: { homeAgent: 'sample' } }), {
    mode: 'agent',
    agentId: 'sample',
  });
  assert.deepEqual(agent({ sessionId: 'sess_rmem_abcdef_lead' }), { mode: 'agent', agentId: 'lead' });
  assert.deepEqual(
    agent({ session: { id: 'sess_1', owner: 'user', sourceType: 'schedule', ownerAgentId: 'sample' } }),
    { mode: 'agent', agentId: 'sample' }
  );
  assert.deepEqual(agent({ session: { id: 'sess_2', owner: 'user', sourceType: 'webhook', ownerAgentId: 'lead' } }), {
    mode: 'agent',
    agentId: 'lead',
  });
  // Ordinary task sessions and new-task tabs are coding Leads acting as Mixy.
  assert.deepEqual(agent({ session: { id: 'sess_3', owner: 'cli', agent: 'lead' } }), {
    mode: 'coding',
    agentId: 'lead',
  });
  assert.deepEqual(agent({ sessionId: 'sess_4', profile: null }), { mode: 'coding', agentId: 'lead' });
  // A delegated worker (owner 'agent') is coding mode, whatever its agent.
  assert.deepEqual(agent({ session: { id: 'sess_home_sample', owner: 'agent', agent: 'sample' } }), {
    mode: 'coding',
    agentId: '',
  });
  assert.deepEqual(agent({ profile: { owner: 'agent', agent: 'sample', homeAgent: 'sample' } }), {
    mode: 'coding',
    agentId: '',
  });
  // The persisted value wins; older records resolve it.
  assert.equal(sessionModeOf({ id: 'sess_home_sample', sessionMode: 'agent' }), 'agent');
  assert.equal(sessionModeOf({ id: 'sess_home_sample' }), 'agent');
  assert.equal(sessionModeOf({ id: 'sess_5', owner: 'cli' }), 'coding');
});

// The words of a text, bullets and markers aside: LEAD.md's split keeps every one.
const words = (text) =>
  text
    .replace(/<!-- tools: agent -->/g, '')
    .split(/\s+/)
    .filter((word) => word && word !== '-')
    .sort();

test('a coding Lead prompt: the same with or without a mode, in the prefix-sharing order', () => {
  const before = compose({ legacy: true });
  const after = compose({ sessionMode: 'coding' });
  for (const key of ['baseRules', 'stableSystemContext', 'sessionMarkerCore', 'sessionEnvironment', 'sessionMarker']) {
    assert.equal(after[key], before[key], key);
  }
  const core = before.sessionMarkerCore;
  const parts = workflow.leadPromptParts({ agentMode: false });
  const instructionFiles = core.slice(core.indexOf('# Instruction Files'), core.indexOf(`${SEP}# Core Memory`));
  assert.equal(
    core,
    [
      workflow.packContext,
      _buildLeadRules(),
      parts.orchestrationContext,
      _buildLeadRules({ part: 'coding' }),
      parts.agentCatalogContext,
      '# Identity\n\nYou are Mixdog, a coding agent.',
      instructionFiles,
      '# Core Memory\nCORE_MEMORY_POOL',
    ].join(SEP)
  );
  // The full catalog and the coding orchestration mode, as before.
  assert.equal(
    `${parts.orchestrationContext}\n\n${parts.agentCatalogContext}`,
    workflow.context.slice(workflow.packContext.length + 2)
  );
  assert.match(parts.orchestrationContext, /^# Orchestration Mode: Balanced/);
  // A coding Lead lists workflow agents only: bots (sample) are Mixy's.
  assert.match(parts.agentCatalogContext, /\(worker\)/);
  assert.doesNotMatch(parts.agentCatalogContext, /\(sample\)/);
  // LEAD.md's split loses no word: common + coding passages + identity.
  assert.deepEqual(
    words(
      [
        _buildLeadRules(),
        _buildLeadRules({ part: 'coding' }).replace('# Progress and Reports', ''),
        _buildLeadRules({ part: 'identity' }),
      ].join('\n')
    ),
    words(LEAD_MD)
  );
  assert.doesNotMatch(_buildLeadRules(), /You are Mixdog|Before your first tool call|On an agent report/);
  assert.match(instructionFiles, /INSTRUCTION_FILE_SENTINEL/);
  assert.doesNotMatch(core, /# Bot Mode|# Delegation\n|# Your Role|# Bots\n/);
});

// The longest common prefix of two strings.
function sharedPrefix(left, right) {
  let at = 0;
  while (at < left.length && left[at] === right[at]) at += 1;
  return at;
}

test('BP3 prefixes: every Lead shares the pack and LEAD.md; agents share through the mode block', (t) => {
  const coding = compose({ sessionMode: 'coding' }).sessionMarkerCore;
  const sample = compose({ agent: 'sample', sessionMode: 'agent' }).sessionMarkerCore;
  const other = compose({ agent: 'other', sessionMode: 'agent' }).sessionMarkerCore;
  const mixy = compose({ agent: 'lead', sessionMode: 'agent' }).sessionMarkerCore;
  const step1 = `${workflow.packContext}${SEP}${_buildLeadRules()}${SEP}`;
  for (const core of [coding, sample, other, mixy]) assert.ok(core.startsWith(step1));
  // Through step 2 (the mode block) every agent but Mixy is byte-identical;
  // each agent's contact catalog (every bot but itself) follows it.
  const step2 = sample.slice(0, sample.indexOf('# Bots'));
  assert.equal(other.slice(0, other.indexOf('# Bots')), step2);
  assert.ok(step2.includes('# Bot Mode') && step2.includes('# Available Agents'));
  assert.ok(mixy.startsWith(step2.slice(0, -SEP.length)), 'Mixy shares it and adds its own section');
  t.diagnostic(
    `shared prefix chars: coding↔agent ${sharedPrefix(coding, sample)}, agent↔agent ${sharedPrefix(sample, other)}, agent↔Mixy ${sharedPrefix(sample, mixy)}; BP3 lengths: coding ${coding.length}, agent ${sample.length}, Mixy ${mixy.length}`
  );
});

function assertInOrder(text, markers) {
  let at = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker);
    assert.ok(next > at, `${marker} out of order`);
    at = next;
  }
}

test('agent-mode BP3: shared rules, mode block, Mixy section, per-agent tail; BP1/BP2/env unchanged', (t) => {
  const coding = compose({ agent: 'sample', legacy: true });
  const agent = compose({ agent: 'sample', sessionMode: 'agent' });
  assert.equal(agent.baseRules, coding.baseRules);
  // BP2 differs only by the Output Style section, which agent mode omits.
  assert.match(coding.stableSystemContext, /# Output Style:/);
  assert.doesNotMatch(agent.stableSystemContext, /# Output Style:/);
  assert.equal(
    agent.stableSystemContext,
    coding.stableSystemContext.replace(/\n*# Output Style: [\s\S]*?(?=\n\n---\n\n|$)/, '')
  );
  assert.equal(agent.sessionEnvironment, coding.sessionEnvironment);
  const core = agent.sessionMarkerCore;
  const parts = workflow.leadPromptParts({ agentMode: true, agentId: 'sample' });
  assert.equal(
    core,
    [
      workflow.packContext,
      _buildLeadRules(),
      parts.orchestrationContext,
      _buildLeadRules({ part: 'agent' }),
      readFileSync(join(process.cwd(), 'src', 'rules', 'agent-mode', 'AGENT_MODE.md'), 'utf8').trim(),
      parts.agentCatalogContext,
      parts.contactCatalogContext,
      '# Identity\n\nYou are Sample. Your role: reads the news for the user.',
      '# Agent Role Catalog\n\n## sample\n\n# Sample\n\nSAMPLE_ROLE_BODY',
      core.slice(core.indexOf('## Persona'), core.indexOf(`${SEP}# Core Memory`)),
      '# Core Memory\nCORE_MEMORY_POOL',
    ].join(SEP)
  );
  assert.match(parts.orchestrationContext, /^# Delegation\n\nHandle conversation yourself\./);
  assert.match(
    _buildLeadRules({ part: 'agent' }),
    /- Just answer conversation\.[\s\S]*- Relay agent reports faithfully\./
  );
  // Sub-agent catalog: no contact. Contact catalog: the other bots, never itself.
  assert.match(parts.agentCatalogContext, /\(worker\)/);
  assert.doesNotMatch(parts.agentCatalogContext, /\(sample\)|\(other\)/);
  assert.match(parts.contactCatalogContext, /^# Bots\n[\s\S]*- Other \(other\): plans trips\./);
  assert.doesNotMatch(parts.contactCatalogContext, /\(sample\)/);
  assert.doesNotMatch(core, /You are Mixdog|# Orchestration Mode|INSTRUCTION_FILE_SENTINEL|# Instruction Files/);
  assert.doesNotMatch(core, /# Your Role|setup APIs|# Routine Run/);

  const mixy = compose({ agent: 'lead', sessionMode: 'agent' }).sessionMarkerCore;
  const mixyParts = workflow.leadPromptParts({ agentMode: true, agentId: 'lead' });
  assert.equal(mixyParts.agentCatalogContext, parts.agentCatalogContext);
  assertInOrder(mixy, [
    '# Bot Mode',
    '# Available Agents',
    "# Your Role\n\n- You are the user's personal assistant,",
    "You coordinate the user's bots and agents",
    "# Bots\n\nThe user's other bots. Hand one a request with `session send`",
    '- Other (other): plans trips.\n- Sample (sample): reads the news for the user.',
    "# Identity\n\nYou are Mixy, the user's assistant in Mixdog.",
    '# Core Memory',
  ]);
  t.diagnostic(`--- sample agent BP3 ---\n${core}\n--- Mixy BP3 ---\n${mixy}`);
});

test('a kind: agent or unmarked (pre-bot) agent is a sub-agent, never a contact; a kind: bot agent is one', (t) => {
  const write = (id, frontmatter) => {
    const dir = join(dataDir, 'agents', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'AGENT.md'), `---\nname: ${id}\n${frontmatter}---\n# ${id}\n\nROLE_BODY`);
    writeFileSync(join(dir, 'agent.json'), JSON.stringify({ name: id, description: `${id} drafts replies.` }));
    return dir;
  };
  const dirs = [write('helper', 'kind: agent\n'), write('legacy', '')];
  t.after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    helpers.listCustomAgentIds(dataDir);
  });
  helpers.listCustomAgentIds(dataDir);
  const context = helpers.activeWorkflowContext(config, dataDir);
  for (const agentId of ['sample', 'lead']) {
    const parts = context.leadPromptParts({ agentMode: true, agentId });
    assert.match(parts.agentCatalogContext, /- helper \(helper\): helper drafts replies\./);
    assert.match(parts.agentCatalogContext, /- legacy \(legacy\): legacy drafts replies\./);
    assert.doesNotMatch(parts.agentCatalogContext, /\(sample\)|\(other\)/);
    assert.doesNotMatch(parts.contactCatalogContext, /\(helper\)|\(legacy\)/);
  }
  const mixyParts = context.leadPromptParts({ agentMode: true, agentId: 'lead' });
  assert.match(mixyParts.contactCatalogContext, /\(other\)[\s\S]*\(sample\)/);
  // A bot sees the other contacts but not itself.
  const botParts = context.leadPromptParts({ agentMode: true, agentId: 'other' });
  assert.match(botParts.contactCatalogContext, /\(sample\)/);
  assert.doesNotMatch(botParts.contactCatalogContext, /\(other\)/);
  // The coding catalog lists it with every other delegatable agent.
  assert.match(context.leadPromptParts({ agentMode: false }).agentCatalogContext, /\(helper\)/);
});

test("Mixy's AGENT.md rides its agent-mode tail only; empty means none", (t) => {
  t.after(() => rmSync(join(leadDir, 'AGENT.md'), { force: true }));
  writeFileSync(join(leadDir, 'AGENT.md'), '  \n');
  const empty = compose({ agent: 'lead', sessionMode: 'agent' }).sessionMarkerCore;
  assert.doesNotMatch(empty, /# Agent Role Catalog/);
  writeFileSync(join(leadDir, 'AGENT.md'), 'MIXY_WORKING_STYLE\n');
  const mixy = compose({ agent: 'lead', sessionMode: 'agent' }).sessionMarkerCore;
  assertInOrder(mixy, [
    '# Your Role',
    "# Identity\n\nYou are Mixy, the user's assistant in Mixdog.",
    `${SEP}# Agent Role Catalog\n\n## lead\n\nMIXY_WORKING_STYLE${SEP}`,
    '# Core Memory',
  ]);
  // A coding Lead acting as Mixy, and every other agent, never carry it.
  assert.doesNotMatch(compose({ sessionMode: 'coding' }).sessionMarkerCore, /MIXY_WORKING_STYLE/);
  assert.doesNotMatch(compose({ agent: 'sample', sessionMode: 'agent' }).sessionMarkerCore, /MIXY_WORKING_STYLE/);
  // Mixy's folder never becomes an agent.
  assert.doesNotMatch(helpers.activeWorkflowContext(config, dataDir).context, /\(lead\)/);
});

test('a renamed Mixy speaks under its display name; its id stays lead', (t) => {
  const before = compose({ agent: 'lead', sessionMode: 'agent' }).sessionMarkerCore;
  const sampleBefore = compose({ agent: 'sample', sessionMode: 'agent', sourceType: 'schedule' }).sessionMarkerCore;
  t.after(() => rmSync(join(leadDir, 'agent.json'), { force: true }));
  writeFileSync(join(leadDir, 'agent.json'), '{ "name": " Momo ", "created": true }\n');
  const renamed = compose({ agent: 'lead', sessionMode: 'agent' }).sessionMarkerCore;
  assert.match(renamed, /# Identity\n\nYou are Momo, the user's assistant in Mixdog\./);
  assert.doesNotMatch(renamed, /Mixy/);
  // Another agent's prompt never names the representative: a rename leaves
  // its bytes (shared block included) untouched.
  const sampleAfter = compose({ agent: 'sample', sessionMode: 'agent', sourceType: 'schedule' }).sessionMarkerCore;
  assert.equal(sampleAfter, sampleBefore);
  assert.doesNotMatch(sampleAfter, /Mixy|Momo/);
  // Only the identity tail changes: everything before it is shared.
  const head = (core) => core.slice(0, core.indexOf('# Identity'));
  assert.equal(head(renamed), head(before));
  // An empty name falls back to Mixy.
  writeFileSync(join(leadDir, 'agent.json'), '{ "name": "  " }\n');
  assert.match(
    compose({ agent: 'lead', sessionMode: 'agent' }).sessionMarkerCore,
    /You are Mixy, the user's assistant in Mixdog\./
  );
});

test("a routine source leaves the bot's prompt as it is: its conduct rides the turn header", () => {
  const run = compose({ agent: 'sample', sessionMode: 'agent', sourceType: 'schedule' }).sessionMarkerCore;
  assert.equal(run, compose({ agent: 'sample', sessionMode: 'agent' }).sessionMarkerCore);
  assert.doesNotMatch(run, /# Routine Run/);
});

test('a schedule run acts as its owner: persona, connectors and memory', (t) => {
  const scopeId = `agent-mode-${Math.random().toString(36).slice(2)}`;
  _registerMcpServerForTest(scopeId, 'alpha', [{ name: 'read_it' }, { name: 'drop_it' }], {
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });
  t.after(() => disconnectAll({ scopeId }));
  const session = _withRegisteredProviderForTest(
    'agent-mode-test',
    { name: 'agent-mode-test', contextWindow: 128000 },
    () =>
      createSession({
        provider: 'agent-mode-test',
        model: 'fixture-model',
        owner: 'user',
        sourceType: 'schedule',
        sourceName: 'daily',
        ownerAgentId: 'sample',
        mcpScopeId: scopeId,
        coreMemoryContext: 'SAMPLE_MEMORY_POOL',
        cwd: root,
      })
  );
  t.after(() => deleteSession(session.id, { deferSummaryUpdate: true }));
  assert.equal(session.sessionMode, 'agent');
  assert.equal(session.agent, 'sample');
  assertInOrder(session.bp3CoreContext, [
    '# Bot Mode',
    'You are Sample. Your role: reads the news for the user.',
    'SAMPLE_ROLE_BODY',
    'SAMPLE_PERSONA_TEXT',
    'SAMPLE_MEMORY_POOL',
  ]);
  // Connectors: listed like any session (shared BP2), refused at dispatch.
  assert.match(
    String(preDispatchDenyForSession(session, { name: 'mcp__alpha__drop_it', arguments: {} })),
    /not available to this agent/
  );
  assert.equal(preDispatchDenyForSession(session, { name: 'mcp__alpha__read_it', arguments: {} }), null);
  assert.equal(injectedMemoryAgentId({ session }), 'sample');
  assert.deepEqual(memoryCallerScope(session), { kind: 'headless', agentId: 'sample' });
});

test('agent-mode compaction runs on its own and emits no user-facing notice', () => {
  const base = { contextWindow: 128000, compaction: { auto: false } };
  assert.deepEqual(resolveWorkerCompactPolicy({ ...base, id: 'sess_task' }, []), { auto: false });
  assert.equal(resolveWorkerCompactPolicy({ ...base, id: 'sess_home_sample' }, []).auto, true);
  assert.equal(resolveWorkerCompactPolicy({ ...base, id: 'sess_x', sessionMode: 'agent' }, []).auto, true);

  const messages = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'old answer' },
  ];
  const divider = (items) => items.some((item) => item.kind === 'statusdone' && item.status === 'compacted');
  assert.equal(divider(compactionSegmentItems(messages, { sessionId: 'sess_task', seq: 1, at: 1 })), true);
  assert.equal(
    divider(compactionSegmentItems(messages, { sessionId: 'sess_home_sample', seq: 1, at: 1, divider: false })),
    false
  );

  const relayed = (session) => {
    const events = [];
    const options = buildAgentLoopOptions({
      sessionId: session.id,
      session,
      outgoing: [],
      turn: { pendingEntries: [] },
      askOpts: { onCompactEvent: (event) => events.push(event) },
      interruption: {},
      checkpoint: { refreshContextState() {}, schedule() {} },
      signal: new AbortController().signal,
    });
    options.onCompactEvent({ status: 'compacted' });
    options.onCompactEvent({ status: 'failed' });
    return events.length;
  };
  assert.equal(relayed({ id: 'sess_task', owner: 'cli', sessionMode: 'coding' }), 2);
  assert.equal(relayed({ id: 'sess_home_sample', owner: 'cli', sessionMode: 'agent' }), 0);
});
