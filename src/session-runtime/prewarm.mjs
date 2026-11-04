// Background prewarm/start schedulers.
// Dependency-injected factory: timer handles live
// in a caller-owned `timers` object (so the facade's clearTimeout teardown
// still sees them) and all state reads go through supplied accessors.
// prewarm/: code-graph-prewarm, tool-runtime-warmup (shell + search servers),
// channel-start (worker boot + automation autostart).
// A prewarm that finds the runtime busy parks (warmup/timer-arm) and runs when
// the runtime wakes the parked jobs, never on a retry timer.
import { createCodeGraphPrewarm } from './prewarm/code-graph-prewarm.mjs';
import { createToolRuntimeWarmup } from './prewarm/tool-runtime-warmup.mjs';
import { createChannelStart } from './prewarm/channel-start.mjs';
import { createWarmupTimers } from './warmup/timer-arm.mjs';

export function createPrewarmSchedulers(deps) {
  const { park, wake } = createWarmupTimers(deps);
  const ctx = { ...deps, park };
  const { scheduleCodeGraphPrewarm } = createCodeGraphPrewarm(ctx);
  const { scheduleToolRuntimeWarmup, scheduleSearchRuntimeWarmup } = createToolRuntimeWarmup(ctx);
  const { invokeChannelStart, scheduleChannelStart, scheduleAutomationAutostart } = createChannelStart(ctx);

  return {
    scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup,
    invokeChannelStart,
    scheduleChannelStart,
    scheduleAutomationAutostart,
    wakeDeferredPrewarms: wake,
  };
}
