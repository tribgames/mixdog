/**
 * One persisted line per page fault report (a crash, an unresponsive page, a
 * main-frame load that failed), so a fault screen can be told apart later:
 * which signal fired, whether it was the page itself or a child target, and
 * on which host. The main process installs the sink that writes it to the
 * desktop diagnostics file.
 */
import type { WebContents } from 'electron';

export interface PageFaultDiagnostic {
  source: 'inspector' | 'render-process-gone' | 'unresponsive' | 'did-fail-load';
  scope: 'root' | 'child';
  /** CDP target type of a child, when known. */
  childType?: string;
  reason: string;
  exitCode?: number;
  /** Chromium net error code of a failed load. */
  errorCode?: number;
  /** Host of the page address only; never a path or query. */
  host: string;
}

let sink: ((entry: PageFaultDiagnostic) => void) | undefined;

export function setPageFaultDiagnosticSink(next: typeof sink): void {
  sink = next;
}

export function reportPageFault(guest: WebContents, entry: Omit<PageFaultDiagnostic, 'host'>): void {
  if (!sink) return;
  let host = '';
  try {
    host = new URL(guest.getURL()).host;
  } catch {
    // No address yet (blank or not a URL): the host stays empty.
  }
  sink({ ...entry, host });
}
