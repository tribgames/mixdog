// Deferred tool loading: load_tool semantics, native provider payloads,
// late-MCP reconciliation, and the BP2 deferred manifest.
import './_env.mjs';
import test from 'node:test';
import { smokeCatalog, fullDefaults } from './_catalog.mjs';
import { __renderToolSearchForTest, TOOL_SEARCH_TOOL } from '../../src/mixdog-session-runtime.mjs';
import { buildRequestBody } from '../../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import {
  applyDeferredToolSurface,
  reconcileDeferredMcpToolCatalog,
} from '../../src/session-runtime/tool-catalog.mjs';
import { snapshotPendingDeferredToolDelta } from '../../src/session-runtime/deferred-tool-delta.mjs';
import { prepareDeferredToolCallThrough } from '../../src/runtime/agent/orchestrator/session/loop/deferred-call-through.mjs';
import {
  applyInitialDeferredToolManifestToBp2,
  buildDeferredToolManifest,
} from '../../src/runtime/agent/orchestrator/context/collect.mjs';

test('load_tool is a pure loader: free-text queries never load or discover', () => {
  const toolSearchSession = {
    tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
    deferredToolCatalog: smokeCatalog.slice(),
    deferredSelectedTools: [...fullDefaults],
  };
  const listQueryResult = JSON.parse(__renderToolSearchForTest({ query: 'shell' }, toolSearchSession, 'full'));
  if (listQueryResult.selected || (Array.isArray(listQueryResult.loaded) && listQueryResult.loaded.length)) {
    throw new Error(`load_tool free-text query must not load: ${JSON.stringify(listQueryResult)}`);
  }
  if (!listQueryResult.error || !/names/i.test(listQueryResult.error)) {
    throw new Error(`load_tool free-text query must steer to names[]: ${JSON.stringify(listQueryResult)}`);
  }
  if (listQueryResult.activeTools.includes('shell') || (Array.isArray(listQueryResult.discoveredTools) && listQueryResult.discoveredTools.includes('shell'))) {
    throw new Error(`load_tool free-text query must not activate/discover tools: ${JSON.stringify(listQueryResult)}`);
  }
  for (const legacyArgs of [{ select: 'shell' }, { query: 'select:shell' }]) {
    const legacyResult = JSON.parse(__renderToolSearchForTest(legacyArgs, toolSearchSession, 'full'));
    if (legacyResult.selected
      || (Array.isArray(legacyResult.loaded) && legacyResult.loaded.length)
      || legacyResult.activeTools.includes('shell')) {
      throw new Error(`load_tool legacy inputs must not load tools: ${JSON.stringify(legacyResult)}`);
    }
  }
  // names[] is the primary loader input (aliases expand, tools activate).
  const namesLoadResult = JSON.parse(__renderToolSearchForTest({ names: ['shell', 'recall'] }, {
    tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
    deferredToolCatalog: smokeCatalog.slice(),
    deferredSelectedTools: [...fullDefaults],
  }, 'full'));
  for (const name of ['shell', 'recall']) {
    if (!namesLoadResult.activeTools.includes(name) || !namesLoadResult.loaded.includes(name)) {
      throw new Error(`load_tool names[] must load ${name}: ${JSON.stringify(namesLoadResult)}`);
    }
  }
  // names[] loads multiple aliases and persists their expanded tool set.
  const bulkSelectResult = JSON.parse(__renderToolSearchForTest({ names: ['shell', 'recall'] }, toolSearchSession, 'full'));
  if (bulkSelectResult.selected?.mode !== 'select') {
    throw new Error(`tool_search query-select must report select mode: ${JSON.stringify(bulkSelectResult.selected)}`);
  }
  for (const name of ['shell', 'task', 'recall']) {
    if (!bulkSelectResult.activeTools.includes(name)) {
      throw new Error(`tool_search bulk select missing ${name}: ${JSON.stringify(bulkSelectResult)}`);
    }
  }
  const prefixedSelectSession = {
    tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
    deferredToolCatalog: smokeCatalog.slice(),
    deferredSelectedTools: [...fullDefaults],
  };
  const prefixedSelectResult = JSON.parse(__renderToolSearchForTest({ names: ['shell', 'recall'] }, prefixedSelectSession, 'full'));
  if (!prefixedSelectResult.activeTools.includes('shell') || !prefixedSelectResult.activeTools.includes('recall')) {
    throw new Error(`tool_search select field should accept select: prefix: ${JSON.stringify(prefixedSelectResult)}`);
  }
  if (!Array.isArray(toolSearchSession.deferredDiscoveredTools) || !toolSearchSession.deferredDiscoveredTools.includes('shell')) {
    throw new Error('tool_search must persist discovered tool state on the session');
  }
});

