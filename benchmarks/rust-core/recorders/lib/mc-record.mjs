// Shared frame of the memory + channels recorders: the exact Node export (b6f10295a), the fixture set directory, and the
// manifest every set carries. One golden file per set holds the cases in the order the Node test file lists them.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, orderedStringify, parseArgs, resolveTree, stageSet, writeSetManifest, writeText, within } from './common.mjs';
import { recorderProvenance } from './provenance.mjs';

// Local-time formatting in recalled text depends on the PC's zone: every recording of this family runs in UTC (an input of
// the recording, stated in each manifest's `normalised`).
process.env.TZ = 'UTC';

export const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
export { importFrom, within };

/** The virtual clock: `Date.now()` and `new Date()` stand still at `ms` for the whole run (every step of it is an input of the recording). */
export function freezeClock(ms) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(ms);
      else super(...args);
    }

    static now() {
      return ms;
    }
  };
}

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
  // Random UUIDs (index revisions) are named by order of first appearance in the file, so two recordings are byte-identical.
  const seen = new Map();
  const goldenText = orderedStringify(golden).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (uuid) => {
    if (!seen.has(uuid)) seen.set(uuid, `<uuid-${seen.size + 1}>`);
    return seen.get(uuid);
  });
  writeText(join(stage, 'golden.json'), goldenText);
  for (const [name, text] of Object.entries(files)) writeText(join(stage, name), text);
  const provenance = recorderProvenance(url);
  writeSetManifest(stage, {
    set,
    recorder: provenance.recorder,
    command: `node ${flags}${provenance.recorder} --tree <git archive of ${NODE_COMMIT} with node_modules>`.replace('  ', ' '),
    identity: ctx.identity,
    extra: { ...provenance, ...extra, uuidsNormalised: seen.size ? `golden.json: ${seen.size} random UUIDs, each written as <uuid-N> by order of first appearance (the same UUID is the same label everywhere)` : 'none',
      timezone: 'UTC (process.env.TZ set by lib/mc-record.mjs before any date formatting: local-time text in a recording is UTC)' },
  });
  commitStage(stage, final);
  console.log(`${set}: recorded ${Array.isArray(golden.cases) ? golden.cases.length : Object.keys(golden.cases ?? {}).length} cases`);
}
