import { readFileSync } from 'node:fs';

/** Source execution reads the originals; desktop bundles embed these calls. */
export function loadComputerSource(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9-]*\.(?:cs|ps1)$/.test(name)) {
    throw new Error('invalid Computer Use source asset');
  }
  return readFileSync(new URL(`./sources/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}
