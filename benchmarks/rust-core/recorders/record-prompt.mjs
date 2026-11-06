#!/usr/bin/env node
// Golden twin of the session system prompt (`mixdog-core` `prompt::*`): `composeSessionSystem` +
// `seedSessionMessages` (session-prompt-composition.mjs), the deferred manifest applied to BP2
// (deferred-tools.mjs), `refreshSessionBp3Environment`, a route change's prompt effect
// (`_refreshSessionRuleVariantsForModel` + `applyPendingWorkspaceReroot` + refresh), the cleared
// conversation (`resetSessionBp3Environment`) and a staged workspace re-root meeting a reset.
//
// Each scenario holds the composition input in the Rust shape, the facts Node's outside loaders
// answered (role files, startup observations, instruction files, locale) and every system
// message array Node produced after each step. Paths under the scenarios' data directory are the
// token `{DATA}`. The shipped rules, agents and output styles that both sides read are copied to
// `plugin/`, the user data (agents, config, a project folder) to `data/`.
//
//   node benchmarks/rust-core/recorders/record-prompt.mjs --tree <dir>
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'prompt');
const stage = stageSet(outDir);

// Node reads (and watches) these folders for the whole run, so they are worked in beside the
// stage and copied into it at the end: a watched folder cannot be renamed on Windows.
const work = mkdtempSync(join(tmpdir(), 'prompt-work-'));

// The shipped tree both sides read: rules, agents, output styles, orchestration texts, the hidden-agent table.
const plugin = join(work, 'plugin');
for (const dir of ['rules', 'agents', 'output-styles', 'orchestration']) {
  cpSync(join(tree, 'src', dir), join(plugin, dir), { recursive: true });
}
mkdirSync(join(plugin, 'defaults'), { recursive: true });
cpSync(join(tree, 'src', 'defaults', 'agents.json'), join(plugin, 'defaults', 'agents.json'));

// The user data both sides read.
const data = join(work, 'data');
const put = (rel, text) => {
  mkdirSync(join(data, rel, '..'), { recursive: true });
  writeFileSync(join(data, rel), text);
};
put('mixdog-config.json', JSON.stringify({ agent: { profile: { title: 'Boss', experienceLevel: 'junior', language: 'en' } } }));
put('agents/lead/AGENT.md', "Work in small steps and ask before big changes.\n");
put('agents/lead/agent.json', JSON.stringify({ name: 'Mia', description: 'Greets people.' }));
put('agents/lead/PERSONA.md', "Warm and brief.\n");
put('agents/ann/AGENT.md', "---\nname: ann\n---\nAnn researches questions and cites sources.\n");
put('agents/ann/agent.json', JSON.stringify({ name: 'Ann', description: 'Handles research. Careful with sources.' }));
put('agents/ann/PERSONA.md', "Precise.\n");
put('project/README.md', '# project\n');
put('project/src/main.rs', 'fn main() {}\n');

process.env.MIXDOG_ROOT = plugin;
process.env.MIXDOG_DATA_DIR = data;
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'prompt-home-'));
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
const CWD = join(data, 'project');

const o = 'src/runtime/agent/orchestrator/';
const rt = 'src/runtime/shared/';
const comp = await importFrom(tree, `${o}session/manager/session-prompt-composition.mjs`);
const utils = await importFrom(tree, `${o}session/manager/prompt-utils.mjs`);
const deferred = await importFrom(tree, `${o}context/deferred-tools.mjs`);
const roles = await importFrom(tree, `${o}context/role-instructions.mjs`);
const caps = await importFrom(tree, `${o}tools/builtin/runtime-capabilities.mjs`);
const surfaceMod = await importFrom(tree, `${o}session/manager/session-tool-surface.mjs`);
const settings = await importFrom(tree, `${o}session/manager/prompt-settings.mjs`);
const instr = await importFrom(tree, `${o}context/instruction-files.mjs`);
const modeMod = await importFrom(tree, `${rt}instruction-files-mode.mjs`);
const skillCat = await importFrom(tree, `${o}context/skill-catalog.mjs`);
const lifecycle = await importFrom(tree, `${o}session/manager/session-lifecycle.mjs`);
const orch = await importFrom(tree, `${o}runtime-core/orchestration.mjs`);
const scratch = await importFrom(tree, `${rt}session-scratch.mjs`);
const editDialect = await importFrom(tree, `${rt}edit-tool-dialect.mjs`);

