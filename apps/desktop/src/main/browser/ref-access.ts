/** One realm-preserving path to an observed element, including child frames. */
import type { WebContents } from 'electron';

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
      const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
      const element = record?.element || record;
      if (!element?.isConnected) throw new Error('stale ref');
      return (${declaration}).apply(element, ${JSON.stringify(args)});
    })()`, signal);
  }

  /** Only this read-only preflight may be repeated to recover a stale ref. */
  async function prepareRef(guest: WebContents, ref: string, signal?: AbortSignal): Promise<string> {
    const connected = await callRef<boolean>(
      guest, ref, 'function() { return Boolean(this && this.isConnected); }', [], signal,
    );
    if (!connected) throw new Error(`ref ${ref} is stale or detached; take a fresh snapshot`);
    return ref;
  }

  return { callRef, prepareRef };
}
