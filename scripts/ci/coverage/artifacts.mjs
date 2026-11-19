// The one naming of everything a gate call produces or consumes as a run artifact (docs/testing.md, "Release coverage"). Two calls of the
// gate in one run (a deploy's native-assets gate and the release gate it calls) must never share an artifact, so every name carries the
// kind, the caller's gate name and the SHA: `<kind>-<gate>-<sha>[-<detail>]`. The workflows spell it with
// `artifactTemplate` (release-gate.yml's env GATE_KEY is `<gate>-<sha>`); the reader below spells it with `artifactName`; a local test
// checks that every upload and download of the gate's workflows is one of these templates.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const KINDS = ['coverage-manifest', 'coverage-inventory-errors', 'evidence', 'rust-lists', 'core-tests', 'mixdogd-dev', 'desktop-out'];

/** The artifact name of a gate call. */
export const artifactName = (kind, { gate, sha, detail }) => [kind, `${gate}-${sha}`, detail].filter((part) => part !== undefined).join('-');

/** The same name as the workflows write it, with the expressions of the gate workflow in place of the values. */
export const artifactTemplate = (kind, detail) => artifactName(kind, { gate: '${{ inputs.gate }}', sha: '${{ inputs.ref || github.sha }}', detail }).replace('${{ inputs.gate }}-${{ inputs.ref || github.sha }}', '${{ env.GATE_KEY }}');

/**
 * The nextest listings of every build variant, from the folder the download left: one folder per variant artifact, holding exactly the
 * `all` listing, one listing per profile the plan names for the variant, and the binding that says which invocation made them.
 * @returns {{ lists: object, problems: string[] }} a missing or malformed folder is a problem, never skipped
 */
export function loadRustLists(dir, plan, call) {
  const lists = {};
  const problems = [];
  for (const variant of plan.rust?.variants ?? []) {
    const folder = join(dir, artifactName('rust-lists', { ...call, detail: variant.name }));
    try {
      const wanted = ['all.json', 'binding.json', ...Object.keys(variant.profileLegs ?? {}).map((profile) => `${profile}.json`)].sort();
      const found = readdirSync(folder).sort();
      if (JSON.stringify(found) !== JSON.stringify(wanted)) throw new Error(`holds ${found.join(', ') || 'nothing'}, the plan names ${wanted.join(', ')}`);
      const read = (name) => JSON.parse(readFileSync(join(folder, name), 'utf8'));
      const binding = read('binding.json');
      const leg = variant.listLeg.split('#')[0];
      if (binding.leg !== leg || binding.sha !== call.sha) throw new Error(`was made by ${binding.leg} at ${binding.sha}, the plan's list leg is ${leg} at ${call.sha}`);
      lists[variant.name] = { all: read('all.json'), profiles: Object.fromEntries(Object.keys(variant.profileLegs ?? {}).map((profile) => [profile, read(`${profile}.json`)])) };
    } catch (error) {
      problems.push(`the listings of build variant ${variant.name} (${folder}): ${error.message}`);
    }
  }
  return { lists, problems };
}
