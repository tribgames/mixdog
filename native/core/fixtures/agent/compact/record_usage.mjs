// Records Node's usage bookkeeping on the session header: what one model call writes
// (`persistIterationMetrics`, `onUsageDelta`), the turn's end (`applyAskTerminalUsageTotals` and the complete
// `recordProviderContextBaseline` of `settleAskTurn`), the check before a send that compacts nothing
// (`compactTelemetry(ctx, 'pre_send_check')`, i.e. `rememberCompactTelemetry`), the turn id bump and what an
// adopted compaction writes.
//
//   node native/core/fixtures/agent/compact/record_usage.mjs [--tree <node checkout with node_modules>]
//
// `golden/usage.json`: per case the session header before the call, the transcript, the call's arguments and the
// header after it (Node mutates the session; a deleted field is absent from `after`), at the case's clock.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, refreshSetManifest, resolveTree } from '../../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-usage-golden-'));
const agentDir = resolve(here, '..');
mkdirSync(join(here, 'golden'), { recursive: true });
const load = (rel) => import(pathToFileURL(join(nodeRoot, rel)).href);

let clock = 1_700_000_000_000;
Date.now = () => clock;

const sessionDir = 'src/runtime/agent/orchestrator/session';
const metrics = await load(`${sessionDir}/manager/usage-metrics.mjs`);
const policy = await load(`${sessionDir}/loop/compact-policy.mjs`);
const debug = await load(`${sessionDir}/loop/compact-debug.mjs`);
const utils = await load(`${sessionDir}/context-utils.mjs`);
const agentMode = await load(`${sessionDir}/agent-mode.mjs`);
const registry = await load('src/runtime/agent/orchestrator/providers/registry.mjs');
const { finalizeProviderRequestTools } = await load('src/runtime/agent/orchestrator/runtime-core/provider-request-tools.mjs');

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const entries = new Map();
metrics.configureUsageMetricsRuntime({ getRuntimeEntry: (id) => entries.get(id) });

const rows = {
  user: { role: 'user', content: 'hello  world' },
  call: { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.txt' } }] },
  tool: { role: 'tool', toolCallId: 'c1', content: 'file body' },
  answer: { role: 'assistant', content: 'done' },
};
const transcript = (...names) => names.map((name) => clone(rows[name]));
const tools = [
  { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'search', description: 'Search', inputSchema: { type: 'object' }, deferLoading: true },
];
const wireTools = (list) =>
  list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, deferLoading: t.deferLoading === true }));
const nativeTools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];

const newSession = (id, over = {}) => {
  const session = {
    id,
    provider: 'custom-harness',
    model: 'harness-model',
    contextWindow: 128000,
    rawContextWindow: 128000,
    effectiveContextWindowPercent: 100,
    autoCompactTokenLimit: null,
    compactBoundaryTokens: 128000,
    compaction: { boundaryTokens: 128000, auto: true, contextWindow: 128000, rawContextWindow: 128000, autoCompactTokenLimit: null },
    // The session store's own bookkeeping, which a save adds to the object when it is missing.
    generation: 0,
    closed: false,
    tools: [],
  };
  // A key stated as undefined is a field the session does not have.
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete session[key];
    else session[key] = clone(value);
  }
  entries.set(id, { session });
  return session;
};
const header = (session) => {
  const { messages: _messages, ...rest } = session;
  return clone(rest);
};

const cases = [];
const step = (name, op, session, messages, args, run) => {
  const before = header(session);
  const result = run();
  cases.push({ name, op, header: before, messages: clone(messages), args: clone(args), now: clock, result: result === undefined ? null : clone(result), after: header(session) });
  clock += 1000;
};
const excludesCache = (session) => registry.providerInputExcludesCache(session.provider);

