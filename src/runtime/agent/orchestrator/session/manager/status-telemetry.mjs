// Standalone-status route info + gateway usage telemetry for sessions.
// Extracted verbatim from manager.mjs (behavior-preserving). Fire-and-forget
// statusline telemetry — must never affect the model turn.
import { getProvider } from '../../providers/registry.mjs';
import { fetchOAuthUsageSnapshot } from '../../providers/oauth-usage.mjs';
import {
    buildGatewayLimits,
    recordGatewayUsageEvent,
    summarizeGatewayUsage,
} from '../../providers/statusline-route-meta.mjs';
import { estimateTranscriptContextUsage } from '../context-utils.mjs';

export function standaloneStatusRouteInfo(session) {
    if (!session) return null;
    // autoCompactTokenLimit is an EXPLICIT sub-boundary auto-compact limit only.
    // Do NOT fall back to compactBoundaryTokens/contextWindow here — that
    // labels a derived full-window value as an explicit limit, which the
    // runtime would treat as the compaction trigger and collapse the buffer.
    // The boundary/window stays available via contextWindow/rawContextWindow.
    const _boundary = Number(session.compactBoundaryTokens || session.contextWindow || 0);
    const _limit = Number(session.autoCompactTokenLimit || 0);
    const explicitAutoCompactTokenLimit = _limit > 0 && (!_boundary || _limit < _boundary) ? _limit : null;
    return {
        provider: session.provider,
        model: session.model,
        modelDisplay: session.modelDisplay || session.displayName || session.model,
        effort: session.effort || '',
        fast: session.fast === true,
        contextWindow: session.contextWindow || null,
        rawContextWindow: session.rawContextWindow || session.contextWindow || null,
        effectiveContextWindowPercent: session.effectiveContextWindowPercent || null,
        autoCompactTokenLimit: explicitAutoCompactTokenLimit,
        presetId: session.presetId || null,
        presetName: session.presetName || null,
    };
}

export function recordStandaloneStatusTelemetry(session, result, durationMs) {
    if (!session || !result?.usage) return;
    const routeInfo = standaloneStatusRouteInfo(session);
    if (!routeInfo?.provider || !routeInfo?.model) return;
    const providerOut = {
        usage: result.usage,
        model: result.model,
        serviceTier: result.serviceTier,
    };
    // The transcript estimate is the SSOT for the displayed context footprint.
    // agentLoop()'s result has no `compact` field, so build a synthetic compact
    // arg carrying the live monotonic estimate (estimateMessagesTokens+reserve)
    // as afterTokens. This lights up summarizeGatewayUsage's estimate-based
    // contextUsedPct branch (provider input_tokens swing wildly / unbounded on
    // e.g. OpenAI gpt-5.5), and lets a genuine >100% pass through.
    const _estTokens = estimateTranscriptContextUsage(session.messages, session.tools || [], { provider: session.provider });
    const _compactArg = { ...(result.compact && typeof result.compact === 'object' ? result.compact : {}), afterTokens: _estTokens };
    try {
        const summary = {
            ...summarizeGatewayUsage(routeInfo, providerOut, _compactArg, durationMs),
            requestKind: 'chat',
            sessionId: session.id || null,
            toolCount: result.toolCallsTotal ?? null,
            messageCount: Array.isArray(session.messages) ? session.messages.length : null,
            cacheStrategy: session.providerCacheOpts?.cacheStrategy || null,
        };
        recordGatewayUsageEvent(summary);
    } catch {
        // Statusline telemetry must never affect the model turn.
    }

    const provider = getProvider(routeInfo.provider);
    if (!provider) return;
    fetchOAuthUsageSnapshot(routeInfo, provider, (message) => {
        if (process.env.MIXDOG_STATUSLINE_TRACE) {
            process.stderr.write(`[statusline] ${message}\n`);
        }
    })
        .then((snapshot) => {
            try { buildGatewayLimits(routeInfo, providerOut, snapshot); } catch {}
        })
        .catch(() => {});
}
