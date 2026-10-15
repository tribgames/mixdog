/**
 * Correlates the agent `terminal` tool's "open a tab and enter this command"
 * request with the renderer. The renderer claims a request just before it
 * enters the command; a request whose tool call already gave up (timeout or a
 * dropped bridge connection) is no longer claimable, so a command reported as
 * failed never runs later.
 */
import { randomUUID } from 'node:crypto';
import type { DesktopTerminalRunRequest } from '../../shared/terminal-command';

export interface TerminalRunRequests {
  /** Resolves once the renderer claims the request; rejects when no window can
   *  take it or `signal` aborts first (the request is then cancelled). */
  open(sessionId: string, command: string, signal: AbortSignal): Promise<void>;
  /** True exactly once per still-waiting request. */
  claim(requestId: string): boolean;
}

export function createTerminalRunRequests(send: (request: DesktopTerminalRunRequest) => boolean): TerminalRunRequests {
  const waiting = new Map<string, () => void>();
  return {
    open(sessionId, command, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const requestId = randomUUID();
        waiting.set(requestId, () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
        function onAbort(): void {
          if (!waiting.delete(requestId)) return;
          send({ sessionId, cancelRequestId: requestId });
          reject(signal.reason);
        }
        if (!send({ sessionId, command, requestId })) {
          waiting.delete(requestId);
          reject(new Error('no desktop window is available to open a terminal'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    claim(requestId) {
      const settle = waiting.get(requestId);
      if (!settle) return false;
      waiting.delete(requestId);
      settle();
      return true;
    },
  };
}
