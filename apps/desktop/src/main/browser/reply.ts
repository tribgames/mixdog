/**
 * How a command's outcome becomes the reply the agent reads. One place
 * decides whether a blocking dialog pre-empts the answer, waits for the page
 * to settle and for any postcondition, formats the fresh snapshot, binds an
 * optional screenshot to it, and prefixes the ref-recovery notes. Actions
 * produce facts; this module turns them into text.
 */
import type { WebContents } from 'electron';

import {
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserSnapshotResultOptions,
  EFFECT_REPORT_ACTIONS,
  normalizeBrowserAction,
} from './command';
import { browserDocumentChanged } from './documents';
import type { TrackedBrowserDownload } from './downloads';
import type { BrowserGuestStateStore } from './guest-state';
import { type BrowserPostcondition, describeBrowserPostcondition } from './postcondition';
import type { BrowserRefSet } from './ref-recovery';
import { createRefRecovery, decorateRecovery, refRecoveryFor } from './reply-ref-recovery';
import { attachFrame, attachScreenshot } from './reply-screenshot';
import { awaitReplyReady, type ReplyWait } from './reply-wait';
import type { BrowserScreenshotCapture } from './screenshot';
import { formatSnapshot } from './snapshot-format';

export type { BrowserRefRecoveryContext } from './reply-ref-recovery';

type SnapshotPayload = Parameters<typeof formatSnapshot>[0];

export interface BrowserReplyHost {
  state: BrowserGuestStateStore;
  settleAfterAction(
    guest: WebContents,
    signal?: AbortSignal,
    until?: Promise<unknown>,
    options?: { background?: boolean; requireQuiet?: boolean; previousUrl?: string }
  ): Promise<unknown>;
  postconditionMatchesGuest(guest: WebContents, expected: BrowserPostcondition, signal?: AbortSignal): Promise<boolean>;
  captureSnapshotPayload(guest: WebContents, command: BrowserCommand, signal?: AbortSignal): Promise<SnapshotPayload>;
  captureScreenshot(
    guest: WebContents,
    background: boolean,
    options: { format?: unknown; quality?: unknown; fullPage?: unknown },
    signal?: AbortSignal
  ): Promise<BrowserScreenshotCapture>;
  bindVisualGrounding(guest: WebContents, refSet: BrowserRefSet, capture: { width: number; height: number }): void;
  /** The owning session's download ledger, newest first. */
  downloadsForGuest(guest: WebContents): TrackedBrowserDownload[];
}

/** Downloads the caller has not heard about from this page yet. */
export function unreportedDownloads(downloads: TrackedBrowserDownload[], reportedAt: number): TrackedBrowserDownload[] {
  return downloads.filter((download) => download.startedAt > reportedAt || (download.completedAt ?? 0) > reportedAt);
}

