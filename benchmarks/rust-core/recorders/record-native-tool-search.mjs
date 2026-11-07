// Records Node's consumer of a tool result that carries `nativeToolSearch`, and what the provider request
// holds of it:
//
//   parse — `parseNativeToolSearchPayload` (`session/loop/tool-helpers.mjs`) as `finalizeBatchResults`
//     (`session/tool-batch/finalize.mjs`) applies it: the result text a tool returned, the parsed payload
//     and the text the message carries after (`summary` replaces the result).
//   requests — the tool message with that payload in a transcript, lowered by `buildRequestBody`
//     (`providers/openai-responses-payload.mjs`, its `input`) and by `toAnthropicMessages`
//     (`providers/lib/anthropic-request-utils.mjs`), with the deferred tool offered and not.
//
//   node benchmarks/rust-core/recorders/record-native-tool-search.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/native-tool-search/golden.json.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'native-tool-search-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const { nodeRealTool, writeJsonCompact } = await import('./lib/tool-definitions.mjs');
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'native-tool-search');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-native-tool-search.mjs';
const U = (rel) => importFrom(tree, `src/${rel}`);
const { applyDeferredToolSurface } = await U('runtime/agent/orchestrator/runtime-core/tool-catalog.mjs');
const { loadSkillToolDependencies } = await U('runtime/agent/orchestrator/runtime-core/skill-tool-loading.mjs');
const { buildSkillToolEnvelope } = await U('runtime/agent/orchestrator/context/skill-catalog.mjs');
const { parseNativeToolSearchPayload } = await U('runtime/agent/orchestrator/session/loop/tool-helpers.mjs');
const { buildRequestBody } = await U('runtime/agent/orchestrator/providers/openai-responses-payload.mjs');
const { toAnthropicMessages } = await U('runtime/agent/orchestrator/providers/lib/anthropic-request-utils.mjs');

const json = (value) => JSON.parse(JSON.stringify(value));
const doc = (name, extra = {}) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, ...extra });
// The runtime's own tools are the product's definitions; `patcher` (a free-form tool) is the recorder's input.
const real = await nodeRealTool(tree);
const skillTool = real('Skill');
const read = real('read');
const office = real('office');
const patcher = doc('patcher', { description: 'Patch files.', freeformDescription: 'Free-form patch text.', freeform: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } });

// The result a Skill call returns for `dependencies` on a `provider` session, from the real loader.
const skillResult = (provider, tools, dependencies) => {
  const current = { id: 'sess_nts', provider, tools: [...tools], messages: [], toolSpec: 'full' };
  applyDeferredToolSurface(current, 'full');
  const envelope = buildSkillToolEnvelope('deck-guide', '# Deck guide', '/skills/deck-guide', { toolDependencies: dependencies }, current);
  return loadSkillToolDependencies(envelope, current).result;
};
const tool = (value) => ({ type: 'tool', value });
const SKILLS = [
  ['openai native: a deferred function', 'openai-oauth', [skillTool, read, office], [tool('office')]],
  ['openai native: a free-form custom tool', 'openai-oauth', [skillTool, read, patcher], [tool('patcher')]],
  ['anthropic native: a deferred function', 'anthropic-oauth', [skillTool, read, office], [tool('office')]],
  ['openai native: only an eager dependency', 'openai-oauth', [skillTool, read, office], [tool('read')]],
  ['bridge: nothing native', 'openrouter', [skillTool, read, office], [tool('office')]],
].map(([name, provider, tools, dependencies]) => ({ name, provider, result: skillResult(provider, tools, dependencies) }));

const payload = (extra) => JSON.stringify({ nativeToolSearch: { provider: 'OpenAI-OAuth ', toolReferences: [' office ', 3, ''], openaiTools: [{ type: 'function', name: 'office', parameters: {} }], ...extra } });
const PARSE = [
  ...SKILLS.map(({ name, result }) => ['Skill', name, result]),
  ['load_tool', 'a payload with no summary names the loaded tools', payload({})],
  ['tool_search', 'a payload with a summary', payload({ summary: 'Loaded by search' })],
  ['skill_view', 'missing and blocked tools are appended to the summary', JSON.stringify({ nativeToolSearch: { provider: 'anthropic', toolReferences: ['a'] }, selected: { tools: { missing: [' x ', '', 7], blocked: [{ name: 'b', reason: 'readonly mode' }, { name: 'c' }, 'd', null, 0, {}, []] } } })],
  ['Skill', 'tools without names are dropped, and a type must be text', payload({ openaiTools: [{ name: ' ' }, { name: 'a', type: 1 }, { name: 'b', type: null }, { name: 'c' }, [], 'x', null, { type: 'function', name: 'd' }], toolReferences: [] })],
  ['Skill', 'a provider alone is a payload', JSON.stringify({ nativeToolSearch: { provider: 'Anthropic' } })],
  ['Skill', 'an empty payload is none', JSON.stringify({ nativeToolSearch: { provider: ' ', toolReferences: [], openaiTools: [] } })],
  ['Skill', 'a payload that is not an object is none', JSON.stringify({ nativeToolSearch: 'x' })],
  ['Skill', 'an array payload is none', JSON.stringify({ nativeToolSearch: [1] })],
  ['Skill', 'other JSON is none', JSON.stringify([1, 2])],
  ['Skill', 'text is none', 'Loaded skill: deck-guide'],
  ['read', 'another tool is none', payload({})],
  ['Skill', 'a summary of text only', JSON.stringify({ nativeToolSearch: { provider: 'openai', summary: 42 } })],
].map(([toolName, name, result]) => {
  const parsed = parseNativeToolSearchPayload(toolName, result);
  return { name, toolName, result, parsed, content: parsed?.summary ? parsed.summary : result };
});

// The transcript a native-search Skill load leaves: the call, the result as finalize keeps it, the next prompt.
const transcript = ({ content, parsed }) => [
  { role: 'user', content: 'Create a presentation.' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'skill-1', name: 'Skill', arguments: { name: 'deck-guide' } }] },
  { role: 'tool', toolCallId: 'skill-1', content, ...(parsed ? { nativeToolSearch: parsed } : {}) },
  { role: 'user', content: 'Go on.' },
];
const eagerTools = [skillTool, read];
const REQUESTS = PARSE.slice(0, SKILLS.length)
  .filter(({ parsed }) => parsed)
  .flatMap((entry) => {
    const messages = transcript(entry);
    const native = SKILLS.find(({ result }) => result === entry.result);
    return [
      {
        name: `${entry.name}: openai input`,
        wire: 'openai',
        messages: json(messages),
        input: json(buildRequestBody(json(messages), 'gpt-6-astra', eagerTools, { sessionId: 'sess_nts' }).input),
      },
      ...[true, false].map((offered) => ({
        name: `${entry.name}: anthropic messages, tool ${offered ? 'offered' : 'not offered'}`,
        wire: 'anthropic',
        provider: 'anthropic-oauth',
        messages: json(messages),
        offered: [...eagerTools, ...(offered ? [office, patcher].map((t) => ({ ...t, deferLoading: true })) : [])].map((t) => t.name),
        messagesOut: json(toAnthropicMessages(json(messages), [...eagerTools, ...(offered ? [office, patcher].map((t) => ({ ...t, deferLoading: true })) : [])], 'anthropic-oauth')),
      })),
    ].map((request) => ({ ...request, skill: native?.name }));
  });

await writeJsonCompact(tree, join(stage, 'golden.json'), { parse: PARSE, requests: REQUESTS });
writeSetManifest(stage, { set: 'native-tool-search', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`native tool search: ${PARSE.length} parse cases, ${REQUESTS.length} requests`);
