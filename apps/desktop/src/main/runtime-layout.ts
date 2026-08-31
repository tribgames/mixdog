import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const FAST_DIRECT_RUNTIME_DIRECTORY = 'fast-runtime';
export const FAST_DIRECT_RUNTIME_MARKER = '.mixdog-fast-runtime.json';

export function packagedRuntimeSourceRoot(
  resourcesPath = process.resourcesPath,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const fastRuntime = join(resourcesPath, FAST_DIRECT_RUNTIME_DIRECTORY);
  const fastSource = join(fastRuntime, 'node_modules', 'mixdog', 'src');
  if (
    pathExists(join(fastRuntime, FAST_DIRECT_RUNTIME_MARKER))
    && pathExists(join(fastSource, 'standalone', 'session-client.mjs'))
  ) {
    return fastSource;
  }
  return join(resourcesPath, 'runtime.asar', 'node_modules', 'mixdog', 'src');
}
