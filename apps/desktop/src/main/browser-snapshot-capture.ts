/**
 * Turning a live page into one addressable observation: the accessibility
 * tree merged across cross-origin frames, the refs the agent will name, and
 * the payload a report is written from. Refs live here because this is what
 * mints them; everything downstream only reads them.
 */
import type { WebContents } from 'electron';

import {
  buildAccessibilitySnapshot,
  type AccessibilityNode,
  type AccessibilityPageInfo,
  type AccessibilityTargetSnapshot,
  type BrowserSnapshotPayload as SnapshotPayload,
} from './browser-accessibility';
import type { BrowserCommand } from './browser-host';
import { browserSnapshotExpression, redactBrowserText } from './browser-host-policy';
import { createBrowserRefSet, type BrowserRefSet } from './browser-ref-recovery';

const MAX_ACCESSIBILITY_TARGETS = 32;

/** One ref, bound to the CDP node and target session that produced it. */
export interface AccessibilityRef {
  backendNodeId: number;
  sessionId?: string;
}

export interface AccessibilityRefSnapshot {
  snapshotId: string;
  refs: Map<string, AccessibilityRef>;
}

export interface BrowserSnapshotCaptureHost {
  evaluate<T>(
    guest: WebContents,
    expression: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<T>;
  guestDebugger(guest: WebContents): Promise<Electron.Debugger>;
  sendCdp<T>(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<T>;
  /** The CDP target sessions this page has attached, for frame geometry, and
   *  the fault line a degraded snapshot reports through. */
  diagnostics(guest: WebContents): {
    cdpSessions: Map<string, {
      frameId?: string;
      parentSessionId?: string;
      ready?: Promise<unknown>;
    }>;
    fault: string;
  };
  /** Cleared whenever a fresh snapshot invalidates image-bound coordinates. */
  visualGrounding: WeakMap<WebContents, unknown>;
  snapshotTextLimit(command: BrowserCommand): number;
  nextSnapshotId(guest: WebContents): string;
  accessibilityRefs: WeakMap<WebContents, AccessibilityRefSnapshot>;
  refSets: WeakMap<WebContents, BrowserRefSet>;
  cdpTimeoutMs: number;
  maxElements: number;
}

export function createBrowserSnapshotCapture(host: BrowserSnapshotCaptureHost) {
  const {
    evaluate,
    guestDebugger,
    sendCdp,
    diagnostics: diagnosticsFor,
    snapshotTextLimit,
    nextSnapshotId,
    accessibilityRefs: accessibilityRefsByGuest,
    refSets: latestRefSetsByGuest,
    visualGrounding: visualGroundingByGuest,
    cdpTimeoutMs: CDP_REQUEST_TIMEOUT_MS,
    maxElements: SNAPSHOT_MAX_ELEMENTS,
  } = host;
  async function captureAccessibilitySnapshot(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<SnapshotPayload> {
    const cdp = await guestDebugger(guest);
    const diagnostics = diagnosticsFor(guest);
    const snapshotTextChars = snapshotTextLimit(command);
    const pageInfoPromise = evaluate<AccessibilityPageInfo>(guest, `(() => ({
      url: String(location.href),
      title: String(document.title || ''),
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.round(document.documentElement.scrollHeight),
      viewportHeight: Math.round(window.innerHeight),
      viewportWidth: Math.round(window.innerWidth),
      text: (document.body ? (document.body.innerText || document.body.textContent || '') : '')
        .slice(0, ${snapshotTextChars * 4})
        .replace(/\\s+/g, ' ').trim().slice(0, ${snapshotTextChars}),
    }))()`, signal);
    const childTargets = [...diagnostics.cdpSessions.entries()];
    const omittedTargets = Math.max(0, childTargets.length - (MAX_ACCESSIBILITY_TARGETS - 1));
    const targets = [
      { sessionId: undefined as string | undefined, ready: Promise.resolve() },
      ...childTargets.slice(0, MAX_ACCESSIBILITY_TARGETS - 1).map(([sessionId, target]) => ({
        sessionId,
        ready: target.ready,
      })),
    ];
    const snapshotsPromise = (async (): Promise<AccessibilityTargetSnapshot[]> => {
      await Promise.allSettled(targets.map((target) => target.ready));
      return await Promise.all(targets.map(async ({ sessionId }) => {
      try {
        let layoutError = '';
        const [axTree, domSnapshot] = await Promise.all([
          sendCdp<{ nodes?: AccessibilityNode[] }>(
            guest,
            cdp,
            'Accessibility.getFullAXTree',
            {},
            CDP_REQUEST_TIMEOUT_MS,
            signal,
            sessionId,
          ),
          sendCdp<{
              documents?: Array<{
                nodes?: { backendNodeId?: number[] };
                layout?: { nodeIndex?: number[]; bounds?: number[][] };
              }>;
          }>(
            guest,
            cdp,
            'DOMSnapshot.captureSnapshot',
            { computedStyles: [], includeDOMRects: true, includePaintOrder: true },
            CDP_REQUEST_TIMEOUT_MS,
            signal,
            sessionId,
          ).catch((error) => {
            layoutError = redactBrowserText((error as Error).message || String(error));
            return { documents: [] };
          }),
        ]);
        const bounds = new Map<number, number[]>();
        for (const document of domSnapshot.documents || []) {
          const backendNodeIds = document.nodes?.backendNodeId || [];
          const nodeIndexes = document.layout?.nodeIndex || [];
          const boxes = document.layout?.bounds || [];
          nodeIndexes.forEach((nodeIndex, index) => {
            const backendNodeId = backendNodeIds[nodeIndex];
            const box = boxes[index];
            if (Number.isFinite(backendNodeId) && Array.isArray(box) && box.length >= 4) {
              bounds.set(backendNodeId, box);
            }
          });
        }
        return {
          sessionId,
          nodes: axTree.nodes || [],
          bounds,
          ...(layoutError ? { layoutError } : {}),
        };
      } catch (error) {
        return {
          sessionId,
          nodes: [],
          bounds: new Map<number, number[]>(),
          error: redactBrowserText((error as Error).message || String(error)),
        };
      }
      }));
    })();
    const [pageInfo, snapshots] = await Promise.all([pageInfoPromise, snapshotsPromise]);
    if (!snapshots.some((snapshot) => snapshot.nodes.length > 0)) {
      throw new Error('CDP accessibility tree is unavailable');
    }

    const snapshotId = nextSnapshotId(guest);
    const maxElements = Math.min(
      500,
      Math.max(1, Number.isFinite(command.maxElements) ? Math.trunc(command.maxElements as number) : SNAPSHOT_MAX_ELEMENTS),
    );
    const built = buildAccessibilitySnapshot({
      pageInfo,
      targets: snapshots,
      snapshotId,
      query: command.query,
      viewportOnly: command.viewportOnly,
      maxElements,
      textChars: snapshotTextChars,
    });
    if (omittedTargets) {
      built.payload.warnings = [
        ...(built.payload.warnings || []),
        `${omittedTargets} additional cross-origin frame target(s) were omitted from this snapshot.`,
      ];
    }
    const refs = new Map<string, AccessibilityRef>();
    for (const ref of built.refs) {
      refs.set(ref.ref, {
        backendNodeId: ref.backendNodeId,
        sessionId: ref.sessionId,
      });
    }
    accessibilityRefsByGuest.set(guest, { snapshotId, refs });
    return built.payload;
  }

  async function callAccessibilityRef<T>(
    guest: WebContents,
    ref: string,
    functionDeclaration: string,
    args: unknown[],
    signal?: AbortSignal,
    timeoutMs = CDP_REQUEST_TIMEOUT_MS,
  ): Promise<{ handled: false } | { handled: true; value: T }> {
    const snapshot = accessibilityRefsByGuest.get(guest);
    if (!snapshot) return { handled: false };
    const target = snapshot.refs.get(ref);
    if (!target) throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
    const cdp = await guestDebugger(guest);
    const resolved = await sendCdp<{
      object?: { objectId?: string };
    }>(
      guest,
      cdp,
      'DOM.resolveNode',
      { backendNodeId: target.backendNodeId },
      timeoutMs,
      signal,
      target.sessionId,
    );
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error(`ref ${ref} is stale or detached; take a fresh snapshot first`);
    try {
      const response = await sendCdp<{
        result?: { value?: T };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>(
        guest,
        cdp,
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
        timeoutMs,
        signal,
        target.sessionId,
      );
      if (response.exceptionDetails) {
        throw new Error(redactBrowserText(
          response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'element action failed',
        ));
      }
      return { handled: true, value: response.result?.value as T };
    } finally {
      void cdp.sendCommand('Runtime.releaseObject', { objectId }, target.sessionId).catch(() => undefined);
    }
  }

  async function evaluateRefScript(
    guest: WebContents,
    ref: string,
    script: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const accessibility = await callAccessibilityRef<unknown>(
      guest,
      ref,
      `async function(script) {
        const element = this;
        return await eval(script);
      }`,
      [script],
      signal,
      timeoutMs,
    );
    if (accessibility.handled) return accessibility.value;
    return await evaluate<unknown>(guest, `(async () => {
      const record = window.__mixdogAgentSnapshot?.refs?.get(${JSON.stringify(ref)});
      const target = record?.element || record;
      if (!target || !target.isConnected) throw new Error('stale ref');
      return await (async function(script) {
        const element = this;
        return await eval(script);
      }).call(target, ${JSON.stringify(script)});
    })()`, signal, timeoutMs);
  }

  async function frameOffsetForSession(
    guest: WebContents,
    cdp: Electron.Debugger,
    initialSessionId: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    let sessionId = initialSessionId;
    let x = 0;
    let y = 0;
    const seen = new Set<string>();
    const sessions = diagnosticsFor(guest).cdpSessions;
    while (sessionId && !seen.has(sessionId)) {
      seen.add(sessionId);
      const target = sessions.get(sessionId);
      if (!target?.frameId) break;
      const owner = await sendCdp<{ backendNodeId?: number }>(
        guest,
        cdp,
        'DOM.getFrameOwner',
        { frameId: target.frameId },
        CDP_REQUEST_TIMEOUT_MS,
        signal,
        target.parentSessionId,
      );
      if (!Number.isFinite(owner.backendNodeId)) break;
      const box = await sendCdp<{
        model?: { content?: number[]; border?: number[] };
      }>(
        guest,
        cdp,
        'DOM.getBoxModel',
        { backendNodeId: owner.backendNodeId },
        CDP_REQUEST_TIMEOUT_MS,
        signal,
        target.parentSessionId,
      );
      const quad = box.model?.content || box.model?.border || [];
      if (quad.length < 8) break;
      x += quad[0];
      y += quad[1];
      sessionId = target.parentSessionId;
    }
    return { x, y };
  }

  async function captureSnapshotPayload(
    guest: WebContents,
    command: BrowserCommand = { action: 'snapshot' },
    signal?: AbortSignal,
  ): Promise<SnapshotPayload> {
    const diagnostics = diagnosticsFor(guest);
    const snapshotTextChars = snapshotTextLimit(command);
    if (diagnostics.fault) {
      throw new Error(`${diagnostics.fault}; navigate to reload this page or choose another tab`);
    }
    let payload: SnapshotPayload;
    try {
      payload = await captureAccessibilitySnapshot(guest, command, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      accessibilityRefsByGuest.delete(guest);
      payload = await evaluate<SnapshotPayload>(
        guest,
        browserSnapshotExpression({
          snapshotId: nextSnapshotId(guest),
          maxElements: command.maxElements || SNAPSHOT_MAX_ELEMENTS,
          textChars: snapshotTextChars,
          query: command.query,
          viewportOnly: command.viewportOnly,
        }),
        signal,
      );
      payload.warnings = [
        `CDP accessibility unavailable; using DOM fallback: ${redactBrowserText((error as Error).message || String(error))}`,
      ];
    }
    latestRefSetsByGuest.set(guest, createBrowserRefSet(payload));
    visualGroundingByGuest.delete(guest);
    return payload;
  }

  return {
    captureAccessibilitySnapshot,
    callAccessibilityRef,
    evaluateRefScript,
    frameOffsetForSession,
    captureSnapshotPayload,
  };
}