export function createBrowserReply(host: BrowserReplyHost) {
  const { state, captureSnapshotPayload, downloadsForGuest } = host;

  /** Format the page report, folding in downloads the page has not yet
   *  mentioned and marking them reported. */
  function reportSnapshot(guest: WebContents, payload: SnapshotPayload, briefAgainst?: BrowserRefSet): string {
    const record = state.for(guest);
    const downloads = unreportedDownloads(downloadsForGuest(guest), record.downloadsReportedAt);
    record.downloadsReportedAt = Date.now();
    return state.redactText(guest, formatSnapshot(payload, record, { downloads, briefAgainst }));
  }

  function dialogResult(guest: WebContents): BrowserCommandResult | null {
    const dialog = state.for(guest).pendingDialog;
    if (!dialog) return null;
    // Chromium supplies no text for a leave-confirmation and the choice is not
    // symmetric: accepting discards whatever the page has not saved.
    if (dialog.type === 'beforeunload') {
      return {
        outcome: 'blocked',
        text:
          'The page refused to be left: it guards unsaved work with a leave confirmation, which Chromium answers by ' +
          'itself, so the navigation was abandoned and the page stayed. handle_dialog has nothing left to answer.\n' +
          'Finish or discard what the page is holding — submit, reset, or clear the form — and navigate again; ' +
          'repeating the same navigation is refused the same way.',
      };
    }
    return {
      outcome: 'blocked',
      text:
        `A ${dialog.type} dialog is blocking the page: ${JSON.stringify(state.redactText(guest, dialog.message))}\n` +
        'Call handle_dialog with accept:true or accept:false before continuing.',
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

  /** What the reply says besides the snapshot: waits that completed, pages
   *  that opened, and a gesture the page visibly ignored. */
  function effectNotes(
    guest: WebContents,
    action: string,
    payload: SnapshotPayload,
    options: BrowserSnapshotResultOptions,
    wait: ReplyWait
  ) {
    const { settleMs, expected, postconditionElapsed } = wait;
    const baseline = options.baseline;
    // A gesture the page ignored looks exactly like one that worked unless
    // the reply says so; repeating it would not help, a different target
    // might. Scroll is judged by position, everything else by the document.
    const reacted =
      options.settleAction && baseline && EFFECT_REPORT_ACTIONS.has(action)
        ? browserDocumentChanged(baseline.revision, state.peek(guest)?.refSet?.revision, {
            includeScroll: action === 'scroll',
          })
        : undefined;
    // A gesture that opened a page did something, even when this document is
    // untouched. Reporting that as "no observable change" sends the caller
    // looking for a covering element instead of the page that just opened.
    const openedPages = state.for(guest).openedPopups.splice(0);
    const unchanged = reacted === false && baseline?.url === payload.url && openedPages.length === 0;
    return [
      settleMs && `Explicit settle completed after ${settleMs}ms.`,
      expected && options.preexistingPostcondition
        ? 'Postcondition was already true before this action, so it proves nothing about it; the action executed once. Verify with a condition only this action makes true.'
        : expected && `Postcondition met after ${postconditionElapsed}ms; action executed once.`,
      openedPages.length > 0 &&
        `Opened ${openedPages.map((name) => JSON.stringify(name)).join(', ')} as a new page; ` +
          'act on it with that tab name, or call list_tabs for its URL.',
      unchanged &&
        `No observable change: the document, URL, and control values are the same as before this ${action}. ` +
          "Do not repeat the same gesture; check the element's states or covering elements, or choose another target.",
    ].filter(Boolean);
  }

  async function snapshotResult(
    guest: WebContents,
    command: BrowserCommand = { action: 'snapshot' },
    signal?: AbortSignal,
    options: BrowserSnapshotResultOptions = {}
  ): Promise<BrowserCommandResult> {
    const dialog = dialogResult(guest);
    if (dialog) return dialog;
    const wait = await awaitReplyReady(host, guest, command, options, signal);
    // Deliberately NOT deduplicated against the previous snapshot. Identical
    // page text is common precisely when a gesture reproduces the same result
    // ("Mouse dragged" twice), and that text is the only evidence the gesture
    // landed. Trading it for tokens would break the verify-after-dispatch
    // contract, so repetition stays.
    const payload = await captureSnapshotPayload(guest, command, signal);
    const action = normalizeBrowserAction(command);
    const snapshot = reportSnapshot(
      guest,
      payload,
      command.brief === true ? (options.reportBaseline ?? options.baseline) : undefined
    );
    if (wait.expected && !wait.postconditionMatched) {
      throw new Error(
        `Postcondition failed after ${wait.postconditionElapsed}ms; ` +
          `the ${action || 'browser'} action executed once and was not retried. ` +
          `Expected ${describeBrowserPostcondition(wait.expected)}.\n\n${snapshot}`
      );
    }
    const notes = effectNotes(guest, action, payload, options, wait);
    const result: BrowserCommandResult = {
      outcome: wait.expected && options.preexistingPostcondition ? 'inconclusive' : 'completed',
      text: notes.length ? `${notes.join(' ')}\n\n${snapshot}` : snapshot,
    };
    if (options.includeScreenshot || command.includeScreenshot === true) {
      await attachScreenshot(host, guest, command, result, options, signal);
    }
    return result;
  }

  const recovery = createRefRecovery(host, { dialogResult, reportSnapshot });

  return {
    refRecoveryFor: (guest: WebContents) => refRecoveryFor(state, guest),
    attachFrame,
    dialogResult,
    formatEvaluationValue,
    snapshotResult,
    withRefRecovery: recovery.withRefRecovery,
    decorateRecovery,
  };
}
