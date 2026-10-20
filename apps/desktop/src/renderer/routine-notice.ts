// A schedule's or webhook's result line in its agent's home thread, in the
// user's language: the transcript notice row and the contact preview read it
// the same way.
import { routineHumanNeeded } from '../../../../src/runtime/agent/orchestrator/session/routine-result.mjs';
import type { RoutineProvenance } from '../shared/contract';
import { t } from './i18n';

/** A run that stopped for a person (routine-result.mjs), in the user's
 *  language: "<site> needs you to sign in" and its kin; null for any other. */
export function routineHumanNeededLine(summary: unknown): string | null {
  const needed = routineHumanNeeded(summary);
  if (!needed) return null;
  const { site } = needed;
  if (needed.outcome === 'login_required') return t('{{site}} needs you to sign in', { site });
  if (needed.outcome === 'sensitive_confirmation_required') {
    return t('{{site}} has something you need to confirm yourself', { site });
  }
  return t('{{site}} has a step you need to do yourself', { site });
}

/** A failed run's short reason in the user's language, from the failure class
 *  the runtime stored; a step that needs a person reads
 *  as such, and an unclassified failure gets the generic line. The raw
 *  message is never the headline. */
export function routineFailureLine(summary: unknown, reason?: unknown, paused?: unknown): string {
  const line = (() => {
    const needed = routineHumanNeededLine(summary);
    if (needed) return needed;
    switch (reason) {
      case 'provider_unavailable':
        return t("The model or provider isn't available. Pick another in model settings.");
      case 'auth_expired':
        return t('The sign-in has expired. Sign in again in provider settings.');
      case 'rate_limited':
        return t('The usage limit was reached. Try again later or switch models.');
      case 'network':
        return t('The network connection failed or timed out. Check the connection and run again.');
      case 'permission_denied':
        return t('A tool was denied permission. Check the permission settings.');
      case 'cancelled':
        return t('The run was cancelled.');
      default:
        return t('A problem occurred during the run.');
    }
  })();
  return paused === true
    ? `${line} ${t('This routine was turned off after repeated failures. Turn it back on in the Routines tab.')}`
    : line;
}

/** A failed run's detail line. */
function failureText(summary: string, reason?: unknown, paused?: unknown): string {
  return routineFailureLine(summary, reason, paused);
}

/** A routine result (routine-result.mjs) as display text; null for every other notice. */
export function routineNoticeText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, name, status, summary, omitted, reason, paused } = value as {
    kind?: unknown;
    name?: unknown;
    status?: unknown;
    summary?: unknown;
    omitted?: unknown;
    reason?: unknown;
    paused?: unknown;
  };
  // The thread's result queue was full and dropped its oldest results.
  if (typeof omitted === 'number' && omitted > 0) return `⏱ ${t('Routine results omitted: {{n}}', { n: omitted })}`;
  if (typeof name !== 'string' || !name) return null;
  const text = typeof summary === 'string' ? summary : '';
  const detail = status === 'failed' ? failureText(text, reason, paused) : text;
  const label = kind === 'webhook' ? `🔗 ${t('Webhook')}` : `⏱ ${t('Schedule')}`;
  return `${label} · ${name}${detail ? ` — ${detail}` : ''}`;
}

/** A contact's last line: the routine result its catalog marker
 *  (`lastMessageRoutine`) describes, in the user's language; otherwise the
 *  stored text verbatim, whatever it looks like. */
export function localizedRoutinePreview(value: string, routine?: RoutineProvenance | null): string {
  if (!routine) return value;
  const failed = routine.status === 'failed';
  return (
    routineNoticeText({
      kind: routine.kind,
      name: routine.name,
      status: failed ? 'failed' : 'completed',
      summary: (failed ? routine.error : routine.summary) ?? '',
    }) ?? value
  );
}
