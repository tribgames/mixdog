import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';

const DRAG_EDGE_SCROLL_ZONE = 48;
const DRAG_EDGE_SCROLL_MAX_STEP = 18;

export function dragEdgeScrollDelta(clientY: number, top: number, bottom: number): number {
  if (bottom <= top) return 0;
  if (clientY < top + DRAG_EDGE_SCROLL_ZONE) {
    const pressure = Math.min(1, Math.max(0, (top + DRAG_EDGE_SCROLL_ZONE - clientY) / DRAG_EDGE_SCROLL_ZONE));
    return pressure ? -Math.max(1, Math.ceil(DRAG_EDGE_SCROLL_MAX_STEP * pressure)) : 0;
  }
  if (clientY > bottom - DRAG_EDGE_SCROLL_ZONE) {
    const pressure = Math.min(1, Math.max(0, (clientY - (bottom - DRAG_EDGE_SCROLL_ZONE)) / DRAG_EDGE_SCROLL_ZONE));
    return pressure ? Math.max(1, Math.ceil(DRAG_EDGE_SCROLL_MAX_STEP * pressure)) : 0;
  }
  return 0;
}

function verticalScrollContainer(element: HTMLElement): HTMLElement | null {
  const rail = element.closest<HTMLElement>('.session-sidebar-scroll');
  if (rail && rail.scrollHeight > rail.clientHeight) return rail;
  let node = element.parentElement;
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

function readOrder(storageKey: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** `known` (the saved order, only current ids) with each id of `ids` it lacks
 *  added last, except ids ahead of every listed one in `ids` (added at the
 *  head of the list): those stay first. */
export function mergeNewAtDefault(known: readonly string[], ids: readonly string[]): string[] {
  const merged = [...known];
  let lead = 0;
  ids.forEach((id, index) => {
    if (merged.includes(id)) return;
    if (ids.slice(0, index).some((before) => merged.includes(before))) merged.push(id);
    else merged.splice(lead++, 0, id);
  });
  return merged;
}

/** `dropAnchor`: a selector inside the drop target whose midpoint splits
 *  before/after (e.g. a section's heading), so a tall target reorders as soon
 *  as the pointer crosses its heading instead of its whole body's middle. */
export function usePersistedListOrder(
  storageKey: string,
  ids: readonly string[],
  options: {
    dropAnchor?: string;
    /** Caller owns ordering and persistence: `ids` is the displayed order and a
     *  drop reports the reordered ids here instead of writing `storageKey`. */
    onCommit?(next: string[], sourceId: string): void;
    /** Whether a drag of `sourceId` may drop on `targetId` (default: always). */
    accepts?(sourceId: string, targetId: string): boolean;
    /** An id the saved order lacks that leads `ids` (added at the head) goes
     *  first instead of last (mergeNewAtDefault). */
    placeNewAtDefault?: boolean;
  } = {}
) {
  const { dropAnchor, onCommit, accepts, placeNewAtDefault } = options;
  const [storedOrder, setStoredOrder] = useState<string[]>(() => (onCommit ? [] : readOrder(storageKey)));
  const [draggingId, setDraggingId] = useState('');
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const draggingIdRef = useRef('');
  const scrollNodeRef = useRef<HTMLElement | null>(null);
  const dragClientYRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const orderedIds = useMemo(() => {
    if (onCommit) return [...ids];
    const available = new Set(ids);
    const known = storedOrder.filter((id) => available.has(id));
    const knownSet = new Set(known);
    if (!placeNewAtDefault) return [...known, ...ids.filter((id) => !knownSet.has(id))];
    return mergeNewAtDefault(known, ids);
  }, [ids, storedOrder, onCommit, placeNewAtDefault]);

  const runEdgeScroll = useCallback(() => {
    scrollFrameRef.current = null;
    const node = scrollNodeRef.current;
    const clientY = dragClientYRef.current;
    if (!node || clientY === null) return;
    const bounds = node.getBoundingClientRect();
    const delta = dragEdgeScrollDelta(clientY, bounds.top, bounds.bottom);
    if (!delta) return;
    const previous = node.scrollTop;
    node.scrollTop += delta;
    if (node.scrollTop !== previous) {
      scrollFrameRef.current = window.requestAnimationFrame(runEdgeScroll);
    }
  }, []);

  const handleDocumentDragOver = useCallback(
    (event: globalThis.DragEvent) => {
      const node = scrollNodeRef.current;
      if (!node) return;
      const bounds = node.getBoundingClientRect();
      const insideExpandedEdge =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top - DRAG_EDGE_SCROLL_ZONE &&
        event.clientY <= bounds.bottom + DRAG_EDGE_SCROLL_ZONE;
      dragClientYRef.current = insideExpandedEdge ? event.clientY : null;
      if (!insideExpandedEdge) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      if (scrollFrameRef.current === null) {
        scrollFrameRef.current = window.requestAnimationFrame(runEdgeScroll);
      }
    },
    [runEdgeScroll]
  );

  const stopEdgeScroll = useCallback(() => {
    document.removeEventListener('dragover', handleDocumentDragOver);
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    scrollNodeRef.current = null;
    dragClientYRef.current = null;
  }, [handleDocumentDragOver]);

  useEffect(() => stopEdgeScroll, [stopEdgeScroll]);

  const finishDrag = () => {
    stopEdgeScroll();
    draggingIdRef.current = '';
    setDraggingId('');
    setDropTarget(null);
  };

  const getReorderProps = (id: string) => ({
    draggable: true,
    'data-reordering': draggingId === id ? 'true' : undefined,
    'data-drop-position': dropTarget?.id === id ? dropTarget.position : undefined,
    onDragStart: (event: ReactDragEvent<HTMLElement>) => {
      stopEdgeScroll();
      draggingIdRef.current = id;
      setDraggingId(id);
      scrollNodeRef.current = verticalScrollContainer(event.currentTarget);
      if (scrollNodeRef.current) {
        document.addEventListener('dragover', handleDocumentDragOver);
      }
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', id);
    },
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      const sourceId = draggingIdRef.current;
      if (!sourceId || sourceId === id || accepts?.(sourceId, id) === false) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const anchor = (dropAnchor && event.currentTarget.querySelector(dropAnchor)) || event.currentTarget;
      const bounds = anchor.getBoundingClientRect();
      const position = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
      setDropTarget((current) => (current?.id === id && current.position === position ? current : { id, position }));
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      const sourceId = draggingIdRef.current || event.dataTransfer.getData('text/plain');
      const position = dropTarget?.id === id ? dropTarget.position : 'before';
      if (!sourceId || sourceId === id || !orderedIds.includes(sourceId) || accepts?.(sourceId, id) === false) {
        finishDrag();
        return;
      }
      const next = orderedIds.filter((entry) => entry !== sourceId);
      const targetIndex = next.indexOf(id);
      if (targetIndex < 0) {
        finishDrag();
        return;
      }
      next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, sourceId);
      if (onCommit) {
        onCommit(next, sourceId);
        finishDrag();
        return;
      }
      setStoredOrder(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* list order is a convenience only */
      }
      finishDrag();
    },
    onDragEnd: finishDrag,
  });

  return { orderedIds, getReorderProps };
}
