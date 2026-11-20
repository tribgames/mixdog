#!/usr/bin/env node
// Lays out the npm packages that carry the native programs of mixdog (scripts/npm-platforms.mjs says which and why):
//   node scripts/stage-npm-native.mjs --from <folder with built programs> [--from <another>] --platform <p> --arch <a> --out <folder>
//     writes <out>/mixdog-<platform>-<arch>/ : package.json (name, the release version, os, cpu), and in bin/ the programs
//     mixdog, mixdogd and mixdog-askpass (each found in one of the --from folders) and assets/templates/ with the Office
//     templates the core reads beside mixdogd. `js-runtime.json` is not staged: it names the package root and the ONNX
//     Runtime library of the install, which only the install knows (bin/native-layout.mjs writes it).
//   node scripts/stage-npm-native.mjs --artifacts <folder> --out <folder>
//     the same for every platform, from the artifacts of mixdogd-build.yml downloaded side by side:
//     <folder>/mixdogd-<target>/{mixdogd,mixdog-askpass} and <folder>/mixdog-entry-<target>/mixdog for each target.
//   node scripts/stage-npm-native.mjs --lock-optional-dependencies
//     rewrites optionalDependencies of the root package.json to every platform package at its own version. The committed
//     package.json carries none: `npm ci` would look for packages that do not exist until the release publishes them. The
//     release pack job runs this on its checkout, before `npm pack`; the published package lists them.
// The version is the root package.json's (the one Deploy stamps), so a package and the packages it lists cannot differ.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { stageOfficeTemplates } from '../apps/desktop/scripts/core-layout.mjs';
import { NATIVE_PROGRAMS, PLATFORMS, platformOf, platformPackageName, programFile } from './npm-platforms.mjs';

export { NATIVE_PROGRAMS };

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rootManifestPath = join(packageRoot, 'package.json');

const readManifest = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeManifest = (path, manifest) => writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

/** The manifest of one platform package. */
export function platformManifest({ key, version, root }) {
  const { platform, cpu } = platformOf(key);
  return {
    name: platformPackageName(key),
    version,
    description: `The native programs of mixdog for ${key}. Install mixdog, not this package.`,
    license: root.license,
    repository: root.repository,
    homepage: root.homepage,
    os: [platform],
    cpu,
    files: ['bin/'],
  };
}

/** Stages the package of one platform under `out`; returns its folder. Throws naming a program no `from` folder holds. */
export async function stageNpmNative({ from, out, platform, arch, version, root = readManifest(rootManifestPath) }) {
  const key = `${platform}-${arch}`;
  platformOf(key);
  const folder = join(out, platformPackageName(key));
  const bin = join(folder, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of NATIVE_PROGRAMS) {
    const file = programFile(name, platform);
    const source = from.map((dir) => join(dir, file)).find((candidate) => existsSync(candidate));
    if (!source) throw new Error(`${file} is not built (looked in ${from.join(', ')})`);
    const target = join(bin, file);
    copyFileSync(source, target);
    if (platform !== 'win32') chmodSync(target, 0o755);
  }
  // The Office engine reads its templates from assets/templates beside the executable.
  await stageOfficeTemplates(bin);
  writeManifest(join(folder, 'package.json'), platformManifest({ key, version: version ?? root.version, root }));
  return folder;
}

/** Sets optionalDependencies of the package.json at `path` to every platform package at `version`. */
export function lockOptionalDependencies(path = rootManifestPath, version) {
  const manifest = readManifest(path);
  const locked = version ?? manifest.version;
  manifest.optionalDependencies = Object.fromEntries(PLATFORMS.map(({ key }) => [platformPackageName(key), locked]));
  writeManifest(path, manifest);
  return manifest.optionalDependencies;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const all = (name) => args.flatMap((arg, at) => (arg === name && args[at + 1] !== undefined ? [args[at + 1]] : []));
  const one = (name) => all(name)[0];
  if (args.includes('--lock-optional-dependencies')) {
    const locked = lockOptionalDependencies(one('--package') ? resolve(one('--package')) : rootManifestPath);
    process.stdout.write(`${JSON.stringify(locked, null, 2)}\n`);
  } else if (one('--artifacts')) {
    const artifacts = resolve(one('--artifacts'));
    const out = one('--out');
    if (!out) {
      process.stderr.write(
        'usage: node scripts/stage-npm-native.mjs --artifacts <folder> --out <folder> [--version <v>]\n'
      );
      process.exit(2);
    }
    for (const { platform, arch, target } of PLATFORMS) {
      const from = [join(artifacts, `mixdogd-${target}`), join(artifacts, `mixdog-entry-${target}`)];
      process.stdout.write(
        `${await stageNpmNative({ from, out: resolve(out), platform, arch, version: one('--version') })}\n`
      );
    }
  } else {
    const from = all('--from').map((dir) => resolve(dir));
    const out = one('--out');
    if (from.length === 0 || !out || !one('--platform') || !one('--arch')) {
      process.stderr.write(
        'usage: node scripts/stage-npm-native.mjs --from <folder> [--from <folder>] --platform <p> --arch <a> --out <folder> [--version <v>]\n' +
          '       node scripts/stage-npm-native.mjs --lock-optional-dependencies [--package <package.json>]\n'
      );
      process.exit(2);
    }
    const folder = await stageNpmNative({
      from,
      out: resolve(out),
      platform: one('--platform'),
      arch: one('--arch'),
      version: one('--version'),
    });
    process.stdout.write(`${folder}\n`);
  }
}
