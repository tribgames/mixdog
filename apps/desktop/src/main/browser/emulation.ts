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
  type BrowserDeviceMetrics,
  resetEmulation,
} from './emulation-overrides';
import { validateEmulationCommand } from './emulation-validation';

interface BrowserEmulationHost {
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
  const overrideGroups = [
    ['userAgent', 'locale'],
    ['colorScheme', 'reducedMotion'],
  ] as const;
  const retainedOverrides = new WeakMap<WebContents, Partial<BrowserCommand>>();
  /** The device metrics an emulate command last left on each guest (absent:
   *  none) — what a phone's fit lays over and gives back. */
  const baseMetrics = new WeakMap<WebContents, BrowserDeviceMetrics>();
  /** Guests a phone's fit currently lays out. */
  const fitted = new WeakSet<WebContents>();

  async function configureEmulation(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal
  ): Promise<string[]> {
    const validated = validateEmulationCommand(command);
    const previous = command.reset ? {} : retainedOverrides.get(guest) || {};
    const effective = { ...command };
    // CDP replaces these groups as a whole, while the public command changes
    // only the supplied switches. Preserve their previously applied siblings.
    for (const group of overrideGroups) {
      if (!group.some((key) => command[key] !== undefined)) continue;
      for (const key of group) {
        if (effective[key] === undefined && previous[key] !== undefined) {
          Object.assign(effective, { [key]: previous[key] });
        }
      }
    }
    const finishViewportChange = command.reset || validated.hasViewport ? host.beginViewportChange?.(guest) : undefined;
    try {
      const applied: string[] = [];
      if (command.reset) {
        await resetEmulation(cdp, guest, signal);
        retainedOverrides.delete(guest);
        baseMetrics.delete(guest);
        applied.push('reset');
      }
      if (validated.hasViewport) {
        const { label, viewport, metrics } = await applyViewportOverride(cdp, guest, command, signal);
        baseMetrics.set(guest, metrics);
        applied.push(label);
        onViewportChanged?.(guest, viewport);
      } else if (command.reset) {
        onViewportChanged?.(guest, null);
      }
      applied.push(...(await applyIdentityOverrides(cdp, guest, effective, signal)));
      applied.push(...(await applyPreferenceOverrides(cdp, guest, effective, validated.networkProfile, signal)));
      applied.push(...(await applyContextOverrides(cdp, guest, command, signal)));
      if (!applied.length) {
        throw new Error(
          'emulate requires reset and/or a viewport, touch, userAgent, locale, timezone, media, CPU, network, geolocation, or headers setting'
        );
      }
      const retained = { ...previous };
      for (const key of overrideGroups.flat()) {
        if (effective[key] !== undefined) Object.assign(retained, { [key]: effective[key] });
      }
      retainedOverrides.set(guest, retained);
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

  /** Run one device-metrics change with presentation held, then report it. */
  async function changeMetrics(guest: WebContents, run: () => Promise<{ width: number; height: number } | null>) {
    const finish = host.beginViewportChange?.(guest);
    try {
      const viewport = await run();
      onViewportChanged?.(guest, viewport);
      invalidateInteractionState(guest);
    } finally {
      finish?.();
    }
  }

  /** A phone's fit: only the device metrics change — size and scale factor,
   *  keeping the guest's mobile flag — and no other emulation domain (user
   *  agent, touch, locale, geolocation, headers, media, CPU, network) is reset
   *  or touched. `unfitMetrics` gives back exactly the metrics before it. */
  async function fitMetrics(
    guest: WebContents,
    viewport: { width: number; height: number; deviceScaleFactor: number }
  ): Promise<void> {
    const base = baseMetrics.get(guest);
    const landscape = viewport.width > viewport.height;
    await changeMetrics(guest, async () => {
      await cdp.call(guest, 'Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: base?.mobile ?? false,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
        screenOrientation: landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
      } satisfies BrowserDeviceMetrics);
      return { width: viewport.width, height: viewport.height };
    });
    // Only an applied fit has metrics to give back.
    fitted.add(guest);
  }

  /** The fit ended: the metrics an emulate command last set come back (an
   *  agent's change during the fit included), or none. */
  async function unfitMetrics(guest: WebContents): Promise<void> {
    if (!fitted.has(guest)) return;
    fitted.delete(guest);
    const base = baseMetrics.get(guest);
    await changeMetrics(guest, async () => {
      if (!base) {
        await cdp.call(guest, 'Emulation.clearDeviceMetricsOverride', {});
        return null;
      }
      await cdp.call(guest, 'Emulation.setDeviceMetricsOverride', base);
      return { width: base.width, height: base.height };
    });
  }

  return { applyEmulation, configureEmulation, fitMetrics, unfitMetrics };
}
