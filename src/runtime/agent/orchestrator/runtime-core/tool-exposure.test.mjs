import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { TOOL_DEFS as WEB_SEARCH_TOOL_DEFS } from '../../../web-search/tool-defs.mjs';
import { TOOL_DEFS as MEMORY_TOOL_DEFS } from '../../../memory/tool-defs.mjs';
import { TOOL_DEFS as BROWSER_TOOL_DEFS } from '../../../browser-bridge/tool-defs.mjs';
import { TOOL_DEFS as COMPUTER_TOOL_DEFS } from '../../../computer-bridge/tool-defs.mjs';
import { TOOL_DEFS as OFFICE_TOOL_DEFS } from '../../../office/tool-defs.mjs';
import { TOOL_DEFS as MEDIA_TOOL_DEFS } from '../../../media/tool-defs.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../tools/code-graph-tool-defs.mjs';
import { previewSessionTools } from '../session/manager/tool-resolution.mjs';
import { estimateToolSchemaTokens } from '../session/context-tool-schema.mjs';
import { collectStandaloneToolDefs } from './tool-defs.mjs';
import { DEFERRED_DEFAULT_LEAD_TOOLS } from './tool-catalog-data.mjs';
import {
  applyDeferredToolSurface,
  reconcileDeferredMcpToolCatalog,
  rearmLateDeferredTools,
  refreshInitialDeferredMcpSurface,
  isReadonlySelectable,
  renderToolSearch,
  selectDeferredTools,
  snapshotProviderRequestTools,
} from './tool-catalog.mjs';
import {
  acknowledgePendingDeferredToolDelta,
  mergePendingDeferredToolDelta,
  snapshotPendingDeferredToolDelta,
} from './deferred-tool-delta.mjs';
import { _sessionForDisk } from '../session/store/serialize.mjs';
import { describeBridgeTools, BRIDGE_LIMITS } from './tool-bridge.mjs';
import { loadSkillToolDependencies } from './skill-tool-loading.mjs';
import { buildSkillToolEnvelope } from '../context/collect.mjs';
import { setInternalToolsProvider } from '../internal-tools.mjs';
import { executeTool } from '../session/loop/tool-exec.mjs';
import { resolveExecutionToolCall } from '../session/loop/tool-call-resolution.mjs';
import { rebuildToolSurfaceForProviderWithMigration } from '../session/loop/tool-exposure-migration.mjs';

const BRIDGE_NAMES = ['load_tool', 'call_tool'];

function realisticCatalog() {
  const { standaloneTools } = collectStandaloneToolDefs({
    webSearchToolDefs: { TOOL_DEFS: WEB_SEARCH_TOOL_DEFS },
    memoryToolDefs: { TOOL_DEFS: MEMORY_TOOL_DEFS },
    codeGraphToolDefs: { CODE_GRAPH_TOOL_DEFS },
    browserToolDefs: BROWSER_TOOL_DEFS,
    computerToolDefs: COMPUTER_TOOL_DEFS,
    officeToolDefs: OFFICE_TOOL_DEFS,
    mediaToolDefs: MEDIA_TOOL_DEFS,
  });
  return { builtins: previewSessionTools('full', [], {}), standaloneTools };
}

const systemMessages = () => [
  { role: 'system', content: '# Tool Use' },
  { role: 'system', content: '# Profile' },
  { role: 'system', content: '# Session', cacheTier: 'tier3' },
];

function leadSession(provider, extra = {}) {
  const { builtins, standaloneTools } = realisticCatalog();
  const session = {
    id: `exposure-${randomUUID()}`,
    provider,
    model: 'fixture-model',
    toolSpec: 'full',
    tools: builtins.slice(),
    messages: systemMessages(),
    ...extra,
  };
  applyDeferredToolSurface(session, 'lead', [...standaloneTools, ...(extra.extraTools || [])], { provider });
  return session;
}

const requestTools = (session) =>
  snapshotProviderRequestTools({
    provider: session.provider,
    tools: session.tools,
    session,
    messages: session.messages,
  });

