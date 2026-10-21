/**
 * The agent's command path: the services every action reads, the runner that
 * admits a command to its page, the per-page queue it waits in, and the
 * bridge that receives commands from the runtime's `browser` tool.
 */
import type { WebContents } from 'electron';

import type { BrowserActionServices } from './actions';
import { createBrowserAutoSignIn } from './auto-sign-in';
import { createBrowserAgentBridge } from './agent-bridge';
import { COMMAND_TIMEOUT_MS, READ_ONLY_ACTIONS } from './command';
import { createBrowserCommandQueue } from './command-queue';
import { createBrowserCommandRunner } from './command-runner';
import type { createBrowserCommandToolkit } from './command-toolkit';
import type { createBrowserGuestLifecycle } from './guest-lifecycle';
import type { BrowserHostFoundation } from './host-foundation';
import type { BrowserProfileImportService } from './profile-import';
import { browserSessionId } from './session-registry';
import type { createBrowserTabs } from './tabs';
import { createBrowserTargetResolver } from './target-resolve';
import type { createBrowserTaskLifecycle } from './task-lifecycle';
import { takeoverGate } from '../takeover-gate';
import { secretInputs, type SecretInputs } from '../secret-input';

type Toolkit = ReturnType<typeof createBrowserCommandToolkit>;

/** Fill an account's stored credential into the page it was asked for, never
 *  into one the guest navigated to meanwhile. */
function storedCredentialFill(
  profileImporter: BrowserProfileImportService,
  fillCredentialInGuest: Toolkit['credentialFill']['fillCredentialInGuest']
): BrowserActionServices['credentials']['fillStored'] {
  return (guest, account, signal) => {
    signal?.throwIfAborted();
    const url = guest.getURL();
    return profileImporter.useCredentialByAccount(
      url,
      account,
      (credential) => {
        signal?.throwIfAborted();
        if (guest.isDestroyed() || guest.getURL() !== url) {
          throw new Error('The page changed before stored credential input; input was not sent.');
        }
        return fillCredentialInGuest(guest, credential, signal);
      },
      signal
    );
  };
}

/** One secret the user typed into the card, filled into the page's focused
 *  password field through the isolated-world credential fill (which keeps it
 *  registered for redaction, and visual-privacy.ts withholds captures while a
 *  password field holds focus). Taken from the slot exactly once. */
export async function fillSecretInput(
  host: {
    currentGuest(sessionId: string): WebContents | null | undefined;
    fill: Toolkit['credentialFill']['fillCredentialInGuest'];
    assertFree?: () => void;
  },
  sessionId: string,
  requestId: string,
  signal?: AbortSignal,
  registry: SecretInputs = secretInputs
): Promise<{ text: 'provided' | 'skipped' }> {
  const value = registry.take(requestId);
  const guest = host.currentGuest(sessionId);
  if (!value || !guest || guest.isDestroyed()) return { text: 'skipped' };
  (host.assertFree || takeoverGate.assertFree)();
  try {
    const result = await host.fill(guest, { username: '', password: value }, signal);
    return { text: result.passwordFilled ? 'provided' : 'skipped' };
  } catch {
    return { text: 'skipped' };
  }
}

/** A turn's end: its temporary pages close, and the implicit blank page the
 *  agent has since left behind goes with them. */
export function finishBrowserTurn(
  host: {
    taskLifecycle: Pick<ReturnType<typeof createBrowserTaskLifecycle<WebContents>>, 'finish'>;
    sessions: Pick<BrowserHostFoundation['sessions'], 'agentPage'>;
    lifecycle: Pick<ReturnType<typeof createBrowserGuestLifecycle>, 'discardUntouchedBlank'>;
  },
  sessionId: string,
  turnId: number,
  options: { aborted: boolean }
): number {
  const closed = host.taskLifecycle.finish(sessionId, turnId, options);
  const page = host.sessions.agentPage(sessionId);
  if (page) host.lifecycle.discardUntouchedBlank(sessionId, page.guest);
  return closed;
}

function createBrowserActionServices(
  parts: Omit<BrowserActionServices, 'targets' | 'credentials' | 'runCommand'>,
  tools: { profileImporter: BrowserProfileImportService; credentialFill: Toolkit['credentialFill'] },
  runCommand: BrowserActionServices['runCommand']
): BrowserActionServices {
  const targets = createBrowserTargetResolver({
    captureSnapshotPayload: parts.snapshots.captureSnapshotPayload,
    state: parts.state,
    cdp: parts.cdp,
    evaluate: parts.cdp.evaluate,
  });
  return {
    ...parts,
    targets,
    credentials: {
      fillStored: storedCredentialFill(tools.profileImporter, (guest, credential, signal) =>
        tools.credentialFill.fillCredentialInGuest(guest, credential, signal)
      ),
    },
    runCommand,
  };
}

