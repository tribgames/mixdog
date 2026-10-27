// The primary agent's (Mixy's) status as this renderer knows it: whether it
// was created (getLeadStatus, decided by the host: main/mixy-first.ts) and the
// name and face the user gave it (agents/lead/agent.json `name`/`avatar`).
// Every surface that names or draws Mixy reads it here: '' / null fall back to
// "Mixy" and Mixy's pup.
import { useEffect, useSyncExternalStore } from 'react';
import { type AgentAvatarValue, normalizeAgentAvatar } from '../../../../src/runtime/shared/agent-avatar.mjs';
import type { DesktopApi } from '../shared/contract';
import { invalidateSidebarReferenceForMutation } from './sidebar-reference-cache';

export const MIXY_DEFAULT_NAME = 'Mixy';

export interface MixyStatus {
  /** null: not answered yet. A failed read is no answer: it stays null and
   *  is read again (READ_RETRY_MS), never taken as created. */
  created: boolean | null;
  name: string;
  avatar: AgentAvatarValue | null;
}

type StatusApi = Partial<Pick<DesktopApi, 'invokeCapability'>> | undefined;

const UNREAD: MixyStatus = { created: null, name: '', avatar: null };
let status: MixyStatus = UNREAD;
let reading: Promise<void> | null = null;
/** The 대표 에이전트 dialog was dismissed (or Mixy created) in this run: the
 *  starter guide's welcome may show. */
let dialogSettled = false;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Adopt a host answer (getLeadStatus / setLeadCreated / saveLeadIdentity). */
export function publishMixyStatus(value: unknown): void {
  const next = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const updated: MixyStatus = {
    created: typeof next.created === 'boolean' ? next.created : (status.created ?? next.created !== false),
    name: typeof next.name === 'string' ? next.name.trim() : status.name,
    avatar: 'avatar' in next ? (normalizeAgentAvatar(next.avatar) ?? null) : status.avatar,
  };
  const renamed = updated.name !== status.name || JSON.stringify(updated.avatar) !== JSON.stringify(status.avatar);
  if (!renamed && updated.created === status.created) return;
  status = updated;
  if (updated.created) dialogSettled = true;
  // Contacts, rooms and tab titles are built from the agents catalog: re-read
  // it so they pick up the new name and face.
  if (renamed) invalidateSidebarReferenceForMutation('saveLeadIdentity');
  notify();
}

/** Waits before each new read after a failed one (the last one repeats). A
 *  failed read once counted as created for the rest of the run: a profile
 *  without Mixy then showed it (its row, the desktop pet) until a restart. */
export const READ_RETRY_MS = Object.freeze([2_000, 5_000, 15_000, 30_000]);
let failedReads = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every reset: a read begun before it no longer answers, retries
 *  or ends the current one. */
let generation = 0;

/** Tests: back to unread. */
export function resetMixyStatus(value: Partial<MixyStatus> | null = null): void {
  status = value ? { ...UNREAD, ...value } : UNREAD;
  generation += 1;
  reading = null;
  failedReads = 0;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  dialogSettled = false;
  notify();
}

export function readMixyStatus(api: StatusApi): void {
  if (status.created !== null || reading || retryTimer || !api?.invokeCapability) return;
  const own = generation;
  reading = Promise.resolve(api.invokeCapability({ capability: 'getLeadStatus', args: [] }))
    .then(
      (result) => {
        if (own !== generation) return;
        failedReads = 0;
        publishMixyStatus(result?.value);
      },
      () => {
        if (own !== generation) return;
        const wait = READ_RETRY_MS[Math.min(failedReads, READ_RETRY_MS.length - 1)];
        failedReads += 1;
        const timer = setTimeout(() => {
          if (retryTimer !== timer) return;
          retryTimer = null;
          readMixyStatus(api);
        }, wait);
        // Never what keeps a process (a test run) alive.
        (timer as { unref?: () => void }).unref?.();
        retryTimer = timer;
      }
    )
    .finally(() => {
      if (own === generation) reading = null;
    });
}

export function settleMixyDialog(): void {
  if (dialogSettled) return;
  dialogSettled = true;
  notify();
}

/** The display name: the user's choice, else Mixy. */
export const mixyName = (): string => status.name || MIXY_DEFAULT_NAME;
/** The stored face; null means Mixy's pup (agentAvatar's default for `lead`). */
export const mixyAvatar = (): AgentAvatarValue | null => status.avatar;

export function useMixyStatus(api: StatusApi, enabled = true): MixyStatus {
  const value = useSyncExternalStore(
    subscribe,
    () => status,
    () => status
  );
  useEffect(() => {
    if (enabled) readMixyStatus(api);
  }, [api, enabled]);
  return value;
}

export function useMixyDialogSettled(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => dialogSettled,
    () => dialogSettled
  );
}

/** Window event: show the Agents view (where the representative bot is made). */
export const OPEN_AGENTS_VIEW_EVENT = 'mixdog:open-agents-view';

// The starter guide's step (and a routine view with no bot) asks the Agents
// pane to open the dialog; a pane not mounted yet takes the request on mount.
const requests = new Set<() => void>();
let pendingRequest = false;
export function requestMixyDialog(): void {
  pendingRequest = requests.size === 0;
  for (const listener of requests) listener();
}
export function onMixyDialogRequest(listener: () => void): () => void {
  if (pendingRequest) {
    pendingRequest = false;
    queueMicrotask(listener);
  }
  requests.add(listener);
  return () => {
    requests.delete(listener);
  };
}
