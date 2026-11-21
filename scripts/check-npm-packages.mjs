#!/usr/bin/env node
// node scripts/check-npm-packages.mjs --dir <folder with the .tgz files> [--platforms win32-x64,linux-x64,...] [--run [<key>]]
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { OFFICE_TEMPLATES_DIR, OFFICE_TEMPLATE_FILES } from '../apps/desktop/scripts/core-layout.mjs';
import { nativeCandidates } from '../bin/native-layout.mjs';
import { NATIVE_PROGRAMS, PLATFORMS, platformOf, platformPackageName, programFile } from './npm-platforms.mjs';

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

const manifestOf = (entries, label) => {
  const entry = entries.find((candidate) => candidate.path === 'package/package.json');
  if (!entry) throw new Error(`${label} has no package/package.json`);
  return JSON.parse(entry.data.toString('utf8'));
};

/** The exact file list of the package of one platform. */
export function expectedPlatformFiles(platform) {
  const files = [
    'package/package.json',
    ...NATIVE_PROGRAMS.map((name) => `package/bin/${programFile(name, platform)}`),
    ...OFFICE_TEMPLATE_FILES.map((name) => `package/bin/${OFFICE_TEMPLATES_DIR}/${name}`),
  ];
  return files.sort();
}

/** The problems of the tarball of platform `key`: a list of sentences, empty when it is what the release publishes. */
export function platformProblems({ entries, key, version }) {
  const problems = [];
  const { platform, cpu } = platformOf(key);
  const manifest = manifestOf(entries, platformPackageName(key));
  const expected = expectedPlatformFiles(platform);
  const actual = entries.map((entry) => entry.path).sort();
  for (const path of expected) if (!actual.includes(path)) problems.push(`${platformPackageName(key)} lacks ${path}`);
  for (const path of actual)
    if (!expected.includes(path))
      problems.push(`${platformPackageName(key)} holds ${path}, which the package is not to carry`);
  if (manifest.name !== platformPackageName(key))
    problems.push(`${platformPackageName(key)} is named ${manifest.name}`);
  if (manifest.version !== version)
    problems.push(`${platformPackageName(key)} is version ${manifest.version}, the release is ${version}`);
  if (JSON.stringify(manifest.os) !== JSON.stringify([platform]))
    problems.push(`${platformPackageName(key)} os is ${JSON.stringify(manifest.os)}, not ["${platform}"]`);
  if (JSON.stringify(manifest.cpu) !== JSON.stringify(cpu))
    problems.push(`${platformPackageName(key)} cpu is ${JSON.stringify(manifest.cpu)}, not ${JSON.stringify(cpu)}`);
  if (platform !== 'win32') {
    for (const name of NATIVE_PROGRAMS) {
      const entry = entries.find((candidate) => candidate.path === `package/bin/${name}`);
      if (entry && (entry.mode & 0o111) === 0)
        problems.push(`${platformPackageName(key)} holds ${name} without the executable bit`);
    }
  }
  return problems;
}

/** The problems of the tarball of the main package. */
export function mainProblems({ entries, version }) {
  const problems = [];
  const manifest = manifestOf(entries, 'mixdog');
  if (manifest.name !== 'mixdog') problems.push(`the main package is named ${manifest.name}`);
  if (manifest.version !== version)
    problems.push(`the main package is version ${manifest.version}, the release is ${version}`);
  const expected = Object.fromEntries(PLATFORMS.map((entry) => [platformPackageName(entry.key), version]));
  const actual = manifest.optionalDependencies ?? {};
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
    problems.push(
      `optionalDependencies of mixdog are ${JSON.stringify(actual)}, not every platform package at ${version}`
    );
  }
  for (const path of [
    'package/bin/mixdog.mjs',
    'package/bin/native-layout.mjs',
    'package/bin/staged-swap.mjs',
    'package/bin/invocation.mjs',
  ]) {
    if (!entries.some((entry) => entry.path === path)) problems.push(`the main package lacks ${path}`);
  }
  for (const entry of entries) {
    const base = entry.path.split('/').pop();
    if (
      entry.path.startsWith('package/native-bin/') ||
      ['mixdog', 'mixdogd', 'mixdog-askpass', 'mixdog.exe', 'mixdogd.exe', 'mixdog-askpass.exe'].includes(base)
    ) {
      problems.push(`the main package carries a native program: ${entry.path}`);
    }
  }
  return problems;
}

