/**
 * A page's fault line, as the pane shows it: a crashed or unresponsive
 * renderer, and a main-frame load that never arrived. A new load clears a
 * load failure; a finished error document does not.
 */
import type { WebContents } from 'electron';

import type { BrowserGuestStateStore } from './guest-state';
import { redactBrowserUrl } from './redaction';

/** Prefix of a fault set by a failed main-frame load; a new load clears it. */
const LOAD_FAULT = 'page failed to load: ';

export function watchPageFaults(state: BrowserGuestStateStore, guest: WebContents): void {
  guest.on('render-process-gone', (_event, details) => {
    state.markCrashed(guest, `renderer ${details.reason}${details.exitCode ? ` (exit ${details.exitCode})` : ''}`);
  });
  guest.on('unresponsive', () => {
    state.for(guest).fault = 'page became unresponsive';
  });
  guest.on('responsive', () => {
    state.for(guest).fault = '';
  });
  guest.on('did-finish-load', () => {
    const record = state.for(guest);
    // The error document of a failed load also finishes loading; only the
    // next navigation clears that failure.
    if (!record.fault.startsWith(LOAD_FAULT)) record.fault = '';
    record.network.finishDocument(guest.getURL());
  });
  // A page that never arrived (refused, unreachable, bad certificate) is a
  // fault the pane shows; without it the pane sits on an empty document.
  // A superseded navigation (-3) is not a failure.
  // The address keeps two failures in a row distinct for the pane.
  guest.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    state.for(guest).fault = `${LOAD_FAULT}${description || 'unknown error'} (${code}) ${redactBrowserUrl(url)}`;
  });
  guest.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const record = state.for(guest);
    if (record.fault.startsWith(LOAD_FAULT)) record.fault = '';
  });
}
