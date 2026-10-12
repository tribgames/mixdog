/**
 * The effort the runtime resolved for the turn in flight: the newest message of
 * the current turn carrying `meta.effortConfiguration.effort` — a step-judged
 * tool result (step-auto-effort.mjs markStepEffort) or, before any step, the
 * turn's own user message (prepareTurnEffortConfiguration). Null when the
 * turn has no recorded value (auto effort off, or a model without it).
 */
export function currentTurnEffort(session) {
  const live = Array.isArray(session?.liveTurnMessages) ? session.liveTurnMessages : session?.messages;
  if (!Array.isArray(live)) return null;
  for (let i = live.length - 1; i >= 0; i--) {
    const message = live[i];
    const effort = message?.meta?.effortConfiguration?.effort;
    if (typeof effort === 'string' && effort) return effort;
    if (message?.role === 'user') return null;
  }
  return null;
}
