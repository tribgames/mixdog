// Cycle LLM dispatch adapters, extracted from index.mjs (pass 3).
//
// Each cycleN scheduler/handler routes its LLM work through an in-process
// makeAgentDispatch() adapter (the memory daemon runs the provider registry
// locally, so the dead IPC agent path is never used). The factory built per
// cycle is fixed (role/taskType), so it is memoized in a single-slot closure
// and reshaped to the cycle call signature:
//   callLlm({ role, taskType, mode, preset, timeout, cwd }, userMessage) -> string
// while makeAgentDispatch's function takes a single { prompt } object. The
// adapter maps the two — preset/cwd resolution is handled inside
// makeAgentDispatch via role.
//
// Pure factory: index.mjs injects makeAgentDispatch. No import-time side
// effects, no db/config coupling.
export function createCycleLlmAdapters({ makeAgentDispatch }) {
  function buildAdapter(agent) {
    let dispatch = null
    return async (opts = {}, userMessage) => {
      if (!dispatch) {
        dispatch = makeAgentDispatch({
          agent,
          taskType: 'maintenance',
          sourceType: 'memory-cycle',
          // The cycle agents parse the full raw line-format response; the
          // agent brief cap (12KB) would truncate a large valid response and
          // append prose, causing partial parsing / omitted / invalid chunks.
          // Opt out so the no-truncation contract is preserved.
          brief: false,
        })
      }
      // Preserve the cycle timeout contract: the caller derives opts.timeout
      // from config / caller deadline and expects it to bound the call.
      // makeAgentDispatch takes it as a per-call idleTimeoutMs (stale
      // watchdog). Map it through; omit when absent/0 so agent defaults apply.
      const callTimeout = Number(opts?.timeout)
      return dispatch({
        prompt: String(userMessage ?? ''),
        preset: opts?.preset || undefined,
        ...(Number.isFinite(callTimeout) && callTimeout > 0 ? { idleTimeoutMs: callTimeout } : {}),
      })
    }
  }

  // Callers (cycle-scheduler `callLlm: getCycle1CallLlm()`, index.mjs bench)
  // treat these as FACTORIES: call once to obtain the callLlm adapter.
  // Returning the adapter directly here made `getCycle1CallLlm()` execute an
  // LLM dispatch with no arguments — empty prompt → agent-dispatch throw →
  // unhandled rejection that killed the memory daemon. Keep the factory
  // contract: each getter returns the (memoized) adapter function.
  const cycle1 = buildAdapter('cycle1-agent')
  const cycle2 = buildAdapter('cycle2-agent')
  const cycle3 = buildAdapter('cycle3-agent')
  return {
    getCycle1CallLlm: () => cycle1,
    getCycle2CallLlm: () => cycle2,
    getCycle3CallLlm: () => cycle3,
  }
}
