import { type MutableRefObject, useCallback, useLayoutEffect, useRef } from 'react';
import {
  batchVirtualizerEndPin,
  ceilRowHeight,
  rememberRowHeight,
  type TranscriptVirtualizer,
} from './transcript-list-geometry';
import { resolveMutationObserver } from './transcript-list-provisional-resize';
import type { useReadingAnchor } from './transcript-list-reading-anchor';
import type { TranscriptRowModel } from './transcript-rows';

type ReadingAnchorState = ReturnType<typeof useReadingAnchor>;

type PendingResizes = MutableRefObject<Map<unknown, { index: number; size: number }>>;

/** The row elements read once since they mounted, with the spacing they took from the rows around them then. A size
 *  the list holds for a row from an earlier mount (a session shown before, a row scrolled away and back) is what the
 *  row measured then: a row that mounts is read in its own commit all the same, so it is never drawn for a frame at a
 *  size it no longer has. A row whose neighbours changed its spacing (a tool card arriving above a streaming reply
 *  gives it the part step) is read in that commit too. */
const readRows = new WeakMap<HTMLElement, string>();

const NEIGHBOUR_MARK_ATTRIBUTES = [
  'data-timeline-key',
  'data-turn-end',
  'data-band-seat',
  'data-band-lead',
  'data-step-before',
  'data-after-changes',
  'data-divider-step',
  'data-divider-gap',
  'data-blank',
  'data-variant',
];

function isHtmlElement(node: Node | null): node is HTMLElement {
  if (!node || typeof node !== 'object') return false;
  if (typeof HTMLElement === 'function' && node instanceof HTMLElement) return true;
  const view = node.ownerDocument?.defaultView;
  return Boolean(view && typeof view.HTMLElement === 'function' && node instanceof view.HTMLElement);
}

function isVirtualRow(node: Node | null): node is HTMLElement {
  return isHtmlElement(node) && node.dataset.timelineKey !== undefined;
}

/** The marks a row's content takes from the rows around it (TranscriptList.tsx `renderVirtualRow`). */
function neighbourMarks(row: HTMLElement): string {
  const content = row.firstElementChild;
  if (!isHtmlElement(content)) return '';
  const marks = content.dataset;
  return [
    marks.turnEnd,
    marks.bandSeat,
    marks.bandLead,
    marks.stepBefore,
    marks.afterChanges,
    marks.dividerStep,
    marks.dividerGap,
    marks.blank,
    marks.variant,
  ].join('|');
}

function applyMeasuredRowSize(
  row: HTMLElement,
  size: number,
  width: number,
  instance: TranscriptVirtualizer,
  pendingResizes: PendingResizes,
  indexForPendingKey: (key: unknown, hint: number) => number,
  apply: (index: number, size: number) => void
): { measured: boolean; hidden: boolean } {
  const key = row.dataset.timelineKey as string;
  const at = indexForPendingKey(key, Number(row.dataset.index));
  const collapsed = size === 0 && width > 0;
  // A hidden pane (display: none -> 0x0 box) must not overwrite the last
  // measured --transcript-measured-height or timeline cache with 0px.
  if (size <= 0 && !collapsed) return { measured: false, hidden: true };
  if (at < 0) return { measured: false, hidden: false };
  rememberRowHeight(row, size);
  if (instance.itemSizeCache.get(key) === size) return { measured: false, hidden: false };
  pendingResizes.current.delete(key);
  // virtual-core's resize records no size for a zero delta.
  if (!instance.itemSizeCache.has(key) && instance.measurementsCache[at]?.size === size) {
    instance.itemSizeCache.set(key, size);
    return { measured: false, hidden: false };
  }
  apply(at, size);
  return { measured: true, hidden: false };
}

/** Reads every row's box before any held height is written (a write between
 *  reads invalidates layout for each next read), then applies the sizes that
 *  differ from what the timeline holds. Returns whether any size was applied
 *  and updates `unmeasuredRows` for rows that were hidden (0x0) during this pass. */
function applyMountedRowSizes(
  mounted: readonly HTMLElement[],
  instance: TranscriptVirtualizer,
  pendingResizes: PendingResizes,
  indexForPendingKey: (key: unknown, hint: number) => number,
  apply: (index: number, size: number) => void,
  unmeasuredRows: Set<HTMLElement>
): boolean {
  if (mounted.length === 0) return false;
  const boxes = mounted.map((row) => row.getBoundingClientRect());
  const sizes = boxes.map((box) => ceilRowHeight(box.height));
  let measured = false;
  batchVirtualizerEndPin(instance, () => {
    mounted.forEach((row, position) => {
      const result = applyMeasuredRowSize(
        row,
        sizes[position] ?? 0,
        Number(boxes[position]?.width) || 0,
        instance,
        pendingResizes,
        indexForPendingKey,
        apply
      );
      if (result.hidden) unmeasuredRows.add(row);
      else unmeasuredRows.delete(row);
      if (result.measured) measured = true;
    });
  });
  return measured;
}

