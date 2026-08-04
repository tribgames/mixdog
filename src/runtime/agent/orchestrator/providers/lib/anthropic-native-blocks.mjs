/**
 * anthropic-native-blocks.mjs — single source of truth for Anthropic NATIVE
 * (server-side) tool block types.
 *
 * Anthropic executes these itself and returns BOTH the CALL block
 * (`server_tool_use` / `mcp_tool_use`) and its RESULT block
 * (`web_search_tool_result`, …). They are never dispatched to the agent loop,
 * so they only survive a continuation turn (`stop_reason:'pause_turn'`) when
 * the provider boundary preserves them verbatim, in original block order — a
 * result block is valid ONLY immediately after the call block that produced
 * it. Shared by the SSE parser (streaming) and the non-streaming normalizer.
 */
export const NATIVE_SERVER_TOOL_CALL_BLOCK_TYPES = new Set(['server_tool_use', 'mcp_tool_use']);

export const NATIVE_SERVER_TOOL_RESULT_BLOCK_TYPES = new Set([
    'web_search_tool_result',
    'web_fetch_tool_result',
    'code_execution_tool_result',
    'bash_code_execution_tool_result',
    'text_editor_code_execution_tool_result',
    'mcp_tool_result',
]);

export function isNativeServerToolBlockType(type) {
    return NATIVE_SERVER_TOOL_CALL_BLOCK_TYPES.has(type)
        || NATIVE_SERVER_TOOL_RESULT_BLOCK_TYPES.has(type);
}
