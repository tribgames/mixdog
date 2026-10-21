import { useEffect, useSyncExternalStore } from 'react';
import { normalizeAgentAvatar } from '../../../../src/runtime/shared/agent-avatar.mjs';
import type { MascotAvatarValue } from './agent-avatar';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';

const LEGACY_STORAGE_KEY = 'mixdog.leadAvatar';

/** The one pixel face every Lead row on the bot page wears. The HOST stores it
 *  (getLeadAppearance / setLeadAppearance), so the desktop and every paired
 *  phone show the same face; a change reaches the others through the existing
 *  settings-changed event. Missing or invalid → the neutral grey pup. */
export const DEFAULT_LEAD_AVATAR: MascotAvatarValue = Object.freeze({
  kind: 'mascot',
  species: 'shepherd',
  accessory: 'none',
  expression: 'calm',
  color: '#9a9a9a',
}) as MascotAvatarValue;

const listeners = new Set<() => void>();
/** Bumped by every read and every write: a read that is no longer the latest
 *  (a newer read began, or a write happened since) must not publish. */
let generation = 0;
let current: MascotAvatarValue = DEFAULT_LEAD_AVATAR;

/** The host's answer (or a stored value) as a mascot, else the grey default.
 *  Only a mascot counts: Leads have no image avatars. */
export function parseLeadAvatar(raw: unknown): MascotAvatarValue {
  const value = normalizeAgentAvatar(raw);
  return value?.kind === 'mascot' ? value : DEFAULT_LEAD_AVATAR;
}

export const leadAvatar = (): MascotAvatarValue => current;

function publish(next: MascotAvatarValue): void {
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Tests: back to the default, as a fresh window. */
export function resetLeadAvatar(): void {
  publish(DEFAULT_LEAD_AVATAR);
}

type LeadApi = Pick<NonNullable<Window['mixdogDesktop']>, 'invokeCapability'>;

const hostApi = (): LeadApi | undefined => {
  const api = globalThis.window?.mixdogDesktop;
  return typeof api?.invokeCapability === 'function' ? (api as LeadApi) : undefined;
};

/** Set the shared Lead face (null restores the grey default). Every Lead row
 *  updates now; the host stores it and tells the other devices. */
export function setLeadAvatar(avatar: MascotAvatarValue | null): void {
  generation += 1;
  publish(avatar ? parseLeadAvatar(avatar) : DEFAULT_LEAD_AVATAR);
  const api = hostApi();
  if (!api) return;
  void Promise.resolve(api.invokeCapability({ capability: 'setLeadAppearance', args: [avatar] })).catch(() => {
    void readLeadAvatar(api); // the host refused: show what it holds
  });
}

/** A face this device kept before the host stored it: sent up once, then dropped. */
function migrateLegacyChoice(): MascotAvatarValue | null {
  try {
    const storage = globalThis.window?.localStorage;
    const raw = storage?.getItem(LEGACY_STORAGE_KEY);
    if (raw == null) return null;
    storage?.removeItem(LEGACY_STORAGE_KEY);
    const value = normalizeAgentAvatar(JSON.parse(raw));
    return value?.kind === 'mascot' ? value : null;
  } catch {
    return null;
  }
}

/** Read the host's Lead face. A host with none yet adopts this device's
 *  legacy choice, if it has one. */
export async function readLeadAvatar(api: LeadApi): Promise<void> {
  generation += 1;
  const mine = generation;
  try {
    const reply = (await api.invokeCapability({ capability: 'getLeadAppearance', args: [] })) as
      | { value?: { avatar?: unknown } }
      | undefined;
    if (mine !== generation) return;
    const stored = reply?.value?.avatar ?? null;
    if (stored == null) {
      const legacy = migrateLegacyChoice();
      if (legacy) setLeadAvatar(legacy);
      else publish(DEFAULT_LEAD_AVATAR);
      return;
    }
    publish(parseLeadAvatar(stored));
  } catch {
    // An older host has no such capability, or the link lapsed: keep what is shown.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The shared Lead face, live: re-read when the host announces a settings
 *  change (another device picked a look) and when a remote link comes back. */
export function useLeadAvatar(): MascotAvatarValue {
  const avatar = useSyncExternalStore(subscribe, leadAvatar, leadAvatar);
  useEffect(() => {
    const api = hostApi();
    if (!api) return undefined;
    const reread = () => void readLeadAvatar(api);
    reread();
    const unsubscribe = globalThis.window.mixdogDesktop?.subscribeSettingsChanged?.(reread);
    globalThis.window.addEventListener(REMOTE_CONNECTION_READY_EVENT, reread);
    return () => {
      unsubscribe?.();
      globalThis.window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, reread);
    };
  }, []);
  return avatar;
}
