// Request/response envelopes between this desktop leg and the relay itself
// (`list-clients`, `revoke-client`): each carries a request id the relay
// echoes, and each waits at most one revoke timeout for its answer.
import { randomUUID } from 'node:crypto';

import { REVOKE_TIMEOUT_MS } from './remote-relay-device';

interface PendingControlRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface RelayControlRequests {
  request<T>(type: string, payload?: Record<string, unknown>): Promise<T>;
  /** Settles the request a `clients-list` / `client-revoked` envelope answers.
   *  Returns false when the envelope is not a control answer at all. */
  settle(envelope: Record<string, unknown>): boolean;
  /** Fails every waiting request: the leg closed or the relay disconnected. */
  rejectAll(message: string): void;
}

export function createRelayControlRequests(deps: {
  sendEnvelope(payload: unknown): void;
  connected(): boolean;
}): RelayControlRequests {
  const pending = new Map<string, PendingControlRequest>();
  return {
    request: <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (!deps.connected()) {
          reject(new Error('Relay is not connected.'));
          return;
        }
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('Relay device request timed out.'));
        }, REVOKE_TIMEOUT_MS);
        timer.unref?.();
        pending.set(requestId, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });
        deps.sendEnvelope({ type, requestId, ...payload });
      }),
    settle: (envelope) => {
      if (envelope.type !== 'clients-list' && envelope.type !== 'client-revoked') return false;
      const requestId = String(envelope.requestId || '');
      const waiting = pending.get(requestId);
      if (!waiting) return true;
      pending.delete(requestId);
      clearTimeout(waiting.timer);
      if (envelope.ok === false) {
        waiting.reject(new Error(String(envelope.error || 'Relay device request failed.')));
      } else {
        waiting.resolve(envelope.type === 'clients-list' ? envelope.clients : envelope.ok);
      }
      return true;
    },
    rejectAll: (message) => {
      for (const [requestId, waiting] of pending) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(message));
        pending.delete(requestId);
      }
    },
  };
}