test('a realistic built-in catalog exposes only the core and the bridge on bridge providers', (t) => {
  const native = leadSession('anthropic-oauth');
  const nativeTokens = estimateToolSchemaTokens(requestTools(native));
  for (const provider of ['antigravity-oauth', 'gemini']) {
    const session = leadSession(provider);
    const catalogNames = new Set(session.deferredToolCatalog.map((tool) => tool.name));
    const core = DEFERRED_DEFAULT_LEAD_TOOLS.filter((name) => name !== 'load_tool' && catalogNames.has(name));
    // Exactly the core plus the shared load_tool and call_tool.
    assert.deepEqual(new Set(session.tools.map((tool) => tool.name)), new Set([...core, ...BRIDGE_NAMES]));
    assert.equal(session.tools.length, core.length + BRIDGE_NAMES.length);
    assert.equal(session.toolExposureMode, 'bridge-v1');
    assert.ok(catalogNames.has('web_fetch') && catalogNames.has('office') && catalogNames.has('browser'));
    // The fixed prompt carries the native roster, then the bridge guidance.
    const bp2 = session.messages[1].content;
    assert.match(
      bp2,
      /<\/available-deferred-tools>\n\n<tool-bridge>\n[^\n]*call_tool[^\n]*load_tool[^\n]*\n<\/tool-bridge>$/
    );
    for (const name of ['web_fetch', 'office', 'browser']) assert.match(bp2, new RegExp(`^- ${name}: `, 'm'));
    assert.equal(bp2.match(/<available-deferred-tools>/g).length, 1);
    assert.doesNotMatch(bp2, /^- (call_tool|search_tools|load_tool)\b/m);
    const bridgeTokens = estimateToolSchemaTokens(requestTools(session));
    const fullTokens = estimateToolSchemaTokens(session.deferredToolCatalog);
    t.diagnostic(
      `${provider}: ${session.tools.length} tools / ${bridgeTokens} schema tokens (native anthropic-oauth ${native.tools.length} tools / ${nativeTokens}; full catalog ${session.deferredToolCatalog.length} tools / ${fullTokens})`
    );
    assert.ok(bridgeTokens < fullTokens / 2, `${bridgeTokens} vs ${fullTokens}`);
  }
  assert.equal(native.toolExposureMode, undefined);
  assert.equal(
    native.tools.some((tool) => tool.name === 'search_tools' || tool.name === 'call_tool'),
    false
  );
});

test('native and bridge sessions carry a byte-identical load_tool definition', () => {
  const loader = (session) => JSON.stringify(requestTools(session).find((tool) => tool.name === 'load_tool'));
  const native = leadSession('anthropic-oauth');
  assert.ok(loader(native));
  for (const provider of ['gemini', 'antigravity-oauth', 'openrouter']) {
    assert.equal(loader(leadSession(provider)), loader(native), provider);
  }
});

const rosterOf = (session) =>
  session.messages
    .map((message) => message.content)
    .join('\n')
    .match(/<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>/)?.[0] ?? '';
const rosterNames = (session) => [...rosterOf(session).matchAll(/^- ([^:\n]+)/gm)].map((match) => match[1]);

test('the bridge roster equals the native roster for the same catalog', () => {
  const native = leadSession('anthropic-oauth');
  for (const provider of ['gemini', 'antigravity-oauth', 'openrouter']) {
    const bridged = leadSession(provider);
    assert.ok(rosterOf(bridged).length > 0, provider);
    assert.equal(rosterOf(bridged), rosterOf(native), provider);
  }
});

