#!/usr/bin/env node
// antigravity-request.test.mjs (hosted search, function-calling mode, the Claude tool-schema handling, Claude replay normalisation and the
// open-loop closure): the real `buildAntigravityRequest` / `antigravityFunctionCallingMode` / `toGeminiRequestTools` over scripted
// messages, tools and replays. Each case records the request pieces the test asserts on (tools, toolConfig, declarations, warnings, contents).
// Not recordable: "Ajv resolves from the root package dependency" (a package.json / node_modules layout check, no product behaviour).
//   node benchmarks/rust-core/recorders/record-antigravity-request.mjs --tree <exact export of b6f10295a>
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-antigravity-request',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/antigravity-request.mjs buildAntigravityRequest(messages, model, tools, opts, project) / antigravityFunctionCallingMode(env), gemini-schema.mjs toGeminiRequestTools. The test\'s asserts are recorded as the values they inspect; the real tool surface (built-in, code-graph, computer, bridge, skill, session) is the input, and every declaration the Claude path produces is recorded whole. Ajv (the tree\'s own dependency) answers the validity / validate() checks.',
  compare: 'mixdog-ai providers/google request.rs (antigravity branch): feed `input` and compare the recorded `result` (`tools`, `toolConfig`, `declarations`, `warnings` in order, `contents` whole). K1 gaps G3 (hosted google_search), G4 (Claude replay normalisation) and the FC-mode env override are OPEN in the core, so those cases are expected to differ.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::google::GoogleAdapter (google/adapter.rs:53), GoogleCodec (google/codec.rs:63) and build_request (google/request.rs:446), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079).",
});
const treeRequire = createRequire(join(rec.tree, 'package.json'));
const Ajv2020 = treeRequire('ajv/dist/2020.js');
const { buildAntigravityRequest, antigravityFunctionCallingMode } = await rec.P('agent/orchestrator/providers/antigravity-request.mjs');
const { toGeminiRequestTools } = await rec.P('agent/orchestrator/providers/gemini-schema.mjs');
const { actionInputUnionFor } = await rec.P('agent/orchestrator/providers/lib/action-input-contract.mjs');
const { BUILTIN_TOOLS } = await rec.P('agent/orchestrator/tools/builtin/builtin-tools.mjs');
const { TOOL_SEARCH_TOOL, TOOL_BRIDGE_TOOLS, SKILL_TOOL, SESSION_TOOL } = await rec.P('agent/orchestrator/runtime-core/tool-defs.mjs');
const { CODE_GRAPH_TOOL_DEFS } = await rec.P('agent/orchestrator/tools/code-graph-tool-defs.mjs');
const { TOOL_DEFS: COMPUTER_TOOL_DEFS } = await rec.P('computer-bridge/tool-defs.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/antigravity-request.test.mjs';
const meta = () => new Ajv2020({ strict: false, validateFormats: false });

const tools = [{ name: 'read', description: 'Read a file.', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }];
const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }];
const toolConfig = (opts) => buildAntigravityRequest(messages, 'gemini-3.8-flash', tools, opts, 'proj').request.toolConfig;

await rec.run('hosted-google-search-ahead-of-declarations', `${SRC}:31`, { nativeTools: [{ type: 'google_search' }], tools }, () => {
  const nativeTools = [{ type: 'google_search' }];
  const build = (toolList, opts) => buildAntigravityRequest(messages, 'gemini-3.8-flash', toolList, opts, 'proj').request;
  return { searchOnly: build(undefined, { nativeTools }), both: build(tools, { nativeTools }), noNative: build(undefined, {}).tools };
});
await rec.run('function-calling-mode-default-env-and-tool-choice', `${SRC}:42`, {}, () => {
  const previous = process.env.MIXDOG_ANTIGRAVITY_FC_MODE;
  const out = { modes: {} };
  for (const env of [{}, { MIXDOG_ANTIGRAVITY_FC_MODE: 'auto' }, { MIXDOG_ANTIGRAVITY_FC_MODE: 'ANY' }, { MIXDOG_ANTIGRAVITY_FC_MODE: 'bogus' }]) out.modes[JSON.stringify(env)] = antigravityFunctionCallingMode(env);
  try {
    delete process.env.MIXDOG_ANTIGRAVITY_FC_MODE;
    out.defaultConfig = toolConfig({});
    process.env.MIXDOG_ANTIGRAVITY_FC_MODE = 'AUTO';
    out.autoConfig = toolConfig({});
    out.noneConfig = toolConfig({ toolChoice: 'none' });
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_ANTIGRAVITY_FC_MODE;
    else process.env.MIXDOG_ANTIGRAVITY_FC_MODE = previous;
  }
  return out;
});

