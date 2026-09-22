/**
 * anthropic-oauth-midstream.mjs — the Anthropic OAuth binding of the shared
 * mid-stream recovery ladder (anthropic-midstream-recovery.mjs): the OAuth log
 * label and owner identities, plus the ttftAt slot the OAuth turn settler
 * fills from midState. The ladder itself reads only the error, the exposure
 * record and the response headers, so it is shared with the API-key provider.
 */
import { createAnthropicMidState, createAnthropicMidstreamRecovery } from './anthropic-midstream-recovery.mjs';

export function createMidState(attemptIndex) {
  return {
    ...createAnthropicMidState(attemptIndex),
    ttftAt: null,
  };
}

/**
 * @param {object} deps
 * @param {number} deps.maxRetries  bounded mid-stream retries for transient stream loss
 * @param {AbortSignal|null} deps.totalSignal
 * @param {ReturnType<import('./anthropic-oauth-recovery.mjs').createAnthropicOAuthRecovery>} deps.recovery
 */
export function createMidstreamRecovery({ maxRetries, totalSignal, recovery }) {
  return createAnthropicMidstreamRecovery({
    label: 'anthropic-oauth',
    outcomeProvider: 'anthropic-oauth',
    midstreamOwner: 'anthropic-oauth-midstream',
    unreachableMessage: 'Anthropic OAuth mid-stream retry: unreachable',
    maxRetries,
    totalSignal,
    recovery,
  });
}