test('a bridge roster never lists tools its allowlist, denied tools or read-only mode exclude', () => {
  const { builtins, standaloneTools } = realisticCatalog();
  const all = [...builtins, ...standaloneTools].map((tool) => tool.name);
  const allowed = leadSession('gemini', {
    schemaAllowedTools: [...all.filter((name) => name !== 'office'), ...BRIDGE_NAMES],
    disallowedTools: ['browser'],
  });
  const listed = rosterNames(allowed);
  assert.ok(listed.includes('web_fetch'));
  assert.equal(listed.includes('office'), false, 'allowlist-excluded');
  assert.equal(listed.includes('browser'), false, 'denied');

  // Read-only: only read-only tools are listed.
  const readonly = {
    provider: 'gemini',
    model: 'fixture-model',
    toolSpec: 'readonly',
    tools: builtins.slice(),
    messages: systemMessages(),
  };
  applyDeferredToolSurface(readonly, 'readonly', standaloneTools, { provider: 'gemini' });
  const catalog = new Map(readonly.deferredToolCatalog.map((tool) => [tool.name, tool]));
  const readonlyListed = rosterNames(readonly);
  assert.ok(readonlyListed.length > 0);
  for (const name of readonlyListed) assert.ok(isReadonlySelectable(catalog.get(name)), name);
  assert.ok(
    readonly.deferredToolCatalog.some((tool) => !isReadonlySelectable(tool) && !readonly.tools.includes(tool)),
    'the catalog holds write tools the roster leaves out'
  );

  // Late MCP tools the policy excludes are never announced either.
  const excluded = { name: 'mcp__late__secret', description: 'Secret.', inputSchema: { type: 'object' } };
  const permitted = { name: 'mcp__late__open', description: 'Open.', inputSchema: { type: 'object' } };
  allowed.schemaAllowedTools.push(permitted.name);
  reconcileDeferredMcpToolCatalog(allowed, []);
  reconcileDeferredMcpToolCatalog(allowed, [excluded, permitted]);
  assert.deepEqual(
    allowed.pendingDeferredToolDelta.added.map((entry) => entry.name),
    [permitted.name]
  );
});

test('tool-free and read-only bridge sessions keep their limits', () => {
  const empty = { provider: 'gemini', tools: [], messages: systemMessages() };
  applyDeferredToolSurface(empty, 'lead', []);
  assert.deepEqual(empty.tools, []);
  assert.doesNotMatch(empty.messages.map((message) => message.content).join('\n'), /tool-bridge/);
  const readonly = leadSession('gemini', { toolSpec: 'readonly' });
  applyDeferredToolSurface(readonly, 'readonly', []);
  for (const tool of readonly.tools) {
    if (!BRIDGE_NAMES.includes(tool.name)) assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
  }
  assert.ok(readonly.tools.some((tool) => tool.name === 'call_tool'));
  // Legacy all-selected state never widens the wire surface.
  const legacy = leadSession('gemini');
  const all = legacy.deferredToolCatalog.map((tool) => tool.name);
  legacy.deferredSelectedTools = all;
  legacy.deferredDiscoveredTools = all;
  applyDeferredToolSurface(legacy, 'lead', []);
  assert.equal(legacy.tools.length, leadSession('gemini').tools.length);
});

test('a 234-tool catalog with a 156KB schema keeps the first request small', (t) => {
  const big = {
    name: 'mcp__huge__configure',
    description: 'Configure the huge system.',
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 1300 }, (_, index) => [
          `option_${index}`,
          { type: 'string', description: `Option ${index} ${'x'.repeat(80)}` },
        ])
      ),
    },
  };
  assert.ok(JSON.stringify(big).length >= 156_000, `${JSON.stringify(big).length}`);
  const { builtins, standaloneTools } = realisticCatalog();
  const filler = Array.from({ length: 234 }, (_, index) => ({
    name: `mcp__fleet__tool_${String(index).padStart(3, '0')}`,
    description: `Fleet tool ${index}.`,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  }));
  const session = {
    provider: 'antigravity-oauth',
    tools: builtins.slice(),
    messages: systemMessages(),
    toolSpec: 'full',
  };
  const builtinCount = new Set([...builtins, ...standaloneTools].map((tool) => tool.name)).size;
  const mcp = [big, ...filler.slice(0, 234 - builtinCount - 1)];
  applyDeferredToolSurface(session, 'lead', [...standaloneTools, ...mcp]);
  assert.equal(session.deferredToolCatalog.length, 234);
  const sent = requestTools(session);
  const tokens = estimateToolSchemaTokens(sent);
  assert.equal(
    sent.some((tool) => tool.name === big.name),
    false
  );
  const catalogTokens = estimateToolSchemaTokens(session.deferredToolCatalog);
  t.diagnostic(`234-tool catalog: first request ${sent.length} tools / ${tokens} schema tokens of ${catalogTokens}`);
  assert.ok(tokens < 12_000, `${tokens} schema tokens`);
  assert.ok(catalogTokens > 40_000);
  // Its description arrives in bounded pages on demand.
  const page = describeBridgeTools(session, { names: [big.name] });
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= BRIDGE_LIMITS.describeMaxBytes);
  assert.ok(page.continueWith.names);
});

