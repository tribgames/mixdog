// Taskbar attention: when the active turn finishes while the
// window is unfocused, flash the taskbar button (Windows/Linux urgency hint)
// or bounce the dock (macOS). Focusing the window clears the signal.
import type { SessionSnapshot } from '../shared/contract';

export interface TurnAttentionHooks {
  isFocused(): boolean;
  flashFrame(flag: boolean): void;
  bounceDock?(): void;
}

export interface TurnAttention {
  onSnapshot(snapshot: SessionSnapshot): void;
  onFocus(): void;
}

export function turnInProgress(snapshot: SessionSnapshot): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const state = snapshot as { busy?: unknown; commandBusy?: unknown };
  return Boolean(state.busy || state.commandBusy);
}

export function createTurnAttention(hooks: TurnAttentionHooks): TurnAttention {
  let wasBusy = false;
  let signaled = false;
  return {
    onSnapshot(snapshot) {
      const busy = turnInProgress(snapshot);
      const finished = wasBusy && !busy;
      wasBusy = busy;
      if (!finished) return;
      let focused = true;
      try {
        focused = hooks.isFocused();
      } catch {
        return;
      }
      if (focused) return;
      signaled = true;
      try {
        hooks.flashFrame(true);
      } catch { /* window is going away */ }
      try {
        hooks.bounceDock?.();
      } catch { /* dock unavailable */ }
    },
    onFocus() {
      if (!signaled) return;
      signaled = false;
      try {
        hooks.flashFrame(false);
      } catch { /* window is going away */ }
    },
  };
}
