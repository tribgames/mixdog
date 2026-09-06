// Small filesystem read helpers used by session-runtime submodules.
import { readFileSync } from 'node:fs';

export { readJsonSafe } from '../runtime/shared/json-file.mjs';

export function readTextSafe(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}
