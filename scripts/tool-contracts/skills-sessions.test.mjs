// Skill loading, session prompt layers, and per-permission session tool
// surfaces (lead, GPT, agent, hidden roles).
import './_env.mjs';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './_env.mjs';
import { SKILL_TOOL, TOOL_SEARCH_TOOL } from '../../src/mixdog-session-runtime.mjs';
import { applyStandaloneToolDefaults } from '../../src/session-runtime/tool-defs.mjs';
import { TOOL_DEFS as WEB_SEARCH_TOOL_DEFS } from '../../src/runtime/web-search/tool-defs.mjs';
import {
  buildSkillToolEnvelope,
  invalidateSkillsCache,
  loadSkillResource,
} from '../../src/runtime/agent/orchestrator/context/collect.mjs';
import { setInternalToolsProvider } from '../../src/runtime/agent/orchestrator/internal-tools.mjs';
import { initProviders } from '../../src/runtime/agent/orchestrator/providers/registry.mjs';
import { closeSession, createSession, resumeSession } from '../../src/runtime/agent/orchestrator/session/manager.mjs';
import { AGENT_OWNER } from '../../src/runtime/agent/orchestrator/agent-owner.mjs';
import { getHiddenAgent, resolveAgentSessionPermission } from '../../src/runtime/agent/orchestrator/internal-agents.mjs';
import { resolveHiddenRoleSchemaAllowedTools } from '../../src/runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';
import { prepareAgentSession } from '../../src/runtime/agent/orchestrator/agent-runtime/session-builder.mjs';

