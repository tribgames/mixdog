// Shared frame of the memory + channels recorders: the exact Node export (b6f10295a), the fixture set directory, and the
// manifest every set carries. One golden file per set holds the cases in the order the Node test file lists them.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest, writeText, within } from './common.mjs';
import { recorderProvenance } from './provenance.mjs';

export const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
export { importFrom, within };

/** JSON-safe copy of a value: what JSON cannot hold is written as a tagged object (NaN, infinities, undefined, bigint, Set, Map). */
export function plain(value) {
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
  if (typeof value === 'number' && Object.is(value, -0)) return { $number: '-0' };
  if (typeof value === 'bigint') return { $bigint: String(value) };
  if (value instanceof Set) return { $set: [...value].map(plain) };
  if (value instanceof Map) return { $map: [...value].map(([k, v]) => [plain(k), plain(v)]) };
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

/** Runs `fn`: `{ result }` or `{ error: { name, message, code } }`, the product's own error text. */
export async function capture(fn) {
  try {
    return { result: plain(await fn()) };
  } catch (error) {
    return { error: { name: error?.name ?? null, message: String(error?.message ?? error), code: error?.code ?? null } };
  }
}

/** The tree under test (must be exactly NODE_COMMIT) and its identity. */
export function begin() {
  const tree = resolveTree(parseArgs());
  return { tree, identity: exactProductIdentity(tree, NODE_COMMIT) };
}

/** Writes `<set>/golden.json` and MANIFEST.json. `extra` carries entry, replay, exclusions, normalised (all required). */
export function finish(ctx, { url, set, golden, extra, flags = '', files = {} }) {
  for (const key of ['entry', 'replay', 'exclusions', 'normalised']) {
    if (extra[key] === undefined) throw new Error(`${set}: manifest field ${key} missing`);
  }
  const final = join(FIXTURES_ROOT, set);
  const stage = stageSet(final);
  writeJson(join(stage, 'golden.json'), golden);
  for (const [name, text] of Object.entries(files)) writeText(join(stage, name), text);
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