/** Marks the rows whose live band (a Thinking row) left in this row set. */
function noteBandHandoffs(
  before: readonly TranscriptRowModel[],
  rows: readonly TranscriptRowModel[],
  handoff: Set<string>
) {
  const kept = new Set(rows.map((row) => String(row.key)));
  before.forEach((row, index) => {
    const lead = before[index - 1];
    if (row._tag === 'Thinking' && lead && !kept.has(String(row.key)) && kept.has(String(lead.key))) {
      handoff.add(String(lead.key));
    }
  });
}

function rowForMutationTarget(root: HTMLElement, target: Node): HTMLElement | null {
  if (!isHtmlElement(target)) return null;
  if (target.parentElement === root) return isVirtualRow(target) ? target : null;
  const parent = target.parentElement;
  if (parent && parent.parentElement === root && parent.firstElementChild === target) {
    return isVirtualRow(parent) ? parent : null;
  }
  return null;
}

/** Rows are measured incrementally in their own commits, before the parent
 *  list writes the spacer height. Direct-child and neighbour-attribute
 *  MutationObservers feed a synchronous `takeRecords()` drain so steady-state
 *  renders early-return in O(1) while scroll mounts, visibility transitions,
 *  and neighbour spacing changes measure only affected rows. Ongoing row
 *  resizes remain owned by virtual-core's single shared border-box
 *  ResizeObserver (transcript-list-row-registration.ts). A prepend landing
 *  re-reads every mounted row synchronously so reading-anchor restoration
 *  lands in the same commit before paint. */
