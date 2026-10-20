// The name and face a deleted (archived) bot left: its archived chat in
// Sessions → 보관됨, its tab and its read-only thread show them. Read once per
// bot from the runtime (`archivedAgentIdentities`) when the session catalog
// first marks its home as deleted (agent-chat-mode.ts).
import { useSyncExternalStore } from 'react';
import { type AgentAvatarValue, agentAvatar } from '../../../../src/runtime/shared/agent-avatar.mjs';

export interface ArchivedBotIdentity {
  name: string;
  avatar: AgentAvatarValue;
}

let identities: ReadonlyMap<string, ArchivedBotIdentity> = new Map();
const requested = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the identities of bots not asked about yet; a failed read is retried on the next mark. */
export function loadArchivedBotIdentities(agentIds: readonly string[]): void {
  const api = typeof window === 'undefined' ? undefined : window.mixdogDesktop;
  const ids = agentIds.filter((id) => id && !requested.has(id));
  if (!ids.length || !api?.invokeCapability) return;
  for (const id of ids) requested.add(id);
  void api
    .invokeCapability<Record<string, { name?: unknown; avatar?: unknown } | null>>({
      capability: 'archivedAgentIdentities',
      args: [ids],
    })
    .then(({ value }) => {
      const next = new Map(identities);
      for (const id of ids) {
        const found = value?.[id];
        if (!found) continue;
        const name = typeof found.name === 'string' && found.name.trim() ? found.name.trim() : id;
        next.set(id, { name, avatar: agentAvatar(id, found.avatar ?? null) });
      }
      identities = next;
      for (const listener of [...listeners]) listener();
    })
    .catch(() => {
      for (const id of ids) requested.delete(id);
    });
}

/** A restored bot: a later deletion reads its name and face afresh. */
export function forgetArchivedBotIdentity(agentId: string): void {
  requested.delete(agentId);
  if (!identities.has(agentId)) return;
  const next = new Map(identities);
  next.delete(agentId);
  identities = next;
  for (const listener of [...listeners]) listener();
}

/** Every archived bot's identity read so far, by agent id. */
export function useArchivedBotIdentities(): ReadonlyMap<string, ArchivedBotIdentity> {
  return useSyncExternalStore(
    subscribe,
    () => identities,
    () => identities
  );
}
