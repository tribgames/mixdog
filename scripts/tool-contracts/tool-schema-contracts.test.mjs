// Model-facing tool schema contracts. Assertions pin structure the runtime or
// the model depends on (names, per-role surfaces, required fields, types,
// enums, defaults, bounds, additionalProperties, valid schemas, present
// descriptions) — never description wording, so editing tool copy cannot
// break this suite. The only literals matched in text are the ones a parser
// or the model must echo, each marked with why.
import './_env.mjs';
import test from 'node:test';
import Ajv from 'ajv';
import { resolveSearchPlan } from '../../src/runtime/memory/lib/query-search-plan.mjs';
import { smokeCatalog, fullDefaults } from './_catalog.mjs';
import {
  compactToolSearchDescription,
  defaultDeferredToolNames,
  SKILL_TOOL,
  TOOL_SEARCH_TOOL,
} from '../../src/mixdog-session-runtime.mjs';
import { SESSION_TOOL } from '../../src/session-runtime/tool-defs.mjs';
import { AGENT_TOOL } from '../../src/standalone/agent-tool.mjs';
import { BUILTIN_TOOLS } from '../../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
import { PATCH_TOOL_DEFS } from '../../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { TOOL_DEFS as MEMORY_TOOL_DEFS } from '../../src/runtime/memory/tool-defs.mjs';
import { TOOL_DEFS as WEB_SEARCH_TOOL_DEFS } from '../../src/runtime/web-search/tool-defs.mjs';
import { REACTION_TOOL_DEFS } from '../../src/runtime/agent/orchestrator/runtime-core/reaction-tool-defs.mjs';

function assertHas(set, name) {
  if (!set.has(name)) throw new Error(`default tool surface missing ${name}: ${[...set].join(', ')}`);
}

function assertLacks(set, name) {
  if (set.has(name)) throw new Error(`default tool surface should not include ${name}: ${[...set].join(', ')}`);
}

// Size of a tool's model-facing text (description + schema) in characters.
function toolSchemaSize(tool) {
  const desc = String(tool?.description || '');
  const schema = JSON.stringify(tool?.input_schema || tool?.inputSchema || {});
  return desc.length + schema.length;
}

// Walk a JSON schema and return the dotted path of every declared property
// (including those inside anyOf/items/nested objects) lacking a description.
function undescribedProperties(schema, path, out = []) {
  if (!schema || typeof schema !== 'object') return out;
  for (const [key, child] of Object.entries(schema.properties || {})) {
    if (!String(child?.description || '').trim()) out.push(`${path}.${key}`);
    undescribedProperties(child, `${path}.${key}`, out);
  }
  for (const container of ['anyOf', 'oneOf', 'allOf']) {
    for (const branch of schema[container] || []) undescribedProperties(branch, path, out);
  }
  if (schema.items) undescribedProperties(schema.items, path, out);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    undescribedProperties(schema.additionalProperties, path, out);
  }
  return out;
}

test('description walker reports a missing description inside every schema container', () => {
  const bare = { type: 'object', properties: { inner: { type: 'string' } } };
  for (const [container, schema] of [
    ['properties', { properties: { outer: { type: 'object', description: 'd', properties: { inner: { type: 'string' } } } } }],
    ['items', { items: bare }],
    ['anyOf', { anyOf: [bare] }],
    ['oneOf', { oneOf: [bare] }],
    ['allOf', { allOf: [bare] }],
    ['additionalProperties', { additionalProperties: bare }],
  ]) {
    const found = undescribedProperties(schema, 't');
    if (!found.some((entry) => entry.endsWith('.inner'))) {
      throw new Error(`walker missed an undescribed parameter inside ${container}: ${JSON.stringify(found)}`);
    }
  }
  if (undescribedProperties({ properties: { ok: { type: 'string', description: 'd' } } }, 't').length) {
    throw new Error('walker must not report described parameters');
  }
});

