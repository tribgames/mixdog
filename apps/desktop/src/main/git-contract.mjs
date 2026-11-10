import { isAbsolute } from 'node:path';

// The grammar lives in shared/ so the phone's protocol adapter validates a call as the host did.
export * from '../shared/git-contract.mjs';

// The desktop's own callers keep the platform-native rule (this local export wins over the star export): the shared
// default is the Windows rule, meant only for a phone naming its host's platform.
export function requiredRepositoryCwd(value) {
  const cwd = typeof value === 'string' ? value.trim() : '';
  if (!cwd || !isAbsolute(cwd)) throw new TypeError('A project directory is required.');
  return cwd;
}