// The delta `usageDeltaEvent` makes of one model call, as the Rust run reports it: the context figures are the billed ones.
const callDelta = (session, over = {}) => {
  const base = {
    sessionId: session.id,
    iterationIndex: 1,
    source: 'provider_send',
    requestedModel: 'harness-model',
    model: 'harness-model',
    deltaInput: 0,
    deltaOutput: 0,
    deltaToolCalls: 0,
    reasoningTokens: null,
    reasoningTokensComplete: false,
    deltaPrompt: 0,
    requestMs: 0,
    promptKnown: true,
    deltaCachedRead: 0,
    deltaCacheWrite: 0,
    ...over,
  };
  const pick = (key, fallback) => (key in over ? over[key] : base[fallback]);
  return {
    ...base,
    contextInputTokens: pick('contextInputTokens', 'deltaInput'),
    contextOutputTokens: pick('contextOutputTokens', 'deltaOutput'),
    contextPromptTokens: pick('contextPromptTokens', 'deltaPrompt'),
    contextCachedReadTokens: pick('contextCachedReadTokens', 'deltaCachedRead'),
    contextCacheWriteTokens: pick('contextCacheWriteTokens', 'deltaCacheWrite'),
    contextMeasuredTokens: 'contextMeasuredTokens' in over ? over.contextMeasuredTokens : null,
    sendTools: [],
    ts: 'ts' in over ? over.ts : clock,
  };
};

const turnStart = (name, session) => step(name, 'turnStart', session, [], {}, () => metrics.bumpUsageMetricsTurnId(session));

// persistIterationMetrics alone (the port under test is the metrics, not the baseline).
const iteration = (name, session, over) => {
  const delta = callDelta(session, over);
  step(name, 'iteration', session, [], { delta, excludesCache: excludesCache(session) }, () => {
    metrics.persistIterationMetrics(delta);
  });
};

// onUsageDelta (ask-turn-loop-options.mjs): the metrics, then for a provider send the request-boundary baseline.
const usageDelta = (name, session, messages, over, sendTools = tools, native = []) => {
  const sent = native.length ? finalizeProviderRequestTools([...clone(native), ...sendTools], native.length) : sendTools;
  const delta = { ...callDelta(session, over), sendTools: wireTools(sent) };
  const sentAt = clock - 7;
  const args = { delta, native, tools: wireTools(sendTools), sentAt, excludesCache: excludesCache(session), calibration: utils.providerTokenCalibration(session.provider) };
  step(name, 'usage', session, messages, args, () => {
    // send-phase.mjs: the response arrived, so the send's start is the provider cache's last use.
    session.lastProviderSendAt = sentAt;
    const d = clone(delta);
    d.sendTools = sent;
    metrics.persistIterationMetrics(d);
    if (d.source === 'provider_send') {
      policy.recordProviderContextBaseline(
        session,
        clone(messages),
        {
          inputTokens: d.contextInputTokens ?? d.deltaInput,
          outputTokens: d.contextOutputTokens ?? d.deltaOutput,
          promptTokens: d.contextPromptTokens ?? d.deltaPrompt,
          cachedTokens: d.contextCachedReadTokens ?? d.deltaCachedRead,
          cacheWriteTokens: d.contextCacheWriteTokens ?? d.deltaCacheWrite,
          contextTokens: d.contextMeasuredTokens ?? null,
        },
        { boundary: 'request', sendTools: d.sendTools }
      );
    }
  });
};

// applyAskTerminalUsageTotals alone.
const terminal = (name, session, result, incremental) =>
  step(name, 'terminal', session, [], { result, incremental, excludesCache: excludesCache(session) }, () =>
    metrics.applyAskTerminalUsageTotals(session, clone(result), { skipTotalsIfIncremental: incremental })
  );

// settleAskTurn: the terminal totals, then the complete-boundary baseline.
const settled = (name, session, messages, result, incremental, sendTools = tools) =>
  step(name, 'settled', session, messages, { result, incremental, tools: wireTools(sendTools), excludesCache: excludesCache(session), calibration: utils.providerTokenCalibration(session.provider) }, () => {
    metrics.applyAskTerminalUsageTotals(session, clone(result), { skipTotalsIfIncremental: incremental });
    policy.recordProviderContextBaseline(session, clone(messages), result.lastTurnUsage || result.usage, { sendTools });
  });

