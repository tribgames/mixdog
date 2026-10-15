// A request whose fixed overhead (tool schemas + protected system context +
// configured headroom) cannot fit the compact boundary fails with an
// actionable TOOL_SURFACE_EXCEEDS_CONTEXT error instead of a futile compaction;
// ordinary history overflow keeps compacting.
//
// Fail-closed isolation first (empty home/config/data dirs, no network,
// in-memory keychain): no user config can route the summary to a real
// provider, and any attempt to reach one throws. Every summary goes to the
// fixture provider each test passes in.
import './test-isolation.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

// Application modules load only after the isolation hooks are installed
// (static imports would be resolved and loaded before it runs).
const { prepareProviderRequest } = await import('./request-boundary.mjs');
const { recordProviderContextBaseline } = await import('./compact-policy.mjs');
const { applyDeferredToolSurface, snapshotProviderRequestTools } = await import(
  '../../runtime-core/tool-catalog.mjs'
);
const { presentErrorText } = await import('../../../../shared/err-text.mjs');
const { describeError } = await import('../../../../shared/error-presentation.mjs');
const { providerErrorKind } = await import('../../providers/provider-error-kind.mjs');
const { isContextOverflowError } = await import('../../providers/retry-classifier.mjs');
const { toolErrorDisplay } = await import('../transcript-restore/tool-result-text.mjs');

const SUMMARY = [
  '## Goal',
  '- continue',
  '',
  '## Constraints & Preferences',
  '- (none)',
  '',
  '## Progress',
  '### Done',
  '- summarized',
  '',
  '### In Progress',
  '- (none)',
  '',
  '### Blocked',
  '- (none)',
  '',
  '## Key Decisions',
  '- (none)',
  '',
  '## Next Steps',
  '- continue',
  '',
  '## Critical Context',
  '- (none)',
  '',
  '## Relevant Files',
  '- (none)',
].join('\n');

/** A summarizer that records whether compaction ever asked it for a summary. */
function summarizer(name) {
  const calls = [];
  return {
    calls,
    provider: {
      name,
      async send(messages) {
        calls.push(messages.length);
        return { content: SUMMARY };
      },
    },
  };
}

/** A tool whose schema grows with `size` (about 2.6 estimator tokens per unit). */
function wideTool(name, size) {
  return {
    name,
    description: `${name} tool.`,
    inputSchema: {
      type: 'object',
      properties: { payload: { type: 'string', description: 'x'.repeat(size * 4) } },
    },
  };
}

function session(provider, { contextWindow, tools = [], history = [], compaction = {}, ...extra }) {
  return {
    id: `overhead-${randomUUID()}`,
    owner: 'agent',
    provider,
    model: 'fixture-model',
    contextWindow,
    compactBoundaryTokens: contextWindow,
    compaction: { auto: true, ...compaction },
    tools,
    messages: [
      { role: 'system', content: 'System rules.' },
      ...history,
      { role: 'user', content: 'current request' },
    ],
    ...extra,
  };
}

function boundary(sessionRef, summary) {
  return prepareProviderRequest({
    provider: summary.provider,
    messages: sessionRef.messages,
    model: sessionRef.model,
    baseSendTools: sessionRef.tools,
    sessionRef,
    sessionId: sessionRef.id,
    cwd: process.cwd(),
    opts: {},
    signal: null,
    crossTurnCalls: new Map(),
    loopUsageMetricsTurnId: () => 'turn',
    loopUsageMetricsEpoch: () => 0,
    iterations: 1,
    lastUsage: null,
    firstTurnUsage: null,
    providerState: null,
    reactiveOverflowRetryPending: false,
    fixedProviderToolSurface: null,
  });
}

const bigHistory = () => [
  { role: 'user', content: `old request ${'context '.repeat(12_000)}` },
  { role: 'assistant', content: `old answer ${'detail '.repeat(12_000)}` },
];

