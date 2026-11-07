// Records the rows Node's trace helpers write, for native/core/fixtures/agent-trace/builders-golden.json.
//
//   MIXDOG_REPO=<node tree> node record-agent-trace-builders.mjs <out.json>
//
// Each case runs the real Node helper (`recorded`) and keeps the row it wrote to the local trace file;
// the Rust builder is given the same call as JSON. Call sites inside private code are driven by
// record-agent-trace-sites.mjs. MIXDOG_DATA_DIR/HOME/APPDATA point at a temp dir set before any
// Mixdog module is imported; Date.now is fixed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const T0 = 1700000000000;

if (process.argv[2] === '--child') {
  Date.now = () => T0;
  const root = resolve(process.env.MIXDOG_REPO);
  const orch = (name) => import(pathToFileURL(join(root, 'src/runtime/agent/orchestrator', name)).href);
  const io = await orch('agent-trace-io.mjs');
  const t = await orch('agent-trace.mjs');
  const fmt = await orch('agent-trace-format.mjs');
  const fallback = await orch('providers/lib/transport-fallback-trace.mjs');
  const prewarm = await orch('providers/openai-startup-prewarm.mjs');
  const cacheBreak = await orch('cache-break-trace.mjs');
  const gemini = await orch('providers/gemini-cache-policy.mjs');
  const diagnostics = await orch('session/loop/diagnostics.mjs');
  const browser = await import(pathToFileURL(join(root, 'src/runtime/browser-bridge/timing.mjs')).href);
  const usageContext = await import(pathToFileURL(join(root, 'src/runtime/shared/llm/usage-context.mjs')).href);
  const append = io.appendAgentTrace;

  const cases = [];
  const add = (name, builder, rust, run, extra = {}) => cases.push({ name, builder, rust, run, ...extra });

  add('preset', 'preset_assign', { sessionId: 's1', agent: 'worker', presetName: 'fast', model: 'm', provider: 'p', parentSessionId: 'par' }, () =>
    t.traceAgentPreset({ sessionId: 's1', agent: 'worker', presetName: 'fast', model: 'm', provider: 'p', parentSessionId: 'par' }));
  add('preset-empty', 'preset_assign', { sessionId: 's1' }, () => t.traceAgentPreset({ sessionId: 's1' }));
  const fetchArgs = { sessionId: 's2', headersMs: 120, httpStatus: 200, handshakeRetries: 2, handshakeRetryClassifiers: ['a', 'b'], provider: 'openai', model: 'm', transport: 'websocket' };
  add('fetch', 'fetch', fetchArgs, () => t.traceAgentFetch(structuredClone(fetchArgs)));
  const fetchMin = { sessionId: 's2', headersMs: 5, httpStatus: 503, handshakeRetries: null, handshakeRetryClassifiers: [] };
  add('fetch-min', 'fetch', fetchMin, () => t.traceAgentFetch(structuredClone(fetchMin)));
  const sseArgs = { sessionId: 's3', sseParseMs: 900, ttftMs: 150, provider: 'anthropic', model: 'm', transport: 'http' };
  add('sse', 'sse', sseArgs, () => t.traceAgentSse(structuredClone(sseArgs)));
  const timing = { sessionId: 's4', status: 'ok', requestId: 'r1', ttftMs: 100.5, endToEndTtftMs: '250.4', queueMs: null, routeMs: 3, preflightMs: undefined, mcpMs: -0.5, providerMs: 'x' };
  add('turn-timing', 'turn_timing', JSON.parse(JSON.stringify(timing)), () => t.traceTurnTiming({ ...timing }));
  add('turn-timing-empty', 'turn_timing', { sessionId: 's4' }, () => t.traceTurnTiming({ sessionId: 's4' }));

  const usage = (name, rust, identity) =>
    add(name, 'usage_raw', identity ? { ...rust, __identity: identity } : rust, () => {
      const call = () => t.traceAgentUsage(structuredClone(rust));
      if (identity) usageContext.withUsageContext(structuredClone(identity), call);
      else call();
    });
  usage('usage-anthropic', {
    sessionId: 'u1', iteration: 2, inputTokens: 100, outputTokens: 40, cachedTokens: 300, cacheWriteTokens: 50,
    model: 'claude', modelDisplay: 'Claude', responseId: 'resp', rawUsage: { service_tier: 'priority', output_tokens_details: { reasoning_tokens: 7 } },
    provider: 'anthropic', requestKind: 'turn', requestPrevResponseId: 'prev', chainContinuous: true, continuationResetReason: null,
    prefixBlocks: [{ hash: 'abc' }],
  });
  usage('usage-openai', { sessionId: 'u2', iteration: 1, inputTokens: 500, outputTokens: 20, cachedTokens: 200, provider: 'openai', model: 'gpt', promptTokens: 480, rawUsage: { thinkingTokens: 3, serviceTier: 'flex' }, serviceTier: 'auto' });
  usage('usage-identity', { sessionId: 'raw', inputTokens: 10, outputTokens: 5, provider: 'anthropic', model: 'm', pricingModel: 'pm0', rawUsage: { reasoningTokens: 5, reasoningTokensComplete: false } },
    { provider: 'xai', sessionId: 'idsess', inputTokensInclusive: false, requestedModel: 'rm', pricingModel: 'pm', sourceType: 'lead' });
  usage('usage-min', { sessionId: 'u3' });
  // The provider is lowered with toLowerCase(): ANTHROPIC is the additive convention, ANTHROPİC
  // (dotted capital I) lowers to i + U+0307 and is not.
  usage('usage-upper', { sessionId: 'u5', inputTokens: 100, outputTokens: 1, cachedTokens: 30, cacheWriteTokens: 10, provider: 'ANTHROPIC-OAuth' });
  usage('usage-dotted-i', { sessionId: 'u6', inputTokens: 100, outputTokens: 1, cachedTokens: 30, cacheWriteTokens: 10, provider: 'ANTHROP\u0130C' });
  usage('usage-bad-reasoning', { sessionId: 'u4', inputTokens: 1, outputTokens: 1, provider: 'google', rawUsage: { reasoningTokens: -1, raw: {} } });

  add('loop', 'loop', { sessionId: 'l1', iteration: 3, sendMs: 40, preSendMs: 5, messageCount: 7, bodyBytesEst: 1234, agent: 'lead' }, () =>
    fmt.traceAgentLoop({ sessionId: 'l1', iteration: 3, sendMs: 40, preSendMs: 5, messageCount: 7, bodyBytesEst: 1234, agent: 'lead' }));
  add('loop-min', 'loop', { sessionId: 'l1', iteration: 3, sendMs: 40, messageCount: 7 }, () =>
    fmt.traceAgentLoop({ sessionId: 'l1', iteration: 3, sendMs: 40, messageCount: 7 }));
  add('compress', 'compress', { sessionId: 'c1', toolName: 'grep', before: 1000, after: 250 }, () => fmt.traceAgentCompress({ sessionId: 'c1', toolName: 'grep', before: 1000, after: 250 }));
  add('compress-zero', 'compress', { sessionId: 'c1', toolName: 'grep', before: 0, after: 0 }, () => fmt.traceAgentCompress({ sessionId: 'c1', toolName: 'grep', before: 0, after: 0 }));
  const shell = {
    sessionId: 'sh1', toolName: 'shell', toolCallId: 'tc', preOffloadBytes: 5000, postOffloadBytes: 800, modelVisibleBytes: 900, offloaded: true, resultKind: 'ok',
    telemetry: { commandOutputBytes: 5000.7, capturedPreviewBytes: 100, shellResultBytes: 5100, toolResultBytes: 5200, exitCode: 2, signal: 'SIGTERM', timedOut: true, spilled: true, losslessCompaction: { applied: true, reason: 'dup', kind: 'lines' } },
  };
  add('shell-output', 'shell_output', shell, () => fmt.traceAgentShellOutput(structuredClone(shell)));
  const shellMin = { sessionId: 'sh2', telemetry: { commandOutputBytes: 0, exitCode: 1.5 }, modelVisibleBytes: -3 };
  add('shell-output-min', 'shell_output', shellMin, () => fmt.traceAgentShellOutput(structuredClone(shellMin)));
  add('shell-output-none', 'shell_output', { sessionId: 'sh3', telemetry: {} }, () => fmt.traceAgentShellOutput({ sessionId: 'sh3', telemetry: {} }), { emits: false });
  add('shell-output-nosession', 'shell_output', { telemetry: { commandOutputBytes: 1 } }, () => fmt.traceAgentShellOutput({ telemetry: { commandOutputBytes: 1 } }), { emits: false });
  const toolOut = { sessionId: 'to1', toolName: 'read', toolCallId: 'tc', preOffloadBytes: 9000, postOffloadBytes: 700, modelVisibleBytes: 1000, offloaded: true, resultKind: 'ok' };
  add('tool-output', 'tool_output', toolOut, () => fmt.traceAgentToolOutput({ ...toolOut }));
  add('tool-output-not-offloaded', 'tool_output', { ...toolOut, offloaded: false }, () => fmt.traceAgentToolOutput({ ...toolOut, offloaded: false }), { emits: false });
  add('batch', 'batch', { sessionId: 'b1', toolCallCount: 3 }, () => fmt.traceAgentBatch({ sessionId: 'b1', toolCallCount: 3 }));
  const batchFull = { sessionId: 'b2', toolCallCount: 2, batchId: 'bid', batchCalls: [{ id: 'a' }, { id: 'b' }], iteration: 4 };
  add('batch-full', 'batch', batchFull, () => fmt.traceAgentBatch(structuredClone(batchFull)));

  const streamErr = { code: 'ECONNRESET', httpStatus: 0, status: 502, retryClassifier: 'reset', message: 'boom' };
  add('fallback-nonstreaming', 'transport_fallback', {
    sessionId: 'f1', iteration: 3, provider: 'anthropic', model: 'm', transport: 'non-streaming', from: 'stream', to: 'non-streaming',
    reason: 'reset', error_code: 'ECONNRESET', error_http_status: 502, error_classifier: 'reset',
  }, () => fallback.traceNonStreamingFallback({ provider: 'anthropic', model: 'm', opts: { sessionId: 'f1', iteration: '3' }, streamErr }));
  add('prewarm', 'spawn_ws_prewarm', { sessionId: 'pk', payload: { stage: 'open', ms: 12 } }, () => prewarm.traceStartupPrewarm('pk', { stage: 'open', ms: 12 }));
  add('output-truncated', 'output_truncated', { sessionId: 'o1', iteration: 2, stop_reason: 'max_tokens', content_len: 3, agent: 'lead' }, () =>
    diagnostics.traceOutputTruncation({ sessionId: 'o1', iteration: 2, response: { truncated: true, stopReason: 'max_tokens', content: 'abc' }, sessionAgent: 'lead' }));
  add('output-truncated-defaults', 'output_truncated', { sessionId: 'o1', iteration: 2, stop_reason: 'length', content_len: 0 }, () =>
    diagnostics.traceOutputTruncation({ sessionId: 'o1', iteration: 2, response: { truncated: true } }));
  const gemRust = { sessionId: 'g1', iteration: 2, kind: 'gemini_cache', payload: { hit: true } };
  add('gemini-cache', 'gemini_cache', gemRust, () => gemini.traceGeminiCache({ sessionId: 'g1' }, 2, 'gemini_cache', { hit: true }));
  const cb = { sessionId: 'cb1', iteration: 4, classification: 'unexpected', reason: 'prefix_changed', source: 'anthropic', provider: 'anthropic', model: 'm', transport: 'http', cachedTokens: 0, promptTokens: 1000 };
  let cbPayload = null;
  add('cache-break', 'cache_break', null, () => {
    cbPayload = cacheBreak.traceCacheBreak(structuredClone(cb), { stderr: false });
  }, { after: (c) => { c.rust = { sessionId: 'cb1', iteration: 4, payload: cbPayload }; } });
  const ctx = { sessionId: 'bt1', turnId: 't1', action: 'click' };
  const bodyOk = { ok: true, value: { timing: { queueMs: 2, commandMs: 5, waitMs: -1, snapshots: 1, steps: [{ index: 1, commandMs: 3, text: 'x' }, { index: 9, commandMs: 1 }], mouseEvents: { mouseMoved: { count: 2, totalMs: 4 }, mousePressed: {} } } } };
  add('browser-timing', 'browser_timing', { context: ctx, bridgeMs: 33, body: bodyOk, status: 200 }, () => browser.traceBrowserTiming(ctx, 33, structuredClone(bodyOk), 200));
  const bodyErr = { ok: false, timing: { queueMs: 1, screenshotMs: 9 } };
  add('browser-timing-error', 'browser_timing', { context: { sessionId: 'bt2' }, bridgeMs: 1, body: bodyErr, status: 500 }, () => browser.traceBrowserTiming({ sessionId: 'bt2' }, 1, structuredClone(bodyErr), 500));

  const results = [];
  const lines = [];
  for (const c of cases) {
    const before = (() => { try { return readFileSync(join(process.env.MIXDOG_DATA_DIR, 'history', 'agent-trace.jsonl'), 'utf8'); } catch { return ''; } })();
    c.run();
    await io.drainAgentTrace();
    c.after?.(c);
    const after = readFileSync(join(process.env.MIXDOG_DATA_DIR, 'history', 'agent-trace.jsonl'), 'utf8');
    const added = after.slice(before.length);
    const emits = added.length > 0;
    if (c.emits === false && emits) throw new Error(`${c.name} emitted unexpectedly`);
    if (c.emits !== false && !emits) throw new Error(`${c.name} emitted nothing`);
    if (emits) lines.push(added.trimEnd());
    results.push({ name: c.name, builder: c.builder, how: c.how ?? 'recorded', source: c.source ?? null, rust: c.rust, emits });
  }
  const pure = {
    grokChain: [
      [{ xaiResponses: { previousResponseId: 'p1' } }, 'p1', 'x'],
      [{ xaiResponses: { previousResponseId: 'p1' } }, 'p2', null],
      [null, '', undefined],
    ].map(([state, prev, reason]) => ({ state, prev, reason: reason ?? null, out: t.grokCacheChainTraceFields(state, prev, reason) })),
  };
  writeFileSync(process.argv[3], `${JSON.stringify({ note: 'recorded by benchmarks/rust-core/recorders/record-agent-trace-builders.mjs', now: T0, cases: results, jsonl: lines.join('\n') + '\n', pure }, null, 1)}\n`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'agent-trace-builders-'));
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  MIXDOG_REPO: process.env.MIXDOG_REPO,
  MIXDOG_DATA_DIR: dir,
  HOME: dir,
  USERPROFILE: dir,
  APPDATA: dir,
  LOCALAPPDATA: dir,
  MIXDOG_DIAGNOSTICS: '1',
  MIXDOG_AGENT_TRACE_VERBOSE: '1',
  MIXDOG_AGENT_TRACE_TIMING: '1',
};
const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', process.argv[2]], { env, encoding: 'utf8' });
rmSync(dir, { recursive: true, force: true });
if (run.status !== 0) throw new Error(`child failed: ${run.stderr}`);
