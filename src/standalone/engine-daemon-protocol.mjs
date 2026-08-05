// Wire identity shared by the engine daemon and its views. Kept dependency-free
// so both the host process and the client can read it without pulling in the
// other side's module graph.
import { readFileSync } from 'node:fs';

/** Bump on any incompatible change to the /call contract or frame shapes. */
export const ENGINE_DAEMON_PROTOCOL = 1;

let cachedVersion = null;

/** Version of the mixdog install this process runs from. A daemon and a view
 *  from DIFFERENT installs cannot share engines safely — the snapshot contract
 *  travels with the runtime, not with the protocol number alone. */
export function engineRuntimeVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    cachedVersion = String(manifest?.version || '0.0.0');
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

export function compareRuntimeVersions(left, right) {
  const parse = (value) => String(value || '0.0.0').split('.').map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}
