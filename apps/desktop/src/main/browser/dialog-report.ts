/**
 * Answering a blocking dialog, and saying what state the page is in. A
 * dialog opened through the page bridge is fulfilled through the bridge; a
 * native one through the CDP handler. Both clear the pending record so the
 * next observation is not reported as blocked.
 */
import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import type { BrowserCommandResult } from './command';
import { dialogBridgeFulfillParams } from './dialog-bridge';
import { redactBrowserText, redactBrowserUrl } from './redaction';

export interface PendingBrowserDialog {
  type: string;
  message: string;
  defaultPrompt?: string;
  openedAt: number;
  sessionId?: string;
  bridgeRequestId?: string;
  /** An answer is on its way, so the dialog closing now is that answer
   *  landing, not the dialog dismissed by itself. */
  answering?: boolean;
}

/** A dialog the page opened that nobody was shown: its bridge request never
 *  reached the host (`unreachable`, a page CSP refusing it, for one), or it
 *  fired where the bridge was not yet installed and Chromium dismissed it
 *  (`early`). The pane shows it as a notice; one reply reports it. */
export interface DismissedBrowserDialog {
  type: string;
  message: string;
  reason: 'unreachable' | 'early';
  reported?: boolean;
}

const DISMISSED_BECAUSE: Record<DismissedBrowserDialog['reason'], string> = {
  unreachable: 'its request never reached the browser (a page security policy can refuse it)',
  early: 'it opened before the browser was intercepting dialogs on this page',
};

/** The page-report line for a dialog that was dismissed unseen. */
export function describeDismissedDialog(dialog: DismissedBrowserDialog): string {
  return (
    `Dismissed ${dialog.type} dialog ${JSON.stringify(redactBrowserText(dialog.message))}: ` +
    `${DISMISSED_BECAUSE[dialog.reason]}, so nobody saw it and the page received a dismissal ` +
    '(confirm returns false, prompt returns null). handle_dialog has nothing to answer.'
  );
}

interface BrowserDialogReportHost {
  diagnostics(guest: WebContents): {
    pendingDialog: PendingBrowserDialog | null;
    fault: string;
    network: { pendingCount: number };
    console: { recentErrors(limit: number): string[] };
    networkFailures: string[];
  };
  cdp: BrowserCdpPort;
  pageId(guest: WebContents): string;
}

export function createBrowserDialogReport(host: BrowserDialogReportHost) {
  const { diagnostics: diagnosticsFor, cdp, pageId: stablePageId } = host;
  async function handleDialog(
    guest: WebContents,
    accept: boolean,
    promptText: string,
    signal?: AbortSignal,
    beforeDispatch?: () => void,
    /** A person accepted the prompt's default untouched: the page keeps its
     *  full default rather than the bounded copy it was shown. */
    keepDefault = false
  ): Promise<void> {
    const diagnostics = diagnosticsFor(guest);
    const pending = diagnostics.pendingDialog;
    if (!pending) throw new Error('no JavaScript dialog is currently open');
    if (pending.answering) throw new Error('Browser dialog is already being answered.');
    pending.answering = true;
    const target = {
      sessionId: pending.sessionId,
      beforeDispatch: () => {
        beforeDispatch?.();
        if (diagnostics.pendingDialog !== pending) throw new Error('Browser dialog changed; answer was not sent.');
      },
    };
    try {
      if (pending.bridgeRequestId) {
        await cdp.call(
          guest,
          'Fetch.fulfillRequest',
          dialogBridgeFulfillParams(pending.bridgeRequestId, accept, promptText, accept && keepDefault),
          signal,
          target
        );
      } else {
        await cdp.call(guest, 'Page.handleJavaScriptDialog', { accept, promptText }, signal, target);
      }
      if (diagnostics.pendingDialog === pending) diagnostics.pendingDialog = null;
    } finally {
      pending.answering = false;
    }
  }

  function diagnosticsResult(guest: WebContents): BrowserCommandResult {
    const diagnostics = diagnosticsFor(guest);
    const lines = [
      `Page: ${stablePageId(guest)} — ${redactBrowserUrl(guest.getURL() || 'about:blank')}`,
      `State: ${diagnostics.fault || (guest.isLoading() ? 'loading' : 'ready')}`,
      `Pending requests: ${diagnostics.network.pendingCount}`,
    ];
    if (diagnostics.pendingDialog) {
      lines.push(
        `Dialog: ${diagnostics.pendingDialog.type} ${JSON.stringify(redactBrowserText(diagnostics.pendingDialog.message))}`
      );
    }
    const consoleErrors = diagnostics.console.recentErrors(10);
    if (consoleErrors.length) {
      lines.push('Console errors:', ...consoleErrors.map((entry) => `- ${entry}`));
    }
    if (diagnostics.networkFailures.length) {
      lines.push('Network failures:', ...diagnostics.networkFailures.slice(-10).map((entry) => `- ${entry}`));
    }
    return { text: lines.join('\n') };
  }

  return { handleDialog, diagnosticsResult };
}
