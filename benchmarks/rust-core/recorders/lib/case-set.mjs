// Plumbing shared by the per-test-file case recorders (K1 uncovered rows): the Node tree, the staged fixture set, a case
// list and the manifest. A recorder calls `openSet`, runs its cases with `set.run(name, async () => observed)` and ends with
// `await set.finish({ entry, replay, ...})`. A case that throws is recorded as `{ threw: {name, message, code} }` (Node's own
// outcome), never skipped.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest, writeText } from './common.mjs';
import { recorderProvenance } from './provenance.mjs';

export const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';

// Date.now is held at this value for the whole run (a row's at, a stamped time): declared in golden.json as clock.
export const FIXED_NOW = 1_800_000_000_000;

export function openSet(setName, recorderUrl, { clock = true } = {}) {
  if (clock) Date.now = () => FIXED_NOW;
  const clockHeld = clock;
  const args = parseArgs();
  const tree = resolveTree(args);
  const finalDir = join(FIXTURES_ROOT, setName);
  const stage = stageSet(finalDir);
  const cases = [];
  const files = new Map();
  const recorder = recorderProvenance(recorderUrl).recorder;
  const set = {
    args, tree, stage, cases, files,
    load: (rel) => importFrom(tree, rel),
    /** Runs one case; `fn` returns what the test asserted on. */
    async run(name, fn, extra = {}) {
      let observed;
      try {
        observed = await fn();
      } catch (e) {
        observed = { threw: { name: e?.name ?? null, message: String(e?.message ?? e), code: e?.code ?? null } };
      }
      cases.push({ case: name, ...extra, observed });
    },
    file(name, text) { files.set(name, text); },
    async finish({ golden = {}, entry, replay, exclusions = {}, replaceInText = [], dataFiles = [] }) {
      const identity = exactProductIdentity(tree, COMMIT);
      writeJson(join(stage, 'golden.json'), { ...(clockHeld ? { clock: { dateNow: FIXED_NOW, note: 'Date.now was held at this value for the whole recording' } } : {}), ...golden, cases });
      for (const [name, text] of files) writeText(join(stage, name), text);
      if (replaceInText.length) {
        const path = join(stage, 'golden.json');
        let text = readFileSync(path, 'utf8');
        for (const [from, to] of replaceInText) text = text.replaceAll(from, to).replaceAll(from.replaceAll('\\', '\\\\'), to);
        writeFileSync(path, text);
      }
      writeSetManifest(stage, {
        set: setName, recorder, command: `node ${recorder} --tree <export of ${COMMIT} with node_modules>`, identity,
        extra: { ...recorderProvenance(recorderUrl, dataFiles), cases: cases.length, entry, replay, exclusions },
      });
      commitStage(stage, finalDir);
      console.log(`${setName}: ${cases.length} cases`);
    },
  };
  return set;
}
