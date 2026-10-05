import scenarioGroups from './scenario-groups.json';

// The harness declares its scenarios imperatively, interleaved with fixture
// setup, so the ids a run may select are only knowable from the group map
// before any work starts. `runScenario` refuses to declare an id that is
// missing here, which keeps the map and the harness in step.
/** Group name → scenario ids; the same file sizes the repeat runner's shards. */
export const SCENARIO_GROUPS: Readonly<Record<string, readonly string[]>> = scenarioGroups;

export const SCENARIO_IDS: readonly string[] = Object.freeze(
  Object.values(SCENARIO_GROUPS)
    .flat()
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))
);

/** Declaration order of a full run. It is not numeric: S30 precedes S29, and the bridge restart (S35) runs last. */
export const SCENARIO_RUN_ORDER: readonly string[] = Object.freeze(
  (
    'S01 S02 S03 S04 S05 S06 S07 S08 S09 S10 S11 S12 S13 S14 S15 S16 S17 S18 S19 S20 S21 S22 S23 S24 S25 S26 S27 S28 ' +
    'S30 S29 S31 S32 S33 S34 S36 S37 S38 S39 S40 S41 S42 S43 S44 S45 S46 S47 S35'
  ).split(' ')
);

/** Selected `--only` ids that no scenario declares, in the order they were selected. */
export function unknownScenarioIds(selected: Iterable<string>): string[] {
  const declared = new Set(SCENARIO_IDS);
  return [...new Set(selected)].filter((id) => !declared.has(id));
}