test('native provider loading keeps the base tool surface byte-stable', () => {
  const nativeToolSearchSession = {
    provider: 'openai-oauth',
    tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
    deferredToolCatalog: smokeCatalog.slice(),
    deferredSelectedTools: [...fullDefaults],
    deferredDiscoveredTools: [],
    deferredProviderMode: 'native',
    deferredNativeTools: true,
  };
  nativeToolSearchSession.deferredCallableTools = nativeToolSearchSession.tools.map((tool) => tool.name);
  const nativeBaseToolsJson = JSON.stringify(nativeToolSearchSession.tools);
  const nativeBaseRequest = buildRequestBody(
    [{ role: 'user', content: 'load shell' }],
    'gpt-5.4',
    nativeToolSearchSession.tools,
    { sessionId: 'deferred-stability', session: nativeToolSearchSession },
  );
  const nativeSelectResult = JSON.parse(__renderToolSearchForTest({ names: ['shell', 'recall'] }, nativeToolSearchSession, 'full'));
  for (const name of ['shell', 'task', 'recall']) {
    if (!nativeSelectResult.activeTools.includes(name)) {
      throw new Error(`native load_tool must register ${name} as callable: ${JSON.stringify(nativeSelectResult)}`);
    }
  }
  if (JSON.stringify(nativeToolSearchSession.tools) !== nativeBaseToolsJson
    || nativeToolSearchSession.tools.some((tool) => tool?.name === 'shell')) {
    throw new Error(`native load_tool must keep the base tools array byte-stable: ${JSON.stringify(nativeToolSearchSession.tools)}`);
  }
  if (!nativeSelectResult.nativeToolSearch?.openaiTools?.some((tool) => tool?.name === 'shell' && tool?.defer_loading === true)) {
    throw new Error(`native tool_search must return OpenAI loadable deferred tools: ${JSON.stringify(nativeSelectResult.nativeToolSearch)}`);
  }
  if (!nativeSelectResult.nativeToolSearch?.toolReferences?.includes('shell')) {
    throw new Error(`native tool_search must return Anthropic tool references: ${JSON.stringify(nativeSelectResult.nativeToolSearch)}`);
  }
  const nativeToolCountAfterFirstLoad = nativeToolSearchSession.tools.length;
  const nativeRepeatResult = JSON.parse(__renderToolSearchForTest({ names: ['shell', 'recall'] }, nativeToolSearchSession, 'full'));
  if (nativeRepeatResult.loaded.length
    || !['shell', 'task', 'recall'].every((name) => nativeRepeatResult.alreadyActive.includes(name))
    || !['shell', 'task', 'recall'].every((name) => nativeRepeatResult.nativeToolSearch?.toolReferences?.includes(name))
    || !['shell', 'task', 'recall'].every((name) => nativeRepeatResult.nativeToolSearch?.openaiTools?.some((tool) => tool?.name === name && tool?.defer_loading === true))
    || nativeToolSearchSession.tools.length !== nativeToolCountAfterFirstLoad) {
    throw new Error(`repeated native load_tool must refresh references without mutating base tools: ${JSON.stringify(nativeRepeatResult)}`);
  }
  const nativeHistory = [
    { role: 'user', content: 'load shell' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'search-1', name: 'load_tool', arguments: { names: ['shell'] }, nativeType: 'tool_search_call' }],
    },
    {
      role: 'tool',
      toolCallId: 'search-1',
      content: nativeSelectResult.nativeToolSearch.summary,
      nativeToolSearch: nativeSelectResult.nativeToolSearch,
    },
  ];
  const nativeFollowupRequest = buildRequestBody(
    nativeHistory,
    'gpt-5.4',
    nativeToolSearchSession.tools,
    { sessionId: 'deferred-stability', session: nativeToolSearchSession },
  );
  if (JSON.stringify(nativeFollowupRequest.tools) !== JSON.stringify(nativeBaseRequest.tools)
    || nativeFollowupRequest.prompt_cache_key !== nativeBaseRequest.prompt_cache_key) {
    throw new Error('OpenAI native loading must not change tools or prompt_cache_key');
  }
  const nativeOutput = nativeFollowupRequest.input.find((item) => item?.type === 'tool_search_output');
  if (!nativeOutput?.tools?.some((tool) => tool?.name === 'shell')
    || nativeFollowupRequest.tools.some((tool) => tool?.name === 'shell')) {
    throw new Error(`OpenAI loaded schemas must exist only in tool_search_output history: ${JSON.stringify(nativeFollowupRequest)}`);
  }
  const directMcpSession = {
    provider: 'openai-oauth',
    toolSpec: 'full',
    tools: [{ name: 'load_tool', inputSchema: { type: 'object', properties: {} } }],
    deferredToolCatalog: [
      { name: 'load_tool', inputSchema: { type: 'object', properties: {} } },
      { name: 'mcp__demo__ping', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
    ],
    deferredCallableTools: ['load_tool', 'mcp__demo__ping'],
    deferredProviderMode: 'native',
    deferredNativeTools: true,
  };
  prepareDeferredToolCallThrough(directMcpSession, 'mcp__demo__ping', {});
  if (directMcpSession.tools.some((tool) => tool?.name === 'mcp__demo__ping')
    || !directMcpSession.deferredCallableTools.includes('mcp__demo__ping')) {
    throw new Error('subsequent native MCP calls must use the callable registry without session.tools promotion');
  }
});

