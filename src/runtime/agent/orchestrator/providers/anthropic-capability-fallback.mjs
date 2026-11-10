/**
 * anthropic-capability-fallback.mjs — the runtime half of the version-floor
 * capabilities (anthropic-thinking-contract.mjs, anthropic-message-threads.mjs).
 * A floor turns a feature on for every later version of a family, so a model
 * that turns out to reject it is switched off for the process and the request
 * is replayed once without it (never after output reached the caller), as
 * mid-conversation effort updates are (effort-configuration.mjs).
 */
import { claudeModelKey } from './anthropic-thinking-contract.mjs';
import { sendWithReplayBeforeOutput } from './lib/replay-before-output.mjs';

// Rejection texts per request feature, in the API's error shapes the effort
// update handles: a field the model does not take ("messages.3.clear_at: Extra
// inputs are not permitted", "thinking.adaptive.display: …") or its beta
// header ("Unexpected value(s) `…` for the `anthropic-beta` header.").
// Threads classify their own errors (anthropic-message-threads.mjs).
const REJECTIONS = {
  progressUpdates: {
    label: 'thinking display "updates"',
    test: (text) => /\bthinking\.(?:adaptive\.)?display\b|thinking-display-updates/i.test(text),
  },
  // A rule about what a turn-scoped message may contain (text blocks only, no
  // output_config or cache_control) shows the model takes it: not a rejection.
  turnScopedSystem: {
    label: 'turn-scoped system message',
    test: (text) =>
      /clear[_-]at|turn-scoped/i.test(text) &&
      !/supports text blocks only|not permitted on a turn-scoped/i.test(text),
  },
};

const unsupported = new Set();
const key = (feature, provider, model) => `${feature}:${provider}:${claudeModelKey(model)}`;

/** False once `model` rejected `feature` on `provider` in this process. */
export function anthropicCapabilityEnabled(feature, provider, model) {
  return !unsupported.has(key(feature, provider, model));
}

export function markAnthropicCapabilityUnsupported(feature, provider, model, label = feature) {
  if (unsupported.has(key(feature, provider, model))) return;
  unsupported.add(key(feature, provider, model));
  if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) {
    process.stderr.write(`[${provider}] ${model} rejected the ${label}; sending without it from now on\n`);
  }
}

/** The floor feature a provider error rejects (`progressUpdates`,
 *  `turnScopedSystem`), or null. */
export function anthropicCapabilityRejection(status, text) {
  if (Number(status) !== 400) return null;
  const message = String(text || '');
  return Object.keys(REJECTIONS).find((feature) => REJECTIONS[feature].test(message)) || null;
}

/**
 * The replay options after a rejected request, or null: switches the rejected
 * feature off for the model and records it on the replay, so each feature is
 * replayed at most once per send.
 */
export function anthropicCapabilityReplay(provider, model, opts, status, text) {
  const feature = anthropicCapabilityRejection(status, text);
  const done = opts?._anthropicCapabilityRetries || [];
  if (!feature || done.includes(feature)) return null;
  markAnthropicCapabilityUnsupported(feature, provider, model, REJECTIONS[feature].label);
  return { ...opts, _anthropicCapabilityRetries: [...done, feature] };
}

/** Runs `send(opts)`; a request whose floor feature got rejected is replayed
 *  once without it, unless output already reached the caller or it was
 *  cancelled. The replay is wrapped again, so a second feature the same model
 *  rejects gets its own single replay. */
export async function withAnthropicCapabilityFallback(provider, model, opts, send) {
  let next = null;
  try {
    return await sendWithReplayBeforeOutput(opts, send, (error) => {
      const status = error?.status ?? error?.httpStatus ?? error?.response?.status;
      next = anthropicCapabilityReplay(provider, model, opts, status, error?.responseBody ?? error?.message);
      return null;
    });
  } catch (error) {
    if (!next) throw error;
    return withAnthropicCapabilityFallback(provider, model, next, send);
  }
}