// The decision of pre-send-compact.mjs for a send that compacts nothing, then its telemetry.
const providerAwareTokens = (tokens, messages, session) =>
  tokens == null || registry.providerNativePdf(session.provider) ? tokens : Math.max(0, tokens - utils.textPdfAllowanceDiscount(messages));
const check = (name, session, messages, { reactive = false, native = [], sendTools = tools } = {}) => {
  const requestTools = wireTools(sendTools);
  const args = { tools: requestTools, native, reactive, agentMode: agentMode.isAgentModeSession(session) };
  step(name, 'check', session, messages, args, () => {
    const live = clone(messages);
    const pol = policy.resolveWorkerCompactPolicy(session, native.length ? finalizeProviderRequestTools([...clone(native), ...sendTools], native.length) : sendTools);
    if (!pol?.auto) return false;
    const estimate = providerAwareTokens(debug.estimateMessagesTokensSafe(live), live, session);
    const pressure = policy.compactionTelemetryPressureTokens(estimate, pol, { reactivePending: reactive, messages: live, sessionRef: session });
    policy.rememberCompactTelemetry(session, pol, { stage: 'pre_send_check', beforeTokens: pressure, afterTokens: pressure, messageTokensEst: estimate, pressureTokens: pressure });
    return true;
  });
};

// ---- a turn of the harness: turn id, a check, a call, a check, a call, the settlement ---------------------------
const turn = newSession('s-turn');
turnStart('turn-start-first', turn);
check('check-first-send-has-no-baseline', turn, transcript('user'));
usageDelta('usage-first-call-records-request-baseline', turn, transcript('user'), { deltaInput: 1200, deltaOutput: 24, deltaPrompt: 1200, deltaToolCalls: 1, requestMs: 160 });
check('check-second-send-adds-growth-to-the-baseline', turn, transcript('user', 'call', 'tool'));
usageDelta('usage-second-call', turn, transcript('user', 'call', 'tool'), { iterationIndex: 2, deltaInput: 1200, deltaOutput: 24, deltaPrompt: 1200, requestMs: 160 });
settled(
  'settled-complete-boundary-baseline',
  turn,
  transcript('user', 'call', 'tool', 'answer'),
  {
    usage: { inputTokens: 2400, outputTokens: 48, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reasoningTokensComplete: false },
    lastTurnUsage: { inputTokens: 1200, outputTokens: 24, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reasoningTokensComplete: false },
    toolCallsTotal: 1,
  },
  true
);
turnStart('turn-start-second', turn);

// ---- the ring of the last eight checks ----------------------------------------------------------------------------
const ring = newSession('s-ring');
for (let n = 0; n < 10; n += 1) check(`check-ring-${n}`, ring, transcript('user', 'call', 'tool').slice(0, 1 + (n % 3)));

