/** Negative text evidence is valid only when the provider completed its read. */
export type VerifyStatus = 'satisfied' | 'unsatisfied' | 'unknown';

export interface VerifyObservation {
  ok: boolean;
  exists: boolean;
  title: string;
  haystack: string;
  textComplete?: boolean;
}

/**
 * Why a text predicate could not be decided. `unknown` on its own reads like a
 * flaw in the condition, when the real cause is the read: an element list the
 * provider cut short, or a window that published no text at all. Naming it
 * tells the caller what to change instead of re-running the same wait.
 */
export function verifyUnknownReason(observation: {
  needsElementText: boolean;
  providerError?: string;
  textComplete?: boolean;
  observedElements: number;
}): { reason: string; hint: string } | null {
  if (!observation.needsElementText || observation.providerError || observation.textComplete === true) return null;
  return observation.observedElements > 0
    ? {
        reason: 'element_text_incomplete',
        hint: 'the window published more text than one read returns; narrow the target with window_id, or verify title_contains/window_exists instead',
      }
    : {
        reason: 'element_text_empty',
        hint: 'the window published no element text, which never proves a string is absent; capture the window to see what it exposes',
      };
}

export function evaluateVerifyPredicate(
  predicate: Record<string, unknown>,
  observation: VerifyObservation
): VerifyStatus {
  if (!observation.ok) return 'unknown';
  if (typeof predicate.window_exists === 'boolean') {
    return observation.exists === predicate.window_exists ? 'satisfied' : 'unsatisfied';
  }
  if (!observation.exists) return 'unknown';
  if (typeof predicate.present === 'string') {
    if (observation.haystack.includes(predicate.present.toLowerCase())) return 'satisfied';
    return observation.textComplete === true ? 'unsatisfied' : 'unknown';
  }
  if (typeof predicate.absent === 'string') {
    if (observation.haystack.includes(predicate.absent.toLowerCase())) return 'unsatisfied';
    return observation.textComplete === true ? 'satisfied' : 'unknown';
  }
  if (typeof predicate.title_contains === 'string') {
    return observation.title.toLowerCase().includes(predicate.title_contains.toLowerCase())
      ? 'satisfied'
      : 'unsatisfied';
  }
  return 'unknown';
}