test('every model-facing tool and parameter has a description and a valid schema', () => {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const tools = [...smokeCatalog, ...REACTION_TOOL_DEFS];
  const missing = [];
  for (const tool of tools) {
    const schema = tool.inputSchema || tool.input_schema;
    if (!String(tool.name || '').trim()) throw new Error(`tool without a name: ${JSON.stringify(tool).slice(0, 80)}`);
    if (!String(tool.description || '').trim()) missing.push(tool.name);
    if (schema?.type !== 'object') throw new Error(`${tool.name} input schema must be an object schema`);
    if (!ajv.validateSchema(schema)) throw new Error(`${tool.name} schema invalid: ${JSON.stringify(ajv.errors)}`);
    missing.push(...undescribedProperties(schema, tool.name));
  }
  // Pre-existing product gaps (reported, not hidden): fix the copy, then delete
  // the entry. Any parameter outside this list lacking a description fails.
  const knownGaps = new Set([
    'read.file_path.file_path',
    'read.file_path.offset',
    'read.file_path.limit',
    'edit.file_path',
    'grep.offset',
    'glob.offset',
    'list.offset',
    ...[
      'action',
      'page',
      'limit',
      'title',
      'body',
      'description',
      'visibility',
      'labels',
      'assignees',
      'base',
      'head',
      'method',
      'event',
      'tag',
      'draft',
      'prerelease',
    ].map((key) => `github.${key}`),
  ]);
  // Exact match: a new gap fails, and so does a fixed gap whose entry is stale.
  const observed = [...new Set(missing)].sort();
  const expected = [...knownGaps].sort();
  const newGaps = observed.filter((entry) => !knownGaps.has(entry));
  const staleEntries = expected.filter((entry) => !observed.includes(entry));
  if (newGaps.length || staleEntries.length) {
    throw new Error(
      `description gaps differ from knownGaps; new: [${newGaps.join(', ')}] stale (remove from knownGaps): [${staleEntries.join(', ')}]`
    );
  }
  const names = tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) throw new Error(`duplicate tool names: ${names.join(', ')}`);
});

test('shell, edit, and task keep their execution contracts', () => {
  const shellTool = BUILTIN_TOOLS.find((tool) => tool.name === 'shell');
  const editTool = BUILTIN_TOOLS.find((tool) => tool.name === 'edit');
  const editProps = editTool?.inputSchema?.properties || {};
  if (
    !editTool ||
    JSON.stringify(editTool.inputSchema?.required) !== JSON.stringify(['file_path', 'old_string', 'new_string']) ||
    editProps.file_path?.minLength !== undefined ||
    editProps.replace_all?.default !== false ||
    editTool.inputSchema?.additionalProperties !== false ||
    editProps.old_string?.type !== 'string' ||
    editProps.new_string?.type !== 'string' ||
    // empty old_string (create) and empty new_string (delete) must stay legal
    editProps.old_string?.minLength !== undefined ||
    editProps.new_string?.minLength !== undefined ||
    editProps.replace_all?.type !== 'boolean'
  ) {
    throw new Error(`edit tool must preserve the exact-string contract: ${JSON.stringify(editTool)}`);
  }
  const shellProps = shellTool?.inputSchema?.properties || {};
  if (
    JSON.stringify(Object.keys(shellProps)) !==
      JSON.stringify(['command', 'cwd', 'timeout_ms', 'wait_ms', 'background']) ||
    shellProps.command?.minLength !== undefined
  ) {
    throw new Error(
      `shell schema must expose only command, optional cwd, timeout_ms, wait_ms and background: ${JSON.stringify(shellProps)}`
    );
  }
  // timeout_ms is DECLARED in the model-facing schema (the schema states the
  // contract) while the default stays "no deadline" — the description and
  // rules both steer models to omit it.
  if (
    shellProps.timeout_ms?.type !== 'integer' ||
    shellProps.timeout_ms?.minimum !== 0 ||
    shellProps.timeout_ms?.default !== undefined
  ) {
    throw new Error(
      `shell timeout_ms must declare the no-deadline-by-default contract: ${JSON.stringify(shellProps.timeout_ms)}`
    );
  }
  const publicTaskTool = BUILTIN_TOOLS.find((tool) => tool.name === 'task');
  const publicTaskProps = publicTaskTool?.inputSchema?.properties || {};
  if (
    JSON.stringify(Object.keys(publicTaskProps)) !== JSON.stringify(['task_id', 'action', 'timeout_ms', 'output']) ||
    JSON.stringify(publicTaskProps.action?.enum) !== JSON.stringify(['list', 'read', 'wait', 'cancel']) ||
    publicTaskProps.task_id?.minLength !== undefined ||
    publicTaskProps.timeout_ms?.minimum !== 0
  ) {
    throw new Error('task schema must expose list/read/wait/cancel with a wait ceiling and no polling parameters');
  }
  if (JSON.stringify(publicTaskTool?.inputSchema?.required) !== JSON.stringify(['action'])) {
    throw new Error('task schema must require an explicit action');
  }
});

