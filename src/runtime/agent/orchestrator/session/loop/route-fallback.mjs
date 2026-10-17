import { canFallbackRoute } from '../../../../shared/model-route-fallback.mjs';
import { getProvider, initProviders } from '../../providers/registry.mjs';
import { loadConfig } from '../../config.mjs';
import { ensureProviderEnabled } from '../../runtime-core/config-helpers.mjs';
import { updateSessionRoute } from '../manager/session-lifecycle.mjs';
import { pinSessionWireRoute } from '../../providers/wire-route.mjs';
import { buildRequestSendOptions } from '../manager/ask-turn-loop-options.mjs';
import { prepareTurnEffortConfiguration } from '../../providers/effort-configuration.mjs';
import { resolveSessionContextMeta } from '../manager/context-meta.mjs';

export async function advanceAgentRoute(state, error) {
  const session = state.sessionRef;
  const index = session?.routeFallbackIndex || 0;
  const next = session?.routeFallbacks?.[index];
  const committed = state.toolCallsTotal > 0 || state.response != null;
  if (!session?.agent || !next || !canFallbackRoute(error, { signal: state.signal, committed })) return false;
  state.throwIfAborted();
  const config = ensureProviderEnabled(loadConfig(), next.provider);
  await initProviders(config.providers, { signal: state.signal });
  state.throwIfAborted();
  const provider = getProvider(next.provider);
  if (!provider) throw new Error(`Provider "${next.provider}" not available`);
  const oldOptions = buildRequestSendOptions({
    sessionId: state.sessionId,
    session,
    signal: state.signal,
  });
  const updated = updateSessionRoute(
    session.id,
    {
      ...next,
      effort: next.effort || null,
      fast: next.fast === true,
      autoEffort: next.autoEffort !== false,
      modelParameters: next.modelParameters || {},
      contextPercent: next.contextPercent,
      contextTokens: next.contextTokens,
      selectedContextWindow: resolveSessionContextMeta(provider, next.model, next).rawContextWindow,
    },
    { crossProvider: true }
  );
  if (!updated) throw new Error('agent session closed during model fallback');
  updated.routeFallbackIndex = index + 1;
  await pinSessionWireRoute(updated, provider);
  state.throwIfAborted();
  state.messages.splice(0, state.messages.length, ...updated.messages);
  updated.liveTurnMessages = state.messages;
  state.sessionRef = updated;
  state.provider = provider;
  state.model = updated.model;
  state.tools = updated.tools;
  state.providerState = undefined;
  state.providerStateUpdated = true;
  state.prefixGuardState = null;
  state.fixedProviderToolSurface = null;
  state.cacheBreakTraceKeys.clear();
  state.transportRetriesUsed = 0;
  state.transportRetryMax = 0;
  for (const key of Object.keys(oldOptions)) delete state.opts[key];
  Object.assign(
    state.opts,
    buildRequestSendOptions({
      sessionId: state.sessionId,
      session: updated,
      turnEffort: updated.effort,
      effortConfiguration: prepareTurnEffortConfiguration(updated, provider),
      signal: state.signal,
    })
  );
  state.opts.onStageChange?.('connecting', {
    provider: updated.provider,
    model: updated.model,
    reason: 'model-fallback',
  });
  return true;
}
