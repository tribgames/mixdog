/** Negative text evidence is valid only when the provider completed its read. */
export type VerifyStatus = 'satisfied' | 'unsatisfied' | 'unknown';

export interface VerifyObservation {
  ok: boolean;
  exists: boolean;
  title: string;
  haystack: string;
  textComplete?: boolean;
}

export function evaluateVerifyPredicate(
  predicate: Record<string, unknown>,
  observation: VerifyObservation,
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