test('default deferred tool surfaces per mode stay fixed and bounded', () => {
  if (fullDefaults.size !== 10) {
    throw new Error(
      `full default catalog should contain both edit dialects (10 tools), got ${fullDefaults.size}: ${[...fullDefaults].join(', ')}`
    );
  }
  for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'apply_patch', 'Skill', 'load_tool']) {
    assertHas(fullDefaults, name);
  }
  for (const name of ['shell', 'task', 'agent', 'recall', 'web_search', 'web_fetch', 'session', 'github']) {
    assertLacks(fullDefaults, name);
  }

  const leadDefaults = defaultDeferredToolNames(smokeCatalog, 'lead');
  // recall / web_search / goal left the lead defaults with cwd and web_fetch
  // (2 measured calls each in the trace window); they auto-load on demand.
  if (leadDefaults.size !== 14) {
    throw new Error(
      `lead default catalog should contain both edit dialects and git (14 tools), got ${leadDefaults.size}: ${[...leadDefaults].join(', ')}`
    );
  }
  for (const name of [
    'read',
    'code_graph',
    'grep',
    'find',
    'glob',
    'list',
    'git',
    'shell',
    'task',
    'apply_patch',
    'agent',
    'Skill',
    'load_tool',
  ]) {
    assertHas(leadDefaults, name);
  }
  for (const name of ['recall', 'web_search', 'web_fetch', 'session', 'github', 'session_manage']) {
    assertLacks(leadDefaults, name);
  }
  if (TOOL_SEARCH_TOOL.annotations?.agentHidden !== true) {
    throw new Error(
      'tool_search must stay Lead-only / standalone-only; agent sessions keep fixed schemas without deferred loading'
    );
  }

  // Budget contract (standing rule: the default model-facing prompt must not
  // grow). Upper bounds only; measured size must be at or below the cap.
  const surfaceSize = [...fullDefaults].reduce(
    (sum, name) => sum + toolSchemaSize(smokeCatalog.find((item) => item?.name === name)),
    0
  );
  if (surfaceSize > 17000) {
    throw new Error(`full default tool surface too large: ${surfaceSize} chars (cap 17000)`);
  }
  for (const [name, cap] of [
    ['apply_patch', 1600],
    ['agent', 2500],
    ['recall', 2400],
    ['web_search', 3200],
    ['web_fetch', 900],
    ['load_tool', 900],
  ]) {
    const size = toolSchemaSize(smokeCatalog.find((item) => item?.name === name));
    if (size > cap) throw new Error(`${name} schema/description too large: ${size} chars (cap ${cap})`);
  }

  const readonlyDefaults = defaultDeferredToolNames(smokeCatalog, 'readonly');
  if (readonlyDefaults.size !== 8) {
    throw new Error(
      `readonly default surface should stay 8 tools, got ${readonlyDefaults.size}: ${[...readonlyDefaults].join(', ')}`
    );
  }
  for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'Skill', 'load_tool']) {
    assertHas(readonlyDefaults, name);
  }
  for (const name of ['apply_patch', 'agent', 'shell', 'git']) {
    assertLacks(readonlyDefaults, name);
  }
});

test('react stays a bot-only Lead default', () => {
  const [react] = REACTION_TOOL_DEFS;
  const props = react.inputSchema.properties;
  if (
    react.name !== 'react' ||
    Object.keys(props).join(',') !== 'emoji,messages_back,remove' ||
    react.inputSchema.additionalProperties !== false ||
    react.inputSchema.required !== undefined ||
    react.annotations?.agentHidden !== true
  ) {
    throw new Error(`react schema drifted: ${JSON.stringify(react)}`);
  }
  // Budget contract: react is a Lead default, so it must not grow the default prompt.
  if (toolSchemaSize(react) > 1200) {
    throw new Error(`react schema/description too large: ${toolSchemaSize(react)} chars (cap 1200)`);
  }
  const leadDefaults = defaultDeferredToolNames([...smokeCatalog, react], 'lead');
  assertHas(leadDefaults, 'react');
  assertLacks(defaultDeferredToolNames([...smokeCatalog, react], 'full'), 'react');
  assertLacks(defaultDeferredToolNames([...smokeCatalog, react], 'readonly'), 'react');
});

test('agent schema hides execution controls and rejects hidden fields', () => {
  const agentProps = AGENT_TOOL.inputSchema?.properties || {};
  if (agentProps.mode || agentProps.wait || agentProps.sessionId) {
    throw new Error('agent schema should not expose execution mode controls or raw session ids');
  }
  if (
    AGENT_TOOL.inputSchema?.required?.join(',') !== 'type' ||
    agentProps.type?.type !== 'string'
  ) {
    throw new Error('agent schema must require a string type');
  }
  for (const name of ['task_id', 'agent', 'tag', 'prompt', 'message', 'file', 'cwd', 'context']) {
    if (agentProps[name]?.minLength !== undefined) {
      throw new Error(`agent schema field ${name} must reject empty strings`);
    }
  }
  if (AGENT_TOOL.inputSchema?.additionalProperties !== false) {
    throw new Error('agent schema must reject hidden or misspelled fields');
  }
});