setInternalToolsProvider({
  executor: async () => 'tool-contracts internal tool',
  tools: [
    { name: 'memory', description: 'Destructive memory surface.', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
    { name: 'recall', description: 'Memory recall surface.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'web_search', description: 'Web search surface.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: true } },
    { name: 'reply', description: 'Channel reply surface.', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
    { name: 'web_fetch', description: 'Web fetch surface.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: true } },
  ],
});
await initProviders({ 'openai-oauth': { enabled: true } });

test('agent visibility: production web_search visible, tool_search hidden', () => {
  const runtimeWebSearchTool = applyStandaloneToolDefaults(WEB_SEARCH_TOOL_DEFS.find((tool) => tool?.name === 'web_search'));
  if (runtimeWebSearchTool?.annotations?.agentHidden === true) {
    throw new Error('production web_search tool must stay visible to agent sessions');
  }
  if (TOOL_SEARCH_TOOL.annotations?.agentHidden !== true) {
    throw new Error('deferred tool_search wrapper must stay hidden from agent sessions');
  }
});

test('skill loader, envelope, and lead/GPT/agent skill surfaces', async () => {
  const skillManifestTmp = mkdtempSync(join(tmpdir(), 'mixdog-skill-manifest-'));
  const previousSkillDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(skillManifestTmp, 'data');
  try {
    const skillDir = join(process.env.MIXDOG_DATA_DIR, 'skills', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: demo-skill',
      'description: Use when validating compact skill manifest matching.',
      '---',
      '',
      '# Demo Skill',
      '',
      'Use this skill for manifest smoke tests.',
      'Read ${MIXDOG_SKILL_DIR}/reference.md when needed.',
      '',
    ].join('\n'));
    invalidateSkillsCache();
    const loadedSkill = loadSkillResource('demo-skill', skillManifestTmp);
    if (!loadedSkill
      || /^---/m.test(loadedSkill.content)
      || !loadedSkill.content.startsWith('# Demo Skill')) {
      throw new Error(`Skill loader must strip SKILL.md frontmatter: ${JSON.stringify(loadedSkill)}`);
    }
    const trimmedSkill = loadSkillResource('  demo-skill  ', skillManifestTmp);
    if (!trimmedSkill || trimmedSkill.filePath !== loadedSkill.filePath) {
      throw new Error(`Skill loader must trim an exact available-skills name: ${JSON.stringify(trimmedSkill)}`);
    }
    const skillEnvelope = buildSkillToolEnvelope(
      'demo-skill',
      loadedSkill.content,
      loadedSkill.dir,
    );
    const skillMessage = skillEnvelope?.newMessages?.[0];
    const normalizedSkillDir = loadedSkill.dir.replace(/\\/g, '/');
    if (skillEnvelope?.result !== 'Loaded skill: demo-skill'
      || skillEnvelope?.newMessages?.length !== 1
      || skillMessage?.role !== 'user'
      || skillMessage?.meta !== 'skill'
      || !skillMessage?.content?.includes(`<base-dir>${normalizedSkillDir}</base-dir>`)
      || !skillMessage?.content?.includes(`${normalizedSkillDir}/reference.md`)
      || skillMessage?.content?.includes('${MIXDOG_SKILL_DIR}')) {
      throw new Error(`Skill load must inject one meta user message with its resolved base directory: ${JSON.stringify(skillEnvelope)}`);
    }
    const skillSession = createSession({
      provider: 'openai-oauth',
      model: 'tool-contracts-model',
      owner: 'cli',
      agent: 'lead',
      cwd: skillManifestTmp,
      permission: 'read-write',
    });
    try {
      const visible = (skillSession.messages || []).map((m) => String(m.content || '')).join('\n');
      if (!/available-skills/i.test(visible) || !/demo-skill/i.test(visible) || !/Skill\(\{"name":"<skill-name>"\}\)/.test(visible)) {
        throw new Error(`lead skill manifest missing compact skill listing: ${visible.slice(0, 1200)}`);
      }
      if ((visible.match(/(^|\n)- Shell: /g) || []).length !== 1
        || /(^|\n)# Environment\n/i.test(visible)) {
        throw new Error(`Lead BP3 must relocate the shell payload exactly once without a new heading: ${visible.slice(0, 1200)}`);
      }
      const skillToolNames = (skillSession.tools || []).map((tool) => tool?.name).filter(Boolean);
      if (!skillToolNames.includes('Skill')) {
        throw new Error(`lead skill manifest session must expose Skill loader: ${skillToolNames.join(', ')}`);
      }
      if (!skillToolNames.includes('edit') || skillToolNames.includes('apply_patch')) {
        throw new Error(`non-GPT sessions must expose edit only: ${skillToolNames.join(', ')}`);
      }
    } finally {
      closeSession(skillSession.id, 'tool-contracts');
    }
    const gptEditSession = createSession({
      provider: 'openai-oauth',
      model: 'gpt-5.5',
      owner: 'cli',
      agent: 'lead',
      cwd: skillManifestTmp,
      permission: 'read-write',
    });
    try {
      const names = (gptEditSession.tools || []).map((tool) => tool?.name).filter(Boolean);
      if (!names.includes('apply_patch') || names.includes('edit')) {
        throw new Error(`GPT sessions must expose apply_patch only: ${names.join(', ')}`);
      }
    } finally {
      closeSession(gptEditSession.id, 'tool-contracts');
    }
    const agentSkillSession = createSession({
      provider: 'openai-oauth',
      model: 'tool-contracts-model',
      owner: AGENT_OWNER,
      agent: 'worker',
      cwd: skillManifestTmp,
      permission: 'read-write',
    });
    try {
      const systemLayers = (agentSkillSession.messages || []).filter((m) => m?.role === 'system');
      const systemVisible = systemLayers
        .map((m) => String(m.content || ''))
        .join('\n');
      // Agent (Pool B/C) sessions FREEZE the Skill meta-tool into the schema
      // unconditionally so the tool bytes stay bit-identical across roles/cwds
      // (provider cache shard stability). The BP2 manifest rides alongside it
      // so the model knows which Skill names exist — a loader without the
      // manifest cannot be targeted. Both must be present together.
      if (!/available-skills/i.test(systemVisible) || !/demo-skill/i.test(systemVisible) || !/Skill\(\{"name":"<skill-name>"\}\)/.test(systemVisible)) {
        throw new Error(`agent BP2 must carry the compact skill manifest alongside the frozen Skill tool: ${systemVisible.slice(0, 1200)}`);
      }
      if (/# Demo Skill|Use this skill for manifest smoke tests|\$\{MIXDOG_SKILL_DIR\}/.test(systemVisible)) {
        throw new Error(`agent Skill manifest must expose metadata only, never SKILL.md body: ${systemVisible.slice(0, 1200)}`);
      }
      if (!/# General/i.test(systemVisible) || !/# Agent Constraints/i.test(systemVisible)) {
        throw new Error(`agent system layers must carry BP1 tool policy and BP3 role rules: ${systemVisible.slice(0, 1200)}`);
      }
      if (!/# General/i.test(systemLayers[0]?.content || '')
        || /available-skills/i.test(systemLayers[0]?.content || '')
        || !/available-skills/i.test(systemLayers[1]?.content || '')
        || !/# Agent Constraints/i.test(systemLayers[2]?.content || '')) {
        throw new Error(`agent prompt layers must place tool policy in BP1, skills in BP2, and role in BP3: ${JSON.stringify(systemLayers)}`);
      }
      const agentSkillTool = (agentSkillSession.tools || []).find((tool) => tool?.name === 'Skill');
      const agentSkillToolNames = (agentSkillSession.tools || []).map((tool) => tool?.name).filter(Boolean);
      if (!agentSkillToolNames.includes('Skill')) {
        throw new Error(`read-write agent schema must expose Skill loader with the manifest: ${agentSkillToolNames.join(', ')}`);
      }
      if (agentSkillTool?.title !== SKILL_TOOL.title
        || agentSkillTool?.description !== SKILL_TOOL.description
        || JSON.stringify(agentSkillTool?.annotations) !== JSON.stringify(SKILL_TOOL.annotations)
        || JSON.stringify(agentSkillTool?.inputSchema) !== JSON.stringify(SKILL_TOOL.inputSchema)) {
        throw new Error(`agent Skill metadata must match the session Skill contract: ${JSON.stringify(agentSkillTool)}`);
      }
    } finally {
      closeSession(agentSkillSession.id, 'tool-contracts');
    }
  } finally {
    invalidateSkillsCache();
    if (previousSkillDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousSkillDataDir;
    rmSync(skillManifestTmp, { recursive: true, force: true });
  }
});

test('worker session context hygiene and verification tool exposure', () => {
  const workerSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-contracts-model',
    owner: AGENT_OWNER,
    agent: 'worker',
    cwd: root,
    permission: 'read-write',
    taskBrief: 'Implement a scoped smoke check.',
  });
  try {
    const visible = (workerSession.messages || []).map((m) => String(m.content || '')).join('\n');
    const userReminderVisible = (workerSession.messages || [])
      .filter((m) => m?.role === 'user')
      .map((m) => String(m.content || ''))
      .join('\n');
    if (/(^|\n)# role\n/i.test(visible) || /(^|\n)permission:/i.test(visible)) {
      throw new Error(`agent context must not repeat raw role/permission labels: ${visible.slice(0, 1200)}`);
    }
    if (/# role-identity/i.test(visible)) {
      throw new Error(`agent context must not repeat role identity: ${visible.slice(0, 1200)}`);
    }
    if (/# task-brief/i.test(visible)) {
      throw new Error(`agent context must not repeat task brief: ${visible.slice(0, 1200)}`);
    }
    if (/available-skills/i.test(userReminderVisible)) {
      throw new Error(`agent skill manifest must stay in system BP2, not user reminders: ${userReminderVisible.slice(0, 1200)}`);
    }
    if (/(^|\n)# environment/i.test(visible)) {
      throw new Error(`agent BP3 must add no Environment heading: ${visible.slice(0, 1200)}`);
    }
    if ((visible.match(/(^|\n)- Shell: /gi) || []).length !== 1) {
      throw new Error(`shell-capable agent BP3 must include the shell syntax payload exactly once: ${visible.slice(0, 1200)}`);
    }
    const workerToolNames = (workerSession.tools || []).map((tool) => tool?.name).filter(Boolean);
    if (workerToolNames.includes('load_tool')) {
      throw new Error(`agent session schema must not expose deferred load_tool: ${workerToolNames.join(', ')}`);
    }
    for (const name of ['shell', 'task']) {
      if (!workerToolNames.includes(name)) {
        throw new Error(`read-write agent session schema must expose ${name} for self-verification: ${workerToolNames.join(', ')}`);
      }
    }
    for (const name of ['skills_list', 'skill_view', 'skill_execute']) {
      if (workerToolNames.includes(name)) {
        throw new Error(`agent session schema must not expose legacy skill tool ${name}: ${workerToolNames.join(', ')}`);
      }
    }
  } finally {
    closeSession(workerSession.id, 'tool-contracts');
  }
});

