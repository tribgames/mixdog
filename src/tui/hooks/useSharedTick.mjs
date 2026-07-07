/**
 * hooks/useSharedTick.mjs — one process-wide animation timer for the TUI.
 *
 * The transcript used to fan out timers: Spinner's useAnimation, a 500ms blink
 * + 1s elapsed setInterval PER pending ToolExecution card, and StatusLine's own
 * refresh interval. With N pending cards that is 1 + 2N + 1 OS timers all waking
 * the event loop independently, which showed up in the stutter bench as +369
 * CPU-ms/s and 143ms frame gaps while idle-animated.
 *
 * This collapses every animated component onto a SINGLE shared setInterval.
 * Subscribers register the cadence they want; the shared timer runs at the
 * finest requested interval and only notifies each subscriber once its own
 * interval has elapsed (derived from Date.now()), so a 500ms blink and a 130ms
 * spinner still animate at their own rates off one timer. When the last
 * subscriber unmounts the timer is cleared, so nothing ticks when nothing
 * animated is on screen. Components derive blink phase / elapsed seconds /
 * spinner frame from Date.now() at render — the tick only forces the re-render.
 */
import { useEffect, useRef, useState } from 'react';

// Boundary tolerance: fire a subscriber a hair early rather than skip a whole
// base-interval and drift its cadence by a full frame.
const TICK_SLOP_MS = 16;

const subscribers = new Set();
let timer = null;

// Delay until the soonest subscriber is due (clamped to >= 1ms). A single timer
// is always aimed at the next real boundary, so a subscriber's cadence is tied
// to ITS OWN lastFire + interval — never to a shared base that resets when the
// finest-interval subscriber leaves. Returns null when nothing is subscribed.
function nextDelayMs(now) {
  let soonest = Infinity;
  for (const sub of subscribers) {
    const due = sub.lastFire + sub.interval - now;
    if (due < soonest) soonest = due;
  }
  return Number.isFinite(soonest) ? Math.max(1, soonest) : null;
}

// Aim the single timer at the next due boundary. Called on every subscribe /
// unsubscribe and after each tick, so adding a faster subscriber pulls the next
// wake earlier and removing the finest one re-aims at the remaining subscribers'
// own due times (no full fresh-interval stall). Clears the timer when empty.
function reconcileTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const delay = nextDelayMs(Date.now());
  if (delay == null) return;
  timer = setTimeout(onTick, delay);
  timer.unref?.();
}

function onTick() {
  timer = null;
  const now = Date.now();
  // Snapshot so a subscriber unsubscribing during notify can't mutate the set
  // mid-iteration.
  for (const sub of Array.from(subscribers)) {
    if (!subscribers.has(sub)) continue;
    if (now - sub.lastFire >= sub.interval - TICK_SLOP_MS) {
      sub.lastFire = now;
      sub.notify(now);
    }
  }
  reconcileTimer();
}

/**
 * Subscribe the calling component to the shared tick.
 *
 * @param {number} intervalMs desired re-render cadence in ms.
 * @param {boolean} [isActive=true] unsubscribe (and let the timer stop) when false.
 * @param {(now:number)=>void} [onTick] optional callback fired on each tick
 *   instead of the default internal re-render (e.g. to bump an existing state).
 */
export function useSharedTick(intervalMs, isActive = true, onTick = null) {
  const [, setTick] = useState(0);
  const cbRef = useRef(onTick);
  cbRef.current = onTick;
  useEffect(() => {
    if (!isActive) return undefined;
    const interval = Math.max(1, Number(intervalMs) || 0);
    const sub = {
      interval,
      lastFire: Date.now(),
      notify: (now) => {
        if (cbRef.current) cbRef.current(now);
        else setTick((t) => (t + 1) % 1_000_000);
      },
    };
    subscribers.add(sub);
    reconcileTimer();
    return () => {
      subscribers.delete(sub);
      reconcileTimer();
    };
  }, [intervalMs, isActive]);
}

export default useSharedTick;
