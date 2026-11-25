import { createContext, useContext, useMemo, useState } from 'react';

/** How a pane brings the conversation it switches to on screen. The pane keeps showing the conversation it showed
 *  until the one it switches to says it can be shown: that one is laid out behind it meanwhile (`preparing`), with its
 *  rows mounted and its reader put where it was, and takes the pane in the commit it calls `ready`. A conversation
 *  whose rows and sizes were kept is ready in the commit it is put up; one whose rows are read again is ready when
 *  they have landed. No frame shows a pane switched to a conversation that is not. */
export interface PanePresentation {
  readonly preparing: boolean;
  /** Counts the times the conversation was put up to be presented: each is a visit of its own. */
  readonly visit: number;
  /** The conversation shows what its reader is to see. */
  ready(): void;
  /** The conversation's draft sent its first prompt: the session that makes is shown by this conversation, with no
   *  handoff. */
  keep(): void;
  /** A conversation read this: it answers `ready` itself. One that never reads it is shown as soon as it is mounted. */
  heard?: boolean;
}

const SHOWN: PanePresentation = { preparing: false, visit: 0, ready: () => undefined, keep: () => undefined };

/** A conversation outside the panes is shown as it is. */
export const PanePresentationContext = createContext<PanePresentation>(SHOWN);

export function usePanePresentation(): PanePresentation {
  const presentation = useContext(PanePresentationContext);
  presentation.heard = true;
  return presentation;
}

/** The presentation of a conversation outside the panes that is hidden and shown again in place (the side dock's
 *  agent session view): each time it is shown again is a visit of its own, from the commit that shows it. A visit is
 *  prepared, as a pane's switch is, until the conversation calls it `ready`: what it shows meanwhile is its cover. */
export function useShownPresentation(shown: boolean): PanePresentation {
  const [visits, setVisits] = useState({ shown, visit: 0, preparing: true });
  if (visits.shown !== shown) {
    setVisits({ shown, visit: shown ? visits.visit + 1 : visits.visit, preparing: shown || visits.preparing });
  }
  const { visit, preparing } = visits;
  return useMemo(
    () => ({
      preparing,
      visit,
      ready: () =>
        setVisits((current) =>
          current.visit === visit && current.preparing ? { ...current, preparing: false } : current
        ),
      keep: SHOWN.keep,
    }),
    [preparing, visit]
  );
}
