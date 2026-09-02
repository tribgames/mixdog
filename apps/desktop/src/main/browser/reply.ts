/**
 * How a command's outcome becomes the reply the agent reads. One place
 * decides whether a blocking dialog pre-empts the answer, waits for the page
 * to settle and for any postcondition, formats the fresh snapshot, binds an
 * optional screenshot to it, and prefixes the ref-recovery notes. Actions
 * produce facts; this module turns them into text.
 */
import type { WebContents } from 'electron';

import { persistFrameImage } from '../frame-files';
import {
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserSnapshotResultOptions,
  POSTCONDITION_POLL_MS,
} from './command';
import type { TrackedBrowserDownload } from './downloads';
import type { BrowserGuestStateStore } from './guest-state';
import { redactBrowserText } from './host-policy';
import {
  describeBrowserPostcondition,
  normalizeBrowserPostcondition,
  normalizeBrowserSettleMs,
  type BrowserPostcondition,
} from './postcondition';
import {
  isBrowserStaleRefError,
  recoverBrowserRef,
  type BrowserRefSet,
} from './ref-recovery';
import type { BrowserScreenshotCapture } from './screenshot';
import { pause } from './settle';
import { formatSnapshot } from './snapshot-format';

/** Refs a command may address, and which of them were transparently swapped
 *  for a fresh equivalent before dispatch. */
export interface BrowserRefRecoveryContext {
  source?: BrowserRefSet;
  replacements: Map<string, string>;
  attempted: Set<string>;
  notes: string[];
}

