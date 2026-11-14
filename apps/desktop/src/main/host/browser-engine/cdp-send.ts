/**
 * `host/browser/cdp/send`: the core's way to send a CDP command the engine
 * has no method of its own for. It is an allowlist, not a filter: a method
 * that is not listed here is refused with -32015, whatever the domain.
 *
 * The list is the read-side commands the engine's own modules already send
 * (frame and layout metrics, node resolution and description, property
 * reads, performance metrics) and the releases that go with them. What has a
 * method of its own stays behind that method: Runtime.evaluate and
 * Runtime.callFunctionOn (`page/eval`, `ref/call`: bound to an `expect`),
 * Page.captureScreenshot (`screenshot`), the input, emulation, fetch,
 * target, tracing and debugger domains (host-owned), the cookie and body
 * readers (`cookies`, `storage`, the network ledger). Nothing the page holds
 * as a secret leaves through a result unmasked: the registry redacts every
 * string of it.
 */
import type { Precondition } from '../../../../../../packages/protocol/src/index.ts';
import { CDP_REQUEST_TIMEOUT_MS } from '../../browser/command';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import type { EngineContext } from './context';
import { ENGINE_ERROR } from './errors';
import { assertNotBlocked, guardBeforeDispatch } from './page';
import { type EnginePageCall, type EngineParams, registerEngineMethod } from './registry';

export const CDP_SEND_ALLOWED: ReadonlySet<string> = new Set([
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'DOM.getDocument',
  'DOM.querySelectorAll',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.getBoxModel',
  'DOM.getNodeForLocation',
  'DOM.getFrameOwner',
  'Runtime.getProperties',
  'Runtime.releaseObject',
  'Runtime.releaseObjectGroup',
  'Performance.getMetrics',
]);

const SEND_MAX_TIMEOUT_MS = 60_000;

/** The refusal of `method`, or undefined when it is on the list. */
export function cdpSendRefusal(method: string): string | undefined {
  return CDP_SEND_ALLOWED.has(method) ? undefined : `CDP method ${method} is not available through host/browser/cdp/send`;
}

async function send(ctx: EngineContext, params: EngineParams, signal: AbortSignal, page: EnginePageCall) {
  const { method, sessionId, timeoutMs, expect } = params;
  if (typeof method !== 'string' || !method) throw new HostRpcError(HOST_INVALID_PARAMS, 'cdp/send needs a method.');
  const reason = cdpSendRefusal(method);
  if (reason) throw new HostRpcError(ENGINE_ERROR.refused, reason, { reason });
  if (params.params !== undefined && params.params !== null && (typeof params.params !== 'object' || Array.isArray(params.params))) {
    throw new HostRpcError(HOST_INVALID_PARAMS, 'cdp/send params must be an object.');
  }
  if (sessionId !== undefined && sessionId !== null) {
    if (typeof sessionId !== 'string' || !page.state.cdpSessions.has(sessionId)) {
      throw new HostRpcError(ENGINE_ERROR.failed, `CDP session ${String(sessionId)} is not attached to the page`);
    }
  }
  assertNotBlocked(page);
  const wait =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? Math.min(SEND_MAX_TIMEOUT_MS, Math.max(1, Math.trunc(timeoutMs)))
      : CDP_REQUEST_TIMEOUT_MS;
  const result = await ctx.cdp.call<unknown>(
    page.guest,
    method,
    (params.params as Record<string, unknown> | undefined) ?? {},
    signal,
    {
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      timeoutMs: wait,
      beforeDispatch: guardBeforeDispatch(page, expect as Precondition | undefined),
    }
  );
  return { result: result ?? {} };
}

/** Registers `host/browser/cdp/send`. */
export function registerCdpSend(connection: HostConnection, ctx: EngineContext): void {
  registerEngineMethod(connection, ctx, 'host/browser/cdp/send', (params, signal, page) =>
    send(ctx, params, signal, page)
  );
}
