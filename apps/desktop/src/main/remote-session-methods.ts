// Session lifecycle and submit methods for one remote connection. Device
// identity and the stale-view check stay with the methods that use them.
import type { DesktopService } from './desktop-service-contract';
import { REMOTE_ORIGINAL_MAX_BYTES, readAttachmentThumbnail } from './attachment-thumbnail';
import { requiredSessionId } from './desktop-state';
import {
  requiredAbortOptions,
  requiredModelSelection,
  requiredNewTaskDraft,
  requiredPromptContent,
  requiredSessionMessageCount,
  requiredString,
  requiredSubmitOptions,
  requiredToolApprovalDecision,
  requiredTranscriptItemLimit,
  sessionDisplayName,
} from './ipc-validation';
import { STALE_SESSION_VIEW_MARKER } from '../shared/session-devices';
import { sessionSidebarActions } from './session-sidebar-actions';
import type { RemoteMethod, RemoteMethodClient, RemoteMethodDependencies } from './remote-methods';

export const STALE_SESSION_VIEW_MESSAGE = `${STALE_SESSION_VIEW_MARKER} Review the latest messages, then send again.`;

export function sessionRemoteMethods(
  host: DesktopService,
  client: RemoteMethodClient | undefined,
  browserRemote: RemoteMethodDependencies['browserRemote']
): Record<string, RemoteMethod> {
  const connectionDevice = async (): Promise<string> => (await client?.deviceName?.()) || 'Web app';
  const sidebar = sessionSidebarActions(host);
  return {
    // The name this connection's own actions are stamped with, so the client
    // can tell which transcript rows it sent itself.
    viewerDevice: () => connectionDevice(),
    markSessionRead: ([sessionId, messageCount, consumedUnread]) => {
      if (consumedUnread !== undefined && typeof consumedUnread !== 'boolean') {
        throw new TypeError('consumedUnread must be a boolean.');
      }
      return host.markSessionRead(
        requiredSessionId(sessionId),
        requiredSessionMessageCount(messageCount),
        consumedUnread === true
      );
    },
    readAttachmentThumbnail: ([attachmentRef]) =>
      readAttachmentThumbnail(attachmentRef, (ref) => host.readAttachmentImage(ref), null, REMOTE_ORIGINAL_MAX_BYTES),
    renameSession: ([sessionId, title]) => host.renameSession(requiredSessionId(sessionId), sessionDisplayName(title)),
    continueSessionInModel: ([sessionId, route]) =>
      host.continueSessionInModel(requiredSessionId(sessionId), requiredModelSelection(route)),
    scheduleQuotaResume: ([sessionId]) => host.scheduleQuotaResume(requiredSessionId(sessionId)),
    cancelQuotaResume: ([sessionId]) => host.cancelQuotaResume(requiredSessionId(sessionId)),
    stopShellJob: ([sessionId, taskId]) =>
      host.stopShellJob(requiredSessionId(sessionId), requiredString(taskId, 'taskId', 256)),
    getQuotaAutoResume: () => host.getQuotaAutoResume(),
    setQuotaAutoResume: ([enabled]) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return host.setQuotaAutoResume(enabled);
    },
    setSessionArchived: ([sessionId, archived]) => sidebar.setSessionArchived(sessionId, archived),
    setSessionFavorite: ([sessionId, favorite]) => sidebar.setSessionFavorite(sessionId, favorite),
    setSessionProject: ([sessionId, projectPath]) => sidebar.setSessionProject(sessionId, projectPath),
    deleteSession: async ([sessionId]) => {
      const ownerSessionId = requiredSessionId(sessionId);
      const snapshot = await host.deleteSession(ownerSessionId);
      // Session deletion remains authoritative when Browser Use is unavailable.
      if (browserRemote) await browserRemote('release', [ownerSessionId]).catch(() => undefined);
      return snapshot;
    },
    // Cold-lane fill for the remote surface: a canonical session.read whose
    // replay frame returns through the broadcast sessionState lane.
    prefetchSession: ([sessionId, itemLimit, readTraceId]) =>
      host.prefetchSession?.(
        requiredSessionId(sessionId),
        requiredTranscriptItemLimit(itemLimit),
        typeof readTraceId === 'string' && readTraceId ? readTraceId : undefined
      ) ?? false,
    submitNewTask: async ([prompt, options, draft]) =>
      host.submitNewTask(
        requiredPromptContent(prompt),
        { ...requiredSubmitOptions(options), device: await connectionDevice() },
        requiredNewTaskDraft(draft)
      ),
    submitToSession: async ([sessionId, prompt, options]) => {
      const id = requiredSessionId(sessionId);
      const content = requiredPromptContent(prompt);
      const submitOptions = requiredSubmitOptions(options);
      const device = await connectionDevice();
      if (client?.staleView?.(id, device)) throw new Error(STALE_SESSION_VIEW_MESSAGE);
      return host.submitToSession(id, content, { ...submitOptions, device });
    },
    abortSession: async ([sessionId, options]) =>
      host.abortSession(requiredSessionId(sessionId), {
        ...requiredAbortOptions(options),
        device: await connectionDevice(),
      }),
    resolveToolApprovalForSession: async ([sessionId, id, decision]) =>
      host.resolveToolApprovalForSession(requiredSessionId(sessionId), requiredString(id, 'approval id', 1_024), {
        ...requiredToolApprovalDecision(decision),
        device: await connectionDevice(),
      }),
    inheritSession: ([sourceSessionId, selection, options]) =>
      host.inheritSession(
        requiredSessionId(sourceSessionId),
        selection == null ? null : requiredModelSelection(selection),
        { compact: (options as { compact?: unknown } | null | undefined)?.compact === true }
      ),
  };
}
