// Recursive renderer for the split-pane workspace (orca-style binary tree:
// flex ratios + pointer-capture resize handles). Pure and prop-driven — the
// tree lives in pane-layout.ts state owned by the caller, and leaves render
// through the injected renderLeaf so this component never touches session or
// engine state itself.
import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelLayoutFrame,
  flushLayoutFrame,
  scheduleLayoutFrame,
} from "./interaction-frame-scheduler";
import {
  clampPaneRatio,
  clampPaneRatioForSizes,
  paneNodeMinimumSize,
  type PaneDirection,
  type PaneLeaf,
  type PaneNode,
} from "./pane-layout";

function PaneResizeHandle({ direction, firstMinimum, secondMinimum, onRatioChange }: {
  direction: PaneDirection;
  firstMinimum: number;
  secondMinimum: number;
  onRatioChange: (ratio: number) => void;
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const previewFrameKey = useRef({});
  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const container = handle.parentElement;
    if (!container) return;
    cleanupRef.current?.();
    setDragging(true);
    handle.setPointerCapture(event.pointerId);
    const isRow = direction === "row";
    const rect = container.getBoundingClientRect();
    let pendingRatio: number | null = null;
    const applyPreview = (): void => {
      if (pendingRatio === null) return;
      onRatioChange(pendingRatio);
    };
    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const ratio = isRow
        ? (moveEvent.clientX - rect.left) / rect.width
        : (moveEvent.clientY - rect.top) / rect.height;
      pendingRatio = clampPaneRatioForSizes(
        ratio,
        isRow ? rect.width : rect.height,
        firstMinimum,
        secondMinimum,
      );
      scheduleLayoutFrame(previewFrameKey.current, applyPreview);
    };
    let cleaned = false;
    const cleanup = (commit: boolean): void => {
      if (cleaned) return;
      cleaned = true;
      if (commit) flushLayoutFrame(previewFrameKey.current);
      else cancelLayoutFrame(previewFrameKey.current);
      setDragging(false);
      try {
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Unmount cleanup can run after Chromium already dropped the capture.
      }
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      handle.removeEventListener("lostpointercapture", stop);
      if (commit && pendingRatio !== null) onRatioChange(pendingRatio);
      if (cleanupRef.current === dispose) cleanupRef.current = null;
    };
    const stop = () => cleanup(true);
    const dispose = () => cleanup(false);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("lostpointercapture", stop);
    cleanupRef.current = dispose;
  }, [direction, firstMinimum, onRatioChange, secondMinimum]);

  return (
    <div
      className={`pane-resize-handle${dragging ? " is-dragging" : ""}`}
      onPointerDown={onPointerDown}
    />
  );
}

export function PaneSplitLayout({ node, path = "", renderLeaf, onRatioChange }: {
  node: PaneNode;
  path?: string;
  renderLeaf: (leaf: PaneLeaf) => React.ReactNode;
  onRatioChange: (path: string, ratio: number) => void;
}): React.JSX.Element {
  if (node.type === "leaf") {
    return (
      <div className="pane-leaf" data-pane-id={node.id} data-pane-path={path}>
        {renderLeaf(node)}
      </div>
    );
  }
  const ratio = clampPaneRatio(node.ratio);
  const nodeMinimum = paneNodeMinimumSize(node);
  const firstMinimum = paneNodeMinimumSize(node.first);
  const secondMinimum = paneNodeMinimumSize(node.second);
  const childPath = (segment: "first" | "second"): string =>
    (path ? `${path}.${segment}` : segment);
  return (
    <div className={`pane-split pane-split-${node.direction}`}
      data-pane-path={path} data-pane-direction={node.direction}
      style={{
        minWidth: nodeMinimum.width,
        minHeight: nodeMinimum.height,
      }}>
      <div className="pane-split-cell" style={{
        flex: `${ratio} 1 0%`,
        minWidth: firstMinimum.width,
        minHeight: firstMinimum.height,
      }}>
        <PaneSplitLayout
          node={node.first}
          path={childPath("first")}
          renderLeaf={renderLeaf}
          onRatioChange={onRatioChange}
        />
      </div>
      <PaneResizeHandle
        direction={node.direction}
        firstMinimum={node.direction === "row" ? firstMinimum.width : firstMinimum.height}
        secondMinimum={node.direction === "row" ? secondMinimum.width : secondMinimum.height}
        onRatioChange={(next) => onRatioChange(path, next)}
      />
      <div className="pane-split-cell" style={{
        flex: `${1 - ratio} 1 0%`,
        minWidth: secondMinimum.width,
        minHeight: secondMinimum.height,
      }}>
        <PaneSplitLayout
          node={node.second}
          path={childPath("second")}
          renderLeaf={renderLeaf}
          onRatioChange={onRatioChange}
        />
      </div>
    </div>
  );
}
