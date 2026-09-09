import { appendAgentTrace } from '../agent/orchestrator/agent-trace-io.mjs';

/** Numeric allowlist: never log page text, targets, URLs, or input values. */
export function browserTimingRow(context, bridgeMs, body, status) {
  const numeric = (source, keys) => Object.fromEntries(keys.flatMap((key) => {
    const value = source?.[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [[key, value]] : [];
  }));
  const keys = ['commandMs', 'waitMs', 'snapshotMs', 'targetMs', 'actionabilityMs', 'inputMs'];
  const timing = body?.ok === false ? body?.timing : body?.value?.timing;
  const phases = numeric(timing, ['queueMs', ...keys, 'screenshotMs', 'snapshots', 'screenshots']);
  if (Array.isArray(timing?.steps)) {
    phases.steps = timing.steps.slice(0, 6)
      .filter((step) => Number.isInteger(step?.index) && step.index >= 1 && step.index <= 6)
      .map((step) => numeric(step, ['index', ...keys]));
  }
  if (timing?.mouseEvents) {
    phases.mouseEvents = {};
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      const event = numeric(timing.mouseEvents[type], ['count', 'totalMs']);
      if (Object.keys(event).length) phases.mouseEvents[type] = event;
    }
  }
  return {
    kind: 'browser_timing',
    sessionId: context.sessionId,
    turn_id: context.turnId,
    action: context.action,
    bridge_ms: bridgeMs,
    http_status: status,
    ok: body?.ok === true,
    payload: phases,
  };
}

export function traceBrowserTiming(context, bridgeMs, body, status) {
  if (process.env.MIXDOG_AGENT_TRACE_TIMING !== '1' && process.env.MIXDOG_AGENT_TRACE_VERBOSE !== '1') return;
  try {
    appendAgentTrace(browserTimingRow(context, bridgeMs, body, status));
  } catch {
    // Diagnostics must not change dispatch, retry, or result semantics.
  }
}
