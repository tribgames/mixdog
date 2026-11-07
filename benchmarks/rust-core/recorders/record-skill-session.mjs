// Records Node's two session-side inputs of the Skill tool:
//
//   arm — `loadSkillToolDependencies` (`runtime-core/skill-tool-loading.mjs`) over a live session: which of a
//     skill's dependency tools join the session (`selectDeferredTools`, `tool-catalog.mjs`), under which
//     denials (`preDispatchDenyForSession`), and the session afterwards (`tools`, `deferredCallableTools`,
//     `deferredDiscoveredTools`, `deferredSelectedTools`, `skillLoadedTools`). `result` is the Skill result the
//     model is shown, `head` its stub and `notice` what follows the stub (`lines`, and the `native` payload that
//     replaces the result on a native tool-search provider, `summary` apart): the Rust `ArmNotice`.
//   transcript — `skillBodyPresentInSession` (`context/skill-catalog.mjs`) over a session's saved `messages` and
//     its `liveTurnMessages`: whether the injected body is still in the conversation the model sees.
//
//   node benchmarks/rust-core/recorders/record-skill-session.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/skill-session/golden.json.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'skill-session-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'skill-session');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-skill-session.mjs';
const U = (rel) => importFrom(tree, `src/${rel}`);
const { applyDeferredToolSurface } = await U('runtime/agent/orchestrator/runtime-core/tool-catalog.mjs');
const { loadSkillToolDependencies } = await U('runtime/agent/orchestrator/runtime-core/skill-tool-loading.mjs');
const { buildSkillResultEnvelope, buildSkillToolEnvelope, skillBodyPresentInSession } = await U('runtime/agent/orchestrator/context/skill-catalog.mjs');

const json = (value) => JSON.parse(JSON.stringify(value));
const doc = (name, extra = {}) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, ...extra });
const skillTool = doc('Skill', { inputSchema: { type: 'object', properties: { name: { type: 'string' } } } });
const read = doc('read', { description: 'Read content.', annotations: { readOnlyHint: true } });
const office = doc('office', { description: 'Create a document.', inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } });
const handoff = doc('handoff_user');
const figma = doc('mcp__figma__get_design', { description: 'Read a design.', annotations: { readOnlyHint: true } });
const other = doc('mcp__other__inspect', { annotations: { readOnlyHint: true } });
const patcher = doc('patcher', { description: 'Patch files.', freeformDescription: 'Free-form patch text.', freeform: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } });
const skillBody = (name, body) => buildSkillResultEnvelope(name, body, `/skills/${name}`);
const user = (content, extra = {}) => ({ role: 'user', content, ...extra });
const injected = (body) => user(body, { meta: 'skill' });
const badSchema = doc('bad_schema', { inputSchema: { type: 'object', properties: { a: { type: 'not-a-type' } } } });

// A session as `createSession` leaves it: the surface built by `applyDeferredToolSurface`, then `after` adjusts it.
const session = (provider, tools, mode, after = () => {}) => {
  const current = { id: 'sess_skill', provider, tools: [...tools], messages: [], toolSpec: mode };
  applyDeferredToolSurface(current, mode);
  after(current);
  return current;
};
const dep = (type, value, extra = {}) => ({ type, value, ...extra });
const ALL = [skillTool, office, read];
const asBridgeless = (current) => {
  delete current.toolExposureMode;
};

