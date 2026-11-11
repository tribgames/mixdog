#!/usr/bin/env node
// Records Node's native request bytes for scripts/tool-contracts/native-request-bytes.test.mjs: the scenarios of
// `nativeRequestScenarios` (native-request-bytes-scenarios.mjs) over the test's own catalog
// (native-request-bytes.head.json `catalog`), each step through Node's real functions — `applyDeferredToolSurface`,
// `snapshotProviderRequestTools`, `renderToolSearch` (the native load_tool), `reconcileDeferredMcpToolCatalog`,
// `snapshotPendingDeferredToolDelta`, `refreshInitialDeferredMcpSurface`, `loadSkillToolDependencies`,
// `prepareDeferredToolCallThrough`, `preDispatchDenyForSession`, `rebuildDeferredToolSurfaceForProvider`,
// `toOpenAIResponsesTool`, `requestAnthropicTools` and `buildSystemBlocks` — in the scenario's order. Where the test
// keeps a name and a hash per tool, this keeps the whole value, and every step records the whole session afterwards.
//
//   node benchmarks/rust-core/recorders/record-native-request-bytes-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/native-request-bytes-cases/{golden.json,MANIFEST.json}.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'native-request-bytes-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
// The sessions' `updatedAt` stamps: one fixed clock, the replay's.
const NOW = 1_700_000_000_000;
Date.now = () => NOW;

const { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-native-request-bytes-cases.mjs';
const TEST = 'scripts/tool-contracts/native-request-bytes.test.mjs';

const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const O = (rel) => importFrom(tree, `src/runtime/agent/orchestrator/${rel}`);
const defs = await O('runtime-core/tool-defs.mjs');
const toolCatalog = await O('runtime-core/tool-catalog.mjs');
const delta = await O('runtime-core/deferred-tool-delta.mjs');
const skills = await O('runtime-core/skill-tool-loading.mjs');
const skillCatalog = await O('context/skill-catalog.mjs');
const callThrough = await O('session/loop/deferred-call-through.mjs');
const deny = await O('session/loop/pre-dispatch-deny.mjs');
const openai = await O('providers/openai-responses-payload.mjs');
const anthropic = await O('providers/anthropic-messages.mjs');
// What the MCP client answers when the tool catalog refreshes a session's server instructions
// (tool-catalog.mjs:575, :839): no server is connected in this process.
const { getMcpServerInstructionsMap } = await O('mcp/client.mjs');

const fixture = JSON.parse(readFileSync(join(tree, 'scripts', 'tool-contracts', 'native-request-bytes.head.json'), 'utf8'));
const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

// The scenario file's inputs, as it writes them.
const MCP_INSTRUCTIONS = { github: 'Prefer list_issues before create_issue.' };
const mcpTool = (name, description, readOnly) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
  annotations: { readOnlyHint: readOnly },
});
const MCP_TOOLS = [mcpTool('mcp__github__list_issues', 'List repository issues.', true), mcpTool('mcp__github__create_issue', 'Open an issue.', false)];
const LATE_TOOL = mcpTool('mcp__late__lookup', 'Look something up.', true);
// The checkout's own load_tool, never the fixture's copy.
const withLoader = (tools) => tools.map((tool) => (tool.name === defs.TOOL_SEARCH_TOOL.name ? defs.TOOL_SEARCH_TOOL : structuredClone(tool)));
const builtins = () => withLoader(fixture.catalog.builtins);
const standalone = () => withLoader(fixture.catalog.standalone);

