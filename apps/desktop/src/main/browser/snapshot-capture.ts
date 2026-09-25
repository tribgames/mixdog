/**
 * Turning a live page into one addressable observation: the accessibility
 * tree merged across cross-origin frames, the refs the agent will name, and
 * the payload a report is written from. Refs live here because this is what
 * mints them; everything downstream only reads them.
 */
import type { WebContents } from 'electron';

import {
  buildAccessibilitySnapshot,
  type AccessibilityPageInfo,
  type BrowserSnapshotPayload as SnapshotPayload,
} from './accessibility';
import type { BrowserCdpPort } from './cdp';
import { boundedInteger, type BrowserCommand } from './command';
import type { GuestSlot } from './guest-state';
import { redactBrowserText } from './redaction';
import { createBrowserRefSet, type BrowserRefSet } from './ref-recovery';
import { type BrowserTargetSession, readAccessibilityTargets } from './snapshot-accessibility-read';
import { createFrameOffsetResolver } from './snapshot-frame-offset';
import { type AccessibilityRef, type AccessibilityRefSnapshot, createSnapshotRefCalls } from './snapshot-ref-calls';
import { browserSnapshotExpression } from './snapshot-scripts';
import { timedBrowserOperation } from './timing';

export { fileInputsFromDomSnapshot } from './snapshot-accessibility-read';
export type { AccessibilityRef, AccessibilityRefSnapshot } from './snapshot-ref-calls';

export interface BrowserSnapshotCaptureHost {
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal, timeoutMs?: number): Promise<T>;
  cdp: BrowserCdpPort;
  /** The CDP target sessions this page has attached, for frame geometry, and
   *  the fault line a degraded snapshot reports through. */
  diagnostics(guest: WebContents): {
    cdpSessions: Map<string, BrowserTargetSession>;
    fault: string;
  };
  /** Cleared whenever a fresh snapshot invalidates image-bound coordinates. */
  visualGrounding: GuestSlot<unknown>;
  snapshotTextLimit(command: BrowserCommand): number;
  nextSnapshotId(guest: WebContents): string;
  documentGeneration?(guest: WebContents): number;
  revision?(guest: WebContents, signal?: AbortSignal): Promise<string>;
  accessibilityRefs: GuestSlot<AccessibilityRefSnapshot>;
  refSets: GuestSlot<BrowserRefSet>;
  maxElements: number;
}

/** One read of the body: innerText reflows the page, and a long document is
 *  exactly where a second read would hurt. The excerpt stops at a cap; the
 *  report has to say so rather than let a long page read as a short one. */
function pageInfoExpression(snapshotTextChars: number): string {
  return `(() => {
      // A <frameset> body holds only the unseen <noframes> fallback.
      const readable = document.body && document.body.tagName !== 'FRAMESET';
      const raw = String(readable ? (document.body.innerText || document.body.textContent || '') : '');
      const normalized = raw.slice(0, ${snapshotTextChars * 4}).replace(/\\s+/g, ' ').trim();
      return {
        url: String(location.href),
        title: String(document.title || ''),
        scrollY: Math.round(window.scrollY),
        scrollHeight: Math.round(document.documentElement.scrollHeight),
        viewportHeight: Math.round(window.innerHeight),
        viewportWidth: Math.round(window.innerWidth),
        text: normalized.slice(0, ${snapshotTextChars}),
        textClipped: raw.length > ${snapshotTextChars * 4} || normalized.length > ${snapshotTextChars},
      };
    })()`;
}

function appendWarning(payload: SnapshotPayload, warning: string): void {
  payload.warnings = [...(payload.warnings || []), warning];
}

