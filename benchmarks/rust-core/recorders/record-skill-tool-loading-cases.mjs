#!/usr/bin/env node
// Records Node's skill tool-dependency loading for the cases of
// src/runtime/agent/orchestrator/runtime-core/skill-tool-loading.test.mjs, through Node's real functions:
// `applyDeferredToolSurface` / `rebuildDeferredToolSurfaceForProvider` (tool-catalog.mjs) building and rebuilding the
// session's surface, `loadSkillToolDependencies` (skill-tool-loading.mjs) arming a loaded skill's dependencies over it,
// and `parseSkillDocument` reading the bundled SKILL.md files. Each case is the test's steps in order; every step
// records the whole session afterwards (and an arm the whole Skill result), so the replay interprets the same steps.
//
//   node benchmarks/rust-core/recorders/record-skill-tool-loading-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/skill-tool-loading-cases/{golden.json,MANIFEST.json}.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'skill-tool-loading-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';

const { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-skill-tool-loading-cases.mjs';
const TEST = 'src/runtime/agent/orchestrator/runtime-core/skill-tool-loading.test.mjs';

const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const U = (rel) => importFrom(tree, `src/runtime/${rel}`);
const contextMod = await U('agent/orchestrator/context/collect.mjs');
const { applyDeferredToolSurface, rebuildDeferredToolSurfaceForProvider } = await U('agent/orchestrator/runtime-core/tool-catalog.mjs');
const { loadSkillToolDependencies } = await U('agent/orchestrator/runtime-core/skill-tool-loading.mjs');
const { HANDOFF_USER_TOOL_DEFS } = await U('agent/orchestrator/runtime-core/ask-user-tool-defs.mjs');
const { parseSkillDocument } = await U('shared/skill-document.mjs');
const { TOOL_BRIDGE_TOOLS } = await U('agent/orchestrator/runtime-core/tool-defs.mjs');

const json = (value) => JSON.parse(JSON.stringify(value));

// The test's tool definitions.
const office = { name: 'office', description: 'Create a document.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } };
const read = { name: 'read', description: 'Read content.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } };
const skill = { name: 'Skill', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } };
const handoff = HANDOFF_USER_TOOL_DEFS[0];
const bridged = (name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} } });
const named = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const skillsRoot = join(tree, 'src', 'defaults', 'skills');
const bundled = (name) => readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8');
// The SKILL.md the second test writes to the data dir.
const DECK_GUIDE = '---\nname: deck-guide\ndescription: Create a presentation.\ndependencies:\n  tools:\n    - type: tool\n      value: office\n---\n# Deck guide\n';

// One case's steps, run on Node as the test runs them; `steps` is what the replay interprets.
function run(name, build) {
  const steps = [];
  let current = null;
  const recordSession = () => json(current);
  const api = {
    // `session(provider, tools, mode)` of the test.
    open(provider, tools, mode = 'full') {
      current = { provider, tools: [...tools], messages: [], toolSpec: mode };
      applyDeferredToolSurface(current, mode);
      steps.push({ op: 'open', provider, tools: json(tools), mode, session: recordSession() });
    },
    set(patch) {
      Object.assign(current, json(patch));
      steps.push({ op: 'set', patch: json(patch), session: recordSession() });
    },
    apply(mode, extra = [], options = {}) {
      applyDeferredToolSurface(current, mode, extra, options);
      steps.push({ op: 'apply', mode, extra: json(extra), options: json(options), session: recordSession() });
    },
    rebuild(provider) {
      rebuildDeferredToolSurfaceForProvider(current, provider);
      steps.push({ op: 'rebuild', provider, session: recordSession() });
    },
    // `loadSkillToolDependencies(buildSkillToolEnvelope(skillName, body, '/skills/<name>', { toolDependencies }), session)`.
    arm(skillName, body, dependencies) {
      const envelope = contextMod.buildSkillToolEnvelope(skillName, body, `/skills/${skillName}`, { toolDependencies: dependencies });
      const result = loadSkillToolDependencies(envelope, current).result;
      steps.push({ op: 'arm', skill: skillName, body, dependencies: json(dependencies), head: envelope.result, result, session: recordSession() });
    },
    parse(skillName, text) {
      const parsed = parseSkillDocument(text);
      steps.push({ op: 'parse', skill: skillName, text, parsed: json(parsed) });
      return parsed;
    },
  };
  build(api);
  return { name, steps };
}

const dependency = { type: 'tool', value: 'office' };
const cases = [];

cases.push(run('skill dependencies do not resend eager tool definitions', (t) => {
  t.open('openai-oauth', [skill, office, read]);
  t.arm('deck-guide', '# Deck guide', [{ type: 'tool', value: 'read' }, dependency]);
  t.arm('deck-guide', '# Deck guide', [{ type: 'tool', value: 'read' }]);
}));

