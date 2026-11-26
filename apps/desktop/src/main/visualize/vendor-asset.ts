import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const requireFromHere = createRequire(import.meta.url);

/** Resolves a visualize vendor script shipped as an asset file beside the main
 *  bundle (`out/main/assets/<fileName>`), falling back to the package path in
 *  source/test runs. */
export function resolveVisualizeVendorAssetPath(
  fileName: string,
  packageSpecifier: string,
  baseDir: string = import.meta.dirname
): string {
  const bundled = join(baseDir, 'assets', fileName);
  if (existsSync(bundled)) return bundled;
  return requireFromHere.resolve(packageSpecifier);
}

/** Reads a visualize vendor script directly from disk without retaining it in
 *  V8's module cache. */
export function readVisualizeVendorAsset(
  fileName: string,
  packageSpecifier: string,
  baseDir?: string
): Promise<string> {
  return readFile(resolveVisualizeVendorAssetPath(fileName, packageSpecifier, baseDir), 'utf8');
}
