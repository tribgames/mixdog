import { screen } from 'electron';

const POINTER_WATCH_MS = 100;
/** DIP of drift that is still the pointer the agent left behind. */
const POINTER_MOVE_TOLERANCE = 2;

export function createHeldPointerWatch(release: (sessionId: string) => void) {
  const held = new Map<string, Electron.Point>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  return {
    hold(thinking: ReadonlySet<string>): void {
      for (const sessionId of [...held.keys()]) if (!thinking.has(sessionId)) held.delete(sessionId);
      for (const sessionId of thinking) {
        if (!held.has(sessionId)) held.set(sessionId, screen.getCursorScreenPoint());
      }
      if (held.size === 0) {
        stop();
        return;
      }
      if (timer) return;
      timer = setInterval(() => {
        const point = screen.getCursorScreenPoint();
        for (const [sessionId, origin] of [...held]) {
          if (Math.abs(point.x - origin.x) + Math.abs(point.y - origin.y) <= POINTER_MOVE_TOLERANCE) continue;
          held.delete(sessionId);
          release(sessionId);
        }
      }, POINTER_WATCH_MS);
      timer.unref?.();
    },
    dispose(): void {
      stop();
      held.clear();
    },
  };
}
