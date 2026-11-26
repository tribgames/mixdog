import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cancelLayoutFrame, scheduleLayoutFrame } from './interaction-frame-scheduler';
import {
  clampPaneRatio,
  clampPaneRatioForSizes,
  paneNodeMinimumSize,
  type PaneDirection,
  type PaneLeaf,
  type PaneNode,
} from './pane-layout';

function PaneResizeHandle({
  direction,
  ratio,
  firstMinimum,
  secondMinimum,
  onRatioChange,
}: {
  direction: PaneDirection;
  ratio: number;
  firstMinimum: number;
  secondMinimum: number;
  onRatioChange: (ratio: number) => void;
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const previewFrameKey = useRef({});
  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      const container = handle.parentElement;
      if (!container) return;
      const firstCell = handle.previousElementSibling;
      const secondCell = handle.nextElementSibling;
      const initialFirstFlex = firstCell instanceof HTMLElement ? firstCell.style.flex : '';
      const initialSecondFlex = secondCell instanceof HTMLElement ? secondCell.style.flex : '';
      cleanupRef.current?.();
      setDragging(true);
      handle.setPointerCapture(event.pointerId);
      const isRow = direction === 'row';
      const rect = container.getBoundingClientRect();
      let pendingRatio: number | null = null;
      const applyPreview = (): void => {
        if (pendingRatio === null) return;
        container.style.setProperty('--pane-split-ratio', String(pendingRatio));
        if (firstCell instanceof HTMLElement) firstCell.style.flex = `${pendingRatio} 1 0%`;
        if (secondCell instanceof HTMLElement) secondCell.style.flex = `${1 - pendingRatio} 1 0%`;
      };
      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        const nextRatio = isRow
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height;
        pendingRatio = clampPaneRatioForSizes(nextRatio, isRow ? rect.width : rect.height, firstMinimum, secondMinimum);
        scheduleLayoutFrame(previewFrameKey.current, applyPreview);
      };
      let cleaned = false;
      const cleanup = (commit: boolean): void => {
        if (cleaned) return;
        cleaned = true;
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', dispose);
        handle.removeEventListener('lostpointercapture', dispose);
        cancelLayoutFrame(previewFrameKey.current);
        container.style.removeProperty('--pane-split-ratio');
        if (firstCell instanceof HTMLElement) firstCell.style.flex = initialFirstFlex;
        if (secondCell instanceof HTMLElement) secondCell.style.flex = initialSecondFlex;
        setDragging(false);
        try {
          if (handle.hasPointerCapture(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId);
          }
        } catch {
          // Unmount cleanup can run after Chromium already dropped the capture.
        }
        if (commit && pendingRatio !== null) onRatioChange(pendingRatio);
        if (cleanupRef.current === dispose) cleanupRef.current = null;
      };
      const stop = () => cleanup(true);
      const dispose = () => cleanup(false);
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', dispose);
      handle.addEventListener('lostpointercapture', dispose);
      cleanupRef.current = dispose;
    },
    [direction, firstMinimum, onRatioChange, secondMinimum]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const isRow = direction === 'row';
      const delta = isRow
        ? event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowRight'
            ? 1
            : 0
        : event.key === 'ArrowUp'
          ? -1
          : event.key === 'ArrowDown'
            ? 1
            : 0;
      if (delta === 0) return;
      event.preventDefault();
      const step = event.shiftKey ? 0.1 : 0.05;
      const container = event.currentTarget.parentElement;
      const rect = container?.getBoundingClientRect();
      const size = rect ? (isRow ? rect.width : rect.height) : 0;
      const next =
        size > 0
          ? clampPaneRatioForSizes(ratio + delta * step, size, firstMinimum, secondMinimum)
          : clampPaneRatio(ratio + delta * step);
      if (next !== ratio) onRatioChange(next);
    },
    [direction, firstMinimum, onRatioChange, ratio, secondMinimum]
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable resize handle, not a thematic break; <hr> brings its own border and margins.
    <div
      className={`pane-resize-handle${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

export function PaneSplitLayout({
  node,
  path = '',
  renderLeaf,
  onRatioChange,
}: {
  node: PaneNode;
  path?: string;
  renderLeaf: (leaf: PaneLeaf) => React.ReactNode;
  onRatioChange: (path: string, ratio: number) => void;
}): React.JSX.Element {
  if (node.type === 'leaf') {
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
  const childPath = (segment: 'first' | 'second'): string => (path ? `${path}.${segment}` : segment);
  return (
    <div
      className={`pane-split pane-split-${node.direction}`}
      data-pane-path={path}
      data-pane-direction={node.direction}
      style={{
        minWidth: nodeMinimum.width,
        minHeight: nodeMinimum.height,
      }}
    >
      <div
        className="pane-split-cell"
        style={{
          flex: `${ratio} 1 0%`,
          minWidth: firstMinimum.width,
          minHeight: firstMinimum.height,
        }}
      >
        <PaneSplitLayout
          node={node.first}
          path={childPath('first')}
          renderLeaf={renderLeaf}
          onRatioChange={onRatioChange}
        />
      </div>
      <PaneResizeHandle
        direction={node.direction}
        ratio={ratio}
        firstMinimum={node.direction === 'row' ? firstMinimum.width : firstMinimum.height}
        secondMinimum={node.direction === 'row' ? secondMinimum.width : secondMinimum.height}
        onRatioChange={(next) => onRatioChange(path, next)}
      />
      <div
        className="pane-split-cell"
        style={{
          flex: `${1 - ratio} 1 0%`,
          minWidth: secondMinimum.width,
          minHeight: secondMinimum.height,
        }}
      >
        <PaneSplitLayout
          node={node.second}
          path={childPath('second')}
          renderLeaf={renderLeaf}
          onRatioChange={onRatioChange}
        />
      </div>
    </div>
  );
}
