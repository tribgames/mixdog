/**
 * Invoking page functions against the refs a snapshot minted: each ref is
 * bound to the CDP node and target session that produced it, so the call
 * resolves the node in that session and releases it afterwards. Pages whose
 * accessibility tree was unavailable fall back to the DOM-side ref lookup.
 */
import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import type { GuestSlot } from './guest-state';
import { redactBrowserText } from './redaction';
import { browserRefElementSource } from './ref-access';

/** One ref, bound to the CDP node and target session that produced it. */
export interface AccessibilityRef {
  backendNodeId: number;
  sessionId?: string;
}

export interface AccessibilityRefSnapshot {
  snapshotId: string;
  refs: Map<string, AccessibilityRef>;
}

export interface SnapshotRefCallHost {
  cdp: BrowserCdpPort;
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal, timeoutMs?: number): Promise<T>;
  accessibilityRefs: GuestSlot<AccessibilityRefSnapshot>;
}

const REF_SCRIPT_FUNCTION = `async function(script) {
        const element = this;
        return await eval(script);
      }`;

export function createSnapshotRefCalls(host: SnapshotRefCallHost) {
  const { cdp, evaluate, accessibilityRefs } = host;

  async function callAccessibilityRef<T>(
    guest: WebContents,
    ref: string,
    functionDeclaration: string,
    args: unknown[],
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<{ handled: false } | { handled: true; value: T }> {
    const snapshot = accessibilityRefs.get(guest);
    if (!snapshot) return { handled: false };
    const target = snapshot.refs.get(ref);
    if (!target) throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
    const call = { sessionId: target.sessionId, timeoutMs };
    const resolved = await cdp.call<{
      object?: { objectId?: string };
    }>(guest, 'DOM.resolveNode', { backendNodeId: target.backendNodeId }, signal, call);
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error(`ref ${ref} is stale or detached; take a fresh snapshot first`);
    try {
      const response = await cdp.call<{
        result?: { value?: T };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>(
        guest,
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
        signal,
        call
      );
      if (response.exceptionDetails) {
        throw new Error(
          redactBrowserText(
            response.exceptionDetails.exception?.description ||
              response.exceptionDetails.text ||
              'element action failed'
          )
        );
      }
      return { handled: true, value: response.result?.value as T };
    } finally {
      void cdp
        .guestDebugger(guest)
        .then((debug) => debug.sendCommand('Runtime.releaseObject', { objectId }, target.sessionId))
        .catch(() => undefined);
    }
  }

  async function evaluateRefScript(
    guest: WebContents,
    ref: string,
    script: string,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    const accessibility = await callAccessibilityRef<unknown>(
      guest,
      ref,
      REF_SCRIPT_FUNCTION,
      [script],
      signal,
      timeoutMs
    );
    if (accessibility.handled) return accessibility.value;
    return await evaluate<unknown>(
      guest,
      `(async () => {
      ${browserRefElementSource(ref)}
      return await (${REF_SCRIPT_FUNCTION}).call(element, ${JSON.stringify(script)});
    })()`,
      signal,
      timeoutMs
    );
  }

  return { callAccessibilityRef, evaluateRefScript };
}
