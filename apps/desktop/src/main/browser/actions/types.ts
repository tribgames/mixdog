/**
 * What every action handler receives. The host resolves the target page,
 * budget, postcondition and ref-recovery context once; a handler only reads
 * the command, drives the page through the shared services, and returns the
 * reply. Handlers never reach the debugger or state maps directly.
 */
import type { WebContents } from 'electron';

import type { BrowserGuestCdp } from '../cdp';
import type { BrowserCommand, BrowserCommandResult } from '../command';
import type { createBrowserDialogReport } from '../dialog-report';
import type { TrackedBrowserDownload } from '../downloads';
import type { createBrowserEmulation } from '../emulation';
import type { BrowserGuestStateStore } from '../guest-state';
import type { createBrowserInitScripts } from '../init-scripts';
import type { createBrowserInputDriver } from '../input';
import type { createBrowserIntercept } from '../intercept';
import type { createBrowserNetworkReports } from '../network';
import type { createBrowserPageState } from '../page-state';
import type { createBrowserPerformanceCommands } from '../performance';
import type { BrowserPostcondition } from '../postcondition';
import type { createBrowserRefActions } from '../ref-actions';
import type { createBrowserRefPoints } from '../ref-points';
import type { BrowserRefRecoveryContext, createBrowserReply } from '../reply';
import type { createBrowserScreenshotService } from '../screenshot';
import type { createBrowserSettle } from '../settle';
import type { createBrowserSnapshotCapture } from '../snapshot-capture';
import type { createBrowserUrlAdmission } from '../url-admission';

export interface BrowserActionServices {
  state: BrowserGuestStateStore;
  cdp: BrowserGuestCdp;
  reply: ReturnType<typeof createBrowserReply>;
  settle: ReturnType<typeof createBrowserSettle>;
  input: ReturnType<typeof createBrowserInputDriver>;
  refActions: ReturnType<typeof createBrowserRefActions>;
  refPoints: ReturnType<typeof createBrowserRefPoints>;
  snapshots: ReturnType<typeof createBrowserSnapshotCapture>;
  screenshots: ReturnType<typeof createBrowserScreenshotService>;
  emulation: ReturnType<typeof createBrowserEmulation>;
  pageState: ReturnType<typeof createBrowserPageState>;
  performance: ReturnType<typeof createBrowserPerformanceCommands>;
  intercept: ReturnType<typeof createBrowserIntercept>;
  initScripts: ReturnType<typeof createBrowserInitScripts>;
  network: ReturnType<typeof createBrowserNetworkReports>;
  dialogs: ReturnType<typeof createBrowserDialogReport>;
  urls: ReturnType<typeof createBrowserUrlAdmission>;
  downloadsForSession(sessionId: string): TrackedBrowserDownload[];
  /** Re-enter the dispatcher for one step of a running sequence. */
  runCommand(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserCommandResult>;
}

export interface BrowserActionContext {
  guest: WebContents;
  command: BrowserCommand;
  /** Normalised action name. */
  action: string;
  signal?: AbortSignal;
  ownerSessionId: string;
  targetIsBackground: boolean;
  expected: BrowserPostcondition | null;
  /** The postcondition already held before dispatch, so it proves nothing. */
  preexistingPostcondition: boolean;
  hasScreenshotOptions: boolean;
  refRecovery: BrowserRefRecoveryContext;
  /** The settled, verified snapshot reply for a completed gesture — or the
   *  cheap DOM-quiet stub while a sequence step runs. */
  actionSnapshot(): Promise<BrowserCommandResult>;
  services: BrowserActionServices;
}

export type BrowserActionHandler = (
  context: BrowserActionContext,
) => Promise<BrowserCommandResult>;

export function defineBrowserActions<T extends Record<string, BrowserActionHandler>>(actions: T): T {
  return actions;
}