export function createBrowserSnapshotCapture(host: BrowserSnapshotCaptureHost) {
  const {
    evaluate,
    cdp,
    diagnostics: diagnosticsFor,
    snapshotTextLimit,
    nextSnapshotId,
    accessibilityRefs: accessibilityRefsByGuest,
    refSets: latestRefSetsByGuest,
    visualGrounding: visualGroundingByGuest,
    maxElements: SNAPSHOT_MAX_ELEMENTS,
  } = host;
  const refCalls = createSnapshotRefCalls({ cdp, evaluate, accessibilityRefs: accessibilityRefsByGuest });
  const frameOffsetForSession = createFrameOffsetResolver({
    cdp,
    sessions: (guest) => diagnosticsFor(guest).cdpSessions,
  });

  async function captureAccessibilitySnapshot(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal
  ): Promise<SnapshotPayload> {
    const diagnostics = diagnosticsFor(guest);
    const snapshotTextChars = snapshotTextLimit(command);
    const pageInfoPromise = evaluate<AccessibilityPageInfo>(guest, pageInfoExpression(snapshotTextChars), signal);
    const [pageInfo, targets] = await Promise.all([
      pageInfoPromise,
      readAccessibilityTargets(cdp, guest, diagnostics.cdpSessions, signal),
    ]);
    if (!targets.snapshots.some((snapshot) => snapshot.nodes.length > 0)) {
      throw new Error('CDP accessibility tree is unavailable');
    }

    const snapshotId = nextSnapshotId(guest);
    const built = buildAccessibilitySnapshot({
      pageInfo,
      targets: targets.snapshots,
      snapshotId,
      query: command.query,
      viewportOnly: command.viewportOnly,
      maxElements: boundedInteger(command.maxElements, SNAPSHOT_MAX_ELEMENTS, 1, 500),
      textChars: snapshotTextChars,
    });
    if (targets.omittedTargets) {
      appendWarning(
        built.payload,
        `${targets.omittedTargets} additional cross-origin frame target(s) were omitted from this snapshot.`
      );
    }
    if (targets.omittedFrames) {
      appendWarning(
        built.payload,
        `${targets.omittedFrames} additional frame document(s) were omitted from this snapshot.`
      );
    }
    const refs = new Map<string, AccessibilityRef>();
    for (const ref of built.refs) {
      refs.set(ref.ref, { backendNodeId: ref.backendNodeId, sessionId: ref.sessionId });
    }
    accessibilityRefsByGuest.set(guest, { snapshotId, refs });
    return built.payload;
  }

  async function captureSnapshotPayload(
    guest: WebContents,
    command: BrowserCommand = { action: 'snapshot' },
    signal?: AbortSignal
  ): Promise<SnapshotPayload> {
    const diagnostics = diagnosticsFor(guest);
    const generation = host.documentGeneration?.(guest);
    const revision = await host.revision?.(guest, signal);
    const snapshotTextChars = snapshotTextLimit(command);
    if (diagnostics.fault) {
      throw new Error(`${diagnostics.fault}; navigate to reload this page or choose another tab`);
    }
    let payload: SnapshotPayload;
    try {
      payload = await captureAccessibilitySnapshot(guest, command, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      accessibilityRefsByGuest.delete(guest);
      payload = await evaluate<SnapshotPayload>(
        guest,
        browserSnapshotExpression({
          snapshotId: nextSnapshotId(guest),
          maxElements: command.maxElements || SNAPSHOT_MAX_ELEMENTS,
          textChars: snapshotTextChars,
          query: command.query,
          viewportOnly: command.viewportOnly,
        }),
        signal
      );
      payload.warnings = [
        `CDP accessibility unavailable; using DOM fallback: ${redactBrowserText((error as Error).message || String(error))}`,
      ];
    }
    if (host.documentGeneration?.(guest) !== generation) {
      accessibilityRefsByGuest.delete(guest);
      throw new Error('document changed during observation; take a fresh snapshot');
    }
    latestRefSetsByGuest.set(guest, { ...createBrowserRefSet(payload), revision });
    visualGroundingByGuest.delete(guest);
    return payload;
  }

  return {
    captureAccessibilitySnapshot,
    callAccessibilityRef: refCalls.callAccessibilityRef,
    evaluateRefScript: refCalls.evaluateRefScript,
    frameOffsetForSession,
    captureSnapshotPayload: timedBrowserOperation('snapshot', captureSnapshotPayload),
  };
}
