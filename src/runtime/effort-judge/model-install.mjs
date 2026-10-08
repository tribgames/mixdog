// Installs the effort-judge model from the Mixdog GitHub release named in the
// bundled model-manifest.json: every file is downloaded with its exact size,
// checked against its sha256 and renamed into place, so a broken or partial
// download never replaces a working file. Files that already match are kept.
// install.json records the installed release; a newer bundled manifest makes
// the install stale and the next refresh downloads only what changed.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadToFileWithRetry } from '../shared/bounded-download.mjs';
import { sha256File, validSha256 } from '../shared/native-asset.mjs';

const MANIFEST_PATH = fileURLToPath(new URL('./model-manifest.json', import.meta.url));
const STAMP = 'install.json';
// Derived from tokenizer.json on first load (compact-tokenizer.mjs).
const DERIVED = ['tokenizer.bin'];

export function effortJudgeManifest() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const files = Object.entries(manifest.files || {});
  if (
    !manifest.release ||
    !files.length ||
    files.some(([, f]) => !validSha256(f.sha256) || !Number.isSafeInteger(f.size) || f.size <= 0 || !/^https:\/\//.test(f.url))
  ) {
    throw new Error('effort judge model manifest is invalid');
  }
  return manifest;
}

/** True when `dir` holds the release the manifest names. */
export function effortJudgeInstallCurrent(dir, manifest = effortJudgeManifest()) {
  try {
    return JSON.parse(readFileSync(join(dir, STAMP), 'utf8')).release === manifest.release;
  } catch {
    return false;
  }
}

/** Download what is missing or different, then stamp the release. */
export async function installEffortJudgeModel(dir, { fetchFn = globalThis.fetch, manifest = effortJudgeManifest() } = {}) {
  mkdirSync(dir, { recursive: true });
  let replaced = false;
  for (const [name, file] of Object.entries(manifest.files)) {
    const target = join(dir, name);
    if (existsSync(target) && (await sha256File(target)) === file.sha256) continue;
    const partial = `${target}.${process.pid}.part`;
    try {
      await downloadToFileWithRetry(file.url, partial, {
        maxBytes: file.size,
        expectedBytes: file.size,
        label: `effort judge ${name}`,
        fetchFn,
      });
      const actual = await sha256File(partial);
      if (actual !== file.sha256) throw new Error(`effort judge ${name}: sha256 mismatch (expected ${file.sha256}, got ${actual})`);
      renameSync(partial, target);
      replaced = true;
    } finally {
      rmSync(partial, { force: true });
    }
  }
  if (replaced) for (const name of DERIVED) rmSync(join(dir, name), { force: true });
  writeFileSync(join(dir, STAMP), `${JSON.stringify({ release: manifest.release })}\n`);
}
