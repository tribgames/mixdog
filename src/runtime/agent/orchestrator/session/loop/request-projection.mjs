// Wire projection for one provider request: the stored transcript is projected
// into the exact message array the provider sees, and that same array is what
// the prefix guard classifies. Extracted from agentLoop so the loop body wires
// state instead of owning three projection passes plus their telemetry.
import { projectSyntheticUserEnvelopes } from '../synthetic-user-envelope.mjs';
import { projectProviderEvidence } from '../evidence-union.mjs';
import { prepareProviderPrefixGuard } from '../provider-prefix-guard.mjs';
import { appendAgentTrace } from '../../agent-trace.mjs';
import { traceCacheBreak } from '../../cache-break-trace.mjs';
import { envFlag } from '../../../../shared/env.mjs';

// Cache-break rows repeat verbatim across retries of the same request; the
// key set is owned by the loop so one transition is traced once per turn.
function cacheBreakTracer({ sessionId, iteration, opts, tracedKeys }) {
    return (details) => {
        const key = [
            details.classification,
            details.reason,
            details.index,
            details.previousHash,
            details.nextHash,
            details.previousRequestPrefixHash,
            details.nextRequestPrefixHash,
        ].join('|');
        if (tracedKeys.has(key)) return;
        tracedKeys.add(key);
        traceCacheBreak({
            sessionId,
            iteration,
            intentionalTransition: opts.cacheBreakIntent,
            ...details,
        });
    };
}

function traceEvidenceProjection({ sessionId, iteration, stats, shadow }) {
    if (!(stats.reusedRows > 0 || stats.exactResultRefs > 0 || stats.pathAliases > 0)) return;
    const payload = {
        shadow,
        before_bytes: stats.beforeBytes,
        after_bytes: stats.afterBytes,
        evidence_rows: stats.evidenceRows,
        reused_rows: stats.reusedRows,
        reference_groups: stats.referenceGroups,
        changed_tool_results: stats.changedToolResults,
        exact_result_refs: stats.exactResultRefs,
        exact_result_bytes_saved: stats.exactResultBytesSaved,
        path_facts: stats.pathFacts,
        path_aliases: stats.pathAliases,
        reused_path_facts: stats.reusedPathFacts,
        path_alias_bytes_saved: stats.pathAliasBytesSaved,
    };
    try {
        appendAgentTrace({ sessionId, iteration, kind: 'evidence_union', ...payload, payload });
    } catch { /* best-effort telemetry */ }
}

export function projectProviderRequest({
    messages, sendTools, opts, provider, sessionRef, sessionId, model, iteration,
    prefixGuardState, cacheBreakTraceKeys,
}) {
    // Wire-only: synthetic user rows (compaction state, runtime control,
    // injected context) get the declared runtime envelope so the human's own
    // prompt stays the only unwrapped user voice. The stored transcript and
    // recoveryMessages keep the raw rows.
    const envelopeProjection = projectSyntheticUserEnvelopes(messages);
    const shadow = envFlag('MIXDOG_EVIDENCE_UNION_SHADOW');
    const evidenceProjection = projectProviderEvidence(envelopeProjection.messages, {
        enabled: !envFlag('MIXDOG_DISABLE_EVIDENCE_UNION'),
        apply: !shadow,
        // Path aliases are a whole-history projection: a later repeated path
        // can rewrite already-sent tool results and invalidate every provider's
        // prefix cache. Row/exact-result references are append-only, so retain
        // those and disable only the unsafe pass.
        pathAliases: false,
    });
    const mutationSource = opts.cacheBreakIntent === 'transcript_rebuild'
        ? 'transcript_rebuild'
        : (evidenceProjection.stats.changedToolResults > 0 ? 'evidence_union' : null);
    const prefixGuardCandidate = prepareProviderPrefixGuard(
        prefixGuardState,
        evidenceProjection.messages,
        {
            tools: sendTools,
            nativeTools: Array.isArray(opts.nativeTools) ? opts.nativeTools : [],
        },
        {
            provider: sessionRef?.provider || provider?.name || null,
            model: model || null,
            cacheBreakIntent: opts.cacheBreakIntent,
            mutationSource,
            onCacheBreak: cacheBreakTracer({
                sessionId, iteration, opts, tracedKeys: cacheBreakTraceKeys,
            }),
        },
    );
    traceEvidenceProjection({ sessionId, iteration, stats: evidenceProjection.stats, shadow });
    return { providerMessages: evidenceProjection.messages, prefixGuardCandidate };
}