// ---- check variants -----------------------------------------------------------------------------------------------
check('check-reactive-pending-floors-the-pressure', newSession('s-reactive'), transcript('user'), { reactive: true });
check('check-native-tool-prefix', newSession('s-native'), transcript('user'), { native: nativeTools });
check('check-no-tools', newSession('s-notools'), transcript('user', 'call'), { sendTools: [] });
check(
  'check-keeps-prior-telemetry-and-clears-errors',
  newSession('s-prior', {
    lastContextTokens: 900,
    compaction: {
      boundaryTokens: 128000,
      auto: true,
      semantic: true,
      tailTurns: 3,
      timeoutMs: 45000,
      bufferTokens: 9,
      lastDurationMs: 4200.4,
      lastTrigger: 'auto',
      lastHandoffSource: 'session-local',
      lastError: 'boom',
      lastFreshContextError: 'bad',
      compactCount: 3,
      singleShotConsumed: true,
      archive: { nextSeq: 4 },
    },
  }),
  transcript('user')
);
check('check-explicit-limit-below-the-boundary-is-kept', newSession('s-limit', { autoCompactTokenLimit: 90000 }), transcript('user'));
check('check-boundary-sized-limit-is-cleared', newSession('s-stale-limit', { autoCompactTokenLimit: 128000 }), transcript('user'));
check('check-window-percent', newSession('s-percent', { effectiveContextWindowPercent: 95, contextWindow: 200000, compactBoundaryTokens: undefined }), transcript('user'));
check('check-agent-session', newSession('s-agent', { sessionMode: 'agent', agent: 'worker' }), transcript('user'));
check('check-auto-off-records-nothing', newSession('s-off', { compaction: { auto: false, boundaryTokens: 128000 } }), transcript('user'));
check('check-no-window-records-nothing', newSession('s-nowindow', { contextWindow: undefined, rawContextWindow: undefined, compactBoundaryTokens: undefined, compaction: { auto: true } }), transcript('user'));
check('check-anthropic-provider-calibration', newSession('s-anthropic', { provider: 'anthropic', model: 'claude-x' }), transcript('user', 'call', 'tool'));

// ---- one model call -----------------------------------------------------------------------------------------------
const calls = newSession('s-calls');
turnStart('turn-start-calls', calls);
iteration('iteration-inclusive-input', calls, { deltaInput: 1000, deltaOutput: 30, deltaPrompt: 1000, deltaCachedRead: 800, deltaToolCalls: 2, requestMs: 400, reasoningTokens: 5, reasoningTokensComplete: true });
iteration('iteration-second-call-folds-into-the-totals', calls, { iterationIndex: 2, deltaInput: 1200, deltaOutput: 14, deltaPrompt: 1200, deltaCachedRead: 1000, requestMs: 250 });
iteration('iteration-reasoning-subtotal-turns-incomplete', calls, { iterationIndex: 3, deltaInput: 10, deltaOutput: 4, deltaPrompt: 10, reasoningTokens: 3, reasoningTokensComplete: false });
iteration('iteration-request-time-without-output-is-not-timed', calls, { iterationIndex: 4, deltaInput: 10, deltaOutput: 0, deltaPrompt: 10, requestMs: 900 });
const exclusive = newSession('s-exclusive', { provider: 'anthropic', model: 'claude-x' });
iteration('iteration-exclusive-input-counts-the-cache-beside-it', exclusive, { deltaInput: 100, deltaOutput: 20, deltaPrompt: 1150, deltaCachedRead: 900, deltaCacheWrite: 50, requestMs: 100 });
iteration('iteration-unmeasured-prompt-adds-nothing-to-the-readout', newSession('s-unknown'), { deltaInput: 0, deltaOutput: 14, promptKnown: false, requestMs: 70 });
iteration('iteration-occupancy-reading-keeps-the-split-unknown', newSession('s-occupancy'), { deltaInput: 0, deltaOutput: 40, contextMeasuredTokens: 5000.4 });
iteration('iteration-no-prompt-and-no-reading-clears-the-snapshot', newSession('s-clear', { lastContextTokens: 77 }), { deltaInput: 0, deltaOutput: 3 });
iteration('iteration-output-in-the-window', newSession('s-window'), { deltaInput: 500, deltaOutput: 60, deltaPrompt: 500, contextInputTokens: 400, contextOutputInWindow: true });
iteration('iteration-explicit-uncached-input', newSession('s-uncached'), { deltaInput: 500, deltaOutput: 6, deltaPrompt: 500, deltaUncachedInput: 77 });
iteration('iteration-without-a-stamp-takes-the-clock', newSession('s-stamp'), { deltaInput: 5, deltaOutput: 1, deltaPrompt: 5, ts: undefined });
iteration('iteration-counter-going-back-starts-an-epoch', newSession('s-epoch', { lastIterationIndex: 3, usageMetricsEpoch: 1, usageMetricsTurnId: 2 }), { iterationIndex: 1, deltaInput: 9, deltaOutput: 1, deltaPrompt: 9 });
iteration('iteration-stated-epoch-wins', newSession('s-stated', { lastIterationIndex: 3, usageMetricsEpoch: 1 }), { iterationIndex: 1, usageMetricsEpoch: 4, deltaInput: 9, deltaOutput: 1, deltaPrompt: 9 });
iteration(
  'iteration-old-session-keeps-its-reasoning-unknown',
  newSession('s-legacy', { totalInputTokens: 500, totalOutputTokens: 50, tokensCumulative: 550, usageReadout: { input: 1, cacheRead: 0, cacheWrite: 0 } }),
  { deltaInput: 10, deltaOutput: 2, deltaPrompt: 10, reasoningTokens: 1, reasoningTokensComplete: true, requestMs: 30 }
);

