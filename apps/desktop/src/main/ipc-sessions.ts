// Session list and lifecycle, prompt/abort/approval routing, model routes,
// and the Settings → Connection remote-access controls.
import { DESKTOP_IPC, type DesktopRemoteAccessInfo } from '../shared/contract';
import type { BrowserHost } from './browser/host';
import { readAttachmentThumbnail } from './attachment-thumbnail';
import { attachmentViewName, readSessionAttachment } from './session-attachments';
import { optionalSessionId, requiredSessionId } from './desktop-state';
import { isSessionMissingError } from './session-final-answer';
import type { DesktopService } from './desktop-service-contract';
import {
  requiredAbortOptions,
  requiredDeviceAlias,
  requiredModelCatalogOptions,
  requiredModelSelection,
  requiredNewTaskDraft,
  requiredPromptContent,
  requiredSessionContentQuery,
  requiredString,
  requiredSubmitOptions,
  requiredSessionMessageCount,
  requiredToolApprovalDecision,
  sessionDisplayName,
} from './ipc-validation';
import type { IpcHandle as Handle } from './ipc';
import { hostDeviceName } from './session-device';
import { sessionSidebarActions } from './session-sidebar-actions';
import type { RemoteHostWindows } from './remote-host-windows';
import { requiredAgentMemoryEntry } from './agent-memory';
import { secretInputs } from './secret-input';
import { takeoverGate } from './takeover-gate';
import { resolveToolApprovalAnnouncingGrant } from './approval-grant-change';

interface SessionIpcOptions {
  handle: Handle;
  host: DesktopService;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  browserHost?: Pick<BrowserHost, 'releaseSession'>;
  remoteAccessInfo?: (options?: { activate?: boolean }) => Promise<DesktopRemoteAccessInfo | null>;
  rotateRemoteAccess?: () => Promise<DesktopRemoteAccessInfo | null>;
  revokeRemoteAccessClient?: (clientId: string) => Promise<DesktopRemoteAccessInfo | null>;
  /** "Connect to another PC": saved hosts and their windows. */
  remoteHosts?: RemoteHostWindows;
}

export function registerSessionIpc({
  handle,
  host,
  invokeDesktopOperation,
  browserHost,
  remoteAccessInfo,
  rotateRemoteAccess,
  revokeRemoteAccessClient,
  remoteHosts,
}: SessionIpcOptions): void {
  handle(DESKTOP_IPC.listSessions, () => host.listSessions());
  handle(DESKTOP_IPC.readSessionAttachment, async (_event, sessionId, attachmentId) => {
    const { meta, bytes } = await readSessionAttachment(host, requiredSessionId(sessionId), attachmentId);
    return {
      name: attachmentViewName(meta),
      mimeType: meta.mimeType,
      size: bytes.length,
      dataUrl: `data:${meta.mimeType};base64,${bytes.toString('base64')}`,
    };
  });
  handle(DESKTOP_IPC.readAttachmentThumbnail, (_event, attachmentRef) =>
    readAttachmentThumbnail(
      attachmentRef,
      (ref) => host.readAttachmentImage(ref),
      async (buffer) => (await import('electron')).nativeImage.createFromBuffer(buffer)
    )
  );
  handle(DESKTOP_IPC.markSessionRead, (_event, sessionId, messageCount, consumedUnread) => {
    if (consumedUnread !== undefined && typeof consumedUnread !== 'boolean') {
      throw new TypeError('consumedUnread must be a boolean.');
    }
    return host.markSessionRead(
      requiredSessionId(sessionId),
      requiredSessionMessageCount(messageCount),
      consumedUnread === true
    );
  });
  handle(DESKTOP_IPC.listAgentPool, () => host.listAgentPool());
  handle(DESKTOP_IPC.searchSessionContent, (_event, query) =>
    host.searchSessionContent(requiredSessionContentQuery(query))
  );
  registerRemoteAccessIpc({
    handle,
    invokeDesktopOperation,
    remoteAccessInfo,
    rotateRemoteAccess,
    revokeRemoteAccessClient,
    remoteHosts,
  });
  handle(DESKTOP_IPC.renameSession, (_event, sessionId, title) =>
    host.renameSession(requiredSessionId(sessionId), sessionDisplayName(title))
  );
  const sidebar = sessionSidebarActions(host);
  handle(DESKTOP_IPC.setSessionArchived, (_event, sessionId, archived) =>
    sidebar.setSessionArchived(sessionId, archived)
  );
  handle(DESKTOP_IPC.openAgentHome, (_event, agentId) => host.openAgentHome(requiredString(agentId, 'agentId', 200)));
  handle(DESKTOP_IPC.resetAgentHome, (_event, agentId) => host.resetAgentHome(requiredString(agentId, 'agentId', 200)));
  handle(DESKTOP_IPC.listAgentMemory, (_event, agentId) =>
    host.listAgentMemory(requiredString(agentId, 'agentId', 200))
  );
  handle(DESKTOP_IPC.deleteAgentMemory, (_event, agentId, entry) =>
    host.deleteAgentMemory(requiredString(agentId, 'agentId', 200), requiredAgentMemoryEntry(entry))
  );
  handle(DESKTOP_IPC.agentRoomAction, (_event, action, args) =>
    host.agentRoomAction(requiredString(action, 'action', 32), Array.isArray(args) ? args : [])
  );
  handle(DESKTOP_IPC.setSessionFavorite, (_event, sessionId, favorite) =>
    sidebar.setSessionFavorite(sessionId, favorite)
  );
  handle(DESKTOP_IPC.setSessionProject, (_event, sessionId, projectPath) =>
    sidebar.setSessionProject(sessionId, projectPath)
  );
  handle(DESKTOP_IPC.deleteSession, async (_event, sessionId) => {
    const ownerSessionId = requiredSessionId(sessionId);
    // A session that is already gone is a no-op, not an error for the UI.
    let snapshot: unknown = null;
    try {
      snapshot = await host.deleteSession(ownerSessionId);
    } catch (error) {
      if (!isSessionMissingError(error)) throw error;
    }
    browserHost?.releaseSession(ownerSessionId);
    return snapshot;
  });
  registerSessionRoutingIpc({ handle, host, invokeDesktopOperation });
}

