// The provenance of a recorder that launches scripts of its own as subprocesses: `recorderProvenance` (lib/provenance.mjs) covers the
// recorder and the modules it imports, but a script it only spawns (a case's world.mjs) and what that loads are not imports of it. They are
// added here: each spawned script, its import closure, and every script that one names by a quoted file name beside it (the preload a
// spawned script hands its own child as `--import`), followed the same way, so a change to any of them changes the provenance.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stableStringify } from './common.mjs';
import { recorderProvenance } from './provenance.mjs';

/** The `--only` guard: a partial run keeps the other cases, so it may write only while the scripts and the tree are those that recorded
 *  them (`recorded` is the manifest on disk). */
export function assertSameOrigin(recorded, provenance, identity) {
  if (stableStringify(recorded.provenance) !== stableStringify(provenance) || stableStringify(recorded.product) !== stableStringify(identity)) {
    throw new Error('--only: the scripts or the tree differ from those that recorded the other cases (MANIFEST.json provenance/product); record the whole set in one run');
  }
}

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const SIBLING = /['"]([\w.-]+\.[cm]?js)['"]/g;
const repoPath = (file) => relative(REPO_ROOT, file).split(sep).join('/');

/** `recorderProvenance(recorderUrl)` with `inputs` extended by the closure of each file in `spawned` (absolute paths of the scripts the
 *  recorder launches, the same values it launches them by). */
export function provenanceWithSpawned(recorderUrl, spawned) {
  const base = recorderProvenance(recorderUrl);
  const inputs = new Map(base.inputs.map((input) => [input.path, input.sha256]));
  const seen = new Set();
  const queue = spawned.map(repoPath);
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const own = recorderProvenance(pathToFileURL(join(REPO_ROOT, file)).href);
    inputs.set(file, own.recorderSha256);
    for (const input of own.inputs) {
      inputs.set(input.path, input.sha256);
      queue.push(input.path);
    }
    for (const match of readFileSync(join(REPO_ROOT, file), 'utf8').matchAll(SIBLING)) {
      const sibling = posix.join(posix.dirname(file), match[1]);
      if (existsSync(join(REPO_ROOT, sibling))) queue.push(sibling);
    }
  }
  inputs.delete(base.recorder);
  return { ...base, inputs: [...inputs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, sha256]) => ({ path, sha256 })) };
}
