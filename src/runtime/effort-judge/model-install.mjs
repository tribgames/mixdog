// Installs the effort-judge model from the Mixdog GitHub release named in the
// bundled model-manifest.json: every file is downloaded with its exact size,
// checked against its sha256 and renamed into place, so a broken or partial
// download never replaces a working file. Files that already match are kept.
// install.json records the installed release; a newer bundled manifest makes
// the install stale and the next refresh downloads only what changed.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { open as openAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFileFsyncUnsupported, parseJsonText, writeJsonAtomicSync } from '../shared/atomic-file.mjs';
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
    files.some(
      ([, f]) => !validSha256(f.sha256) || !Number.isSafeInteger(f.size) || f.size <= 0 || !/^https:\/\//.test(f.url)
    )
  ) {
    throw new Error('effort judge model manifest is invalid');
  }
  return manifest;
}

// Release named by the stamp; '' when it is missing or damaged (empty,
// NUL-filled), so a damaged stamp reads as not installed and the next refresh
// re-verifies every file against its sha256 and stamps again.
function stampedRelease(dir) {
  try {
    return String(parseJsonText(readFileSync(join(dir, STAMP), 'utf8')).release || '');
  } catch {
    return '';
  }
}

/** True when `dir` holds a complete install of some release (stamped). */
export function effortJudgeInstallStamped(dir) {
  return stampedRelease(dir) !== '';
}

/** True when `dir` holds the release the manifest names. */
export function effortJudgeInstallCurrent(dir, manifest = effortJudgeManifest()) {
  return stampedRelease(dir) === manifest.release;
}

/**
 * Files in `dir` that are missing or differ from the manifest sha256. When any
 * does, the stamp is removed so the folder reads as not installed and the next
 * install re-downloads only those files (a crash can leave a stamped model with
 * its tail zeroed: same size, wrong hash).
 */
export async function invalidateDamagedEffortJudgeInstall(dir, manifest = effortJudgeManifest()) {
  const bad = [];
  for (const [name, file] of Object.entries(manifest.files)) {
    const target = join(dir, name);
    if (!existsSync(target) || (await sha256File(target)) !== file.sha256) bad.push(name);
  }
  if (bad.length) rmSync(join(dir, STAMP), { force: true });
  return bad;
}

// Flushes the downloaded file through a write handle (Windows refuses fsync on
// a read-only one) so a crash right after the rename cannot publish a file
// whose size is committed but whose tail never reached the disk.
export async function fsyncFile(path, open = openAsync) {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } catch (err) {
    if (!isFileFsyncUnsupported(err)) throw err;
  } finally {
    await handle.close();
  }
}

/** Download what is missing or different, then stamp the release. */
export async function installEffortJudgeModel(
  dir,
  { fetchFn = globalThis.fetch, manifest = effortJudgeManifest(), syncFile = fsyncFile } = {}
) {
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
      if (actual !== file.sha256)
        throw new Error(`effort judge ${name}: sha256 mismatch (expected ${file.sha256}, got ${actual})`);
      await syncFile(partial);
      // From the first replaced file until the new stamp, the folder is a mix of
      // releases: without a stamp it reads as not installed, so an interrupted
      // install is never loaded.
      if (!replaced) rmSync(join(dir, STAMP), { force: true });
      renameSync(partial, target);
      replaced = true;
    } finally {
      rmSync(partial, { force: true });
    }
  }
  if (replaced) for (const name of DERIVED) rmSync(join(dir, name), { force: true });
  writeJsonAtomicSync(join(dir, STAMP), { release: manifest.release }, { compact: true });
}
