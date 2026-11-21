import type { SectionLink } from './phone-section-link.ts';

export interface LoginFlows {
  subscribeUpdated(listener: (update: { flowId: string; state: unknown }) => void): () => void;
  subscribeLost(listener: (update: { flowId: string }) => void): () => void;
  read(flowId: string): { state: unknown; lost: boolean };
}

export function createLoginFlows(link: Pick<SectionLink, 'upWith' | 'notifications'>): LoginFlows {
  const flows = new Map<string, unknown>();
  const lostFlows = new Set<string>();
  const loginListeners = new Set<(update: { flowId: string; state: unknown }) => void>();
  const lostListeners = new Set<(update: { flowId: string }) => void>();
  let stopTracking: (() => void) | undefined;
  const lose = (flowId: string): void => {
    if (lostFlows.has(flowId)) return;
    lostFlows.add(flowId);
    for (const listener of [...lostListeners]) listener({ flowId });
  };
  const track = (): void => {
    if (stopTracking) return;
    stopTracking = link.upWith((client, current) => {
      // A sign-in feed is connection-bound. Keep its last state for a reader, but never present an old flow as live.
      for (const flowId of flows.keys()) lose(flowId);
      const offs = [
        link.notifications(client, current, 'login/updated', (params) => {
          if (typeof params.flowId !== 'string') return;
          flows.set(params.flowId, params.state);
          lostFlows.delete(params.flowId);
          for (const listener of [...loginListeners]) listener({ flowId: params.flowId, state: params.state });
        }),
        client.on((event) => {
          if (current() && event.type === 'status' && event.status.state !== 'ready') {
            for (const flowId of flows.keys()) lose(flowId);
          }
        }),
        client.store.subscribe((change) => {
          if (
            current() &&
            change.type === 'subscription' &&
            change.state === 'lost' &&
            change.feedId.startsWith('login:')
          ) {
            lose(change.feedId.slice('login:'.length));
          }
        }),
      ];
      return () => {
        for (const off of offs) off();
      };
    });
  };
  const stopIdleTracking = (): void => {
    if (loginListeners.size || lostListeners.size) return;
    stopTracking?.();
    stopTracking = undefined;
    flows.clear();
    lostFlows.clear();
  };
  return {
    subscribeUpdated: (listener) => {
      loginListeners.add(listener);
      track();
      return () => {
        loginListeners.delete(listener);
        stopIdleTracking();
      };
    },
    subscribeLost: (listener) => {
      lostListeners.add(listener);
      track();
      return () => {
        lostListeners.delete(listener);
        stopIdleTracking();
      };
    },
    read: (flowId) => ({ state: flows.get(flowId), lost: lostFlows.has(flowId) || !flows.has(flowId) }),
  };
}
