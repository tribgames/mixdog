// Small filesystem read helpers used by session-runtime submodules.
import { readFileSync } from 'node:fs';

export function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function readTextSafe(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}
