import { capLineOrientedToolOutput, RECALL_OUTPUT_MAX_BYTES } from '../../agent/orchestrator/tools/builtin/tool-output-limit.mjs'

// Byte cap for recall's model-facing text. Line-oriented: complete leading
// rows are preserved and the omitted tail becomes a factual continuation
// footer, so a huge multi-query/grouped browse cannot flood the caller's
// context (42KB single-call observed before the cap).
function capRecallText(text) {
  return capLineOrientedToolOutput(
    text,
    RECALL_OUTPUT_MAX_BYTES,
    (kept, lines) => `... [recall output capped at ${Math.round(RECALL_OUTPUT_MAX_BYTES / 1024)}KB after ${kept.length} of ${lines.length} lines; narrow query[]/category/period or page with limit/offset for the rest]`,
  )
}

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
        const cappedText = capRecallText(result.text)
        return { ...result, text: cappedText, content: [{ type: 'text', text: cappedText }], isError: result.isError || false }
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
