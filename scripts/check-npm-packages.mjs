#!/usr/bin/env node
// node scripts/check-npm-packages.mjs --dir <folder with the .tgz> --runtime <folder with the runtime archives>
//     [--platforms win32-x64,linux-x64,...] [--build-id <id>] [--repository <owner/name>] [--tag <tag>] [--run [<key>]]
// The package is the launcher and its manifest of the runtime archives, which are release assets (scripts/npm-platforms.mjs):
// both are checked against each other, the archives the way the launcher reads them, and with --run the package is
// installed, the archive of a platform imported into a scratch data folder and every program started through the launcher.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { nativeCandidates } from '../bin/native-layout.mjs';
import { RUNTIME_MANIFEST, extractArchive, manifestProblems, runtimeCacheRoot, runtimeFolder, verifyArchive } from '../bin/runtime.mjs';
import { LEGACY_ENTRY, LEGACY_ENTRY_SOURCE, runtimeFiles } from './npm-runtime-assets.mjs';
import { PLATFORMS, platformOf, programFile, runtimeAssetName } from './npm-platforms.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const text = (buffer, from, to) => buffer.toString('utf8', from, to).replace(/\0.*$/s, '');

/** The files of a gzip-compressed tar as { path, mode, data }; the path as written, with its leading `package/`. */
export function readTarball(file) {
  const tar = gunzipSync(readFileSync(file));
  const entries = [];
  let longName = null;
  let paxPath = null;
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(text(header, 124, 136).trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      for (const record of data.toString('utf8').split('\n')) {
        const match = /^\d+ path=(.*)$/.exec(record);
        if (match) paxPath = match[1];
      }
    } else if (type === 'L') {
      longName = text(data, 0, data.length);
    } else if (type === '0' || type === '\0') {
      const prefix = text(header, 345, 500);
      const name = paxPath ?? longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
      entries.push({ path: name, mode: parseInt(text(header, 100, 108).trim() || '0', 8), data });
      longName = null;
      paxPath = null;
    } else if (type !== 'g') {
      longName = null;
      paxPath = null;
    }
  }
  return entries;
}

const fileOf = (entries, path) => entries.find((candidate) => candidate.path === `package/${path}`);
const jsonOf = (entries, path, label) => {
  const entry = fileOf(entries, path);
  if (!entry) throw new Error(`${label} has no package/${path}`);
  return JSON.parse(entry.data.toString('utf8'));
};

/** The runtime manifest the package carries. Throws when it has none. */
export const runtimeManifestOf = (entries) => jsonOf(entries, `bin/${RUNTIME_MANIFEST}`, 'the package');

/** The files the package must carry for the launcher, the runtime, the swap and an install made by 1.4.5 to work. */
export const LAUNCHER_FILES = Object.freeze([
  'bin/download.mjs',
  'bin/invocation.mjs',
  'bin/mixdog-runtime.mjs',
  'bin/mixdog.mjs',
  'bin/native-layout.mjs',
  'bin/rename.mjs',
  `bin/${RUNTIME_MANIFEST}`,
  'bin/runtime.mjs',
  'bin/staged-swap.mjs',
  LEGACY_ENTRY,
  'src/skill-script-entry.mjs',
]);

const PROGRAM_NAMES = new Set(['mixdog', 'mixdogd', 'mixdog-askpass', 'mixdog.exe', 'mixdogd.exe', 'mixdog-askpass.exe']);

/**
 * The problems of the tarball of the package: a list of sentences, empty when it is what the release publishes. Its runtime
 * manifest names exactly `platforms`, each archive under its asset name with the layout of its platform, at `version`, of
 * build `buildId` and at `repository`/`tag` when those are given.
 */
