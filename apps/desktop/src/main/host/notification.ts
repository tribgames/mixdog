/**
 * `host/notification/show{title, body, threadId?, sound?, volume?}`: the core
 * decides whether and what to notify (preferences, on-screen check); this host
 * only presents the OS toast and plays the sound, and reports a click as
 * `host/notification/clicked{threadId}` so the core routes it.
 */
import type { Notification } from 'electron';

import { retainNotification } from '../notification-window';
import { HOST_METHOD, type HostConnection, HostRpcError, HOST_INVALID_PARAMS, objectParams } from './connection';

export interface NotificationPresenter {
  /** The OS toast for already-bounded content. */
  createNotification(content: { title: string; body: string }): Pick<Notification, 'on' | 'show'>;
  /** Plays the notification sound at `volume` percent (0–100); absent volume = the user's own. */
  playSound?(volume: number | undefined): Promise<unknown>;
  /** Brings this PC's window forward (the session itself is routed by the core). */
  activate(): void;
}

export function registerNotificationHost(connection: HostConnection, presenter: NotificationPresenter): void {
  const live = new Set<unknown>();
  connection.handleNotification(HOST_METHOD.notificationShow, (params) => {
    const { title, body, threadId, sound, volume } = objectParams(params, HOST_METHOD.notificationShow);
    if (typeof title !== 'string' || typeof body !== 'string') {
      throw new HostRpcError(HOST_INVALID_PARAMS, 'host/notification/show needs a title and a body.');
    }
    const notification = presenter.createNotification({ title, body });
    retainNotification(live, notification);
    notification.on('click', () => {
      presenter.activate();
      if (typeof threadId === 'string' && threadId) connection.notify(HOST_METHOD.notificationClicked, { threadId });
    });
    notification.show();
    if (sound !== undefined && sound !== null && sound !== 'none') {
      void presenter.playSound?.(typeof volume === 'number' ? volume : undefined).catch(() => undefined);
    }
  });
}
