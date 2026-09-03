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
}

export interface BrowserDialogReportHost {
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
  ): Promise<void> {
    const diagnostics = diagnosticsFor(guest);
    const pending = diagnostics.pendingDialog;
    if (!pending) throw new Error('no JavaScript dialog is currently open');
    const target = { sessionId: pending.sessionId };
    if (pending.bridgeRequestId) {
      await cdp.call(
        guest,
        'Fetch.fulfillRequest',
        dialogBridgeFulfillParams(pending.bridgeRequestId, accept, promptText),
        signal,
        target,
      );
    } else {
      await cdp.call(guest, 'Page.handleJavaScriptDialog', { accept, promptText }, signal, target);
    }
    diagnostics.pendingDialog = null;
  }

  function diagnosticsResult(guest: WebContents): BrowserCommandResult {
    const diagnostics = diagnosticsFor(guest);
    const lines = [
      `Page: ${stablePageId(guest)} — ${redactBrowserUrl(guest.getURL() || 'about:blank')}`,
      `State: ${diagnostics.fault || (guest.isLoading() ? 'loading' : 'ready')}`,
      `Pending requests: ${diagnostics.network.pendingCount}`,
    ];
    if (diagnostics.pendingDialog) {
      lines.push(`Dialog: ${diagnostics.pendingDialog.type} ${JSON.stringify(redactBrowserText(diagnostics.pendingDialog.message))}`);
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
