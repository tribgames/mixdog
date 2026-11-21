/** A runtime owner's attachment in this process's saved-login registry (`secret-input.ts`): its process is bound by id
 *  and OS creation time as this host's own worker reads them, never on the caller's word. Detached owners whose process
 *  the OS proves ended are retired as one attaches and as one detaches (`reconcileSavedLoginOwners`). Null when the
 *  process is not running (or cannot be read); otherwise the function that detaches it. */
import { secretInputs } from '../../secret-input';
import type { ReadProcessFate } from './process-fate';
import { reconcileSavedLoginOwners } from './saved-login';

export async function bindSavedLoginOwner(
  fate: ReadProcessFate,
  ownerId: string,
  pid: number
): Promise<(() => void) | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const identity = await fate({ pid, created: '' }).catch(() => null);
  const detach =
    identity?.state === 'running'
      ? secretInputs.attachSavedLoginOwner(ownerId, { pid, created: identity.created })
      : null;
  if (!detach) return null;
  void reconcileSavedLoginOwners(fate);
  return () => {
    detach();
    void reconcileSavedLoginOwners(fate);
  };
}
