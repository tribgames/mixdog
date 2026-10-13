// The connection attempts of the SSH IPC and the questions ssh asks in a window.
// An attempt is main-minted: the host-key pre-check registers one for a window and
// an address, and connect / cancel name it. Attempts and questions die with their
// window, and a window holds a handful at most.
import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent, WebContents } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract-ipc';
import type { DesktopSshAskpass } from '../../shared/contract-ssh';
import type { ConnectionManager } from '../connections/contract';
import type { HostKeyInspection } from './host-key';
import type { SshTarget } from './ssh-command';
import type { AskpassAsk } from './ssh-auth';
import { text } from './ssh-ipc-input';

export interface Attempt {
  readonly token: string;
  /** webContents.id of the window the attempt belongs to. */
  readonly senderId: number;
  readonly target: SshTarget;
  /** The pre-check as main saw it; frozen, so the key shown is the key pinned. */
  readonly inspection: Readonly<HostKeyInspection>;
  /** inspected: may connect once · connecting · restartable: found a daemon the user may replace. */
  state: 'inspected' | 'connecting' | 'restartable';
  /** The host key was dealt with (pinned or replaced); a restart does not pin again. */
  keyHandled: boolean;
  cancelled: boolean;
  recordId: string;
  wasOpen: boolean;
}

const MAX_ATTEMPTS_PER_WINDOW = 8;
const MAX_SECRET_LENGTH = 4096;

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};
const freezeInspection = (inspection: HostKeyInspection): Readonly<HostKeyInspection> =>
  deepFreeze(structuredClone(inspection));

export interface AttemptRegistry {
  /** Registers a new attempt for the sender's window, making room by dropping an idle one. */
  register(event: IpcMainInvokeEvent, target: SshTarget, inspection: HostKeyInspection): Attempt;
  /** The attempt the window named; throws when it is gone or belongs to another window. */
  owned(event: IpcMainInvokeEvent, attemptId: unknown): Attempt;
  drop(attempt: Attempt): void;
  /** Cancels the attempt of this window by id; anything else is ignored. */
  cancelFor(event: IpcMainInvokeEvent, attemptId: unknown): Promise<void>;
  /** Puts a question from ssh in front of the user in the window that asked. */
  askInWindow(sender: WebContents, attemptId: string, host: string): AskpassAsk;
  /** Hands the user's answer to the question it belongs to. */
  answer(event: IpcMainInvokeEvent, requestId: unknown, secret: unknown): void;
}

export function createAttemptRegistry(connections: Pick<ConnectionManager, 'close'>): AttemptRegistry {
  // token → attempt, oldest first.
  const attempts = new Map<string, Attempt>();
  const watchedWindows = new Set<number>();
  // requestId → the question ssh asked in a window, waiting for its answer.
  const questions = new Map<string, { senderId: number; resolve(secret: string | null): void }>();

  /** Ends an attempt that is not connecting; one that is stops where it is and
   *  gives its window back. */
  async function cancelAttempt(attempt: Attempt): Promise<void> {
    attempt.cancelled = true;
    if (attempt.state !== 'connecting') {
      attempts.delete(attempt.token);
      return;
    }
    if (attempt.recordId && !attempt.wasOpen) await connections.close(attempt.recordId).catch(() => undefined);
  }

  /** Attempts die with their window, and a window holds a handful at most. */
  function admit(event: IpcMainInvokeEvent): void {
    const { sender } = event;
    if (!watchedWindows.has(sender.id)) {
      watchedWindows.add(sender.id);
      sender.once('destroyed', () => {
        watchedWindows.delete(sender.id);
        for (const attempt of [...attempts.values()]) if (attempt.senderId === sender.id) void cancelAttempt(attempt);
        for (const [requestId, question] of questions) {
          if (question.senderId === sender.id) {
            questions.delete(requestId);
            question.resolve(null);
          }
        }
      });
    }
    const mine = [...attempts.values()].filter((attempt) => attempt.senderId === sender.id);
    while (mine.length >= MAX_ATTEMPTS_PER_WINDOW) {
      const idle = mine.find((attempt) => attempt.state !== 'connecting');
      if (!idle) throw new Error('Too many SSH connections are being made at once.');
      attempts.delete(idle.token);
      mine.splice(mine.indexOf(idle), 1);
    }
  }

  return {
    register(event, target, inspection) {
      admit(event);
      const attempt: Attempt = {
        token: randomUUID(),
        senderId: event.sender.id,
        target,
        inspection: freezeInspection(inspection),
        state: 'inspected',
        keyHandled: false,
        cancelled: false,
        recordId: '',
        wasOpen: false,
      };
      attempts.set(attempt.token, attempt);
      return attempt;
    },

    owned(event, attemptId) {
      const attempt = attempts.get(text(attemptId, 'attemptId'));
      if (!attempt || attempt.senderId !== event.sender.id) {
        throw new Error('This connection attempt is no longer active. Check the address again.');
      }
      return attempt;
    },

    drop: (attempt) => {
      attempts.delete(attempt.token);
    },

    async cancelFor(event, attemptId) {
      const attempt = attempts.get(String(attemptId));
      if (attempt?.senderId === event.sender.id) await cancelAttempt(attempt);
    },

    askInWindow: (sender, attemptId, host) => (request, signal) =>
      new Promise((resolve) => {
        if (sender.isDestroyed() || signal.aborted) return resolve(null);
        const requestId = randomUUID();
        const tell = (kind: DesktopSshAskpass['kind']): void => {
          if (sender.isDestroyed()) return;
          const payload: DesktopSshAskpass = {
            attemptId,
            requestId,
            kind,
            host,
            prompt: request.prompt,
            retry: request.retry,
            timeoutMs: 120_000,
          };
          sender.send(DESKTOP_IPC.sshAskpass, payload);
        };
        const onAbort = (): void => {
          if (!questions.delete(requestId)) return;
          tell('close');
          resolve(null);
        };
        questions.set(requestId, {
          senderId: sender.id,
          resolve: (secret) => {
            signal.removeEventListener('abort', onAbort);
            resolve(secret);
          },
        });
        signal.addEventListener('abort', onAbort, { once: true });
        tell(request.kind);
      }),

    answer(event, requestId, secret) {
      const question = questions.get(String(requestId));
      if (!question || question.senderId !== event.sender.id) return;
      questions.delete(String(requestId));
      question.resolve(typeof secret === 'string' && secret.length <= MAX_SECRET_LENGTH ? secret : null);
    },
  };
}
