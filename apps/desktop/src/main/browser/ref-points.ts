/**
 * Where a gesture actually lands. A ref becomes a screen point only after the
 * page confirms the element is on top of it, and an image coordinate is
 * accepted only while the screenshot it came from still describes the page.
 * Both refuse rather than guess, because a wrong point clicks the wrong thing.
 */
import type { WebContents } from 'electron';

import { BrowserActionabilityError, waitForBrowserActionable } from './actionability';
import type { BrowserCdpPort } from './cdp';
import type { BrowserCommand } from './command';
import type { GuestSlot } from './guest-state';
import { createBrowserHitTarget } from './hit-target';
import { browserRefElementSource } from './ref-access';
import { probeRefPoint } from './ref-point-probe';
import { probeRefRect } from './ref-rect-probe';
import type { BrowserRefSet } from './ref-recovery';
import { bindVisualGrounding, type VisualGrounding, visualPoint } from './ref-visual-grounding';
import type { AccessibilityRefSnapshot } from './snapshot-capture';
import { formatSnapshot, type SnapshotDiagnosticsView } from './snapshot-format';
import { timedBrowserOperation } from './timing';

export type { VisualGrounding } from './ref-visual-grounding';

export interface BrowserRefPointHost {
  callAccessibilityRef<T>(
    guest: WebContents,
    ref: string,
    functionDeclaration: string,
    args: unknown[],
    signal?: AbortSignal
  ): Promise<{ handled: false } | { handled: true; value: T }>;
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T>;
  cdp: BrowserCdpPort;
  /** Offset of the frame a ref lives in, relative to the top document. */
  frameOffsetForSession(
    guest: WebContents,
    sessionId: string | undefined,
    signal?: AbortSignal,
    localPoint?: { x: number; y: number }
  ): Promise<{ x: number; y: number }>;
  captureSnapshotPayload(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal
  ): Promise<Parameters<typeof formatSnapshot>[0]>;
  diagnostics(guest: WebContents): SnapshotDiagnosticsView;
  /** The ref table a covered-element report re-reads before it gives up. */
  accessibilityRefs: GuestSlot<AccessibilityRefSnapshot>;
  visualGrounding: GuestSlot<VisualGrounding>;
  revision?(guest: WebContents, signal?: AbortSignal): Promise<string>;
  frames?(guest: WebContents): Map<string, { frameId?: string; parentSessionId?: string }>;
}

export function createBrowserRefPoints(host: BrowserRefPointHost) {
  const {
    cdp,
    captureSnapshotPayload,
    diagnostics: diagnosticsFor,
    accessibilityRefs: accessibilityRefsByGuest,
    visualGrounding: visualGroundingByGuest,
  } = host;
  const hitTarget = createBrowserHitTarget({
    cdp,
    frames: (guest) => host.frames?.(guest) || new Map(),
    pendingDialog: (guest) => Boolean(diagnosticsFor(guest).pendingDialog),
  });

  async function guardRef(guest: WebContents, ref: string, signal?: AbortSignal) {
    const target = accessibilityRefsByGuest.get(guest)?.refs.get(ref);
    if (target) return hitTarget.guard(guest, target, signal);
    const resolved = await cdp.call<{ result?: { objectId?: string }; exceptionDetails?: unknown }>(
      guest,
      'Runtime.evaluate',
      {
        expression: `(() => {
          ${browserRefElementSource(ref)}
          return element;
        })()`,
        returnByValue: false,
      },
      signal
    );
    if (!resolved.result?.objectId || resolved.exceptionDetails)
      throw new Error('input target is stale; take a fresh snapshot');
    return hitTarget.guard(guest, { objectId: resolved.result.objectId }, signal);
  }

  /** A covered ref waits for the blocker to clear. When it does not, the
   *  refusal carries a fresh snapshot so the blocker can be dismissed by ref. */
  async function resolveRefPoint(
    guest: WebContents,
    ref: string,
    signal?: AbortSignal
  ): Promise<{ x: number; y: number }> {
    try {
      return await waitForBrowserActionable(() => probeRefPoint(host, guest, ref, signal), signal);
    } catch (error) {
      if (!(error instanceof BrowserActionabilityError) || error.reason !== 'covered') throw error;
      // Capture guidance only after the wait expires. Capturing during each
      // probe would retire the ref we are still waiting to click.
      let fresh: Awaited<ReturnType<BrowserRefPointHost['captureSnapshotPayload']>> | null;
      try {
        fresh = await captureSnapshotPayload(guest, { action: 'snapshot', maxElements: 500 }, signal);
      } catch (captureError) {
        if (signal?.aborted) throw signal.reason || captureError;
        fresh = null;
      }
      throw new Error(
        `${error.message} Dismiss or scroll past the blocker, or act on a different element; ` +
          `an overlay is rarely named in the fresh snapshot below.\n\n` +
          (fresh ? formatSnapshot(fresh, diagnosticsFor(guest)) : 'A fresh snapshot could not be captured.')
      );
    }
  }

  function resolveRefRect(guest: WebContents, ref: string, signal?: AbortSignal) {
    return waitForBrowserActionable(() => probeRefRect(host, guest, ref, signal), signal);
  }

  return {
    resolveRefPoint: timedBrowserOperation('actionability', resolveRefPoint),
    resolveRefRect: timedBrowserOperation('actionability', resolveRefRect),
    bindVisualGrounding: (guest: WebContents, refSet: BrowserRefSet, capture: { width: number; height: number }) =>
      bindVisualGrounding(visualGroundingByGuest, guest, refSet, capture),
    visualPoint: timedBrowserOperation(
      'actionability',
      (
        guest: WebContents,
        command: BrowserCommand,
        xValue: unknown,
        yValue: unknown,
        label: string,
        signal?: AbortSignal
      ) => visualPoint(host, guest, command, xValue, yValue, label, signal)
    ),
    guardRef: timedBrowserOperation('actionability', guardRef),
  };
}