test('apply_patch model contract stays a single-string custom grammar tool', () => {
  const patchTool = PATCH_TOOL_DEFS[0];
  // Function-only compatibility keeps only a non-empty patch string; OpenAI
  // custom tools receive the Lark grammar directly.
  if (
    patchTool?.inputSchema?.properties?.patch?.type !== 'string' ||
    patchTool?.inputSchema?.properties?.patch?.minLength !== 1
  ) {
    throw new Error('apply_patch JSON fallback must expose one non-empty V4A patch string');
  }
  if (
    Object.keys(patchTool?.inputSchema?.properties || {}).join(',') !== 'patch' ||
    JSON.stringify(patchTool?.inputSchema?.required || []) !== '["patch"]'
  ) {
    throw new Error(`apply_patch JSON fallback must expose only patch: ${JSON.stringify(patchTool?.inputSchema)}`);
  }
  if (patchTool?.title !== 'Apply Patch' || patchTool?.annotations?.title !== 'Apply Patch') {
    throw new Error(`apply_patch titles drifted: ${JSON.stringify(patchTool)}`);
  }
  if (
    !String(patchTool?.freeformDescription || '').trim() ||
    patchTool?.freeform?.type !== 'grammar' ||
    patchTool?.freeform?.syntax !== 'lark'
  ) {
    throw new Error(`apply_patch must expose freeform grammar metadata: ${JSON.stringify(patchTool)}`);
  }
  for (const requiredGrammarLine of [
    'start: begin_patch hunk+ end_patch',
    'begin_patch: "*** Begin Patch" LF',
    'add_hunk: "*** Add File: " filename LF add_line+',
    'change_move: "*** Move to: " filename LF',
    'end_patch: "*** End Patch" LF?',
    '%import common.LF',
  ]) {
    if (!patchTool.freeform.definition.includes(requiredGrammarLine)) {
      throw new Error(`apply_patch freeform grammar missing required line: ${requiredGrammarLine}`);
    }
  }
});

test('read schema exposes canonical scalar and batch windows', () => {
  const readTool = BUILTIN_TOOLS.find((tool) => tool.name === 'read');
  const readSchema = readTool?.inputSchema || {};
  const readProps = readSchema.properties || {};
  if (
    readProps.file_path?.anyOf?.[0]?.type !== 'string' ||
    readProps.file_path?.minLength !== undefined ||
    readProps.file_path?.anyOf?.[1]?.type !== 'array' ||
    readProps.path ||
    JSON.stringify(readSchema.required) !== JSON.stringify(['file_path'])
  ) {
    throw new Error('read schema must expose canonical file_path with explicit batch support');
  }
  if (
    readProps.offset?.type !== 'integer' ||
    readProps.offset?.minimum !== 1 ||
    readProps.limit?.type !== 'integer' ||
    readProps.limit?.minimum !== 1
  ) {
    throw new Error('read range args must use the scalar integer contract');
  }
  if (
    Object.keys(readProps).some((key) => !['file_path', 'offset', 'limit', 'pages'].includes(key)) ||
    readSchema.additionalProperties !== false
  ) {
    throw new Error('read schema must not expose legacy arguments');
  }
  if (readProps.pages?.type !== 'string') {
    throw new Error('read must expose the PDF pages range as a string');
  }
});

test('code_graph schema keeps blank-target rejection and result/depth bounds', () => {
  const codeGraphProps = CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties || {};
  const codeGraphFileShapes = codeGraphProps.files?.anyOf || [];
  const codeGraphSymbolShapes = codeGraphProps.symbols?.anyOf || [];
  const codeGraphFileStringShape = codeGraphFileShapes.find((shape) => shape?.type === 'string');
  const codeGraphFileArrayShape = codeGraphFileShapes.find((shape) => shape?.type === 'array');
  const codeGraphSymbolStringShape = codeGraphSymbolShapes.find((shape) => shape?.type === 'string');
  const codeGraphSymbolArrayShape = codeGraphSymbolShapes.find((shape) => shape?.type === 'array');
  if (
    codeGraphFileStringShape?.minLength !== undefined ||
    codeGraphFileArrayShape?.minItems !== undefined ||
    codeGraphFileArrayShape?.items?.minLength !== undefined ||
    codeGraphSymbolStringShape?.minLength !== undefined ||
    codeGraphSymbolArrayShape?.minItems !== undefined ||
    codeGraphSymbolArrayShape?.items?.minLength !== undefined ||
    codeGraphProps.cwd?.minLength !== undefined ||
    codeGraphProps.limit?.maximum !== 500
  ) {
    throw new Error('code_graph schema must reject blank targets and expose runtime result/depth bounds');
  }
  for (const [label, schema] of [
    ['code_graph.limit', codeGraphProps.limit],
    ['code_graph.depth', codeGraphProps.depth],
  ]) {
    if (schema?.type !== 'integer') throw new Error(`${label} must expose integer schema: ${JSON.stringify(schema)}`);
  }
});