// ---- onUsageDelta -------------------------------------------------------------------------------------------------
usageDelta('usage-native-tool-prefix', newSession('s-usage-native'), transcript('user'), { deltaInput: 900, deltaOutput: 100, deltaPrompt: 900 }, tools, nativeTools);
usageDelta('usage-exclusive-input-baseline', newSession('s-usage-ex', { provider: 'anthropic', model: 'claude-x' }), transcript('user', 'call'), { deltaInput: 10, deltaOutput: 30, deltaPrompt: 5210, deltaCachedRead: 5000, deltaCacheWrite: 200 });
usageDelta('usage-occupancy-baseline', newSession('s-usage-occ'), transcript('user'), { deltaInput: 0, deltaOutput: 40, contextMeasuredTokens: 4321 });
usageDelta('usage-other-sources-record-no-baseline', newSession('s-usage-side'), transcript('user'), { deltaInput: 50, deltaOutput: 5, deltaPrompt: 50, source: 'side_question' });
usageDelta('usage-unmeasured-call-records-no-baseline', newSession('s-usage-none'), transcript('user'), { deltaInput: 0, deltaOutput: 0 });

// ---- the turn's end -----------------------------------------------------------------------------------------------
const usage = (inputTokens, outputTokens, extra = {}) => ({ inputTokens, outputTokens, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: null, reasoningTokensComplete: false, ...extra });
terminal('terminal-counted-by-the-calls-adds-no-totals', newSession('s-t1'), { usage: usage(100, 10), lastTurnUsage: usage(60, 6), toolCallsTotal: 2 }, true);
terminal('terminal-without-calls-adds-the-totals', newSession('s-t2'), { usage: usage(100, 10, { cachedTokens: 40, cacheWriteTokens: 5, reasoningTokens: 4, reasoningTokensComplete: true }), lastTurnUsage: usage(60, 6, { cachedTokens: 20 }), toolCallsTotal: 3 }, false);
terminal('terminal-without-usage-marks-the-reasoning-incomplete', newSession('s-t3', { reasoningUsage: { reasoningTokens: 9, reasoningTokensComplete: true } }), { toolCallsTotal: 0 }, true);
terminal('terminal-last-turn-defaults-to-the-aggregate', newSession('s-t4'), { usage: usage(80, 8), toolCallsTotal: 1 }, true);
terminal('terminal-occupancy', newSession('s-t5'), { usage: usage(0, 0), lastTurnUsage: { inputTokens: 0, outputTokens: 12, contextTokens: 7000.6 }, toolCallsTotal: 0 }, true);
terminal('terminal-unmeasured-clears-the-snapshot', newSession('s-t6', { lastContextTokens: 5 }), { usage: usage(0, 0), lastTurnUsage: usage(0, 0), toolCallsTotal: 0 }, true);
terminal('terminal-context-input-puts-the-output-in-the-window', newSession('s-t7'), { usage: usage(900, 30), lastTurnUsage: usage(900, 30, { contextInputTokens: 400, contextCachedTokens: 10 }), toolCallsTotal: 0 }, true);
terminal('terminal-exclusive-input', newSession('s-t8', { provider: 'anthropic', model: 'claude-x' }), { usage: usage(10, 5, { cachedTokens: 300, cacheWriteTokens: 40 }), lastTurnUsage: usage(10, 5, { cachedTokens: 300, cacheWriteTokens: 40 }), toolCallsTotal: 1 }, false);
settled('settled-exclusive-input', newSession('s-settled-ex', { provider: 'anthropic', model: 'claude-x' }), transcript('user', 'answer'), { usage: usage(10, 5, { cachedTokens: 300, cacheWriteTokens: 40 }), lastTurnUsage: usage(10, 5, { cachedTokens: 300, cacheWriteTokens: 40 }), toolCallsTotal: 0 }, false);
settled('settled-unmeasured-records-no-baseline', newSession('s-settled-none'), transcript('user', 'answer'), { usage: usage(0, 0), lastTurnUsage: usage(0, 0), toolCallsTotal: 0 }, true);

