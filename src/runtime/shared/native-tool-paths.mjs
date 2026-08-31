import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const NATIVE_TOOL_FILENAMES = Object.freeze({
  graph: process.platform === 'win32' ? 'mixdog-graph.exe' : 'mixdog-graph',
  patch: process.platform === 'win32' ? 'mixdog-patch.exe' : 'mixdog-patch',
  spawn: process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn',
});

export function packageNativeToolsDir(packageRoot = DEFAULT_PACKAGE_ROOT) {
  return join(packageRoot, 'native-tools');
}

export function packageNativeToolPath(kind, packageRoot = DEFAULT_PACKAGE_ROOT) {
  const fileName = NATIVE_TOOL_FILENAMES[kind];
  if (!fileName) throw new Error(`unknown native tool kind: ${kind}`);
  return join(packageNativeToolsDir(packageRoot), fileName);
}
