/**
 * Device emulation: viewport, touch, user agent, locale, timezone, media
 * preferences, CPU, and network conditions. Every switch is one CDP override,
 * so this only needs a way to talk CDP and a way to report the page afterwards.
 */
import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import type { BrowserCommand, BrowserCommandResult, BrowserSnapshotResultOptions } from './command';
import {
  applyContextOverrides,
  applyIdentityOverrides,
  applyPreferenceOverrides,
  applyViewportOverride,
  resetEmulation,
} from './emulation-overrides';
import { validateEmulationCommand } from './emulation-validation';

export interface BrowserEmulationHost {
  cdp: BrowserCdpPort;
  /** An override changes the page, so refs taken before it are no longer safe. */
  invalidateInteractionState(guest: WebContents): void;
  /** Hold presentation until the complete metrics override has settled. */
  beginViewportChange?(guest: WebContents): () => void;
  /** Device metrics were set (size) or cleared (null) on this guest. The pane
   *  that shows it mirrors the size as a centered device frame. */
  onViewportChanged?(guest: WebContents, viewport: { width: number; height: number } | null): void;
  snapshotResult(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal,
    options?: BrowserSnapshotResultOptions
  ): Promise<BrowserCommandResult>;
}

export function createBrowserEmulation(host: BrowserEmulationHost) {
  const { cdp, invalidateInteractionState, snapshotResult, onViewportChanged } = host;

  async function configureEmulation(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal
  ): Promise<string[]> {
    const validated = validateEmulationCommand(command);
    const finishViewportChange = command.reset || validated.hasViewport ? host.beginViewportChange?.(guest) : undefined;
    try {
      const applied: string[] = [];
      if (command.reset) {
        await resetEmulation(cdp, guest, signal);
        applied.push('reset');
      }
      if (validated.hasViewport) {
        const { label, viewport } = await applyViewportOverride(cdp, guest, command, signal);
        applied.push(label);
        onViewportChanged?.(guest, viewport);
      } else if (command.reset) {
        onViewportChanged?.(guest, null);
      }
      applied.push(...(await applyIdentityOverrides(cdp, guest, command, signal)));
      applied.push(...(await applyPreferenceOverrides(cdp, guest, command, validated.networkProfile, signal)));
      applied.push(...(await applyContextOverrides(cdp, guest, command, signal)));
      if (!applied.length) {
        throw new Error(
          'emulate requires reset and/or a viewport, touch, userAgent, locale, timezone, media, CPU, network, geolocation, or headers setting'
        );
      }
      invalidateInteractionState(guest);
      return applied;
    } finally {
      finishViewportChange?.();
    }
  }

  async function applyEmulation(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal,
    options: BrowserSnapshotResultOptions = {}
  ): Promise<BrowserCommandResult> {
    const applied = await configureEmulation(guest, command, signal);
    const snapshot = await snapshotResult(guest, command, signal, {
      ...options,
      settleAction: true,
    });
    return {
      ...snapshot,
      text: `Emulation configured: ${applied.join(', ')}\n\n${snapshot.text}`,
    };
  }

  return { applyEmulation, configureEmulation };
}
