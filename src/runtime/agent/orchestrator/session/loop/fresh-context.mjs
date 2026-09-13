// Conversation-only compaction. The current summary and live conversation
// produce one replacement summary; Memory DB contents are never read or mutated.
import { loadConfig } from '../../config.mjs';
import { getProvider, initProviders } from '../../providers/registry.mjs';
import { resolveMaintenanceRoute } from '../../agent-runtime/maintenance-route.mjs';
import { resolveSessionContextMeta } from '../manager/context-meta.mjs';
import { builtinFeatureActive } from '../../../../../session-runtime/builtin-features.mjs';
import { positiveInt } from '../../../../shared/numbers.mjs';
import { providerTokenCalibration } from '../context-utils.mjs';
import {
    freshContextCompactMessages,
    generateFreshHandoffSummary,
    SUMMARY_OUTPUT_TOKENS,
} from '../compact.mjs';

// Select an explicitly configured, enabled maintenance route only. An absent
// or disabled maintenance role falls back to the conversation's own model,
// not an unrelated global default. Provider failures/cancellation are not
// absence and must propagate without silently routing around them.
export async function resolveCompactionRoute({
    sessionRef,
    provider,
    model,
    config = loadConfig(),
    signal,
    getProviderFn = getProvider,
    initProvidersFn = initProviders,
} = {}) {
    signal?.throwIfAborted();
    const route = builtinFeatureActive(config, 'memory') && config.recap?.enabled !== false
        ? resolveMaintenanceRoute({ agent: 'cycle1-agent', config, includeDefault: false })
        : null;
    const useMaintenance = !!(route?.provider && route?.model
        && config.providers?.[route.provider]?.enabled !== false);
    const providerName = useMaintenance ? route.provider : (sessionRef?.provider || provider?.name);
    const selectedModel = useMaintenance ? route.model : (model || sessionRef?.model);
    if (useMaintenance) await initProvidersFn(config.providers || {}, { signal });
    signal?.throwIfAborted();
    const selectedProvider = useMaintenance ? getProviderFn(providerName) : (provider || getProviderFn(providerName));
    if (!selectedProvider || typeof selectedProvider.send !== 'function' || !selectedModel) {
        throw new Error(`compact summary route unavailable: ${providerName || 'unknown'}/${selectedModel || 'unknown'}`);
    }
    const sameModel = providerName === sessionRef?.provider && selectedModel === sessionRef?.model;
    const contextWindow = sameModel && positiveInt(sessionRef?.contextWindow)
        ? positiveInt(sessionRef.contextWindow)
        : resolveSessionContextMeta(selectedProvider, selectedModel).contextWindow;
    return {
        provider: selectedProvider,
        providerName,
        model: selectedModel,
        contextWindow,
        fast: useMaintenance ? route.fast === true : undefined,
        source: useMaintenance ? 'maintenance' : 'session',
    };
}

export async function runFreshContextCompact({
    sessionRef,
    messages,
    compactBudgetTokens,
    compactPolicy = {},
    sessionId = sessionRef?.id,
    signal,
    provider,
    model,
    sendOpts = {},
    goalReminderText,
    activeTurn,
    config,
    getProviderFn,
    initProvidersFn,
} = {}) {
    const startedAt = Date.now();
    const route = await resolveCompactionRoute({
        sessionRef, provider, model, config, signal, getProviderFn, initProvidersFn,
    });
    const contextWindow = positiveInt(compactPolicy.contextWindow)
        || positiveInt(sessionRef?.contextWindow)
        || positiveInt(compactPolicy.boundaryTokens)
        || compactBudgetTokens;
    const calibration = Number(compactPolicy.tokenCalibration) > 0
        ? Number(compactPolicy.tokenCalibration)
        : providerTokenCalibration(sessionRef?.provider || provider?.name);
    const hardBudget = Math.max(1, Math.floor(contextWindow / calibration));
    const summaryWindow = positiveInt(route.contextWindow) || contextWindow;
    const outputTokens = Math.min(SUMMARY_OUTPUT_TOKENS, Math.max(256, Math.floor(summaryWindow * 0.15)));
    // The summary request's input budget belongs to its OWN model, whereas
    // the rebuilt conversation must fit the original session's target/window.
    const inputBudget = Math.max(1, Math.floor(
        (summaryWindow - outputTokens) / providerTokenCalibration(route.providerName),
    ));
    const summarySession = {
        id: `${sessionId || 'unknown'}:compact`,
        provider: route.providerName,
        model: route.model,
        cwd: sessionRef?.cwd,
    };
    const generated = await generateFreshHandoffSummary(
        route.provider, messages, route.model, Math.max(compactBudgetTokens, hardBudget), {
            reserveTokens: compactPolicy.reserveTokens,
            compactionInputBudgetTokens: inputBudget,
            maxOutputTokens: outputTokens,
            providerName: route.providerName,
            sessionId,
            signal,
            // Never share provider conversation state or cross-provider
            // credentials with the summary request.
            sendOpts: {
                ...(route.providerName === sessionRef?.provider ? sendOpts : {}),
                session: summarySession,
            },
            fast: route.fast,
            timeoutMs: compactPolicy.handoffTimeoutMs,
            force: true,
            filterOldHistoryForIngest: true,
        },
    );
    signal?.throwIfAborted();
    const result = freshContextCompactMessages(messages, compactBudgetTokens, {
        reserveTokens: compactPolicy.reserveTokens,
        maxBudgetTokens: hardBudget,
        force: true,
        handoffText: generated.summary,
        contextWindow,
        sessionId,
        latestUserPrefix: goalReminderText,
        activeTurn,
    });
    signal?.throwIfAborted();
    result.usage = generated.usage;
    result.handoffSource = 'session-local';
    result.summaryProvider = route.providerName;
    result.summaryModel = route.model;
    result.diagnostics.pipeline = {
        handoffSource: 'session-local',
        summaryRoute: route.source,
        summaryProvider: route.providerName,
        summaryModel: route.model,
        generated: generated.diagnostics,
        totalMs: Date.now() - startedAt,
    };
    return result;
}
