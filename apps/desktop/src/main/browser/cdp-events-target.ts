/** A child target (iframe) attached under a guest: bring its CDP session up
 *  and record it, within the per-guest child-session limit. */
import type { WebContents } from 'electron';

import { MAX_CHILD_CDP_SESSIONS } from './command';
import type { BrowserGuestStateStore } from './guest-state';
import { redactBrowserUrl } from './redaction';

type CdpParams = Record<string, unknown>;

export interface TargetAttachHost {
  state: BrowserGuestStateStore;
  initializeTargetSession(
    guest: WebContents,
    cdp: Electron.Debugger,
    signal: AbortSignal,
    sessionId: string
  ): Promise<void>;
  /** The debugger lifetime of a guest, or undefined once it is gone. */
  lifetimeSignal(guest: WebContents): AbortSignal | undefined;
}

export function onAttachedToTarget(
  host: TargetAttachHost,
  guest: WebContents,
  cdp: Electron.Debugger,
  params: CdpParams,
  parentSessionId: string | undefined
): void {
  const diagnostics = host.state.for(guest);
  const attachedSessionId = String(params.sessionId || '');
  const targetInfo = (params.targetInfo && typeof params.targetInfo === 'object' ? params.targetInfo : {}) as {
    targetId?: string;
    type?: string;
    url?: string;
  };
  const lifetime = host.lifetimeSignal(guest);
  if (!lifetime || lifetime.aborted || !attachedSessionId || targetInfo.type !== 'iframe') return;
  if (diagnostics.cdpSessions.has(attachedSessionId)) return;
  if (diagnostics.cdpSessions.size >= MAX_CHILD_CDP_SESSIONS) {
    // Leave the excess session attached but uninitialized: detaching it
    // mid-navigation could exercise the native crash path. Chromium drops
    // the session by itself when the frame goes away.
    diagnostics.console.recordInternal(
      `CDP child target limit reached (${MAX_CHILD_CDP_SESSIONS}); excess iframe left unobserved`
    );
    return;
  }
  const ready = host.initializeTargetSession(guest, cdp, lifetime, attachedSessionId);
  diagnostics.cdpSessions.set(attachedSessionId, {
    type: String(targetInfo.type || 'iframe'),
    url: redactBrowserUrl(String(targetInfo.url || '').slice(0, 8_000)),
    frameId: String(targetInfo.targetId || ''),
    parentSessionId,
    ready,
  });
  ready.catch((error) =>
    diagnostics.console.recordInternal(`CDP child target initialization failed: ${(error as Error).message}`)
  );
}