function scenario(provider) {
  const steps = [];
  const sessions = {};
  const push = (label, step) => steps.push({ ...step, session: label, after: json(sessions[label]) });
  const open = (label, mode = 'lead', extra = {}) => {
    const session = {
      id: `native-bytes-${provider}-${mode}`,
      provider,
      model: provider.startsWith('openai') ? 'gpt-5.6-sol' : 'claude-opus-4-7',
      toolSpec: mode === 'readonly' ? 'readonly' : 'full',
      tools: builtins(),
      mcpServerInstructions: { ...MCP_INSTRUCTIONS },
      messages: [
        { role: 'system', content: '# Base rules' },
        { role: 'system', content: '# Profile' },
        { role: 'system', content: '# Session', cacheTier: 'tier3' },
      ],
      ...extra,
    };
    const before = json(session);
    const extraTools = [...standalone(), ...structuredClone(MCP_TOOLS)];
    toolCatalog.applyDeferredToolSurface(session, mode, extraTools, { provider });
    sessions[label] = session;
    push(label, { op: 'open', mode, before, extraTools: json(extraTools) });
  };
  const request = (label, name) => {
    const session = sessions[label];
    const tools = toolCatalog.snapshotProviderRequestTools({ provider: session.provider, tools: session.tools, session, messages: session.messages });
    const chat = [{ role: 'user', content: 'go' }];
    const wire = session.provider.startsWith('openai') ? tools.map((tool) => openai.toOpenAIResponsesTool(tool)) : anthropic.requestAnthropicTools(tools, chat, {});
    const system = session.provider.startsWith('openai')
      ? null
      : anthropic.buildSystemBlocks(session.messages.filter((message) => message.role === 'system'), { type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral', ttl: '1h' });
    push(label, { op: 'request', name, provider: session.provider, tools: json(tools), wireTools: json(wire), anthropicSystem: json(system) });
  };
  const load = (label, args, name) => {
    const session = sessions[label];
    const result = toolCatalog.renderToolSearch(args, session, session.deferredSurfaceMode || 'lead');
    push(label, { op: 'load', name, args, result });
  };

  open('lead');
  request('lead', 'first');
  load('lead', { names: ['web_fetch', 'mcp__github__list_issues'] }, 'load');
  load('lead', { names: ['web_fetch'] }, 'again');
  load('lead', { names: ['nope_tool'] }, 'missing');
  load('lead', {}, 'empty');
  load('lead', { query: 'fetch a page' }, 'query');
  request('lead', 'afterLoad');

  // Late MCP: the baseline snapshot, then a connect and a disconnect.
  for (const [name, live] of [
    ['baseline', MCP_TOOLS],
    ['connect', [...MCP_TOOLS, LATE_TOOL]],
  ]) {
    const tools = structuredClone(live);
    toolCatalog.reconcileDeferredMcpToolCatalog(sessions.lead, tools);
    push('lead', { op: 'reconcile', name, live: json(tools) });
  }
  steps.push({ op: 'delta', name: 'connected', session: 'lead', result: json(delta.snapshotPendingDeferredToolDelta(sessions.lead)) });
  const left = structuredClone(MCP_TOOLS.slice(0, 1));
  toolCatalog.reconcileDeferredMcpToolCatalog(sessions.lead, left);
  push('lead', { op: 'reconcile', name: 'disconnect', live: json(left) });
  steps.push({ op: 'delta', name: 'afterDisconnect', session: 'lead', result: json(delta.snapshotPendingDeferredToolDelta(sessions.lead)) });
  request('lead', 'lateMcp');

  // First turn: a server that finished its handshake folds into the roster.
  open('fresh');
  const live = [...structuredClone(MCP_TOOLS), structuredClone(LATE_TOOL)];
  toolCatalog.refreshInitialDeferredMcpSurface(sessions.fresh, live);
  push('fresh', { op: 'refreshInitial', live: json(live) });
  request('fresh', 'firstTurnFold');

  open('skill');
  const dependencies = [
    { type: 'tool', value: 'office' },
    { type: 'tool', value: 'nope_tool' },
  ];
  const envelope = skillCatalog.buildSkillToolEnvelope('deck', '# Deck', '/skills/deck', { toolDependencies: dependencies });
  const head = envelope.result;
  const loaded = skills.loadSkillToolDependencies(envelope, sessions.skill, 'lead');
  push('skill', { op: 'skill', dependencies, head, result: json(loaded) });
  request('skill', 'skillLoading');

  open('unresolved', 'lead', { toolSpec: null });
  open('allowlisted', 'lead', { schemaAllowedTools: ['read'] });
  open('denied', 'lead', { disallowedTools: ['grep', 'office'] });
  steps.push({ op: 'callThrough', name: 'unresolvedMode', session: 'unresolved', tool: 'office', result: json(callThrough.prepareDeferredToolCallThrough(sessions.unresolved, 'office')) });
  for (const [name, label, tool] of [
    ['allowlist', 'allowlisted', 'shell'],
    ['loadToolAllowlist', 'allowlisted', 'load_tool'],
    ['disallowed', 'denied', 'grep'],
    ['allowed', 'denied', 'read'],
  ]) {
    steps.push({ op: 'deny', name, session: label, tool, result: json(deny.preDispatchDenyForSession(sessions[label], { name: tool, arguments: {} })) });
  }
  load('denied', { names: ['office', 'web_fetch'] }, 'deniedLoad');
  request('allowlisted', 'allowlisted');
  request('denied', 'denied');

  open('readonly', 'readonly');
  request('readonly', 'readonly');

  // Provider switches: within the family, then to the other native family.
  open('switched');
  load('switched', { names: ['web_fetch'] }, 'switchLoad');
  const sameFamily = provider === 'anthropic-oauth' ? 'anthropic' : 'openai';
  const otherFamily = provider === 'anthropic-oauth' ? 'openai-oauth' : 'anthropic-oauth';
  for (const [name, next] of [
    ['switchSameFamily', sameFamily],
    ['switchOtherFamily', otherFamily],
  ]) {
    sessions.switched.provider = next;
    toolCatalog.rebuildDeferredToolSurfaceForProvider(sessions.switched, next);
    push('switched', { op: 'switch', name, provider: next });
    request('switched', name);
  }
  return { provider, steps };
}

const cases = ['anthropic-oauth', 'openai-oauth'].map(scenario);

const finalDir = join(FIXTURES_ROOT, 'native-request-bytes-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's native request scenarios at ${NODE_COMMIT}, per provider of ${RECORDER}`, test: TEST, now: NOW, mcpInstructions: MCP_INSTRUCTIONS, liveMcpInstructions: json(getMcpServerInstructionsMap(undefined)), cases });
writeSetManifest(stage, {
  set: 'native-request-bytes-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      'per step the whole session afterwards; per request the system texts, the whole wire tools and the whole Anthropic ' +
      'system blocks; per load the whole load_tool text; per delta the whole notice; per skill load the whole Skill ' +
      'result; per deny and call-through the whole refusal',
    excluded: {},
  },
});
commitStage(stage, finalDir);
console.log(`native-request-bytes-cases: ${cases.length} case(s), ${cases.reduce((n, c) => n + c.steps.length, 0)} step(s)`);
process.exit(0);
