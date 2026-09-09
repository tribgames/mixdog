/** Route trusted mouse input to its actual renderer, including offscreen OOPIFs.
 * DOM hit-testing still starts at the root, so a covering parent wins. */
import type { WebContents } from 'electron';
import type { BrowserCdpPort } from './cdp';
import type { BrowserInputOutcome } from './input';

interface InputDispatchHost {
  cdp: BrowserCdpPort;
  documentId(guest: WebContents): string;
  frames(guest: WebContents): Map<string, { frameId?: string }>;
  frameOffset(
    guest: WebContents, sessionId: string, signal?: AbortSignal,
  ): Promise<{ x: number; y: number }>;
}

export function createBrowserInputDispatch(host: InputDispatchHost) {
  type Route = { sessionId?: string; offset: { x: number; y: number }; documentId: string };
  const gestures = new WeakMap<WebContents, Route>();
  async function hitRoute(
    guest: WebContents, params: Record<string, unknown>, signal?: AbortSignal,
  ): Promise<Route> {
    const route: Route = { offset: { x: 0, y: 0 }, documentId: host.documentId(guest) };
    const frames = host.frames(guest);
    if (!frames.size || !guest.isOffscreen()) return route;
    let target: { frameId?: string; backendNodeId?: number };
    try {
      target = await host.cdp.call(guest, 'DOM.getNodeForLocation', {
        x: Math.round(Number(params.x)), y: Math.round(Number(params.y)), includeUserAgentShadowDOM: true,
      }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      // Scrollbars and empty compositor space are valid mouse destinations,
      // but have no DOM node. Chromium's root input handler owns those points.
      if (!/(?:^|: )No node found at given location\.?$/.test(String((error as Error)?.message ?? error))) throw error;
      return route;
    }
    route.sessionId = [...frames].find(([, frame]) => frame.frameId === target.frameId)?.[0];
    if (!route.sessionId && target.backendNodeId) {
      const owner = await host.cdp.call<{ node: { frameId?: string } }>(guest, 'DOM.describeNode', {
        backendNodeId: target.backendNodeId,
      }, signal);
      route.sessionId = [...frames].find(([, frame]) => frame.frameId === owner.node.frameId)?.[0];
    }
    if (route.sessionId) route.offset = await host.frameOffset(guest, route.sessionId, signal);
    return route;
  }
  return async (
    guest: WebContents, method: string, params: Record<string, unknown>, signal?: AbortSignal,
    beforeDispatch?: () => void,
  ): Promise<BrowserInputOutcome> => {
    let sessionId: string | undefined;
    let input = params;
    const mouse = method === 'Input.dispatchMouseEvent';
    const release = mouse && params.type === 'mouseReleased';
    let route: Route | undefined;
    if (mouse) {
      route = params.type === 'mouseWheel' ? undefined : gestures.get(guest);
      if (route && route.documentId !== host.documentId(guest)) {
        gestures.delete(guest);
        route = undefined;
        if (params.type !== 'mousePressed' && Number(params.buttons)) {
          throw new Error('Browser page changed; input was not sent.');
        }
        if (release) throw new Error('Browser page changed; input was not sent.');
      }
      route ??= await hitRoute(guest, params, signal);
      sessionId = route.sessionId;
      input = { ...params, x: Number(params.x) - route.offset.x, y: Number(params.y) - route.offset.y };
    }
    const guard = () => {
      signal?.throwIfAborted();
      if (route && (route.documentId !== host.documentId(guest)
        || (route.sessionId && !host.frames(guest).has(route.sessionId)))) {
        throw new Error('Browser page changed; input was not sent.');
      }
      beforeDispatch?.();
    };
    try {
      const result = await host.cdp.sendCdpInput(
        guest, await host.cdp.guestDebugger(guest), method, input, signal, sessionId, guard,
      );
      if (route && params.type === 'mousePressed') gestures.set(guest, route);
      return result;
    } finally {
      if (release && !Number(params.buttons)) gestures.delete(guest);
    }
  };
}
