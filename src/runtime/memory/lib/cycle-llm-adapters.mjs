// Cycle LLM dispatch adapters, extracted from index.mjs (pass 3).
//
// Each cycleN scheduler/handler routes its LLM work through the provider's
// process-singleton agent broker. The memory process owns PG/embeddings only;
// provider/session modules are not duplicated here. The factory fixes the
// cycle role/taskType and reshapes to the cycle call signature:
//   callLlm({ role, taskType, mode, preset, timeout, cwd }, userMessage) -> string
// while callAgentDispatch takes (opts, prompt).
//
// Pure factory: index.mjs injects callAgentDispatch. No import-time side
// effects, no db/config coupling.
export function createCycleLlmAdapters({ callAgentDispatch }) {
  function buildAdapter(agent) {
    return async (opts = {}, userMessage) => {
      return callAgentDispatch({
        ...opts,
        agent,
        taskType: 'maintenance',
      }, String(userMessage ?? ''))
    }
  }

  // Callers (cycle-scheduler `callLlm: getCycle1CallLlm()`, index.mjs bench)
  // treat these as FACTORIES: call once to obtain the callLlm adapter.
  // Returning the adapter directly here made `getCycle1CallLlm()` execute an
  // LLM dispatch with no arguments — empty prompt → agent-dispatch throw →
  // unhandled rejection that killed the memory runtime. Keep the factory
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
