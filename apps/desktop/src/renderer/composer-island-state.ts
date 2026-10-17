import { createContext, type Dispatch, type SetStateAction, useContext, useState } from 'react';

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
} | null>(null);

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
