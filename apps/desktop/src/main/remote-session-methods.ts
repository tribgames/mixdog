// Session lifecycle and submit methods for one remote connection. Device
// identity and the stale-view check stay with the methods that use them.
import { resolve as resolvePath } from 'node:path';

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
import { isSensitivePath } from './remote-sensitive-paths';
import { findToolRecord, remoteToolOutput, toolRecordsNamedPaths } from './remote-transcript';
import { sessionSidebarActions } from './session-sidebar-actions';
import { resolveToolApprovalAnnouncingGrant } from './approval-grant-change';
import type { RemoteMethod, RemoteMethodClient, RemoteMethodDependencies } from './remote-methods';

export const READ_NOT_VIEWED = 'This session is not open on this device.';
export const READ_NOT_HELD = 'This row is not in the transcript this device holds.';

export const STALE_SESSION_VIEW_MESSAGE = `${STALE_SESSION_VIEW_MARKER} Review the latest messages, then send again.`;

/** The folder a session's relative paths are under; '' when unknown. */
export async function sessionFolder(
  host: Pick<DesktopService, 'listSessions'>,
  sessionId: string | undefined
): Promise<string> {
  if (!sessionId) return '';
  const rows = await Promise.resolve()
    .then(() => host.listSessions())
    .catch(() => []);
  return rows.find((row) => row.id === sessionId)?.cwd ?? '';
}

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
      const transcript = await host.readSessionTranscript?.(session);
      const found = findToolRecord(transcript, id);
      if (!found) return null;
      // The remote file lanes' deny list applies to what a row names: its
      // path arguments, its diff headers, its aggregate's members, and the
      // session folder they sit in. A denied row is not served at all; the
      // phone keeps the capped copy it already holds.
      const root = await sessionFolder(host, session);
      const base = root || process.cwd();
      const named = toolRecordsNamedPaths([found.record, ...found.related]);
      const withheld = { id, withheld: true };
      if (named.unreadable) return withheld;
      const paths = named.paths.map((path) => resolvePath(base, path));
      if (root) paths.push(resolvePath(root));
      for (const path of paths) if (await isSensitivePath(path)) return withheld;
      return remoteToolOutput(transcript, id);
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
    resolveToolApprovalForSession: async ([sessionId, id, decision]) =>
      resolveToolApprovalAnnouncingGrant(
        host,
        (name, args) => host.invokeDesktopOperation(name, args),
        requiredSessionId(sessionId),
        requiredString(id, 'approval id', 1_024),
        { ...requiredToolApprovalDecision(decision), device: await connectionDevice() }
      ),
    // Per-agent push mute (profile panel, contact menu on a paired phone).
    getAgentNotificationMute: ([agentId]) => host.getAgentNotificationMute(requiredString(agentId, 'agent id', 200)),
    setAgentNotificationMute: ([agentId, muted]) => {
      if (typeof muted !== 'boolean') throw new TypeError('muted must be a boolean.');
      return host.setAgentNotificationMute(requiredString(agentId, 'agent id', 200), muted);
    },
    inheritSession: ([sourceSessionId, selection, options]) =>
      host.inheritSession(
        requiredSessionId(sourceSessionId),
        selection == null ? null : requiredModelSelection(selection),
        { compact: (options as { compact?: unknown } | null | undefined)?.compact === true }
      ),
  };
}
