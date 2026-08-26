// Idle memory reclaim (main half); renderer/idle-reclaim.ts owns the cache
// registry this event drives.
//
// Diagnostics from a normal working day: the renderer sat at ~330 MB while
// idle, rose to 1.0–1.2 GB across a few sessions, and stayed there. The heap
// was reclaimable — the same log shows unforced drops of 500 MB once the host
// came under pressure — but nothing asks for it back while RAM is plentiful.
// Chromium already owns the right primitive for a backgrounded tab; this arms
// it deliberately, and only when the user cannot notice: window unfocused, no
// turn streaming, and one release per quiet stretch.
import type { SessionSnapshot } from '../shared/contract';
import { turnInProgress } from './turn-attention';

export const IDLE_RECLAIM_EVENT = 'mixdog:idle-reclaim';
export const IDLE_RECLAIM_DELAY_MS = 5 * 60_000;

export interface IdleReclaimHooks {
  isFocused(): boolean;
  reclaim(): void | Promise<void>;
  delayMs?: number;
}

export interface IdleReclaim {
  onFocus(): void;
  onBlur(): void;
  onSnapshot(snapshot: SessionSnapshot): void;
  dispose(): void;
}

export function createIdleReclaim(hooks: IdleReclaimHooks): IdleReclaim {
  const delayMs = hooks.delayMs ?? IDLE_RECLAIM_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  let released = false;
  let disposed = false;

  const cancel = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };
  // A destroyed or unreadable window counts as focused: the reclaim is an
  // optimization, and skipping it is always the safe answer.
  const focused = () => {
    try { return hooks.isFocused(); } catch { return true; }
  };
  const arm = () => {
    if (disposed || released || busy || timer || focused()) return;
    timer = setTimeout(() => {
      timer = null;
      if (disposed || busy || focused()) return;
      released = true;
      void Promise.resolve(hooks.reclaim()).catch(() => { /* best effort */ });
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
    onBlur() { arm(); },
    onSnapshot(snapshot) {
      const next = turnInProgress(snapshot);
      if (next === busy) return;
      busy = next;
      if (busy) {
        // A running turn allocates again, so a later quiet stretch is worth
        // another release even if this background window already had one.
        released = false;
        cancel();
      } else arm();
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}

/** The subset of Electron's WebContents this module drives. */
export interface IdleReclaimTarget {
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
  debugger: {
    isAttached(): boolean;
    attach(version?: string): void;
    detach(): void;
    sendCommand(method: string): Promise<unknown>;
  };
}

/** Drop the renderer's recomputable caches, then let Chromium shrink the V8
 *  heap the way it does for a backgrounded tab. Both legs are best-effort: an
 *  open DevTools session owns the debugger, and a window on its way out simply
 *  has nothing left to release. */
export async function purgeRendererMemory(contents: IdleReclaimTarget): Promise<void> {
  if (contents.isDestroyed()) return;
  await contents.executeJavaScript(
    `window.dispatchEvent(new Event(${JSON.stringify(IDLE_RECLAIM_EVENT)}));true`,
  ).catch(() => { /* the document is gone or mid-navigation */ });
  if (contents.isDestroyed()) return;
  let attached = false;
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3');
      attached = true;
    }
    await contents.debugger.sendCommand('Memory.forciblyPurgeJavaScriptMemory');
  } catch {
    /* DevTools holds the debugger, or the target went away mid-purge */
  } finally {
    if (attached) {
      try { contents.debugger.detach(); } catch { /* already detached */ }
    }
  }
}
