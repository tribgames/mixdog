/**
 * A page's fault line, as the pane shows it: a crashed or unresponsive
 * renderer, and a main-frame load that never arrived. A new load clears a
 * load failure; a finished error document does not.
 */
import type { WebContents } from 'electron';

import type { BrowserGuestStateStore } from './guest-state';
import { reportPageFault } from './page-fault-diagnostics';
import { redactBrowserUrl } from './redaction';

/** Prefix of a fault set by a failed main-frame load; a new load clears it. */
const LOAD_FAULT = 'page failed to load: ';

export function watchPageFaults(state: BrowserGuestStateStore, guest: WebContents): void {
  // Electron repeats `unresponsive` while a page stays stuck; the log keeps
  // one line per episode, which ends on `responsive` or a replaced document.
  let unresponsive = false;
  guest.on('render-process-gone', (_event, details) => {
    unresponsive = false;
    reportPageFault(guest, {
      source: 'render-process-gone',
      scope: 'root',
      reason: details.reason,
      exitCode: details.exitCode,
    });
    state.markCrashed(guest, `renderer ${details.reason}${details.exitCode ? ` (exit ${details.exitCode})` : ''}`);
  });
  guest.on('unresponsive', () => {
    if (!unresponsive) {
      unresponsive = true;
      reportPageFault(guest, { source: 'unresponsive', scope: 'root', reason: 'page became unresponsive' });
    }
    state.for(guest).fault = 'page became unresponsive';
  });
  guest.on('responsive', () => {
    unresponsive = false;
    state.for(guest).fault = '';
  });
  guest.on('did-finish-load', () => {
    const record = state.for(guest);
    // The error document of a failed load also finishes loading; only the
    // next navigation clears that failure.
    if (!record.fault.startsWith(LOAD_FAULT)) record.fault = '';
    // A main-frame load after a crash is a live page again; leaving the flag
    // would reload it once more on the next command and reject remote input.
    record.crashed = false;
    record.network.finishDocument(guest.getURL());
  });
  // A page that never arrived (refused, unreachable, bad certificate) is a
  // fault the pane shows; without it the pane sits on an empty document.
  // A superseded navigation (-3) is not a failure.
  // The address keeps two failures in a row distinct for the pane.
  guest.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    // The address stays out of the log; the sink keeps only the host.
    reportPageFault(guest, {
      source: 'did-fail-load',
      scope: 'root',
      reason: description || 'unknown error',
      errorCode: code,
    });
    state.for(guest).fault = `${LOAD_FAULT}${description || 'unknown error'} (${code}) ${redactBrowserUrl(url)}`;
  });
  guest.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    unresponsive = false;
    const record = state.for(guest);
    if (record.fault.startsWith(LOAD_FAULT)) record.fault = '';
  });
}
