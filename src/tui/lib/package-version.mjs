// The version of the package this TUI runs from (the package.json three levels above src/tui/{lib,dist}).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cached = null;

export function localPackageVersion() {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'));
    cached = String(raw?.version || '0.0.0');
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
