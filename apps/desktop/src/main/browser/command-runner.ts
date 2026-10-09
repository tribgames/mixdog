/**
 * Per-command dispatch: validate the command, place it on its page (visible
 * or background), settle the page around the handler, and redact the reply.
 * The host owns wiring; this owns what one command does once it runs.
 */
import type { createBrowserActionApproval } from './action-approval';
import { browserActionHandler, type BrowserActionServices } from './actions';
import {
  type BrowserCommand,
  type BrowserCommandResult,
  DIALOG_TOLERANT_ACTIONS,
  normalizeBrowserAction,
  POSTCONDITION_ACTIONS,
  TABLESS_ACTIONS,
} from './command';
import type { createBrowserDownloads } from './downloads';
import type { createBrowserGuestLifecycle } from './guest-lifecycle';
import { browserDocumentId, type BrowserGuestStateStore } from './guest-state';
import { normalizeBrowserPostcondition, normalizeBrowserSettleMs } from './postcondition';
import { browserSessionId, type BrowserSessionRegistry } from './session-registry';
import { throwIfBrowserCancelled } from './settle';
import type { createBrowserTabs } from './tabs';
import type { createBrowserTaskLifecycle } from './task-lifecycle';
import type { WebContents } from 'electron';

interface BrowserCommandRunnerHost {
  state: BrowserGuestStateStore;
  approvals: ReturnType<typeof createBrowserActionApproval>;
  browserSessions: BrowserSessionRegistry;
  lifecycle: ReturnType<typeof createBrowserGuestLifecycle>;
  tabs: ReturnType<typeof createBrowserTabs>;
  downloads: ReturnType<typeof createBrowserDownloads>;
  taskLifecycle: ReturnType<typeof createBrowserTaskLifecycle<WebContents>>;
  retainGuest: (guest: WebContents) => void;
  /** Runs a page unthrottled until the returned release is called. */
  drivePage: (guest: WebContents) => () => void;
  services: BrowserActionServices;
}

/** Validate and normalize one command before any page work: the action and the
 *  session that owns it, whether screenshot options are allowed here, the
 *  postcondition, and where it runs (visible tab vs named background page). */
function prepareBrowserCommand(command: BrowserCommand): {
  action: string;
  ownerSessionId: string;
  hasScreenshotOptions: boolean;
  expected: ReturnType<typeof normalizeBrowserPostcondition>;
  background: BrowserCommand['background'];
  tab: string;
} {
  const action = normalizeBrowserAction(command);
  if (!action) throw new Error('browser command requires action');
  const ownerSessionId = browserSessionId(command.session_id);
  const hasScreenshotOptions = ['fullPage', 'format', 'quality'].some((name) => Object.hasOwn(command, name));
  if (action !== 'snapshot' && hasScreenshotOptions && command.includeScreenshot !== true) {
    throw new Error(`${action} screenshot options require includeScreenshot=true`);
  }
  normalizeBrowserSettleMs(command.settleMs);
  const expected = normalizeBrowserPostcondition(command.expect);
  if (expected && !POSTCONDITION_ACTIONS.has(action)) {
    throw new Error(`expect is not supported for browser action "${action}"`);
  }
  // Foreground drives and reveals the visible tab; background drives a
  // hidden offscreen page on the same partition without taking the screen.
  const background = action === 'open' && command.background !== true ? false : command.background;
  return { action, ownerSessionId, hasScreenshotOptions, expected, background, tab: String(command.tab || '').trim() };
}

