// Wire identity shared by the daemon's session transport and its views. Kept dependency-free
// so both the host process and the client can read it without pulling in the
// other side's module graph.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  SESSION_CONFIGURE_ACTIONS,
  SESSION_READ_ACTIONS,
} from './session-protocol.mjs';

/** Compatibility generation, not an application or capability version.
 * Increment only for a rare, fundamentally incompatible wire rewrite. */
export const SESSION_PROTOCOL = 1;

/** Monotonic API index inside protocol 1. Increment when actions or payload
 * shapes change. Newer clients replace older daemons; older clients attach to
 * newer daemons and are normalized at the session boundary. */
export const SESSION_REVISION = 4;

/** Diagnostic-only action-surface identity. It never advances the protocol. */
export const SESSION_CAPABILITY_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify({
    read: SESSION_READ_ACTIONS,
    configure: SESSION_CONFIGURE_ACTIONS,
  }))
  .digest('hex')
  .slice(0, 16);

let cachedVersion = null;

function numericVersion(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

export function compareRuntimeVersions(left, right) {
  const a = numericVersion(left);
  const b = numericVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** Build rank within one protocol generation. */
export function runtimeVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    cachedVersion = String(manifest?.version || '0.0.0');
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}