test('readonly blocks, missing names, and MCP status reporting', () => {
  const readonlyReportingSession = {
    tools: [TOOL_SEARCH_TOOL],
    deferredToolCatalog: smokeCatalog.slice(),
    deferredSelectedTools: ['load_tool'],
  };
  const readonlyReportingResult = JSON.parse(__renderToolSearchForTest(
    { names: ['shell', 'definitely_missing_tool'] },
    readonlyReportingSession,
    'readonly',
    {
      mcpStatus: () => ({
        servers: [
          { name: 'connecting-mcp', status: 'disconnected' },
          { name: 'failed-mcp', status: 'failed' },
        ],
      }),
    },
  ));
  if (!readonlyReportingResult.blocked?.some((entry) => entry?.name === 'shell' && entry?.reason === 'readonly mode')
    || !readonlyReportingResult.missing.includes('definitely_missing_tool')
    || !readonlyReportingResult.pendingMcpServers?.includes('connecting-mcp')
    || !readonlyReportingResult.failedMcpServers?.includes('failed-mcp')
    || !/retry next turn/i.test(readonlyReportingResult.note || '')
    || !/unavailable/i.test(readonlyReportingResult.note || '')) {
    throw new Error(`load_tool must preserve readonly and MCP status reporting: ${JSON.stringify(readonlyReportingResult)}`);
  }
});