cases.push(run('skill dependencies are callable on the next request without changing the eager tools: the session per provider', (t) => {
  const parsed = t.parse('deck-guide', DECK_GUIDE);
  for (const provider of ['openai-oauth', 'anthropic-oauth', 'gemini', 'openrouter']) {
    t.open(provider, [skill, office, read]);
    // The Skill tool loads the skill twice; the second load leaves the tools as they are.
    t.arm('deck-guide', parsed.body, parsed.frontmatter.dependencies.tools);
    t.arm('deck-guide', parsed.body, parsed.frontmatter.dependencies.tools);
    t.rebuild('openai-oauth');
  }
}));

cases.push(run('missing, readonly and schema policy restrictions cannot be relaxed by a skill', (t) => {
  t.open('openai-oauth', [skill, read]);
  t.arm('deck-guide', '# Deck guide', [dependency]);
  t.open('openai-oauth', [skill, office, read], 'readonly');
  t.arm('deck-guide', '# Deck guide', [dependency]);
  t.open('openai-oauth', [skill, office, read]);
  t.set({ schemaAllowedTools: ['Skill', 'read'] });
  t.arm('deck-guide', '# Deck guide', [dependency]);
  t.open('openai-oauth', [skill, office, read]);
  t.arm('deck-guide', '# Deck guide', [dependency]);
  t.set({ tools: [skill, read] });
  t.apply('full', [], { disallowed: ['office'] });
}));

cases.push(run('MCP dependencies load only registered server tools, and never follow installation metadata', (t) => {
  t.open('openai-oauth', [skill, { ...read, name: 'mcp__figma__get_design' }, { ...read, name: 'mcp__other__inspect' }]);
  t.arm('deck-guide', '# Deck guide', [
    { type: 'mcp', value: 'figma', command: 'must-not-run' },
    { type: 'mcp', value: 'absent', url: 'https://must-not-connect.invalid' },
  ]);
}));

cases.push(run('every bundled skill declares its mandatory existing tools without eagerly linking optional capabilities', (t) => {
  const names = readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const name of names) t.parse(name, bundled(name));
}));

cases.push(run('loading browser-use or computer-use makes the deferred handoff_user schema available; agents are refused', (t) => {
  for (const name of ['browser-use', 'computer-use']) {
    const parsed = t.parse(name, bundled(name));
    const toolDependencies = parsed.frontmatter.dependencies.tools;
    for (const provider of ['openai-oauth', 'anthropic-oauth']) {
      t.open(provider, [skill, read, bridged('browser'), bridged('computer'), handoff], 'full');
      t.arm(name, parsed.body ?? '# Skill', toolDependencies);
    }
    t.open('openai-oauth', [skill, read, bridged('browser'), bridged('computer'), handoff], 'full');
    t.set({ owner: 'agent', agent: 'worker' });
    t.arm(name, '# Skill', toolDependencies);
  }
}));

cases.push(run('policy skills load their deferred tools while fetch stays independently deferred', (t) => {
  const tools = [skill, read, ...['goal', 'recall', 'memory', 'web_fetch'].map(named)];
  for (const provider of ['openai-oauth', 'anthropic-oauth']) {
    t.open(provider, tools, 'lead');
    for (const name of ['history-recall', 'memory-management']) {
      const parsed = t.parse(name, bundled(name));
      t.arm(name, parsed.body, parsed.frontmatter.dependencies.tools);
    }
  }
  t.open('openrouter', tools, 'lead');
}));

// The second test's request half, as the test runs it: the Skill tool loading `deck-guide` from the data dir twice
// (`executeTool`), the request tools before and after (`snapshotProviderRequestTools`), then an `agentLoop` whose fake
// provider calls Skill twice and ends, and `createSkillsApi().skillToolContent`. Where the test checks a few fields of a
// request, this keeps each request's whole tools as the provider's own converter puts them on the wire and, for the
// two native providers, the whole transcript part of the body (`buildRequestBody` input, the OAuth body's `messages`).
const { executeTool } = await U('agent/orchestrator/session/loop/tool-exec.mjs');
const { agentLoop } = await U('agent/orchestrator/session/agent-loop.mjs');
const { normalizeToolEnvelope } = await U('agent/orchestrator/session/tool-envelope.mjs');
const { snapshotProviderRequestTools } = await U('agent/orchestrator/runtime-core/tool-catalog.mjs');
const { setInternalToolsProvider } = await U('agent/orchestrator/internal-tools.mjs');
const { buildRequestBody, toOpenAIResponsesTool } = await U('agent/orchestrator/providers/openai-responses-payload.mjs');
const { requestAnthropicTools } = await U('agent/orchestrator/providers/lib/anthropic-request-utils.mjs');
const { _buildRequestBodyForCacheSmoke: buildAnthropicOAuthBody } = await U('agent/orchestrator/providers/anthropic-oauth.mjs');
const { toGeminiTools } = await U('agent/orchestrator/providers/gemini-schema.mjs');
const { toOpenAITools } = await U('agent/orchestrator/providers/openai-compat-wire.mjs');
const { createSkillsApi } = await importFrom(tree, 'src/session-runtime/skills-api.mjs');