const ARM = [
  ['native openai: an eager and a deferred dependency', session('openai-oauth', ALL, 'full'), [dep('tool', 'read'), dep('tool', 'office')]],
  ['native anthropic: an eager and a deferred dependency', session('anthropic-oauth', ALL, 'full'), [dep('tool', 'read'), dep('tool', 'office')]],
  ['bridge: the fixed surface only records the load', session('openrouter', ALL, 'full'), [dep('tool', 'office')]],
  ['a fixed surface without bridge exposure takes the tool into its schema', session('openrouter', ALL, 'full', asBridgeless), [dep('tool', 'office')]],
  ['a repeat load changes nothing more', session('openai-oauth', ALL, 'full'), [dep('tool', 'office')], [], 2],
  ['a repeat load on a schema surface adds the tool once', session('openrouter', ALL, 'full', asBridgeless), [dep('tool', 'office')], [], 2],
  ['a tool the session does not have', session('openai-oauth', ALL, 'full'), [dep('tool', 'nope')]],
  ['a dependency name is matched exactly before the catalog is asked', session('openai-oauth', ALL, 'full'), [dep('tool', 'OFFICE')]],
  ['a read-only session loads only what it may read', session('openai-oauth', ALL, 'readonly'), [dep('tool', 'read'), dep('tool', 'office')]],
  ['a schema allowlist is not relaxed', session('openai-oauth', ALL, 'full', (current) => { current.schemaAllowedTools = ['Skill', 'read']; }), [dep('tool', 'office')]],
  ['a denied tool stays denied', session('openai-oauth', ALL, 'full', (current) => { current.disallowedTools = ['office']; }), [dep('tool', 'office')]],
  ['a tool list naming tools:readonly selects read-only', session('openai-oauth', ALL, 'full', (current) => { current.toolSpec = ['tools:readonly']; }), [dep('tool', 'office'), dep('tool', 'read')]],
  ['the lead mode selects read-only', session('openai-oauth', ALL, 'lead'), [dep('tool', 'office')]],
  ['a surface mode set by the session wins over the tool spec', session('openai-oauth', ALL, 'lead', (current) => { current.deferredSurfaceMode = 'full'; }), [dep('tool', 'office')]],
  ['mcp dependencies load the server tools only, and an absent server is reported', session('openai-oauth', [skillTool, figma, other, read], 'full'), [dep('mcp', 'figma', { command: 'must-not-run' }), dep('mcp', 'absent', { url: 'https://must-not-connect.invalid' })]],
  ['an mcp tool outside the latest connected snapshot is missing', session('openai-oauth', [skillTool, figma, other, read], 'full', (current) => { current.deferredMcpToolNames = ['mcp__other__inspect']; }), [dep('mcp', 'figma'), dep('tool', 'mcp__figma__get_design')]],
  ['an mcp server matched by its own metadata name', session('openai-oauth', [skillTool, doc('lookup', { mcpServerName: 'docs' }), read], 'full'), [dep('mcp', 'docs')]],
  ['an unsupported dependency type loads nothing', session('openai-oauth', ALL, 'full'), [dep('http', 'office')]],
  ['issues alone load nothing', session('openai-oauth', ALL, 'full'), [], ['SKILL.md: bad dependency']],
  ['a late catalog tool joins', session('openai-oauth', ALL, 'full', (current) => { current.deferredLateToolCatalog = [doc('late_tool')]; }), [dep('tool', 'late_tool')]],
  ['a delegated worker is refused a control-plane tool', session('openai-oauth', [skillTool, read, handoff], 'full', (current) => { current.owner = 'agent'; current.agent = 'worker'; }), [dep('tool', 'handoff_user')]],
  ['a lead takes the control-plane tool', session('openai-oauth', [skillTool, read, handoff], 'full'), [dep('tool', 'handoff_user')]],
  ['a native session holding a discovery already has the tool', session('openai-oauth', ALL, 'full', (current) => { current.deferredDiscoveredTools = ['office']; }), [dep('tool', 'office')]],
  ['earlier skill loads are kept', session('openai-oauth', ALL, 'full', (current) => { current.skillLoadedTools = ['read']; }), [dep('tool', 'office')]],
  ['repeated dependencies count once', session('openai-oauth', ALL, 'full'), [dep('tool', 'read'), dep('tool', 'read'), dep('tool', 'office'), dep('tool', 'office')]],
  ['a tool the route rejects is not loaded on a schema surface', session('openrouter', [...ALL, badSchema], 'full', asBridgeless), [dep('tool', 'bad_schema'), dep('tool', 'office')]],
  ['a session without a tool list loads nothing', { id: 'sess_skill', provider: 'openai-oauth', messages: [] }, [dep('tool', 'office')]],
  ['an unchanged repeat load is already active and still reports the tools', session('openai-oauth', ALL, 'full'), [dep('tool', 'office')], [], 1, true],
  ['a free-form tool loads as a custom tool on openai', session('openai-oauth', [skillTool, read, patcher], 'full'), [dep('tool', 'patcher')]],
  ['a free-form tool loads as a function on anthropic', session('anthropic-oauth', [skillTool, read, patcher], 'full'), [dep('tool', 'patcher')]],
  ['bridge: an eager dependency is direct and a deferred one is bridged', session('openrouter', ALL, 'full'), [dep('tool', 'read'), dep('tool', 'office')]],
].map(([name, before, dependencies, issues = [], loads = 1, already = false]) => {
  // An unchanged repeat load: the session's transcript already holds the body the load injects.
  if (already) before.messages = [injected(skillBody('deck-guide', '# Deck guide'))];
  const live = json(before);
  const snapshot = json(before);
  let result = '';
  let head = '';
  for (let load = 0; load < loads; load += 1) {
    const envelope = buildSkillToolEnvelope('deck-guide', '# Deck guide', '/skills/deck-guide', { toolDependencies: dependencies, dependencyIssues: issues }, live);
    head = envelope.result;
    result = loadSkillToolDependencies(envelope, live).result;
  }
  // What follows the stub: the lines of the summary, and the native payload that carries them.
  const wrapped = result.startsWith('{"nativeToolSearch"') ? JSON.parse(result).nativeToolSearch : null;
  const { summary = result, ...native } = wrapped ?? {};
  const lines = summary.split('\n');
  if (lines.shift() !== head) throw new Error(`${name}: the result does not start with the stub`);
  return { name, before: snapshot, dependencies, issues, loads, already, head, result, notice: { lines, native: wrapped ? native : null }, after: json(live) };
});

