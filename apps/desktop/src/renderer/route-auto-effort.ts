/** Explicit two-state Auto reasoning flag (`effortAuto`):
 *  - `true` = Auto reasoning
 *  - `false` = manual level chosen
 *  - `undefined` = absent (never coerced to `true`; converted once on load from legacy `autoEffort`). */
export type EffortAutoState = boolean | undefined;

export function readEffortAuto(value: unknown): EffortAutoState {
  return typeof value === 'boolean' ? value : undefined;
}

/** The ONE legacy conversion: where `effortAuto` is absent on pre-update data,
 *  old switch ON and old `autoEffort !== false` becomes Auto (`true`), else Manual (`false`). */
export function convertLegacyAutoEffort(oldAutoEffort: unknown, legacySwitchOn: boolean): boolean {
  return legacySwitchOn && oldAutoEffort !== false;
}

/** Resolve a stored route's `effortAuto` on load: explicit `effortAuto` wins;
 *  otherwise run the ONE legacy conversion from `autoEffort` + `legacySwitchOn`. */
export function resolveEffortAuto(
  route: { effortAuto?: unknown; autoEffort?: unknown } | null | undefined,
  legacySwitchOn: boolean
): boolean {
  const explicit = readEffortAuto(route?.effortAuto);
  if (explicit !== undefined) return explicit;
  return convertLegacyAutoEffort(route?.autoEffort, legacySwitchOn);
}

/** Whether a stored route has not yet been converted to `effortAuto` or still
 *  carries the legacy `autoEffort` key. */
export function needsLegacyAutoEffortConversion(
  route: { effortAuto?: unknown; autoEffort?: unknown } | null | undefined
): boolean {
  if (!route || typeof route !== 'object') return false;
  return readEffortAuto(route.effortAuto) === undefined || Object.hasOwn(route, 'autoEffort');
}

/** First explicit boolean wins; all absent stays absent (`undefined`). */
export function pickEffortAuto(...candidates: unknown[]): EffortAutoState {
  for (const candidate of candidates) {
    if (typeof candidate === 'boolean') return candidate;
  }
  return undefined;
}

/** Route payload field for an explicit `effortAuto` choice; absent is omitted. */
export function effortAutoField(
  state: unknown,
  capable = true
): { effortAuto: boolean } | Record<string, never> {
  if (!capable) return {};
  const explicit = readEffortAuto(state);
  return explicit === undefined ? {} : { effortAuto: explicit };
}

/** Merge two live views of the same agent's explicit flag: when both carry an
 *  explicit boolean, `false` wins; otherwise the explicit state survives. */
export function mergeEffortAuto(current: unknown, next: unknown): EffortAutoState {
  const left = readEffortAuto(current);
  const right = readEffortAuto(next);
  if (left !== undefined && right !== undefined) return left && right;
  return left ?? right;
}

/** Key segment distinguishing explicit `true`, explicit `false`, and absent. */
export function effortAutoKey(value: unknown): '' | '0' | '1' {
  const state = readEffortAuto(value);
  return state === true ? '1' : state === false ? '0' : '';
}
