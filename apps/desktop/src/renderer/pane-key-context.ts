import { createContext, useContext } from 'react';

/** The pane (leaf) a surface belongs to: a conversation, with its composer
 *  island, sits in one pane and opens that pane's dock. '' outside a pane. */
export const PaneKeyContext = createContext('');

export function usePaneKey(): string {
  return useContext(PaneKeyContext);
}
