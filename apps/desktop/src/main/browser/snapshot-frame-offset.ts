/**
 * Where a cross-origin frame sits on the top document: the frame owner's box
 * in each parent session, summed up the session chain. Before input lands,
 * every owner along the chain must also be the element actually hit at the
 * point — a covered or transformed frame would swallow the gesture silently.
 */
import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import type { BrowserTargetSession } from './snapshot-accessibility-read';

export interface FrameOffsetHost {
  cdp: BrowserCdpPort;
  sessions(guest: WebContents): Map<string, BrowserTargetSession>;
}

interface FrameOwnerOrigin {
  backendNodeId: number;
  x: number;
  y: number;
}

interface Point {
  x: number;
  y: number;
}

const FRAME_OWNER_HIT_TEST = `function(x, y) {
                for (let node = this; node; node = node.parentElement) {
                  if (this.ownerDocument.defaultView.getComputedStyle(node).transform !== 'none') return false;
                }
                let hit = this.ownerDocument.elementFromPoint(x, y);
                while (hit?.shadowRoot) {
                  const next = hit.shadowRoot.elementFromPoint(x, y);
                  if (!next || next === hit) break;
                  hit = next;
                }
                return hit === this;
              }`;

/** The frame owner element and its content-box origin in the parent session,
 *  or null when the parent cannot place the frame. */
async function frameOwnerOrigin(
  cdp: BrowserCdpPort,
  guest: WebContents,
  frameId: string,
  parent: { sessionId?: string },
  signal?: AbortSignal
): Promise<FrameOwnerOrigin | null> {
  const owner = await cdp.call<{ backendNodeId?: number }>(guest, 'DOM.getFrameOwner', { frameId }, signal, parent);
  if (!Number.isFinite(owner.backendNodeId)) return null;
  const backendNodeId = owner.backendNodeId as number;
  const box = await cdp.call<{
    model?: { content?: number[]; border?: number[] };
  }>(guest, 'DOM.getBoxModel', { backendNodeId }, signal, parent);
  const quad = box.model?.content || box.model?.border || [];
  if (quad.length < 8) return null;
  return { backendNodeId, x: quad[0], y: quad[1] };
}

/** Throws unless the frame owner is the untransformed element hit at `point`. */
async function assertFrameOwnerHit(
  cdp: BrowserCdpPort,
  guest: WebContents,
  backendNodeId: number,
  point: Point,
  parent: { sessionId?: string },
  signal?: AbortSignal
): Promise<void> {
  const resolved = await cdp.call<{ object?: { objectId?: string } }>(
    guest,
    'DOM.resolveNode',
    { backendNodeId },
    signal,
    parent
  );
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error('parent frame could not be verified before input');
  try {
    const checked = await cdp.call<{ result?: { value?: boolean }; exceptionDetails?: unknown }>(
      guest,
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: FRAME_OWNER_HIT_TEST,
        arguments: [{ value: point.x }, { value: point.y }],
        returnByValue: true,
      },
      signal,
      parent
    );
    if (checked.exceptionDetails || checked.result?.value !== true) {
      throw new Error('parent frame is covered or transformed; input was not dispatched');
    }
  } finally {
    void cdp.call(guest, 'Runtime.releaseObject', { objectId }, undefined, parent).catch(() => undefined);
  }
}

export function createFrameOffsetResolver(host: FrameOffsetHost) {
  const { cdp } = host;

  return async function frameOffsetForSession(
    guest: WebContents,
    initialSessionId: string | undefined,
    signal?: AbortSignal,
    localPoint?: Point
  ): Promise<Point> {
    let sessionId = initialSessionId;
    let x = 0;
    let y = 0;
    const seen = new Set<string>();
    const sessions = host.sessions(guest);
    while (sessionId && !seen.has(sessionId)) {
      seen.add(sessionId);
      const target = sessions.get(sessionId);
      if (!target?.frameId) break;
      const parent = { sessionId: target.parentSessionId };
      const owner = await frameOwnerOrigin(cdp, guest, target.frameId, parent, signal);
      if (!owner) break;
      x += owner.x;
      y += owner.y;
      if (localPoint) {
        await assertFrameOwnerHit(
          cdp,
          guest,
          owner.backendNodeId,
          { x: x + localPoint.x, y: y + localPoint.y },
          parent,
          signal
        );
      }
      sessionId = target.parentSessionId;
    }
    return { x, y };
  };
}
