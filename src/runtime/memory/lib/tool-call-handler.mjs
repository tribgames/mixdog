export function createToolCallHandler({ handleSearch, handleMemoryAction }) {
  async function handleToolCall(name, args, signal) {
    try {
      if (name === 'search_memories') {
        const result = await handleSearch(args || {}, signal)
        return { ...result, content: [{ type: 'text', text: result.text }], isError: result.isError || false }
      }
      if (name === 'recall') {
        // recall is aiWrapped in the unified build; in standalone mode map it to
        // search_memories so the advertised tool name actually works. Forward
        // every advertised arg so id/limit/offset/sort/includeArchived/
        // includeMembers/includeRaw reach handleSearch instead of being dropped.
        const a = args || {}
        const hasQuery = Array.isArray(a.query)
          ? a.query.some((value) => String(value || '').trim())
          : String(a.query ?? '').trim() !== ''
        const recallIds = hasQuery
          ? []
          : (Array.isArray(a.id) ? a.id : [a.id])
              .map((value) => Number(value))
              .filter((value) => Number.isInteger(value) && value > 0)
        const searchArgs = {
          ...(a.query !== undefined ? { query: a.query } : {}),
          ...(recallIds.length > 0 ? { ids: recallIds } : {}),
          ...(a.period ? { period: a.period } : {}),
          ...(a.limit !== undefined ? { limit: a.limit } : {}),
          ...(a.offset !== undefined ? { offset: a.offset } : {}),
          ...(a.sort !== undefined ? { sort: a.sort } : {}),
          ...(a.category !== undefined ? { category: a.category } : {}),
          ...(a.includeArchived !== undefined ? { includeArchived: a.includeArchived } : {}),
          ...(a.includeMembers !== undefined ? { includeMembers: a.includeMembers } : {}),
          ...(a.includeRaw !== undefined ? { includeRaw: a.includeRaw } : {}),
          ...(a.cwd ? { cwd: a.cwd } : {}),
          ...(a.projectScope ? { projectScope: a.projectScope } : {}),
          ...(a.sessionId ? { sessionId: a.sessionId } : {}),
          ...(a.session_id ? { session_id: a.session_id } : {}),
          ...(a.currentSession !== undefined ? { currentSession: a.currentSession } : {}),
          // Hint only — never a filter. Marks the caller's own session as
          // "(current)" in the multi-session grouped browse output.
          ...(a.currentSessionId ? { currentSessionId: a.currentSessionId } : {}),
        }
        const result = await handleSearch(searchArgs, signal)
        return { ...result, content: [{ type: 'text', text: result.text }], isError: result.isError || false }
      }
      if (name === 'memory') {
        const result = await handleMemoryAction(args || {}, signal)
        return { ...result, content: [{ type: 'text', text: result.text }], isError: result.isError || false }
      }
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `${name} failed: ${msg}` }], isError: true }
    }
  }

  return handleToolCall
}
