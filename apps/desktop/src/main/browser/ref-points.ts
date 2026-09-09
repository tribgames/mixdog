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
import { createBrowserHitTarget } from './hit-target';
import { BROWSER_STABLE_RECT } from './stable-rect';
import { timedBrowserOperation } from './timing';

/** The screenshot a coordinate action is allowed to be expressed in. */
export interface VisualGrounding {
  snapshotId: string;
  revision?: string;
  capturedAt?: number;
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
    localPoint?: { x: number; y: number },
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
  revision?(guest: WebContents, signal?: AbortSignal): Promise<string>;
  frames?(guest: WebContents): Map<string, { frameId?: string; parentSessionId?: string }>;
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
  const hitTarget = createBrowserHitTarget({
    cdp,
    frames: (guest) => host.frames?.(guest) || new Map(),
    pendingDialog: (guest) => Boolean(diagnosticsFor(guest).pendingDialog),
  });

  async function guardRef(guest: WebContents, ref: string, signal?: AbortSignal) {
    const target = accessibilityRefsByGuest.get(guest)?.refs.get(ref);
    if (target) return hitTarget.guard(guest, target, signal);
    const resolved = await cdp.call<{ result?: { objectId?: string }; exceptionDetails?: unknown }>(
      guest, 'Runtime.evaluate', {
        expression: `(() => {
          const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
          const element = record?.element || record;
          if (!element?.isConnected) throw new Error('stale ref');
          return element;
        })()`, returnByValue: false,
      }, signal,
    );
    if (!resolved.result?.objectId || resolved.exceptionDetails) throw new Error('input target is stale; take a fresh snapshot');
    return hitTarget.guard(guest, { objectId: resolved.result.objectId }, signal);
  }
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
      x?: number;
      y?: number;
      via?: string;
    }>(guest, ref, `async function() {
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
    }`, [], signal);
    let point: { error?: string; covering?: string; x?: number; y?: number };
    if (accessibility.handled) {
      const target = accessibilityRefsByGuest.get(guest)?.refs.get(ref);
      if (!target) throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
      if (accessibility.value?.error) {
        point = accessibility.value;
      } else if (typeof accessibility.value?.x === 'number' && typeof accessibility.value?.y === 'number') {
        // The landing spot is the control's label, so the page already
        // measured it; only the cross-origin frame offset is left to add.
        const local = { x: accessibility.value.x, y: accessibility.value.y };
        const frameOffset = await frameOffsetForSession(guest, target.sessionId, signal, local);
        point = { x: frameOffset.x + local.x, y: frameOffset.y + local.y };
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
            { x: topX + (bottomX - topX) * ry, y: topY + (bottomY - topY) * ry },
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
      revision: refSet.revision,
      capturedAt: Date.now(),
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
    if (!grounding.capturedAt || Date.now() - grounding.capturedAt > 30_000
      || (host.revision && grounding.revision !== await host.revision(guest, signal))) {
      visualGroundingByGuest.delete(guest);
      throw new Error(`${label} visual grounding is stale; take a fresh snapshot(mode=both)`);
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

  return {
    resolveRefPoint: timedBrowserOperation('actionability', resolveRefPoint),
    bindVisualGrounding,
    visualPoint: timedBrowserOperation('actionability', visualPoint),
    guardRef: timedBrowserOperation('actionability', guardRef),
  };
}
