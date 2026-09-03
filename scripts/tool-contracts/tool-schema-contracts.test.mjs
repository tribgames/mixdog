// Model-facing tool schema and description contracts. Assertions here pin
// load-bearing key phrases and structural schema shapes — not full sentences —
// so routine wording polish does not break the suite. When a contract phrase
// itself changes on purpose, update it here in the same pass.
import './_env.mjs';
import test from 'node:test';
import { smokeCatalog, fullDefaults } from './_catalog.mjs';
import { compactToolSearchDescription, defaultDeferredToolNames, SKILL_TOOL, TOOL_SEARCH_TOOL } from '../../src/mixdog-session-runtime.mjs';
import { CWD_TOOL } from '../../src/session-runtime/tool-defs.mjs';
import { AGENT_TOOL } from '../../src/standalone/agent-tool.mjs';
import { BUILTIN_TOOLS } from '../../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../../src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
import { PATCH_TOOL_DEFS } from '../../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { TOOL_DEFS as MEMORY_TOOL_DEFS } from '../../src/runtime/memory/tool-defs.mjs';
import { TOOL_DEFS as WEB_SEARCH_TOOL_DEFS } from '../../src/runtime/web-search/tool-defs.mjs';
import { TOOL_DEFS as CHANNEL_TOOL_DEFS } from '../../src/runtime/channels/tool-defs.mjs';
import { assertCodeGraphDescriptionContract } from '../code-graph-description-contract.mjs';

function assertHas(set, name) {
  if (!set.has(name)) throw new Error(`default tool surface missing ${name}: ${[...set].join(', ')}`);
}

function assertLacks(set, name) {
  if (set.has(name)) throw new Error(`default tool surface should not include ${name}: ${[...set].join(', ')}`);
}

function toolSchemaSize(tool) {
  const desc = String(tool?.description || '');
  const schema = JSON.stringify(tool?.input_schema || tool?.inputSchema || {});
  return desc.length + schema.length;
}

test('shell, edit, and task keep their execution contracts', () => {
  const shellTool = BUILTIN_TOOLS.find((tool) => tool.name === 'shell');
  const shellDescription = shellTool?.description || '';
  // The timeout contract is anchored on the timeout_ms argument description
  // below — the tool description no longer duplicates it.
  if (!/Run programs, runtime\/state operations/i.test(shellDescription)
      || !/10s foreground window.*not a timeout/i.test(shellDescription)
      || !/call task wait instead of polling task read/i.test(shellDescription)) {
    throw new Error(`shell description must keep its execution-routing and async-completion phrases: ${shellDescription}`);
  }
  const editTool = BUILTIN_TOOLS.find((tool) => tool.name === 'edit');
  const editProps = editTool?.inputSchema?.properties || {};
  if (!editTool
    || JSON.stringify(editTool.inputSchema?.required) !== JSON.stringify(['file_path', 'old_string', 'new_string'])
    || editProps.file_path?.minLength !== undefined
    || editProps.replace_all?.default !== false
    || editTool.inputSchema?.additionalProperties !== false
    || !/^Replace exact text in one file\./i.test(editTool.description || '')
    || !/Empty only to create/i.test(editProps.old_string?.description || '')
    || !/may be empty to delete/i.test(editProps.new_string?.description || '')) {
    throw new Error(`edit tool must preserve the exact-string contract: ${JSON.stringify(editTool)}`);
  }
  const shellProps = shellTool?.inputSchema?.properties || {};
  if (JSON.stringify(Object.keys(shellProps)) !== JSON.stringify(['command', 'timeout_ms'])
    || shellProps.command?.minLength !== undefined) {
    throw new Error(`shell schema must expose only command and optional timeout_ms: ${JSON.stringify(shellProps)}`);
  }
  // timeout_ms is DECLARED in the model-facing schema (the schema states the
  // contract) while the default stays "no deadline" — the description and
  // rules both steer models to omit it.
  if (shellProps.timeout_ms?.type !== 'number'
    || shellProps.timeout_ms?.minimum !== 0
    || !/hard process-kill deadline/i.test(shellProps.timeout_ms?.description || '')
    || !/Omit or 0 = no deadline/.test(shellProps.timeout_ms?.description || '')) {
    throw new Error(`shell timeout_ms must declare the no-deadline-by-default contract: ${JSON.stringify(shellProps.timeout_ms)}`);
  }
  const publicTaskTool = BUILTIN_TOOLS.find((tool) => tool.name === 'task');
  const publicTaskProps = publicTaskTool?.inputSchema?.properties || {};
  if (!/Completion is automatic/i.test(publicTaskTool?.description || '')
    || !/Never repeat read to watch a task/i.test(publicTaskTool?.description || '')) {
    throw new Error(`task description must prohibit unsolicited progress checks: ${publicTaskTool?.description || ''}`);
  }
  if (JSON.stringify(publicTaskProps.action?.enum) !== JSON.stringify(['list', 'read', 'wait', 'cancel'])
    || publicTaskProps.task_id?.minLength !== undefined
    || publicTaskProps.monitor_interval_ms
    || publicTaskProps.timeout_ms?.minimum !== 0
    || publicTaskProps.after_ms || publicTaskProps.poll_ms) {
    throw new Error('task schema must expose list/read/wait/cancel with a wait ceiling and no polling parameters');
  }
  if (JSON.stringify(publicTaskTool?.inputSchema?.required) !== JSON.stringify(['action'])) {
    throw new Error('task schema must require an explicit action');
  }
});

