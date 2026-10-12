// The device-connection requests waiting for an answer. One list is shared by
// the app-wide notice (RemoteClaimPrompt) and the "Connect a device" dialog, so
// an answer given in the dialog clears the notice too.
import { useSyncExternalStore } from 'react';

import type { DesktopRemoteClientClaim } from '../shared/contract';
import { remoteClientKind, type RemoteClientKind } from '../shared/remote-trust';
import { t } from './i18n';
import { deviceKindText, deviceTitle } from './remote-client-kind-label';
import { pruneRemoteClientClaims } from './remote-claim-queue';

type Claims = readonly DesktopRemoteClientClaim[];

let queue: Claims = [];
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateClaimQueue(update: (current: DesktopRemoteClientClaim[]) => DesktopRemoteClientClaim[]): void {
  queue = update([...queue]);
  for (const listener of [...listeners]) listener();
}

export function useClaimQueue(): Claims {
  return useSyncExternalStore(
    subscribe,
    () => queue,
    () => queue
  );
}

/** Answers a claim. Resolves true when the host handled it; a lost request
 *  clears the whole stale batch. A failed call rejects and keeps the queue. */
export async function resolveClaim(claim: DesktopRemoteClientClaim, approved: boolean): Promise<boolean> {
  const resolve = window.mixdogDesktop?.resolveRemoteClientClaim;
  if (!resolve) return false;
  if (claim.expiresAt <= Date.now()) {
    updateClaimQueue((current) => pruneRemoteClientClaims(current));
    return false;
  }
  const handled = await resolve(claim.claimId, approved);
  updateClaimQueue((current) => (handled ? current.filter((row) => row.claimId !== claim.claimId) : []));
  return handled;
}

/** How a claim names its device: name, kind and the platform when known. */
export function claimDisplay(claim: DesktopRemoteClientClaim): {
  name: string;
  kind: RemoteClientKind;
  kindText: string;
  type: string;
} {
  const kind: RemoteClientKind = claim.desktop ? 'pc' : remoteClientKind(claim.browser);
  const name = claim.name || claim.platform || claim.browser ? deviceTitle(claim, kind) : t('this device');
  const kindText = deviceKindText(claim, kind);
  return { name, kind, kindText, type: claim.platform ? `${kindText} · ${claim.platform}` : kindText };
}
