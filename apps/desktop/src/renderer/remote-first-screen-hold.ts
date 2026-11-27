interface HoldWindow extends EventTarget {
  __mixdogShellPainted?: boolean;
}
interface PaintWindow extends HoldWindow {
  requestAnimationFrame(callback: () => void): number;
}
interface HoldDocument extends EventTarget {
  readonly visibilityState: string;
}

const SHELL_PAINTED = 'mixdog:shell-painted';

/** Called once the app's first tree has committed: the second frame callback after the commit runs after the frame that showed it. */
export function announceShellPainted(win: PaintWindow = window as unknown as PaintWindow): void {
  win.requestAnimationFrame(() =>
    win.requestAnimationFrame(() => {
      win.__mixdogShellPainted = true;
      win.dispatchEvent(new Event(SHELL_PAINTED));
    })
  );
}

/** The hold on the page's first peer's direct-path offer. The first `RTCPeerConnection` of a page blocks its main thread for
 *  hundreds of ms, so it waits for the shell's first paint; after it, that cost overlaps the wait for the first screen's data,
 *  which then comes over the direct path instead of the relay. It settles at once when the page is or becomes hidden: a hidden
 *  page paints nothing, and the PC's negotiation window runs out while its timers are throttled. Only the first call of a page
 *  load gets a hold; a reconnect's peer is never held. */
export function createFirstPaintHold(
  win: HoldWindow = window as unknown as HoldWindow,
  doc: HoldDocument = document
): () => Promise<void> | undefined {
  let given = false;
  return () => {
    if (given) return undefined;
    given = true;
    return new Promise<void>((resolve) => {
      if (win.__mixdogShellPainted || doc.visibilityState === 'hidden') {
        resolve();
        return;
      }
      const settle = (): void => {
        win.removeEventListener(SHELL_PAINTED, settle);
        doc.removeEventListener('visibilitychange', onVisibility);
        resolve();
      };
      const onVisibility = (): void => {
        if (doc.visibilityState === 'hidden') settle();
      };
      win.addEventListener(SHELL_PAINTED, settle);
      doc.addEventListener('visibilitychange', onVisibility);
    });
  };
}