// ---- a compaction pass (compactBeforeSend): its 'compacting' stage, then the way it ended --------------------------------
// `end`: { kind: 'done', changed, handoffSource, afterTokens, durationMs, after: [row names] } | { kind: 'failed', message,
// durationMs } | { kind: 'skipped' }. The whole header after both stages is compared.
const passFlow = (name, session, messages, end, { trigger = 'auto', reactive = false, native = [], sendTools = tools } = {}) => {
  const afterRows = end.kind === 'done' ? transcript(...end.after) : [];
  const args = { tools: wireTools(sendTools), native, reactive, trigger, agentMode: agentMode.isAgentModeSession(session), end: { ...end, after: undefined }, after: clone(afterRows) };
  step(name, 'pass', session, messages, args, () => {
    const live = clone(messages);
    const pol = policy.resolveWorkerCompactPolicy(session, native.length ? finalizeProviderRequestTools([...clone(native), ...sendTools], native.length) : sendTools);
    const estimate = providerAwareTokens(debug.estimateMessagesTokensSafe(live), live, session);
    const pressure = policy.compactionTelemetryPressureTokens(estimate, pol, { reactivePending: reactive, messages: live, sessionRef: session });
    const remember = (stage, extra) =>
      policy.rememberCompactTelemetry(session, pol, { stage, beforeTokens: pressure, afterTokens: pressure, messageTokensEst: estimate, pressureTokens: pressure, ...extra });
    remember('compacting', { trigger });
    if (end.kind === 'failed') {
      remember('overflow_failed', { trigger, freshContextError: end.message, compactError: end.message, durationMs: end.durationMs });
    } else if (end.kind === 'skipped') {
      remember('pre_send_check', { skipReason: 'no_token_reduction' });
    } else {
      if (end.changed) metrics.bumpUsageMetricsEpoch(session);
      remember('pre_send', {
        afterTokens: end.afterTokens,
        compactChanged: end.changed,
        freshContext: true,
        freshContextError: null,
        handoffSource: end.handoffSource,
        compactError: null,
        durationMs: end.durationMs,
      });
      if (end.changed) {
        const rest = clone(afterRows);
        policy.recordContextUsageSnapshot(session, pol, {
          messages: rest,
          usedTokens: end.afterTokens,
          messageTokensEst: providerAwareTokens(debug.estimateMessagesTokensSafe(rest), rest, session),
          source: 'post_compact',
        });
      }
    }
  });
};
{
  const session = newSession('s-compacted');
  turnStart('turn-start-compacted', session);
  usageDelta('usage-before-compaction', session, transcript('user', 'call', 'tool'), { deltaInput: 800, deltaOutput: 20, deltaPrompt: 800 });
  passFlow('pass-compacted-bumps-the-epoch-and-voids-the-reading', session, transcript('user', 'call', 'tool'), { kind: 'done', changed: true, handoffSource: 'session-local', afterTokens: 300, durationMs: 1234.4, after: ['user', 'answer'] });
}
passFlow('pass-no-change-keeps-the-reading', newSession('s-pass-same'), transcript('user'), { kind: 'done', changed: false, handoffSource: 'rules', afterTokens: 40, durationMs: 12, after: ['user'] });
passFlow('pass-skipped-is-a-plain-check', newSession('s-pass-skip'), transcript('user', 'call', 'tool'), { kind: 'skipped' }, { trigger: 'cache_expired' });
passFlow(
  'pass-failed-records-the-error',
  newSession('s-pass-fail', { compaction: { boundaryTokens: 128000, auto: true, compactCount: 2, lastTrigger: 'auto' } }),
  transcript('user', 'call', 'tool'),
  { kind: 'failed', message: 'summary send failed', durationMs: 90 },
  { trigger: 'reactive', reactive: true }
);
passFlow(
  'pass-after-an-earlier-error-clears-it',
  newSession('s-pass-clear', { compaction: { boundaryTokens: 128000, auto: true, lastError: 'boom', lastFreshContextError: 'bad', compactCount: 1, lastDurationMs: 77 } }),
  transcript('user', 'call', 'tool'),
  { kind: 'done', changed: true, handoffSource: 'rules', afterTokens: 55, durationMs: 0, after: ['user'] }
);

