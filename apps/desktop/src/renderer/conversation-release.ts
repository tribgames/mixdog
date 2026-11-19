// "May this conversation be released?" A conversation kept mounted off screen
// (retained) is given back once the window idles, but only when nothing in it
// is unfinished: every part that can hold the user's work registers how it
// tells, and the pane asks the conversation as a whole.
import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react';

export interface ConversationReleaseGate {
  /** Registers a part's answer to "do you hold anything unfinished?"; returns its removal. */
  hold(unfinished: () => boolean): () => void;
  /** No registered part holds anything unfinished. */
  mayRelease(): boolean;
  /** A part's state moved: whoever waits on the gate asks again. */
  changed(): void;
  subscribe(listener: () => void): () => void;
}

export function createConversationReleaseGate(): ConversationReleaseGate {
  const holds = new Set<() => boolean>();
  const listeners = new Set<() => void>();
  const gate: ConversationReleaseGate = {
    hold(unfinished) {
      holds.add(unfinished);
      return () => {
        holds.delete(unfinished);
        gate.changed();
      };
    },
    mayRelease() {
      for (const unfinished of holds) if (unfinished()) return false;
      return true;
    },
    changed() {
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return gate;
}

export const ConversationReleaseContext = createContext<ConversationReleaseGate | null>(null);

/** Answers for this part of the conversation: `unfinished` is read when the
 *  pane asks (refs included), and every commit of the caller re-asks. */
export function useConversationReleaseHold(unfinished: () => boolean): void {
  const gate = useContext(ConversationReleaseContext);
  const latest = useRef(unfinished);
  latest.current = unfinished;
  useLayoutEffect(() => gate?.hold(() => latest.current()), [gate]);
  useEffect(() => {
    gate?.changed();
  });
}
