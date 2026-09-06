const states = new Map();
const stateFor = (id) => {
  if (!states.has(id)) states.set(id, {});
  return states.get(id);
};

export function localModelState(id) {
  const state = states.get(id);
  return state ? structuredClone(state) : {};
}

export function recordLocalModelLoad(id, props, loadTimeMs) {
  const state = stateFor(id);
  const caps = props?.chat_template_caps || {};
  state.capabilities = {
    tools: caps.supports_tools === false || caps.supports_tool_calls === false ? false
      : caps.supports_tools === true && caps.supports_tool_calls === true ? true : null,
    images: false, audio: false, video: false,
    reasoningSettings: false,
  };
  state.loadTimeMs = typeof loadTimeMs === 'number' && Number.isFinite(loadTimeMs) ? Math.round(loadTimeMs) : null;
}

export function beginLocalInference(id, queuedAt, now = performance.now.bind(performance)) {
  const started = now();
  let first = null;
  stateFor(id).inference = { state: 'running', queueWaitMs: Math.max(0, started - queuedAt) };
  return {
    progress(kind) { if (kind !== 'transport' && first === null) first = now(); },
    finish(result, error) {
      const end = now();
      const outputTokens = Number(result?.usage?.outputTokens);
      const generationMs = first === null ? null : Math.max(0, end - first);
      stateFor(id).inference = {
        state: error ? 'failed' : 'complete', at: new Date().toISOString(),
        queueWaitMs: Math.round(Math.max(0, started - queuedAt)),
        firstResponseMs: first === null ? null : Math.round(first - started),
        durationMs: Math.round(end - started),
        outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
        inputTokens: Number.isFinite(result?.usage?.inputTokens) ? result.usage.inputTokens : null,
        tokensPerSecond: generationMs > 0 && outputTokens > 1
          ? Math.round((outputTokens - 1) / (generationMs / 1000) * 10) / 10 : null,
        error: error ? String(error?.message || error).slice(0, 1024) : null,
      };
    },
  };
}

export function recordLocalModelVerification(id, verification) {
  stateFor(id).verification = { ...verification, at: new Date().toISOString() };
}

export function forgetLocalModelState(id) { states.delete(id); }