// Unified-shard policy (session-lifecycle.mjs): exactly two schema surfaces
// exist — Lead and Agent. Role permission is prompt/diagnostic metadata and
// call-time guards (isBlockedPublicWrapperCall, mutation gates) enforce the
// restrictions; the provider-visible Agent schema stays identical across
// permissions so the provider cache shard never fragments.
const UNIFIED_AGENT_BUILTINS = ['find', 'glob', 'list', 'grep', 'code_graph', 'read', 'edit', 'git', 'git_stage', 'shell', 'task', 'Skill'];

function sessionToolNames(session) {
  return (session?.tools || []).map((tool) => tool?.name).filter(Boolean);
}

test('agent permissions share one unified schema; permission stays metadata', () => {
  const surfaces = new Map();
  for (const permission of ['read', 'read-write', 'full', 'none']) {
    const session = createSession({
      provider: 'openai-oauth',
      model: 'tool-contracts-model',
      owner: AGENT_OWNER,
      agent: 'worker',
      cwd: root,
      permission,
    });
    try {
      surfaces.set(permission, sessionToolNames(session));
      if (session.permission !== permission || session.toolPermission !== permission) {
        throw new Error(`agent permission must persist as session metadata: ${JSON.stringify({ permission, stored: session.permission, tool: session.toolPermission })}`);
      }
    } finally {
      closeSession(session.id, 'tool-contracts');
    }
  }
  const reference = JSON.stringify(surfaces.get('read'));
  for (const [permission, names] of surfaces) {
    if (JSON.stringify(names) !== reference) {
      throw new Error(`agent schema must not fragment by permission: ${permission}=${names.join(', ')} vs read=${surfaces.get('read').join(', ')}`);
    }
  }
  const readNames = surfaces.get('read');
  for (const name of UNIFIED_AGENT_BUILTINS) {
    if (!readNames.includes(name)) {
      throw new Error(`unified agent schema must carry ${name}: ${readNames.join(', ')}`);
    }
  }
  // Internal wrapper tools registered via setInternalToolsProvider ride the
  // shared schema too — the call-time guard owns enforcement, not the schema.
  for (const name of ['memory', 'recall', 'reply', 'web_search', 'web_fetch']) {
    if (!readNames.includes(name)) {
      throw new Error(`unified agent schema must include registered internal tool ${name}: ${readNames.join(', ')}`);
    }
  }
  // agentHidden, owner-boundary, and off-dialect tools stay out of every
  // agent schema (non-GPT sessions expose edit, never apply_patch).
  for (const name of ['load_tool', 'agent', 'apply_patch']) {
    if (readNames.includes(name)) {
      throw new Error(`agent schema must omit ${name}: ${readNames.join(', ')}`);
    }
  }
});

