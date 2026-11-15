/**
 * `host/notification/show{title, body, threadId?, sound?, volume?}`: the core
 * decides whether and what to notify (preferences, on-screen check); this host
 * only presents the OS toast and plays the sound, and reports a click as
 * `host/notification/clicked{threadId}` so the core routes it.
 */
import type { Notification } from 'electron';

import type {
  HostNotificationClickedParams,
  HostNotificationShowParams,
  HostNotificationStatus,
} from '../../../../../packages/protocol/src/index.ts';
import { retainNotification } from '../notification-window';
import { HOST_METHOD, type HostConnection, HostRpcError, HOST_INVALID_PARAMS, objectParams } from './connection';

export interface NotificationPresenter {
  /** The OS toast for already-bounded content. */
  createNotification(content: { title: string; body: string }): Pick<Notification, 'on' | 'show' | 'close'>;
  /** Plays the notification sound at `volume` percent (0–100); absent volume = the user's own. */
  playSound?(volume: number | undefined): Promise<unknown>;
  /** Brings this PC's window forward and, when a click names a session, opens it there. */
  activate(threadId?: string): void;
  /** Brings a server connection's window forward and shows the thread in it (a click on that server's notification). */
  focusConnection?(connectionId: string, threadId: string | undefined): void;
  /** Whether the OS can show toasts at all. */
  isSupported(): boolean;
  /** Fixed product text in this PC's UI language. */
  translate?(key: string): string;
  /** The desktop pet's overlay shows this session's replies right now: a toast for it is redundant. */
  showsThread?(threadId: string): boolean;
  /** One step of a toast, named `turn-notification-<step>` for the desktop diagnostics log: suppressed, requested, os-show,
   *  sound, sound-failed, closed, failed and clicked happen here (detection and the core's own refusals are in its log). */
  diagnostic?(event: string, details: Record<string, unknown>): void;
  /** The OS's own idle time in seconds: input anywhere on the PC counts. */
  idleSeconds(): number;
}

export const TEST_NOTIFICATION_BODY = 'Notifications from Mixdog appear like this.';

/** Registers the toast methods; the result closes every toast this host still holds (the app is quitting). */
export function registerNotificationHost(connection: HostConnection, presenter: NotificationPresenter): () => void {
  const live = new Set<unknown>();
  const byConnection = new Map<string, Set<Pick<Notification, 'on' | 'show' | 'close'>>>();
  connection.handleNotification(HOST_METHOD.notificationClose, (params) => {
    const { connectionId } = objectParams<{ connectionId?: unknown }>(params, HOST_METHOD.notificationClose);
    if (typeof connectionId !== 'string' || !connectionId) return;
    for (const notification of [...(byConnection.get(connectionId) ?? [])]) notification.close();
    byConnection.delete(connectionId);
  });
  // What Node's `notificationStatus` host method answered (main/index.ts at b6f10295a): paired devices hold their pushes
  // while this PC is in use.
  connection.handleRequest(HOST_METHOD.notificationStatus, async (): Promise<HostNotificationStatus> => ({
    supported: presenter.isSupported(),
    idleSeconds: presenter.idleSeconds(),
  }));
  connection.handleNotification(HOST_METHOD.notificationShow, (params) => {
    const { title, body, threadId, connectionId, sound, volume } = objectParams<HostNotificationShowParams>(
      params,
      HOST_METHOD.notificationShow
    );
    if (typeof title !== 'string' || typeof body !== 'string') {
      throw new HostRpcError(HOST_INVALID_PARAMS, 'host/notification/show needs a title and a body.');
    }
    const thread = typeof threadId === 'string' && threadId ? threadId : undefined;
    const server = typeof connectionId === 'string' && connectionId ? connectionId : undefined;
    const report = (event: string, details: Record<string, unknown> = {}): void =>
      presenter.diagnostic?.(`turn-notification-${event}`, { ...(thread ? { sessionId: thread } : {}), ...details });
    // Status is requested by notify/test before this one-way delivery. A capability change
    // here can only suppress presentation; throwing cannot become the request's result.
    if (!presenter.isSupported()) return report('suppressed', { reason: 'unsupported' });
    // This PC's own overlay shows the session: what the main window shows is the core's screen set, this one is the host's.
    if (thread && !server && presenter.showsThread?.(thread)) return report('suppressed', { reason: 'foreground-visible' });
    let notification: Pick<Notification, 'on' | 'show' | 'close'>;
    try {
      notification = presenter.createNotification({
        title,
        body: body === TEST_NOTIFICATION_BODY ? (presenter.translate?.(body) ?? body) : body,
      });
    } catch (error) {
      return report('failed', { error: error instanceof Error ? error.message : String(error) });
    }
    retainNotification(live, notification);
    // A server's toasts are kept by its connection, so the core can close them when the server's notifier ends.
    if (server) {
      const set = byConnection.get(server) ?? new Set();
      set.add(notification);
      byConnection.set(server, set);
      const forget = () => {
        set.delete(notification);
        if (set.size === 0 && byConnection.get(server) === set) byConnection.delete(server);
      };
      notification.on('close', forget);
      notification.on('click', forget);
    }
    notification.on('show', () => report('os-show'));
    notification.on('close', () => report('closed'));
    notification.on('failed', (_event: unknown, error: unknown) => report('failed', { error }));
    notification.on('click', () => {
      report('clicked');
      if (server && presenter.focusConnection) presenter.focusConnection(server, thread);
      else presenter.activate(thread);
      if (thread) {
        const clicked: HostNotificationClickedParams = {
          threadId: thread as HostNotificationClickedParams['threadId'],
          ...(server ? { connectionId: server } : {}),
        };
        connection.notify(HOST_METHOD.notificationClicked, clicked);
      }
    });
    report('requested');
    try {
      notification.show();
    } catch (error) {
      live.delete(notification);
      return report('failed', { error: error instanceof Error ? error.message : String(error) });
    }
    if (sound !== undefined && sound !== null && sound !== 'none') {
      void presenter
        .playSound?.(typeof volume === 'number' ? volume : undefined)
        .then((result) => report('sound', { result }))
        .catch((error: unknown) => report('sound-failed', { error: error instanceof Error ? error.message : String(error) }));
    }
  });
  return () => {
    for (const notification of [...live]) (notification as Pick<Notification, 'close'>).close();
    live.clear();
  };
}
