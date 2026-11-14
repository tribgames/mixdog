// A server window's refusals: the members that act on THIS PC (shared/this-pc-features.ts) answer with the connection gate's
// text instead of reaching the host.
import { THIS_PC_FEATURE_KEYS, thisPcFeatureRefusal } from '../../shared/this-pc-features.ts';

/** `api` with every this-PC member replaced by one that rejects with its refusal; a member `api` lacks stays absent. */
export function withServerGates<T extends object>(api: T): T {
  const gated = { ...api } as Record<string, unknown>;
  for (const key of THIS_PC_FEATURE_KEYS) {
    if (typeof gated[key] !== 'function') continue;
    const message = thisPcFeatureRefusal(key);
    if (!message) continue;
    gated[key] = () => Promise.reject(Object.assign(new Error(message), { code: 'ssh-unsupported' }));
  }
  return gated as T;
}
