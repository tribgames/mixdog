// What made a recording, computed instead of listed by hand: the recorder, every local module it loads (followed
// through static imports, dynamic imports and require, to any depth) and the Node that ran it. A manifest written
// from this passes the check that every module the recorder loads is listed with its sha256
// (D:\mixdog-build\tools\manifest-check.mjs follows the same specifiers); hand-kept lists kept missing a helper.
//
// Usage, in a recorder:
//   import { recorderProvenance } from './lib/provenance.mjs';
//   writeSetManifest(dir, { ..., extra: { ...recorderProvenance(import.meta.url), exclusions } });
// Data files the recorder reads (not modules) go in `inputs` of the call: recorderProvenance(import.meta.url, ['x.json']).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;

const sha256 = (path) => createHash('sha256').update(readFileSync(join(REPO_ROOT, path))).digest('hex');

function closure(file, seen = new Set()) {
  if (seen.has(file) || !/\.[cm]?js$/i.test(file)) return seen;
  seen.add(file);
  for (const match of readFileSync(join(REPO_ROOT, file), 'utf8').matchAll(SPECIFIER)) {
    const target = posix.normalize(posix.join(posix.dirname(file), match[1]));
    if (existsSync(join(REPO_ROOT, target))) closure(target, seen);
  }
  return seen;
}

/**
 * `{ recorder, recorderSha256, nodeVersion, inputs }` for the recorder at `recorderUrl` (its `import.meta.url`):
 * `inputs` lists every other local module it loads and each of `dataFiles` (repository-relative), by sha256, sorted.
 */
export function recorderProvenance(recorderUrl, dataFiles = []) {
  const recorder = relative(REPO_ROOT, fileURLToPath(recorderUrl)).split(sep).join('/');
  const modules = [...closure(recorder)].filter((file) => file !== recorder);
  const inputs = [...new Set([...modules, ...dataFiles.map((file) => file.replaceAll('\\', '/'))])].sort();
  return {
    recorder,
    recorderSha256: sha256(recorder),
    nodeVersion: process.version,
    inputs: inputs.map((path) => ({ path, sha256: sha256(path) })),
  };
}
