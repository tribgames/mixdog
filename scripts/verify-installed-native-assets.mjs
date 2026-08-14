import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  nativePackageName,
  nativePlatformKey,
} from '../src/runtime/shared/native-assets.mjs';
import { verifyNativePackageDirectory } from './stage-native-packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const expectedName = nativePackageName();
const expectedVersion = rootPackage.optionalDependencies?.[expectedName];

if (!expectedVersion) {
  process.stdout.write('Mixdog native asset verification skipped for source checkout.\n');
} else {
  const require = createRequire(join(root, 'package.json'));
  let packageRoot;
  try {
    packageRoot = dirname(require.resolve(`${expectedName}/package.json`));
  } catch {
    throw new Error(`Required native package ${expectedName}@${expectedVersion} is not installed.`);
  }
  const { packageJson, manifest } = await verifyNativePackageDirectory(packageRoot, {
    expectedPlatformKey: nativePlatformKey(),
  });
  if (packageJson.version !== expectedVersion || manifest.packageVersion !== expectedVersion) {
    throw new Error(
      `Required native package version mismatch: expected ${expectedVersion}, got ${packageJson.version}.`,
    );
  }
  const identity = createHash('sha256')
    .update(JSON.stringify(manifest.assets))
    .digest('hex')
    .slice(0, 12);
  process.stdout.write(`Verified ${expectedName}@${expectedVersion} (${identity}).\n`);
}
