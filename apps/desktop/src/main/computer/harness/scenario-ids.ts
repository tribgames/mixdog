// The harness declares its scenarios imperatively, interleaved with fixture
// setup, so the ids a run may select are only knowable from this list before
// any work starts. `runScenario` refuses to declare an id that is missing
// here, which keeps the list and the harness in step.
const DECLARED_SCENARIO_IDS =
  'S01 S02 S03 S04 S05 S06 S07 S08 S09 S10 S11 S12 S13 S14 S15 S16 S17 S18 S19 S20 S21 S22 ' +
  'S23 S24 S25 S26 S27 S28 S29 S30 S31 S32 S33 S34 S35 S36 S37 S38 S39 S40 S41 S42 S43 S44';

export const SCENARIO_IDS: readonly string[] = Object.freeze(DECLARED_SCENARIO_IDS.split(' '));

/** Selected `--only` ids that no scenario declares, in the order they were selected. */
export function unknownScenarioIds(selected: Iterable<string>): string[] {
  const declared = new Set(SCENARIO_IDS);
  return [...new Set(selected)].filter((id) => !declared.has(id));
}
