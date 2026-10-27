import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactDisplayBeforeTokens,
  compactionTelemetryPressureTokens,
  currentContextEstimateTokens,
  invalidateProviderContextBaseline,
  recordContextUsageSnapshot,
  recordProviderContextBaseline,
  rememberCompactTelemetry,
  resolveCompactionPressureTokens,
  resolveContextTokens,
  resolveContextTokensWithSource,
  resolveContextUsageSnapshot,
  resolveGaugeContextTokens,
  resolveWorkerCompactPolicy,
  shouldCompactForRequestMedia,
  shouldCompactForSession,
} from './loop/compact-policy.mjs';
import { contextMessagesSignature, estimateMessagesTokens } from './context-utils.mjs';

test('compaction rows report the last measured context, not a recomputed estimate', () => {
  // Idle-resumed session: the provider last measured ~960k while the
  // whole-transcript estimate inflated to ~1.76M.
  assert.equal(compactDisplayBeforeTokens({ lastContextTokens: 959_921 }, 1_756_616), 959_921);
  assert.equal(
    compactDisplayBeforeTokens({ lastContextTokens: 959_921, lastContextTokensStaleAfterCompact: true }, 1_756_616),
    1_756_616
  );
  assert.equal(compactDisplayBeforeTokens({ lastContextTokens: 0 }, 42_000), 42_000);
});

test('Cursor main sessions preserve the configured 200k compact boundary', () => {
  const session = {
    provider: 'cursor-oauth',
    model: 'gemini-3.7-flash',
    contextWindow: 200_000,
    compactBoundaryTokens: 200_000,
    compaction: { auto: true },
  };

  const policy = resolveWorkerCompactPolicy(session, []);
  assert.equal(policy.boundaryTokens, 200_000);
  assert.equal(policy.triggerTokens, 200_000);
  assert.equal(policy.bufferTokens, 0);
  assert.equal(policy.compactTargetTokens, 50_000);
});

test('tool-result media at the request byte cap arms compaction; user attachments never do', () => {
  const screenshot = { type: 'image', data: 'A'.repeat(1_000_000), mimeType: 'image/png' };
  const toolTurns = (count) =>
    Array.from({ length: count }, (_, index) => [
      { role: 'assistant', content: '', toolCalls: [{ id: `call-${index}`, name: 'browser', arguments: '{}' }] },
      { role: 'tool', toolCallId: `call-${index}`, content: [{ type: 'text', text: 'shot' }, screenshot] },
    ]).flat();
  assert.equal(shouldCompactForRequestMedia(toolTurns(23)), false);
  assert.equal(shouldCompactForRequestMedia(toolTurns(24)), true);
  assert.equal(
    shouldCompactForRequestMedia([{ role: 'user', content: Array.from({ length: 30 }, () => screenshot) }]),
    false
  );
});

test('successful compaction publishes post-compact pressure and invalidates the old baseline', () => {
  const session = {
    provider: 'cursor-oauth',
    model: 'gemini-3.7-flash',
    contextWindow: 200_000,
    compactBoundaryTokens: 200_000,
    contextPressureBaselineTokens: 225_000,
    contextPressureBaselineRequestReserveTokens: 800,
    contextPressureBaselineUpdatedAt: Date.now(),
    lastContextTokensStaleAfterCompact: false,
    compaction: { auto: true },
  };
  const policy = resolveWorkerCompactPolicy(session, []);

  rememberCompactTelemetry(session, policy, {
    stage: 'pre_send',
    beforeTokens: 225_000,
    afterTokens: 20_000,
    pressureTokens: 225_000,
    compactChanged: true,
  });

  assert.equal(session.compaction.currentEstimatedTokens, 20_000);
  assert.equal(session.contextPressureBaselineTokens, null);
  assert.equal(session.contextPressureBaselineRequestReserveTokens, null);
  assert.equal(session.lastContextTokensStaleAfterCompact, true);
});

