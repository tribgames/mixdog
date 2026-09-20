/**
 * after-hook.mjs — the PostToolUse hook: it may override the model-visible
 * result but never the envelope's newMessages channel.
 */
import { normalizeToolEnvelope, makeToolEnvelope } from '../../tool-envelope.mjs';
import { resolveToolResultAfterHook } from '../tool-helpers.mjs';

export async function applyAfterToolHook(result, afterToolHook, { name, args, cwd, callerSessionId, toolCallId }) {
  if (typeof afterToolHook !== 'function') return result;
  try {
    // Tool outcome metadata is runtime-internal. Hooks receive the same
    // model-visible result value they received before transient
    // envelopes existed, never the envelope object itself.
    const { result: visible, newMessages, explicitSuccess, explicitFailure } = normalizeToolEnvelope(result);
    const hookResult = await afterToolHook({
      name,
      args,
      cwd,
      sessionId: callerSessionId,
      toolCallId,
      result: visible,
    });
    // Envelope-aware hook override: a PostToolUse hook may override the
    // model-VISIBLE tool output (the envelope's `result` / stub), but it
    // must NEVER drop the `newMessages` channel. Split first, apply the
    // override to `result` only, then re-wrap so newMessages survive.
    const overridden = resolveToolResultAfterHook(visible, hookResult);
    if (newMessages.length || explicitSuccess || explicitFailure) {
      return makeToolEnvelope(overridden, newMessages, { explicitSuccess, explicitFailure });
    }
    return overridden;
  } catch {
    // PostToolUse hooks are best-effort; never let one break the tool result.
  }
  return result;
}
