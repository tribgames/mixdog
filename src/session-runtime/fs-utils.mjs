// Small filesystem read helpers used by session-runtime submodules.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

export { readJsonSafe } from '../runtime/shared/json-file.mjs';

export function readTextSafe(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

// Directory entries (Dirent) of an existing readable directory, else [].
export function readDirEntriesSafe(path) {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
