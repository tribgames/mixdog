import type { BrowserWindow } from 'electron';

export const IDLE_RECLAIM_EVENT = 'mixdog:idle-reclaim';
const IDLE_RECLAIM_DELAY_MS = 5 * 60_000;
const IDLE_RECLAIM_POLL_MS = 30_000;

interface IdleReclaimHooks {
  isFocused(): boolean;
  reclaim(): void | Promise<void>;
  delayMs?: number;
  /** Milliseconds since the user last touched the machine's keyboard or mouse.
   *  Covers a window that stayed focused (or never blurred) while the user left. */
  systemIdleMs?(): number;
  pollMs?: number;
}

export interface IdleReclaim {
  onFocus(): void;
  onBlur(): void;
  dispose(): void;
}

export function createIdleReclaim(hooks: IdleReclaimHooks): IdleReclaim {
  const delayMs = hooks.delayMs ?? IDLE_RECLAIM_DELAY_MS;
  const pollMs = hooks.pollMs ?? IDLE_RECLAIM_POLL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let poller: ReturnType<typeof setTimeout> | null = null;
  let released = false;
  let releasedAt = 0;
  let disposed = false;

  const cancel = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };
  const run = () => {
    released = true;
    releasedAt = Date.now();
    void Promise.resolve(hooks.reclaim()).catch(() => {
      /* best effort */
    });
  };
  // Background turns deliberately do not gate or reset this: they kept the
  // idle clock from ever completing while nobody was at the PC. Only the user
  // (focus, input) ends a quiet stretch.
  const poll = () => {
    poller = null;
    if (disposed) return;
    let idleMs = 0;
    try {
      idleMs = hooks.systemIdleMs?.() ?? 0;
    } catch {
      /* unreadable idle time counts as present */
    }
    // Only input newer than the release ends its quiet stretch; a short idle
    // reading alone does not, or a release by the blur timer would be
    // repeated here moments later.
    if (released && idleMs < Date.now() - releasedAt) released = false;
    if (!released && idleMs >= delayMs) run();
    poller = setTimeout(poll, pollMs);
    poller.unref?.();
  };
  if (hooks.systemIdleMs) {
    poller = setTimeout(poll, pollMs);
    poller.unref?.();
  }
  // A destroyed or unreadable window counts as focused: the reclaim is an
  // optimization, and skipping it is always the safe answer.
  const focused = () => {
    try {
      return hooks.isFocused();
    } catch {
      return true;
    }
  };
  const arm = () => {
    if (disposed || released || timer || focused()) return;
    timer = setTimeout(() => {
      timer = null;
      if (disposed || released || focused()) return;
      run();
    }, delayMs);
    timer.unref?.();
  };

  return {
    onFocus() {
      // Touching the window refills what was dropped; the next background
      // stretch earns its own release.
      released = false;
      cancel();
    },
    onBlur() {
      arm();
    },
    dispose() {
      disposed = true;
      cancel();
      if (poller) clearTimeout(poller);
      poller = null;
    },
  };
}

export function attachWindowIdleReclaim(
  window: Pick<BrowserWindow, 'on' | 'once' | 'isDestroyed' | 'isFocused'>,
  hooks: Pick<IdleReclaimHooks, 'reclaim' | 'delayMs' | 'systemIdleMs' | 'pollMs'>
): IdleReclaim {
  const controller = createIdleReclaim({
    ...hooks,
    isFocused: () => window.isDestroyed() || window.isFocused(),
  });
  window.on('focus', controller.onFocus);
  window.on('blur', controller.onBlur);
  window.once('closed', controller.dispose);
  return controller;
}

/** The subset of Electron's WebContents this module drives. */
interface IdleReclaimTarget {
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
}

/** Drops the renderer's recomputable caches. Never use the debugger: CDP Memory.forciblyPurgeJavaScriptMemory
 *  simulates an OomIntervention and crashed the renderer with ACCESS_VIOLATION. */
export async function purgeRendererMemory(contents: IdleReclaimTarget): Promise<void> {
  if (contents.isDestroyed()) return;
  await contents
    .executeJavaScript(`window.dispatchEvent(new Event(${JSON.stringify(IDLE_RECLAIM_EVENT)}));true`)
    .catch(() => {
      /* the document is gone or mid-navigation */
    });
}
