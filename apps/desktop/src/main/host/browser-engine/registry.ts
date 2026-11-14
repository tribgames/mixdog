/**
 * The one way an engine method (`host/browser/*`) is served. Every handler
 * goes through here, so the checks and the exits are not repeated per method:
 *
 *  - the params are an object; a page method names a live `pageId` (-32011);
 *  - an `expect` is checked before the handler runs (-32010), and the handler
 *    checks it again beside each CDP send through `page.guarded`;
 *  - the page's queued events are flushed before the reply, so the core sees
 *    them first, and the page's facts ride the result;
 *  - every string of a result, the facts included, has the secrets known to
 *    the page masked (`redactKnown`): no handler does this itself;
 *  - a result over 192 KiB serialized is not sent: a base64 `data` payload
 *    moves to `blob/put` (the result then carries `blob`), anything else
 *    fails with a plain error.
 */
import type { BrowserBlobRef, PageFacts, Precondition } from '../../../../../../packages/protocol/src/index.ts';
import { redactBrowserText } from '../../browser/redaction';
import {
  HOST_INVALID_PARAMS,
  type HostConnection,
  HostRpcError,
  objectParams,
} from '../connection';
import { MAX_INLINE_RESULT_BYTES, uploadBlob } from './blob-upload';
import type { EngineContext, EnginePage } from './context';
import { ENGINE_ERROR, pageGone } from './errors';
import { checkPrecondition, guardedSend } from './precondition';

/** What a page method's handler works with: the live page and the guarded send. */
export interface EnginePageCall extends EnginePage {
  pageId: string;
  facts(): PageFacts;
  /** `guardedSend` bound to this page: the check and the send start in one synchronous step. */
  guarded<T>(expect: Precondition | undefined, send: () => Promise<T>): Promise<T>;
}

export type EngineParams = Record<string, unknown>;
export type EngineHandler = (params: EngineParams, signal: AbortSignal, page: EnginePageCall) => Promise<unknown>;
export type EngineSessionHandler = (params: EngineParams, signal: AbortSignal) => Promise<unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A copy of `value` with `redact` applied to every string in it. */
function redactLeaves(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactLeaves(item, redact));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactLeaves(item, redact)]));
  }
  return value;
}

function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null');
}

/** Brings a result under the response limit, or fails it. */
async function fitResult(connection: HostConnection, method: string, result: unknown): Promise<unknown> {
  if (sizeOf(result) <= MAX_INLINE_RESULT_BYTES) return result;
  if (isPlainObject(result) && typeof result.data === 'string' && result.blob === undefined) {
    const { data, ...rest } = result;
    const mimeType = typeof rest.mimeType === 'string' ? rest.mimeType : 'application/octet-stream';
    const blob: BrowserBlobRef = await uploadBlob(connection, Buffer.from(data, 'base64'), mimeType);
    const moved = { ...rest, blob };
    if (sizeOf(moved) <= MAX_INLINE_RESULT_BYTES) return moved;
  }
  throw new HostRpcError(ENGINE_ERROR.failed, `${method} result is larger than ${MAX_INLINE_RESULT_BYTES} bytes.`);
}

function asRpcError(error: unknown, redact: (text: string) => string): HostRpcError {
  if (error instanceof HostRpcError) {
    return new HostRpcError(
      error.code,
      redact(error.message),
      error.data === undefined ? undefined : redactLeaves(error.data, redact)
    );
  }
  return new HostRpcError(ENGINE_ERROR.failed, redact(redactBrowserText((error as Error)?.message || String(error))));
}

/** Serves `method` with the shared exits; `run` produces the result and the redaction for this call. */
function serve(
  connection: HostConnection,
  ctx: EngineContext,
  method: string,
  run: (
    fields: EngineParams,
    signal: AbortSignal,
    /** Masks with the page's secrets from here on, a refusal of `run` itself included. */
    maskWith: (redact: (text: string) => string) => void
  ) => { redact: (text: string) => string; result: Promise<unknown>; finish?: (result: unknown) => unknown }
): void {
  connection.handleRequest(method, async (params, signal) => {
    const fields = objectParams(params, method) as EngineParams;
    let redact: (text: string) => string = redactBrowserText;
    let recorded = false;
    const recordIn = () => {
      recorded = true;
      ctx.transcript?.record({ dir: 'in', method, params: redactLeaves(fields, redact) });
    };
    try {
      const call = run(fields, signal, (mask) => (redact = mask));
      redact = call.redact;
      recordIn();
      const settled = await call.result;
      const out = await fitResult(
        connection,
        method,
        redactLeaves(call.finish ? call.finish(settled) : settled, redact)
      );
      ctx.transcript?.record({ dir: 'out', method, result: out });
      return out;
    } catch (error) {
      if (!recorded) recordIn();
      const failure = asRpcError(error, redact);
      ctx.transcript?.record({
        dir: 'out',
        method,
        error: { code: failure.code, message: failure.message, data: failure.data },
      });
      throw failure;
    }
  });
}

/** A method addressed to a page: `params.pageId` names it, `params.expect` may bind the call to its state. */
export function registerEngineMethod(
  connection: HostConnection,
  ctx: EngineContext,
  method: string,
  handler: EngineHandler
): void {
  serve(connection, ctx, method, (fields, signal, maskWith) => {
    const { pageId, expect } = fields;
    if (typeof pageId !== 'string' || !pageId) {
      throw new HostRpcError(HOST_INVALID_PARAMS, `${method} needs a pageId.`);
    }
    const redact = (text: string) => ctx.redactKnown(pageId, text);
    maskWith(redact);
    const live = () => {
      const page = ctx.page(pageId);
      if (!page || page.guest.isDestroyed()) throw pageGone(pageId);
      return page;
    };
    const page = live();
    const facts = () => ctx.events.facts(pageId);
    if (expect !== undefined && expect !== null) {
      if (!isPlainObject(expect)) throw new HostRpcError(HOST_INVALID_PARAMS, `${method} expect must be an object.`);
      try {
        checkPrecondition(expect as unknown as Precondition, page, facts);
      } catch (error) {
        // The refusal carries the facts: the events they count go out first.
        ctx.events.flush(pageId);
        throw error;
      }
    }
    // The person's input on the page ends this call with -32012; while they hold it the call is refused.
    const running = ctx.leases?.beginCall(pageId, signal);
    const call: EnginePageCall = {
      ...page,
      pageId,
      facts,
      guarded: (bound, send) => guardedSend(page, facts, bound, send),
    };
    const result = handler(fields, running?.signal ?? signal, call).catch((error) => {
      // A page that died under the handler is gone, whatever the CDP error said.
      if (page.guest.isDestroyed() && !(error instanceof HostRpcError)) throw pageGone(pageId);
      throw error;
    });
    // The queued events go out before the reply, on success and on failure alike.
    const settled = result.finally(() => {
      running?.end();
      ctx.events.flush(pageId);
    });
    return {
      redact,
      result: settled,
      finish: (value) => {
        if (value === undefined || value === null) return { facts: facts() };
        return isPlainObject(value) && value.facts === undefined ? { ...value, facts: facts() } : value;
      },
    };
  });
}

/** A method not addressed to one page (resolving a session's page, listing): same exits, no page, no facts. */
export function registerEngineSessionMethod(
  connection: HostConnection,
  ctx: EngineContext,
  method: string,
  handler: EngineSessionHandler
): void {
  serve(connection, ctx, method, (fields, signal) => ({
    redact: redactBrowserText,
    result: handler(fields, signal),
  }));
}