const claudeRequest = (toolList, model = 'claude-sonnet-4-6', opts = {}) => {
  const warnings = [];
  const { request } = buildAntigravityRequest(messages, model, toolList, { onToolExcluded: (exclusion) => warnings.push(exclusion.message), ...opts }, 'proj');
  return { request, warnings, declarations: request.tools?.at(-1)?.functionDeclarations ?? [] };
};
const claudeDeclarations = (toolList, model) => claudeRequest(toolList, model).declarations;
const realToolsByName = new Map([...BUILTIN_TOOLS, TOOL_SEARCH_TOOL, ...CODE_GRAPH_TOOL_DEFS, ...COMPUTER_TOOL_DEFS].map((tool) => [tool.name, tool]));
const realTools = ['find', 'glob', 'grep', 'read', 'code_graph', 'git', 'load_tool', 'computer'].map((name) => realToolsByName.get(name));
const hasUnion = (value) => {
  if (Array.isArray(value)) return value.some(hasUnion);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key === 'anyOf' || key === 'oneOf' || hasUnion(child));
};
const mcp = (name, inputSchema) => ({ name, description: 'd', inputSchema });
const claudeSchema = (inputSchema) => claudeDeclarations([mcp('t', inputSchema)])[0]?.parametersJsonSchema;
const excluded = (inputSchema, name = 't') => { const { declarations, warnings } = claudeRequest([mcp(name, inputSchema)]); return { declarations, warnings }; };
const schemaCase = (id, line, source, extra = () => ({})) => rec.run(id, `${SRC}:${line}`, { inputSchema: source }, () => {
  const before = structuredClone(source);
  const out = { schema: claudeSchema(source), ...extra(source) };
  out.sourceUnchanged = JSON.stringify(source) === JSON.stringify(before);
  return out;
});