test('native custom apply_patch and alias/plain-query loading behaviors', () => {
  const nativePatchSearchSession = {
    provider: 'openai-oauth',
    tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name) && tool?.name !== 'apply_patch'),
    deferredToolCatalog: smokeCatalog.slice(),
    deferredSelectedTools: [...fullDefaults].filter((name) => name !== 'apply_patch'),
    deferredDiscoveredTools: [],
    deferredProviderMode: 'native',
    deferredNativeTools: true,
  };
  const nativePatchSelectResult = JSON.parse(__renderToolSearchForTest({ names: ['apply_patch'] }, nativePatchSearchSession, 'full'));
  const nativePatchTool = nativePatchSelectResult.nativeToolSearch?.openaiTools?.find((tool) => tool?.name === 'apply_patch');
  if (nativePatchTool?.type !== 'custom' || nativePatchTool?.format?.syntax !== 'lark') {
    throw new Error(`native tool_search must preserve apply_patch as OpenAI custom freeform: ${JSON.stringify(nativePatchSelectResult.nativeToolSearch)}`);
  }
  if (nativePatchTool.defer_loading === true || nativePatchTool.parameters) {
    throw new Error(`native tool_search custom apply_patch must not be downgraded to deferred function schema: ${JSON.stringify(nativePatchTool)}`);
  }
  const grokCanonicalSession = { provider: 'grok-oauth', model: 'grok-code-fast-1', tools: [], messages: [] };
  applyDeferredToolSurface(grokCanonicalSession, 'full', smokeCatalog, { provider: 'grok-oauth' });
  const grokCanonicalJson = JSON.stringify(grokCanonicalSession.tools);
  const grokLoadResult = JSON.parse(__renderToolSearchForTest({ names: ['edit'] }, grokCanonicalSession, 'full'));
  if (grokCanonicalSession.deferredNativeTools
    || grokLoadResult.nativeToolSearch
    || JSON.stringify(grokCanonicalSession.tools) !== grokCanonicalJson
    || !grokLoadResult.alreadyActive.includes('edit')) {
    throw new Error(`Grok must use a fixed canonical ordinary-function surface: ${JSON.stringify(grokLoadResult)}`);
  }
  // Native names[] loading explicitly activates aliases on the current surface.
  const nativeSelectQuerySession = {
    tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
    deferredToolCatalog: smokeCatalog.slice(),
    deferredSelectedTools: [...fullDefaults],
    deferredDiscoveredTools: [],
    deferredProviderMode: 'native',
    deferredNativeTools: true,
  };
  const nativeSelectQueryResult = JSON.parse(__renderToolSearchForTest({ names: ['websearch'] }, nativeSelectQuerySession, 'full'));
  for (const name of ['web_search', 'web_fetch']) {
    if (!nativeSelectQueryResult.activeTools.includes(name)) {
      throw new Error(`native tool_search query-select should load ${name}: ${JSON.stringify(nativeSelectQueryResult)}`);
    }
  }
  if (!nativeSelectQueryResult.nativeToolSearch?.toolReferences?.includes('web_search')) {
    throw new Error(`native query-select must return nativeToolSearch payload: ${JSON.stringify(nativeSelectQueryResult.nativeToolSearch)}`);
  }
  // Native late-MCP selections must resolve against the boot+late catalog union,
  // otherwise the load result says "loaded" but omits the provider payload.
  const nativeLateMcpSearchSession = {
    provider: 'openai-oauth',
    tools: [],
    deferredToolCatalog: [{ name: 'load_tool', description: 'Loader.', inputSchema: { type: 'object', properties: {} } }],
    deferredLateToolCatalog: [{ name: 'mcp__late__ping', description: 'Late MCP tool.', inputSchema: { type: 'object', properties: {} } }],
    deferredDiscoveredTools: [],
    deferredProviderMode: 'native',
    deferredNativeTools: true,
  };
  const nativeLateMcpSelectResult = JSON.parse(__renderToolSearchForTest({ names: ['mcp__late__ping'] }, nativeLateMcpSearchSession, 'full'));
  if (nativeLateMcpSearchSession.tools.some((tool) => tool?.name === 'mcp__late__ping')) {
    throw new Error(`native late MCP load must not promote its schema onto session.tools: ${JSON.stringify(nativeLateMcpSearchSession.tools)}`);
  }
  if (!nativeLateMcpSelectResult.nativeToolSearch?.toolReferences?.includes('mcp__late__ping')) {
    throw new Error(`native late MCP load must include nativeToolSearch payload: ${JSON.stringify(nativeLateMcpSelectResult)}`);
  }
  if (!nativeLateMcpSelectResult.nativeToolSearch?.openaiTools?.some((tool) => tool?.name === 'mcp__late__ping' && tool?.defer_loading === true)) {
    throw new Error(`native late MCP load must include OpenAI loadable tool spec: ${JSON.stringify(nativeLateMcpSelectResult.nativeToolSearch)}`);
  }
  // A plain query never auto-loads/discovers, even on native providers.
  const nativePlainQuerySession = {
    tools: smokeCatalog.filter((tool) => fullDefaults.has(tool?.name)),
    deferredToolCatalog: smokeCatalog.slice(),
    deferredSelectedTools: [...fullDefaults],
    deferredDiscoveredTools: [],
    deferredProviderMode: 'native',
    deferredNativeTools: true,
  };
  for (const q of ['run tests', 'web docs', 'memory previous', 'status']) {
    const r = JSON.parse(__renderToolSearchForTest({ query: q }, nativePlainQuerySession, 'full'));
    if (r.selected || r.discoveredTools.length) {
      throw new Error(`native tool_search plain query "${q}" must not auto-load/discover: ${JSON.stringify(r)}`);
    }
  }
});

