// Auto effort for one user turn. The Auto effort built-in (Extensions →
// Built-in) turns it `on`: the judged effort applies to this turn. The
// MIXDOG_AUTO_EFFORT env value (off/observe/on) overrides it for diagnostics;
// `observe` judges and logs without applying. Applies only to user-written
// prompts on models whose effort can change mid-conversation without
// invalidating the prompt cache.
import { readSection } from '../../../../shared/config.mjs';
import { effortConfigurationMode } from '../../providers/effort-configuration.mjs';
import { autoEffortBase, normalizeAutoEffortMode, resolveAutoEffort } from '../../providers/auto-effort.mjs';
import { builtinFeatureActive } from '../../runtime-core/builtin-features.mjs';
import { effortOptionsFor } from '../../runtime-core/effort.mjs';
import { judgeTurn, recordEffortDecision } from '../../../../effort-judge/judge-client.mjs';
import { promptContentText } from './prompt-utils.mjs';

// Per-step auto effort applies where a lower step effort actually shortens
// the model's reasoning. Measured with the step judge against fixed high
// (same tasks, all runs passing): GPT-6.1 Sol output -46% on five hard tasks
// and -26% on eight Terminal-Bench tasks; Claude Opus 5.5 unchanged (+-3%),
// since it sizes its own thinking regardless of the requested effort. So the
// OpenAI Responses route judges steps and the Anthropic route keeps the turn's
// effort for the whole turn.
const STEP_AUTO_MODES = new Set(['responses']);

// MIXDOG_AUTO_EFFORT_STEPS=off keeps auto effort to the turn's first request
// (no per-step judgment), e.g. to compare the two in a benchmark; `on` also
// judges steps on routes outside STEP_AUTO_MODES (measurement only).
export function autoEffortStepsEnabled(configurationMode) {
  const env = String(process.env.MIXDOG_AUTO_EFFORT_STEPS || '').trim().toLowerCase();
  if (env === 'off') return false;
  return env === 'on' || STEP_AUTO_MODES.has(configurationMode);
}

export function autoEffortMode() {
  if (process.env.MIXDOG_AUTO_EFFORT) return normalizeAutoEffortMode(process.env.MIXDOG_AUTO_EFFORT);
  try {
    return builtinFeatureActive(readSection('agent'), 'autoEffort') ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

function lastText(messages, role) {
  for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== role) continue;
    const text = promptContentText(message.content).trim();
    if (text) return text;
  }
  return '';
}

/**
 * `{ base, effort, step, level, confidence, applied, mode, request }` for this
 * turn, or null when auto effort does not apply. The judge never delays the
 * turn: a missing, warming, or slow model yields null and the default effort.
 */
export async function resolveTurnAutoEffort({ sessionId, session, provider, input }) {
  const mode = autoEffortMode();
  // promptSource marks runtime-injected turns (completion notices, queued work);
  // agent-owned sessions (workers, maintenance) receive runtime-written briefs.
  if (mode === 'off' || input?.promptSource || session?.owner === 'agent') return null;
  const request = promptContentText(input?.prompt).trim();
  // Skill bodies and runtime blocks arrive as tagged text, not as a request.
  if (!request || request.startsWith('<')) return null;
  const opts = { ...(provider?.config || {}), modelParameters: session.modelParameters || {} };
  if (!effortConfigurationMode(session.provider, session.model, opts)) return null;
  const chosen = String(session.effort || '').toLowerCase();
  const base = autoEffortBase(chosen);
  // The previous user request shows the work a short follow-up continues.
  const judged = await judgeTurn({
    request,
    prev: lastText(session.messages, 'assistant'),
    prevRequest: lastText(session.messages, 'user'),
  });
  const record = {
    at: new Date().toISOString(),
    sessionId,
    provider: session.provider,
    model: session.model,
    mode,
    chosen,
    base,
    requestChars: request.length,
  };
  if (!judged.probs) {
    recordEffortDecision({ ...record, skipped: judged.skipped });
    return null;
  }
  const resolved = resolveAutoEffort({
    base,
    options: effortOptionsFor(session.provider, { id: session.model }),
    probs: judged.probs,
  });
  recordEffortDecision({
    ...record,
    ...(resolved || { skipped: 'default-outside-auto-range' }),
    ms: judged.ms,
    probs: judged.probs.map((value) => Number(value.toFixed(3))),
  });
  if (!resolved) return null;
  return { ...resolved, applied: mode === 'on' && resolved.effort !== chosen, mode, request };
}