/** The tarballs of `dir`: { main, platforms: { key: file } }. */
export function findTarballs(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.tgz'));
  const platforms = {};
  let main;
  for (const name of files) {
    const manifest = manifestOf(readTarball(join(dir, name)), name);
    if (name !== `${manifest.name}-${manifest.version}.tgz`)
      throw new Error(`${name} does not match its package identity`);
    if (manifest.name === 'mixdog') {
      if (main) throw new Error(`${dir} holds multiple tarballs for mixdog`);
      main = join(dir, name);
    } else {
      const entry = PLATFORMS.find(({ key }) => platformPackageName(key) === manifest.name);
      if (!entry) throw new Error(`${name} is the package ${manifest.name}, which is not one of the mixdog packages`);
      if (platforms[entry.key]) throw new Error(`${dir} holds multiple tarballs for ${manifest.name}`);
      platforms[entry.key] = join(dir, name);
    }
  }
  return { main, platforms };
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

/** Installs the packed main package and the platform package for `key` side by side and starts what they carry. */
export function runInstall({ main, platformTarball, key, version, tmp }) {
  const problems = [];
  const modules = join(tmp, 'node_modules');
  extractTarball(main, join(modules, 'mixdog'));
  extractTarball(platformTarball, join(modules, platformPackageName(key)));
  const launcher = join(modules, 'mixdog', 'bin', 'mixdog.mjs');
  const help = run(process.execPath, [launcher, '--help']);
  if (help.status !== 0) problems.push(`the launcher exited ${help.status} on --help: ${help.stderr.trim()}`);
  else if (!help.stdout.startsWith('mixdog'))
    problems.push(`the launcher's --help does not begin with "mixdog": ${help.stdout.slice(0, 80)}`);
  const folder = join(modules, platformPackageName(key), 'bin');
  const { platform } = platformOf(key);
  const manifestPath = join(folder, 'js-runtime.json');
  if (!existsSync(manifestPath)) problems.push('the launcher left no js-runtime.json beside the programs');
  else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.program !== 'node') problems.push(`js-runtime.json names ${manifest.program} as the interpreter`);
    if (!existsSync(resolve(folder, manifest.packageRoot, 'package.json')))
      problems.push(`js-runtime.json packageRoot ${manifest.packageRoot} is not the mixdog package`);
    if (manifest.ortLibrary !== undefined && !existsSync(resolve(folder, manifest.ortLibrary)))
      problems.push(`js-runtime.json ortLibrary ${manifest.ortLibrary} does not exist`);
  }
  const core = run(join(folder, programFile('mixdogd', platform)), ['--version']);
  const reported = core.status === 0 ? core.stdout.trim().split(/\s+/).pop() : undefined;
  if (reported !== version)
    problems.push(
      `mixdogd reports ${reported ?? `exit ${core.status}: ${core.stderr.trim()}`}, the release is ${version}`
    );
  const { MIXDOG_ASKPASS_ENDPOINT: _endpoint, MIXDOG_ASKPASS_TOKEN: _token, ...env } = process.env;
  const askpass = run(join(folder, programFile('mixdog-askpass', platform)), ['prompt'], { env });
  if (askpass.status !== 2) problems.push(`mixdog-askpass exited ${askpass.status} with no endpoint, not 2`);
  return problems;
}

/** The whole check; returns the problems. */
export function checkPackages({
  dir,
  platforms,
  run: runKey,
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
}) {
  const problems = [];
  const found = findTarballs(dir);
  if (!found.main) problems.push(`${dir} holds no tarball of the package mixdog`);
  else problems.push(...mainProblems({ entries: readTarball(found.main), version }));
  for (const key of platforms) {
    if (!found.platforms[key]) problems.push(`${dir} holds no tarball of ${platformPackageName(key)}`);
    else problems.push(...platformProblems({ entries: readTarball(found.platforms[key]), key, version }));
  }
  for (const key of Object.keys(found.platforms))
    if (!platforms.includes(key))
      problems.push(`${dir} holds a tarball of ${platformPackageName(key)}, which this release does not stage`);
  if (runKey) {
    if (!found.main || !found.platforms[runKey])
      problems.push(`cannot start ${runKey}: its tarballs are not in ${dir}`);
    else {
      const tmp = mkdtempSync(join(tmpdir(), 'mixdog-npm-check-'));
      try {
        problems.push(
          ...runInstall({ main: found.main, platformTarball: found.platforms[runKey], key: runKey, version, tmp })
        );
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
  if (!dir) {
    process.stderr.write(
      'usage: node scripts/check-npm-packages.mjs --dir <folder> [--platforms <key,key,...>] [--run [<key>]]\n'
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
  const problems = checkPackages({ dir: resolve(dir), platforms, run: runKey });
  for (const problem of problems) process.stderr.write(`mixdog-check: ${problem}\n`);
  if (problems.length > 0) process.exit(1);
  process.stdout.write(
    `mixdog-check: ${platforms.length} platform package(s) and the main package are as released${runKey ? `; ${runKey} starts` : ''}\n`
  );
}
