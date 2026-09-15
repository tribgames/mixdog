/** One realm-preserving path to an observed element, including child frames. */
import type { WebContents } from 'electron';
import { BrowserActionabilityError, waitForBrowserActionable } from './actionability';
import { BROWSER_EDITABILITY_CHECK } from './editability';

export interface BrowserRefAccessHost {
  callAccessibilityRef<T>(
    guest: WebContents,
    ref: string,
    functionDeclaration: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<{ handled: false } | { handled: true; value: T }>;
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T>;
}

/** Page-context prelude that binds `element` to one observed ref through the
 *  page-side ref table, and refuses a ref whose element left the document. */
export function browserRefElementSource(ref: string): string {
  return `const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
      const element = record?.element || record;
      if (!element?.isConnected) throw new Error('stale ref');`;
}

/** A ref operation reports its page-side refusal as `error`; only staleness
 *  names the ref, because only staleness is answered by a fresh snapshot. */
export function checkedBrowserRefResult<T extends { error?: string }>(result: T, ref: string): T {
  if (result?.error) {
    throw new Error(result.error === 'stale'
      ? `ref ${ref} is stale or unknown; take a fresh snapshot first`
      : result.error);
  }
  return result;
}

export function createBrowserRefAccess(host: BrowserRefAccessHost) {
  async function callRef<T>(
    guest: WebContents,
    ref: string,
    declaration: string,
    args: unknown[] = [],
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await host.callAccessibilityRef<T>(guest, ref, declaration, args, signal);
    if (result.handled) return result.value;
    return host.evaluate<T>(guest, `(() => {
      ${browserRefElementSource(ref)}
      return (${declaration}).apply(element, ${JSON.stringify(args)});
    })()`, signal);
  }

  /** Only this read-only preflight may be repeated to recover a stale ref. */
  async function prepareRef(
    guest: WebContents,
    ref: string,
    signal?: AbortSignal,
    editable = false,
  ): Promise<string> {
    const connected = await callRef<boolean>(
      guest, ref, 'function() { return Boolean(this && this.isConnected); }', [], signal,
    );
    if (!connected) throw new Error(`ref ${ref} is stale or detached; take a fresh snapshot`);
    if (editable) {
      await waitForBrowserActionable(async () => {
        const error = await callRef<string>(
          guest, ref, `function() { return (${BROWSER_EDITABILITY_CHECK})(this); }`, [], signal,
        );
        if (error === 'stale') throw new Error(`ref ${ref} is stale or detached; take a fresh snapshot`);
        if (error) throw new BrowserActionabilityError(error, 'not-editable');
      }, signal);
    }
    return ref;
  }

  return { callRef, prepareRef };
}
