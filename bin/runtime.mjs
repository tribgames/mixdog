// The native runtime of the package: the programs (mixdog, mixdogd, mixdog-askpass) and the Office templates beside them,
// which the npm package does not carry (npmjs.org refuses packages of their size). Each platform's runtime is one archive,
// an asset of the GitHub release of the version. bin/runtime-manifest.json, written by the release from the archives it
// built (scripts/npm-runtime-assets.mjs), names each: the asset, its length and SHA-256, the version, the build and the
// files it holds. An archive is used only once its bytes are those; it is then extracted, entry by entry against that
// file list, into the user's runtime cache, `<data>/runtime/<version>/<key>-<sha256>`, never into the package, which a
// global install may have owned by root. `.ready.json`, written before the folder takes its name, says it is complete:
// the launcher, the staged swap (bin/staged-swap.mjs) and the core's updater (update_installer.rs) all ask for it.
//
// The runtime is provisioned at install (the postinstall, when npm runs scripts), at first use (the launcher, when it did
// not) or on request (bin/mixdog-runtime.mjs `prefetch` and `import`, for a machine without the network). It is always the
// one the manifest names: a missing archive is never replaced by another version's. Dependency-free: the launcher ships alone.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createGunzip } from 'node:zlib';

import { download } from './download.mjs';
import { nativeCandidates } from './native-layout.mjs';
import { renameWithRetry } from './rename.mjs';

export const RUNTIME_MANIFEST = 'runtime-manifest.json';
export const READY_FILE = '.ready.json';
export const PROGRAMS = Object.freeze(['mixdog', 'mixdogd', 'mixdog-askpass']);
const STALE_WORK_MS = 60 * 60 * 1000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEY = /^(darwin|linux|win32)-(arm64|x64)$/;

export const programFile = (name, platform) => (platform === 'win32' ? `${name}.exe` : name);

/** `resolvePluginData()`: MIXDOG_DATA_DIR, else `<MIXDOG_HOME or ~/.mixdog>/data`. */
export function dataDir(env = process.env, home = homedir()) {
  if (env.MIXDOG_DATA_DIR) return env.MIXDOG_DATA_DIR;
  return join(env.MIXDOG_HOME || join(home, '.mixdog'), 'data');
}

export const runtimeCacheRoot = (data) => join(data, 'runtime');

/** What is wrong with `manifest` as the runtime manifest of version `version`: sentences, none when it is sound. */
export function manifestProblems(manifest, version) {
  const problems = [];
  if (manifest?.schema !== 1) return ['its schema is not 1'];
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(manifest.repository ?? '')) problems.push(`the repository ${JSON.stringify(manifest.repository)} is not owner/name`);
  if (!NAME.test(manifest.tag ?? '')) problems.push(`the tag ${JSON.stringify(manifest.tag)} is not a tag name`);
  const targets = Object.entries(manifest.targets ?? {});
  if (targets.length === 0) problems.push('it names no target');
  for (const [key, entry] of targets) {
    if (!KEY.test(key)) {
      problems.push(`${key} is not a platform`);
      continue;
    }
    const platform = key.split('-')[0];
    if (!NAME.test(entry?.asset ?? '')) problems.push(`${key}: the asset ${JSON.stringify(entry?.asset)} is not a file name`);
    if (!Number.isSafeInteger(entry?.length) || entry.length <= 0) problems.push(`${key}: the length ${JSON.stringify(entry?.length)} is not a size`);
    if (!/^[0-9a-f]{64}$/.test(entry?.sha256 ?? '')) problems.push(`${key}: the sha256 ${JSON.stringify(entry?.sha256)} is not a SHA-256`);
    if (entry?.version !== version) problems.push(`${key}: the version ${JSON.stringify(entry?.version)} is not the package's ${version}`);
    if (!NAME.test(entry?.buildId ?? '')) problems.push(`${key}: the build ${JSON.stringify(entry?.buildId)} is not a build id`);
    const files = Object.entries(entry?.files ?? {});
    for (const [path, size] of files) {
      if (!path.split('/').every((segment) => NAME.test(segment))) problems.push(`${key}: ${JSON.stringify(path)} is not a relative path`);
      if (!Number.isSafeInteger(size) || size < 0) problems.push(`${key}: the size of ${path} is not a size`);
    }
    for (const name of PROGRAMS)
      if (!files.some(([path]) => path === programFile(name, platform))) problems.push(`${key}: it lists no ${programFile(name, platform)}`);
  }
  return problems;
}

