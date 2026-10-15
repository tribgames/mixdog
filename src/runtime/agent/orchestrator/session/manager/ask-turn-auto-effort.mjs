// Auto effort for one user turn. The Auto effort built-in (Extensions →
// Built-in) turns it `on`: the judged effort applies to this turn. The
// MIXDOG_AUTO_EFFORT env value (off/observe/on) overrides it for diagnostics;
// `observe` judges and logs without applying. Applies to user-written prompts
// and to agent sessions' briefs and Lead follow-ups (not runtime-injected
// turns) on models whose effort can change mid-conversation without
// invalidating the prompt cache, and on custom Chat/Responses routes whose
// model declares effort levels (the effort is sent with each request).
import { readSection } from '../../../../shared/config.mjs';
import { autoEffortModel, turnEffortConfigurationMode } from '../../providers/effort-configuration.mjs';
import {
  autoEffortApplicable,
  autoEffortBase,
  normalizeAutoEffortMode,
  resolveAutoEffort,
} from '../../providers/auto-effort.mjs';
import { builtinFeatureActive } from '../../runtime-core/builtin-features.mjs';
import { effortOptionsFor, warnEmptyAutoEffortLadder } from '../../runtime-core/effort.mjs';
import { effortJudgeSupportsSteps, judgeTurn, recordEffortDecision } from '../../../../effort-judge/judge-client.mjs';
import { promptContentText } from './prompt-utils.mjs';

// Every cache-safe route judges its tool-result steps the same way. Measured
// against fixed high (same tasks, all runs passing): GPT-6.1 Sol output -46% on
// five hard tasks and -26% on eight Terminal-Bench tasks; Claude Opus 5.5 about
// unchanged (+-3%), since it sizes its own thinking regardless of the effort.
// MIXDOG_AUTO_EFFORT_STEPS=off keeps auto effort to the turn's first request
// (no per-step judgment), e.g. to compare the two in a benchmark.
export function autoEffortStepsEnabled() {
  return (
    String(process.env.MIXDOG_AUTO_EFFORT_STEPS || '')
      .trim()
      .toLowerCase() !== 'off'
  );
}

/** `{ request, base }` when each tool-result step of this turn is judged
 *  (session/loop/step-auto-effort.mjs): auto effort is on for the turn, the
 *  route has an effort configuration (a mid-conversation update route, or a
 *  custom Chat/Responses route whose model declares levels), and the installed
 *  judge was trained on steps. Otherwise null. */
export function turnStepAutoEffort(autoEffort, effortConfiguration) {
  return autoEffort?.mode === 'on' && effortConfiguration && autoEffortStepsEnabled() && effortJudgeSupportsSteps()
    ? { request: autoEffort.request, base: autoEffort.base }
    : null;
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
 * turn, or null when auto effort does not apply. The judge delays a turn only
 * briefly (its first-use load is the longest wait): a missing, still-loading,
 * or slow model yields null and the default effort.
 */
export async function resolveTurnAutoEffort({ sessionId, session, provider, input }) {
  const mode = autoEffortMode();
  // promptSource marks runtime-injected turns (completion notices, queued work).
  // Agent sessions are judged like any other: their spawn brief and later Lead
  // `send` messages arrive as plain prompts.
  if (mode === 'off' || input?.promptSource) return null;
  // The session's route turned Auto effort off: its chosen effort stands.
  if (session?.autoEffort === false) return null;
  const request = promptContentText(input?.prompt).trim();
  // Skill bodies and runtime blocks arrive as tagged text, not as a request.
  if (!request || request.startsWith('<')) return null;
  if (!turnEffortConfigurationMode(session, provider)) return null;
  const chosen = String(session.effort || '').toLowerCase();
  const base = autoEffortBase(chosen);
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
  const options = effortOptionsFor(session.provider, autoEffortModel(session.provider, provider, session.model));
  // No judged outcome can apply when the base is off the model's ladder, so
  // the judge is not asked (in observe mode too: nothing would be logged).
  if (!autoEffortApplicable({ base, options })) {
    recordEffortDecision({ ...record, skipped: 'default-outside-auto-range' });
    warnEmptyAutoEffortLadder(session.provider, session.model, base);
    return null;
  }
  // The previous user request shows the work a short follow-up continues.
  const judged = await judgeTurn({
    request,
    prev: lastText(session.messages, 'assistant'),
    prevRequest: lastText(session.messages, 'user'),
  });
  if (!judged.probs) {
    recordEffortDecision({ ...record, skipped: judged.skipped });
    return null;
  }
  const resolved = resolveAutoEffort({ base, options, probs: judged.probs });
  recordEffortDecision({
    ...record,
    ...(resolved || { skipped: 'default-outside-auto-range' }),
    ms: judged.ms,
    probs: judged.probs.map((value) => Number(value.toFixed(3))),
  });
  if (!resolved) return null;
  return { ...resolved, applied: mode === 'on' && resolved.effort !== chosen, mode, request };
}
