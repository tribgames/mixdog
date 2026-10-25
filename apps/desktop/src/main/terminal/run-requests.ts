/**
 * Correlates the agent `terminal` tool's reveal of a terminal that main already
 * started with the desktop renderer. The renderer claims the request once a
 * pane really shows that terminal, which is how the tool result tells "shown"
 * from "running in the background".
 */
import { randomUUID } from 'node:crypto';
import type { DesktopTerminalRunRequest } from '../../shared/terminal-command';

export interface TerminalRunRequests {
  /** Sends the reveal. True when the renderer claims it within `timeoutMs`
   *  (a pane shows the terminal); false when no window can take it or nobody
   *  claims it in time (the terminal runs in the background). */
  reveal(request: Omit<DesktopTerminalRunRequest, 'requestId'>, timeoutMs: number): Promise<boolean>;
  /** True exactly once per still-waiting request. */
  claim(requestId: string): boolean;
}

export function createTerminalRunRequests(send: (request: DesktopTerminalRunRequest) => boolean): TerminalRunRequests {
  const waiting = new Map<string, () => void>();
  return {
    reveal(request, timeoutMs) {
      return new Promise<boolean>((resolve) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          waiting.delete(requestId);
          resolve(false);
        }, timeoutMs);
        waiting.set(requestId, () => {
          clearTimeout(timer);
          resolve(true);
        });
        if (!send({ ...request, requestId })) {
          waiting.delete(requestId);
          clearTimeout(timer);
          resolve(false);
        }
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
