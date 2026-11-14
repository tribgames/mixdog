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
 *
 * Three more are served for the engine's `snapshot format=pdf` and `network
 * <requestId>`: Page.printToPDF runs through the page's own printer (the
 * embedded debugger does not carry it) inside the visual-output privacy check
 * a screenshot runs, and the request body readers answer as network-report.ts
 * read them.
 */
import type { WebContents } from 'electron';

import type { Precondition } from '../../../../../../packages/protocol/src/index.ts';
import { CDP_REQUEST_TIMEOUT_MS, MAX_PRINTED_PDF_BYTES } from '../../browser/host-types';
import type { BrowserVisualPrivacy } from '../../browser/visual-privacy';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import type { EngineContext } from './context';
import { MAX_INLINE_RESULT_BYTES, uploadBlob } from './blob-upload';
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
  'Page.printToPDF',
  'Network.getRequestPostData',
  'Network.getResponseBody',
]);

/** What `Page.printToPDF` needs of the browser host: the privacy check a screenshot runs (screenshots.prepareVisualOutput). */
export interface CdpSendHost {
  prepareVisualOutput: BrowserVisualPrivacy | ((guest: WebContents, signal?: AbortSignal) => Promise<(() => Promise<void>) | undefined>);
}

const SEND_MAX_TIMEOUT_MS = 60_000;

/** The refusal of `method`, or undefined when it is on the list. */
export function cdpSendRefusal(method: string): string | undefined {
  return CDP_SEND_ALLOWED.has(method) ? undefined : `CDP method ${method} is not available through host/browser/cdp/send`;
}

/**
 * The page printed as the old `snapshot format=pdf` printed it (printBackground), inside the visual-output privacy check: a page
 * holding a filled secret is refused for a PDF as for a screenshot. Inline base64 up to the inline limit, else a blob ref.
 */
async function printToPdf(connection: HostConnection, host: CdpSendHost, signal: AbortSignal, page: EnginePageCall) {
  const finishPrivacyCheck = await host.prepareVisualOutput(page.guest, signal);
  const printed = await page.guest.printToPDF({ printBackground: true });
  await finishPrivacyCheck?.();
  if (printed.length > MAX_PRINTED_PDF_BYTES) {
    throw new HostRpcError(ENGINE_ERROR.failed, `printed PDF is ${printed.length} bytes; limit is ${MAX_PRINTED_PDF_BYTES} bytes`);
  }
  if (!printed.length) throw new HostRpcError(ENGINE_ERROR.failed, 'the page could not be printed to PDF');
  const data = printed.toString('base64');
  if (data.length <= MAX_INLINE_RESULT_BYTES / 2) return { result: { data } };
  return { result: { blob: await uploadBlob(connection, printed, 'application/pdf') } };
}

async function send(
  connection: HostConnection,
  ctx: EngineContext,
  host: CdpSendHost,
  params: EngineParams,
  signal: AbortSignal,
  page: EnginePageCall
) {
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
  if (method === 'Page.printToPDF') {
    guardBeforeDispatch(page, expect as Precondition | undefined)?.();
    return printToPdf(connection, host, signal, page);
  }
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
export function registerCdpSend(connection: HostConnection, ctx: EngineContext, host: CdpSendHost): void {
  registerEngineMethod(connection, ctx, 'host/browser/cdp/send', (params, signal, page) =>
    send(connection, ctx, host, params, signal, page)
  );
}