test('recall schema keeps fan-out, paging, and expansion contracts', () => {
  const recallTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'recall');
  const recallProps = recallTool?.inputSchema?.properties || {};
  const recallQueryShapes = recallProps.query?.anyOf || [];
  const recallQueryStringShape = recallQueryShapes.find((shape) => shape?.type === 'string');
  const recallQueryArrayShape = recallQueryShapes.find((shape) => shape?.type === 'array');
  const recallIdShapes = recallProps.id?.anyOf || [];
  const recallIdStringShape = recallIdShapes.find((shape) => shape?.type === 'integer');
  const recallIdArrayShape = recallIdShapes.find((shape) => shape?.type === 'array');
  if (!recallProps.id?.anyOf) {
    throw new Error('recall schema must preserve the id lookup shape');
  }
  if (
    recallQueryStringShape?.minLength !== undefined ||
    recallQueryArrayShape?.minItems !== undefined ||
    recallQueryArrayShape?.maxItems !== 5 ||
    recallQueryArrayShape?.items?.minLength !== undefined ||
    recallIdStringShape?.minimum !== 1 ||
    recallIdArrayShape?.minItems !== undefined ||
    recallIdArrayShape?.items?.type !== 'integer' ||
    recallIdArrayShape?.items?.minimum !== 1 ||
    recallProps.projectScope?.type !== 'string'
  ) {
    throw new Error('recall schema must expose fan-out query shapes and the project scope filter');
  }
  if (
    recallProps.limit?.type !== 'integer' ||
    recallProps.limit?.minimum !== 1 ||
    recallProps.limit?.maximum !== 100 ||
    recallProps.offset?.type !== 'integer' ||
    recallProps.offset?.minimum !== 0 ||
    recallProps.offset?.maximum !== 500
  ) {
    throw new Error('recall schema must expose runtime paging bounds');
  }
  // Cross-session / raw recall surface: summary-only is the default; expansion
  // into chunk members or unchunked raw/episode turns is explicit.
  if (recallProps.includeMembers?.default !== false || recallProps.includeMembers?.type !== 'boolean') {
    throw new Error('recall includeMembers must be an opt-in boolean');
  }
  if (recallProps.includeRaw?.default !== false || recallProps.includeRaw?.type !== 'boolean') {
    throw new Error('recall includeRaw must be an opt-in boolean');
  }
  if (recallProps.includeArchived?.type !== 'boolean' || recallProps.sessionOnly) {
    throw new Error('recall schema must expose includeArchived and keep sessionOnly private');
  }
  // The schema declares no default for includeArchived, so cover the runtime
  // default (archived included unless explicitly false) through the search plan.
  const planFor = (extra) => resolveSearchPlan({ query: 'x', projectScope: 'all', ...extra }, () => null);
  if (planFor({}).includeArchived !== true || planFor({}).excludeStatuses.length !== 0) {
    throw new Error('recall without includeArchived must include archived items');
  }
  if (planFor({ includeArchived: false }).excludeStatuses.join(',') !== 'archived') {
    throw new Error('recall includeArchived:false must exclude archived items');
  }
});