test('late MCP reconciliation: Gemini manifests and native typed deltas', () => {
  const geminiManifestSession = { provider: 'gemini', tools: [], messages: [] };
  const manifestBase = [
    { name: 'load_tool', inputSchema: { type: 'object', properties: {} } },
    { name: 'read', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
  ];
  applyDeferredToolSurface(geminiManifestSession, 'full', manifestBase, { provider: 'gemini' });
  const geminiTurnManifest = JSON.stringify(geminiManifestSession.tools);
  const geminiLate = { name: 'mcp__gemini__late', inputSchema: { type: 'object', properties: {} } };
  // Continuations use the same array; only the next user-turn reconciliation may replace it.
  if (JSON.stringify(geminiManifestSession.tools) !== geminiTurnManifest) {
    throw new Error('Gemini manifest changed within a user turn');
  }
  reconcileDeferredMcpToolCatalog(geminiManifestSession, [geminiLate]);
  if (!geminiManifestSession.tools.some((tool) => tool.name === 'mcp__gemini__late')) {
    throw new Error('Gemini must adopt the complete ordered live manifest at the next user turn');
  }
  const nativeLateSession = {
    provider: 'openai-oauth',
    deferredProviderMode: 'native',
    deferredNativeTools: true,
    deferredToolCatalog: manifestBase,
    deferredLateToolCatalog: [],
    deferredAnnouncedTools: manifestBase.map((tool) => tool.name),
    deferredSurfaceMode: 'full',
    deferredCallableTools: ['load_tool', 'read'],
    tools: manifestBase.slice(),
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'real task' },
      { role: 'assistant', content: 'done' },
    ],
  };
  const nativeLateMessagesBefore = JSON.stringify(nativeLateSession.messages);
  let nativeLateEnqueueCalls = 0;
  reconcileDeferredMcpToolCatalog(nativeLateSession, [{
    name: 'mcp__demo__late',
    description: 'Late tool metadata.',
    inputSchema: { type: 'object', properties: {} },
  }], {
    enqueue() {
      nativeLateEnqueueCalls += 1;
      return true;
    },
  });
  const nativeLateDelta = snapshotPendingDeferredToolDelta(nativeLateSession);
  if (nativeLateEnqueueCalls !== 0
    || JSON.stringify(nativeLateSession.messages) !== nativeLateMessagesBefore
    || nativeLateSession.pendingDeferredToolDelta?.type !== 'deferred_tools_delta'
    || !nativeLateDelta?.content.includes('mcp__demo__late: Late tool metadata.')) {
    throw new Error(`late MCP reconcile must persist one typed delta without creating a turn: ${JSON.stringify({
      nativeLateEnqueueCalls,
      messages: nativeLateSession.messages,
      delta: nativeLateSession.pendingDeferredToolDelta,
    })}`);
  }
});

test('deferred manifest rendering and BP2 injection', () => {
  // Skill-style deferred manifest: `- name: description` lines, `<`/`>` sanitized,
  // bare names allowed, header instructs direct calls, empty pool → ''.
  const manifestText = buildDeferredToolManifest([
    { name: 'shell', description: 'Run commands.' },
    { name: 'web_search', description: 'Web <search> now.' },
    'recall',
  ]);
  if (!/<available-deferred-tools>/.test(manifestText) || !/- shell: Run commands\./.test(manifestText)) {
    throw new Error(`deferred manifest must render "- name: description" lines: ${manifestText}`);
  }
  if (!/call any tool listed below directly/i.test(manifestText)) {
    throw new Error(`deferred manifest must tell the model it can call listed tools directly: ${manifestText}`);
  }
  if (!/^- recall$/m.test(manifestText)) {
    throw new Error(`deferred manifest must allow bare names without descriptions: ${manifestText}`);
  }
  if (/[<>]/.test(manifestText.replace(/<\/?available-deferred-tools>/g, ''))) {
    throw new Error(`deferred manifest must sanitize angle brackets in descriptions: ${manifestText}`);
  }
  if (buildDeferredToolManifest([]) !== '') {
    throw new Error('empty deferred pool must yield an empty manifest');
  }
  const bp2ManifestSession = {
    messages: [
      { role: 'system', content: 'BP1 BASE' },
      { role: 'system', content: 'BP2 PROFILE' },
      { role: 'system', content: 'BP3 SESSION', cacheTier: 'tier3' },
    ],
    deferredToolCatalog: [
      { name: 'shell', description: 'Run commands.' },
      { name: 'recall', description: 'Recall prior work.' },
    ],
  };
  applyInitialDeferredToolManifestToBp2(bp2ManifestSession, ['shell', 'recall']);
  const bp2ManifestText = bp2ManifestSession.messages[1].content;
  if (!/- shell: Run commands\./.test(bp2ManifestText) || !/- recall: Recall prior work\./.test(bp2ManifestText)) {
    throw new Error(`BP2 deferred manifest must carry catalog descriptions: ${bp2ManifestText}`);
  }
  if (bp2ManifestSession.messages[0].content !== 'BP1 BASE'
    || bp2ManifestSession.messages[2].content !== 'BP3 SESSION'
    || bp2ManifestSession.deferredToolBp2Applied !== true) {
    throw new Error(`BP2 deferred manifest injection must preserve BP1/BP3: ${JSON.stringify(bp2ManifestSession.messages)}`);
  }
});
