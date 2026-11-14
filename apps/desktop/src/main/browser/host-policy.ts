/**
 * Pure decisions the browser host makes from its environment and inputs:
 * URL policy, pane viewport emulation, task-cleanup validation, pending
 * session work and how a human input competes with agent commands.
 */
import type { WebContents } from 'electron';

import type { EmulationSpec } from '../../../../../packages/protocol/src/index.ts';
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

/** The `emulate` command the agent's overrides make, with the pane's fixed
 *  viewport laid under them: the size, scale factor, mobile flag and
 *  orientation only make sense together, so an override of one of them keeps
 *  the pane's size for the part it leaves out instead of being refused. */
export function mergeEmulationOverrides(
  overrides: EmulationSpec,
  pane: DesktopBrowserViewportConfig | null
): BrowserCommand {
  const command: BrowserCommand = { action: 'emulate' };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null) Object.assign(command, { [key]: value });
  }
  if (!pane || pane.width === null || pane.height === null) return command;
  const sizeParts = [command.width, command.height].filter((value) => value !== undefined).length;
  const shapesViewport = [command.deviceScaleFactor, command.mobile, command.orientation].some(
    (value) => value !== undefined
  );
  if (sizeParts === 1 || (sizeParts === 0 && shapesViewport)) {
    command.width ??= pane.width;
    command.height ??= pane.height;
  }
  return command;
}

/** The one owner of a page's emulation: the pane's viewport and the agent's
 *  overrides both go through it, so clearing the agent's overrides gives the
 *  page back to the pane's viewport rather than to none. `configure` is the
 *  emulation tool's `configureEmulation`. */
export function createBrowserEmulationOwner(host: {
  configure(guest: WebContents, command: BrowserCommand, signal?: AbortSignal): Promise<string[]>;
}) {
  const panes = new WeakMap<WebContents, DesktopBrowserViewportConfig>();
  return {
    /** The pane's viewport the page was last given (null: none was chosen). */
    paneViewport: (guest: WebContents): DesktopBrowserViewportConfig | null => panes.get(guest) ?? null,
    /** A pane preset: replaces every emulation of the page, the agent's included. */
    async applyPane(guest: WebContents, config: DesktopBrowserViewportConfig, signal?: AbortSignal): Promise<void> {
      panes.set(guest, config);
      await host.configure(guest, browserViewportEmulation(config), signal);
    },
    /** The agent's overrides on top of what the page has; `null` clears them
     *  and the pane's viewport is what remains. The returned spec is what the
     *  agent now has in force; `labelled` is given what was configured, in the
     *  command's words, the siblings of a group the page kept included. */
    async applyAgent(
      guest: WebContents,
      overrides: EmulationSpec | null,
      signal?: AbortSignal,
      labelled?: (labels: string[]) => void
    ): Promise<EmulationSpec | null> {
      const pane = panes.get(guest) ?? null;
      if (overrides === null) {
        await host.configure(guest, pane ? browserViewportEmulation(pane) : { action: 'emulate', reset: true }, signal);
        return null;
      }
      const command = mergeEmulationOverrides(overrides, pane);
      const labels = await host.configure(guest, command, signal);
      labelled?.(labels);
      const { action: _action, ...applied } = command;
      return applied as EmulationSpec;
    },
  };
}

export type BrowserEmulationOwner = ReturnType<typeof createBrowserEmulationOwner>;

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