const SKILLS = [
  { name: 'tidy', whenToUse: 'Clean up code, format, lint.', toolDependencies: [{ type: 'tool', value: 'tidy' }] },
  { name: 'pdf', whenToUse: 'Read or create PDF files.' },
];
const STYLE_CONFIG = { outputStyle: 'detailed', profile: { title: 'Boss', experienceLevel: 'expert', language: 'ko' }, agent: { instructionFiles: 'all' } };
const INSTRUCTIONS = '# Instruction Files\n\n## C:/work/AGENTS.md\n\nBe careful.\n\n---\n\n## C:/work/proj/CLAUDE.md\n\nUse tabs.';

const LEAD_PARTS = {
  orchestrationContext: orch.orchestrationInstructions('focused'),
  agentCatalogContext: '# Available Agents\n\n- Worker (worker): General implementation worker\n- Reviewer (reviewer): Reviews changes',
  contactCatalogContext: '',
};

// `createSession` options, the resolved tool surface and the route, as `composeSessionSystem` reads them.
const SCENARIOS = [
  {
    name: 'coding-lead-styled',
    full: true,
    opts: { id: 'sess_lead_a1', cwd: CWD, owner: 'cli', systemPrompt: '', promptConfig: STYLE_CONFIG, workflowContext: '# Active Workflow: Solo\n\nWork alone.', leadWorkflowParts: LEAD_PARTS, orchestrationMode: 'focused', coreMemoryContext: 'The user prefers short answers.', instructionFilesContext: INSTRUCTIONS },
    route: { provider: 'anthropic', model: 'claude-opus-4-1' },
    surface: { ownerIsAgent: false, resolvedAgent: null, skills: SKILLS, disallowed: [], schemaAllowedTools: null, tools: ['read', 'edit', 'git', 'shell'] },
    sessionMode: 'coding',
  },
  {
    name: 'coding-lead-no-delegation',
    opts: { id: 'sess_lead_a2', cwd: CWD, owner: 'cli', systemPrompt: 'Caller prompt.', promptConfig: { outputStyle: 'minimal', profile: { language: 'system' } }, workflowContext: '', leadWorkflowParts: { ...LEAD_PARTS, agentCatalogContext: '' }, orchestrationMode: 'none', coreMemoryContext: '', instructionFilesContext: '', workflow: { id: 'solo', agentsConfigured: true, agents: [] } },
    route: { provider: 'openai', model: 'gpt-5.5-2026-01-02' },
    surface: { ownerIsAgent: false, resolvedAgent: null, skills: [], disallowed: ['git'], schemaAllowedTools: null, tools: ['read', 'apply_patch', 'shell'] },
    sessionMode: 'coding',
  },
  {
    name: 'agent-mode-mixy',
    opts: { id: 'sess_home_lead', cwd: CWD, owner: 'cli', agent: 'lead', systemPrompt: '', promptConfig: STYLE_CONFIG, workflowContext: '# Active Workflow: Chat', leadWorkflowParts: { orchestrationContext: '', agentCatalogContext: '', contactCatalogContext: "# Contacts\n\n- Ann (ann): researcher" }, orchestrationMode: 'focused', coreMemoryContext: 'Name: Sam', instructionFilesContext: '' },
    route: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    surface: { ownerIsAgent: false, resolvedAgent: 'lead', skills: SKILLS, disallowed: [], schemaAllowedTools: null, tools: ['read', 'shell'] },
    sessionMode: 'agent',
  },
  {
    name: 'agent-mode-bot',
    opts: { id: 'sess_home_ann', cwd: CWD, owner: 'cli', agent: 'ann', systemPrompt: '', promptConfig: STYLE_CONFIG, workflowContext: '', leadWorkflowParts: { orchestrationContext: '', agentCatalogContext: '', contactCatalogContext: '' }, orchestrationMode: 'focused', coreMemoryContext: '', instructionFilesContext: '' },
    route: { provider: 'openai', model: 'gpt-5.5' },
    surface: { ownerIsAgent: false, resolvedAgent: 'ann', skills: [], disallowed: [], schemaAllowedTools: null, tools: ['read'] },
    sessionMode: 'agent',
  },
  {
    name: 'worker-agent',
    full: true,
    opts: { id: 'sess_agent_w1', cwd: CWD, owner: 'agent', agent: 'worker', systemPrompt: 'Task brief for the worker.', promptConfig: STYLE_CONFIG, workflowContext: '', coreMemoryContext: 'Shared memory.', instructionFilesContext: INSTRUCTIONS },
    route: { provider: 'openai', model: 'gpt-5.5' },
    surface: { ownerIsAgent: true, resolvedAgent: 'worker', skills: SKILLS, disallowed: ['agent'], schemaAllowedTools: null, tools: ['read', 'edit', 'git'] },
    sessionMode: 'coding',
  },
  {
    name: 'explore-agent-restricted',
    full: true,
    opts: { id: 'sess_agent_r1', cwd: CWD, owner: 'agent', agent: 'explore-agent', systemPrompt: '', promptConfig: null, workflowContext: '', coreMemoryContext: '', instructionFilesContext: '' },
    route: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    surface: { ownerIsAgent: true, resolvedAgent: 'explore-agent', skills: [], disallowed: ['shell'], schemaOmitted: ['edit', 'apply_patch', 'git'], schemaAllowedTools: ['read', 'grep', 'glob'], tools: ['read', 'grep', 'glob'] },
    sessionMode: 'coding',
  },
  {
    name: 'title-agent-tool-free',
    opts: { id: 'sess_agent_t1', cwd: CWD, owner: 'agent', agent: 'title-agent', systemPrompt: '', promptConfig: null, workflowContext: '', coreMemoryContext: '', instructionFilesContext: '' },
    route: { provider: 'openai', model: 'gpt-5.4-mini' },
    surface: { ownerIsAgent: true, resolvedAgent: 'title-agent', skills: [], disallowed: [], schemaAllowedTools: [], tools: [] },
    sessionMode: 'coding',
  },
  {
    name: 'worker-profile-skips',
    opts: { id: 'sess_agent_w2', cwd: CWD, owner: 'agent', agent: 'worker', systemPrompt: '', promptConfig: null, workflowContext: '', coreMemoryContext: 'skipped memory', instructionFilesContext: INSTRUCTIONS },
    route: { provider: 'openai', model: 'gpt-5.5' },
    surface: { ownerIsAgent: true, resolvedAgent: 'worker', skills: SKILLS, disallowed: [], schemaAllowedTools: null, tools: ['read', 'git'] },
    profile: { skip: { skills: true, claudemd: true, memory: true } },
    sessionMode: 'coding',
  },
];