/** The runtime manifest of the package at `packageRoot`, checked against its version. Throws saying what is wrong. */
export function readRuntimeManifest(packageRoot) {
  const path = join(packageRoot, 'bin', RUNTIME_MANIFEST);
  const { version } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      error.code === 'ENOENT'
        ? `${packageRoot} has no bin/${RUNTIME_MANIFEST}: it is not a released mixdog package. Reinstall it: npm install -g mixdog`
        : `${path} cannot be read: ${error.message}`
    );
  }
  const problems = manifestProblems(manifest, version);
  if (problems.length > 0) throw new Error(`${path} is not the runtime manifest of mixdog ${version}: ${problems.join('; ')}`);
  return manifest;
}

/** The target of `manifest` this machine runs, best first (Windows on Arm runs win32-x64), or undefined. */
export function selectTarget(manifest, platform = process.platform, arch = process.arch) {
  const key = nativeCandidates(platform, arch).find((candidate) => manifest.targets[candidate]);
  return key ? { key, entry: manifest.targets[key] } : undefined;
}

export const runtimeFolder = (cacheRoot, key, entry) => join(cacheRoot, entry.version, `${key}-${entry.sha256}`);

const readyMarker = (key, entry) => ({
  key,
  asset: entry.asset,
  length: entry.length,
  sha256: entry.sha256,
  version: entry.version,
  buildId: entry.buildId,
  files: entry.files,
});

/** The folder of the verified runtime of `key`, when it is complete: its marker is this entry's and every file is there at its size. */
export function readyRuntime({ cacheRoot, key, entry }) {
  const folder = runtimeFolder(cacheRoot, key, entry);
  try {
    const marker = JSON.parse(readFileSync(join(folder, READY_FILE), 'utf8'));
    if (JSON.stringify(marker) !== JSON.stringify(readyMarker(key, entry))) return undefined;
    for (const [path, size] of Object.entries(entry.files)) if (statSync(join(folder, path)).size !== size) return undefined;
  } catch {
    return undefined;
  }
  return folder;
}

/**
 * The runtime of the package at `packageRoot` for this machine: `{ error }` when the package has no sound manifest,
 * `{ unsupported }` when it has no runtime this machine runs, `{ missing }` when it is not provisioned yet, else the folder
 * and the program to start. Each but the first carries the manifest, the target and the cache root.
 */
export function resolveRuntime({ packageRoot, platform = process.platform, arch = process.arch, data = dataDir() }) {
  let manifest;
  try {
    manifest = readRuntimeManifest(packageRoot);
  } catch (error) {
    return { error: error.message };
  }
  const target = selectTarget(manifest, platform, arch);
  if (!target) return { unsupported: true, manifest };
  const cacheRoot = runtimeCacheRoot(data);
  const folder = readyRuntime({ cacheRoot, ...target });
  if (!folder) return { missing: true, manifest, cacheRoot, ...target };
  const [platformOfKey, archOfKey] = target.key.split('-');
  return { ready: true, manifest, cacheRoot, ...target, folder, platform: platformOfKey, arch: archOfKey, program: join(folder, programFile('mixdog', platformOfKey)) };
}

/** The public URL of the release asset `entry` names. */
export const assetUrl = (manifest, entry) => `https://github.com/${manifest.repository}/releases/download/${encodeURIComponent(manifest.tag)}/${entry.asset}`;