const wireRoot = mkdtempSync(join(tmpdir(), 'skill-load-'));
const mask = (value) => JSON.parse(JSON.stringify(value).split(JSON.stringify(wireRoot).slice(1, -1)).join('<root>').split(wireRoot.replace(/\\/g, '/')).join('<root>'));
process.env.MIXDOG_DATA_DIR = join(wireRoot, 'data');
mkdirSync(join(process.env.MIXDOG_DATA_DIR, 'skills', 'deck-guide'), { recursive: true });
writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'skills', 'deck-guide', 'SKILL.md'), DECK_GUIDE);
contextMod.invalidateSkillsCache(wireRoot);
const officeCalls = [];
setInternalToolsProvider({
  tools: [office],
  executor: async (name, args) => {
    officeCalls.push({ name, args });
    return JSON.stringify({ created: true });
  },
});
// Each provider's request tools as its own converter sends them.
const wireTools = (provider, tools, messages) => {
  if (provider === 'openai-oauth') return tools.map((tool) => toOpenAIResponsesTool(tool));
  // As the OAuth route calls it (anthropic-oauth.mjs:199): its provider name decides eager_input_streaming.
  if (provider === 'anthropic-oauth') return requestAnthropicTools(tools, messages, {}, 'anthropic-oauth');
  if (provider === 'gemini') return toGeminiTools(tools);
  return toOpenAITools(tools);
};
const testSession = (provider) => {
  const current = { provider, tools: [skill, office, read], messages: [], toolSpec: 'full' };
  applyDeferredToolSurface(current, 'full');
  return current;
};
const wire = { providers: [] };
for (const provider of ['openai-oauth', 'anthropic-oauth', 'gemini', 'openrouter']) {
  const current = testSession(provider);
  const opened = json(current);
  const initial = snapshotProviderRequestTools({ provider, tools: current.tools, session: current, messages: [] });
  const loads = [];
  for (let n = 0; n < 2; n += 1) {
    const loaded = normalizeToolEnvelope(await executeTool('Skill', { name: 'deck-guide' }, wireRoot, null, current));
    loads.push(mask({ result: loaded.result, newMessages: loaded.newMessages ?? [], session: current }));
  }
  const after = snapshotProviderRequestTools({ provider, tools: current.tools, session: current, messages: [] });
  const office_ = normalizeToolEnvelope(await executeTool('office', { action: 'create' }, wireRoot, null, current));
  rebuildDeferredToolSurfaceForProvider(current, 'openai-oauth');
  const rebuilt = json(current);

  const loopSession = testSession(provider);
  loopSession.id = `skill-wire-${provider}`;
  loopSession.compaction = { auto: false };
  const loopOpened = json(loopSession);
  const requests = [];
  const fakeProvider = {
    name: provider,
    async send(messages, _model, requestTools) {
      const request = { tools: json(wireTools(provider, requestTools, messages)), input: null };
      if (provider === 'openai-oauth') request.input = json(buildRequestBody(messages, 'gpt-6-astra', requestTools, { sessionId: loopSession.id }).input);
      // The OAuth route's own body (anthropic-oauth.mjs:207-259): its messages after the cache markers, as sent.
      else if (provider === 'anthropic-oauth') request.input = json(buildAnthropicOAuthBody(messages, 'claude-sonnet-4-5', requestTools, {}).messages);
      requests.push(mask(request));
      if (requests.length <= 2) return { content: '', toolCalls: [{ id: `skill-${requests.length}`, name: 'Skill', arguments: { name: 'deck-guide' } }] };
      return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  // As a product turn runs the loop: the session's live transcript is the array the loop appends to
  // (`precommitUserTurn`, ask-turn-execute.mjs:122-123), so a repeat Skill load sees the body the first one injected;
  // the settle clears it (ask-turn-settle.mjs:116).
  const outgoing = [{ role: 'user', content: 'Create a presentation.' }];
  loopSession.liveTurnMessages = outgoing;
  await agentLoop(fakeProvider, outgoing, 'fake-model', loopSession.tools, null, wireRoot, { session: loopSession, sessionId: loopSession.id });
  delete loopSession.liveTurnMessages;
  wire.providers.push({
    provider,
    opened,
    initial: json(wireTools(provider, initial, [])),
    loads,
    after: json(wireTools(provider, after, [])),
    office: mask(office_.result),
    rebuilt,
    loop: { opened: loopOpened, requests, session: mask(loopSession) },
  });
}
{
  const current = testSession('openai-oauth');
  const opened = json(current);
  const api = createSkillsApi({ contextMod, getCwd: () => wireRoot });
  const loaded = api.skillToolContent('deck-guide', current);
  wire.skillToolContent = mask({ opened, result: loaded.result, newMessages: loaded.newMessages ?? [], session: current });
}
wire.officeCalls = json(officeCalls);
setInternalToolsProvider({ tools: [], executor: async () => '' });
contextMod.invalidateSkillsCache(wireRoot);
try {
  rmSync(wireRoot, { recursive: true, force: true });
} catch {}

// Every case is replayed; these parts of a case are not.
const excluded = {
  'skill dependencies are callable on the next request without changing the eager tools: the office call':
    "`executeTool('office')` answers through the executor the test injects (`setInternalToolsProvider`, internal-tools.mjs:30), " +
    'which no product path installs; that the armed dependency is callable is what the next request carries (replayed ' +
    "here, whole) and the call-through's admission of it (native-request-bytes-cases, `callThrough`)",
  'skill dependencies are callable on the next request without changing the eager tools: the loop session `messages`':
    "the test's `agentLoop` appends to the array it is given and never writes `session.messages` (the turn commit does, " +
    'ask-turn-execute.mjs:122); that transcript is compared whole as each request\'s input',
  'skill dependencies are callable on the next request without changing the eager tools: the loop session `id`':
    "an input the recorder gives the test's session (`loopSession.id = skill-wire-<provider>`), not a product output; the core's " +
    'thread carries the id its directory minted, and every request that carries the id (OpenAI `session_id`) is compared as sent',
  'skill dependencies are callable on the next request without changing the eager tools: the loop session `compaction`':
    "an input the recorder gives the test's session (`loopSession.compaction = { auto: false }`), which skill loading never reads or " +
    "writes; the core's thread holds the compaction record its own installation made (compaction-installation set)",
  'skill dependencies are callable on the next request without changing the eager tools: the loop session `_providerPrefixGuardState`':
    'in-memory only: Node drops it from every stored session (store/serialize.mjs:42,59-81), so no client or file sees it',
  'skill dependencies are callable on the next request without changing the eager tools: the loop session `deferredMcpToolNames`, `deferredLateToolCatalog`, `todoCheck`':
    "written by the loop's per-turn MCP reconcile (tool-catalog.mjs:679,731) and todo cycle (todo-check.mjs:37), not by " +
    "skill loading; the replay's turn assembly stands in for those steps, which the mcp-fold and todo-list sets replay " +
    'through the core (`mcp_fold`, `TodoGuards`)',
};

const finalDir = join(FIXTURES_ROOT, 'skill-tool-loading-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), {
  note: `Node's skill tool-dependency loading at ${NODE_COMMIT}, per case of ${RECORDER}`,
  test: TEST,
  bridgeTools: json(TOOL_BRIDGE_TOOLS),
  cases,
  wire,
});
writeSetManifest(stage, {
  set: 'skill-tool-loading-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      'per step: the whole session afterwards; an arm also the whole Skill result; a parse the whole parsed document; ' +
      'wire: per provider the whole Skill results and new messages, the whole request tools on the wire before and ' +
      'after, and per loop request the whole wire tools and (OpenAI, Anthropic) the whole transcript part of the body',
    excluded,
    declared:
      "a tool the test defines without `description` (its `Skill`) goes on Node's wire with the key absent; the core's " +
      "tool definition always has a description string, so its codec sends `description: \"\"`. The replay drops that " +
      'empty key from only those tools, named from the test input; no product source reaches a request without a ' +
      'description (mcp/client.mjs:1647,323; session/manager/tool-resolution.mjs:35; runtime-core/tool-bridge.mjs:238; ' +
      'builtin-tools.mjs; tool-defs.mjs:216). ' +
      "The core's loop session also holds its turn pipeline's per-turn bookkeeping (usage totals and last-request readings, `turnHop`, `turnBotChain`, " +
      "`transcriptEpoch`, `turnCoverage`, `title`, `titleUpdatedAt`, `reasoningUsage`, `usageMetricsTurnId`, `lastIterationIndex`, `lastTurnCompletedAt`, " +
      "`closeProvenance`, the `_repeat*` guards): the test runs `agentLoop` alone, whose turn commit writes them elsewhere (ask-turn-execute.mjs:122); the replay " +
      "names each in `TURN_BOOKKEEPING` (skill_wire_node_cases.rs) and fails on any other key Node's session lacks. " +
      "The loop session's `lastProviderSendAt` is each side's own send clock: compared as present and a number",
  },
});
commitStage(stage, finalDir);
console.log(`skill-tool-loading-cases: ${cases.length} case(s), ${cases.reduce((n, c) => n + c.steps.length, 0)} step(s)`);
process.exit(0);