export function createBrowserHostAgent(options: {
  base: Pick<
    BrowserHostFoundation,
    | 'state'
    | 'cdp'
    | 'documents'
    | 'settle'
    | 'intercept'
    | 'urls'
    | 'partition'
    | 'profileImporter'
    | 'approvals'
    | 'sessions'
    | 'leave'
    | 'display'
    | 'commandChains'
    | 'pendingReads'
  >;
  tools: Omit<Toolkit, 'dispatchInput'>;
  lifecycle: ReturnType<typeof createBrowserGuestLifecycle>;
  tabs: ReturnType<typeof createBrowserTabs>;
  taskLifecycle: ReturnType<typeof createBrowserTaskLifecycle<WebContents>>;
  retainGuest: (guest: WebContents) => void;
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
  /** The `browserAutoSignIn` setting (default on). */
  autoSignInEnabled?: () => boolean;
}) {
  const { base, tools, lifecycle, taskLifecycle } = options;
  const autoSignIn = createBrowserAutoSignIn({
    enabled: options.autoSignInEnabled || (() => true),
    suggestions: (url) => base.profileImporter.credentialSuggestions(url),
    withCredential: (url, id, use, signal) => base.profileImporter.useCredential(url, id, use, signal),
    fill: (guest, credential, signal) => tools.credentialFill.fillCredentialInGuest(guest, credential, signal),
    submit: (guest, signal) => tools.input.pressKey(guest, 'enter', signal),
    collect: (guest, expression, signal) => base.documents.collect(guest, expression, signal),
    invalidate: (guest) => base.state.invalidateInteraction(guest),
  });
  const { state, cdp, sessions, leave, commandChains, pendingReads } = base;
  const services = createBrowserActionServices(
    {
      documents: base.documents,
      state,
      cdp,
      reply: tools.reply,
      settle: base.settle,
      input: tools.input,
      refActions: tools.refActions,
      refPoints: tools.refPoints,
      snapshots: tools.snapshots,
      screenshots: tools.screenshots,
      emulation: tools.emulation,
      pageState: tools.pageState,
      performance: tools.performance,
      intercept: base.intercept,
      initScripts: tools.initScripts,
      network: tools.network,
      dialogs: tools.dialogs,
      urls: base.urls,
      downloadsForSession: base.partition.downloadLedger.downloadsForSession,
    },
    { profileImporter: base.profileImporter, credentialFill: tools.credentialFill },
    (command, signal) => runCommand(command, signal)
  );
  const runCommand = createBrowserCommandRunner({
    state,
    approvals: base.approvals,
    browserSessions: sessions,
    lifecycle,
    tabs: options.tabs,
    downloads: tools.downloads,
    taskLifecycle,
    retainGuest: options.retainGuest,
    autoSignIn,
    // Every agent command reaches its page here, before acting on it: from
    // now on a veto answers the agent, not a person's earlier click or key.
    drivePage: (guest) => {
      leave.agentActs(guest);
      // A window the page opens from here on is the agent's (popup-focus).
      state.for(guest).actor = 'agent';
      const releaseDomains = cdp.drive(guest);
      const releasePower = base.display.power.drive(guest);
      return () => {
        releasePower();
        releaseDomains();
      };
    },
    services,
  });
  const queue = createBrowserCommandQueue({
    chains: commandChains,
    pendingReads,
    sessionId: (command) => browserSessionId(command.session_id),
    currentPageId: (sessionId) => {
      const guest = sessions.currentGuest(sessionId);
      return guest && !guest.isDestroyed() ? state.pageId(guest) : undefined;
    },
    backgroundEntryByPageId: lifecycle.backgroundEntryByPageId,
    run: runCommand,
    bounded: cdp.bounded,
    readOnlyActions: READ_ONLY_ACTIONS,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  });
  const bridge = createBrowserAgentBridge({
    chains: commandChains,
    pendingReads,
    execute: (command, signal) => queue.executeSerialized(command, signal),
    finishTurn: (sessionId, turnId, finish) =>
      finishBrowserTurn({ taskLifecycle, sessions, lifecycle }, sessionId, turnId, finish),
    secretInput: (sessionId, requestId, signal) =>
      fillSecretInput(
        { currentGuest: (id) => sessions.currentGuest(id), fill: tools.credentialFill.fillCredentialInGuest },
        sessionId,
        requestId,
        signal
      ),
    visibleGuests: () => sessions.visibleGuests(),
    lifecycle,
    onDiagnostic: options.onDiagnostic,
  });
  return { ...queue, bridge };
}