export function mainProblems({ entries, version, platforms = PLATFORMS.map(({ key }) => key), buildId, repository, tag }) {
  const problems = [];
  const manifest = jsonOf(entries, 'package.json', 'the package');
  if (manifest.name !== 'mixdog') problems.push(`the package is named ${manifest.name}`);
  if (manifest.version !== version) problems.push(`the package is version ${manifest.version}, the release is ${version}`);
  if (manifest.optionalDependencies !== undefined)
    problems.push(`the package lists optional dependencies: ${JSON.stringify(manifest.optionalDependencies)}`);
  const bin = { mixdog: 'bin/mixdog.mjs', 'mixdog-runtime': 'bin/mixdog-runtime.mjs' };
  if (JSON.stringify(manifest.bin) !== JSON.stringify(bin)) problems.push(`the package's bin is ${JSON.stringify(manifest.bin)}, not ${JSON.stringify(bin)}`);
  for (const path of LAUNCHER_FILES) if (!fileOf(entries, path)) problems.push(`the package lacks package/${path}`);
  if (fileOf(entries, LEGACY_ENTRY) && fileOf(entries, LEGACY_ENTRY).data.toString('utf8') !== LEGACY_ENTRY_SOURCE)
    problems.push(`the package's ${LEGACY_ENTRY} is not the command an install made by 1.4.5 starts`);
  for (const entry of entries)
    if (PROGRAM_NAMES.has(entry.path.split('/').pop())) problems.push(`the package carries a native program: ${entry.path}`);
  if (!fileOf(entries, `bin/${RUNTIME_MANIFEST}`)) return problems;
  const runtime = runtimeManifestOf(entries);
  problems.push(...manifestProblems(runtime, version).map((problem) => `the runtime manifest: ${problem}`));
  if (repository !== undefined && runtime.repository !== repository) problems.push(`the runtime manifest names the repository ${runtime.repository}, not ${repository}`);
  if (tag !== undefined && runtime.tag !== tag) problems.push(`the runtime manifest names the tag ${runtime.tag}, not ${tag}`);
  const keys = Object.keys(runtime.targets ?? {});
  for (const key of platforms) if (!keys.includes(key)) problems.push(`the runtime manifest names no runtime for ${key}`);
  for (const key of keys) {
    if (!platforms.includes(key)) {
      problems.push(`the runtime manifest names a runtime for ${key}, which this release does not build`);
      continue;
    }
    const entry = runtime.targets[key];
    if (entry.asset !== runtimeAssetName(key)) problems.push(`${key}: the asset is ${entry.asset}, not ${runtimeAssetName(key)}`);
    if (buildId !== undefined && entry.buildId !== buildId) problems.push(`${key}: the build is ${entry.buildId}, not ${buildId}`);
    const expected = runtimeFiles(platformOf(key).platform).sort();
    const listed = Object.keys(entry.files ?? {}).sort();
    if (JSON.stringify(listed) !== JSON.stringify(expected)) problems.push(`${key}: the runtime lists ${listed.join(', ')}, not ${expected.join(', ')}`);
  }
  return problems;
}

