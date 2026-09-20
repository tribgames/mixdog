// Background prewarm/start schedulers.
// Dependency-injected factory: timer handles live
// in a caller-owned `timers` object (so the facade's clearTimeout teardown
// still sees them) and all state reads go through supplied accessors.
// prewarm/: code-graph-prewarm, tool-runtime-warmup (shell + search servers),
// channel-start (worker boot + automation autostart).
import { createCodeGraphPrewarm } from './prewarm/code-graph-prewarm.mjs';
import { createToolRuntimeWarmup } from './prewarm/tool-runtime-warmup.mjs';
import { createChannelStart } from './prewarm/channel-start.mjs';

export function createPrewarmSchedulers(deps) {
  const { scheduleCodeGraphPrewarm } = createCodeGraphPrewarm(deps);
  const { scheduleToolRuntimeWarmup, scheduleSearchRuntimeWarmup } = createToolRuntimeWarmup(deps);
  const { invokeChannelStart, scheduleChannelStart, scheduleAutomationAutostart } = createChannelStart(deps);

  return {
    scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup,
    invokeChannelStart,
    scheduleChannelStart,
    scheduleAutomationAutostart,
  };
}
