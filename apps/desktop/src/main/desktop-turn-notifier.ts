import type { Notification } from 'electron';
import { createFinalAnswerWatcher } from './final-answer-watcher';
import { shouldShowTurnNotification, type TurnCompletion } from './push-turn-events';
import type { SessionFinalAnswer } from './session-final-answer';

type NativeNotification = Pick<Notification, 'on' | 'show' | 'close'>;

interface DesktopTurnNotifierOptions {
  isEnabled(): boolean;
  isSupported(): boolean;
  isForeground(): boolean;
  readFinalAnswer(sessionId: string, startedAt: number, signal?: AbortSignal): Promise<SessionFinalAnswer | null>;
  createNotification(content: { title: string; body: string }): NativeNotification;
  playSound?(): Promise<string>;
  openSession(sessionId: string): void;
  diagnostic(event: string, details: Record<string, unknown>): void;
}

/** Completion detection and native delivery share one app-lifetime owner.
 * A native "show" event means OS acceptance, NOT proof that a banner was
 * visible. Keep that distinction in diagnostics and in the live probe. */
export function createDesktopTurnNotifier(options: DesktopTurnNotifierOptions) {
  const live = new Set<NativeNotification>();
  const report = (event: string, completion: TurnCompletion, details: Record<string, unknown> = {}) =>
    options.diagnostic(event, { sessionId: completion.sessionId, ...details });

  const deliver = (completion: TurnCompletion): void => {
    if (!options.isSupported()) {
      report('suppressed', completion, { reason: 'unsupported' });
      return;
    }
    if (!shouldShowTurnNotification(completion, options.isForeground())) {
      report('suppressed', completion, { reason: 'foreground' });
      return;
    }
    let notification: NativeNotification | undefined;
    try {
      notification = options.createNotification({ title: completion.title, body: completion.preview });
      const current = notification;
      const release = () => {
        live.delete(current);
      };
      live.add(current);
      let soundStarted = false;
      current.on('show', () => {
        report('os-show', completion);
        if (soundStarted || !options.playSound || !options.isEnabled()) return;
        soundStarted = true;
        void options
          .playSound()
          .then((result) => report('sound', completion, { result }))
          .catch((error: unknown) =>
            report('sound-failed', completion, {
              error: error instanceof Error ? error.message : String(error),
            })
          );
      });
      current.on('close', () => {
        release();
        report('closed', completion);
      });
      current.on('failed', (_event, error) => {
        release();
        report('failed', completion, { error });
      });
      current.on('click', () => {
        release();
        report('clicked', completion);
        options.openSession(completion.sessionId);
      });
      report('requested', completion);
      current.show();
    } catch (error) {
      if (notification) live.delete(notification);
      report('failed', completion, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const watcher = createFinalAnswerWatcher({
    isEnabled: options.isEnabled,
    readFinalAnswer: options.readFinalAnswer,
    onFinalAnswer: deliver,
    onDiagnostic: options.diagnostic,
    onError: (error) => options.diagnostic('read-failed', { error }),
  });
  return {
    onSessions: watcher.onSessions,
    onAgentPool: watcher.onAgentPool,
    dispose() {
      watcher.dispose();
      for (const notification of live) notification.close();
      live.clear();
    },
  };
}