/** The problems of the archives in `dir` against `manifest`: exactly its assets, each its bytes, each extracting as the launcher extracts it. */
export async function runtimeProblems({ manifest, dir }) {
  const problems = [];
  const entries = Object.entries(manifest.targets);
  const assets = entries.map(([, entry]) => entry.asset);
  for (const name of readdirSync(dir)) if (!assets.includes(name)) problems.push(`${dir} holds ${name}, which is no asset of the runtime manifest`);
  for (const [key, entry] of entries) {
    const file = join(dir, entry.asset);
    if (!existsSync(file)) {
      problems.push(`${dir} holds no ${entry.asset}`);
      continue;
    }
    const scratch = mkdtempSync(join(tmpdir(), 'mixdog-runtime-check-'));
    try {
      await verifyArchive(file, entry);
      await extractArchive(file, scratch, entry.files, platformOf(key).platform);
    } catch (error) {
      problems.push(`${key}: ${error.message}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return problems;
}

/** The tarball of the package in `dir`, the only file there. */
export function findTarball(dir) {
  const names = readdirSync(dir);
  const tarballs = names.filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1 || names.length !== 1) throw new Error(`${dir} holds ${names.join(', ') || 'nothing'}, not the one tarball of the package`);
  const manifest = jsonOf(readTarball(join(dir, tarballs[0])), 'package.json', tarballs[0]);
  if (tarballs[0] !== `${manifest.name}-${manifest.version}.tgz`) throw new Error(`${tarballs[0]} does not match its package identity`);
  return join(dir, tarballs[0]);
}

/** Extracts the tarball into `folder` without its `package/` prefix. */
export function extractTarball(file, folder) {
  for (const entry of readTarball(file)) {
    const path = join(folder, entry.path.replace(/^package\//, ''));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.data);
    if (process.platform !== 'win32') chmodSync(path, entry.mode & 0o777 || 0o644);
  }
}

const run = (program, args, options = {}) =>
  spawnSync(program, args, { encoding: 'utf8', timeout: 120_000, windowsHide: true, ...options });

/**
 * Installs the packed package into a scratch `node_modules`, imports the archive of `key` into a scratch data folder with the
 * package's own command, and starts the launcher, the 1.4.5 command and each program.
 */
export function runInstall({ main, archive, key, version, tmp }) {
  const problems = [];
  const packageRoot = join(tmp, 'node_modules', 'mixdog');
  extractTarball(main, packageRoot);
  const data = join(tmp, 'data');
  // A data folder of its own, and no npm settings: this install never reaches the network.
  const env = Object.fromEntries(Object.entries({ ...process.env, MIXDOG_DATA_DIR: data }).filter(([name]) => !/^npm_config_/i.test(name)));
  const imported = run(process.execPath, [join(packageRoot, 'bin', 'mixdog-runtime.mjs'), 'import', archive], { env });
  if (imported.status !== 0) {
    problems.push(`mixdog-runtime import exited ${imported.status}: ${imported.stderr.trim()}`);
    return problems;
  }
  const status = run(process.execPath, [join(packageRoot, 'bin', 'mixdog-runtime.mjs'), 'status'], { env });
  if (status.status !== 0) problems.push(`mixdog-runtime status exited ${status.status} after the import: ${status.stdout.trim()}`);
  for (const [label, entry, extra] of [
    ['the launcher', join(packageRoot, 'bin', 'mixdog.mjs'), {}],
    // 1.4.5 starts its swapped-in package this way.
    ['the command of an install made by 1.4.5', join(packageRoot, LEGACY_ENTRY), { MIXDOG_SWAP_REEXEC: '1' }],
  ]) {
    const help = run(process.execPath, [entry, '--help'], { env: { ...env, ...extra } });
    if (help.status !== 0) problems.push(`${label} exited ${help.status} on --help: ${help.stderr.trim()}`);
    else if (!help.stdout.startsWith('mixdog')) problems.push(`the --help of ${label} does not begin with "mixdog": ${help.stdout.slice(0, 80)}`);
  }
  const runtime = JSON.parse(readFileSync(join(packageRoot, 'bin', RUNTIME_MANIFEST), 'utf8'));
  const folder = runtimeFolder(runtimeCacheRoot(data), key, runtime.targets[key]);
  const { platform } = platformOf(key);
  const manifestPath = join(folder, 'js-runtime.json');
  if (!existsSync(manifestPath)) problems.push(`the launcher left no js-runtime.json beside the programs in ${folder}`);
  else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.program !== 'node') problems.push(`js-runtime.json names ${manifest.program} as the interpreter`);
    if (!existsSync(resolve(folder, manifest.packageRoot, 'src', 'skill-script-entry.mjs')))
      problems.push(`js-runtime.json packageRoot ${manifest.packageRoot} is not the mixdog package`);
    if (manifest.ortLibrary !== undefined && !existsSync(resolve(folder, manifest.ortLibrary)))
      problems.push(`js-runtime.json ortLibrary ${manifest.ortLibrary} does not exist`);
  }
  const core = run(join(folder, programFile('mixdogd', platform)), ['--version'], { env });
  const reported = core.status === 0 ? core.stdout.trim().split(/\s+/).pop() : undefined;
  if (reported !== version) problems.push(`mixdogd reports ${reported ?? `exit ${core.status}: ${core.stderr.trim()}`}, the release is ${version}`);
  const { MIXDOG_ASKPASS_ENDPOINT: _endpoint, MIXDOG_ASKPASS_TOKEN: _token, ...askpassEnv } = env;
  const askpass = run(join(folder, programFile('mixdog-askpass', platform)), ['prompt'], { env: askpassEnv });
  if (askpass.status !== 2) problems.push(`mixdog-askpass exited ${askpass.status} with no endpoint, not 2`);
  return problems;
}

/** The whole check; returns the problems. */
export async function checkPackages({
  dir,
  runtime,
  platforms = PLATFORMS.map(({ key }) => key),
  run: runKey,
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  buildId,
  repository,
  tag,
}) {
  const main = findTarball(dir);
  const entries = readTarball(main);
  const problems = mainProblems({ entries, version, platforms, buildId, repository, tag });
  if (!fileOf(entries, `bin/${RUNTIME_MANIFEST}`) || problems.some((problem) => problem.startsWith('the runtime manifest:'))) return problems;
  const manifest = runtimeManifestOf(entries);
  problems.push(...(await runtimeProblems({ manifest, dir: runtime })));
  if (runKey) {
    if (!manifest.targets[runKey]) problems.push(`cannot start ${runKey}: the package has no runtime for it`);
    else if (problems.length === 0) {
      const tmp = mkdtempSync(join(tmpdir(), 'mixdog-npm-check-'));
      try {
        problems.push(...runInstall({ main, archive: join(runtime, manifest.targets[runKey].asset), key: runKey, version, tmp }));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
  return problems;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const dir = value('--dir');
  const runtime = value('--runtime');
  if (!dir || !runtime) {
    process.stderr.write(
      'usage: node scripts/check-npm-packages.mjs --dir <folder> --runtime <folder> [--platforms <key,key,...>] [--build-id <id>] [--repository <owner/name>] [--tag <tag>] [--run [<key>]]\n'
    );
    process.exit(2);
  }
  const platforms = value('--platforms') ? value('--platforms').split(',') : PLATFORMS.map(({ key }) => key);
  let runKey;
  if (args.includes('--run')) {
    const next = value('--run');
    runKey = next && !next.startsWith('--') ? next : nativeCandidates().find((key) => platforms.includes(key));
    if (!runKey) {
      process.stderr.write(`mixdog-check: no staged platform runs on ${process.platform}-${process.arch}\n`);
      process.exit(1);
    }
  }
  const problems = await checkPackages({
    dir: resolve(dir),
    runtime: resolve(runtime),
    platforms,
    run: runKey,
    buildId: value('--build-id'),
    repository: value('--repository'),
    tag: value('--tag'),
  });
  for (const problem of problems) process.stderr.write(`mixdog-check: ${problem}\n`);
  if (problems.length > 0) process.exit(1);
  process.stdout.write(`mixdog-check: the package and the runtime archives of ${platforms.length} platform(s) are as released${runKey ? `; ${runKey} starts` : ''}\n`);
}