const DEFERRED_CATALOG = [
  { name: 'web_search', description: 'Search the web for current information.' },
  { name: 'recall', description: 'Recall earlier work.' },
  { name: 'mcp__gmail__send_mail', description: 'Send an email. Needs an account.' },
  { name: 'mcp__gmail__read_mail', description: 'Read email.' },
];
const POOL = ['recall', 'web_search', 'mcp__gmail__send_mail', 'mcp__gmail__read_mail'];
const NEXT_ROUTE = { provider: 'anthropic', model: 'claude-opus-4-1' };

const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sysOf = (messages) => plain(messages.filter((m) => m.role === 'system').map(({ role, content, cacheTier }) => (cacheTier ? { role, content, cacheTier } : { role, content })));
const HEADER_KEYS = ['bp3CoreContext', 'bp3EnvironmentContext', 'sessionStartMetaInjected', 'workspaceReroot'];
const headerOf = (session) => plain(Object.fromEntries(HEADER_KEYS.filter((k) => session[k] !== undefined).map((k) => [k, session[k]])));

function record(scenario) {
  const { opts, route, surface: spec, sessionMode } = scenario;
  const profile = scenario.profile ?? null;
  const ownerIsAgent = spec.ownerIsAgent;
  const toolsForRouting = spec.tools.map((name) => ({ name }));
  const agent = spec.resolvedAgent;
  // `resolveSessionToolSurface`: the denials, the allowlist as honored, the omitted-tool list of BP1.
  const sessionDeny = [
    ...spec.disallowed,
    ...(surfaceMod.delegationDisabled({ ...opts, sessionMode }, ownerIsAgent) ? ['agent'] : []),
    ...(surfaceMod.reactionDisabled(opts, ownerIsAgent) ? ['react'] : []),
  ];
  const allowTools = surfaceMod.honoredSchemaAllowlist(spec.schemaAllowedTools, { ownerIsAgent, agent });
  const ruleOmitTools = [...sessionDeny, ...(spec.schemaOmitted ?? []), editDialect.unusedModelEditToolName(route.model)];
  const surface = { ownerIsAgent, resolvedAgent: agent, skills: spec.skills, ruleOmitTools, schemaAllowedTools: allowTools, toolsForRouting };
  const config = settings.promptConfigSlice(opts.promptConfig);
  const configMode = config ? config.instructionFiles : undefined;
  const facts = {
    roleCatalog: ownerIsAgent || (agent && agent !== 'lead') ? roles.loadScopedRoleInstructions(agent || null, route.provider || null) : '',
    mixyRoleSection: roles.composeSystemPrompt({ agent: 'lead', skipPersona: true }).sessionMarkerCore,
    persona: agent ? roles.composeSystemPrompt({ agent, skipRoleCatalog: true }).sessionMarkerCore : '',
    identityLine: agent ? roles.agentModeIdentityLine(agent) : roles.agentModeIdentityLine('lead'),
    shellTools: caps.describeShellToolsStartupState(),
    git: caps.describeGitStartupState({ cwd: opts.cwd }),
    cwdEntries: caps.describeCwdStartupEntries({ cwd: opts.cwd }),
    shellName: process.platform === 'win32' ? 'PowerShell' : 'Bash',
    scratch: scratch.sessionScratchDir(opts.id),
    instructionFiles: opts.instructionFilesContext,
    instructionFilesMode: config ? modeMod.normalizeInstructionFilesMode(config.instructionFiles) : instr.configuredInstructionFilesMode(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  };
  const delegationFree = surfaceMod.delegationDisabled({ ...opts, sessionMode }, ownerIsAgent);
  const toolFreeRole = ownerIsAgent && allowTools?.length === 0;
  const skillManifest = skillCat.buildSkillManifest(spec.skills);
  const runOpts = { ...opts };
  const prompt = comp.composeSessionSystem(runOpts, { profile, providerName: route.provider, modelName: route.model, surface, sessionMode, sessionId: opts.id });
  const seeded = comp.seedSessionMessages(prompt, undefined);

  const input = {
    sessionId: opts.id,
    provider: route.provider,
    model: route.model,
    agentMode: sessionMode === 'agent',
    ownerIsAgent,
    agent: agent ?? null,
    toolFreeRole,
    skipAgentRules: false,
    ruleOmitTools,
    allowTools: allowTools ?? null,
    hasGitTool: spec.tools.includes('git'),
    delegationFree,
    systemPrompt: opts.systemPrompt || '',
    profileSkip: { skills: profile?.skip?.skills === true, claudemd: profile?.skip?.claudemd === true, memory: profile?.skip?.memory === true },
    cwd: opts.cwd,
    config: plain(config),
    workflowContext: opts.workflowContext || '',
    orchestrationContext: opts.leadWorkflowParts?.orchestrationContext || '',
    agentCatalogContext: opts.leadWorkflowParts?.agentCatalogContext || '',
    contactCatalogContext: opts.leadWorkflowParts?.contactCatalogContext || '',
    orchestrationMode: opts.orchestrationMode || '',
    coreMemoryContext: opts.coreMemoryContext || '',
    instructionFilesContext: opts.instructionFilesContext,
    skillManifest,
  };
  void configMode;

  // After session creation: the tool surface's deferred manifest, then the `# Session` block.
  const header = {
    id: opts.id,
    owner: opts.owner,
    cwd: opts.cwd,
    provider: route.provider,
    model: route.model,
    agent: agent ?? undefined,
    disallowedTools: sessionDeny,
    schemaAllowedTools: spec.schemaAllowedTools ?? undefined,
    bp3EnvSplit: true,
    bp3CoreContext: prompt.sessionMarkerCore,
    bp3EnvironmentContext: prompt.environmentTailContext,
    sessionStartMetaInjected: false,
    deferredToolCatalog: DEFERRED_CATALOG,
    tools: spec.tools.map((name) => ({ name })),
  };
  const session = clone({ ...header, messages: seeded });
  const steps = { seeded: sysOf(session.messages) };
  deferred.applyInitialDeferredToolManifestToBp2(session, POOL);
  steps.afterManifest = sysOf(session.messages);
  utils.refreshSessionBp3Environment(session, opts.cwd);
  steps.afterRefresh = { messages: sysOf(session.messages), header: headerOf(session) };

  // The remaining steps repeat the same blocks per scenario: four scenarios carry them.
  if (!scenario.full) return finish(steps);

  // A route change before any conversation.
  const routed = clone(session);
  const previous = { provider: routed.provider, model: routed.model };
  routed.provider = NEXT_ROUTE.provider;
  routed.model = NEXT_ROUTE.model;
  lifecycle._refreshSessionRuleVariantsForModel(routed, previous.model, previous.provider);
  utils.applyPendingWorkspaceReroot(routed);
  utils.refreshSessionBp3Environment(routed, routed.cwd);
  steps.afterRoute = { from: previous, to: NEXT_ROUTE, messages: sysOf(routed.messages), header: headerOf(routed) };

  // A cleared conversation.
  const reset = clone(session);
  utils.resetSessionBp3Environment(reset);
  steps.afterReset = { messages: sysOf(reset.messages), header: headerOf(reset) };

  // A working-folder change staged on a session with a conversation, then a reset and a route change.
  if (!toolFreeRole) {
    const staged = clone(session);
    staged.messages.push({ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' });
    utils.refreshSessionWorkspaceContext(staged, {
      cwd: join(data, 'elsewhere'),
      environmentContext: `- Cwd: ${join(data, 'elsewhere')} — the active Project root; relative paths and shell commands resolve here.\n- Shell: ${facts.shellName}.`,
      coreMemoryContext: 'New folder memory.',
      instructionFilesContext: '# Instruction Files\n\n## C:/other/AGENTS.md\n\nOther rules.',
    });
    const stagedRoute = clone(staged);
    const stagedReset = clone(staged);
    steps.staged = { header: headerOf(staged), messages: sysOf(staged.messages) };
    utils.resetSessionBp3Environment(stagedReset);
    steps.stagedThenReset = { messages: sysOf(stagedReset.messages), header: headerOf(stagedReset) };
    stagedRoute.provider = NEXT_ROUTE.provider;
    stagedRoute.model = NEXT_ROUTE.model;
    lifecycle._refreshSessionRuleVariantsForModel(stagedRoute, previous.model, previous.provider);
    utils.applyPendingWorkspaceReroot(stagedRoute);
    utils.refreshSessionBp3Environment(stagedRoute, stagedRoute.cwd);
    steps.stagedThenRoute = { messages: sysOf(stagedRoute.messages), header: headerOf(stagedRoute) };
  }

  return finish(steps);

  function finish(done) {
    return {
      name: scenario.name,
      input,
      facts,
      header: plain(header),
      node: {
        blocks: { baseRules: prompt.baseRules ?? null, stableSystemContext: prompt.stableSystemContext, sessionMarkerCore: prompt.sessionMarkerCore, sessionEnvironment: prompt.sessionEnvironment },
        environmentTailContext: prompt.environmentTailContext,
        promptIdentity: plain(prompt.promptIdentity),
        promptSettings: plain(prompt.promptSettings),
        responseLanguage: plain(prompt.responseLanguage),
        steps: done,
      },
      pool: POOL,
    };
  }
}

const recorded = SCENARIOS.map(record);
// The data directory is a temp path: the tests see the token.
let text = JSON.stringify({ catalog: DEFERRED_CATALOG, scenarios: recorded });
const escaped = (s) => s.replaceAll('\\', '\\\\');
for (const variant of [escaped(data), data, data.replaceAll('\\', '/')]) text = text.split(variant).join('{DATA}');
writeJson(join(stage, 'scenarios.json'), JSON.parse(text));
cpSync(plugin, join(stage, 'plugin'), { recursive: true });
cpSync(data, join(stage, 'data'), { recursive: true });
writeSetManifest(stage, {
  set: 'prompt',
  recorder: 'benchmarks/rust-core/recorders/record-prompt.mjs',
  command: 'node benchmarks/rust-core/recorders/record-prompt.mjs --tree <tree>',
  identityTree: tree,
});
commitStage(stage, outDir);
// The work folders stay in the temp folder: Node's watchers hold them until this process exits.
console.log(`prompt: ${recorded.length} scenarios -> ${outDir}`);
