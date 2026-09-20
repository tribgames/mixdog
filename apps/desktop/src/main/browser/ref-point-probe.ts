/**
 * Where a ref is on screen, as a point a gesture can be sent to. The page
 * confirms the element — or the label a person would click instead — is
 * actually on top at that point; a covered, hidden, disabled or moving
 * element is refused with the reason, because a wrong point clicks the
 * wrong thing.
 */
import type { WebContents } from 'electron';

import { BrowserActionabilityError } from './actionability';
import type { BrowserRefPointHost } from './ref-points';
import type { AccessibilityRef } from './snapshot-capture';
import { browserRefPointExpression } from './snapshot-scripts';
import { BROWSER_STABLE_RECT } from './stable-rect';

export type RefPointProbeHost = Pick<
  BrowserRefPointHost,
  'callAccessibilityRef' | 'evaluate' | 'cdp' | 'frameOffsetForSession' | 'accessibilityRefs'
>;

interface Point {
  x: number;
  y: number;
}

/** What the page reports for a ref: a landing point in its own realm, a
 *  relative point inside the element's box, or why it cannot be hit. */
interface RefPointReport {
  error?: string;
  covering?: string;
  rx?: number;
  ry?: number;
  x?: number;
  y?: number;
  via?: string;
}

const REF_POINT_PROBE = `async function() {
      const target = this;
      if (!target || !target.isConnected) return { error: 'stale' };
      if (target.disabled || target.getAttribute?.('aria-disabled') === 'true') return { error: 'disabled' };
      const view = target.ownerDocument?.defaultView || window;
      const hidden = (node) => {
        const style = view.getComputedStyle(node);
        return style.display === 'none' || style.visibility === 'hidden';
      };
      if (hidden(target)) return { error: 'not-actionable' };
      const targetRect = await (${BROWSER_STABLE_RECT})(target);
      if (!targetRect) return { error: 'moving' };
      // A transparent, pointer-events:none, or 1px control is how custom
      // checkboxes hide the native input; the label is what a person clicks,
      // and clicking it activates the control. Opacity alone never disqualifies.
      const labels = target.labels ? Array.from(target.labels) : [];
      const candidates = [target, ...labels.filter((label) => (
        label !== target && label.isConnected && !hidden(label)
      ))];
      const points = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
      const controlSelector = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"]';
      const controlFor = (value) => value?.matches?.(controlSelector)
        ? value
        : value?.closest?.(controlSelector);
      const labelControl = (value) => value?.closest?.('label')?.control || null;
      const sameDestination = (left, right) => {
        if (!left || !right || left === right
          || left.matches?.('a[href]') !== true || right.matches?.('a[href]') !== true) return false;
        try {
          return new URL(left.href, location.href).href === new URL(right.href, location.href).href;
        } catch {
          return false;
        }
      };
      let covering = null;
      let visible = false;
      for (const candidate of candidates) {
        const rect = candidate === target ? targetRect : candidate.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        visible = true;
        for (const [rx, ry] of points) {
          const localX = rect.left + rect.width * rx;
          const localY = rect.top + rect.height * ry;
          let hit = candidate.ownerDocument.elementFromPoint(localX, localY);
          while (hit?.shadowRoot) {
            const nested = hit.shadowRoot.elementFromPoint?.(localX, localY);
            if (!nested || nested === hit) break;
            hit = nested;
          }
          const targetControl = controlFor(target);
          const hitControl = controlFor(hit);
          const related = hit && (
            hit === target
            || hit === candidate
            || (candidate.contains(hit) && (!hitControl || hitControl === targetControl))
            || (targetControl && hitControl === targetControl)
            || sameDestination(targetControl, hitControl)
            || labelControl(hit) === target
          );
          if (!related) {
            covering = hit || covering;
            continue;
          }
          let frameView = view;
          let px = localX;
          let py = localY;
          for (;;) {
            let frame;
            try { frame = frameView.frameElement; } catch { break; }
            if (!frame) break;
            const parent = frame.ownerDocument;
            const frameRect = frame.getBoundingClientRect();
            px += frameRect.left + frame.clientLeft;
            py += frameRect.top + frame.clientTop;
            if (parent.elementFromPoint(px, py) !== frame) return { error: 'covered', covering: 'parent frame overlay' };
            frameView = parent.defaultView;
          }
          return candidate === target ? { rx, ry } : { x: px, y: py, via: 'label' };
        }
      }
      if (!visible) return { error: 'not-visible' };
      const label = covering
        ? ((covering.tagName || 'element').toLowerCase() + ' "'
          + String(covering.getAttribute?.('aria-label') || covering.textContent || '')
            .replace(/\\s+/g, ' ').trim().slice(0, 60) + '"')
        : 'another element';
      return { error: 'covered', covering: label };
    }`;

