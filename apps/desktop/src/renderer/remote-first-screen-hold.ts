interface HoldWindow extends EventTarget {
  __mixdogStartupSettled?: boolean;
}
interface HoldDocument extends EventTarget {
  readonly visibilityState: string;
}

/** The hold on the page's first peer's direct-path offer. It settles when the page shows its first usable screen (startup restore
 *  settled), or at once when the page is or becomes hidden: a hidden page paints nothing, and the PC's negotiation window runs out
 *  while its timers are throttled. Only the first call of a page load gets a hold; a reconnect's peer is never held. */
export function createFirstScreenHold(
  win: HoldWindow = window as unknown as HoldWindow,
  doc: HoldDocument = document
): () => Promise<void> | undefined {
  let given = false;
  return () => {
    if (given) return undefined;
    given = true;
    return new Promise<void>((resolve) => {
      if (win.__mixdogStartupSettled || doc.visibilityState === 'hidden') {
        resolve();
        return;
      }
      const settle = (): void => {
        win.removeEventListener('mixdog:startup-settled', settle);
        doc.removeEventListener('visibilitychange', onVisibility);
        resolve();
      };
      const onVisibility = (): void => {
        if (doc.visibilityState === 'hidden') settle();
      };
      win.addEventListener('mixdog:startup-settled', settle);
      doc.addEventListener('visibilitychange', onVisibility);
    });
  };
}
