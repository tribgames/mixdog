// Provider OAuth login flows in flight (browser round-trip or manual code).
// The registry owns flow ids, the expiry timer and cancellation, and hands
// back the plain status record the renderer polls.
import type { DesktopOAuthFlow } from './backend-support';
import { recordValue } from './backend-support';

const FLOW_TTL_MS = 10 * 60 * 1_000;

export function oauthFlowStatus(flow: DesktopOAuthFlow): Record<string, unknown> {
  return {
    flowId: flow.id,
    provider: flow.provider,
    url: flow.url,
    manualUrl: flow.manualUrl,
    state: flow.state,
    completed: flow.state === 'complete',
    error: flow.error,
    manualCodeSupported: Boolean(flow.completeCode),
  };
}

function cancelFlow(flow: DesktopOAuthFlow, reason: string): void {
  try {
    const result = flow.cancel?.();
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch((error: unknown) => {
        console.warn(`OAuth flow could not be ${reason}:`, error);
      });
    }
  } catch (error) {
    console.warn(`OAuth flow could not be ${reason}:`, error);
  }
}

export function createOAuthFlowRegistry() {
  const flows = new Map<string, DesktopOAuthFlow>();
  let sequence = 0;

  function get(id: string): DesktopOAuthFlow | undefined {
    return flows.get(id);
  }

  function remove(id: string): void {
    flows.delete(id);
  }

  /** Register a provider-started flow and return its pollable status. */
  function register(value: unknown): Record<string, unknown> {
    const started = recordValue(value);
    if (!started) throw new Error('OAuth provider did not return a login flow.');
    const provider = String(started.provider || '').trim();
    if (!provider) throw new Error('OAuth provider login is missing its provider id.');
    const id = `oauth_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
    const flow: DesktopOAuthFlow = {
      id,
      provider,
      url: typeof started.url === 'string' ? started.url : null,
      manualUrl: typeof started.manualUrl === 'string' ? started.manualUrl : null,
      state: 'pending',
      result: null,
      error: null,
      completeCode: typeof started.completeCode === 'function'
        ? started.completeCode as (code: string) => Promise<unknown>
        : undefined,
      cancel: typeof started.cancel === 'function' ? started.cancel as () => unknown : undefined,
      // An abandoned browser round-trip must not pin the flow forever.
      timeout: setTimeout(() => {
        const current = flows.get(id);
        if (!current) return;
        cancelFlow(current, 'expired');
        flows.delete(id);
      }, FLOW_TTL_MS),
    };
    flow.timeout.unref?.();
    flows.set(id, flow);
    const waitForCallback = started.waitForCallback;
    if (waitForCallback && typeof (waitForCallback as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(waitForCallback).then((result) => {
        const current = flows.get(id);
        if (!current || current.state !== 'pending' || !result) return;
        current.state = 'complete';
        current.result = true;
      }).catch((error) => {
        const current = flows.get(id);
        if (!current || current.state !== 'pending') return;
        current.state = 'failed';
        current.error = error instanceof Error ? error.message : String(error);
      });
    }
    return oauthFlowStatus(flow);
  }

  /** Engine disposal: cancel and forget every in-flight login. */
  function cancelAll(): void {
    for (const flow of flows.values()) {
      clearTimeout(flow.timeout);
      cancelFlow(flow, 'disposed');
    }
    flows.clear();
  }

  return { register, get, remove, cancelAll };
}
