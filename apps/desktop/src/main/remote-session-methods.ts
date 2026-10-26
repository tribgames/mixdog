// Session lifecycle and submit methods for one remote connection. Device
// identity and the stale-view check stay with the methods that use them.
import type { DesktopService } from './desktop-service-contract';
import { REMOTE_ORIGINAL_MAX_BYTES, readAttachmentThumbnail } from './attachment-thumbnail';
import { requiredSessionId } from './desktop-state';
import { isSessionMissingError } from './session-final-answer';
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
import { findToolRecord, remoteToolOutput } from './remote-transcript';
import { sessionSidebarActions } from './session-sidebar-actions';
import { resolveToolApprovalAnnouncingGrant } from './approval-grant-change';
import type { RemoteMethod, RemoteMethodClient, RemoteMethodDependencies } from './remote-methods';

export const READ_NOT_VIEWED = 'This session is not open on this device.';
export const READ_NOT_HELD = 'This row is not in the transcript this device holds.';

export const STALE_SESSION_VIEW_MESSAGE = `${STALE_SESSION_VIEW_MARKER} Review the latest messages, then send again.`;

/** How the host took a notification's Allow / Deny: `answered`; `settled`
 *  (already decided elsewhere, or no longer waiting); `open` (an Allow this
 *  PC takes only in the app: it opens on the approval, decided there). */
export type ApprovalNotificationAnswer = 'answered' | 'settled' | 'open';

