'use strict';

/**
 * Shared text-cleaning utilities. Used by both:
 *   - hooks/session-start.cjs (CJS hook)
 *   - src/memory/lib/memory-extraction.mjs (ESM, via createRequire re-export)
 *
 * Single source of truth for the regex set that strips:
 *   - markdown fences, headers, list markers, bold
 *   - tool/system tags emitted by Claude Code (system-reminder, tool-use-id,
 *     local-command-*, etc.)
 *   - mixdog tags (channel, schedule-context, teammate-message)
 *   - URLs, emoji, "Ran X", "Process exited", and other transcript noise
 */

function cleanMemoryText(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<memory-context>[\s\S]*?<\/memory-context>/gi, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, '')
    .replace(/<tool-use-id>[\s\S]*?<\/tool-use-id>/gi, '')
    .replace(/<output-file>[\s\S]*?<\/output-file>/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<schedule-context>[\s\S]*?<\/schedule-context>/gi, '')
    .replace(/<teammate-message[\s\S]*?<\/teammate-message>/gi, '')
    .replace(/<channel[^>]*>\n?([\s\S]*?)\n?<\/channel>/g, '$1')
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^This session is being continued from a previous conversation[\s\S]*?(?=\n\n|$)/gim, '')
    .replace(/^\[[^\]\n]{1,140}\]\s*$/gm, '')
    .replace(/^\s*●\s.*$/gm, '')
    .replace(/^\s*Ran .*$/gm, '')
    // stable best-effort sanitization, do not extend without justification
    .replace(/^\s*Command: .*$/gm, '')
    .replace(/^\s*Process exited .*$/gm, '')
    .replace(/^\s*Full transcript available at: .*$/gm, '')
    .replace(/^\s*Read the output file to retrieve the result: .*$/gm, '')
    .replace(/^\s*Original token count: .*$/gm, '')
    .replace(/^\s*Wall time: .*$/gm, '')
    .replace(/^\s*Chunk ID: .*$/gm, '')
    .replace(/^\s*tool_uses: .*$/gm, '')
    .replace(/^\s*menu item .*$/gm, '')
    .replace(/<\/?[a-z][-a-z]*(?:\s[^>]*)?\/?>/gi, '')
    .replace(/[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\s+|\s+$/gm, '')
    .trim();
}

module.exports = { cleanMemoryText };
