// A virtual clock for page tests that measure frame-by-frame behaviour: the page's `performance.now`, `Date.now`, timers and
// `requestAnimationFrame` run on a clock that only the pump advances, and the pump only advances it once the page has nothing else to do
// (its microtasks and message-channel tasks, one real rendering frame for the observers). Machine load changes how long a step takes, never
// what a step sees. CSS animations are paused and stepped on the same clock. Install it before the bundle under test:
//   await page.evaluate(VIRTUAL_CLOCK);
// Page code then waits with plain `setTimeout`/`requestAnimationFrame`; time passes while it waits.
export const VIRTUAL_CLOCK = `
  (() => {
    const real = {
      raf: window.requestAnimationFrame.bind(window),
      setTimeout: window.setTimeout.bind(window),
    };
    const FRAME_MS = 1000 / 60;
    const EPOCH = Date.now();
    let now = 1000;
    let order = 0;
    let ids = 0;
    const timers = new Map();
    let frameCallbacks = new Map();
    let wake = null;
    const poke = () => {
      if (wake) {
        const resume = wake;
        wake = null;
        resume();
      }
    };

    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    Date.now = () => EPOCH + Math.floor(now);
    window.setTimeout = (callback, delay = 0, ...args) => {
      const id = ++ids;
      timers.set(id, { at: now + Math.max(0, Number(delay) || 0), order: ++order, callback, args, every: null });
      poke();
      return id;
    };
    window.setInterval = (callback, delay = 0, ...args) => {
      const id = ++ids;
      const every = Math.max(1, Number(delay) || 0);
      timers.set(id, { at: now + every, order: ++order, callback, args, every });
      poke();
      return id;
    };
    window.clearTimeout = window.clearInterval = (id) => void timers.delete(id);
    window.requestAnimationFrame = (callback) => {
      const id = ++ids;
      frameCallbacks.set(id, callback);
      poke();
      return id;
    };
    window.cancelAnimationFrame = (id) => void frameCallbacks.delete(id);

    // A paused animation is set to the virtual time since it was first seen; a finished one is finished, so its end events fire.
    const started = new WeakMap();
    const stepAnimations = () => {
      for (const animation of document.getAnimations()) {
        if (!started.has(animation)) {
          animation.pause();
          started.set(animation, now - (Number(animation.currentTime) || 0));
        }
        const elapsed = now - started.get(animation);
        const end = animation.effect?.getComputedTiming().endTime;
        if (Number.isFinite(end) && elapsed >= end) animation.finish();
        else animation.currentTime = elapsed;
      }
    };

    // Frames go on while an animation still runs, so it is first seen (and so started) at the virtual time it began, not when a script next asks.
    const animating = () =>
      document.getAnimations().some((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime) && animation.playState !== 'finished');

    const channelTask = () =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(0);
      });
    const settle = async () => {
      for (let turn = 0; turn < 3; turn += 1) {
        await Promise.resolve();
        await channelTask();
      }
    };
    const dueTimer = () => {
      let best = null;
      for (const [id, timer] of timers) {
        if (!best || timer.at < best.timer.at || (timer.at === best.timer.at && timer.order < best.timer.order)) best = { id, timer };
      }
      return best;
    };
    const nextFrameAt = () => (Math.floor(now / FRAME_MS + 1e-9) + 1) * FRAME_MS;

    (async () => {
      for (;;) {
        await settle();
        const timer = dueTimer();
        const frameAt = frameCallbacks.size || animating() ? nextFrameAt() : Infinity;
        if (!timer && frameAt === Infinity) {
          await new Promise((resolve) => (wake = resolve));
          continue;
        }
        if (timer && timer.timer.at <= frameAt) {
          now = Math.max(now, timer.timer.at);
          const { callback, args, every } = timer.timer;
          if (every === null) timers.delete(timer.id);
          else {
            timer.timer.at = now + every;
            timer.timer.order = ++order;
          }
          try {
            callback(...args);
          } catch (error) {
            real.setTimeout(() => {
              throw error;
            });
          }
          continue;
        }
        now = frameAt;
        stepAnimations();
        const callbacks = [...frameCallbacks.values()];
        frameCallbacks = new Map();
        for (const callback of callbacks) {
          try {
            callback(now);
          } catch (error) {
            real.setTimeout(() => {
              throw error;
            });
          }
        }
        // Observers (resize, intersection) are delivered after a real rendering frame's callbacks: let two real frames pass before the next virtual step.
        // A page that is not on screen gets no frames: the timeout keeps the clock going (its observers then do not fire).
        await new Promise((resolve) => {
          real.raf(() => real.raf(() => resolve()));
          real.setTimeout(resolve, 250);
        });
      }
    })();
  })();
`;
