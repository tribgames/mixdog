// Presentation contract: the last measured prompt, never cumulative billing,
// generated output, or the internal estimate used to protect the context window.
export function sessionContextMeasurement(session, hasConversationActivity = true) {
  const pending = { tokens: null, source: 'pending', updatedAt: null };
  if (!session || !hasConversationActivity) return pending;
  if (session.contextPressureBaselineSource === 'checkpoint_post_compact') return pending;
  const updatedAt = Number(session.lastContextTokensUpdatedAt) || 0;
  const compactAt = Math.max(
    Number(session.compaction?.lastChangedAt) || 0,
    Number(session.compaction?.lastCompactAt) || 0,
  );
  const routeMismatch = (session.contextPressureBaselineProvider
      && session.contextPressureBaselineProvider !== session.provider)
    || (session.contextPressureBaselineModel
      && session.contextPressureBaselineModel !== session.model);
  if (routeMismatch || (compactAt > 0 && updatedAt <= compactAt)) return pending;
  // Missing usage is explicitly persisted as null; do not revive an older
  // provider anchor or turn a missing reading into zero.
  if (session.lastContextTokens === null && updatedAt > 0) {
    return { tokens: null, source: 'unavailable', updatedAt };
  }
  if (session.lastContextTokensStaleAfterCompact === true) return pending;
  const tokens = Number(session.lastContextTokens);
  return Number.isFinite(tokens) && tokens > 0
    ? { tokens, source: 'last_api_request', updatedAt: updatedAt || null }
    : pending;
}

export function contextMeasurementStats(context) {
  const measurement = context?.measurement || {
    tokens: context?.lastApiRequestStale ? null : context?.lastApiRequestTokens,
    source: context?.lastApiRequestStale ? 'pending' : 'last_api_request',
    updatedAt: null,
  };
  const known = measurement.source === 'last_api_request'
    && Number.isFinite(Number(measurement.tokens)) && Number(measurement.tokens) > 0;
  return {
    currentContextTokens: known ? Number(measurement.tokens) : null,
    // Retained for old transports, but estimates no longer enter the display lane.
    currentEstimatedContextTokens: 0,
    currentContextSource: known ? 'last_api_request'
      : measurement.source === 'unavailable' ? 'unavailable' : 'pending',
    currentContextUpdatedAt: measurement.updatedAt || null,
  };
}

export function contextPercent(tokens, limit) {
  if (tokens == null || !(Number(limit) > 0)) return null;
  return Math.round(Math.max(0, Math.min(100, Number(tokens) / Number(limit) * 100)) * 10) / 10;
}

export function measuredContextUsage(input = {}) {
  const stats = input.stats && typeof input.stats === 'object' ? input.stats : {};
  const limit = Math.max(0, Number(input.contextWindow || input.displayContextWindow || input.rawContextWindow) || 0);
  const source = String(stats.currentContextSource || '');
  const tokens = stats.currentContextTokens;
  const known = tokens != null && Number.isFinite(Number(tokens)) && Number(tokens) > 0
    && (source === 'last_api_request' || !source);
  const used = known ? Number(tokens) : null;
  return {
    used, limit, percent: contextPercent(used, limit), known,
    source: known ? 'last_api_request' : source === 'unavailable' ? 'unavailable' : 'pending',
    updatedAt: stats.currentContextUpdatedAt || null,
    estimated: false,
  };
}

export function contextMeasurementLabel(source) {
  return source === 'last_api_request' ? 'Last measured input'
    : source === 'unavailable' ? 'Usage unavailable' : 'Awaiting measurement';
}