function registerRemoteAccessIpc({
  handle,
  invokeDesktopOperation,
  remoteAccessInfo,
  rotateRemoteAccess,
  revokeRemoteAccessClient,
  remoteHosts,
}: Pick<
  SessionIpcOptions,
  | 'handle'
  | 'invokeDesktopOperation'
  | 'remoteAccessInfo'
  | 'rotateRemoteAccess'
  | 'revokeRemoteAccessClient'
  | 'remoteHosts'
>): void {
  // Settings → Connection: pairing card (null while the bridge is off).
  handle(
    DESKTOP_IPC.remoteAccessInfo,
    (_event, options) =>
      remoteAccessInfo?.({ activate: (options as { activate?: unknown } | undefined)?.activate !== false }) ?? null
  );
  handle(DESKTOP_IPC.rotateRemoteAccess, () => rotateRemoteAccess?.() ?? null);
  handle(
    DESKTOP_IPC.revokeRemoteAccessClient,
    (_event, clientId) => revokeRemoteAccessClient?.(requiredString(clientId, 'clientId')) ?? null
  );
  // The 6-digit code lives only while Settings → Connection is open.
  handle(DESKTOP_IPC.remotePairCode, (_event, action) =>
    invokeDesktopOperation('remoteAccessPairCode', [action === 'renew' || action === 'release' ? action : 'ensure'])
  );
  const requiredRemoteHosts = (): RemoteHostWindows => {
    if (!remoteHosts) throw new Error('Connecting to another PC is unavailable.');
    return remoteHosts;
  };
  handle(DESKTOP_IPC.getRemoteAccessSettings, () => invokeDesktopOperation('remoteAccessSettings', []));
  handle(DESKTOP_IPC.setRemoteAccessEnabled, (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    return invokeDesktopOperation('remoteAccessSetEnabled', [enabled]);
  });
  handle(DESKTOP_IPC.setRemotePcName, (_event, name) =>
    invokeDesktopOperation('remoteAccessSetName', [typeof name === 'string' ? name : ''])
  );
  handle(DESKTOP_IPC.setRemoteClientAlias, async (_event, clientId, alias) => {
    await invokeDesktopOperation('remoteAccessSetClientAlias', [
      requiredString(clientId, 'clientId'),
      requiredDeviceAlias(alias),
    ]);
  });
  handle(DESKTOP_IPC.renameRemoteHost, async (_event, id, name) => {
    await requiredRemoteHosts().rename(requiredString(id, 'id', 64), typeof name === 'string' ? name : '');
  });
  handle(DESKTOP_IPC.listRemoteHosts, () => remoteHosts?.list() ?? []);
  handle(DESKTOP_IPC.connectRemoteHostByCode, (_event, code) =>
    requiredRemoteHosts().connectByCode(requiredString(code, 'code', 16))
  );
  handle(DESKTOP_IPC.openRemoteHost, (_event, id) => requiredRemoteHosts().open(requiredString(id, 'id', 64)));
  handle(DESKTOP_IPC.forgetRemoteHost, (_event, id) => requiredRemoteHosts().forget(requiredString(id, 'id', 64)));
  handle(DESKTOP_IPC.listRemoteClientClaims, () => invokeDesktopOperation('remoteAccessListClaims', []));
  // The approval itself: this answer is what mints the asking app's credential,
  handle(DESKTOP_IPC.resolveRemoteClientClaim, async (_event, claimId, approved) => {
    if (typeof approved !== 'boolean') throw new TypeError('approved must be a boolean.');
    const handled = await invokeDesktopOperation('remoteAccessResolveClaim', [
      requiredString(claimId, 'claimId'),
      approved,
    ]);
    return handled === true;
  });
}

