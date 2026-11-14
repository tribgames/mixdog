/**
 * `host/browser/ref/call`: a function called on the element a snapshot ref
 * names. A ref is bound to the CDP node and target session that minted it, so
 * the call resolves the node in that session, runs the function and releases
 * the object; a ref in a cross-origin frame also answers that frame's offset.
 * A page whose accessibility tree was unavailable has DOM refs instead (the
 * page-side ref table), reached through a page evaluation. A ref of a snapshot that is no longer the page's current one is -32013; the
 * page's own exception is returned as `exception`, not thrown.
 */
import type { WebContents } from 'electron';

import type { BrowserExceptionDetails, Precondition } from '../../../../../../packages/protocol/src/index.ts';
import { redactBrowserText } from '../../browser/redaction';
import { browserRefElementSource } from '../../browser/ref-access';
import { createFrameOffsetResolver } from '../../browser/snapshot-frame-offset';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import type { EngineContext, EnginePage } from './context';
import { ENGINE_ERROR } from './errors';
import { registerEngineMethod } from './registry';

export const HOST_BROWSER_REF_CALL = 'host/browser/ref/call';

export interface RefCallHost {
  /** The page's JavaScript evaluation (`cdp.evaluate`), for the DOM-ref path. */
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal, timeoutMs?: number): Promise<T>;
}

/** The snapshot id the page's refs belong to now: the accessibility refs', else the DOM fallback's. */
export function currentSnapshotId(state: EnginePage['state']): string | undefined {
  return state.accessibilityRefs?.snapshotId ?? state.refSet?.snapshotId;
}

/** -32013 unless `snapshotId` is the page's current snapshot. */
export function requireCurrentSnapshot(state: EnginePage['state'], snapshotId: string): void {
  if (currentSnapshotId(state) !== snapshotId) {
    throw new HostRpcError(
      ENGINE_ERROR.staleSnapshot,
      `snapshot ${snapshotId} is no longer current; take a fresh snapshot first`
    );
  }
}

function staleRef(ref: string): HostRpcError {
  return new HostRpcError(ENGINE_ERROR.staleSnapshot, `ref ${ref} is stale or unknown; take a fresh snapshot first`);
}

function invalid(message: string): HostRpcError {
  return new HostRpcError(HOST_INVALID_PARAMS, message);
}

interface CdpExceptionDetails {
  text?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: { description?: string };
}

function exceptionOf(details: CdpExceptionDetails): BrowserExceptionDetails {
  return {
    text: redactBrowserText(details.exception?.description || details.text || 'element action failed'),
    ...(Number.isInteger(details.lineNumber) ? { line: details.lineNumber } : {}),
    ...(Number.isInteger(details.columnNumber) ? { column: details.columnNumber } : {}),
  };
}

/** The DOM-ref call: the function runs with the element as `this`; a page-side failure comes back as data. */
function domRefExpression(ref: string, functionDeclaration: string, args: unknown[]): string {
  return `(async () => {
    try {
      ${browserRefElementSource(ref)}
      return { ok: true, value: await (${functionDeclaration}).apply(element, ${JSON.stringify(args)}) };
    } catch (error) {
      return { ok: false, text: String((error && error.message) || error) };
    }
  })()`;
}

export function registerRefCall(connection: HostConnection, ctx: EngineContext, host: RefCallHost): void {
  registerEngineMethod(connection, ctx, HOST_BROWSER_REF_CALL, async (params, signal, page) => {
    const { snapshotId, ref, functionDeclaration, args, returnByValue, timeoutMs } = params;
    if (typeof snapshotId !== 'string' || !snapshotId) throw invalid('ref/call needs a snapshotId.');
    if (typeof ref !== 'string' || !ref) throw invalid('ref/call needs a ref.');
    if (typeof functionDeclaration !== 'string' || !functionDeclaration.trim()) {
      throw invalid('ref/call needs a functionDeclaration.');
    }
    if (args !== undefined && args !== null && !Array.isArray(args)) throw invalid('ref/call args must be an array.');
    if (timeoutMs !== undefined && timeoutMs !== null && (typeof timeoutMs !== 'number' || !(timeoutMs > 0))) {
      throw invalid('ref/call timeoutMs must be a positive number.');
    }
    const callArgs = (args as unknown[] | undefined | null) ?? [];
    const timeout = typeof timeoutMs === 'number' ? timeoutMs : undefined;
    const expect = (params.expect ?? undefined) as Precondition | undefined;
    requireCurrentSnapshot(page.state, snapshotId);

    const accessibility = page.state.accessibilityRefs;
    if (accessibility?.snapshotId !== snapshotId) {
      const outcome = await page.guarded(expect, () =>
        host.evaluate<{ ok: true; value: unknown } | { ok: false; text: string }>(
          page.guest,
          domRefExpression(ref, functionDeclaration, callArgs),
          signal,
          timeout
        )
      );
      if (outcome.ok) return outcome.value === undefined ? {} : { value: outcome.value };
      if (outcome.text === 'stale ref') throw staleRef(ref);
      return { exception: { text: redactBrowserText(outcome.text) } };
    }

    const target = accessibility.refs.get(ref);
    if (!target) throw staleRef(ref);
    const call = { sessionId: target.sessionId, timeoutMs: timeout };
    const resolved = await page.guarded(expect, () =>
      ctx.cdp.call<{ object?: { objectId?: string } }>(
        page.guest,
        'DOM.resolveNode',
        { backendNodeId: target.backendNodeId },
        signal,
        call
      )
    );
    const objectId = resolved.object?.objectId;
    if (!objectId) throw staleRef(ref);
    try {
      const response = await page.guarded(expect, () =>
        ctx.cdp.call<{
          result?: { value?: unknown; description?: string; objectId?: string };
          exceptionDetails?: CdpExceptionDetails;
        }>(
          page.guest,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration,
            arguments: callArgs.map((value) => ({ value })),
            returnByValue: returnByValue !== false,
            awaitPromise: true,
            userGesture: true,
          },
          signal,
          call
        )
      );
      if (response.result?.objectId && response.result.objectId !== objectId) {
        ctx.cdp.releaseObject(page.guest, response.result.objectId, target.sessionId);
      }
      if (response.exceptionDetails) return { exception: exceptionOf(response.exceptionDetails) };
      // A result kept by reference has no value to send; its description says what it is.
      const value = returnByValue !== false ? response.result?.value : response.result?.description;
      const answer = value === undefined ? {} : { value };
      // A ref inside a cross-origin frame is measured in that frame: where the frame sits in the top viewport goes with the
      // answer, so the core can place a point or a box there.
      if (!target.sessionId) return answer;
      const frameOffset = await createFrameOffsetResolver({ cdp: ctx.cdp, sessions: () => page.state.cdpSessions })(
        page.guest,
        target.sessionId,
        signal
      );
      return frameOffset.x || frameOffset.y ? { ...answer, frameOffset } : answer;
    } finally {
      ctx.cdp.releaseObject(page.guest, objectId, target.sessionId);
    }
  });
}