test('an env-derived compact reserve is never persisted as session configuration', () => {
  const previous = process.env.MIXDOG_AGENT_COMPACT_RESERVED_TOKENS;
  const session = {
    provider: 'cursor-oauth',
    model: 'gemini-3.7-flash',
    contextWindow: 500_000,
    compactBoundaryTokens: 500_000,
    compaction: { auto: true, reservedTokens: null },
  };
  try {
    process.env.MIXDOG_AGENT_COMPACT_RESERVED_TOKENS = '450000';
    const policy = resolveWorkerCompactPolicy(session, []);
    assert.equal(policy.configuredReserveTokens, 450_000);
    rememberCompactTelemetry(session, policy, { stage: 'pre_send_check', pressureTokens: 10_000 });
    assert.equal(session.compaction.reservedTokens, null);

    process.env.MIXDOG_AGENT_COMPACT_RESERVED_TOKENS = '55000';
    session.contextWindow = 104_857;
    session.compactBoundaryTokens = 104_857;
    assert.equal(resolveWorkerCompactPolicy(session, []).reserveTokens, 55_000);

    delete process.env.MIXDOG_AGENT_COMPACT_RESERVED_TOKENS;
    assert.equal(resolveWorkerCompactPolicy(session, []).reserveTokens, 0);

    // An explicit session reserve survives telemetry and outranks the env.
    session.compaction.reservedTokens = 7_000;
    process.env.MIXDOG_AGENT_COMPACT_RESERVED_TOKENS = '55000';
    const explicit = resolveWorkerCompactPolicy(session, []);
    assert.equal(explicit.reserveTokens, 7_000);
    rememberCompactTelemetry(session, explicit, { stage: 'pre_send_check', pressureTokens: 10_000 });
    assert.equal(session.compaction.reservedTokens, 7_000);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_AGENT_COMPACT_RESERVED_TOKENS;
    else process.env.MIXDOG_AGENT_COMPACT_RESERVED_TOKENS = previous;
  }
});

// Reported compaction numbers must share ONE scale with the context gauge
// (user: 게이지는 499k인데 압축 알림은 131k→23k). The pre-compact side follows
// the provider-billed prompt; the post-compact side is the same calibrated
// estimate the gauge falls back to once compaction drops the baseline.
test('gauge and post-compact estimate are one scale', () => {
  const messages = [
    { role: 'user', content: 'hello world '.repeat(200) },
    { role: 'assistant', content: 'reply text '.repeat(200) },
  ];
  const session = {
    provider: 'anthropic-oauth',
    model: 'claude-opus-5',
    contextWindow: 500_000,
    compactBoundaryTokens: 500_000,
    compaction: { auto: true },
    tools: [],
  };
  const policy = resolveWorkerCompactPolicy(session, []);
  const messageTokensEst = estimateMessagesTokens(messages);

  // No baseline: both ends resolve through the identical calibrated formula.
  assert.equal(
    resolveGaugeContextTokens(messageTokensEst, policy, { messages, sessionRef: session }),
    currentContextEstimateTokens(messageTokensEst, policy)
  );

  // Live baseline: the reported "before" follows the provider-billed prompt
  // instead of the much smaller raw transcript estimate.
  Object.assign(session, {
    contextPressureBaselineTokens: 499_000,
    contextPressureBaselineOutputTokens: 0,
    contextPressureBaselineMessageCount: messages.length,
    contextPressureBaselinePrefixSignature: contextMessagesSignature(messages),
    contextPressureBaselineProvider: session.provider,
    contextPressureBaselineModel: session.model,
    contextPressureBaselineToolSignature: policy.toolSchemaSignature,
    contextPressureBaselineBoundary: 'complete',
    contextPressureBaselineUpdatedAt: Date.now(),
    lastContextTokensStaleAfterCompact: false,
  });

  const gauged = resolveGaugeContextTokens(messageTokensEst, policy, { messages, sessionRef: session });
  assert.equal(gauged, 499_000);
  assert.equal(resolveCompactionPressureTokens(messageTokensEst, policy, { messages, sessionRef: session }), gauged);
  assert.equal(shouldCompactForSession(messageTokensEst, policy, { messages, sessionRef: session }), false);
  assert.ok(gauged > currentContextEstimateTokens(messageTokensEst, policy) * 10);
});