export interface BrowserReplyHost {
  state: BrowserGuestStateStore;
  settleAfterAction(
    guest: WebContents,
    signal?: AbortSignal,
    until?: Promise<unknown>,
  ): Promise<unknown>;
  postconditionMatchesGuest(
    guest: WebContents,
    expected: BrowserPostcondition,
    signal?: AbortSignal,
  ): Promise<boolean>;
  captureSnapshotPayload(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<Parameters<typeof formatSnapshot>[0]>;
  captureScreenshot(
    guest: WebContents,
    background: boolean,
    options: { format?: unknown; quality?: unknown; fullPage?: unknown },
    signal?: AbortSignal,
  ): Promise<BrowserScreenshotCapture>;
  bindVisualGrounding(
    guest: WebContents,
    refSet: BrowserRefSet,
    capture: { width: number; height: number },
  ): void;
  /** The owning session's download ledger, newest first. */
  downloadsForGuest(guest: WebContents): TrackedBrowserDownload[];
}

/** Downloads the caller has not heard about from this page yet. */
export function unreportedDownloads(
  downloads: TrackedBrowserDownload[],
  reportedAt: number,
): TrackedBrowserDownload[] {
  return downloads.filter((download) => download.startedAt > reportedAt
    || (download.completedAt ?? 0) > reportedAt);
}

export function createBrowserReply(host: BrowserReplyHost) {
  const {
    state,
    settleAfterAction,
    postconditionMatchesGuest,
    captureSnapshotPayload,
    captureScreenshot,
    bindVisualGrounding,
    downloadsForGuest,
  } = host;

  /** Format the page report, folding in downloads the page has not yet
   *  mentioned and marking them reported. */
  function reportSnapshot(
    guest: WebContents,
    payload: Parameters<typeof formatSnapshot>[0],
  ): string {
    const record = state.for(guest);
    const downloads = unreportedDownloads(downloadsForGuest(guest), record.downloadsReportedAt);
    record.downloadsReportedAt = Date.now();
    return formatSnapshot(payload, record, { downloads });
  }

  function refRecoveryFor(guest: WebContents): BrowserRefRecoveryContext {
    return {
      source: state.peek(guest)?.refSet,
      replacements: new Map(),
      attempted: new Set(),
      notes: [],
    };
  }

  /** Where a screenshot goes: into the reply, or beside the run when the caller
   *  asked to keep pixels out of the conversation. A frame that cannot be
   *  written stays in the reply rather than disappearing. */
  function attachFrame(
    result: BrowserCommandResult,
    command: BrowserCommand,
    capture: { mimeType: string; data: string },
    frameId: string,
  ): BrowserCommandResult {
    if (String(command.image_output || 'inline') === 'file') {
      const stored = persistFrameImage(
        'browser',
        String(command.session_id || 'browser'),
        frameId,
        capture,
      );
      if (stored) {
        result.text += `\n\nFrame written to ${stored.path} (${stored.bytes} bytes).`;
        return result;
      }
    }
    result.image = { mimeType: capture.mimeType, data: capture.data };
    return result;
  }

  function dialogResult(guest: WebContents): BrowserCommandResult | null {
    const dialog = state.for(guest).pendingDialog;
    if (!dialog) return null;
    return {
      text: `A ${dialog.type} dialog is blocking the page: ${JSON.stringify(redactBrowserText(dialog.message))}\n`
        + 'Call handle_dialog with accept:true or accept:false before continuing.',
    };
  }

  function formatEvaluationValue(guest: WebContents, value: unknown, maxChars: number): string {
    let rendered: string;
    if (value === undefined) rendered = 'undefined';
    else if (typeof value === 'string') rendered = value;
    else {
      try {
        rendered = JSON.stringify(value, null, 2);
      } catch {
        rendered = String(value);
      }
      if (rendered === undefined) rendered = String(value);
    }
    const redacted = state.redactText(guest, rendered);
    if (redacted.length <= maxChars) return redacted;
    return `${redacted.slice(0, maxChars)}\n[truncated: ${redacted.length - maxChars} more characters]`;
  }

  async function snapshotResult(
    guest: WebContents,
    command: BrowserCommand = { action: 'snapshot' },
    signal?: AbortSignal,
    options: BrowserSnapshotResultOptions = {},
  ): Promise<BrowserCommandResult> {
    const dialog = dialogResult(guest);
    if (dialog) return dialog;
    const settleMs = normalizeBrowserSettleMs(command.settleMs);
    const expected = options.expected === undefined
      ? normalizeBrowserPostcondition(command.expect)
      : options.expected;
    let postconditionElapsed = 0;
    let postconditionMatched = true;
    let announcePostcondition: () => void = () => undefined;
    const postconditionSatisfied = new Promise<void>((resolve) => {
      announcePostcondition = resolve;
    });
    const waitForPostcondition = async (): Promise<void> => {
      if (!expected) return;
      const startedAt = Date.now();
      for (;;) {
        if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
        postconditionElapsed = Date.now() - startedAt;
        if (await postconditionMatchesGuest(guest, expected, signal)) {
          announcePostcondition();
          break;
        }
        if (postconditionElapsed >= expected.timeoutMs) {
          postconditionMatched = false;
          break;
        }
        // The poll interval is the floor on how fast a verified action can
        // return; each probe is one small page evaluation.
        await pause(POSTCONDITION_POLL_MS, signal);
      }
    };
    await Promise.all([
      options.settleAction
        ? settleAfterAction(
          guest,
          signal,
          // A condition that was already true before the gesture proves nothing
          // about this one, so it may never cut the settle short.
          expected && !options.preexistingPostcondition ? postconditionSatisfied : undefined,
        )
        : Promise.resolve(),
      settleMs ? pause(settleMs, signal) : Promise.resolve(),
      waitForPostcondition(),
    ]);
    // Deliberately NOT deduplicated against the previous snapshot. Identical
    // page text is common precisely when a gesture reproduces the same result
    // ("Mouse dragged" twice), and that text is the only evidence the gesture
    // landed. Trading it for tokens would break the verify-after-dispatch
    // contract, so repetition stays.
    const payload = await captureSnapshotPayload(guest, command, signal);
    const snapshot = reportSnapshot(guest, payload);
    if (expected && !postconditionMatched) {
      throw new Error(
        `Postcondition failed after ${postconditionElapsed}ms; `
        + `the ${String(command.action || 'browser')} action executed once and was not retried. `
        + `Expected ${describeBrowserPostcondition(expected)}.\n\n${snapshot}`,
      );
    }
    const notes = [
      settleMs && `Explicit settle completed after ${settleMs}ms.`,
      expected && options.preexistingPostcondition
        ? 'Postcondition is inconclusive because it was already satisfied before input dispatch; action executed once.'
        : expected && `Postcondition met after ${postconditionElapsed}ms; action executed once.`,
    ].filter(Boolean);
    const result: BrowserCommandResult = {
      text: notes.length ? `${notes.join(' ')}\n\n${snapshot}` : snapshot,
    };
    if (options.includeScreenshot || command.includeScreenshot === true) {
      const refSet = state.peek(guest)?.refSet;
      if (!refSet) throw new Error('browser screenshot could not bind to the fresh snapshot');
      const capture = await captureScreenshot(
        guest,
        options.targetIsBackground === true,
        command,
        signal,
      );
      if (capture.fullPage) {
        result.text += `\n\nFull-page screenshot: ${capture.width}x${capture.height} px; inspection-only and not coordinate-bound.`;
      } else {
        bindVisualGrounding(guest, refSet, capture);
        result.text += `\n\nVisual screenshot: ${refSet.snapshotId} is ${capture.width}x${capture.height} image px; viewport ${refSet.viewportWidth}x${refSet.viewportHeight} CSS px. Coordinate actions require this snapshotId and use image-pixel coordinates.`;
      }
      attachFrame(result, command, capture, refSet.snapshotId);
    }
    return result;
  }

  /** Run a ref-addressed operation, transparently swapping a stale ref for
   *  its fresh equivalent once. The action itself is never replayed. */
  async function withRefRecovery<T>(
    guest: WebContents,
    context: BrowserRefRecoveryContext,
    sourceRef: string,
    operation: (ref: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const source = context.source?.refs.get(sourceRef);
    if (!source) {
      throw new Error(`ref ${sourceRef} is not from the latest snapshot; take a fresh snapshot first`);
    }
    const effectiveRef = context.replacements.get(sourceRef) || sourceRef;
    try {
      return await operation(effectiveRef);
    } catch (error) {
      if (!isBrowserStaleRefError(error) || context.attempted.has(sourceRef)) throw error;
      context.attempted.add(sourceRef);
      if (guest.getURL() !== source.url) {
        throw new Error(`ref ${sourceRef} became stale after navigation; automatic recovery will not cross URLs`);
      }
      const dialog = dialogResult(guest);
      if (dialog) throw new Error(dialog.text);
      const freshPayload = await captureSnapshotPayload(
        guest,
        { action: 'snapshot', maxElements: 500 },
        signal,
      );
      const fresh = state.peek(guest)?.refSet;
      if (!fresh) throw error;
      for (const [originalRef, fingerprint] of context.source?.refs || []) {
        const recovered = recoverBrowserRef(fingerprint, fresh);
        if (recovered.ref) context.replacements.set(originalRef, recovered.ref);
      }
      const recovered = recoverBrowserRef(source, fresh);
      if (!recovered.ref) {
        throw new Error(
          `ref ${sourceRef} became stale; automatic recovery stopped because ${recovered.reason}.\n\n`
          + reportSnapshot(guest, freshPayload),
        );
      }
      context.replacements.set(sourceRef, recovered.ref);
      context.notes.push(`${sourceRef} -> ${recovered.ref}`);
      return await operation(recovered.ref);
    }
  }

  function decorateRecovery(
    result: BrowserCommandResult,
    context: BrowserRefRecoveryContext,
  ): BrowserCommandResult {
    if (!context.notes.length) return result;
    return {
      ...result,
      text: `Automatic ref recovery before input dispatch (no action replay): ${context.notes.join(', ')}\n\n${result.text}`,
    };
  }

  return {
    refRecoveryFor,
    attachFrame,
    dialogResult,
    formatEvaluationValue,
    snapshotResult,
    withRefRecovery,
    decorateRecovery,
  };
}