export function useMountedRowMeasurement({
  rows,
  spacer,
  virtualizerRef,
  baseResizeItem,
  pendingResizes,
  indexForPendingKey,
  laidOutRows,
  pendingAnchor,
  anchorHold,
  restoreReadingAnchor,
}: {
  rows: readonly TranscriptRowModel[];
  spacer: MutableRefObject<HTMLDivElement | null>;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  baseResizeItem: MutableRefObject<((index: number, size: number) => void) | null>;
  pendingResizes: PendingResizes;
  indexForPendingKey: (key: unknown, hint: number) => number;
  laidOutRows: ReadingAnchorState['laidOutRows'];
  pendingAnchor: ReadingAnchorState['pendingAnchor'];
  anchorHold: ReadingAnchorState['anchorHold'];
  restoreReadingAnchor: ReadingAnchorState['restoreReadingAnchor'];
}) {
  const landingMeasure = useRef(false);
  const measuredInLanding = useRef(false);
  const landingFrame = useRef(0);
  const previousRows = useRef(rows);
  const bandHandoff = useRef(new Set<string>());
  const latestRef = useRef({ indexForPendingKey, restoreReadingAnchor });
  latestRef.current = { indexForPendingKey, restoreReadingAnchor };

  const trackerRef = useRef<{
    root: HTMLElement | null;
    rowByKey: Map<string, HTMLElement>;
    keyByRow: WeakMap<HTMLElement, string>;
    unmeasuredRows: Set<HTMLElement>;
    childObserver: MutationObserver | null;
    attrObserver: MutationObserver | null;
  }>({
    root: null,
    rowByKey: new Map(),
    keyByRow: new WeakMap(),
    unmeasuredRows: new Set(),
    childObserver: null,
    attrObserver: null,
  });

  const measureRows = useCallback(
    (targets: readonly HTMLElement[], landing: boolean) => {
      if (targets.length === 0) return false;
      const instance = virtualizerRef.current;
      const apply = landing ? baseResizeItem.current : instance.resizeItem;
      if (!apply) return false;
      return applyMountedRowSizes(
        targets,
        instance,
        pendingResizes,
        latestRef.current.indexForPendingKey,
        apply,
        trackerRef.current.unmeasuredRows
      );
    },
    [baseResizeItem, pendingResizes, virtualizerRef]
  );

  const trackRow = useCallback((row: HTMLElement) => {
    const tracker = trackerRef.current;
    const key = row.dataset.timelineKey;
    if (key === undefined) return;
    const priorKey = tracker.keyByRow.get(row);
    if (priorKey !== undefined && priorKey !== key && tracker.rowByKey.get(priorKey) === row) {
      tracker.rowByKey.delete(priorKey);
    }
    tracker.keyByRow.set(row, key);
    tracker.rowByKey.set(key, row);
  }, []);

  const untrackRow = useCallback((node: Node) => {
    if (!isHtmlElement(node)) return;
    const tracker = trackerRef.current;
    tracker.unmeasuredRows.delete(node);
    const priorKey = tracker.keyByRow.get(node) ?? node.dataset.timelineKey;
    if (priorKey !== undefined && tracker.rowByKey.get(priorKey) === node) {
      tracker.rowByKey.delete(priorKey);
    }
    tracker.keyByRow.delete(node);
  }, []);

  const collectDirtyFromRecords = useCallback(
    (root: HTMLElement, records: readonly MutationRecord[]): HTMLElement[] => {
      if (records.length === 0) return [];
      const instance = virtualizerRef.current;
      const dirty = new Set<HTMLElement>();
      for (const record of records) {
        if (record.type === 'childList') {
          if (record.target !== root) continue;
          for (const removed of record.removedNodes) untrackRow(removed);
          for (const added of record.addedNodes) {
            if (!isVirtualRow(added) || !added.isConnected) continue;
            trackRow(added);
            const marks = neighbourMarks(added);
            const changed = readRows.get(added) !== marks;
            readRows.set(added, marks);
            const key = added.dataset.timelineKey as string;
            if (changed || (!instance.itemSizeCache.has(key) && !pendingResizes.current.has(key))) {
              dirty.add(added);
            }
          }
          continue;
        }
        if (record.type === 'attributes') {
          const row = rowForMutationTarget(root, record.target);
          if (!row?.isConnected) continue;
          trackRow(row);
          const marks = neighbourMarks(row);
          const changed = readRows.get(row) !== marks || record.attributeName === 'data-timeline-key';
          readRows.set(row, marks);
          if (changed) dirty.add(row);
        }
      }
      return [...dirty].filter((row) => row.isConnected && row.parentElement === root);
    },
    [pendingResizes, trackRow, untrackRow, virtualizerRef]
  );

  const disconnectTracker = useCallback(() => {
    const tracker = trackerRef.current;
    tracker.childObserver?.disconnect();
    tracker.childObserver = null;
    tracker.attrObserver?.disconnect();
    tracker.attrObserver = null;
    tracker.rowByKey.clear();
    tracker.unmeasuredRows.clear();
    tracker.root = null;
  }, []);

  const ensureAttached = useCallback(
    (root: HTMLElement): HTMLElement[] => {
      const tracker = trackerRef.current;
      if (tracker.root === root) return [];
      disconnectTracker();
      tracker.root = root;
      const MutationObserverCtor = resolveMutationObserver();
      if (MutationObserverCtor) {
        const handleMutations = (records: MutationRecord[]) => {
          const dirty = collectDirtyFromRecords(root, records);
          if (dirty.length === 0) return;
          const landing = landingMeasure.current;
          const measured = measureRows(dirty, landing);
          if (landing && measured) latestRef.current.restoreReadingAnchor();
        };
        // Separate direct-child observation from subtree attribute observation so
        // streaming DOM updates inside row bodies never trigger childList work.
        tracker.childObserver = new MutationObserverCtor(handleMutations);
        tracker.childObserver.observe(root, { childList: true });
        tracker.attrObserver = new MutationObserverCtor(handleMutations);
        tracker.attrObserver.observe(root, {
          attributes: true,
          subtree: true,
          attributeFilter: NEIGHBOUR_MARK_ATTRIBUTES,
        });
      }
      const instance = virtualizerRef.current;
      const initial: HTMLElement[] = [];
      for (const child of root.children) {
        if (!isVirtualRow(child)) continue;
        trackRow(child);
        const marks = neighbourMarks(child);
        const changed = readRows.get(child) !== marks;
        readRows.set(child, marks);
        const key = child.dataset.timelineKey as string;
        if (changed || (!instance.itemSizeCache.has(key) && !pendingResizes.current.has(key))) {
          initial.push(child);
        }
      }
      return initial;
    },
    [collectDirtyFromRecords, disconnectTracker, measureRows, pendingResizes, trackRow, virtualizerRef]
  );

  const drainAndMeasureDirty = useCallback(
    (landing: boolean): boolean => {
      const root = spacer.current;
      if (!root) return false;
      const initialDirty = ensureAttached(root);
      const tracker = trackerRef.current;
      const childRecords = tracker.childObserver?.takeRecords() ?? [];
      const attrRecords = tracker.attrObserver?.takeRecords() ?? [];
      const hasHandoff = bandHandoff.current.size > 0;
      const hasUnmeasured = tracker.unmeasuredRows.size > 0;
      // O(1) steady-state fast path: nothing mounted, changed attributes,
      // handed off a Thinking band, or remained unmeasured from a hidden pass.
      if (
        initialDirty.length === 0 &&
        childRecords.length === 0 &&
        attrRecords.length === 0 &&
        !hasHandoff &&
        !hasUnmeasured &&
        tracker.childObserver !== null
      ) {
        return false;
      }
      const dirty = new Set<HTMLElement>(initialDirty);
      if (childRecords.length > 0 || attrRecords.length > 0) {
        for (const row of collectDirtyFromRecords(root, [...childRecords, ...attrRecords])) {
          dirty.add(row);
        }
      }
      if (tracker.childObserver === null) {
        const instance = virtualizerRef.current;
        for (const child of root.children) {
          if (!isVirtualRow(child)) continue;
          trackRow(child);
          const marks = neighbourMarks(child);
          const changed = readRows.get(child) !== marks;
          readRows.set(child, marks);
          const key = child.dataset.timelineKey as string;
          if (changed || (!instance.itemSizeCache.has(key) && !pendingResizes.current.has(key))) {
            dirty.add(child);
          }
        }
      }
      if (hasHandoff) {
        for (const key of bandHandoff.current) {
          const row = tracker.rowByKey.get(key);
          if (row?.isConnected && row.parentElement === root) dirty.add(row);
        }
        bandHandoff.current.clear();
      }
      if (hasUnmeasured) {
        for (const row of [...tracker.unmeasuredRows]) {
          if (row.isConnected && row.parentElement === root) dirty.add(row);
          else tracker.unmeasuredRows.delete(row);
        }
      }
      if (dirty.size === 0) return false;
      return measureRows([...dirty], landing);
    },
    [collectDirtyFromRecords, ensureAttached, measureRows, pendingResizes, spacer, trackRow, virtualizerRef]
  );

  useLayoutEffect(
    () => () => {
      if (landingFrame.current) {
        window.cancelAnimationFrame(landingFrame.current);
        landingFrame.current = 0;
      }
      disconnectTracker();
    },
    [disconnectTracker]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: must run only when the row set changes; every other input is read through refs or stable callbacks
  useLayoutEffect(() => {
    laidOutRows.current = rows;
    const before = previousRows.current;
    previousRows.current = rows;
    noteBandHandoffs(before, rows, bandHandoff.current);
    const pending = pendingAnchor.current;
    pendingAnchor.current = null;
    if (!pending?.anchor || virtualizerRef.current.options.anchorTo === 'end') return;
    anchorHold.current = { ...pending.anchor, start: null };
    if (latestRef.current.indexForPendingKey(pending.anchor.key, pending.anchor.index) !== pending.anchor.index) {
      landingMeasure.current = true;
      if (landingFrame.current) window.cancelAnimationFrame(landingFrame.current);
      landingFrame.current = window.requestAnimationFrame(() => {
        landingFrame.current = 0;
        landingMeasure.current = false;
      });
      const root = spacer.current;
      if (root) {
        ensureAttached(root);
        const tracker = trackerRef.current;
        const pendingRecords = [
          ...(tracker.childObserver?.takeRecords() ?? []),
          ...(tracker.attrObserver?.takeRecords() ?? []),
        ];
        if (pendingRecords.length > 0) collectDirtyFromRecords(root, pendingRecords);
        bandHandoff.current.clear();
        const mounted: HTMLElement[] = [];
        for (const child of root.children) {
          if (!isVirtualRow(child)) continue;
          trackRow(child);
          readRows.set(child, neighbourMarks(child));
          mounted.push(child);
        }
        measureRows(mounted, true);
      }
      measuredInLanding.current = true;
    } else {
      drainAndMeasureDirty(landingMeasure.current);
      measuredInLanding.current = true;
    }
    latestRef.current.restoreReadingAnchor(true);
  }, [rows]);

  // Synchronous pre-spacer drain across commits (scroll mounts, visibility flips,
  // neighbour spacing changes) with an O(1) early return when nothing is dirty.
  useLayoutEffect(() => {
    if (measuredInLanding.current) {
      measuredInLanding.current = false;
      return;
    }
    const landing = landingMeasure.current;
    if (drainAndMeasureDirty(landing) && landing) {
      latestRef.current.restoreReadingAnchor();
    }
  });
}