test('session and memory schemas stay minimal and direct', () => {
  const sessionProps = SESSION_TOOL.inputSchema?.properties || {};
  if (
    SESSION_TOOL.name !== 'session' ||
    SESSION_TOOL.title !== 'Session' ||
    SESSION_TOOL.annotations?.title !== 'Session' ||
    SESSION_TOOL.annotations?.agentHidden !== true ||
    SESSION_TOOL.annotations?.destructiveHint !== true ||
    Object.keys(sessionProps).join(',') !==
      'action,title,key,session_id,prompt,to,limit,cursor,include_agents,include_archived,offset,text_offset,item_id,path,compact,value,brief,project,worktree,confirm_large,model,effort,notify,attachments' ||
    sessionProps.effort?.type !== 'string' ||
    sessionProps.worktree?.type !== 'object' ||
    sessionProps.worktree?.additionalProperties !== false ||
    sessionProps.worktree?.required?.join(',') !== 'mode' ||
    sessionProps.worktree?.properties?.mode?.enum?.join(',') !== 'branch,worktree' ||
    sessionProps.worktree?.properties?.name?.type !== 'string' ||
    sessionProps.confirm_large?.type !== 'boolean' ||
    sessionProps.to?.type !== 'string' ||
    sessionProps.include_agents?.type !== 'boolean' ||
    sessionProps.include_archived?.type !== 'boolean' ||
    sessionProps.attachments?.type !== 'array' ||
    sessionProps.action?.enum?.join(',') !==
      'status,list,bots,read,send,cancel,delete,create,rename,compact,fork,set-project,list-projects,favorite,archive,suggest' ||
    sessionProps.session_id?.type !== 'string' ||
    sessionProps.limit?.minimum !== 1 ||
    sessionProps.limit?.maximum !== 100 ||
    sessionProps.path?.minLength !== undefined ||
    sessionProps.path?.type !== 'string' ||
    sessionProps.compact?.type !== 'boolean' ||
    sessionProps.value?.type !== 'boolean' ||
    SESSION_TOOL.inputSchema?.additionalProperties !== false
  ) {
    throw new Error(
      'session schema must expose session lookup/control by exact id, status/rename/compact/fork, the Project action and create’s initial worktree location'
    );
  }
  const memoryTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'memory');
  const memoryProps = memoryTool?.inputSchema?.properties || {};
  if (
    memoryTool?.title !== 'Memory' ||
    memoryTool?.annotations?.title !== 'Memory' ||
    // Direct curated memory and the revisioned per-project edit/delete index.
    Object.keys(memoryProps).sort().join(',') !==
      'agent_id,id,include_inactive,index_revision,limit,offset,op,project_id,summary' ||
    memoryProps.op?.enum?.join(',') !== 'add,edit,delete,list' ||
    memoryTool?.inputSchema?.required?.join(',') !== 'op' ||
    memoryProps.id?.type !== 'integer' ||
    memoryProps.id?.minimum !== 1 ||
    memoryProps.index_revision?.type !== 'string'
  ) {
    throw new Error('memory schema must expose only the direct durable-core contract');
  }
  if (
    memoryProps.summary?.type !== 'string' ||
    memoryProps.project_id?.type !== 'string' ||
    memoryProps.action ||
    memoryProps.element ||
    memoryProps.status ||
    memoryProps.confirm ||
    memoryProps.category
  ) {
    throw new Error('memory schema must keep internal routing and derived fields private');
  }
});

test('web_search and web_fetch schemas keep sync fan-out contracts', () => {
  const webSearchTool = WEB_SEARCH_TOOL_DEFS.find((tool) => tool.name === 'web_search');
  const webSearchProps = webSearchTool?.inputSchema?.properties || {};
  const webSearchQueryShapes = webSearchProps.query?.anyOf || [];
  const webSearchQueryStringShape = webSearchQueryShapes.find((shape) => shape?.type === 'string');
  const webSearchQueryArrayShape = webSearchQueryShapes.find((shape) => shape?.type === 'array');
  if (
    webSearchProps.mode ||
    webSearchProps.action ||
    webSearchProps.task_id ||
    !webSearchProps.query?.anyOf ||
    webSearchQueryStringShape?.minLength !== 1 ||
    webSearchQueryArrayShape?.minItems !== 1 ||
    webSearchQueryArrayShape?.items?.minLength !== 1 ||
    !webSearchTool?.inputSchema?.required?.includes('query')
  ) {
    throw new Error('web_search schema must preserve sync execution guidance and string/array query shape');
  }
  if (
    webSearchProps.maxResults?.type !== 'integer' ||
    webSearchProps.maxResults?.minimum !== 1 ||
    webSearchProps.maxResults?.maximum !== 20
  ) {
    throw new Error('web_search maxResults schema must match the runtime integer range');
  }
  if (
    webSearchProps.type?.type !== 'string' ||
    webSearchProps.locale?.type !== 'string' ||
    webSearchProps.contextSize?.type !== 'string'
  ) {
    throw new Error('web_search schema must expose string type, locale, and contextSize');
  }
  const webFetchTool = WEB_SEARCH_TOOL_DEFS.find((tool) => tool.name === 'web_fetch');
  const webFetchProps = webFetchTool?.inputSchema?.properties || {};
  const webFetchUrlShapes = webFetchProps.url?.anyOf || [];
  const webFetchUrlStringShape = webFetchUrlShapes.find((shape) => shape?.type === 'string');
  const webFetchUrlArrayShape = webFetchUrlShapes.find((shape) => shape?.type === 'array');
  if (
    webFetchUrlStringShape?.minLength !== undefined ||
    webFetchUrlStringShape?.format !== 'uri' ||
    webFetchUrlArrayShape?.minItems !== 1 ||
    webFetchUrlArrayShape?.maxItems !== 10 ||
    webFetchUrlArrayShape?.items?.minLength !== undefined ||
    webFetchUrlArrayShape?.items?.format !== 'uri'
  ) {
    throw new Error('web_fetch schema must preserve body-fetch capability and string/array url shape');
  }
  if (
    webFetchProps.startIndex?.type !== 'integer' ||
    webFetchProps.startIndex?.minimum !== 0 ||
    webFetchProps.maxLength?.type !== 'integer' ||
    webFetchProps.maxLength?.minimum !== 0
  ) {
    throw new Error('web_fetch schema must describe paging window fields');
  }
});

