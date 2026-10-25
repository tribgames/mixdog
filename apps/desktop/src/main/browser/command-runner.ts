/**
 * Per-command dispatch: validate the command, place it on its page (visible
 * or background), settle the page around the handler, and redact the reply.
 * The host owns wiring; this owns what one command does once it runs.
 */
import type { createBrowserActionApproval } from './action-approval';
import { type createBrowserAutoSignIn, SAVED_SIGN_IN_DONE, SAVED_SIGN_IN_NEEDS_USER } from './auto-sign-in';
import { browserActionHandler, type BrowserActionServices } from './actions';
import { adoptResolvedTargets } from './actions/target';
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
import type { createBrowserLinkedSignIns } from './linked-sign-in';
import { normalizeBrowserPostcondition, normalizeBrowserSettleMs } from './postcondition';
import { browserSessionId, type BrowserSessionRegistry } from './session-registry';
import { throwIfBrowserCancelled } from './settle';
import type { createBrowserTabs } from './tabs';
import type { createBrowserTaskLifecycle } from './task-lifecycle';
import type { UserWait } from './user-wait';
import type { WebContents } from 'electron';
import { takeoverGate } from '../takeover-gate';

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
  /** Throws while the user has taken over (default: the window's takeover gate). */
  assertNoTakeover?: () => void;
  /** Saved-login sign-in after a command (auto-sign-in.ts). */
  autoSignIn?: ReturnType<typeof createBrowserAutoSignIn>;
  /** Linked sign-in memory (linked-sign-in.ts): the account a click or typing
   *  on a provider's page names, and the `Linked sign-in:` line of a reply. */
  linkedSignIn?: {
    beforeAction(guest: WebContents, action: string, command: BrowserCommand, signal?: AbortSignal): Promise<void> | void;
    replyLine: ReturnType<typeof createBrowserLinkedSignIns>['replyLine'];
  };
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

  /** The page a command targets runs unthrottled for the command's duration.
   *  `userWait`: the command's clock, which stands still while the person is
   *  asked to approve a step (the queue's ceiling does not count that time). */
  async function runCommand(
    command: BrowserCommand,
    signal?: AbortSignal,
    userWait?: UserWait
  ): Promise<BrowserCommandResult> {
    // A pending takeover of this session hands its pages to the user
    // (takeover-gate.ts); one that starts meanwhile aborts this command and
    // waits for it. Other sessions' takeovers never stop it.
    host.assertNoTakeover?.();
    const operation = takeoverGate.beginOperation(browserSessionId(command.session_id));
    const releases: Array<() => void> = [operation.release];
    try {
      const runSignal = signal ? AbortSignal.any([signal, operation.signal]) : operation.signal;
      return await runResolvedCommand(command, runSignal, (guest) => releases.push(host.drivePage(guest)), userWait);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  async function runResolvedCommand(
    command: BrowserCommand,
    signal: AbortSignal | undefined,
    drive: (guest: WebContents) => void,
    userWait?: UserWait
  ): Promise<BrowserCommandResult> {
    const { action, ownerSessionId, hasScreenshotOptions, expected, background, tab } = prepareBrowserCommand(command);
    // Tab-less bookkeeping actions never open or create a page.
    if (TABLESS_ACTIONS.has(action)) {
      await approvals.approve(command, () => ({ url: '', identity: ownerSessionId }), signal, undefined, userWait);
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
    const knownPages = sessionPages(ownerSessionId);
    const target = tabs.resolveTargetGuest(ownerSessionId, background, tab);
    const targetIsBackground = target?.background === true;
    if (!target && !previousGuest && action !== 'navigate' && action !== 'open') {
      throw new Error('No browser page is open; navigate or use background:true.');
    }
    const guest = target?.guest ?? (await lifecycle.ensureGuest(ownerSessionId, { reveal: false, adopt: false }));
    // A page this command made: a failure before it held a document closes it.
    const createdPage = !knownPages.has(guest);
    const opensForeground = action === 'open' && !targetIsBackground;
    if (opensForeground && createdPage) {
      lifecycle.discardCreatedPage(ownerSessionId, guest);
      const message = 'Could not show a page: no page is open in this conversation; navigate to one first.';
      lifecycle.reportOpenFailure(ownerSessionId, message);
      throw new Error(message);
    }
    drive(guest);
    const backgroundPage = browserSessions.backgroundPageForGuest(ownerSessionId, guest);
    // The pane follows the page the agent works in; a hidden helper page it
    // created with background:true is not one the user is meant to watch, but
    // one it revealed (`open`, background:false) is shown, so it is followed.
    if (backgroundPage?.kind !== 'agent' || !targetIsBackground) {
      browserSessions.setAgentPage(ownerSessionId, guest, turnId);
    }
    // A hidden helper never takes the selection from a page the person is
    // on; it only replaces the pane's untouched blank, which is no page.
    lifecycle.discardUntouchedBlank(ownerSessionId, guest);
    taskLifecycle.use(
      ownerSessionId,
      turnId,
      guest,
      backgroundPage ? backgroundPage.kind === 'agent' && !backgroundPage.keepAlive : !previousGuest
    );
    // Only `open` (and a takeover, openForTakeover) shows a page during a
    // turn; it keeps its page for the user.
    if (opensForeground) retainGuest(guest);
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
      let approvedReceiver: string | undefined;
      if (!command.internalStep) {
        // An upload resolves its real target before the person is asked: a
        // `target` spec becomes the ref the handler will then use, and the
        // frame document that ref (or the open chooser) belongs to is bound.
        const uploadReceiver = async () => {
          if (!command.ref && command.target !== undefined && command.target !== null) {
            const resolved = await services.targets.resolveTargetRefs(guest, [command.target], signal);
            adoptResolvedTargets({ guest, services, refRecovery, effectBaseline }, resolved);
            command.ref = resolved[0].ref;
          }
          return services.refActions.uploadReceiver(guest, command.ref ? String(command.ref) : undefined, signal);
        };
        const approved = await approvals.approve(
          command,
          () => ({
            url: guest.getURL(),
            identity: browserDocumentId(state, guest),
          }),
          signal,
          action === 'upload' ? uploadReceiver : undefined,
          userWait
        );
        approvedReceiver = approved?.receiver;
      }
      await host.linkedSignIn?.beforeAction(guest, action, command, signal);
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
        approvedReceiver,
      });
      // A page that asks for a sign-in the profile has a saved login for.
      // On `open` it runs first, so the reveal shows the page as it ends up.
      const signedIn =
        command.internalStep === true || typeof command.savedAccount === 'string'
          ? null
          : await host.autoSignIn?.afterCommand({
              guest,
              sessionId: ownerSessionId,
              turnId,
              signal,
              observe: () =>
                reply.snapshotResult(guest, { action: 'snapshot', maxChars: command.maxChars }, signal, {
                  targetIsBackground,
                }),
            });
      // The identity a "Continue with Google/GitHub" last used on this site.
      const linked =
        command.internalStep === true || !host.linkedSignIn
          ? ''
          : await host.linkedSignIn.replyLine({ guest, sessionId: ownerSessionId, turnId }).catch(() => '');
      // An open always answers with its placement (the transcript's "보기"
      // line reads it); a sign-in made on the way rides along as its note.
      if (opensForeground) {
        const placement = await revealOpenedPage(ownerSessionId, guest, signal);
        const note = signedIn ? savedSignInNote(signedIn.text) : '';
        return { text: state.redactText(guest, [placement, note, linked].filter(Boolean).join('\n\n')) };
      }
      const final = signedIn ?? result;
      return { ...final, text: state.redactText(guest, linked ? `${linked}\n\n${final.text}` : final.text) };
    } catch (error) {
      const message = state.redactText(guest, (error as Error).message || String(error));
      // A failed open (not a cancelled one) tells the shell why.
      if (opensForeground && !signal?.aborted) {
        lifecycle.reportOpenFailure(ownerSessionId, message, guest.isDestroyed() ? undefined : state.pageId(guest));
      }
      if (createdPage && lifecycle.discardCreatedPage(ownerSessionId, guest)) {
        throw new Error(`${message.replace(/\.?$/, '.')} The blank tab this command opened was closed.`);
      }
      throw new Error(message);
    }
  }

  /** The saved-login line an auto sign-in put ahead of its snapshot. */
  function savedSignInNote(text: string): string {
    const note = text.split('\n\n')[0];
    return note.startsWith(SAVED_SIGN_IN_DONE) || note.startsWith(SAVED_SIGN_IN_NEEDS_USER) ? note : '';
  }

  /** Every page the session holds now, visible or named. */
  function sessionPages(sessionId: string): Set<WebContents> {
    return new Set([
      ...browserSessions.visibleGuests(sessionId),
      ...[...browserSessions.backgroundPages(sessionId).values()].map((page) => page.guest),
    ]);
  }

  /** What the agent may tell the user about an `open`: exactly one of shown,
   *  pending (the conversation is not on screen) or failed (thrown). The
   *  transcript's "브라우저 · 보기" line reads the page id from the first two
   *  forms (renderer/browser-peek-line.tsx). */
  async function revealOpenedPage(sessionId: string, guest: WebContents, signal?: AbortSignal): Promise<string> {
    let placement: 'shown' | 'pending';
    let page: string;
    try {
      placement = await lifecycle.revealPage(sessionId, guest, signal);
      page = `page ${state.pageId(guest)} — ${guest.getTitle() || '(untitled)'} (${guest.getURL() || 'about:blank'})`;
    } catch (error) {
      // Cancellation stays cancellation, not a placement failure.
      throwIfBrowserCancelled(signal);
      throw new Error(`Could not show the page in the browser panel: ${(error as Error).message || String(error)}`);
    }
    if (placement === 'shown') return `Shown in the browser panel: ${page}.`;
    return (
      `Not on screen yet: ${page} is kept in this conversation's browser panel, which is not visible now; ` +
      'it appears when the user opens that panel. Do not tell the user it is on screen.'
    );
  }

  return runCommand;
}