// ---- syncSessionCompaction: a session follows the saved compaction settings (session-compaction-sync.mjs) -------------------
const { syncSessionCompaction } = await load('src/session-runtime/session-compaction-sync.mjs');
const syncCase = (name, session, config) => step(name, 'sync', session, [], { config }, () => syncSessionCompaction(session, clone(config)));
const created = { boundaryTokens: 128000, auto: true, model: null, summaryModel: null, timeoutMs: null, bufferTokens: 4000, bufferRatio: 0.03, mainBufferTokens: null, reservedTokens: null, contextWindow: 128000, lastStage: 'pre_send_check', compactCount: 2 };
syncCase('sync-seeds-the-config-fields-and-strips-the-buffer', newSession('s-sync', { compaction: created }), { compaction: { auto: true } });
syncCase('sync-takes-the-saved-values', newSession('s-sync-saved', { compaction: created }), { compaction: { auto: false, summaryModel: 'm-sum', bufferTokens: 9000, summaryMode: 'self', onModelChange: false } });
// The install point (boot/infrastructure.mjs): the sync runs unless the caller injected its own config.
const { usesInjectedConfig } = await load('src/session-runtime/session-compaction-sync.mjs');
for (const [label, params] of [['none', {}], ['object', { initialConfig: { compaction: { auto: false } } }], ['not-an-object', { initialConfig: 'x' }]]) {
  const session = newSession(`s-install-${label}`, { compaction: created });
  step(`install-${label}`, 'install', session, [], { params, config: { compaction: { auto: true } } }, () => {
    if (!usesInjectedConfig(params)) syncSessionCompaction(session, { compaction: { auto: true } });
  });
}
syncCase('sync-without-a-section-leaves-the-session-alone', newSession('s-sync-none', { compaction: created }), { other: 1 });

// ---- the disk-side heartbeat: Node's own event handlers over a run of events, the clock moved across the 60 s boundary --------
// `markSessionStreamDelta` (text, reasoning, tool protocol, and the non-semantic transport / keepalive) and
// `markSessionToolCall`; after each event the session's `lastHeartbeatAt` and how many times it was saved.
{
  const live = await load(`${sessionDir}/manager/runtime-liveness.mjs`);
  const { runtimeState } = await load(`${sessionDir}/manager/runtime-state.mjs`);
  let saves = 0;
  live.configureRuntimeLiveness({ saveSessionAsync: async () => { saves += 1; } });
  const session = { id: 's-heartbeat', generation: 0 };
  runtimeState.set(session.id, { stage: 'streaming', session, controller: { signal: { aborted: false } }, updatedAt: clock });
  const events = [];
  const run = [
    ['text', 0],
    ['reasoning', 10_000],
    ['transport', 20_000],
    ['tool', 30_000],
    ['text', 30_000],
    ['keepalive', 1],
    ['toolCall', 5_000],
    ['text', 1],
    ['reasoning', 60_000],
    ['text', 1],
    ['semantic', 61_000],
    ['text', 100],
  ];
  const started = clock;
  for (const [kind, advance] of run) {
    clock += advance;
    const before = session.lastHeartbeatAt ?? null;
    if (kind === 'toolCall') live.markSessionToolCall(session.id, 'read');
    else await live.markSessionStreamDelta(session.id, kind);
    events.push({ kind, at: clock, before, after: session.lastHeartbeatAt ?? null, saves });
  }
  writeFileSync(join(here, 'golden', 'heartbeat.json'), `${JSON.stringify({ start: started, events }, null, 2)}\n`);
}

