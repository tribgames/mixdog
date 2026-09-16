// Opt-in agent-loop diagnostics. Every emitter here is gated by its own env
// switch and is a no-op on provider behavior; failures are swallowed so a
// diagnostic can never end a turn.
import { traceAgentLoop, estimateProviderPayloadBytes, appendAgentTrace } from '../../agent-trace.mjs';

function writeDiagnostic(line) {
  try {
    process.stderr.write(line);
  } catch {
    /* diagnostics only */
  }
}

function responseStopReason(response) {
  return response?.stopReason ?? response?.stop_reason ?? 'length';
}

function responseContentLength(response) {
  return typeof response?.content === 'string' ? response.content.length : 0;
}

// Two modes:
//   VERBOSE=1 → full row; pay the FULL messages+tools payload byte estimate
//               (serializes the whole array).
//   TIMING=1  → send-latency attribution only; skip the payload estimate so
//               measuring send_ms does not itself add serialization cost
//               during high-fanout bench runs.
export function traceProviderSend({
  sessionId,
  iteration,
  sendMs,
  preSendMs,
  toolResumeMs,
  messages,
  providerMessages,
  model,
  sendTools,
  sessionAgent,
}) {
  const verbose = process.env.MIXDOG_AGENT_TRACE_VERBOSE === '1';
  if (!verbose && process.env.MIXDOG_AGENT_TRACE_TIMING !== '1') return;
  traceAgentLoop({
    sessionId,
    iteration,
    sendMs,
    preSendMs,
    toolResumeMs,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    bodyBytesEst: verbose ? estimateProviderPayloadBytes(providerMessages, model, sendTools) : undefined,
    agent: sessionAgent || null,
  });
}

// Diagnostic for every provider-declared truncation. Eligible no-tool text
// turns are recovered by the max-output ladder rather than accepted as final.
export function traceOutputTruncation({ sessionId, iteration, response, sessionAgent }) {
  if (response?.truncated !== true) return;
  writeDiagnostic(
    `[loop] provider output truncated at max-output limit (sess=${sessionId || 'unknown'} ` +
      `iter=${iteration} stopReason=${responseStopReason(response)} ` +
      `contentLen=${responseContentLength(response)}); ` +
      `continuation recovery will be attempted when eligible.\n`
  );
  try {
    appendAgentTrace({
      sessionId,
      iteration,
      kind: 'output_truncated',
      payload: {
        stop_reason: responseStopReason(response),
        content_len: responseContentLength(response),
        agent: sessionAgent || null,
      },
    });
  } catch {
    /* best-effort telemetry */
  }
}

// Where non-model time goes per iteration — presend (repair/compact/snapshot),
// send (provider round-trip incl. streaming), tools (batch execution). Gated by
// the same env as [turn-timing] so bench runs opt in via -AgentEnv.
export function traceLoopPhaseTiming({ iteration, preSendMs, sendMs, toolsMs, calls }) {
  if (process.env.MIXDOG_TURN_TIMING !== '1') return;
  writeDiagnostic(
    `[loop-timing] iter=${iteration} presend=${preSendMs}ms send=${sendMs}ms tools=${toolsMs}ms calls=${calls}\n`
  );
}