export function sessionRemoteMethods(
  host: DesktopService,
  client: RemoteMethodClient | undefined,
  browserRemote: RemoteMethodDependencies['browserRemote'],
  approvalNotifications?: RemoteMethodDependencies['approvalNotifications']
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
    // The other half of the phone's output cap (remote-transcript.ts): the
    // uncapped result of one tool row, read from the host's held transcript.
    readTranscriptItem: async ([sessionId, itemId]) => {
      const session = requiredSessionId(sessionId);
      const id = requiredString(itemId, 'itemId', 1_024);
      // Only a session this connection is synchronized with, and only a row
      // of the transcript the host actually sent it: the host's own record of
      // the connection, never a session or row id the caller names.
      if (!client?.viewedSessionIds?.().includes(session)) throw new Error(READ_NOT_VIEWED);
      if (!client.heldTranscript || !findToolRecord(client.heldTranscript(session), id)) throw new Error(READ_NOT_HELD);
      // The whole row, as the desktop's own transcript shows it.
      return remoteToolOutput(await host.readSessionTranscript?.(session), id);
    },
    renameSession: ([sessionId, title]) => host.renameSession(requiredSessionId(sessionId), sessionDisplayName(title)),
    continueSessionInModel: ([sessionId, route]) =>
      host.continueSessionInModel(requiredSessionId(sessionId), requiredModelSelection(route)),
    scheduleQuotaResume: ([sessionId]) => host.scheduleQuotaResume(requiredSessionId(sessionId)),
    cancelQuotaResume: ([sessionId]) => host.cancelQuotaResume(requiredSessionId(sessionId)),
    stopShellJob: ([sessionId, taskId]) =>
      host.stopShellJob(requiredSessionId(sessionId), requiredString(taskId, 'taskId', 256)),
    releaseShellJob: ([sessionId, taskId]) =>
      host.releaseShellJob(requiredSessionId(sessionId), requiredString(taskId, 'taskId', 256)),
    getQuotaAutoResume: () => host.getQuotaAutoResume(),
    getTaskWorkspace: () => host.getTaskWorkspace(),
    setQuotaAutoResume: ([enabled]) => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return host.setQuotaAutoResume(enabled);
    },
    setSessionArchived: ([sessionId, archived]) => sidebar.setSessionArchived(sessionId, archived),
    openAgentHome: ([agentId]) => host.openAgentHome(requiredString(agentId, 'agentId', 200)),
    resetAgentHome: ([agentId]) => host.resetAgentHome(requiredString(agentId, 'agentId', 200)),
    agentRoomAction: ([action, args]) =>
      host.agentRoomAction(requiredString(action, 'action', 32), Array.isArray(args) ? args : []),
    setSessionFavorite: ([sessionId, favorite]) => sidebar.setSessionFavorite(sessionId, favorite),
    setSessionProject: ([sessionId, projectPath]) => sidebar.setSessionProject(sessionId, projectPath),
    deleteSession: async ([sessionId]) => {
      const ownerSessionId = requiredSessionId(sessionId);
      // A session that is already gone is a no-op, not an error for the UI.
      let snapshot: unknown = null;
      try {
        snapshot = await host.deleteSession(ownerSessionId);
      } catch (error) {
        if (!isSessionMissingError(error)) throw error;
      }
      // Session deletion remains authoritative when Browser Use is unavailable.
      if (browserRemote) await browserRemote('release', [ownerSessionId]).catch(() => undefined);
      return snapshot;
    },
    // Cold-lane fill for the remote surface: a canonical session.read whose
    // replay frame returns through the broadcast sessionState lane. An open
    // reads before the phone registers the session as visible, so the read is
    // marked for this connection: the relay fan-out delivers its answer
    // anyway, as the desktop transport does (shouldPublishSessionState).
    prefetchSession: async ([sessionId, itemLimit, readTraceId]) => {
      const session = requiredSessionId(sessionId);
      const limit = requiredTranscriptItemLimit(itemLimit);
      client?.requestRead?.(session);
      // Before the read: its answer may be published before it returns.
      if (limit !== undefined) client?.requestTranscriptPage?.(session, limit);
      try {
        const accepted =
          (await host.prefetchSession?.(
            session,
            limit,
            typeof readTraceId === 'string' && readTraceId ? readTraceId : undefined
          )) ?? false;
        if (accepted !== true) client?.releaseRead?.(session);
        return accepted;
      } catch (error) {
        client?.releaseRead?.(session);
        throw error;
      }
    },
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
    resolveToolApprovalForSession: async ([sessionId, id, decision]) => {
      const session = requiredSessionId(sessionId);
      const approvalId = requiredString(id, 'approval id', 1_024);
      const answer = requiredToolApprovalDecision(decision);
      // An older phone page answers a notification's Allow here with a bare
      // { approved: true }. The card's own Allow on a payment, a permanent
      // delete or an Office rollback says response 'approve' (ApprovalCard.tsx
      // approvalCardRows), so a bare Allow for one of those is refused: the
      // notification already opened the app on it, where it is decided.
      if (
        answer.approved &&
        answer.response === undefined &&
        approvalNotifications?.approvalPointerOnly(session, approvalId) === true
      ) {
        return false;
      }
      return resolveToolApprovalAnnouncingGrant(
        host,
        (name, args) => host.invokeDesktopOperation(name, args),
        session,
        approvalId,
        { ...answer, device: await connectionDevice() }
      );
    },
    // A phone notification's Allow / Deny (native-push-bridge.ts). Deny answers
    // as the card's 거절. Allow answers once with the very decision this PC's
    // card sends for its 한 번만 허용 (a permission request's once scope...;
    // shared/approval-enter-rule.ts), and only for the approval the session
    // shows now where that card allows it with a bare Enter (push-notifier.ts
    // approvalAllowDecision); any other Allow (a payment, a permanent delete,
    // an always-only permission, a sign-in...) is refused here, whatever the
    // phone offered, and answered 'open'.
    answerApprovalNotification: async ([sessionId, id, action]): Promise<ApprovalNotificationAnswer> => {
      const session = requiredSessionId(sessionId);
      const approvalId = requiredString(id, 'approval id', 1_024);
      if (action !== 'allow' && action !== 'deny') throw new TypeError('action must be allow or deny.');
      const decision =
        action === 'allow' ? approvalNotifications?.approvalAllowDecision(session, approvalId) : { approved: false };
      if (!decision) return 'open';
      const accepted = await resolveToolApprovalAnnouncingGrant(
        host,
        (name, args) => host.invokeDesktopOperation(name, args),
        session,
        approvalId,
        { ...decision, device: await connectionDevice() }
      );
      return accepted ? 'answered' : 'settled';
    },
    inheritSession: ([sourceSessionId, selection, options]) =>
      host.inheritSession(
        requiredSessionId(sourceSessionId),
        selection == null ? null : requiredModelSelection(selection),
        { compact: (options as { compact?: unknown } | null | undefined)?.compact === true }
      ),
  };
}
