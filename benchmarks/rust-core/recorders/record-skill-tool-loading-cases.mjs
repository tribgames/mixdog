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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
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

// Every case is replayed; these parts of a case are not.
const excluded = {
  'skill dependencies are callable on the next request without changing the eager tools: the request and the call':
    "the test's own `executeTool('Skill')` from the data dir, `executeTool('office')` through its injected internal-tools provider, " +
    '`snapshotProviderRequestTools` and the per-provider wire bodies of an `agentLoop` with a fake provider, and ' +
    '`createSkillsApi().skillToolContent`: not replayed here (open)',
};

const finalDir = join(FIXTURES_ROOT, 'skill-tool-loading-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), {
  note: `Node's skill tool-dependency loading at ${NODE_COMMIT}, per case of ${RECORDER}`,
  test: TEST,
  bridgeTools: json(TOOL_BRIDGE_TOOLS),
  cases,
});
writeSetManifest(stage, {
  set: 'skill-tool-loading-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: 'per step: the whole session afterwards; an arm also the whole Skill result; a parse the whole parsed document',
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`skill-tool-loading-cases: ${cases.length} case(s), ${cases.reduce((n, c) => n + c.steps.length, 0)} step(s)`);
process.exit(0);