test('load_tool and Skill schemas stay pure loaders', () => {
  const toolSearchNamesSchema = TOOL_SEARCH_TOOL.inputSchema?.properties?.names;
  const toolSearchNamesStringSchema = toolSearchNamesSchema?.anyOf?.find((entry) => entry?.type === 'string');
  const toolSearchNamesArraySchema = toolSearchNamesSchema?.anyOf?.find((entry) => entry?.type === 'array');
  if (
    !toolSearchNamesSchema ||
    toolSearchNamesStringSchema?.minLength !== undefined ||
    toolSearchNamesArraySchema?.minItems !== 1 ||
    toolSearchNamesArraySchema?.items?.minLength !== undefined ||
    TOOL_SEARCH_TOOL.inputSchema?.required?.join(',') !== 'names' ||
    TOOL_SEARCH_TOOL.inputSchema?.additionalProperties !== false
  ) {
    throw new Error('load_tool schema must require non-empty names[] as the only loader field');
  }
  const skillNameSchema = SKILL_TOOL.inputSchema?.properties?.name;
  if (
    skillNameSchema?.type !== 'string' ||
    skillNameSchema?.minLength !== undefined ||
    SKILL_TOOL.inputSchema?.required?.join(',') !== 'name' ||
    SKILL_TOOL.inputSchema?.additionalProperties !== false
  ) {
    throw new Error('Skill schema must require one exact non-empty available-skills name');
  }
  // compactToolSearchDescription enforces the runtime's single-line 220-char snippet limit.
  const longText = 'word '.repeat(80);
  const longToolSearchText = compactToolSearchDescription(`${longText}\n${longText}`);
  if (longToolSearchText.length > 220 || /\n/.test(longToolSearchText)) {
    throw new Error(
      `tool_search descriptions must be compact single-line snippets, got ${longToolSearchText.length} chars`
    );
  }
});

// grep: pattern/path fan-out shapes, scoped-discovery description, and the
// single context field that keeps ripgrep aliases internal.
function assertGrepLocatorSchema(grepTool) {
  const grepPatternShapes = grepTool?.inputSchema?.properties?.pattern?.anyOf;
  const grepStringPatternShape = grepPatternShapes?.find((shape) => shape?.type === 'string');
  const grepArrayPatternShape = grepPatternShapes?.find((shape) => shape?.type === 'array');
  if (
    !grepStringPatternShape ||
    grepStringPatternShape?.minLength !== undefined ||
    grepArrayPatternShape?.items?.type !== 'string' ||
    grepArrayPatternShape?.items?.minLength !== undefined ||
    grepArrayPatternShape?.minItems !== undefined ||
    grepArrayPatternShape?.maxItems !== 10 ||
    grepTool?.inputSchema?.properties?.pattern?.type ||
    grepTool?.inputSchema?.properties?.path?.anyOf?.[0]?.type !== 'string' ||
    grepTool?.inputSchema?.properties?.path?.minLength !== undefined ||
    grepTool?.inputSchema?.properties?.path?.anyOf?.[1]?.type !== 'array' ||
    grepTool?.inputSchema?.properties?.glob?.type !== 'string' ||
    grepTool?.inputSchema?.properties?.glob?.minLength !== undefined ||
    grepTool?.inputSchema?.properties?.glob?.anyOf ||
    grepTool?.inputSchema?.properties?.limit?.type !== 'integer' ||
    grepTool?.inputSchema?.properties?.offset?.type !== 'integer' ||
    grepTool?.inputSchema?.properties?.context?.type !== 'integer'
  ) {
    throw new Error('grep schema must expose pattern and path fan-out with scalar glob guidance');
  }
  if (grepTool?.inputSchema?.properties?.limit?.minimum !== 0) {
    throw new Error('grep limit schema must keep locator caps explicit');
  }
  if (grepTool?.inputSchema?.properties?.['-C'] || grepTool?.inputSchema?.properties?.context?.maximum !== 200) {
    throw new Error('grep schema must expose one context field and keep ripgrep aliases internal');
  }
  if (grepTool?.inputSchema?.properties?.type) {
    throw new Error('grep type schema must stay hidden; prefer glob for extension narrowing');
  }
}