function registerSessionRoutingIpc({
  handle,
  host,
  invokeDesktopOperation,
}: Pick<SessionIpcOptions, 'handle' | 'host' | 'invokeDesktopOperation'>): void {
  handle(DESKTOP_IPC.submitNewTask, (_event, prompt, options, draft) =>
    host.submitNewTask(requiredPromptContent(prompt), requiredSubmitOptions(options), requiredNewTaskDraft(draft))
  );
  // Split panes: prompt/abort/approval addressed to any pooled live session
  // (active or parked). The host contract requires every addressed route.
  handle(DESKTOP_IPC.submitToSession, (_event, sessionId, prompt, options) =>
    host.submitToSession(requiredSessionId(sessionId), requiredPromptContent(prompt), requiredSubmitOptions(options))
  );
  handle(DESKTOP_IPC.abortSession, (_event, sessionId, options) =>
    host.abortSession(requiredSessionId(sessionId), requiredAbortOptions(options))
  );
  // The secret card's value stays in this process (secret-input.ts): never
  // forwarded to the host, logged or echoed back.
  handle(DESKTOP_IPC.provideSecretInput, (_event, requestId, value) =>
    secretInputs.provide(requiredString(requestId, 'secret request id', 120), typeof value === 'string' ? value : '')
  );
  handle(DESKTOP_IPC.takeoverReady, (_event, sessionId, id) =>
    takeoverGate.ready(requiredSessionId(sessionId), requiredString(id, 'takeover id', 200))
  );
  handle(DESKTOP_IPC.resolveToolApprovalForSession, async (_event, sessionId, id, input) => {
    const decision = requiredToolApprovalDecision(input);
    return resolveToolApprovalAnnouncingGrant(
      host,
      invokeDesktopOperation,
      requiredSessionId(sessionId),
      requiredString(id, 'approval id', 1_024),
      // This PC answered: every other device names it ("Allowed from <PC>").
      { ...decision, device: hostDeviceName() }
    );
  });
  handle(DESKTOP_IPC.inheritSession, (_event, sourceSessionId, selection, options) =>
    host.inheritSession(
      requiredSessionId(sourceSessionId),
      selection === undefined || selection === null ? null : requiredModelSelection(selection),
      { compact: (options as { compact?: unknown } | null | undefined)?.compact === true }
    )
  );
  handle(DESKTOP_IPC.listProviderModels, (_event, options) =>
    host.listProviderModels(requiredModelCatalogOptions(options))
  );
  handle(DESKTOP_IPC.continueSessionInModel, (_event, sessionId, route) =>
    host.continueSessionInModel(requiredSessionId(sessionId), requiredModelSelection(route))
  );
  handle(DESKTOP_IPC.scheduleQuotaResume, (_event, sessionId) =>
    host.scheduleQuotaResume(requiredSessionId(sessionId))
  );
  handle(DESKTOP_IPC.cancelQuotaResume, (_event, sessionId) => host.cancelQuotaResume(requiredSessionId(sessionId)));
  handle(DESKTOP_IPC.stopShellJob, (_event, sessionId, taskId) =>
    host.stopShellJob(requiredSessionId(sessionId), requiredString(taskId, 'taskId', 256))
  );
  handle(DESKTOP_IPC.releaseShellJob, (_event, sessionId, taskId) =>
    host.releaseShellJob(requiredSessionId(sessionId), requiredString(taskId, 'taskId', 256))
  );
  handle(DESKTOP_IPC.getQuotaAutoResume, () => host.getQuotaAutoResume());
  handle(DESKTOP_IPC.viewerDevice, () => hostDeviceName());
  handle(DESKTOP_IPC.getTaskWorkspace, () => host.getTaskWorkspace());
  handle(DESKTOP_IPC.setQuotaAutoResume, (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    return host.setQuotaAutoResume(enabled);
  });
  handle(DESKTOP_IPC.setModelRoute, (_event, selection, sessionId) =>
    host.setModelRoute(requiredModelSelection(selection), optionalSessionId(sessionId))
  );
  handle(DESKTOP_IPC.setFast, (_event, enabled, sessionId) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    return host.setFast(enabled, optionalSessionId(sessionId));
  });
}
