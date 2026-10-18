// OS notifications for a server window, raised on this PC: a session's final
// answer and a tool approval waiting, both labeled with the server's name, and
// the link dropping or coming back while the window is in the background.
// Clicking one brings that server's window (and session) to the front.
import type {
  DesktopAgentPoolRow,
  DesktopConnectionLinkView,
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
} from '../../shared/contract';
import type { Notification } from 'electron';
import { createDesktopTurnNotifier } from '../desktop-turn-notifier';
import type { SessionFinalAnswer } from '../session-final-answer';

type NativeNotification = ReturnType<ServerNotifierOptions['createNotification']>;

/** A drop shorter than this is not worth a notification. */
export const LINK_LOST_NOTICE_DELAY_MS = 5_000;

export interface ServerNotifierSources {
  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void;
  subscribeAgentPool(listener: (agents: DesktopAgentPoolRow[]) => void): () => void;
  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void;
  subscribeLink(listener: (view: DesktopConnectionLinkView) => void): () => void;
  readFinalAnswer(sessionId: string, startedAt: number, signal?: AbortSignal): Promise<SessionFinalAnswer | null>;
}

export interface ServerNotifierOptions {
  serverName: string;
  sources: ServerNotifierSources;
  /** The user's notification setting (this PC's). */
  isEnabled(): boolean;
  isSupported(): boolean;
  /** The server's window is visible and focused. */
  isForeground(): boolean;
  createNotification(content: { title: string; body: string }): Pick<Notification, 'on' | 'show' | 'close'>;
  playSound?(): Promise<string>;
  /** Bring the server's window to the front, on `sessionId` when given. */
  focus(sessionId?: string): void;
  /** The fixed texts, in this PC's UI language at the moment they show. */
  text: ServerNotifierText;
  diagnostic(event: string, details: Record<string, unknown>): void;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface ServerNotifierText {
  approvalWaiting(): string;
  /** `{{name}}` is replaced by the server's name. */
  lostTitle(): string;
  lostReconnecting(): string;
  lostStopped(): string;
  restoredTitle(): string;
  restoredBody(): string;
}

export interface ServerNotifier {
  dispose(): void;
}

const named = (template: string, name: string): string => template.replace('{{name}}', () => name);

/** A server names its sessions and supplies their previews: the OS gets
 *  bounded text, one line for the title. */
export const NOTIFICATION_TITLE_CHARS = 120;
export const NOTIFICATION_BODY_CHARS = 240;
const clip = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};
export function boundedNotification(content: { title: string; body: string }): { title: string; body: string } {
  return {
    title: clip(content.title.replace(/\s+/g, ' ').trim(), NOTIFICATION_TITLE_CHARS),
    body: clip(content.body.trim(), NOTIFICATION_BODY_CHARS),
  };
}

export function createServerNotifier(options: ServerNotifierOptions): ServerNotifier {
  const schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  // The server's name leads and stays whole; the session title gives way.
  const serverLabel = clip(options.serverName, 40);
  const label = (title: string): string => `${serverLabel} · ${title}`;
  const create = (content: { title: string; body: string }) => options.createNotification(boundedNotification(content));
  const live = new Set<NativeNotification>();
  const show = (content: { title: string; body: string }, sessionId?: string): void => {
    if (!options.isSupported()) return;
    try {
      const notification = create(content);
      live.add(notification);
      const release = () => live.delete(notification);
      notification.on('close', release);
      notification.on('failed', release);
      notification.on('click', () => {
        release();
        options.focus(sessionId);
      });
      notification.show();
    } catch (error) {
      options.diagnostic('server-notification-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Final answers: the same completion rule as this PC's sessions.
  const turns = createDesktopTurnNotifier({
    isEnabled: options.isEnabled,
    isSupported: options.isSupported,
    isForeground: options.isForeground,
    createNotification: (content) => create({ ...content, title: label(content.title) }),
    ...(options.playSound ? { playSound: options.playSound } : {}),
    readFinalAnswer: options.sources.readFinalAnswer,
    openSession: (sessionId) => options.focus(sessionId),
    diagnostic: (event, details) => options.diagnostic(`server-turn-notification-${event}`, details),
  });

  // Approvals: a session that STARTS waiting on a tool approval needs the user.
  const titles = new Map<string, string>();
  const approvals = new Map<string, string>();
  const onSessionState = (update: DesktopSessionStateUpdate): void => {
    const sessionId = update.sessionId;
    const approval = (update.snapshot as { toolApproval?: { id?: unknown } | null } | null)?.toolApproval;
    const key = approval ? String(approval.id ?? 'pending') : null;
    const previous = approvals.get(sessionId) ?? null;
    if (key) approvals.set(sessionId, key);
    else approvals.delete(sessionId);
    if (!key || key === previous || update.frameSource === 'replay') return;
    if (!options.isEnabled() || options.isForeground()) return;
    show(
      { title: label(titles.get(sessionId) || options.serverName), body: options.text.approvalWaiting() },
      sessionId
    );
  };

  // The link: a drop that lasts, and the recovery after a drop that was told.
  let lostTimer: unknown = null;
  let lostShown = false;
  let previous: DesktopConnectionLinkView['state']['status'] = 'connected';
  const onLink = (view: DesktopConnectionLinkView): void => {
    const status = view.state.status;
    const was = previous;
    previous = status;
    if (status === 'connected') {
      if (lostTimer) cancel(lostTimer);
      lostTimer = null;
      if (lostShown && options.isEnabled() && !options.isForeground()) {
        show({
          title: named(options.text.restoredTitle(), serverLabel),
          body: options.text.restoredBody(),
        });
      }
      lostShown = false;
      return;
    }
    // Sleep is not a loss, and a loss already told is not told again.
    if (status === 'paused' || was === 'paused' || lostShown || lostTimer) return;
    const terminal = view.state.status === 'lost' && view.state.terminal;
    const raise = (): void => {
      lostTimer = null;
      if (!options.isEnabled() || options.isForeground()) return;
      lostShown = true;
      show({
        title: named(options.text.lostTitle(), serverLabel),
        body: terminal ? options.text.lostStopped() : options.text.lostReconnecting(),
      });
    };
    if (terminal) raise();
    else lostTimer = schedule(raise, LINK_LOST_NOTICE_DELAY_MS);
  };

  const unsubscribers = [
    options.sources.subscribeSessions((sessions) => {
      for (const session of sessions) titles.set(session.id, session.title || session.preview || options.serverName);
      turns.onSessions(sessions);
    }),
    options.sources.subscribeAgentPool(turns.onAgentPool),
    options.sources.subscribeSessionStates(onSessionState),
    options.sources.subscribeLink(onLink),
  ];

  return {
    dispose() {
      if (lostTimer) cancel(lostTimer);
      for (const unsubscribe of unsubscribers) unsubscribe();
      turns.dispose();
      for (const notification of live) notification.close();
      live.clear();
    },
  };
}