test('eager tool schemas over a small window fail with TOOL_SURFACE_EXCEEDS_CONTEXT, no summarization', async () => {
  const summary = summarizer('anthropic-oauth');
  const tools = [wideTool('huge_a', 4_000), wideTool('huge_b', 3_000), wideTool('small_c', 50)];
  const sessionRef = session('anthropic-oauth', { contextWindow: 8_000, tools, history: bigHistory() });
  const before = sessionRef.messages.slice();
  await assert.rejects(boundary(sessionRef, summary), (error) => {
    assert.equal(error.code, 'TOOL_SURFACE_EXCEEDS_CONTEXT');
    assert.equal(error.overheadKind, 'fixed_overhead');
    const lines = error.message.split('\n');
    assert.match(lines[0], /^Tool definitions and system context leave no room for conversation history/);
    assert.match(error.message, /context window 8,000 tokens/);
    assert.match(error.message, /tool definitions [\d,]+ tokens \(3 tools\)/);
    assert.match(error.message, /protected system context [\d,]+ tokens/);
    assert.match(error.message, /configured headroom 0 tokens/);
    assert.match(error.message, /Compacting the conversation history cannot reduce these\./);
    assert.match(error.message, /larger context window, or send a smaller eager tool surface/);
    assert.match(error.message, /Largest tool definitions: huge_a \([\d,]+ tokens\), huge_b/);
    // Names and counts only, never a definition.
    assert.doesNotMatch(error.message, /xxxx|inputSchema|payload/);
    // Not routed as a provider context overflow (that would compact and retry).
    assert.equal(isContextOverflowError(error), false);
    assert.notEqual(providerErrorKind(error).kind, 'context_overflow');
    // Surfaces show the actionable text, not a generic "Context too large".
    assert.equal(presentErrorText(error), error.message);
    assert.equal(toolErrorDisplay(error, 'turn'), `Error: ${error.message}`);
    const persisted = describeError({ message: toolErrorDisplay(error, 'turn'), errorKind: providerErrorKind(error) });
    assert.equal(persisted.summary, `${lines[0]}`);
    assert.match(persisted.details, /Largest tool definitions/);
    assert.equal(describeError(error.message).summary, lines[0]);
    return true;
  });
  assert.deepEqual(summary.calls, [], 'no summarization was attempted');
  assert.deepEqual(sessionRef.messages, before, 'the history is untouched');
});