// Every paging knob across the three path locators stays an integer schema.
function assertPagingIntegerSchemas(globTool, findTool, listTool) {
  for (const [label, schema] of [
    ['glob.limit', globTool?.inputSchema?.properties?.limit],
    ['glob.offset', globTool?.inputSchema?.properties?.offset],
    ['find.limit', findTool?.inputSchema?.properties?.limit],
    ['list.limit', listTool?.inputSchema?.properties?.limit],
    ['list.offset', listTool?.inputSchema?.properties?.offset],
  ]) {
    if (schema?.type !== 'integer') throw new Error(`${label} must expose integer schema: ${JSON.stringify(schema)}`);
  }
}

// glob: known-base wildcard contract and capped pattern fan-out.
function assertGlobLocatorSchema(globTool) {
  const globPatternShapes = globTool?.inputSchema?.properties?.pattern?.anyOf;
  const globStringPatternShape = globPatternShapes?.find((shape) => shape?.type === 'string');
  const globArrayPatternShape = globPatternShapes?.find((shape) => shape?.type === 'array');
  if (
    !globStringPatternShape ||
    globStringPatternShape?.minLength !== undefined ||
    globArrayPatternShape?.items?.type !== 'string' ||
    globArrayPatternShape?.items?.minLength !== undefined ||
    globArrayPatternShape?.minItems !== undefined ||
    globArrayPatternShape?.maxItems !== 10 ||
    globTool?.inputSchema?.properties?.pattern?.type ||
    globTool?.inputSchema?.properties?.path?.type !== 'string' ||
    globTool?.inputSchema?.properties?.path?.minLength !== undefined ||
    globTool?.inputSchema?.properties?.path?.anyOf
  ) {
    throw new Error('glob schema must expose capped pattern fan-out and scalar path');
  }
}

// find: fuzzy-lookup description, limit sentinel, and its nonblank query /
// optional base-directory operands.
function assertFindLocatorSchema(findTool) {
  if (findTool?.inputSchema?.properties?.limit?.type !== 'integer' || findTool.inputSchema.properties.limit.minimum !== 0) {
    throw new Error('find limit must be an integer with 0 as the unlimited sentinel');
  }
  if (
    findTool?.inputSchema?.properties?.query?.type !== 'string' ||
    findTool?.inputSchema?.properties?.query?.minLength !== 1 ||
    findTool?.inputSchema?.properties?.query?.pattern !== '\\S' ||
    findTool?.inputSchema?.properties?.query?.anyOf
  ) {
    throw new Error('find schema must expose a nonblank scalar query matching its runtime guard');
  }
  if (
    findTool?.inputSchema?.properties?.path?.type !== 'string' ||
    findTool?.inputSchema?.properties?.path?.minLength !== undefined ||
    findTool?.inputSchema?.required?.join(',') !== 'query'
  ) {
    throw new Error('find schema must expose a non-empty optional Project-relative base directory');
  }
}

// list: known-directory immediate-entry contract and its page-cap sentinel.
function assertListLocatorSchema(listTool) {
  if (
    listTool?.inputSchema?.properties?.path?.type !== 'string' ||
    listTool?.inputSchema?.properties?.path?.minLength !== undefined ||
    listTool?.inputSchema?.properties?.limit?.maximum !== 100 ||
    listTool?.inputSchema?.properties?.path?.anyOf
  ) {
    throw new Error('list schema must expose a scalar path and a limit capped at 100');
  }
}

test('grep, glob, find, and list schemas keep locator contracts', () => {
  const grepTool = BUILTIN_TOOLS.find((tool) => tool.name === 'grep');
  const globTool = BUILTIN_TOOLS.find((tool) => tool.name === 'glob');
  const findTool = BUILTIN_TOOLS.find((tool) => tool.name === 'find');
  const listTool = BUILTIN_TOOLS.find((tool) => tool.name === 'list');
  assertGrepLocatorSchema(grepTool);
  assertPagingIntegerSchemas(globTool, findTool, listTool);
  assertGlobLocatorSchema(globTool);
  assertFindLocatorSchema(findTool);
  assertListLocatorSchema(listTool);
});