test('default deferred tool surfaces per mode stay fixed and bounded', () => {
  if (fullDefaults.size !== 10) {
    throw new Error(`full default catalog should contain both edit dialects (10 tools), got ${fullDefaults.size}: ${[...fullDefaults].join(', ')}`);
  }
  for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'apply_patch', 'Skill', 'load_tool']) {
    assertHas(fullDefaults, name);
  }
  for (const name of ['shell', 'task', 'agent', 'recall', 'web_search', 'web_fetch', 'cwd', 'git_stage']) {
    assertLacks(fullDefaults, name);
  }

  const leadDefaults = defaultDeferredToolNames(smokeCatalog, 'lead');
  if (leadDefaults.size !== 16) {
    throw new Error(`lead default catalog should contain both edit dialects and git (16 tools), got ${leadDefaults.size}: ${[...leadDefaults].join(', ')}`);
  }
  for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'git', 'shell', 'task', 'apply_patch', 'agent', 'recall', 'web_search', 'Skill', 'load_tool']) {
    assertHas(leadDefaults, name);
  }
  for (const name of ['web_fetch', 'cwd', 'git_stage', 'session_manage']) {
    assertLacks(leadDefaults, name);
  }
  if (TOOL_SEARCH_TOOL.annotations?.agentHidden !== true) {
    throw new Error('tool_search must stay Lead-only / standalone-only; agent sessions keep fixed schemas without deferred loading');
  }

  const surfaceSize = [...fullDefaults].reduce((sum, name) => {
    const tool = smokeCatalog.find((item) => item?.name === name);
    return sum + toolSchemaSize(tool);
  }, 0);
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
    const tool = smokeCatalog.find((item) => item?.name === name);
    const size = toolSchemaSize(tool);
    if (size > cap) throw new Error(`${name} schema/description too large: ${size} chars (cap ${cap})`);
  }

  const readonlyDefaults = defaultDeferredToolNames(smokeCatalog, 'readonly');
  if (readonlyDefaults.size !== 8) {
    throw new Error(`readonly default surface should stay 8 tools, got ${readonlyDefaults.size}: ${[...readonlyDefaults].join(', ')}`);
  }
  for (const name of ['read', 'code_graph', 'grep', 'find', 'glob', 'list', 'Skill', 'load_tool']) {
    assertHas(readonlyDefaults, name);
  }
  for (const name of ['apply_patch', 'agent', 'shell', 'git_stage']) {
    assertLacks(readonlyDefaults, name);
  }
});