export function createBrowserCommandRunner(host: BrowserCommandRunnerHost) {
  const { state, approvals, browserSessions, lifecycle, tabs, downloads, taskLifecycle, retainGuest, services } = host;
  const { cdp, reply, settle } = services;

  /** The page a command targets runs unthrottled for the command's duration. */
  async function runCommand(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserCommandResult> {
    const releases: Array<() => void> = [];
    try {
      return await runResolvedCommand(command, signal, (guest) => releases.push(host.drivePage(guest)));
    } finally {
      for (const release of releases) release();
    }
  }

  async function runResolvedCommand(
    command: BrowserCommand,
    signal: AbortSignal | undefined,
    drive: (guest: WebContents) => void
  ): Promise<BrowserCommandResult> {
    const { action, ownerSessionId, hasScreenshotOptions, expected, background, tab } = prepareBrowserCommand(command);
    // Tab-less bookkeeping actions never open or create a page.
    if (TABLESS_ACTIONS.has(action)) {
      await approvals.approve(command, () => ({ url: '', identity: ownerSessionId }), signal);
    }
    if (!['hide', 'downloads'].includes(action)) await lifecycle.restoreSession(ownerSessionId);
    if (action === 'list_tabs') return tabs.listTabs(ownerSessionId);
    if (action === 'downloads') return downloads.listDownloads(ownerSessionId, command, signal);
    if (action === 'close_tab') return tabs.closeBackgroundTab(ownerSessionId, tab);
    if (action === 'hide') {
      lifecycle.requestBrowserSurface(ownerSessionId, 'hide');
      return { text: 'Browser panel hide requested; tabs and page state are preserved.' };
    }
    const handler = browserActionHandler(action);
    if (!handler) throw new Error(`unknown browser action "${action}"`);
    const turnId = Number(command.turn_id) || 0;
    taskLifecycle.begin(ownerSessionId, turnId);
    const previousGuest = browserSessions.liveGuest(ownerSessionId);
    const target = tabs.resolveTargetGuest(ownerSessionId, background, tab);
    const targetIsBackground = target?.background === true;
    if (!target && !previousGuest && action !== 'navigate' && action !== 'open') {
      throw new Error('No browser page is open; navigate or use background:true.');
    }
    const guest = target?.guest ?? (await lifecycle.ensureGuest(ownerSessionId, { reveal: false }));
    drive(guest);
    const backgroundPage = browserSessions.backgroundPageForGuest(ownerSessionId, guest);
    taskLifecycle.use(
      ownerSessionId,
      turnId,
      guest,
      backgroundPage ? backgroundPage.kind === 'agent' && !backgroundPage.keepAlive : !previousGuest
    );
    if (action === 'open' && !targetIsBackground) {
      retainGuest(guest);
      lifecycle.requestBrowserSurface(ownerSessionId, true);
    } else if (
      !targetIsBackground &&
      (action === 'navigate' || command.background === false) &&
      !taskLifecycle.reveal(ownerSessionId, turnId, guest)
    ) {
      lifecycle.requestBrowserSurface(ownerSessionId, true);
    }
    await lifecycle.recoverCrashedGuest(guest, signal);
    throwIfBrowserCancelled(signal);
    // Explicit navigation and dialog handling can release a blocked execution.
    // Other commands, including non-CDP storage mutations, wait for cleanup.
    if (!['navigate', 'handle_dialog', 'status'].includes(action)) {
      await cdp.waitForIdle(guest, signal);
    }
    // A blocked page accepts no gesture: CDP would queue the input behind the
    // dialog and replay it after handle_dialog, which nobody asked for.
    if (!DIALOG_TOLERANT_ACTIONS.has(action)) {
      const blocked = reply.dialogResult(guest, false);
      if (blocked) return blocked;
    }
    const refRecovery = reply.refRecoveryFor(guest);
    const reportBaseline = state.peek(guest)?.refSet;
    // The latest observation of this page is what the gesture starts from; a
    // target resolution inside the handler moves it to the fresher one.
    const effectBaseline = { current: state.peek(guest)?.refSet };
    const preexistingPostcondition = Boolean(
      expected &&
        action !== 'navigate' &&
        !state.for(guest).pendingDialog &&
        (await settle.postconditionMatchesGuest(guest, expected, signal))
    );
    const actionSnapshot = () =>
      command.internalStep === true
        ? settle.stepSettleResult(guest, signal, targetIsBackground)
        : reply.snapshotResult(guest, command, signal, {
            expected,
            preexistingPostcondition,
            settleAction: true,
            targetIsBackground,
            baseline: effectBaseline.current,
            reportBaseline,
          });
    try {
      if (!command.internalStep) {
        await approvals.approve(
          command,
          () => ({
            url: guest.getURL(),
            identity: browserDocumentId(state, guest),
          }),
          signal
        );
      }
      const result = await handler({
        guest,
        command,
        action,
        signal,
        ownerSessionId,
        targetIsBackground,
        expected,
        preexistingPostcondition,
        hasScreenshotOptions,
        refRecovery,
        effectBaseline,
        actionSnapshot,
        services,
      });
      return { ...result, text: state.redactText(guest, result.text) };
    } catch (error) {
      throw new Error(state.redactText(guest, (error as Error).message || String(error)));
    }
  }

  return runCommand;
}
