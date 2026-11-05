#!/usr/bin/env node
// Builds the publishable npm packages of `mixdogd` from already-built release
// binaries (`cargo build --release --target <triple> -p mixdog-cli`):
//   <out>/mixdogd                       the launcher package (@mixdog/mixdogd)
//   <out>/mixdogd-<os>-<arch>           one platform package each, with `os`/`cpu`
//                                       set so npm installs only the matching one
// The version is the core's own (workspace version): the launcher pins every
// platform package to exactly it.
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CORE_PLATFORM_TARGETS } from '../../desktop/src/main/ssh/server-manifest.mjs';
import { binaryFileName, platformPackageName } from '../platform.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NPM_OS = { win32: 'win32', linux: 'linux', darwin: 'darwin' };
const NPM_CPU = { x64: 'x64', arm64: 'arm64' };

export async function stageNpm({ targetDir, outDir, version }) {
  await rm(outDir, { recursive: true, force: true });
  const optionalDependencies = {};
  for (const [key, target] of Object.entries(CORE_PLATFORM_TARGETS)) {
    const [platform, arch] = key.split('-');
    const dir = join(outDir, `mixdogd-${key}`);
    const file = binaryFileName(platform);
    await mkdir(join(dir, 'bin'), { recursive: true });
    await copyFile(join(targetDir, target, 'release', file), join(dir, 'bin', file));
    if (platform !== 'win32') await chmod(join(dir, 'bin', file), 0o755);
    const name = platformPackageName(key);
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name,
          version,
          description: `The Mixdog core (mixdogd) for ${key}.`,
          license: 'Apache-2.0',
          os: [NPM_OS[platform]],
          cpu: [NPM_CPU[arch]],
          files: ['bin/'],
        },
        null,
        2
      )}\n`
    );
    optionalDependencies[name] = version;
  }
  const launcher = join(outDir, 'mixdogd');
  await mkdir(join(launcher, 'bin'), { recursive: true });
  await cp(join(packageRoot, 'bin', 'mixdogd.mjs'), join(launcher, 'bin', 'mixdogd.mjs'));
  await cp(join(packageRoot, 'platform.mjs'), join(launcher, 'platform.mjs'));
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  await writeFile(
    join(launcher, 'package.json'),
    `${JSON.stringify({ ...manifest, version, optionalDependencies }, null, 2)}\n`
  );
  return { version, packages: [launcher, ...Object.keys(CORE_PLATFORM_TARGETS).map((key) => join(outDir, `mixdogd-${key}`))] };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const version = argument('version');
  if (!version) {
    console.error('[stage-npm] --version=<core version> is required');
    process.exit(1);
  }
  try {
    const staged = await stageNpm({
      targetDir: resolve(argument('target-dir') ?? join(packageRoot, '../../native/core/target')),
      outDir: resolve(argument('out-dir') ?? join(packageRoot, 'dist')),
      version,
    });
    console.log(`[stage-npm] ${staged.version}: ${staged.packages.length} packages`);
  } catch (error) {
    console.error(`[stage-npm] failed: ${error.message}`);
    process.exit(1);
  }
}