test('provider baseline plus trailing growth is the only display and compaction value', () => {
  const prefix = [{ role: 'user', content: 'large provider-aligned prefix '.repeat(5_000) }];
  const trailing = { role: 'user', content: 'new trailing message' };
  const messages = [...prefix, trailing];
  const session = {
    provider: 'anthropic-oauth',
    model: 'claude-opus-5',
    contextWindow: 500_000,
    compactBoundaryTokens: 500_000,
    compaction: { auto: true },
    tools: [],
  };
  const policy = resolveWorkerCompactPolicy(session, []);
  const messageTokensEst = estimateMessagesTokens(messages);
  const providerTokens = 1_000;
  Object.assign(session, {
    contextPressureBaselineTokens: providerTokens,
    contextPressureBaselineOutputTokens: 0,
    contextPressureBaselineMessageCount: prefix.length,
    contextPressureBaselinePrefixSignature: contextMessagesSignature(messages, prefix.length),
    contextPressureBaselineProvider: session.provider,
    contextPressureBaselineModel: session.model,
    contextPressureBaselineToolSignature: policy.toolSchemaSignature,
    contextPressureBaselineBoundary: 'complete',
    contextPressureBaselineUpdatedAt: Date.now(),
    lastContextTokensStaleAfterCompact: false,
  });

  const expected = providerTokens + Math.round(estimateMessagesTokens([trailing]) * policy.tokenCalibration);
  const contextTokens = resolveContextTokens(messageTokensEst, policy, { messages, sessionRef: session });
  assert.equal(contextTokens, expected);
  assert.equal(resolveGaugeContextTokens(messageTokensEst, policy, { messages, sessionRef: session }), contextTokens);
  assert.equal(
    resolveCompactionPressureTokens(messageTokensEst, policy, { messages, sessionRef: session }),
    contextTokens
  );
  assert.ok(currentContextEstimateTokens(messageTokensEst, policy) > contextTokens * 2);

  const decisionPolicy = { ...policy, triggerTokens: contextTokens + 1 };
  assert.equal(shouldCompactForSession(messageTokensEst, decisionPolicy, { messages, sessionRef: session }), false);
  assert.equal(
    compactionTelemetryPressureTokens(messageTokensEst, decisionPolicy, {
      messages,
      sessionRef: session,
    }),
    contextTokens
  );
  assert.equal(
    compactionTelemetryPressureTokens(messageTokensEst, decisionPolicy, {
      reactivePending: true,
      messages,
      sessionRef: session,
    }),
    decisionPolicy.triggerTokens
  );
});

// Issue #238: a fork measured by the provider at 447,906 tokens compacted at a
// pressure of 981,912 — (694,911 estimated + reserve) × 1.4 — against a
// 900,000 trigger, because an agent result posted more than half an hour after
// the last request made the measured reading count as "stale".
test('a forked session anchors to its provider reading when growth arrives long after it', () => {
  const messages = [
    { role: 'system', content: 'fork prompt rebuilt from current settings' },
    { role: 'user', content: 'carried conversation' },
    { role: 'assistant', content: 'carried answer' },
  ];
  const session = {
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-5-5',
    contextWindow: 1_000_000,
    compactBoundaryTokens: 1_000_000,
    compaction: { auto: true },
    tools: [],
    messages,
  };
  // The heir starts unmeasured (cold-heir.mjs), then its first turn is measured.
  invalidateProviderContextBaseline(session);
  assert.equal(
    recordProviderContextBaseline(session, messages, { inputTokens: 440_000, outputTokens: 7_906 }, { sendTools: [] }),
    true
  );
  const measuredAt = Date.now() - 50 * 60_000;
  session.contextPressureBaselineUpdatedAt = measuredAt;
  session.lastProviderSendAt = measuredAt - 30_000;
  session.lastContextTokens = 440_000;
  session.lastContextTokensUpdatedAt = measuredAt;
  // Fifty minutes later a delegated agent's result is posted to the waiting Lead.
  messages.push({ role: 'user', content: 'agent result: the review is done' });
  session.updatedAt = Date.now();

  const policy = { ...resolveWorkerCompactPolicy(session, []), triggerTokens: 900_000 };
  const messageTokensEst = 694_911;
  assert.ok(currentContextEstimateTokens(messageTokensEst, policy) > policy.triggerTokens);

  const resolved = resolveContextTokensWithSource(messageTokensEst, policy, { messages, sessionRef: session });
  const growth = Math.round(estimateMessagesTokens(messages.slice(3)) * policy.tokenCalibration);
  assert.deepEqual(resolved, { tokens: 447_906 + growth, source: 'provider' });
  assert.equal(shouldCompactForSession(messageTokensEst, policy, { messages, sessionRef: session }), false);

  // A request that completed after the reading without replacing it means
  // usage recording failed: only then does the estimate take over.
  session.lastProviderSendAt = measuredAt + 60_000;
  assert.equal(
    resolveContextTokensWithSource(messageTokensEst, policy, { messages, sessionRef: session }).source,
    'estimated'
  );
  assert.equal(shouldCompactForSession(messageTokensEst, policy, { messages, sessionRef: session }), true);
});