test('resume reapplies the unified schema for every permission form', async () => {
  let reference = null;
  for (const permission of ['read-write', 'none']) {
    const session = createSession({
      provider: 'openai-oauth',
      model: 'tool-contracts-model',
      owner: AGENT_OWNER,
      agent: 'worker',
      cwd: root,
      permission,
    });
    try {
      const fresh = JSON.stringify(sessionToolNames(session));
      const resumed = await resumeSession(session.id, 'full');
      const resumedNames = JSON.stringify(sessionToolNames(resumed));
      if (resumedNames !== fresh) {
        throw new Error(`resume must preserve the ${permission} agent schema: fresh=${fresh} resumed=${resumedNames}`);
      }
      if (reference === null) reference = fresh;
      else if (fresh !== reference) {
        throw new Error(`resumed agent schema must stay unified across permissions: ${permission}=${fresh} reference=${reference}`);
      }
    } finally {
      closeSession(session.id, 'tool-contracts');
    }
  }
  // Object allow/deny permissions stay verbatim metadata without shaping the
  // provider-visible schema.
  const objectPermission = { allow: ['read', 'grep'], deny: ['grep'] };
  const objectPermissionSession = createSession({
    provider: 'openai-oauth',
    model: 'tool-contracts-model',
    owner: AGENT_OWNER,
    agent: 'worker',
    cwd: root,
    permission: objectPermission,
  });
  try {
    if (JSON.stringify(objectPermissionSession.permission) !== JSON.stringify(objectPermission)) {
      throw new Error(`object permission must persist verbatim as metadata: ${JSON.stringify(objectPermissionSession.permission)}`);
    }
    const resumedObject = await resumeSession(objectPermissionSession.id, 'full');
    if (JSON.stringify(sessionToolNames(resumedObject)) !== reference) {
      throw new Error(`object-permission agent schema must stay unified: ${sessionToolNames(resumedObject).join(', ')}`);
    }
  } finally {
    closeSession(objectPermissionSession.id, 'tool-contracts');
  }
});