// ---- the stream decoder's own progress kinds, into the same heartbeat ----------------------------------------------------------
// Node's Anthropic SSE decoder (`createAnthropicSseTurn`) fed a tool_use block, a thinking block and a text block, its
// `onStreamDelta` wired to the real `markSessionStreamDelta`: per decoder event the progress kinds it reported and the
// session's `lastHeartbeatAt` afterwards. `rust` names the Rust `StreamEvent` that is the same wire event.
{
  const live = await load(`${sessionDir}/manager/runtime-liveness.mjs`);
  const { runtimeState } = await load(`${sessionDir}/manager/runtime-state.mjs`);
  const { createAnthropicSseTurn } = await load('src/runtime/agent/orchestrator/providers/anthropic-sse-turn.mjs');
  let saves = 0;
  live.configureRuntimeLiveness({ saveSessionAsync: async () => { saves += 1; } });
  const session = { id: 's-decoder', generation: 0 };
  runtimeState.set(session.id, { stage: 'streaming', session, controller: { signal: { aborted: false } }, updatedAt: clock });
  let kinds = [];
  const pending = [];
  const turn = createAnthropicSseTurn({
    state: null,
    knownToolNames: ['read'],
    onStreamDelta: (kind = 'semantic') => {
      kinds.push(kind);
      pending.push(live.markSessionStreamDelta(session.id, kind));
    },
    onToolCall: () => {},
    onTextDelta: () => {},
  });
  const steps = [
    ['tool_use block opens', 'ToolCallStart', 0, () => turn.onContentBlockStart(0, { type: 'tool_use', id: 'c1', name: 'read' })],
    ['arguments stream (first)', 'ToolCallArgsDelta', 70_000, () => turn.onContentBlockDelta(0, { type: 'input_json_delta', partial_json: '{"path":' })],
    ['arguments stream (second)', 'ToolCallArgsDelta', 1_000, () => turn.onContentBlockDelta(0, { type: 'input_json_delta', partial_json: '"a.txt"}' })],
    ['tool_use block closes', 'ToolCallDone', 61_000, () => turn.onContentBlockStop(0)],
    ['thinking streams', 'ReasoningDelta', 1_000, () => { turn.onContentBlockStart(1, { type: 'thinking', thinking: '' }); turn.onContentBlockDelta(1, { type: 'thinking_delta', thinking: 'hm' }); }],
    ['text streams', 'TextDelta', 61_000, () => { turn.onContentBlockStart(2, { type: 'text', text: '' }); turn.onContentBlockDelta(2, { type: 'text_delta', text: 'Done.' }); }],
  ];
  const events = [];
  const started = clock;
  for (const [label, rust, advance, drive] of steps) {
    clock += advance;
    kinds = [];
    drive();
    await Promise.all(pending.splice(0));
    events.push({ label, rust, at: clock, kinds, after: session.lastHeartbeatAt ?? null, saves });
  }
  writeFileSync(join(here, 'golden', 'stream_progress.json'), `${JSON.stringify({ start: started, events }, null, 2)}\n`);
}

writeFileSync(join(here, 'golden', 'usage.json'), `${JSON.stringify({ cases }, null, 2)}\n`);
refreshSetManifest(agentDir, nodeRoot);
process.exit(0);