/** The point at (rx, ry) inside the node's box, in top-document coordinates
 *  once the cross-origin frame offset is added. */
async function pointInBoxModel(
  host: RefPointProbeHost,
  guest: WebContents,
  target: AccessibilityRef,
  rx: number,
  ry: number,
  signal?: AbortSignal
): Promise<RefPointReport> {
  const box = await host.cdp.call<{
    model?: { content?: number[]; border?: number[] };
  }>(guest, 'DOM.getBoxModel', { backendNodeId: target.backendNodeId }, signal, { sessionId: target.sessionId });
  const quad = box.model?.content || box.model?.border || [];
  if (quad.length < 8) return { error: 'not-visible' };
  const topX = quad[0] + (quad[2] - quad[0]) * rx;
  const topY = quad[1] + (quad[3] - quad[1]) * rx;
  const bottomX = quad[6] + (quad[4] - quad[6]) * rx;
  const bottomY = quad[7] + (quad[5] - quad[7]) * rx;
  const local = { x: topX + (bottomX - topX) * ry, y: topY + (bottomY - topY) * ry };
  const frameOffset = await host.frameOffsetForSession(guest, target.sessionId, signal, local);
  return { x: frameOffset.x + local.x, y: frameOffset.y + local.y };
}

async function pointFromAccessibility(
  host: RefPointProbeHost,
  guest: WebContents,
  ref: string,
  report: RefPointReport,
  signal?: AbortSignal
): Promise<RefPointReport> {
  const target = host.accessibilityRefs.get(guest)?.refs.get(ref);
  if (!target) throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
  if (report?.error) return report;
  if (typeof report?.x === 'number' && typeof report?.y === 'number') {
    // The landing spot is the control's label, so the page already
    // measured it; only the cross-origin frame offset is left to add.
    const local = { x: report.x, y: report.y };
    const frameOffset = await host.frameOffsetForSession(guest, target.sessionId, signal, local);
    return { x: frameOffset.x + local.x, y: frameOffset.y + local.y };
  }
  return pointInBoxModel(host, guest, target, report?.rx ?? 0.5, report?.ry ?? 0.5, signal);
}

function refPointFailure(ref: string, point: RefPointReport | undefined): Error {
  if (point?.error === 'covered') {
    return new BrowserActionabilityError(
      `ref ${ref} is covered by ${point.covering || 'another element'}; input was not dispatched.`,
      'covered'
    );
  }
  if (point?.error === 'not-visible') {
    return new BrowserActionabilityError(`ref ${ref} is not visible; take a fresh snapshot first`, 'hidden');
  }
  if (point?.error === 'disabled') {
    return new BrowserActionabilityError(`ref ${ref} is disabled`, 'disabled');
  }
  if (point?.error === 'moving') {
    return new BrowserActionabilityError(
      `ref ${ref} is still moving; wait briefly and take a fresh snapshot`,
      'moving'
    );
  }
  if (point?.error === 'not-actionable') {
    return new BrowserActionabilityError(
      `ref ${ref} is not actionable (hidden, transparent, or pointer events disabled)`,
      'hidden'
    );
  }
  return new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
}

export async function probeRefPoint(
  host: RefPointProbeHost,
  guest: WebContents,
  ref: string,
  signal?: AbortSignal
): Promise<Point> {
  const accessibility = await host.callAccessibilityRef<RefPointReport>(guest, ref, REF_POINT_PROBE, [], signal);
  const point = accessibility.handled
    ? await pointFromAccessibility(host, guest, ref, accessibility.value, signal)
    : await host.evaluate<RefPointReport>(guest, browserRefPointExpression(ref), signal);
  if (!point || point.error || typeof point.x !== 'number' || typeof point.y !== 'number') {
    throw refPointFailure(ref, point);
  }
  return { x: point.x, y: point.y };
}
