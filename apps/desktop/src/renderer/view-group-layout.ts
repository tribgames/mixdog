// Two side surfaces — the activity-rail sidebar and the utility dock — offer
// the SAME view customization: drag a view onto another to stack them into one
// group, drag a group root to reorder the column, and remember the result for
// the next launch. They differ only in their id vocabulary, their storage key
// and their drag MIME types, so one implementation serves both instead of two
// copies drifting apart.
import {
  useCallback,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type HTMLAttributes,
} from "react";

export type ViewGroupPlacement = "before" | "after" | "inside";

export function createViewGroupLayout<Id extends string>({
  storageKey,
  viewMime,
  groupMime,
  defaultOrder,
}: {
  storageKey: string;
  viewMime: string;
  groupMime: string;
  defaultOrder: readonly Id[];
}) {
  const isViewId = (value: unknown): value is Id => defaultOrder.includes(value as Id);

  /** Stored layout → the groups actually renderable now: unknown, unavailable
   *  and duplicated ids drop out, and every available id missing from the
   *  stored value joins the end as its own group. */
  const normalize = (value: unknown, available: readonly Id[] = defaultOrder): Id[][] => {
    const allowed = new Set(available);
    const seen = new Set<Id>();
    const groups: Id[][] = [];
    if (Array.isArray(value)) {
      for (const rawGroup of value) {
        if (!Array.isArray(rawGroup)) continue;
        const group: Id[] = [];
        for (const id of rawGroup) {
          if (!isViewId(id) || !allowed.has(id) || seen.has(id)) continue;
          seen.add(id);
          group.push(id);
        }
        if (group.length) groups.push(group);
      }
    }
    for (const id of available) {
      if (!seen.has(id)) groups.push([id]);
    }
    return groups;
  };

  const mutableGroups = (groups: readonly (readonly Id[])[]): Id[][] =>
    groups.map((group) => [...group]).filter((group) => group.length > 0);

  const moveGroup = (
    groups: readonly (readonly Id[])[],
    sourceRoot: Id,
    targetRoot: Id,
    placement: Exclude<ViewGroupPlacement, "inside">,
  ): Id[][] => {
    const next = mutableGroups(groups);
    const sourceIndex = next.findIndex((group) => group[0] === sourceRoot);
    const targetIndex = next.findIndex((group) => group[0] === targetRoot);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return next;
    const [source] = next.splice(sourceIndex, 1);
    const adjustedTarget = next.findIndex((group) => group[0] === targetRoot);
    next.splice(adjustedTarget + (placement === "after" ? 1 : 0), 0, source);
    return next;
  };

  const moveView = (
    groups: readonly (readonly Id[])[],
    sourceId: Id,
    targetId: Id,
    placement: ViewGroupPlacement,
  ): Id[][] => {
    if (sourceId === targetId) return mutableGroups(groups);
    const next = mutableGroups(groups);
    const sourceGroupIndex = next.findIndex((group) => group.includes(sourceId));
    const targetGroupIndex = next.findIndex((group) => group.includes(targetId));
    if (sourceGroupIndex < 0 || targetGroupIndex < 0) return next;
    if (placement === "inside"
      && sourceGroupIndex === targetGroupIndex
      && next[sourceGroupIndex][0] === sourceId) return next;

    next[sourceGroupIndex] = next[sourceGroupIndex].filter((id) => id !== sourceId);
    if (next[sourceGroupIndex].length === 0) next.splice(sourceGroupIndex, 1);

    const currentTargetGroupIndex = next.findIndex((group) => group.includes(targetId));
    if (currentTargetGroupIndex < 0) return next;
    if (placement === "inside") {
      const targetGroup = next[currentTargetGroupIndex];
      targetGroup.splice(targetGroup.indexOf(targetId) + 1, 0, sourceId);
    } else {
      next.splice(currentTargetGroupIndex + (placement === "after" ? 1 : 0), 0, [sourceId]);
    }
    return next;
  };

  const readStoredGroups = (): unknown => {
    try {
      return JSON.parse(window.localStorage.getItem(storageKey) || "null");
    } catch {
      return null;
    }
  };

  const persistGroups = (groups: readonly (readonly Id[])[]): void => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(groups));
    } catch {
      // View customization remains available for the current renderer session.
    }
  };

  const dragIdReader = (mime: string) =>
    (event: Pick<DragEvent, "dataTransfer">): Id | null => {
      const value = event.dataTransfer?.getData(mime);
      return isViewId(value) ? value : null;
    };

  const useLayout = (available: readonly Id[]) => {
    const availableKey = available.join("\0");
    const [storedGroups, setStoredGroups] = useState<readonly (readonly Id[])[]>(
      () => normalize(readStoredGroups(), available));
    const groups = useMemo(
      () => normalize(storedGroups, available),
      [availableKey, storedGroups],
    );
    const apply = useCallback((move: (current: Id[][]) => Id[][]) => {
      setStoredGroups((current) => {
        const next = move(normalize(current, available));
        persistGroups(next);
        return next;
      });
    }, [availableKey]);
    return {
      groups,
      groupFor: useCallback((id: Id): readonly Id[] =>
        groups.find((group) => group.includes(id)) ?? [id], [groups]),
      moveGroup: useCallback((
        sourceRoot: Id,
        targetRoot: Id,
        placement: Exclude<ViewGroupPlacement, "inside">,
      ) => apply((current) => moveGroup(current, sourceRoot, targetRoot, placement)), [apply]),
      moveView: useCallback((
        sourceId: Id,
        targetId: Id,
        placement: ViewGroupPlacement,
      ) => apply((current) => moveView(current, sourceId, targetId, placement)), [apply]),
      reset: useCallback(() => apply(() => normalize(null, available)), [apply]),
      getViewDragProps: useCallback((id: Id): HTMLAttributes<HTMLElement> => ({
        draggable: true,
        onDragStart: (event) => {
          const dragEvent = event as ReactDragEvent<HTMLElement>;
          dragEvent.dataTransfer.effectAllowed = "move";
          dragEvent.dataTransfer.setData(viewMime, id);
          dragEvent.dataTransfer.setData("text/plain", id);
        },
      }), []),
    };
  };

  return {
    normalize,
    moveGroup,
    moveView,
    viewDragId: dragIdReader(viewMime),
    groupDragId: dragIdReader(groupMime),
    useLayout,
  };
}

