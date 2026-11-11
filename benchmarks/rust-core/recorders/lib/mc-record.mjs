// Shared frame of the memory + channels recorders: the exact Node export (b6f10295a), the fixture set directory, and the
// manifest every set carries. One golden file per set holds the cases in the order the Node test file lists them.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest, within } from './common.mjs';
import { recorderProvenance } from './provenance.mjs';

export const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
export { importFrom, within };

/** The tree under test (must be exactly NODE_COMMIT) and its identity. */
export function begin() {
  const tree = resolveTree(parseArgs());
  return { tree, identity: exactProductIdentity(tree, NODE_COMMIT) };
}

/** Writes `<set>/golden.json` and MANIFEST.json. `extra` carries entry, replay, exclusions, normalised (all required). */
export function finish(ctx, { url, set, golden, extra, flags = '' }) {
  for (const key of ['entry', 'replay', 'exclusions', 'normalised']) {
    if (extra[key] === undefined) throw new Error(`${set}: manifest field ${key} missing`);
  }
  const final = join(FIXTURES_ROOT, set);
  const stage = stageSet(final);
  writeJson(join(stage, 'golden.json'), golden);
  const provenance = recorderProvenance(url);
  writeSetManifest(stage, {
    set,
    recorder: provenance.recorder,
    command: `node ${flags}${provenance.recorder} --tree <git archive of ${NODE_COMMIT} with node_modules>`.replace('  ', ' '),
    identity: ctx.identity,
    extra: { ...provenance, ...extra },
  });
  commitStage(stage, final);
  console.log(`${set}: recorded ${Array.isArray(golden.cases) ? golden.cases.length : Object.keys(golden.cases ?? {}).length} cases`);
}
