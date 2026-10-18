import { createContext, createElement, type Dispatch, type SetStateAction, useContext, useState } from 'react';

/** The island's expandable tabs. Only one is open at a time; the files
 *  segment opens the pane's side dock instead, and is a tab only where the
 *  surface has no dock. */
export type ComposerIslandTab =
  | ''
  | 'goal'
  | 'agents'
  | 'shells'
  | 'files'
  | 'files-menu'
  | 'branch'
  | 'git'
  | 'resume';

export const ComposerIslandContext = createContext<{
  expanded: ComposerIslandTab;
  setExpanded: Dispatch<SetStateAction<ComposerIslandTab>>;
  /** The pill advance (width plus separator margin) reserved for each
   *  late-reading segment that has not decided yet; 0 when none is known. */
  reserves: IslandSegmentReserves;
} | null>(null);

/** Segments whose presence waits on a read (the session's branch menu, its
 *  changes, the repository status) after the island mounts. */
export type IslandReservedSegment = 'branch' | 'files' | 'git';
export type IslandSegmentReserves = Record<IslandReservedSegment, number>;

/** A segment that has not decided yet. Inside an island that knows the
 *  segment's last advance it keeps that room in the pill: a first entry
 *  otherwise opened the pill without the segment and widened it once the
 *  read answered, sliding every segment sideways. `holdEntry` also holds the
 *  conversation's entry reveal (`data-entry-pending`, use-transcript-reveal). */
export function IslandSegmentPending({
  kind,
  holdEntry = false,
}: {
  kind: IslandReservedSegment;
  holdEntry?: boolean;
}) {
  const reserve = useContext(ComposerIslandContext)?.reserves[kind] ?? 0;
  const marks = { 'data-island-pending': kind, ...(holdEntry ? { 'data-entry-pending': '' } : {}) };
  if (reserve <= 0) return createElement('span', { hidden: true, ...marks });
  return createElement('span', {
    className: 'composer-island-reserve',
    'aria-hidden': true,
    style: { width: `${reserve}px` },
    ...marks,
  });
}

/** Open state of one island tab. Inside the composer island the island owns
 *  it (one open tab at a time); a segment rendered on its own keeps it local. */
export function useComposerIslandTab(tab: Exclude<ComposerIslandTab, ''>): [boolean, (open: boolean) => void] {
  const island = useContext(ComposerIslandContext);
  const [localOpen, setLocalOpen] = useState(false);
  if (!island) return [localOpen, setLocalOpen];
  return [
    island.expanded === tab,
    (open) => {
      if (open) island.setExpanded(tab);
      // Against the current tab, not this render's: a close that lands after
      // another tab opened (an unmounting segment) leaves that tab open.
      else island.setExpanded((current) => (current === tab ? '' : current));
    },
  ];
}

/** Portal target for the queued follow-up tray: the dock owns where the tray
 *  sits (attached to the composer's top edge, under the island). */
export const ComposerQueueTrayContext = createContext<HTMLElement | null>(null);
