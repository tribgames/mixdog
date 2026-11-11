// Plumbing shared by the per-test-file case recorders (K1 uncovered rows): the Node tree, the staged fixture set, a case
// list and the manifest. A recorder calls `openSet`, runs its cases with `set.run(name, async () => observed)` and ends with
// `await set.finish({ entry, replay, ...})`. A case that throws is recorded as `{ threw: {name, message, code} }` (Node's own
// outcome (encoded by xact), never skipped. Every observed value is encoded by xact (lib/exact.mjs) the moment n returns it.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest, writeText } from './common.mjs';
import { exact } from './exact.mjs';
import { normalisePaths } from './normalise-paths.mjs';
import { replayFor } from './replay-targets.mjs';
import { recorderProvenance } from './provenance.mjs';

export const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';

// Date.now is held at this value for the whole run (a row's at, a stamped time): declared in golden.json as clock.
export const FIXED_NOW = 1_800_000_000_000;

export function openSet(setName, recorderUrl, { clock = true, classes = {} } = {}) {
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
        observed = exact(await fn(), { path: name, classes });
      } catch (e) {
        if (String(e?.message).startsWith('exact:')) throw e;
        observed = { threw: exact(e, { path: name, classes }) };
      }
      cases.push({ case: name, ...extra, observed });
    },
    file(name, text) { files.set(name, text); },
    async finish({ golden = {}, entry, replay, exclusions = {}, replaceInText = [], replaceRegex = [], dataFiles = [], normaliseReason = 'per-run temp path (or generated name) replaced by a placeholder' }) {
      const identity = exactProductIdentity(tree, COMMIT);
      writeJson(join(stage, 'golden.json'), { ...(clockHeld ? { clock: { dateNow: FIXED_NOW, note: 'Date.now was held at this value for the whole recording' } } : {}), ...golden, cases });
      for (const [name, text] of files) writeText(join(stage, name), text);
      // Normalisation is by string value at JSON paths, and the manifest lists every path it changed with its reason.
      let normalised = [];
      if (replaceInText.length || replaceRegex.length) {
        const path = join(stage, 'golden.json');
        const result = normalisePaths(JSON.parse(readFileSync(path, 'utf8')), { replaceInText, replaceRegex });
        normalised = result.paths;
        writeFileSync(path, JSON.stringify(result.doc, null, 2) + '\n');
      }
      writeSetManifest(stage, {
        set: setName, recorder, command: `node ${process.execArgv.length ? `${process.execArgv.join(" ")} ` : ""}${recorder} --tree <export of ${COMMIT} with node_modules>`, identity,
        extra: { ...recorderProvenance(recorderUrl, dataFiles), cases: cases.length, entry, replay: replayFor(setName, replay), exclusions, values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)', normalised: { reason: normaliseReason, paths: normalised } },
      });
      commitStage(stage, finalDir);
      console.log(`${setName}: ${cases.length} cases`);
    },
  };
  return set;
}
