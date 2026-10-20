import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { t } from './i18n';
import { enqueueRemoteClientClaim, normalizeRemoteClientClaim, pruneRemoteClientClaims } from './remote-claim-queue';
import { OPEN_CONNECTION_SETTINGS_EVENT } from './remote-claim-events';
import { isRemoteClaimPromptActive, subscribeRemoteClaimPromptActive } from './remote-claim-prompt-state';
import { claimDisplay, updateClaimQueue, useClaimQueue } from './remote-claim-store';
import { requestConnectionDialog } from './settings/connection-intent';

// An installed web app runs in its own storage container: it reaches this
// desktop with no credential and asks for one, and the answer here IS the
// grant. The answer is given in Settings → Connection's "Connect a device"
// dialog; this component keeps the request list current and, while that dialog
// is not open, shows the app-wide notice that leads there.
export function RemoteClaimPrompt() {
  const queue = useClaimQueue();
  const [dialogOpen, setDialogOpen] = useState(isRemoteClaimPromptActive);
  const api = window.mixdogDesktop;

  // biome-ignore lint/correctness/useExhaustiveDependencies: api is window.mixdogDesktop; keeping it as a dependency re-subscribes if the bridge object is replaced.
  useEffect(() => {
    if (typeof api?.subscribeRemoteClientClaim !== 'function') return undefined;
    return api.subscribeRemoteClientClaim((claim) => {
      const normalized = normalizeRemoteClientClaim(claim);
      // A reloaded copy of the same container replaces its stale card instead
      // of stacking another approval behind it.
      if (normalized) updateClaimQueue((current) => enqueueRemoteClientClaim(current, normalized));
    });
  }, [api]);

  useEffect(() => subscribeRemoteClaimPromptActive(setDialogOpen), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: api is window.mixdogDesktop; keeping it as a dependency reloads the claims if the bridge object is replaced.
  useEffect(() => {
    if (typeof api?.listRemoteClientClaims !== 'function') return undefined;
    let live = true;
    void api
      .listRemoteClientClaims()
      .then((claims) => {
        if (!live) return;
        updateClaimQueue((current) =>
          claims.reduce((next, value) => {
            const normalized = normalizeRemoteClientClaim(value);
            return normalized ? enqueueRemoteClientClaim(next, normalized) : next;
          }, current)
        );
      })
      .catch(() => {
        /* the live event path remains available */
      });
    return () => {
      live = false;
      updateClaimQueue(() => []);
    };
  }, [api]);

  const claim = queue[0];

  useEffect(() => {
    if (!claim) return undefined;
    const remaining = claim.expiresAt - Date.now();
    const expire = () => updateClaimQueue((current) => pruneRemoteClientClaims(current));
    if (remaining <= 0) {
      expire();
      return undefined;
    }
    const timer = window.setTimeout(expire, remaining);
    return () => window.clearTimeout(timer);
  }, [claim]);

  if (!claim || dialogOpen) return null;
  // Same lane as the toasts: just below the main panel's tab strip, clear
  // of the title-bar controls.
  const strip = document.querySelector('.main-panel .workspace-tabs-shell')?.getBoundingClientRect();
  return createPortal(
    <div
      className="remote-claim-notice"
      data-modal-background
      role="status"
      style={strip?.height ? { top: Math.round(strip.bottom + 16) } : undefined}
    >
      <div className="remote-claim-notice-text">
        <b>{t('Device connection request')}</b>
        <span>{claimDisplay(claim).name}</span>
      </div>
      <button
        type="button"
        onClick={() => {
          requestConnectionDialog('connect');
          window.dispatchEvent(new Event(OPEN_CONNECTION_SETTINGS_EVENT));
        }}
      >
        {t('View')}
      </button>
    </div>,
    document.body
  );
}
