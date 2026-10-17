/**
 * The agent's command path: the services every action reads, the runner that
 * admits a command to its page, the per-page queue it waits in, and the
 * bridge that receives commands from the runtime's `browser` tool.
 */
import type { WebContents } from 'electron';

import type { BrowserActionServices } from './actions';
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
}) {
  const { base, tools, lifecycle, taskLifecycle } = options;
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
    // Every agent command reaches its page here, before acting on it: from
    // now on a veto answers the agent, not a person's earlier click or key.
    drivePage: (guest) => {
      leave.agentActs(guest);
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
    finishTurn: (sessionId, turnId, finish) => taskLifecycle.finish(sessionId, turnId, finish),
    visibleGuests: () => sessions.visibleGuests(),
    lifecycle,
    onDiagnostic: options.onDiagnostic,
  });
  return { ...queue, bridge };
}