test('a restarted tool surface adjusts only schema reserve instead of discarding provider usage', () => {
  const messages = [{ role: 'user', content: 'durable provider-aligned history' }];
  const previousTools = [
    { name: 'read', description: 'Read files', inputSchema: { type: 'object' } },
    { name: 'recall', description: 'Recall stored context '.repeat(40), inputSchema: { type: 'object' } },
    { name: 'goal', description: 'Manage the durable checklist '.repeat(40), inputSchema: { type: 'object' } },
  ];
  const restartedTools = [{ name: 'read', description: 'Read files', inputSchema: { type: 'object' } }];
  const session = {
    provider: 'openai-oauth',
    model: 'gpt-5.6-sol',
    contextWindow: 272_000,
    compactBoundaryTokens: 272_000,
    compaction: { auto: true },
    tools: previousTools,
  };
  assert.equal(
    recordProviderContextBaseline(
      session,
      messages,
      { promptTokens: 75_000, outputTokens: 0 },
      { sendTools: previousTools }
    ),
    true
  );

  const policy = resolveWorkerCompactPolicy(session, restartedTools);
  // The point of this fixture is a naive whole-transcript estimate that WOULD
  // trigger compaction, so the assertions below prove the provider baseline
  // wins anyway. Derive it from the policy instead of hardcoding a number
  // that only clears the trigger at one particular calibration.
  const wholeTranscriptEstimate = Math.ceil((policy.triggerTokens / policy.tokenCalibration) * 1.2);
  const currentReserve = Math.round(policy.requestReserveTokens * policy.tokenCalibration);
  const expected = 75_000 - session.contextPressureBaselineRequestReserveTokens + currentReserve;
  assert.notEqual(session.contextPressureBaselineToolSignature, policy.toolSchemaSignature);
  assert.ok(currentContextEstimateTokens(wholeTranscriptEstimate, policy) > policy.triggerTokens);
  assert.equal(
    resolveCompactionPressureTokens(wholeTranscriptEstimate, policy, {
      messages,
      sessionRef: session,
    }),
    expected
  );
  assert.equal(
    shouldCompactForSession(wholeTranscriptEstimate, policy, {
      messages,
      sessionRef: session,
    }),
    false
  );

  delete session.contextPressureBaselineRequestReserveTokens;
  assert.equal(
    resolveCompactionPressureTokens(wholeTranscriptEstimate, policy, {
      messages,
      sessionRef: session,
    }),
    75_000 + currentReserve
  );

  session.contextPressureBaselineModel = 'different-model';
  assert.equal(
    resolveCompactionPressureTokens(wholeTranscriptEstimate, policy, {
      messages,
      sessionRef: session,
    }),
    currentContextEstimateTokens(wholeTranscriptEstimate, policy)
  );
});

test('post-compact context snapshot survives serialization and invalidates on the next turn', () => {
  const messages = [
    { role: 'user', content: 'compacted summary' },
    { role: 'assistant', content: 'retained answer' },
  ];
  const tools = [{ name: 'read', description: 'Read files', inputSchema: { type: 'object' } }];
  const session = {
    provider: 'openai-oauth',
    model: 'gpt-5.6-sol',
    contextWindow: 272_000,
    compactBoundaryTokens: 272_000,
    usageMetricsTurnId: 'turn-7',
    usageMetricsEpoch: 2,
    messages,
    tools,
    compaction: { auto: true },
  };
  const policy = resolveWorkerCompactPolicy(session, tools);
  const usedTokens = currentContextEstimateTokens(estimateMessagesTokens(messages), policy);
  recordContextUsageSnapshot(session, policy, {
    messages,
    usedTokens,
    source: 'post_compact',
  });

  const restarted = JSON.parse(JSON.stringify(session));
  const restartedPolicy = resolveWorkerCompactPolicy(restarted, restarted.tools);
  assert.equal(
    resolveContextUsageSnapshot(restarted, restartedPolicy, { messages: restarted.messages })?.usedTokens,
    usedTokens
  );

  restarted.usageMetricsTurnId = 'turn-8';
  restarted.messages.push({ role: 'user', content: 'new request' });
  assert.equal(resolveContextUsageSnapshot(restarted, restartedPolicy, { messages: restarted.messages }), null);
});
