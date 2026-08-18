import { useEffect, useRef } from "react";

interface PageHideTarget {
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
}

export function bindPageHideFlush(
  target: PageHideTarget,
  flush: () => void,
): () => void {
  target.addEventListener("pagehide", flush);
  return () => target.removeEventListener("pagehide", flush);
}

/** Debounced layout writers still commit their latest rendered value when a
 * desktop restart closes the page before the timer fires. */
export function usePageHideFlush(flush: () => void): void {
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => bindPageHideFlush(window, () => flushRef.current()), []);
}
