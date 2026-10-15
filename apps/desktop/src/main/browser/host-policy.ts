/**
 * Pure decisions the browser host makes from its environment and inputs:
 * URL policy, pane viewport emulation, task-cleanup validation, pending
 * session work and how a human input competes with agent commands.
 */
import { BROWSER_INPUT_WAIT_MS, browserTypingInput } from '../../shared/browser-input-policy';
import type { DesktopBrowserPageControl, DesktopBrowserViewportConfig } from '../../shared/contract';
import type { BrowserCommand } from './command';
import type { BrowserUrlPolicy } from './url-policy';

/** Private/LAN/Tailscale addresses are the user's own network when the browser
 *  and the session's work both run on this PC, so they are allowed there. A
 *  session working against a remote server keeps them blocked. The env flag
 *  forces them allowed either way. Cloud metadata endpoints are blocked by
 *  url-policy regardless of this stance. */
export function browserUrlPolicyFromEnvironment(session: { remote: boolean }): BrowserUrlPolicy {
  return {
    allowPrivateNetwork:
      !session.remote || /^(?:1|true|yes)$/i.test(String(process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK || '')),
    allowedDomains: String(process.env.MIXDOG_BROWSER_ALLOWED_DOMAINS || '')
      .split(',')
      .map((domain) => domain.trim())
      .filter(Boolean),
  };
}

/** A fixed pane viewport becomes a full emulation command; a cleared one resets
 *  emulation so the guest goes back to following the pane's own size. */
export function browserViewportEmulation(config: DesktopBrowserViewportConfig): BrowserCommand {
  const fixedViewport =
    config.width !== null && config.height !== null ? { width: config.width, height: config.height } : null;
  const orientation = fixedViewport && fixedViewport.width > fixedViewport.height ? 'landscape' : 'portrait';
  return {
    action: 'emulate',
    reset: true,
    ...(fixedViewport
      ? {
          ...fixedViewport,
          deviceScaleFactor: config.deviceScaleFactor,
          mobile: config.mobile,
          touch: config.touch,
          userAgent: config.userAgent ?? '',
          orientation,
        }
      : {}),
  };
}

/** A task cleanup context must name a session and a real turn, and carry
 *  nothing beyond its abort flag. */
export function assertBrowserTaskCleanupContext(
  sessionId: unknown,
  turnId: unknown,
  input: Record<string, unknown>
): void {
  if (
    !sessionId ||
    !Number.isSafeInteger(turnId) ||
    Number(turnId) <= 0 ||
    Object.keys(input).some((key) => key !== 'action' && key !== 'aborted')
  ) {
    throw new Error('Invalid browser task cleanup context.');
  }
}

/** Everything still running for one session — queued commands and in-flight
 *  reads — which a turn's cleanup waits out before closing its pages. */
export function pendingSessionWork(
  prefix: string,
  chains: Map<string, Promise<unknown>>,
  reads: Map<string, Set<Promise<unknown>>>
): Promise<unknown>[] {
  return [
    ...[...chains].filter(([key]) => key.startsWith(prefix)).map(([, task]) => task),
    ...[...reads].filter(([key]) => key.startsWith(prefix)).flatMap(([, tasks]) => [...tasks]),
  ];
}

/** How a queued human input competes with agent commands: releases must still
 *  finish an already-sent press, even after a slow command. Typing retains its
 *  order behind that input; only pointer gestures expire while queued. */
export function browserLocalInputOptions(input: DesktopBrowserPageControl): {
  takeover: boolean;
  dropIfBusy?: boolean;
  held?: boolean;
  maxWaitMs?: number;
} {
  const release = input.type === 'pointer' && input.phase === 'mouseReleased';
  const hover = input.type === 'pointer' && input.phase === 'mouseMoved' && input.buttons === 0;
  return {
    takeover: !hover,
    dropIfBusy: hover,
    ...(input.type === 'pointer' && input.phase !== 'mouseMoved' ? { held: !release } : {}),
    maxWaitMs: release || browserTypingInput(input) ? undefined : BROWSER_INPUT_WAIT_MS,
  };
}