/** Container-level drag acceptance for a whole tab strip. Only the tab
 *  buttons themselves called preventDefault on dragover, so the browser
 *  flashed its no-drop cursor over every gap and margin between them during a
 *  reorder (user: 드래그할 때 자꾸 금지 표기가 떠). Spread on the strip's
 *  container, these props keep the "move" cursor across the whole strip and
 *  route a drop landing beside a button to the NEAREST tab instead of
 *  cancelling. Events over a `data-view-group` button stay with the button's
 *  own handlers, which know the precise before/inside/after placement. */
export function viewGroupContainerDropProps<Id extends string>({
  viewMime,
  groupMime,
  axis,
  viewDragId,
  groupDragId,
  setDrop,
  moveGroup,
  moveView,
}: {
  viewMime: string;
  groupMime: string;
  /** Layout direction of the strip: "y" for a vertical rail, "x" for a row. */
  axis: "x" | "y";
  viewDragId: (event: Pick<DragEvent, "dataTransfer">) => Id | null;
  groupDragId: (event: Pick<DragEvent, "dataTransfer">) => Id | null;
  setDrop: (drop: { target: Id; placement: ViewGroupPlacement } | null) => void;
  moveGroup?: (source: Id, target: Id, placement: Exclude<ViewGroupPlacement, "inside">) => void;
  moveView?: (source: Id, target: Id, placement: ViewGroupPlacement) => void;
}): HTMLAttributes<HTMLElement> {
  const overButton = (event: ReactDragEvent<HTMLElement>): boolean =>
    event.target instanceof Element && event.target.closest("[data-view-group]") !== null;
  /** Gap position → the nearest tab button plus which side of its center the
   *  pointer sits on; gaps never produce "inside". */
  const nearestTarget = (
    event: ReactDragEvent<HTMLElement>,
  ): { target: Id; placement: Exclude<ViewGroupPlacement, "inside"> } | null => {
    const pointer = axis === "y" ? event.clientY : event.clientX;
    let best: { target: Id; placement: "before" | "after" } | null = null;
    let bestDistance = Infinity;
    for (const button of event.currentTarget.querySelectorAll<HTMLElement>("[data-view-group]")) {
      const id = button.dataset.viewGroup as Id | undefined;
      if (!id) continue;
      const bounds = button.getBoundingClientRect();
      const center = axis === "y"
        ? bounds.top + bounds.height / 2
        : bounds.left + bounds.width / 2;
      const distance = Math.abs(pointer - center);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = { target: id, placement: pointer < center ? "before" : "after" };
    }
    return best;
  };
  const accepts = (event: ReactDragEvent<HTMLElement>): boolean => {
    const types = Array.from(event.dataTransfer.types);
    return types.includes(groupMime) || types.includes(viewMime);
  };
  return {
    onDragOver: (event) => {
      if (!accepts(event)) return;
      // Accepting on the container is what keeps the cursor a move arrow
      // across the gaps; a hovered button repaints the indicator itself.
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (overButton(event)) return;
      setDrop(nearestTarget(event));
    },
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
    },
    onDrop: (event) => {
      if (overButton(event) || !accepts(event)) return;
      event.preventDefault();
      const nearest = nearestTarget(event);
      const groupSource = groupDragId(event.nativeEvent);
      const viewSource = viewDragId(event.nativeEvent);
      if (nearest && groupSource) moveGroup?.(groupSource, nearest.target, nearest.placement);
      else if (nearest && viewSource) moveView?.(viewSource, nearest.target, nearest.placement);
      setDrop(null);
    },
  };
}
