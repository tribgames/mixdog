// After a connector's browser sign-in, the window that started it comes back
// to the front so the user sees its row turn 연결됨. Only a sign-in this
// window began with the host browser (beginMcpOAuthLogin through its own
// capability IPC) is tracked, and it raises the window at most once: when the
// host reports the browser callback arrived (or the flow settled after the
// browser step). A cancel, a timeout or anything else never takes focus.

type Row = Record<string, unknown>;

// A sign-in nobody finishes is forgotten after the host's own deadline.
const FLOW_TTL_MS = 6 * 60_000;

export interface SignInFocus {
  /** Every capability call of the window and its result value. */
  observe(capability: string, args: readonly unknown[], value: unknown): void;
}

export function createSignInFocus({ activate, now = Date.now }: { activate(): void; now?: () => number }): SignInFocus {
  const flows = new Map<string, number>();
  const record = (value: unknown): Row => (value && typeof value === 'object' ? (value as Row) : {});
  return {
    observe(capability, args, value) {
      for (const [flowId, expires] of flows) if (expires < now()) flows.delete(flowId);
      const result = record(value);
      if (capability === 'beginMcpOAuthLogin') {
        // Away from the host (openBrowser: false) the browser is on another device.
        if (record(args[1]).openBrowser === false) return;
        if (result.state === 'pending' && typeof result.flowId === 'string') {
          flows.set(result.flowId, now() + FLOW_TTL_MS);
        }
        return;
      }
      const flowId = typeof args[0] === 'string' ? args[0] : '';
      if (!flowId || !flows.has(flowId)) return;
      if (capability === 'cancelMcpOAuthLogin') {
        flows.delete(flowId);
        return;
      }
      if (capability !== 'getMcpOAuthLoginStatus') return;
      const state = String(result.state || '');
      const step = String(result.step || '');
      if (state === 'pending' && (step === 'starting' || step === 'browser' || !step)) return;
      flows.delete(flowId);
      // The user left the browser on purpose (cancel) or never came back (timeout).
      if (state === 'cancelled' || result.reason === 'timeout') return;
      activate();
    },
  };
}