test('an excessive configured reserve is reported as the reserve', async () => {
  const summary = summarizer('compact-overhead-reserve');
  const sessionRef = session('compact-overhead-reserve', {
    contextWindow: 40_000,
    tools: [wideTool('read', 100)],
    compaction: { reservedTokens: 45_000 },
  });
  await assert.rejects(boundary(sessionRef, summary), (error) => {
    assert.equal(error.code, 'TOOL_SURFACE_EXCEEDS_CONTEXT');
    assert.equal(error.overheadKind, 'configured_reserve');
    assert.match(error.message, /^The configured compaction headroom leaves no room for conversation history/);
    assert.match(error.message, /configured headroom 45,000 tokens/);
    assert.match(error.message, /Lower the configured headroom \(compaction\.reservedTokens/);
    return true;
  });
  assert.deepEqual(summary.calls, []);
});

test('an ordinary oversized history still compacts', async () => {
  const summary = summarizer('compact-overhead-history');
  const sessionRef = session('compact-overhead-history', {
    contextWindow: 20_000,
    tools: [wideTool('read', 100)],
    history: bigHistory(),
  });
  const before = sessionRef.messages.length;
  const result = await boundary(sessionRef, summary);
  assert.ok(summary.calls.length > 0, 'the summarizer ran');
  assert.ok(sessionRef.messages.length < before || result.providerStateCleared, 'the transcript was compacted');
});

test('a bridge session with the 234-tool / 156KB catalog fits where the full catalog would not', async () => {
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
  const filler = Array.from({ length: 233 }, (_, index) => ({
    name: `mcp__fleet__tool_${String(index).padStart(3, '0')}`,
    description: `Fleet tool ${index}.`,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  }));
  const core = [wideTool('read', 200), wideTool('grep', 200), wideTool('shell', 200)];
  const bridged = session('gemini', { contextWindow: 32_000, tools: core.slice(), toolSpec: 'full' });
  applyDeferredToolSurface(bridged, 'lead', [big, ...filler]);
  assert.equal(bridged.toolExposureMode, 'bridge-v1');
  assert.equal(bridged.deferredToolCatalog.length, 237);
  const summary = summarizer('gemini');
  await boundary(bridged, summary);
  assert.deepEqual(summary.calls, []);

  // The same catalog sent eagerly on a native session cannot fit at all.
  const eager = session('anthropic-oauth', { contextWindow: 32_000, tools: [...core, big, ...filler] });
  await assert.rejects(boundary(eager, summarizer('anthropic-oauth')), (error) => {
    assert.equal(error.code, 'TOOL_SURFACE_EXCEEDS_CONTEXT');
    assert.match(error.message, /Largest tool definitions: mcp__huge__configure/);
    return true;
  });
});

// ~6,050 estimator tokens of schemas, which the anthropic calibration (1.4)
// prices at ~8,450: above an 8,000 window by estimate alone.
const overEstimatedTools = () => [wideTool('wide_a', 1_130), wideTool('wide_b', 1_130)];

test('review: a provider-measured request below the boundary is never refused on an estimate', async () => {
  const unmeasured = session('anthropic-oauth', { contextWindow: 8_000, tools: overEstimatedTools() });
  await assert.rejects(boundary(unmeasured, summarizer('anthropic-oauth')), { code: 'TOOL_SURFACE_EXCEEDS_CONTEXT' });

  // The provider measured this unchanged request (same prefix, same schemas) at 6,000.
  const measured = session('anthropic-oauth', { contextWindow: 8_000, tools: overEstimatedTools() });
  const sendTools = snapshotProviderRequestTools({
    provider: measured.provider,
    tools: measured.tools,
    messages: measured.messages,
    session: measured,
  });
  assert.equal(
    recordProviderContextBaseline(measured, measured.messages, { inputTokens: 6_000 }, { sendTools }),
    true
  );
  const summary = summarizer('anthropic-oauth');
  await boundary(measured, summary);
  assert.deepEqual(summary.calls, []);

  // A reading taken with other tool schemas does not vouch for these.
  const retooled = session('anthropic-oauth', { contextWindow: 8_000, tools: overEstimatedTools() });
  recordProviderContextBaseline(retooled, retooled.messages, { inputTokens: 6_000 }, { sendTools: [wideTool('x', 10)] });
  await assert.rejects(boundary(retooled, summarizer('anthropic-oauth')), { code: 'TOOL_SURFACE_EXCEEDS_CONTEXT' });
});

test('review: a near miss without a provider reading is sent, not refused', async () => {
  // ~5,300 estimator tokens, ~7,400 calibrated: within the old 1,024-token
  // margin of the 8,000 boundary, but not over it.
  const nearMiss = session('anthropic-oauth', { contextWindow: 8_000, tools: [wideTool('near', 2_000)] });
  const summary = summarizer('anthropic-oauth');
  const result = await boundary(nearMiss, summary);
  assert.ok(result.sendTools.some((tool) => tool.name === 'near'));
  assert.deepEqual(summary.calls, []);
});

test('review: the refusal is never classified as a provider context overflow', async () => {
  const tools = [wideTool('mcp__fixture__context_length_exceeded', 9_000)];
  const sessionRef = session('anthropic-oauth', { contextWindow: 8_000, tools });
  const error = await boundary(sessionRef, summarizer('anthropic-oauth')).then(
    () => assert.fail('expected a refusal'),
    (caught) => caught
  );
  assert.match(error.message, /Largest tool definitions: mcp__fixture__context_length_exceeded/);
  // The tool name alone would read as a provider overflow …
  assert.equal(isContextOverflowError(new Error('mcp__fixture__context_length_exceeded')), true);
  // … but the refusal, bare, wrapped as a cause, or as its persisted text, never does.
  const wrapped = new Error('turn failed', { cause: error });
  const doubly = new Error('outer', { cause: wrapped });
  for (const candidate of [error, wrapped, doubly, error.message, toolErrorDisplay(error, 'turn')]) {
    assert.equal(isContextOverflowError(candidate), false, String(candidate?.message ?? candidate).slice(0, 40));
  }
  for (const candidate of [error, wrapped, doubly]) {
    const kind = providerErrorKind(candidate);
    assert.equal(kind.kind, 'unknown');
    assert.equal(kind.code, 'TOOL_SURFACE_EXCEEDS_CONTEXT');
  }
  assert.notEqual(describeError(toolErrorDisplay(error, 'turn')).kind, 'context-overflow');
  // Persisted failure text kept as a cause (a string node in the chain).
  const persisted = toolErrorDisplay(error, 'turn');
  assert.match(persisted, /context_length_exceeded/);
  for (const candidate of [
    new Error('turn failed', { cause: persisted }),
    new Error('outer', { cause: new Error('turn failed', { cause: persisted }) }),
  ]) {
    assert.equal(isContextOverflowError(candidate), false);
    assert.deepEqual(
      [providerErrorKind(candidate).kind, providerErrorKind(candidate).code],
      ['unknown', 'TOOL_SURFACE_EXCEEDS_CONTEXT']
    );
  }
  // A genuine provider overflow behind the same wrapper still is one.
  assert.equal(isContextOverflowError(new Error('turn failed', { cause: 'context_length_exceeded' })), true);
});

test('review: a measured total never proves the fixed part — 6,000 measured, 8,000 boundary, 2,500 reserve compacts', async () => {
  // ~4,800 estimator tokens of schemas, ~6,700 calibrated: with the 2,500
  // headroom the ESTIMATE reaches the boundary, but the provider measured the
  // whole request (history included) at 6,000 — below the estimate, so the
  // estimate overstates the fixed part and only compaction can tell.
  const history = [
    { role: 'user', content: `earlier request ${'context '.repeat(3_000)}` },
    { role: 'assistant', content: `earlier answer ${'detail '.repeat(3_000)}` },
    ...Array.from({ length: 4 }, (_, index) => [
      { role: 'user', content: `recent request ${index}` },
      { role: 'assistant', content: `recent answer ${index}` },
    ]).flat(),
  ];
  const tools = () => [wideTool('mid_a', 890), wideTool('mid_b', 890)];
  const compaction = { reservedTokens: 2_500 };
  const unmeasured = session('anthropic-oauth', { contextWindow: 8_000, tools: tools(), history, compaction });
  await assert.rejects(boundary(unmeasured, summarizer('anthropic-oauth')), (error) => {
    assert.equal(error.overheadKind, 'configured_reserve');
    return true;
  });

  const measured = session('anthropic-oauth', { contextWindow: 8_000, tools: tools(), history, compaction });
  const sendTools = snapshotProviderRequestTools({
    provider: measured.provider,
    tools: measured.tools,
    messages: measured.messages,
    session: measured,
  });
  assert.ok(recordProviderContextBaseline(measured, measured.messages, { inputTokens: 6_000 }, { sendTools }));
  const before = measured.messages.length;
  const summary = summarizer('anthropic-oauth');
  // Compaction clears the provider reading; with the fixed inputs unchanged
  // the later pass keeps the earlier verdict instead of refusing on the
  // estimate alone.
  await boundary(measured, summary);
  assert.ok(summary.calls.length > 0, 'compaction ran instead of a refusal');
  assert.ok(measured.messages.length < before, 'the history was compacted');
});

test('review: MCP schemas that grow during compaction are re-judged — ~52k tool tokens over a 20k boundary refuse', async () => {
  const grow = (size) => ({ ...wideTool('mcp__fixture__grow', size), description: 'Grow tool.' });
  const sessionRef = session('compact-overhead-mcp', {
    contextWindow: 20_000,
    tools: [wideTool('read', 100), grow(10)],
    history: bigHistory(),
  });
  const index = sessionRef.tools.findIndex((tool) => tool.name === 'mcp__fixture__grow');
  const summary = summarizer('compact-overhead-mcp');
  const send = summary.provider.send;
  // The server reconnects with a far larger schema while the summary runs;
  // the next pass of this boundary adopts it.
  summary.provider.send = async (...args) => {
    sessionRef.tools[index] = grow(20_000);
    return send(...args);
  };
  await assert.rejects(boundary(sessionRef, summary), (error) => {
    assert.equal(error.code, 'TOOL_SURFACE_EXCEEDS_CONTEXT');
    assert.equal(error.overheadKind, 'fixed_overhead');
    const tools = Number(/tool definitions ([\d,]+) tokens/.exec(error.message)[1].replaceAll(',', ''));
    assert.ok(tools > 50_000 && tools < 54_000, `${tools}`);
    assert.match(error.message, /Largest tool definitions: mcp__fixture__grow/);
    return true;
  });
  assert.ok(summary.calls.length > 0, 'the first pass compacted before the schema grew');
});

test('review: a system prompt re-rooted by compaction is re-judged — ~22.5k over a 20k boundary refuses', async () => {
  const { refreshSessionWorkspaceContext } = await import('../manager/prompt-utils.mjs');
  const sessionRef = session('compact-overhead-reroot', {
    contextWindow: 20_000,
    tools: [wideTool('read', 100)],
    history: bigHistory(),
    bp3EnvSplit: true,
    bp3EnvironmentContext: '- Cwd: /project — the active Project root',
  });
  sessionRef.messages.splice(1, 0, { role: 'system', content: '# Core\nProject rules.', cacheTier: 'tier3' });
  // A workspace change staged mid-conversation: compaction applies it.
  refreshSessionWorkspaceContext(sessionRef, {
    cwd: '/elsewhere',
    instructionFilesContext: `# Instruction Files\n${'Follow the house rules. '.repeat(3_750)}`,
  });
  assert.ok(sessionRef.workspaceReroot, 'the re-root is staged');
  const summary = summarizer('compact-overhead-reroot');
  await assert.rejects(boundary(sessionRef, summary), (error) => {
    assert.equal(error.code, 'TOOL_SURFACE_EXCEEDS_CONTEXT');
    assert.equal(error.overheadKind, 'fixed_overhead');
    const system = Number(/protected system context ([\d,]+) tokens/.exec(error.message)[1].replaceAll(',', ''));
    assert.ok(system > 22_000 && system < 23_500, `${system}`);
    return true;
  });
  assert.ok(summary.calls.length > 0, 'the first pass compacted before the re-root');
  assert.equal(sessionRef.workspaceReroot, undefined, 'compaction applied the re-root');
});