test('bridge tool definitions stay byte-identical across search, describe, call, skill loading and MCP churn', async (t) => {
  const scopeId = `exposure-bytes-${randomUUID()}`;
  const probe = {
    name: 'bridge_probe',
    description: 'Probe.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  };
  t.after(setInternalToolsProvider({ scopeId, tools: [probe], executor: async () => 'probed' }));
  const session = leadSession('gemini', { mcpScopeId: scopeId, extraTools: [probe] });
  const tools = () => JSON.stringify(requestTools(session));
  const prompt = () => JSON.stringify(session.messages);
  const before = { tools: tools(), prompt: prompt() };
  const same = (event) => {
    assert.equal(tools(), before.tools, event);
    assert.equal(prompt(), before.prompt, event);
  };
  assert.match(renderToolSearch({ query: 'web' }, session, 'lead'), /^Error: INVALID_ARGUMENTS: /);
  same('stray query');
  describeBridgeTools(session, { names: ['web_fetch', 'office'] });
  renderToolSearch({ names: ['office'] }, session, 'lead');
  same('describe');
  const call = resolveExecutionToolCall(
    { id: 'X', name: 'call_tool', arguments: { name: 'bridge_probe', arguments: {} } },
    session
  );
  assert.equal(call.name, 'bridge_probe');
  assert.equal(
    await executeTool(call.name, call.arguments, process.cwd(), null, session, { bridgeWireCall: call.wireCall }),
    'probed'
  );
  same('call');
  const skill = loadSkillToolDependencies(
    buildSkillToolEnvelope('deck', '# Deck', '/skills/deck', { toolDependencies: [{ type: 'tool', value: 'office' }] }),
    session
  );
  assert.match(skill.result, /available through call_tool: office/);
  same('skill loading');
});

test('bridge MCP connect, reconnect and removal append delta notices and keep prompt and tool bytes', () => {
  const session = leadSession('gemini');
  const tools = () => JSON.stringify(requestTools(session));
  const prompt = () => JSON.stringify(session.messages);
  const before = { tools: tools() };
  const same = (event) => {
    assert.equal(tools(), before.tools, event);
    assert.equal(prompt(), before.prompt, event);
  };
  // First turn, before any request: a server that finished its handshake
  // joins the initial roster in place (exactly as native); tool defs keep
  // their bytes.
  const mcp = { name: 'mcp__late__run', description: 'Run.', inputSchema: { type: 'object', properties: {} } };
  refreshInitialDeferredMcpSurface(session, [mcp]);
  assert.equal(tools(), before.tools, 'first-turn MCP fold');
  assert.match(rosterOf(session), /^- mcp__late: Run$/m);
  reconcileDeferredMcpToolCatalog(session, [mcp]);
  assert.equal(session.pendingDeferredToolDelta, undefined, 'the initial roster already announced it');
  before.prompt = prompt();

  // Later connects, reconnects and removals: appended delta notices only.
  const late = { name: 'mcp__late__two', description: 'Two.', inputSchema: { type: 'object', properties: {} } };
  reconcileDeferredMcpToolCatalog(session, [mcp, late]);
  same('MCP connect');
  assert.deepEqual(session.pendingDeferredToolDelta.added, [{ name: late.name, description: 'Two.' }]);
  assert.match(snapshotPendingDeferredToolDelta(session).content, /Added deferred tools:\n- mcp__late: Two\n/);
  reconcileDeferredMcpToolCatalog(session, [{ ...mcp, description: 'Run (reconnected).' }, late]);
  assert.equal(
    describeBridgeTools(session, { names: [mcp.name] }).entries[0].document.description,
    'Run (reconnected).'
  );
  same('MCP reconnect');
  reconcileDeferredMcpToolCatalog(session, []);
  same('MCP removal');
  assert.deepEqual(session.pendingDeferredToolDelta.added, []);
  assert.deepEqual(session.pendingDeferredToolDelta.removed, [mcp.name]);
});

test('a compaction that strips an announced late MCP tool re-arms it for the next turn only', () => {
  const session = leadSession('gemini');
  const boot = { name: 'mcp__late__run', description: 'Run.', inputSchema: { type: 'object', properties: {} } };
  const late = { name: 'mcp__late__two', description: 'Two.', inputSchema: { type: 'object', properties: {} } };
  refreshInitialDeferredMcpSurface(session, [boot]);
  reconcileDeferredMcpToolCatalog(session, [boot]);
  reconcileDeferredMcpToolCatalog(session, [boot, late]);
  const announced = snapshotPendingDeferredToolDelta(session);
  assert.deepEqual(announced.added, [{ name: late.name, description: 'Two.' }]);
  assert.equal(acknowledgePendingDeferredToolDelta(session, announced.revision), true);
  assert.equal(snapshotPendingDeferredToolDelta(session), null, 'delivered once: nothing pending, text stripped');

  // Compaction: the boot manifest is not rebuilt, so only a re-arm can tell the model again.
  assert.deepEqual(rearmLateDeferredTools(session), [late.name], 'boot-listed tools are not re-announced');
  const again = snapshotPendingDeferredToolDelta(session);
  assert.deepEqual(again.added, [{ name: late.name, description: 'Two.' }]);
  assert.equal(acknowledgePendingDeferredToolDelta(session, again.revision), true);
  assert.equal(snapshotPendingDeferredToolDelta(session), null);

  // A tool that disconnected before the compaction is not re-announced.
  reconcileDeferredMcpToolCatalog(session, [boot]);
  acknowledgePendingDeferredToolDelta(session, snapshotPendingDeferredToolDelta(session).revision);
  assert.equal(rearmLateDeferredTools(session), null);
});

test('re-arming skips late tools the session keeps loaded, keeps history-only ones and never duplicates a pending one', () => {
  const session = leadSession('anthropic-oauth');
  const mcp = (name) => ({ name, description: `${name}.`, inputSchema: { type: 'object', properties: {} } });
  const [boot, loaded, history, pending] = ['boot', 'loaded', 'history', 'pending'].map((n) => mcp(`mcp__late__${n}`));
  refreshInitialDeferredMcpSurface(session, [boot]);
  reconcileDeferredMcpToolCatalog(session, [boot]);
  reconcileDeferredMcpToolCatalog(session, [boot, loaded, history]);
  acknowledgePendingDeferredToolDelta(session, snapshotPendingDeferredToolDelta(session).revision);
  // `loaded` stays in session state across a compaction; `history` was only ever
  // seen in the (compactable) transcript.
  assert.deepEqual(selectDeferredTools(session, [loaded.name], 'lead').added, [loaded.name]);
  reconcileDeferredMcpToolCatalog(session, [boot, loaded, history, pending]);
  assert.deepEqual(session.pendingDeferredToolDelta.added, [
    { name: pending.name, description: 'mcp__late__pending.' },
  ]);

  assert.deepEqual(rearmLateDeferredTools(session)?.sort(), [history.name, pending.name]);
  assert.deepEqual(
    snapshotPendingDeferredToolDelta(session).added.map((entry) => entry.name),
    [history.name, pending.name],
    'loaded tool is skipped; the pending one appears once'
  );
});

test('review: a read-only bridge session announces the removal of a late read-only MCP tool', () => {
  const { builtins, standaloneTools } = realisticCatalog();
  const session = {
    provider: 'gemini',
    model: 'fixture-model',
    toolSpec: 'readonly',
    tools: builtins.slice(),
    messages: systemMessages(),
  };
  applyDeferredToolSurface(session, 'readonly', standaloneTools, { provider: 'gemini' });
  reconcileDeferredMcpToolCatalog(session, []);
  const late = {
    name: 'mcp__late__lookup',
    description: 'Look it up.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  };
  reconcileDeferredMcpToolCatalog(session, [late]);
  assert.deepEqual(
    session.pendingDeferredToolDelta.added.map((entry) => entry.name),
    [late.name]
  );
  // The model saw the addition.
  assert.equal(acknowledgePendingDeferredToolDelta(session, snapshotPendingDeferredToolDelta(session).revision), true);
  assert.equal(session.pendingDeferredToolDelta, undefined);
  reconcileDeferredMcpToolCatalog(session, []);
  assert.deepEqual(session.pendingDeferredToolDelta?.removed, [late.name]);
  assert.deepEqual(session.pendingDeferredToolDelta.added, []);
  // A late write tool was never announced, so its removal is not either.
  const write = { ...late, name: 'mcp__late__write', annotations: { readOnlyHint: false } };
  delete session.pendingDeferredToolDelta;
  reconcileDeferredMcpToolCatalog(session, [write]);
  assert.equal(session.pendingDeferredToolDelta, undefined);
  reconcileDeferredMcpToolCatalog(session, []);
  assert.equal(session.pendingDeferredToolDelta, undefined);
});

test("a server's instruction text rides its first load_tool, once, and never the BP2 manifest", () => {
  const mcp = (name, description) => ({
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  });
  const gmailText = 'Account: dev@tribgames.com. This server acts only for this Gmail account.';
  const session = leadSession('anthropic-oauth', {
    extraTools: [
      mcp('mcp__gmail__send', 'Send.'),
      mcp('mcp__gmail__read', 'Read.'),
      mcp('mcp__docs__page', 'Page.'),
      mcp('mcp__plain__run', 'Run.'),
    ],
    mcpServerInstructions: { gmail: gmailText, docs: `<>${'d'.repeat(700)}`, plain: '   ' },
  });
  const load = (...names) => JSON.parse(renderToolSearch({ names }, session, 'lead'));

  const prompt = session.messages[1].content;
  assert.match(prompt, /^- mcp__gmail: /m);
  assert.doesNotMatch(prompt, /dev@tribgames|## gmail|mcp-instructions/);

  // First load of any tool of the server: heading + text, once.
  const first = load('mcp__gmail__send');
  assert.equal(first.mcpInstructions, `## gmail\n${gmailText}`);
  assert.deepEqual(first.loaded, ['mcp__gmail__send']);
  assert.equal(load('mcp__gmail__read').mcpInstructions, undefined, 'another tool of an announced server');
  assert.equal(load('mcp__gmail__send').mcpInstructions, undefined, 'a reload');
  // The server name loads its tools; sanitized and capped like the removed block.
  const docs = load('mcp__docs');
  assert.deepEqual(docs.loaded, ['mcp__docs__page']);
  assert.equal(docs.mcpInstructions, `## docs\n${'d'.repeat(597)}...`);
  // No instruction text: nothing is added, and nothing is recorded.
  const plain = load('mcp__plain__run', 'web_fetch');
  assert.equal('mcpInstructions' in plain, false);
  assert.deepEqual(session.mcpInstructionsAnnounced, ['gmail', 'docs']);
});

const instructionTool = (name) => ({
  name,
  description: 'Tool.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
});
const GMAIL_TEXT = 'Account: dev@tribgames.com. This server acts only for this Gmail account.';

test('a bridge session gets the server instructions with the first described tool, once', () => {
  const session = leadSession('gemini', {
    extraTools: [instructionTool('mcp__gmail__send'), instructionTool('mcp__gmail__read'), instructionTool('mcp__plain__run')],
  });
  session.mcpServerInstructions = { gmail: GMAIL_TEXT };
  assert.equal(session.toolExposureMode, 'bridge-v1');
  const describe = (...names) => JSON.parse(renderToolSearch({ names }, session, 'lead'));
  const first = describe('mcp__gmail__send');
  assert.equal(first.entries[0].name, 'mcp__gmail__send');
  assert.equal(first.mcpInstructions, `## gmail\n${GMAIL_TEXT}`);
  assert.equal(describe('mcp__gmail__send').mcpInstructions, undefined, 'a repeat');
  assert.equal(describe('mcp__gmail__read').mcpInstructions, undefined, 'another tool of the announced server');
  assert.equal('mcpInstructions' in describe('mcp__plain__run'), false, 'a server without instructions');
  // An error result carries nothing and records nothing.
  assert.match(renderToolSearch({ names: [] }, session, 'lead'), /^Error: /);
  assert.deepEqual(session.mcpInstructionsAnnounced, ['gmail']);
});

test('bridge instructions count inside the page budget and are announced only when they ride the page', () => {
  const bridgeSession = (padding, instructions) => {
    const session = leadSession('gemini', {
      extraTools: [{ ...instructionTool('mcp__big__a'), description: 'x'.repeat(padding) }, instructionTool('mcp__other__b')],
    });
    session.mcpServerInstructions = instructions;
    return session;
  };
  const describe = (session, names) => {
    const raw = renderToolSearch({ names }, session, 'lead');
    return { raw, page: JSON.parse(raw) };
  };
  const both = ['mcp__big__a', 'mcp__other__b'];
  // The largest padding for which both definitions still share one page.
  let low = 0;
  let high = 40_000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (describe(bridgeSession(middle, {}), both).page.entries.length === 2) low = middle;
    else high = middle - 1;
  }
  const near = describe(bridgeSession(low, {}), both);
  assert.equal(near.page.entries.length, 2, 'without instructions the page is full but whole');
  assert.ok(Buffer.byteLength(near.raw) <= BRIDGE_LIMITS.describeMaxBytes);

  const session = bridgeSession(low, { big: 'Big server text.', other: 'Other server text.' });
  const first = describe(session, both);
  assert.ok(Buffer.byteLength(first.raw) <= BRIDGE_LIMITS.describeMaxBytes, 'the instruction text stays inside the budget');
  assert.deepEqual(
    first.page.entries.map((entry) => entry.name),
    ['mcp__big__a'],
    'the second definition moved to the next page'
  );
  assert.equal(first.page.mcpInstructions, '## big\nBig server text.');
  assert.deepEqual(session.mcpInstructionsAnnounced, ['big'], 'the server that did not ride the page stays unannounced');
  // The next page carries the text of the server it describes.
  const next = describe(session, [first.page.continueWith.names]);
  assert.deepEqual(
    next.page.entries.map((entry) => entry.name),
    ['mcp__other__b']
  );
  assert.equal(next.page.mcpInstructions, '## other\nOther server text.');
  assert.ok(Buffer.byteLength(next.raw) <= BRIDGE_LIMITS.describeMaxBytes);
  assert.deepEqual(session.mcpInstructionsAnnounced, ['big', 'other']);
});

test('a native session whose tool is already active gets the server instructions once', () => {
  const session = leadSession('anthropic-oauth', { extraTools: [instructionTool('mcp__gmail__send')] });
  session.mcpServerInstructions = { gmail: GMAIL_TEXT };
  selectDeferredTools(session, ['mcp__gmail__send'], 'lead'); // loaded before the text was ever claimed
  const load = () => JSON.parse(renderToolSearch({ names: ['mcp__gmail__send'] }, session, 'lead'));
  const first = load();
  assert.deepEqual(first.alreadyActive, ['mcp__gmail__send']);
  assert.deepEqual(first.loaded, []);
  assert.equal(first.mcpInstructions, `## gmail\n${GMAIL_TEXT}`);
  assert.equal(load().mcpInstructions, undefined);
});

test('a compaction re-arms the server instructions for the next load', () => {
  const session = leadSession('anthropic-oauth', { extraTools: [instructionTool('mcp__gmail__send')] });
  session.mcpServerInstructions = { gmail: GMAIL_TEXT };
  const load = () => JSON.parse(renderToolSearch({ names: ['mcp__gmail__send'] }, session, 'lead'));
  assert.ok(load().mcpInstructions);
  assert.equal(load().mcpInstructions, undefined);
  rearmLateDeferredTools(session); // the transcript that held the load result is gone
  assert.equal(session.mcpInstructionsAnnounced, undefined);
  assert.equal(load().mcpInstructions, `## gmail\n${GMAIL_TEXT}`);
  assert.equal(load().mcpInstructions, undefined);
});

test('announced instructions and recorded removal servers survive a save and resume', () => {
  const session = { deferredMcpToolNames: ['mcp__docs__keep'], deferredToolCatalog: [] };
  mergePendingDeferredToolDelta(session, {
    removed: [
      { name: 'mcp__docs__a', server: 'docs' },
      { name: 'mcp__gone__b', server: 'gone' },
    ],
  });
  session.mcpInstructionsAnnounced = ['gmail'];
  const resumed = JSON.parse(JSON.stringify(_sessionForDisk(session)));
  assert.deepEqual(resumed.mcpInstructionsAnnounced, ['gmail']);
  assert.deepEqual(resumed.pendingDeferredToolDelta.removedServers, { mcp__docs__a: 'docs', mcp__gone__b: 'gone' });
  assert.equal(snapshotPendingDeferredToolDelta(resumed).content, snapshotPendingDeferredToolDelta(session).content);
  assert.match(snapshotPendingDeferredToolDelta(resumed).content, /^- mcp__docs: 1 tool removed$/m);
  assert.match(snapshotPendingDeferredToolDelta(resumed).content, /^- mcp__gone$/m);
});

test('switching bridge ↔ native rebuilds the surface and guidance and keeps discoveries and history', () => {
  const session = leadSession('anthropic-oauth');
  selectDeferredTools(session, ['web_fetch'], 'lead');
  assert.ok(session.deferredDiscoveredTools.includes('web_fetch'));
  const history = [
    { role: 'user', content: 'fetch it' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'h1', name: 'web_fetch', arguments: { url: 'https://a.test' } }],
    },
    { role: 'tool', toolCallId: 'h1', content: 'body' },
  ];
  session.messages.push(...structuredClone(history));
  session.providerState = { cursor: 1 };
  const nativeTools = JSON.stringify(requestTools(session));

  session.provider = 'gemini';
  assert.equal(rebuildToolSurfaceForProviderWithMigration(session, 'gemini'), true);
  assert.equal(session.toolExposureMode, 'bridge-v1');
  assert.deepEqual(
    session.tools.slice(-BRIDGE_NAMES.length).map((tool) => tool.name),
    BRIDGE_NAMES
  );
  assert.match(session.messages[1].content, /<\/available-deferred-tools>\n\n<tool-bridge>/);
  assert.equal(session.messages[1].content.match(/<available-deferred-tools>/g).length, 1);
  assert.equal(session.providerState, undefined);
  assert.equal(session.pendingCacheBreakIntent, 'tool_surface_bridge_migration');
  assert.deepEqual(session.messages.slice(3), history);
  assert.equal(rebuildToolSurfaceForProviderWithMigration(session, 'gemini'), false);

  session.provider = 'anthropic-oauth';
  delete session.pendingCacheBreakIntent;
  assert.equal(rebuildToolSurfaceForProviderWithMigration(session, 'anthropic-oauth'), true);
  assert.equal(session.toolExposureMode, undefined);
  assert.ok(session.deferredDiscoveredTools.includes('web_fetch'));
  assert.match(session.messages[1].content, /<available-deferred-tools>/);
  assert.doesNotMatch(session.messages[1].content, /tool-bridge/);
  assert.deepEqual(session.messages.slice(3), history);
  // The same native definitions return (a provider switch is a tagged cache
  // break, so only their content, not their order, is compared).
  const byName = (tools) => JSON.stringify(JSON.parse(tools).sort((a, b) => a.name.localeCompare(b.name)));
  assert.equal(byName(JSON.stringify(requestTools(session))), byName(nativeTools));
});
