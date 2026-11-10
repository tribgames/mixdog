// Wire projection for one provider request: the stored transcript is projected
// into the exact message array the provider sees, and that same array is what
// the prefix guard classifies, so the loop body wires state instead of owning
// the projection and its cache-break telemetry. Tool results are delivered
// verbatim; stored-history compaction and artifact offload happen elsewhere.
import { projectSyntheticUserEnvelopes } from '../synthetic-user-envelope.mjs';
import { prepareProviderPrefixGuard } from '../provider-prefix-guard.mjs';
import { traceCacheBreak } from '../../cache-break-trace.mjs';

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

export function projectProviderRequest({
  messages,
  sendTools,
  opts,
  provider,
  sessionRef,
  sessionId,
  model,
  iteration,
  prefixGuardState,
  cacheBreakTraceKeys,
}) {
  // Wire-only: synthetic user rows (compaction state, runtime control,
  // injected context) get the declared runtime envelope so the human's own
  // prompt stays the only unwrapped user voice. The stored transcript and
  // recoveryMessages keep the raw rows.
  const providerMessages = projectSyntheticUserEnvelopes(messages).messages;
  const mutationSource = opts.cacheBreakIntent === 'transcript_rebuild' ? 'transcript_rebuild' : null;
  const prefixGuardCandidate = prepareProviderPrefixGuard(
    prefixGuardState,
    providerMessages,
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
        sessionId,
        iteration,
        opts,
        tracedKeys: cacheBreakTraceKeys,
      }),
    }
  );
  return { providerMessages, prefixGuardCandidate };
}