const SURFACE = [...BUILTIN_TOOLS, ...CODE_GRAPH_TOOL_DEFS, ...COMPUTER_TOOL_DEFS, ...TOOL_BRIDGE_TOOLS, SKILL_TOOL, SESSION_TOOL];
await rec.run('full-builtin-bridge-surface-sent-as-authored', `${SRC}:84`, { surface: SURFACE, models: ['claude-sonnet-4-6', 'claude-opus-4-6-thinking'] }, () => {
  const surface = SURFACE;
  const before = structuredClone(surface);
  const sonnet = claudeRequest(surface, 'claude-sonnet-4-6');
  const opus = claudeRequest(surface, 'claude-opus-4-6-thinking');
  const validator = meta();
  const rows = sonnet.declarations.map((declaration, i) => {
    const schema = declaration.parametersJsonSchema;
    return { declaration, authoredSchemaUnion: actionInputUnionFor(surface[i].inputSchema), hasParameters: declaration.parameters !== undefined, equalsActionInputUnion: JSON.stringify(schema) === JSON.stringify(actionInputUnionFor(surface[i].inputSchema)), valid2020: validator.validateSchema(schema) === true, rootType: schema.type, rootCombinators: ['anyOf', 'oneOf', 'allOf', 'not'].filter((key) => schema[key] !== undefined) };
  });
  return { surfaceHasUnion: hasUnion(surface.map((tool) => tool.inputSchema)), sonnetWarnings: sonnet.warnings, sonnetEqualsOpus: JSON.stringify(sonnet.declarations) === JSON.stringify(opus.declarations), opusDeclarations: opus.declarations, opusWarnings: opus.warnings, rows, surfaceUnchanged: JSON.stringify(surface) === JSON.stringify(before) };
});
await schemaCase('standard-2020-12-forms-sent-as-written', 115, {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:example:tool', type: 'object',
  properties: { maybe: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] }, nullable: { type: ['string', 'null'] }, multi: { type: ['string', 'number'] }, level: { type: 'integer', enum: [1, 2, 3] }, flag: { const: null }, open: { nullable: true, type: 'string' }, deep: { type: 'array', items: { oneOf: [{ type: 'boolean' }, { type: 'object', properties: {} }] } } },
  additionalProperties: { type: 'string' },
});
await schemaCase('boolean-schemas-recursive-defs-keyword-like-names', 138, {
  type: 'object',
  properties: { examples: { type: 'array', items: { type: 'string' } }, type: { type: 'string', enum: ['a', 'b'] }, items: { type: 'array', items: { type: 'string' } }, definitions: { type: 'string' }, $ref: { type: 'string' }, anyOf: { type: 'string', default: { anyOf: 1 } }, anything: true, never: false, node: { $ref: '#/$defs/Node' } },
  required: ['type'], $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
});
await schemaCase('draft-07-standard-keyword-mapping', 160, {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:example:tool', type: 'object',
  properties: { closed: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }], additionalItems: false }, typed: { type: 'array', items: [{ type: 'string' }], additionalItems: { type: 'number' } }, open: { type: 'array', items: [{ type: 'string' }] }, plain: { type: 'array', items: { type: 'string' } }, ref: { $ref: '#/definitions/Name' }, definitions: { type: 'string' } },
  definitions: { Name: { type: 'string' } }, dependencies: { closed: ['open'], open: { required: ['typed'] }, plain: true },
});
await schemaCase('draft-07-definitions-follow-own-id-scope', 187, {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
  properties: { embedded: { $id: 'urn:example:inner', type: 'object', definitions: { Leaf: { type: 'string' } }, properties: { leaf: { $ref: '#/definitions/Leaf' } } } },
});
await schemaCase('draft-07-keywords-beside-ref-ignored', 207, {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
  properties: { sibling: { $ref: '#/definitions/s', maxLength: 1, description: 'ignored', type: 'integer' }, nested: { type: 'array', items: { anyOf: [{ $ref: '#/definitions/s', minLength: 5 }, { type: 'null' }] } }, deep: { type: 'object', properties: { inner: { $ref: '#/definitions/s', pattern: '^z$' } } }, $ref: { type: 'string', maxLength: 1 }, holder: { type: 'object', properties: { $ref: { type: 'string', minLength: 2 } }, required: ['$ref'] } },
  definitions: { s: { type: 'string' } },
}, (source) => {
  const out = claudeSchema(source);
  const validate = meta().compile(out);
  return { validates: [{ sibling: 'long string', nested: ['abc', null], deep: { inner: 'abc' } }, { sibling: 5 }, { $ref: 'xx' }].map((value) => ({ value, valid: validate(value) })) };
});
await schemaCase('draft-07-definitions-reachable-from-ref-node', 236, {
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
  properties: { x: { $ref: '#/properties/x/definitions/t', definitions: { t: { type: 'string' } }, maxLength: 1 } },
});
await rec.run('invalid-tool-left-out-with-warning-request-proceeds-in-order', `${SRC}:248`, {}, () => {
  const good = (name) => mcp(name, { type: 'object', properties: { x: { type: 'string' } } });
  const { request, warnings, declarations } = claudeRequest([good('first'), mcp('badtype', { type: 'object', properties: { a: { type: 'bogus-type' } } }), good('second'), mcp('missing', { type: 'object', properties: { value: { $ref: '#/$defs/Absent' } } }), good('third')], 'claude-sonnet-4-6', { nativeTools: [{ type: 'google_search' }] });
  return { declarations, firstTool: request.tools[0], toolConfig: request.toolConfig, warnings };
});
const branch = { type: 'object', properties: { a: { type: 'string' } } };
await rec.run('provider-forbidden-roots-exclude-the-tool', `${SRC}:279`, {}, () => Object.fromEntries([
  ['allOf', { type: 'object', allOf: [branch] }], ['anyOf', { type: 'object', anyOf: [branch] }], ['oneOf', { type: 'object', oneOf: [branch] }], ['not', { type: 'object', properties: {}, not: {} }],
  ['rootAnyOfNoType', { anyOf: [branch] }], ['stringRoot', { type: 'string' }], ['refRoot', { $ref: '#/$defs/A', $defs: { A: branch } }], ['undefinedSchema', undefined], ['trueSchema', true],
].map(([name, schema]) => [name, excluded(schema)])));
await rec.run('schemas-invalid-under-their-dialect-excluded', `${SRC}:292`, {}, () => Object.fromEntries([
  ['duplicateRequired', { type: 'object', required: ['a', 'a'] }], ['bogusType', { type: 'object', properties: { a: { type: 'bogus-type' } } }], ['remoteRef', { type: 'object', properties: { a: { $ref: 'https://example.invalid/a.json' } } }],
  ['draft07TupleBoth', { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { a: { items: [{}], prefixItems: [{}] } } }],
].map(([name, schema]) => [name, excluded(schema)])));
await rec.run('every-tool-invalid-request-carries-no-tools', `${SRC}:312`, {}, () => { const { request, warnings } = claudeRequest([mcp('bad', { anyOf: [] })]); return { warnings, tools: request.tools, toolConfig: request.toolConfig }; });
await rec.run('default-warning-channel-console-warn-once-per-problem', `${SRC}:319`, {}, () => {
  const originalWarn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args[0]);
  try {
    const bad = mcp('warn_once_tool', { type: 'object', properties: {}, allOf: [{}] });
    buildAntigravityRequest(messages, 'claude-sonnet-4-6', [bad], {}, 'proj');
    buildAntigravityRequest(messages, 'claude-sonnet-4-6', [bad], {}, 'proj');
  } finally {
    console.warn = originalWarn;
  }
  return { warned };
});
await rec.run('missing-schema-excludes-tool-order-kept', `${SRC}:329`, {}, () => ({ declarations: claudeDeclarations([mcp('b', { type: 'object', properties: {} }), mcp('a', { type: 'object', properties: { x: { type: 'string' } } })]) }));
await rec.run('gemini-declarations-unchanged-by-claude-normalization', `${SRC}:340`, { tools: realTools }, () => {
  const expected = toGeminiRequestTools(realTools, undefined).at(-1).functionDeclarations;
  const actual = claudeDeclarations(realTools, 'gemini-3.8-flash');
  return { equal: JSON.stringify(actual) === JSON.stringify(expected), hasUnion: hasUnion(actual), declarations: actual, geminiProjection: expected };
});
await rec.run('computer-per-action-alternatives-claude-flat-for-gemini', `${SRC}:355`, {}, () => {
  const computer = realToolsByName.get('computer');
  const actions = computer.inputSchema.properties.action.enum;
  const [claude] = claudeDeclarations([computer], 'claude-sonnet-4-6');
  const schema = claude.parametersJsonSchema;
  const validator = meta();
  const validate = validator.compile(schema);
  const [gemini] = claudeDeclarations([computer], 'gemini-3.8-flash');
  const flat = gemini.parametersJsonSchema.properties.input;
  return {
    claude: { declaration: claude, valid2020: validator.validateSchema(schema), rootCombinators: ['anyOf', 'oneOf', 'allOf', 'not'].filter((key) => schema[key] !== undefined), alternativeTitlesEqualActions: JSON.stringify(schema.properties.input.anyOf.map((a) => a.title).sort()) === JSON.stringify([...actions].sort()), validates: [{ action: 'list', input: { kind: 'windows' } }, { action: 'list', input: { kind: 'windows', bogus: 1 } }].map((value) => ({ value, valid: validate(value) })) },
    gemini: { flatHasAnyOf: flat.anyOf !== undefined, flatHasKindActionsOperation: Boolean(flat.properties.kind && flat.properties.actions && flat.properties.operation) },
  };
});

