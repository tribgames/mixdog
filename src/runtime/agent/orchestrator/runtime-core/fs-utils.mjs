// Small filesystem read helpers used by session-runtime submodules.
import { readdirSync, readFileSync } from 'node:fs';
import { holdsNoData } from '../../../shared/atomic-file.mjs';

export { readJsonSafe } from '../../../shared/json-file.mjs';

// The default data dir of a loader factory: a path, or a resolver read per
// call so a later runtime start's data dir is honored.
export const defaultDirResolver = (dataDir) => (typeof dataDir === 'function' ? dataDir : () => dataDir);

export function readTextSafe(path) {
  try {
    const text = readFileSync(path, 'utf8');
    // A crash can leave NUL bytes (String.trim keeps them): no data is no text.
    return holdsNoData(text) ? '' : text.trim();
  } catch {
    return '';
  }
}

// Directory entries (Dirent) of an existing readable directory, else [].
export function readDirEntriesSafe(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