const v1 = skillBody('deck-guide', '# Deck guide v1');
const v2 = skillBody('deck-guide', '# Deck guide v2');
const TRANSCRIPT = [
  ['the body is in the saved messages', { messages: [user('hi'), injected(v1)] }, v1],
  ['no turn runs and the body was never loaded', { messages: [user('hi')] }, v1],
  ['a newer body of the skill supersedes', { messages: [injected(v1), user('again'), injected(v2)] }, v1],
  ['the newest body is present', { messages: [injected(v1), injected(v2)] }, v2],
  ['another skill does not count', { messages: [injected(skillBody('other', '# Deck guide v1'))] }, v1],
  ['a running turn is read in place of the saved messages', { messages: [injected(v1)], liveTurnMessages: [user('compacted summary'), user('next request')] }, v1],
  ['the body is in the running turn', { messages: [user('old')], liveTurnMessages: [user('request'), injected(v1)] }, v1],
  ['a body in block content joins its text', { messages: [user([{ type: 'text', text: v1 }])] }, v1],
  ['blocks without text add nothing', { messages: [user([{ type: 'text', text: v1.slice(0, 20) }, { type: 'image' }, { type: 'text', text: '' }, v1.slice(20)])] }, v1],
  ['leading whitespace of the stored message is ignored', { messages: [user(`\n  ${v1}`)] }, v1],
  ['an assistant message is no instruction', { messages: [{ role: 'assistant', content: v1 }] }, v1],
  ['a message with no content', { messages: [{ role: 'user' }, user(null), user(5), injected(v1)] }, v1],
  ['an escaped name is matched unescaped', { messages: [injected(skillBody('a<b', 'x'))] }, skillBody('a<b', 'x')],
  ['not a skill body', { messages: [injected(v1)] }, 'plain text'],
  ['an empty body', { messages: [injected(v1)] }, ''],
  ['a trailing difference is a different body', { messages: [injected(`${v1} `)] }, v1],
].map(([name, current, body]) => ({
  name,
  messages: current.messages,
  live: current.liveTurnMessages ?? null,
  body,
  present: skillBodyPresentInSession(json(current), body),
}));

writeJson(join(stage, 'golden.json'), { arm: ARM, transcript: TRANSCRIPT });
writeSetManifest(stage, { set: 'skill-session', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`skill session: ${ARM.length} arm cases, ${TRANSCRIPT.length} transcript cases`);
