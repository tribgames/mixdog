/** Arm event-time target checks in the element's document and every iframe
 * ancestor. Geometry is preflight only; an overlay can appear before input. */
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type { BrowserCdpPort } from './cdp';

export const BROWSER_HIT_GUARD = `function(token, stop) {
  const view = this.ownerDocument.defaultView;
  const guards = view.__mixdogHitGuards ||= new Map();
  if (stop) {
    const guard = guards.get(token);
    if (!guard) return { expired: true };
    guard.cleanup();
    return { blocked: guard.blocked };
  }
  const target = this;
  if (!target.isConnected) throw new Error('target detached before input');
  const events = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend'];
  const guard = {blocked: false, cleanup: () => {}};
  const listeners = [];
  let current = target;
  for (;;) {
    const owner = current.ownerDocument.defaultView;
    const expected = current;
    const listener = event => {
      if (!event.isTrusted) return;
      if (!event.composedPath().includes(expected)) guard.blocked = true;
      if (guard.blocked) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    for (const event of events) owner.addEventListener(event, listener, {capture: true, passive: false});
    listeners.push({owner, listener});
    try { current = owner.frameElement; } catch { current = null; }
    if (!current) break;
  }
  const timer = view.setTimeout(() => guard.cleanup(), 5000);
  guard.cleanup = () => {
    view.clearTimeout(timer);
    for (const {owner, listener} of listeners) {
      for (const event of events) owner.removeEventListener(event, listener, true);
    }
    guards.delete(token);
  };
  guards.set(token, guard);
  return {blocked: false};
}`;

export function createBrowserHitTarget(host: {
  cdp: BrowserCdpPort;
  frames(guest: WebContents): Map<string, { frameId?: string; parentSessionId?: string }>;
  pendingDialog?(guest: WebContents): boolean;
}) {
  async function guard(
    guest: WebContents,
    target: { backendNodeId?: number; objectId?: string; sessionId?: string },
    signal?: AbortSignal,
  ) {
    const objects: Array<{ objectId: string; sessionId?: string; token: string }> = [];
    const originalUrl = guest.getURL();
    async function finish(check: boolean) {
      if (check && host.pendingDialog?.(guest)) {
        // JavaScript cleanup cannot complete until the dialog is answered.
        // Queue cleanup only, never input, and return the blocked page now.
        void finish(false).catch(() => undefined);
        return;
      }
      let failed = false;
      for (const object of objects.reverse()) {
        try {
          const response = await host.cdp.call<{ result?: { value?: { blocked?: boolean; expired?: boolean } }; exceptionDetails?: unknown }>(
            guest, 'Runtime.callFunctionOn', {
              objectId: object.objectId, functionDeclaration: BROWSER_HIT_GUARD,
              arguments: [{ value: object.token }, { value: true }], returnByValue: true,
            }, undefined, object,
          );
          failed ||= !!response.exceptionDetails || !!response.result?.value?.blocked || !!response.result?.value?.expired;
        } catch { failed = true; }
        finally {
          await host.cdp.call(guest, 'Runtime.releaseObject', { objectId: object.objectId }, undefined, object).catch(() => undefined);
        }
      }
      // Navigation destroys the old document's guard. The caller reports the
      // resulting page; do not turn a successful navigation into a retry hint.
      if (check && failed && guest.getURL() === originalUrl && !guest.isLoading()) throw new Error('input target changed or could not be verified; input was not replayed, observe before continuing');
    }
    try {
      let node = target;
      for (let depth = 0; depth < 32; depth++) {
        const resolved = node.objectId ? { object: { objectId: node.objectId } }
          : await host.cdp.call<{ object?: { objectId?: string } }>(
            guest, 'DOM.resolveNode', { backendNodeId: node.backendNodeId }, signal, node,
          );
        if (!resolved.object?.objectId) throw new Error('target detached before input');
        const object = { objectId: resolved.object.objectId, sessionId: node.sessionId, token: randomUUID() };
        objects.push(object);
        const armed = await host.cdp.call<{ exceptionDetails?: unknown }>(
          guest, 'Runtime.callFunctionOn', {
            objectId: object.objectId, functionDeclaration: BROWSER_HIT_GUARD,
            arguments: [{ value: object.token }, { value: false }], returnByValue: true,
          }, signal, object,
        );
        if (armed.exceptionDetails) throw new Error('could not arm input target check');
        const frame = node.sessionId ? host.frames(guest).get(node.sessionId) : undefined;
        if (!frame?.frameId) break;
        const owner = await host.cdp.call<{ backendNodeId?: number }>(
          guest, 'DOM.getFrameOwner', { frameId: frame.frameId }, signal, { sessionId: frame.parentSessionId },
        );
        if (!owner.backendNodeId) throw new Error('could not verify parent frame target');
        node = { backendNodeId: owner.backendNodeId, sessionId: frame.parentSessionId };
      }
      return () => finish(true);
    } catch (error) {
      await finish(false);
      throw error;
    }
  }
  return { guard };
}
