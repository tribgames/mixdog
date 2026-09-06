import { readFileSync } from 'node:fs';

// Parse a JSON file, or null when it is missing, unreadable, or malformed.
export function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
