// Provider request boundary for one agent-loop iteration: normalize the
// transcript, freeze exactly one tool snapshot for the whole request (pressure,
// send, recovery, telemetry), and run the pre-send compact pass until the
// transcript stops changing. Extracted from agentLoop; behavior identical to
// the inline do/while it replaced.
import { repairTranscriptBeforeProviderSend } from './transcript-repair.mjs';
import { messagesArrayChanged } from './tool-helpers.mjs';
import { runPreSendCompactPass } from '../pre-send-compact.mjs';
import {
  refreshDeferredMcpToolCatalog,
  snapshotProviderRequestTools,
} from '../../../../../session-runtime/tool-catalog.mjs';
import {
  finalizeProviderRequestTools,
  providerNativeToolPrefixCount,
  runWithProviderRequestToolsScope,
} from '../../../../../session-runtime/provider-request-tools.mjs';

export async function prepareProviderRequest(state) {
  const {
    provider,
    messages,
    model,
    baseSendTools,
    sessionRef,
    sessionId,
    cwd,
    opts,
    signal,
    loopUsageMetricsTurnId,
    loopUsageMetricsEpoch,
  } = state;
  let { iterations, lastUsage, firstTurnUsage, providerState, reactiveOverflowRetryPending, fixedProviderToolSurface } =
    state;
  let providerStateCleared = false;
  // A soft compact target may remain above an explicit trigger: never
  // compact the same input twice before a provider attempt.
  let compactAttempted = false;
  let compactChanged;
  let sendTools;
  let requestToolScope;
  refreshDeferredMcpToolCatalog(sessionRef);
  do {
    // Provider-history normalization is part of the request boundary:
    // repair first, then take exactly one immutable tool snapshot.
    const messagesBeforeTranscriptRepair = messages.slice();
    repairTranscriptBeforeProviderSend(messages, sessionId);
    if (!opts.cacheBreakIntent && messagesArrayChanged(messagesBeforeTranscriptRepair, messages)) {
      opts.cacheBreakIntent = 'transcript_rebuild';
    }
    const candidateSendTools = snapshotProviderRequestTools({
      provider: sessionRef?.provider || provider?.name,
      tools: baseSendTools,
      nativeTools: opts.nativeTools,
      messages,
      session: sessionRef,
    });
    // Preserve the eager prefix, but adopt additions, schema updates and
    // removals of deferred/MCP definitions between model requests.
    const isDynamicTool = (tool) =>
      tool.deferLoading === true || tool.defer_loading === true || String(tool.name || '').startsWith('mcp__');
    const dynamicTools = (list) => list.slice(providerNativeToolPrefixCount(list)).filter(isDynamicTool);
    const dynamicToolsChanged =
      fixedProviderToolSurface &&
      JSON.stringify(dynamicTools(candidateSendTools)) !== JSON.stringify(dynamicTools(fixedProviderToolSurface));
    if (!fixedProviderToolSurface) {
      fixedProviderToolSurface = candidateSendTools;
    } else if (dynamicToolsChanged) {
      const replacements = new Map(dynamicTools(candidateSendTools).map((tool) => [tool.name, tool]));
      const nativePrefixCount = providerNativeToolPrefixCount(fixedProviderToolSurface);
      const merged = fixedProviderToolSurface.flatMap((tool, index) => {
        if (index < nativePrefixCount || !isDynamicTool(tool)) return [tool];
        const replacement = replacements.get(tool.name);
        replacements.delete(tool.name);
        return replacement ? [replacement] : [];
      });
      merged.push(...replacements.values());
      fixedProviderToolSurface = finalizeProviderRequestTools(merged, nativePrefixCount);
    }
    sendTools = fixedProviderToolSurface;
    requestToolScope = {
      session: sessionRef,
      provider: sessionRef?.provider || provider?.name,
      messages,
      requestTools: sendTools,
      nativePrefixCount: providerNativeToolPrefixCount(sendTools),
    };
    const pass = await runWithProviderRequestToolsScope(requestToolScope, () =>
      runPreSendCompactPass({
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
      })
    );
    ({ iterations, lastUsage, firstTurnUsage, providerState, reactiveOverflowRetryPending, compactChanged } = pass);
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
