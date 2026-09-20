// Session list and lifecycle, prompt/abort/approval routing, model routes,
// and the Settings → Connection remote-access controls.
import type { IpcMainInvokeEvent } from 'electron';
import { DESKTOP_IPC, type DesktopRemoteAccessInfo } from '../shared/contract';
import type { BrowserHost } from './browser/host';
import { optionalSessionId, requiredSessionId } from './desktop-state';
import type { DesktopService } from './desktop-service-contract';
import {
  requiredAbortOptions,
  requiredModelCatalogOptions,
  requiredModelSelection,
  requiredNewTaskDraft,
  requiredPromptContent,
  requiredString,
  requiredSubmitOptions,
  requiredSessionMessageCount,
  requiredTranscriptItemLimit,
  requiredToolApprovalDecision,
  sessionDisplayName,
} from './ipc-validation';

type Handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

interface SessionIpcOptions {
  handle: Handle;
  host: DesktopService;
  invokeDesktopOperation: <T>(method: string, args: unknown[]) => Promise<T>;
  browserHost?: Pick<BrowserHost, 'releaseSession'>;
  remoteAccessInfo?: () => Promise<DesktopRemoteAccessInfo | null>;
  rotateRemoteAccess?: () => Promise<DesktopRemoteAccessInfo | null>;
  revokeRemoteAccessClient?: (clientId: string) => Promise<DesktopRemoteAccessInfo | null>;
}

export function registerSessionIpc({
  handle,
  host,
  invokeDesktopOperation,
  browserHost,
  remoteAccessInfo,
  rotateRemoteAccess,
  revokeRemoteAccessClient,
}: SessionIpcOptions): void {
  handle(DESKTOP_IPC.listSessions, () => host.listSessions());
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
  // Settings → Connection: pairing card (null while the bridge is off).
  handle(DESKTOP_IPC.remoteAccessInfo, () => remoteAccessInfo?.() ?? null);
  handle(DESKTOP_IPC.rotateRemoteAccess, () => rotateRemoteAccess?.() ?? null);
  handle(
    DESKTOP_IPC.revokeRemoteAccessClient,
    (_event, clientId) => revokeRemoteAccessClient?.(requiredString(clientId, 'clientId')) ?? null
  );
  handle(DESKTOP_IPC.listRemoteClientClaims, () => invokeDesktopOperation('remoteAccessListClaims', []));
  // The approval itself: this answer is what mints the asking app's credential.
  handle(DESKTOP_IPC.resolveRemoteClientClaim, async (_event, claimId, approved) => {
    if (typeof approved !== 'boolean') throw new TypeError('approved must be a boolean.');
    const handled = await invokeDesktopOperation('remoteAccessResolveClaim', [
      requiredString(claimId, 'claimId'),
      approved,
    ]);
    return handled === true;
  });
  handle(DESKTOP_IPC.renameSession, (_event, sessionId, title) =>
    host.renameSession(requiredSessionId(sessionId), sessionDisplayName(title))
  );
  handle(DESKTOP_IPC.setSessionArchived, (_event, sessionId, archived) => {
    if (typeof archived !== 'boolean') throw new TypeError('archived must be a boolean.');
    return host.setSessionArchived(requiredSessionId(sessionId), archived);
  });
  handle(DESKTOP_IPC.deleteSession, async (_event, sessionId) => {
    const ownerSessionId = requiredSessionId(sessionId);
    const snapshot = await host.deleteSession(ownerSessionId);
    browserHost?.releaseSession(ownerSessionId);
    return snapshot;
  });
  handle(DESKTOP_IPC.prefetchSession, (_event, sessionId, itemLimit, readTraceId) =>
    host.prefetchSession(
      requiredSessionId(sessionId),
      requiredTranscriptItemLimit(itemLimit),
      typeof readTraceId === 'string' ? readTraceId : undefined
    )
  );
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
  handle(DESKTOP_IPC.resolveToolApprovalForSession, (_event, sessionId, id, input) =>
    host.resolveToolApprovalForSession(
      requiredSessionId(sessionId),
      requiredString(id, 'approval id', 1_024),
      requiredToolApprovalDecision(input)
    )
  );
  handle(DESKTOP_IPC.inheritSession, (_event, sourceSessionId, selection) =>
    host.inheritSession(
      requiredSessionId(sourceSessionId),
      selection === undefined || selection === null ? null : requiredModelSelection(selection)
    )
  );
  handle(DESKTOP_IPC.listProviderModels, (_event, options) =>
    host.listProviderModels(requiredModelCatalogOptions(options))
  );
  handle(DESKTOP_IPC.setModelRoute, (_event, selection, sessionId) =>
    host.setModelRoute(requiredModelSelection(selection), optionalSessionId(sessionId))
  );
  handle(DESKTOP_IPC.setFast, (_event, enabled, sessionId) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
    return host.setFast(enabled, optionalSessionId(sessionId));
  });
}
