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
  /** null: not read yet. A failed read counts as created: nobody is ever blocked. */
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

/** Tests: back to unread. */
export function resetMixyStatus(value: Partial<MixyStatus> | null = null): void {
  status = value ? { ...UNREAD, ...value } : UNREAD;
  reading = null;
  dialogSettled = false;
  notify();
}

export function readMixyStatus(api: StatusApi): void {
  if (status.created !== null || reading || !api?.invokeCapability) return;
  reading = Promise.resolve(api.invokeCapability({ capability: 'getLeadStatus', args: [] }))
    .then((result) => publishMixyStatus(result?.value))
    .catch(() => publishMixyStatus({ created: true }))
    .finally(() => {
      reading = null;
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

// The onboarding wizard (open or still deciding), as the app shell knows it
// (published by StarterGuide): the 대표 에이전트 dialog waits for it.
let onboardingActive = false;
export function setOnboardingActive(value: boolean): void {
  if (onboardingActive === value) return;
  onboardingActive = value;
  notify();
}
export function useOnboardingActive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => onboardingActive,
    () => onboardingActive
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
