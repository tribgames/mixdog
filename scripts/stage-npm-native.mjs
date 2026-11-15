#!/usr/bin/env node
// Lays the native programs of the npm package out for one platform:
//   node scripts/stage-npm-native.mjs --from <folder with the built mixdog and mixdogd> [--platform win32 --arch x64]
// writes native-bin/<platform>-<arch>/{mixdog, mixdogd, js-runtime.json, assets/templates/}. The manifest names the script interpreter as
// `node` (bin/mixdog.mjs puts the Node npm runs on first on the search path) and the package root two folders up.
import { copyFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageOfficeTemplates } from '../apps/desktop/scripts/core-layout.mjs';

export const NATIVE_PROGRAMS = ['mixdog', 'mixdogd'];

export function jsRuntimeManifest() {
  return { program: 'node', packageRoot: '../..' };
}

export async function stageNpmNative({ from, packageRoot, platform = process.platform, arch = process.arch }) {
  const folder = join(packageRoot, 'native-bin', `${platform}-${arch}`);
  mkdirSync(folder, { recursive: true });
  const suffix = platform === 'win32' ? '.exe' : '';
  for (const name of NATIVE_PROGRAMS) {
    const source = join(from, `${name}${suffix}`);
    if (!existsSync(source)) throw new Error(`${source} is not built`);
    const target = join(folder, `${name}${suffix}`);
    copyFileSync(source, target);
    if (platform !== 'win32') chmodSync(target, 0o755);
  }
  writeFileSync(join(folder, 'js-runtime.json'), `${JSON.stringify(jsRuntimeManifest(), null, 2)}\n`);
  // The Office engine reads its templates from assets/templates beside the executable.
  await stageOfficeTemplates(folder);
  return folder;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (name) => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const from = arg('--from');
  if (!from) {
    process.stderr.write('usage: node scripts/stage-npm-native.mjs --from <folder> [--platform <p>] [--arch <a>]\n');
    process.exit(2);
  }
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const folder = await stageNpmNative({ from: resolve(from), packageRoot, platform: arg('--platform'), arch: arg('--arch') });
  process.stdout.write(`${folder}\n`);
}
