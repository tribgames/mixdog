/**
 * Where a gesture actually lands. A ref becomes a screen point only after the
 * page confirms the element is on top of it, and an image coordinate is
 * accepted only while the screenshot it came from still describes the page.
 * Both refuse rather than guess, because a wrong point clicks the wrong thing.
 */
import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import type { BrowserCommand } from './command';
import type { GuestSlot } from './guest-state';
import type { BrowserRefSet } from './ref-recovery';
import type { AccessibilityRefSnapshot } from './snapshot-capture';
import {
  formatSnapshot,
  type SnapshotDiagnosticsView,
} from './snapshot-format';
import { browserRefPointExpression } from './snapshot-scripts';

/** The screenshot a coordinate action is allowed to be expressed in. */
export interface VisualGrounding {
  snapshotId: string;
  url: string;
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface BrowserRefPointHost {
  callAccessibilityRef<T>(
    guest: WebContents,
    ref: string,
    functionDeclaration: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<{ handled: false } | { handled: true; value: T }>;
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T>;
  cdp: BrowserCdpPort;
  /** Offset of the frame a ref lives in, relative to the top document. */
  frameOffsetForSession(
    guest: WebContents,
    sessionId: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number }>;
  captureSnapshotPayload(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<Parameters<typeof formatSnapshot>[0]>;
  diagnostics(guest: WebContents): SnapshotDiagnosticsView;
  /** The ref table a covered-element report re-reads before it gives up. */
  accessibilityRefs: GuestSlot<AccessibilityRefSnapshot>;
  visualGrounding: GuestSlot<VisualGrounding>;
}

export function createBrowserRefPoints(host: BrowserRefPointHost) {
  const {
    callAccessibilityRef,
    evaluate,
    cdp,
    frameOffsetForSession,
    captureSnapshotPayload,
    diagnostics: diagnosticsFor,
    accessibilityRefs: accessibilityRefsByGuest,
    visualGrounding: visualGroundingByGuest,
  } = host;
  async function resolveRefPoint(
    guest: WebContents,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const accessibility = await callAccessibilityRef<{
      error?: string;
      covering?: string;
      rx?: number;
      ry?: number;
    }>(guest, ref, `async function() {
      if (!this || !this.isConnected) return { error: 'stale' };
      if (this.disabled || this.getAttribute?.('aria-disabled') === 'true') return { error: 'disabled' };
      const view = this.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(this);
      if (style.display === 'none' || style.visibility === 'hidden'
        || style.pointerEvents === 'none' || Number(style.opacity || '1') === 0) {
        return { error: 'not-actionable' };
      }
      const nextVisualTick = () => new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(finish, 100);
        requestAnimationFrame(finish);
      });
      this.scrollIntoView({ block: 'center', inline: 'center' });
      await nextVisualTick();
      await nextVisualTick();
      const first = this.getBoundingClientRect();
      await nextVisualTick();
      const rect = this.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return { error: 'not-visible' };
      if (Math.abs(first.left - rect.left) > 2 || Math.abs(first.top - rect.top) > 2
        || Math.abs(first.width - rect.width) > 2 || Math.abs(first.height - rect.height) > 2) {
        return { error: 'moving' };
      }
      const points = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
      const controlSelector = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"]';
      const controlFor = (value) => value?.matches?.(controlSelector)
        ? value
        : value?.closest?.(controlSelector);
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
      for (const [rx, ry] of points) {
        let hit = this.ownerDocument.elementFromPoint(rect.left + rect.width * rx, rect.top + rect.height * ry);
        while (hit?.shadowRoot) {
          const nested = hit.shadowRoot.elementFromPoint?.(rect.left + rect.width * rx, rect.top + rect.height * ry);
          if (!nested || nested === hit) break;
          hit = nested;
        }
        const targetControl = controlFor(this);
        const hitControl = controlFor(hit);
        const related = hit && (
          hit === this
          || (this.contains(hit) && (!hitControl || hitControl === targetControl))
          || (targetControl && hitControl === targetControl)
          || sameDestination(targetControl, hitControl)
        );
        if (related) return { rx, ry };
        covering = hit || covering;
      }
      const label = covering
        ? ((covering.tagName || 'element').toLowerCase() + ' "'
          + String(covering.getAttribute?.('aria-label') || covering.textContent || '')
            .replace(/\\s+/g, ' ').trim().slice(0, 60) + '"')
        : 'another element';
      return { error: 'covered', covering: label };
    }`, [], signal);
    let point: { error?: string; covering?: string; x?: number; y?: number };
    if (accessibility.handled) {
      const target = accessibilityRefsByGuest.get(guest)?.refs.get(ref);
      if (!target) throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
      if (accessibility.value?.error) {
        point = accessibility.value;
      } else {
        const box = await cdp.call<{
          model?: { content?: number[]; border?: number[] };
        }>(
          guest,
          'DOM.getBoxModel',
          { backendNodeId: target.backendNodeId },
          signal,
          { sessionId: target.sessionId },
        );
        const quad = box.model?.content || box.model?.border || [];
        if (quad.length < 8) {
          point = { error: 'not-visible' };
        } else {
          const rx = accessibility.value?.rx ?? 0.5;
          const ry = accessibility.value?.ry ?? 0.5;
          const topX = quad[0] + (quad[2] - quad[0]) * rx;
          const topY = quad[1] + (quad[3] - quad[1]) * rx;
          const bottomX = quad[6] + (quad[4] - quad[6]) * rx;
          const bottomY = quad[7] + (quad[5] - quad[7]) * rx;
          const frameOffset = await frameOffsetForSession(
            guest,
            target.sessionId,
            signal,
          );
          point = {
            x: frameOffset.x + topX + (bottomX - topX) * ry,
            y: frameOffset.y + topY + (bottomY - topY) * ry,
          };
        }
      }
    } else {
      point = await evaluate<{
        error?: string;
        covering?: string;
        x?: number;
        y?: number;
      }>(guest, browserRefPointExpression(ref), signal);
    }
    if (!point || point.error || typeof point.x !== 'number' || typeof point.y !== 'number') {
      if (point?.error === 'covered') {
        let fresh;
        try {
          fresh = await captureSnapshotPayload(
            guest,
            { action: 'snapshot', maxElements: 500 },
            signal,
          );
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error;
          fresh = null;
        }
        throw new Error(
          `ref ${ref} is covered by ${point.covering || 'another element'}; input was not dispatched. `
          + 'Dismiss the blocker using a ref from the fresh snapshot below.\n\n'
          + (fresh ? formatSnapshot(fresh, diagnosticsFor(guest)) : 'A fresh snapshot could not be captured.'),
        );
      }
      if (point?.error === 'not-visible') {
        throw new Error(`ref ${ref} is not visible; take a fresh snapshot first`);
      }
      if (point?.error === 'disabled') {
        throw new Error(`ref ${ref} is disabled`);
      }
      if (point?.error === 'moving') {
        throw new Error(`ref ${ref} is still moving; wait briefly and take a fresh snapshot`);
      }
      if (point?.error === 'not-actionable') {
        throw new Error(`ref ${ref} is not actionable (hidden, transparent, or pointer events disabled)`);
      }
      throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
    }
    return { x: point.x, y: point.y };
  }

  function bindVisualGrounding(
    guest: WebContents,
    refSet: BrowserRefSet,
    capture: { width: number; height: number },
  ): void {
    visualGroundingByGuest.set(guest, {
      snapshotId: refSet.snapshotId,
      url: refSet.url,
      imageWidth: capture.width,
      imageHeight: capture.height,
      viewportWidth: refSet.viewportWidth,
      viewportHeight: refSet.viewportHeight,
    });
  }

  async function visualPoint(
    guest: WebContents,
    command: BrowserCommand,
    xValue: unknown,
    yValue: unknown,
    label: string,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const grounding = visualGroundingByGuest.get(guest);
    if (!grounding || !command.snapshotId || command.snapshotId !== grounding.snapshotId) {
      throw new Error(`${label} requires snapshotId from the latest snapshot(mode=both) or locate result`);
    }
    const x = Number(xValue);
    const y = Number(yValue);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`${label} requires finite screenshot x and y coordinates`);
    }
    if (x < 0 || y < 0 || x >= grounding.imageWidth || y >= grounding.imageHeight) {
      throw new Error(
        `${label} coordinates must be inside the ${grounding.imageWidth}x${grounding.imageHeight} screenshot`,
      );
    }
    const current = await evaluate<{ url: string; width: number; height: number }>(guest, `(() => ({
      url: String(location.href),
      width: Math.round(window.innerWidth),
      height: Math.round(window.innerHeight),
    }))()`, signal);
    if (current.url !== grounding.url
      || current.width !== grounding.viewportWidth
      || current.height !== grounding.viewportHeight) {
      visualGroundingByGuest.delete(guest);
      throw new Error(`${label} visual grounding is stale because the page or viewport changed; call snapshot with mode=both again`);
    }
    return {
      x: x * grounding.viewportWidth / grounding.imageWidth,
      y: y * grounding.viewportHeight / grounding.imageHeight,
    };
  }

  return { resolveRefPoint, bindVisualGrounding, visualPoint };
}