test('hidden agents share the unified schema unless a specialist allow-list is declared', async (t) => {
  // Hermetic skills root: a dev machine has installed skills while a CI
  // runner has none, and either ambient state would decide the Skill-manifest
  // assertion below. One fixture skill pins the contract everywhere.
  const hiddenSkillsTmp = mkdtempSync(join(tmpdir(), 'mixdog-hidden-skills-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(hiddenSkillsTmp, 'data');
  const fixtureSkillDir = join(process.env.MIXDOG_DATA_DIR, 'skills', 'hidden-fixture');
  mkdirSync(fixtureSkillDir, { recursive: true });
  writeFileSync(join(fixtureSkillDir, 'SKILL.md'), [
    '---',
    'name: hidden-fixture',
    'description: Deterministic fixture for the hidden-agent skill manifest contract.',
    '---',
    '',
    '# Hidden Fixture',
    '',
  ].join('\n'));
  invalidateSkillsCache();
  t.after(() => {
    invalidateSkillsCache();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(hiddenSkillsTmp, { recursive: true, force: true });
  });
  const hiddenAgents = JSON.parse(readFileSync(join(root, 'src', 'defaults', 'agents.json'), 'utf8')).agents || [];
  const hiddenPreset = { id: 'hidden-smoke', name: 'hidden-smoke', type: 'agent', provider: 'openai-oauth', model: 'tool-contracts-model', tools: 'full' };
  const hiddenRuntimeSpec = { scopeKey: 'hidden-role-smoke', lane: 'agent' };
  for (const entry of hiddenAgents) {
    const agent = String(entry?.agent || '').trim();
    if (!agent) continue;
    const hidden = getHiddenAgent(agent);
    const permission = resolveAgentSessionPermission(agent, hidden?.permission || null);
    const schemaAllowedTools = resolveHiddenRoleSchemaAllowedTools(hidden);
    const { session } = prepareAgentSession({
      agent,
      presetName: 'hidden-smoke',
      preset: hiddenPreset,
      runtimeSpec: hiddenRuntimeSpec,
      permission,
      cwd: root,
      sourceType: 'hidden-role-smoke',
      sourceName: agent,
      schemaAllowedTools,
    });
    try {
      const tools = sessionToolNames(session);
      const resumed = await resumeSession(session.id, 'full');
      const resumedTools = sessionToolNames(resumed);
      // Order-insensitive: the session tool surface follows catalog order, while
      // schemaAllowedTools declares an allow-set; only set equality is contractual.
      const asSet = (list) => JSON.stringify(list.slice().sort());
      if (Array.isArray(schemaAllowedTools) && schemaAllowedTools.length) {
        // Declared specialists keep their exact allow-set, fresh and resumed.
        if (asSet(tools) !== asSet(schemaAllowedTools) || asSet(resumedTools) !== asSet(schemaAllowedTools)) {
          throw new Error(`hidden agent ${agent} specialist schema mismatch: expected=${schemaAllowedTools.join(', ')} tools=${tools.join(', ')} resumed=${resumedTools.join(', ')}`);
        }
      } else {
        // Everyone else rides the unified Agent surface (permission stays
        // call-time metadata under the unified-shard policy).
        for (const name of UNIFIED_AGENT_BUILTINS) {
          if (!tools.includes(name)) {
            throw new Error(`hidden agent ${agent} must ride the unified schema (missing ${name}): ${tools.join(', ')}`);
          }
        }
        if (tools.includes('load_tool') || tools.includes('agent')) {
          throw new Error(`hidden agent ${agent} schema must omit deferred/owner-boundary tools: ${tools.join(', ')}`);
        }
        if (asSet(tools) !== asSet(resumedTools)) {
          throw new Error(`hidden agent ${agent} resumed schema must match fresh schema: ${resumedTools.join(', ')}`);
        }
      }
      const systemVisible = (session.messages || [])
        .filter((m) => m?.role === 'system')
        .map((m) => String(m.content || ''))
        .join('\n');
      // The unified surface freezes the Skill tool, so the compact manifest
      // must ride alongside it — a loader without the manifest cannot be
      // targeted.
      if (tools.includes('Skill') && !/available-skills/i.test(systemVisible)) {
        throw new Error(`hidden agent ${agent} carries Skill without its compact manifest`);
      }
      if (/effective-cwd|Override cwd|# task-brief/i.test(systemVisible)) {
        throw new Error(`hidden agent ${agent} must not carry legacy cwd/task-brief injection`);
      }
      if (/(^|\n)# Environment\n/i.test(systemVisible)) {
        throw new Error(`hidden agent ${agent} BP3 must not add an Environment heading`);
      }
    } finally {
      closeSession(session.id, 'tool-contracts');
    }
  }
});