async function sha256Of(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Throws unless `file` is the archive `entry` names, byte for byte. */
export async function verifyArchive(file, entry) {
  const { size } = statSync(file);
  if (size !== entry.length) throw new Error(`${file} is ${size} bytes, not the ${entry.length} bytes of ${entry.asset} of mixdog ${entry.version}`);
  const digest = await sha256Of(file);
  if (digest !== entry.sha256) throw new Error(`${file} is not ${entry.asset} of mixdog ${entry.version}: its SHA-256 is ${digest}, the release's is ${entry.sha256}`);
}

const octal = (header, at, length) => {
  const text = header.toString('latin1', at, at + length).replace(/[\0 ]+$/, '');
  if (!/^[0-7]+$/.test(text)) throw new Error(`a tar header field holds ${JSON.stringify(text)}, not a number`);
  return Number.parseInt(text, 8);
};
const textField = (header, at, length) => header.toString('utf8', at, at + length).replace(/\0.*$/s, '');

/**
 * Extracts the gzip-compressed ustar `archive` into `folder`, accepting only regular files that are exactly `files`
 * (path -> size), each once; anything else (a link, a folder entry, a path or size not listed, a damaged header) ends it
 * with an error. The programs are made executable.
 */
export async function extractArchive(archive, folder, files, platform) {
  const expected = new Map(Object.entries(files));
  const programs = new Set(PROGRAMS.map((name) => programFile(name, platform)));
  const seen = new Set();
  let header = Buffer.alloc(0);
  let fd = null;
  let remaining = 0;
  let padding = 0;
  let zeros = 0;
  const begin = (block) => {
    if (block.every((byte) => byte === 0)) {
      zeros += 1;
      return;
    }
    if (zeros > 0) throw new Error('the archive holds an entry after its end');
    const sum = block.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (block.toString('latin1', 257, 263) !== 'ustar\0' || octal(block, 148, 8) !== sum) throw new Error('the archive has a damaged or non-ustar header');
    const type = block[156];
    const prefix = textField(block, 345, 155);
    const path = prefix ? `${prefix}/${textField(block, 0, 100)}` : textField(block, 0, 100);
    if (type !== 0x30 && type !== 0) throw new Error(`the archive holds ${path}, which is not a regular file`);
    const size = octal(block, 124, 12);
    if (!expected.has(path)) throw new Error(`the archive holds ${path}, which the runtime does not`);
    if (seen.has(path)) throw new Error(`the archive holds ${path} twice`);
    if (expected.get(path) !== size) throw new Error(`the archive holds ${path} of ${size} bytes, not ${expected.get(path)}`);
    seen.add(path);
    const target = join(folder, path);
    mkdirSync(dirname(target), { recursive: true });
    fd = openSync(target, 'wx', 0o644);
    if (platform !== 'win32' && programs.has(path)) chmodSync(target, 0o755);
    remaining = size;
    padding = (512 - (size % 512)) % 512;
    if (remaining === 0) {
      closeSync(fd);
      fd = null;
    }
  };
  try {
    for await (const chunk of createReadStream(archive).pipe(createGunzip())) {
      let at = 0;
      while (at < chunk.length) {
        if (remaining > 0) {
          const take = Math.min(remaining, chunk.length - at);
          writeSync(fd, chunk, at, take);
          at += take;
          remaining -= take;
          if (remaining === 0) {
            closeSync(fd);
            fd = null;
          }
        } else if (padding > 0) {
          const take = Math.min(padding, chunk.length - at);
          at += take;
          padding -= take;
        } else {
          const take = Math.min(512 - header.length, chunk.length - at);
          header = Buffer.concat([header, chunk.subarray(at, at + take)]);
          at += take;
          if (header.length === 512) {
            begin(header);
            header = Buffer.alloc(0);
          }
        }
      }
    }
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (remaining > 0 || padding > 0 || header.length > 0 || zeros < 2) throw new Error('the archive ends before its end');
  const lacking = [...expected.keys()].filter((path) => !seen.has(path));
  if (lacking.length > 0) throw new Error(`the archive lacks ${lacking.join(', ')}`);
}

/** Removes the downloads, extractions and replaced runtimes left in `dir`: nothing has written to them for an hour. */
function sweepStaleWork(dir) {
  for (const name of readdirSync(dir)) {
    if (!['.download-', '.extract-', '.replaced-'].some((prefix) => name.startsWith(prefix))) continue;
    try {
      if (Date.now() - statSync(join(dir, name)).mtimeMs > STALE_WORK_MS) rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      // Another process removed it.
    }
  }
}

const workName = (kind, key) => `.${kind}-${key}-${process.pid}-${randomBytes(4).toString('hex')}`;

/**
 * Installs the verified `archive` as the runtime of `key` in `cacheRoot`: checked against `entry` first, extracted beside
 * its place, marked ready and only then named. Returns the folder. A runtime another process completed first is kept.
 * An incomplete one in its place is moved aside whole, never removed there: another process may have just put a runtime
 * there, and on Windows a program of it that runs stops a removal halfway.
 */
export async function installArchive({ archive, cacheRoot, key, entry, rename = renameWithRetry }) {
  await verifyArchive(archive, entry);
  const versionDir = join(cacheRoot, entry.version);
  mkdirSync(versionDir, { recursive: true });
  const work = join(versionDir, workName('extract', key));
  mkdirSync(work);
  try {
    await extractArchive(archive, work, entry.files, key.split('-')[0]);
    writeFileSync(join(work, READY_FILE), `${JSON.stringify(readyMarker(key, entry), null, 2)}\n`);
    const folder = runtimeFolder(cacheRoot, key, entry);
    const ready = () => readyRuntime({ cacheRoot, key, entry }) === folder;
    if (ready()) return folder;
    try {
      rename(work, folder);
      return folder;
    } catch (error) {
      if (ready()) return folder;
      if (!existsSync(folder)) throw new Error(`cannot put the runtime in place at ${folder}: ${error.message}`);
    }
    const replaced = join(versionDir, workName('replaced', key));
    try {
      rename(folder, replaced);
    } catch (error) {
      if (ready()) return folder;
      if (error.code !== 'ENOENT') throw new Error(`cannot replace the incomplete runtime at ${folder}, which a running mixdog may hold: ${error.message}`);
    }
    try {
      rename(work, folder);
    } catch (error) {
      if (!ready()) throw new Error(`cannot put the runtime in place at ${folder}: ${error.message}`);
    }
    try {
      rmSync(replaced, { recursive: true, force: true });
    } catch {
      // A scanner holds a file of it for a moment: the sweep of a later fetch removes it.
    }
    return folder;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Downloads the archive of `key` from the release (`url` is the asset's, by default the public one) and installs it. */
export async function fetchRuntime({ manifest, cacheRoot, key, entry, env = process.env, url = assetUrl(manifest, entry), fetchArchive = download, onProgress }) {
  const versionDir = join(cacheRoot, entry.version);
  mkdirSync(versionDir, { recursive: true });
  sweepStaleWork(versionDir);
  const file = join(versionDir, workName('download', key));
  try {
    await fetchArchive({ url, file, length: entry.length, env, userAgent: `mixdog-runtime/${entry.version}`, onProgress });
    return await installArchive({ archive: file, cacheRoot, key, entry });
  } finally {
    rmSync(file, { force: true });
  }
}

/** `onProgress` for a download of `entry`: the percentage on one line of a terminal, nothing elsewhere. */
export function progressReporter(stream, entry) {
  if (!stream.isTTY) return () => {};
  let shown = -1;
  return (bytes) => {
    const percent = Math.floor((bytes * 100) / entry.length);
    if (percent === shown) return;
    shown = percent;
    stream.write(`\rmixdog: ${entry.asset} ${percent}%${bytes === entry.length ? '\n' : ''}`);
  };
}

/** `fetchRuntime` of a `resolveRuntime` result that is missing, saying on `stderr` what it fetches. */
export function provision(found, { env = process.env, stderr = process.stderr, fetchArchive = download, url } = {}) {
  const { manifest, cacheRoot, key, entry } = found;
  const source = url ?? assetUrl(manifest, entry);
  stderr.write(`mixdog: fetching the native runtime of mixdog ${entry.version} for ${key} (${Math.ceil(entry.length / 1e6)} MB) from ${source}\n`);
  return fetchRuntime({ manifest, cacheRoot, key, entry, env, url: source, fetchArchive, onProgress: progressReporter(stderr, entry) });
}

/** Installs a local copy of the archive of this machine's target, recognized by its bytes, never by its name. */
export async function importRuntime({ file, manifest, cacheRoot, platform = process.platform, arch = process.arch }) {
  const target = selectTarget(manifest, platform, arch);
  if (!target) throw new Error(`mixdog has no runtime for ${platform}-${arch}`);
  return installArchive({ archive: file, cacheRoot, ...target });
}

/** What to tell a user whose runtime is not installed, with what to download and the command that installs it. */
export function missingRuntimeMessage({ manifest, key, entry, packageRoot, reason }) {
  const cli = join(packageRoot, 'bin', 'mixdog-runtime.mjs');
  return [
    `mixdog: the native runtime of mixdog ${entry.version} for ${key} is not installed${reason ? `, and fetching it failed: ${reason}` : ''}.`,
    `It is the release asset ${entry.asset} (${entry.length} bytes, SHA-256 ${entry.sha256}):`,
    `  ${assetUrl(manifest, entry)}`,
    `Download that file where it can be reached (\`mixdog-runtime prefetch --target ${key} --out <folder>\` downloads and checks it), then run here:`,
    `  mixdog-runtime import <path to ${entry.asset}>`,
    `or, where mixdog-runtime is not on PATH:`,
    `  node "${cli}" import <path to ${entry.asset}>`,
    '',
  ].join('\n');
}