// ---- Claude replay ----
const CLAUDE = 'claude-sonnet-4-6';
const GEMINI = 'gemini-3.8-flash';
const THINKING = 'claude-opus-4-6-thinking';
const SENTINEL = 'skip_thought_signature_validator';
const replayOf = (items, model, provider = 'antigravity') => ({ version: 1, provider, items, ...(model ? { requestContext: { model } } : {}) });
const contentsOf = (history, model, toolList = BUILTIN_TOOLS, opts = {}) => buildAntigravityRequest(history, model, toolList, opts).request.contents;
const toolTurn = (assistant, id = 'toolu_9') => [{ role: 'user', content: 'go' }, { ...assistant, toolCalls: [{ id, name: 'glob', arguments: { pattern: '*' } }] }, { role: 'tool', toolCallId: id, content: 'ok' }, { role: 'user', content: 'next' }];
const call = (id = 'toolu_9') => ({ functionCall: { name: 'glob', args: { pattern: '*' }, id } });
const both = (history, models = [CLAUDE, GEMINI]) => Object.fromEntries(models.map((model) => [model, contentsOf(history, model, BUILTIN_TOOLS)]));

await rec.run('claude-replay-drops-empty-text-parts-around-tool-call', `${SRC}:395`, {}, () => {
  const recorded = [{ text: '' }, { functionCall: { name: 'glob', args: { pattern: '*.md' }, id: 'toolu_1' } }, { text: '' }, { text: '', thoughtSignature: 'sig' }];
  const history = (model) => [{ role: 'user', content: 'find markdown' }, { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'glob', arguments: { pattern: '*.md' } }], providerReplay: { version: 1, provider: 'antigravity', items: recorded, requestContext: { model } } }, { role: 'tool', toolCallId: 'toolu_1', content: 'README.md' }];
  return { claude: contentsOf(history('claude-sonnet-5-5-low'), 'claude-sonnet-5-5-low'), gemini: contentsOf(history(GEMINI), GEMINI) };
});
await rec.run('claude-turn-of-only-empty-parts-omitted', `${SRC}:424`, {}, () => {
  const history = (model) => [{ role: 'user', content: 'first' }, { role: 'assistant', content: '', providerReplay: { version: 1, provider: 'antigravity', items: [{ text: '' }, { text: '' }], requestContext: { model } } }, { role: 'user', content: 'second' }];
  return { claude: contentsOf(history('claude-sonnet-5-5-low'), 'claude-sonnet-5-5-low', []), gemini: contentsOf(history(GEMINI), GEMINI, []) };
});
await rec.run('claude-replay-rejoins-streamed-thinking-deltas', `${SRC}:452`, {}, () => {
  const recorded = [{ text: '' }, { thought: true, text: 'first ' }, { thought: true, text: 'second' }, { thought: true, text: '', thoughtSignature: 'sig-a' }, { thought: true, text: 'next block', thoughtSignature: 'sig-b' }, { text: 'answer ' }, { text: 'text' }, { functionCall: { name: 'glob', args: { pattern: '*.md' }, id: 'toolu_2' } }, { text: '' }];
  const history = (model) => [{ role: 'user', content: 'find markdown' }, { role: 'assistant', content: 'answer text', toolCalls: [{ id: 'toolu_2', name: 'glob', arguments: { pattern: '*.md' } }], providerReplay: { version: 1, provider: 'antigravity', items: recorded, requestContext: { model } } }, { role: 'tool', toolCallId: 'toolu_2', content: 'README.md' }];
  return { claude: contentsOf(history('claude-sonnet-5-5-low'), 'claude-sonnet-5-5-low'), gemini: contentsOf(history(GEMINI), GEMINI) };
});
await rec.run('plain-history-without-provider-replay-drops-thinking-for-claude', `${SRC}:512`, {}, () => both(toolTurn({ role: 'assistant', content: 'answer', providerMetadata: { gemini: { thoughtParts: [{ text: 'because', thoughtSignature: 'unknown-origin' }] } } })));
await rec.run('replay-from-another-family-or-provider-drops-thinking-and-signatures', `${SRC}:526`, {}, () => {
  const items = [{ thought: true, text: 'gemini thought', thoughtSignature: 'gemini-sig' }, { text: 'answer', thoughtSignature: 'gemini-text-sig' }, { ...call(), thoughtSignature: 'gemini-call-sig' }];
  return { variants: [replayOf(items, 'gemini-3.1-pro-high'), replayOf(items, 'gemini-3.1-pro-high', 'gemini'), replayOf(items, undefined, 'gemini')].map((providerReplay) => ({ providerReplay, claude: contentsOf(toolTurn({ role: 'assistant', content: 'answer', providerReplay }), CLAUDE) })) };
});
await rec.run('interrupted-thought-run-dropped-for-claude-sentinel-for-gemini', `${SRC}:548`, {}, () => {
  const history = (model) => toolTurn({ role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'cut ' }, { thought: true, text: 'off' }, { text: '' }, call()], model) });
  return { claude: contentsOf(history(CLAUDE), CLAUDE), gemini: contentsOf(history(GEMINI), GEMINI) };
});
await rec.run('recorded-sentinel-or-empty-signature-is-not-own', `${SRC}:568`, {}, () => ({ claude: contentsOf(toolTurn({ role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'a', thoughtSignature: SENTINEL }, { thought: true, text: 'b', thoughtSignature: '' }, call()], CLAUDE) }), CLAUDE) }));
await rec.run('thinking-only-claude-turn-unsigned-omitted-signed-kept', `${SRC}:582`, {}, () => {
  const history = (items, model) => [{ role: 'user', content: 'first' }, { role: 'assistant', content: '', providerReplay: replayOf(items, model) }, { role: 'user', content: 'second' }];
  const unsigned = [{ thought: true, text: 'thinking' }, { text: '' }];
  const signed = [{ thought: true, text: 'thinking' }, { thought: true, text: '', thoughtSignature: 'sig' }];
  return { unsignedClaude: contentsOf(history(unsigned, CLAUDE), CLAUDE, []), signedClaude: contentsOf(history(signed, CLAUDE), CLAUDE), unsignedGemini: contentsOf(history(unsigned, GEMINI), GEMINI) };
});
await rec.run('thinking-after-tool-call-keeps-signed-run-drops-unsigned', `${SRC}:609`, {}, () => ({ claude: contentsOf(toolTurn({ role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'before', thoughtSignature: 'sig-1' }, call(), { thought: true, text: 'after ' }, { thought: true, text: 'call' }, { thought: true, text: '', thoughtSignature: 'sig-2' }, { thought: true, text: 'tail without signature' }], CLAUDE) }), CLAUDE) }));
await rec.run('thought-runs-never-merge-across-messages-or-part-types', `${SRC}:633`, {}, () => ({ claude: contentsOf([{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_a', name: 'glob', arguments: { pattern: '*' } }], providerReplay: replayOf([{ thought: true, text: 'unsigned head' }, call('toolu_a')], CLAUDE) }, { role: 'tool', toolCallId: 'toolu_a', content: 'ok' }, { role: 'assistant', content: 'done', providerReplay: replayOf([{ thought: true, text: 'split ' }, { text: 'interleaved' }, { thought: true, text: 'run', thoughtSignature: 'sig-b' }], CLAUDE) }, { role: 'user', content: 'next' }], CLAUDE) }));

const openLoop = (assistant) => [
  { role: 'user', content: 'earlier' },
  { role: 'assistant', content: 'earlier answer', providerReplay: replayOf([{ thought: true, text: 'old', thoughtSignature: 'sig-old' }, { text: 'earlier answer' }], THINKING) },
  { role: 'user', content: 'go' },
  { ...assistant, toolCalls: [{ id: 'toolu_9', name: 'glob', arguments: { pattern: '*' } }] },
  { role: 'tool', toolCallId: 'toolu_9', content: 'ok' },
];
await rec.run('open-loop-without-thinking-closed-with-fresh-turn-wire-only', `${SRC}:700`, {}, () => {
  const cases = { interrupted: { role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'cut' }, call()], THINKING) }, foreign: { role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'g', thoughtSignature: 'gemini-sig' }, call()], 'gemini-3.1-pro-high') }, compacted: { role: 'assistant', content: '' } };
  const out = {};
  for (const [name, assistant] of Object.entries(cases)) {
    const history = openLoop(assistant);
    const snapshot = JSON.stringify(history);
    out[name] = { contents: contentsOf(history, THINKING), historyUnchanged: JSON.stringify(history) === snapshot };
  }
  return out;
});
await rec.run('signed-loop-no-open-loop-thinking-off-and-gemini-left-as-built', `${SRC}:738`, {}, () => {
  const signed = openLoop({ role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'plan', thoughtSignature: 'sig-plan' }, call()], THINKING) });
  const compacted = openLoop({ role: 'assistant', content: '' });
  const answered = [...compacted, { role: 'assistant', content: 'done' }, { role: 'user', content: 'next' }];
  return { signed: contentsOf(signed, THINKING), answered: contentsOf(answered, THINKING), sonnet: contentsOf(compacted, CLAUDE), sonnetEffortHigh: contentsOf(compacted, CLAUDE, BUILTIN_TOOLS, { effort: 'high' }), gemini: contentsOf(compacted, GEMINI) };
});
await rec.run('later-steps-keep-closure-and-fresh-turn-keeps-signed-thinking', `${SRC}:782`, {}, () => ({ contents: contentsOf([...openLoop({ role: 'assistant', content: '' }), { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_10', name: 'glob', arguments: { pattern: '*.md' } }], providerReplay: replayOf([{ thought: true, text: 'fresh', thoughtSignature: 'sig-fresh' }, { functionCall: { name: 'glob', args: { pattern: '*.md' }, id: 'toolu_10' } }], THINKING) }, { role: 'tool', toolCallId: 'toolu_10', content: 'README.md' }], THINKING) }));
await rec.finish();