test('agent schema hides execution controls and rejects hidden fields', () => {
  const agentProps = AGENT_TOOL.inputSchema?.properties || {};
  if (agentProps.mode || agentProps.wait || agentProps.sessionId) {
    throw new Error('agent schema should not expose execution mode controls or raw session ids');
  }
  if (AGENT_TOOL.inputSchema?.required?.join(',') !== 'type'
    || !/New spawn requires agent/i.test(agentProps.type?.description || '')
    || !/send requires tag/i.test(agentProps.type?.description || '')
    || !/task_id or tag/i.test(agentProps.type?.description || '')) {
    throw new Error('agent schema must require type and describe each action target');
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
  const patchDescription = patchTool?.inputSchema?.properties?.patch?.description || '';
  // Function-only compatibility keeps only a non-empty patch string; OpenAI
  // custom tools receive the Lark grammar directly.
  if (!/Complete V4A patch text/i.test(patchDescription)
      || patchTool?.inputSchema?.properties?.patch?.minLength !== 1) {
    throw new Error('apply_patch JSON fallback must expose one non-empty V4A patch string');
  }
  if (Object.keys(patchTool?.inputSchema?.properties || {}).join(',') !== 'patch'
      || JSON.stringify(patchTool?.inputSchema?.required || []) !== '["patch"]') {
    throw new Error(`apply_patch JSON fallback must expose only patch: ${JSON.stringify(patchTool?.inputSchema)}`);
  }
  if (/\*\*\* Root:|root_line/.test(JSON.stringify(patchTool))) {
    throw new Error(`apply_patch model contract must not expose non-Codex Root extensions: ${JSON.stringify(patchTool)}`);
  }
  if (patchTool?.title !== 'Apply Patch'
      || patchTool?.annotations?.title !== 'Apply Patch'
      || !/^Edit files with one complete V4A patch/i.test(patchTool?.description || '')
      || /Begin Patch|Add File|Delete File|Update File|exact current lines/i.test(patchTool?.description || '')) {
    throw new Error(`apply_patch JSON fallback must stay minimal and grammar-free: ${JSON.stringify(patchTool)}`);
  }
  if (!/^Edit files with one raw V4A patch; do not wrap it in JSON\./.test(patchTool?.freeformDescription || '')
      || !/one Add\/Delete\/Update File block per target path/i.test(patchTool?.freeformDescription || '')
      || patchTool?.freeform?.type !== 'grammar'
      || patchTool?.freeform?.syntax !== 'lark') {
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

test('read schema exposes only the canonical scalar window contract', () => {
  const readTool = BUILTIN_TOOLS.find((tool) => tool.name === 'read');
  const readDescription = readTool?.description || '';
  const readSchema = readTool?.inputSchema || {};
  const readProps = readSchema.properties || {};
  if (!/not director/i.test(readDescription)) {
    throw new Error('read description must keep directory-vs-file guidance');
  }
  if (/line\+context/i.test(readDescription) || !/Known-file contents or line ranges/i.test(readDescription)) {
    throw new Error('read description must stay compact and file-oriented');
  }
  if (readProps.file_path?.type !== 'string'
    || readProps.file_path?.minLength !== undefined
    || readProps.file_path?.anyOf
    || !/Known file path as plain text/i.test(readProps.file_path?.description || '')
    || !/fans out to per-file results/i.test(readProps.file_path?.description || '')
    || readProps.path
    || JSON.stringify(readSchema.required) !== JSON.stringify(['file_path'])) {
    throw new Error('read schema must expose only the canonical scalar file_path');
  }
  if (readProps.offset?.type !== 'integer'
    || readProps.offset?.minimum !== 1
    || !/1-based start line/i.test(readProps.offset?.description || '')
    || readProps.limit?.type !== 'integer'
    || readProps.limit?.minimum !== 1
    || !/Maximum line count/i.test(readProps.limit?.description || '')) {
    throw new Error('read range args must use the scalar integer contract with Mixdog descriptions');
  }
  if (Object.keys(readProps).some((key) => !['file_path', 'offset', 'limit'].includes(key))
    || readSchema.additionalProperties !== false) {
    throw new Error('read schema must not expose legacy or batch arguments');
  }
});

test('code_graph descriptions route structure lookups away from grep', () => {
  const codeGraphDescription = CODE_GRAPH_TOOL_DEFS[0]?.description || '';
  const codeGraphProps = CODE_GRAPH_TOOL_DEFS[0]?.inputSchema?.properties || {};
  // code_graph description stays structure-oriented and must actively route
  // symbol/definition/caller lookups AWAY from repeated grep (the grep_retry +
  // find_symbol_noscope anti-patterns). It is allowed to be verbose enough to
  // enumerate modes, but must not drift into web-search territory.
  if (!/Source-file structure/i.test(codeGraphDescription)
    || !['find_symbol', 'symbol_search', 'references', 'callers', 'callees'].every((mode) => codeGraphDescription.includes(mode))
    || !/Text, literals, and regex belong to grep/i.test(codeGraphDescription)) {
    throw new Error('code_graph description must stay structure-oriented and name its symbol modes');
  }
  if (!/File modes use files\[\]/i.test(codeGraphDescription) || !/symbol modes use symbols\[\]/i.test(codeGraphDescription)) {
    throw new Error('code_graph description must keep its per-mode files[]/symbols[] target contract');
  }
  if (!/files\[\]/i.test(codeGraphProps.mode?.description || '') || !/project-relative or absolute/i.test(codeGraphProps.files?.description || '')) {
    throw new Error('code_graph schema must keep compact relative/absolute path descriptions');
  }
  if (!/Explicit root outside the project/i.test(codeGraphProps.cwd?.description || '') || !/omit for project root/i.test(codeGraphProps.cwd?.description || '')) {
    throw new Error('code_graph schema must expose its explicit outside-cwd root');
  }
  if (!/find_symbol returns declaration\/body/i.test(codeGraphDescription)
      || !/references returns declaration\/usages plus optional body/i.test(codeGraphDescription)
      || !/callers\/callees return locations/i.test(codeGraphDescription)
      || !/find_symbol defaults true/i.test(codeGraphProps.body?.description || '')
      || !/references is opt-in/i.test(codeGraphProps.body?.description || '')) {
    throw new Error('code_graph descriptions must distinguish declarations, usages, and relation locations');
  }
  const codeGraphFileShapes = codeGraphProps.files?.anyOf || [];
  const codeGraphSymbolShapes = codeGraphProps.symbols?.anyOf || [];
  const codeGraphFileStringShape = codeGraphFileShapes.find((shape) => shape?.type === 'string');
  const codeGraphFileArrayShape = codeGraphFileShapes.find((shape) => shape?.type === 'array');
  const codeGraphSymbolStringShape = codeGraphSymbolShapes.find((shape) => shape?.type === 'string');
  const codeGraphSymbolArrayShape = codeGraphSymbolShapes.find((shape) => shape?.type === 'array');
  if (codeGraphFileStringShape?.minLength !== undefined
      || codeGraphFileArrayShape?.minItems !== undefined
      || codeGraphFileArrayShape?.items?.minLength !== undefined
      || codeGraphSymbolStringShape?.minLength !== undefined
      || codeGraphSymbolArrayShape?.minItems !== undefined
      || codeGraphSymbolArrayShape?.items?.minLength !== undefined
      || codeGraphProps.cwd?.minLength !== undefined
      || codeGraphProps.limit?.maximum !== 500
      || !/overview hierarchy or caller traversal depth/i.test(codeGraphProps.depth?.description || '')) {
    throw new Error('code_graph schema must reject blank targets and expose runtime result/depth bounds');
  }
  for (const [label, schema] of [
    ['code_graph.limit', codeGraphProps.limit],
    ['code_graph.depth', codeGraphProps.depth],
  ]) {
    if (schema?.type !== 'integer') throw new Error(`${label} must expose integer schema: ${JSON.stringify(schema)}`);
  }
  assertCodeGraphDescriptionContract({
    description: codeGraphDescription,
    modeDescription: codeGraphProps.mode?.description || '',
    symbolsDescription: codeGraphProps.symbols?.description || '',
  });
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
  if (!/prior work/i.test(recallTool?.description || '') || !recallProps.id?.anyOf || !/Do not invent ids/i.test(recallProps.id?.description || '')) {
    throw new Error('recall schema must preserve scoped prior-context guidance and id lookup shape');
  }
  if (recallQueryStringShape?.minLength !== undefined
    || recallQueryArrayShape?.minItems !== undefined
    || recallQueryArrayShape?.maxItems !== 5
    || recallQueryArrayShape?.items?.minLength !== undefined
    || recallIdStringShape?.minimum !== 1
    || recallIdArrayShape?.minItems !== undefined
    || recallIdArrayShape?.items?.type !== 'integer'
    || recallIdArrayShape?.items?.minimum !== 1
    || !/independent fan-out/i.test(recallProps.query?.description || '')
    || !/pool/i.test(recallProps.projectScope?.description || '')) {
    throw new Error('recall schema must explain fan-out query and project scope filters');
  }
  if (recallProps.limit?.type !== 'integer'
    || recallProps.limit?.minimum !== 1
    || recallProps.limit?.maximum !== 100
    || !/default 10/i.test(recallProps.limit?.description || '')
    || !/5 sessions for period=last/i.test(recallProps.limit?.description || '')
    || recallProps.offset?.type !== 'integer'
    || recallProps.offset?.minimum !== 0
    || recallProps.offset?.maximum !== 500
    || !/default 0/i.test(recallProps.offset?.description || '')) {
    throw new Error('recall schema must expose runtime paging bounds and defaults');
  }
  // Cross-session / raw recall surface: summary-only is the default; expansion
  // into chunk members or unchunked raw/episode turns is explicit.
  if (recallProps.includeMembers?.default !== false
    || !/chunk members.*default false/i.test(recallProps.includeMembers?.description || '')) {
    throw new Error('recall includeMembers must stay scoped to chunk-member output only');
  }
  if (recallProps.includeRaw?.default !== false
    || !/raw\/episode rows.*default false/i.test(recallProps.includeRaw?.description || '')) {
    throw new Error('recall schema must expose includeRaw for unchunked raw/episode turns');
  }
  if (!/archived entries.*default true/i.test(recallProps.includeArchived?.description || '') || recallProps.sessionOnly) {
    throw new Error('recall schema must expose archived defaults and keep sessionOnly private');
  }
});

test('cwd and memory schemas stay minimal and direct', () => {
  const cwdProps = CWD_TOOL.inputSchema?.properties || {};
  if (CWD_TOOL.title !== 'Project'
    || CWD_TOOL.annotations?.title !== 'Project'
    || !/active Project/i.test(CWD_TOOL.description || '')
    || !/shell-local cd does not change the Project/i.test(CWD_TOOL.description || '')
    || Object.keys(cwdProps).join(',') !== 'path'
    || cwdProps.path?.minLength !== undefined
    || CWD_TOOL.inputSchema?.additionalProperties !== false) {
    throw new Error('cwd schema must expose only an optional non-empty Project path');
  }
  const memoryTool = MEMORY_TOOL_DEFS.find((tool) => tool.name === 'memory');
  const memoryProps = memoryTool?.inputSchema?.properties || {};
  if (memoryTool?.title !== 'Memory'
    || memoryTool?.annotations?.title !== 'Memory'
    || !/durable core memory/i.test(memoryTool?.description || '')
    || Object.keys(memoryProps).sort().join(',') !== 'id,op,project_id,summary'
    || memoryTool?.inputSchema?.required?.join(',') !== 'op'
    || memoryProps.id?.type !== 'integer'
    || memoryProps.id?.minimum !== 1
    || !/required for edit, delete/i.test(memoryProps.id?.description || '')) {
    throw new Error('memory schema must expose only the direct durable-core contract');
  }
  if (!/add and edit/i.test(memoryProps.summary?.description || '')
    || !/current Project/i.test(memoryProps.project_id?.description || '')
    || memoryProps.action
    || memoryProps.element
    || memoryProps.status
    || memoryProps.limit
    || memoryProps.confirm
    || memoryProps.category) {
    throw new Error('memory schema must keep internal routing and derived fields private');
  }
});

test('web_search and web_fetch schemas keep sync fan-out contracts', () => {
  const webSearchTool = WEB_SEARCH_TOOL_DEFS.find((tool) => tool.name === 'web_search');
  const webSearchProps = webSearchTool?.inputSchema?.properties || {};
  const webSearchQueryShapes = webSearchProps.query?.anyOf || [];
  const webSearchQueryStringShape = webSearchQueryShapes.find((shape) => shape?.type === 'string');
  const webSearchQueryArrayShape = webSearchQueryShapes.find((shape) => shape?.type === 'array');
  if (!/Runs synchronously/i.test(webSearchTool?.description || '')
    || webSearchProps.mode
    || webSearchProps.action
    || webSearchProps.task_id
    || !webSearchProps.query?.anyOf
    || webSearchQueryStringShape?.minLength !== undefined
    || webSearchQueryArrayShape?.minItems !== undefined
    || webSearchQueryArrayShape?.items?.minLength !== undefined
    || !/lossless fan-out/i.test(webSearchProps.query?.description || '')
    || !webSearchTool?.inputSchema?.required?.includes('query')) {
    throw new Error('web_search schema must preserve sync execution guidance and string/array query shape');
  }
  if (webSearchProps.maxResults?.type !== 'integer'
    || webSearchProps.maxResults?.minimum !== 1
    || webSearchProps.maxResults?.maximum !== 20
    || !/default 10/i.test(webSearchProps.maxResults?.description || '')) {
    throw new Error('web_search maxResults schema must match the runtime integer range and default');
  }
  if (!/Default web/i.test(webSearchProps.type?.description || '') || !/locale hint/i.test(webSearchProps.locale?.description || '') || !/Default low/i.test(webSearchProps.contextSize?.description || '')) {
    throw new Error('web_search schema must describe type, locale, and contextSize defaults');
  }
  const webFetchTool = WEB_SEARCH_TOOL_DEFS.find((tool) => tool.name === 'web_fetch');
  const webFetchProps = webFetchTool?.inputSchema?.properties || {};
  const webFetchUrlShapes = webFetchProps.url?.anyOf || [];
  const webFetchUrlStringShape = webFetchUrlShapes.find((shape) => shape?.type === 'string');
  const webFetchUrlArrayShape = webFetchUrlShapes.find((shape) => shape?.type === 'array');
  if (!/Fetch page\/docs body from URL/i.test(webFetchTool?.description || '')
    || webFetchUrlStringShape?.minLength !== undefined
    || webFetchUrlStringShape?.format !== 'uri'
    || webFetchUrlArrayShape?.minItems !== undefined
    || webFetchUrlArrayShape?.maxItems !== 10
    || webFetchUrlArrayShape?.items?.minLength !== undefined
    || webFetchUrlArrayShape?.items?.format !== 'uri'
    || !/Public HTTP\(S\) URL/i.test(webFetchProps.url?.description || '')
    || !/array of up to 10 URLs/i.test(webFetchProps.url?.description || '')) {
    throw new Error('web_fetch schema must preserve body-fetch capability and string/array url shape');
  }
  if (webFetchProps.startIndex?.type !== 'integer'
    || webFetchProps.startIndex?.minimum !== 0
    || !/default 0/i.test(webFetchProps.startIndex?.description || '')
    || webFetchProps.maxLength?.type !== 'integer'
    || webFetchProps.maxLength?.minimum !== 0
    || !/default 50000/i.test(webFetchProps.maxLength?.description || '')
    || !/0 unlimited/i.test(webFetchProps.maxLength?.description || '')) {
    throw new Error('web_fetch schema must describe paging window fields');
  }
});

test('load_tool and Skill schemas stay pure loaders', () => {
  const toolSearchNamesSchema = TOOL_SEARCH_TOOL.inputSchema?.properties?.names;
  const toolSearchNamesStringSchema = toolSearchNamesSchema?.anyOf?.find((entry) => entry?.type === 'string');
  const toolSearchNamesArraySchema = toolSearchNamesSchema?.anyOf?.find((entry) => entry?.type === 'array');
  if (!/full schema of named deferred tools/i.test(TOOL_SEARCH_TOOL.description || '')
    || !/auto-load/i.test(TOOL_SEARCH_TOOL.description || '')
    || !toolSearchNamesSchema
    || toolSearchNamesStringSchema?.minLength !== undefined
    || toolSearchNamesArraySchema?.minItems !== undefined
    || toolSearchNamesArraySchema?.items?.minLength !== undefined
    || TOOL_SEARCH_TOOL.inputSchema?.required?.join(',') !== 'names'
    || TOOL_SEARCH_TOOL.inputSchema?.properties?.select
    || TOOL_SEARCH_TOOL.inputSchema?.additionalProperties !== false) {
    throw new Error('load_tool schema must require non-empty names[] as the only loader field (legacy select stays retired)');
  }
  const skillNameSchema = SKILL_TOOL.inputSchema?.properties?.name;
  if (!/named SKILL\.md into context/i.test(SKILL_TOOL.description || '')
    || skillNameSchema?.type !== 'string'
    || skillNameSchema?.minLength !== undefined
    || !/Exact name from available-skills/i.test(skillNameSchema?.description || '')
    || SKILL_TOOL.inputSchema?.required?.join(',') !== 'name'
    || SKILL_TOOL.inputSchema?.additionalProperties !== false) {
    throw new Error('Skill schema must require one exact non-empty available-skills name');
  }
  const patchDescription = PATCH_TOOL_DEFS[0]?.inputSchema?.properties?.patch?.description || '';
  const longToolSearchText = compactToolSearchDescription(`${patchDescription}\n${patchDescription}`);
  if (longToolSearchText.length > 220 || /\n/.test(longToolSearchText)) {
    throw new Error(`tool_search descriptions must be compact single-line snippets, got ${longToolSearchText.length} chars`);
  }
});

test('grep, glob, find, and list schemas keep locator contracts', () => {
  if (CHANNEL_TOOL_DEFS.some((tool) => tool.name === 'reply' || tool.name === 'fetch')) {
    throw new Error('channel reply/fetch must stay removed from the model-facing surface');
  }
  const grepTool = BUILTIN_TOOLS.find((tool) => tool.name === 'grep');
  const grepPatternDescription = grepTool?.inputSchema?.properties?.pattern?.description || '';
  const grepPathDescription = grepTool?.inputSchema?.properties?.path?.description || '';
  const grepGlobDescription = grepTool?.inputSchema?.properties?.glob?.description || '';
  const grepModeDescription = grepTool?.inputSchema?.properties?.mode?.description || '';
  const grepLimitDescription = grepTool?.inputSchema?.properties?.limit?.description || '';
  const grepContextDescription = grepTool?.inputSchema?.properties?.context?.description || '';
  const grepPatternShapes = grepTool?.inputSchema?.properties?.pattern?.anyOf;
  const grepStringPatternShape = grepPatternShapes?.find((shape) => shape?.type === 'string');
  const grepArrayPatternShape = grepPatternShapes?.find((shape) => shape?.type === 'array');
  if (!grepStringPatternShape
      || grepStringPatternShape?.minLength !== undefined
      || grepArrayPatternShape?.items?.type !== 'string'
      || grepArrayPatternShape?.items?.minLength !== undefined
      || grepArrayPatternShape?.minItems !== undefined
      || grepArrayPatternShape?.maxItems !== 10
      || grepTool?.inputSchema?.properties?.pattern?.type
      || grepTool?.inputSchema?.properties?.path?.type !== 'string'
      || grepTool?.inputSchema?.properties?.path?.minLength !== undefined
      || grepTool?.inputSchema?.properties?.path?.anyOf
      || grepTool?.inputSchema?.properties?.glob?.type !== 'string'
      || grepTool?.inputSchema?.properties?.glob?.minLength !== undefined
      || grepTool?.inputSchema?.properties?.glob?.anyOf
      || grepTool?.inputSchema?.properties?.limit?.type !== 'integer'
      || grepTool?.inputSchema?.properties?.offset?.type !== 'integer'
      || grepTool?.inputSchema?.properties?.context?.type !== 'integer'
      || !/literal text or regex/i.test(grepPatternDescription)
      || !/plain (?:existing )?file or directory scope/i.test(grepPathDescription)) {
    throw new Error('grep schema must expose pattern fan-out and scalar path/glob guidance');
  }
  if (!/\bSearch file contents for literal or regex matches\b/i.test(grepTool?.description || '')
      || !/contextual path:line blocks/i.test(grepTool?.description || '')
      || !/reconnaissance pattern goes to mode:files/i.test(grepTool?.description || '')) {
    throw new Error('grep description must state its scoped discovery and returned-span reuse contract');
  }
  if (!/glob filter evaluated inside path/i.test(grepGlobDescription)
      || !/use path instead/i.test(grepGlobDescription)) {
    throw new Error('grep glob schema must describe scope narrowing');
  }
  if (!/files lists matching paths/i.test(grepModeDescription)
      || !/count totals all patterns together per file/i.test(grepModeDescription)
      || !/content/i.test(grepModeDescription)) {
    throw new Error('grep mode schema must name its compact output shapes and count aggregation');
  }
  if (grepTool?.inputSchema?.properties?.limit?.minimum !== 0 || !/Max results/i.test(grepLimitDescription)) {
    throw new Error('grep limit schema must keep locator caps explicit');
  }
  if (grepTool?.inputSchema?.properties?.['-C']
      || grepTool?.inputSchema?.properties?.context?.maximum !== 200
      || !/automatic context/i.test(grepContextDescription)
      || !/0 for matches only/i.test(grepContextDescription)) {
    throw new Error('grep schema must expose one context field and keep ripgrep aliases internal');
  }
  if (grepTool?.inputSchema?.properties?.type) {
    throw new Error('grep type schema must stay hidden; prefer glob for extension narrowing');
  }

  const globTool = BUILTIN_TOOLS.find((tool) => tool.name === 'glob');
  const findTool = BUILTIN_TOOLS.find((tool) => tool.name === 'find');
  const listTool = BUILTIN_TOOLS.find((tool) => tool.name === 'list');
  const listLimitDescription = listTool?.inputSchema?.properties?.limit?.description || '';
  const findLimitDescription = findTool?.inputSchema?.properties?.limit?.description || '';
  const globPatternShapes = globTool?.inputSchema?.properties?.pattern?.anyOf;
  const globStringPatternShape = globPatternShapes?.find((shape) => shape?.type === 'string');
  const globArrayPatternShape = globPatternShapes?.find((shape) => shape?.type === 'array');
  for (const [label, schema] of [
    ['glob.limit', globTool?.inputSchema?.properties?.limit],
    ['glob.offset', globTool?.inputSchema?.properties?.offset],
    ['find.limit', findTool?.inputSchema?.properties?.limit],
    ['list.limit', listTool?.inputSchema?.properties?.limit],
    ['list.offset', listTool?.inputSchema?.properties?.offset],
  ]) {
    if (schema?.type !== 'integer') throw new Error(`${label} must expose integer schema: ${JSON.stringify(schema)}`);
  }
  if (!/wildcard-matching (?:file )?paths under a known base/i.test(globTool?.description || '')
      || !/Directories never match/i.test(globTool?.description || '')
      || !/unknown base directory goes to find first/i.test(globTool?.description || '')
      || !/Known existing base directory/i.test(globTool?.inputSchema?.properties?.path?.description || '')) {
    throw new Error('glob description must state its known-base wildcard path contract');
  }
  if (!globStringPatternShape
      || globStringPatternShape?.minLength !== undefined
      || globArrayPatternShape?.items?.type !== 'string'
      || globArrayPatternShape?.items?.minLength !== undefined
      || globArrayPatternShape?.minItems !== undefined
      || globArrayPatternShape?.maxItems !== 10
      || globTool?.inputSchema?.properties?.pattern?.type
      || globTool?.inputSchema?.properties?.path?.type !== 'string'
      || globTool?.inputSchema?.properties?.path?.minLength !== undefined
      || globTool?.inputSchema?.properties?.path?.anyOf) {
    throw new Error('glob schema must expose capped pattern fan-out and scalar path');
  }
  // Contract-only description: guessed-fragment/verified-root routing policy
  // lives in src/rules/shared/30-exploration.md.
  if (!/Fuzzy filename\/directory path lookup when the location itself is unknown/i.test(findTool?.description || '') || !/returns paths only/i.test(findTool?.description || '')) {
    throw new Error('find description must state its fuzzy path-lookup contract');
  }
  if (!/default 25/i.test(findLimitDescription) || !/0 unlimited/i.test(findLimitDescription)) {
    throw new Error('find limit must state default 25 and the 0-unlimited sentinel');
  }
  if (!/known directory's immediate entries/i.test(listTool?.description || '')
      || !/no wildcard/i.test(listTool?.description || '')
      || listTool?.inputSchema?.properties?.path?.type !== 'string'
      || listTool?.inputSchema?.properties?.path?.minLength !== undefined
      || !/current Project/i.test(listTool?.inputSchema?.properties?.path?.description || '')
      || !/default 100/i.test(listLimitDescription)
      // list's 0 sentinel drops the PAGE cap only; the absolute cap still
      // applies, and the description says so.
      || !/0 = no page cap/i.test(listLimitDescription)
      || listTool?.inputSchema?.properties?.limit?.maximum !== 100
      || listTool?.inputSchema?.properties?.path?.anyOf) {
    throw new Error('list description must state its known-directory immediate-entry contract');
  }
  if (findTool?.inputSchema?.properties?.query?.type !== 'string'
      || findTool?.inputSchema?.properties?.query?.minLength !== undefined
      || findTool?.inputSchema?.properties?.query?.anyOf) {
    throw new Error('find schema must expose scalar query');
  }
  if (findTool?.inputSchema?.properties?.path?.type !== 'string'
      || findTool?.inputSchema?.properties?.path?.minLength !== undefined
      || !/omit for the current Project/i.test(findTool?.inputSchema?.properties?.path?.description || '')
      || /No content or symbol search/i.test(findTool?.description || '')) {
    throw new Error('find schema must expose a non-empty optional Project-relative base directory');
  }
});
