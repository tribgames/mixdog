// Provider request boundary for one agent-loop iteration: normalize the
// transcript, freeze exactly one tool snapshot for the whole request (pressure,
// send, recovery, telemetry), and run the pre-send compact pass until the
// transcript stops changing. Extracted from agentLoop; behavior identical to
// the inline do/while it replaced.
import { repairTranscriptBeforeProviderSend } from './transcript-repair.mjs';
import { messagesArrayChanged } from './tool-helpers.mjs';
import { runPreSendCompactPass } from '../pre-send-compact.mjs';
import { snapshotProviderRequestTools } from '../../../../../session-runtime/tool-catalog.mjs';
import {
    providerNativeToolPrefixCount,
    runWithProviderRequestToolsScope,
} from '../../../../../session-runtime/provider-request-tools.mjs';

export async function prepareProviderRequest(state) {
    const {
        provider, messages, model, baseSendTools, sessionRef, sessionId, cwd, opts, signal,
        loopUsageMetricsTurnId, loopUsageMetricsEpoch,
    } = state;
    let {
        iterations, lastUsage, firstTurnUsage, providerState, reactiveOverflowRetryPending,
        fixedProviderToolSurface,
    } = state;
    let providerStateCleared = false;
    // A soft compact target may remain above an explicit trigger: never
    // compact the same input twice before a provider attempt.
    let compactAttempted = false;
    let compactChanged;
    let sendTools;
    let requestToolScope;
    do {
        // Provider-history normalization is part of the request boundary:
        // repair first, then take exactly one immutable tool snapshot.
        const messagesBeforeTranscriptRepair = messages.slice();
        repairTranscriptBeforeProviderSend(messages, sessionId);
        if (!opts.cacheBreakIntent
            && messagesArrayChanged(messagesBeforeTranscriptRepair, messages)) {
            opts.cacheBreakIntent = 'transcript_rebuild';
        }
        const candidateSendTools = snapshotProviderRequestTools({
            provider: sessionRef?.provider || provider?.name,
            tools: baseSendTools,
            nativeTools: opts.nativeTools,
            messages,
            session: sessionRef,
        });
        // Only native deferred definitions may join a running request loop.
        // Skill discovery never promotes them into the eager cache prefix.
        const deferredToolsAdded = fixedProviderToolSurface
            && candidateSendTools.some((tool) => (
                (tool.deferLoading === true || tool.defer_loading === true)
                && !fixedProviderToolSurface.some((previous) => previous.name === tool.name)
            ));
        if (!fixedProviderToolSurface || deferredToolsAdded) {
            fixedProviderToolSurface = candidateSendTools;
        }
        sendTools = fixedProviderToolSurface;
        requestToolScope = {
            session: sessionRef,
            provider: sessionRef?.provider || provider?.name,
            messages,
            requestTools: sendTools,
            nativePrefixCount: providerNativeToolPrefixCount(sendTools),
        };
        const pass = await runWithProviderRequestToolsScope(requestToolScope, () => runPreSendCompactPass({
            provider,
            messages,
            model,
            requestTools: sendTools,
            sessionRef,
            sessionId,
            cwd,
            opts,
            signal,
            iterations,
            lastUsage,
            firstTurnUsage,
            providerState,
            reactiveOverflowRetryPending,
            loopUsageMetricsTurnId,
            loopUsageMetricsEpoch,
            skipProactiveCompact: compactAttempted,
        }));
        ({
            iterations,
            lastUsage,
            firstTurnUsage,
            providerState,
            reactiveOverflowRetryPending,
            compactChanged,
        } = pass);
        compactAttempted ||= compactChanged;
        // Sticky: a pass that dropped providerState still invalidates it even
        // when a later pass in the same boundary leaves it untouched.
        if (pass.providerStateCleared) providerStateCleared = true;
        // A changed transcript ends this request attempt. Repair the new
        // history and establish one fresh post-compaction snapshot before
        // sending.
    } while (compactChanged);
    return {
        iterations,
        lastUsage,
        firstTurnUsage,
        providerState,
        providerStateCleared,
        reactiveOverflowRetryPending,
        fixedProviderToolSurface,
        sendTools,
        requestToolScope,
    };
}
