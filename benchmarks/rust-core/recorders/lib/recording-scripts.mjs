// What a recording states about the run that made its bytes: the Node that ran it and every script of this repository that took part, each
// with its sha256 (the entry scripts, the files they start or compile, and every local module they load, followed through their relative
// imports), read when the recording is written.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { REPO_ROOT } from './common.mjs';

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;

/** `entries`: repository-relative paths (posix). Returns `{ node: process.version, scripts: [{ path, sha256 }] }`, sorted by path. */
export function recordingScripts(entries) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!/\.[cm]?js$/i.test(file)) return;
    for (const match of readFileSync(join(REPO_ROOT, file), 'utf8').matchAll(IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(file), match[1]));
      if (existsSync(join(REPO_ROOT, target))) visit(target);
    }
  };
  for (const entry of entries) visit(entry);
  const scripts = [...seen].sort().map((path) => ({ path, sha256: createHash('sha256').update(readFileSync(join(REPO_ROOT, path))).digest('hex') }));
  return { node: process.version, scripts };
}
