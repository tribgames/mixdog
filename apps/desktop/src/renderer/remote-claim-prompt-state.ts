type RemoteClaimPromptListener = (active: boolean) => void;

let active = false;
const listeners = new Set<RemoteClaimPromptListener>();

export function isRemoteClaimPromptActive(): boolean {
  return active;
}

export function setRemoteClaimPromptActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of [...listeners]) listener(active);
}

export function subscribeRemoteClaimPromptActive(
  listener: RemoteClaimPromptListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
