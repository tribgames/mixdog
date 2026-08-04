const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

// Public contract mirrors Codex: apply_patch is the PRIMARY edit tool and takes
// a raw freeform V4A patch (no JSON envelope) on providers that support custom
// grammar tools. No prior `read` is required or implied — send the patch as
// soon as the target and content are known. The JSON schema below is only the
// fallback for providers that cannot carry freeform/custom tools, so it exposes
// the patch string alone; runtime-only knobs stay off the model surface.
// Batching stays a rules-level policy: every new edit goes in one patch, with
// one file block per target.
const APPLY_PATCH_FREEFORM_DESCRIPTION =
  'Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.';

// JSON-schema fallback providers (Anthropic and other non-grammar surfaces)
// get the full Codex V4A instructions inline: without a grammar the model has
// no format signal beyond this description, and the dominant one-shot failure
// modes (missing section headers, retyped context, marker resubmission) are
// exactly what these rules preempt. Mirrors
// refs/codex/codex-rs/prompts/templates/apply_patch_tool_instructions.md,
// adapted to the JSON `patch` argument.
const APPLY_PATCH_JSON_DESCRIPTION = [
  'Edit files with this V4A envelope:',
  '*** Begin Patch',
  '[file sections]',
  '*** End Patch',
  'Every section starts with exactly one header:',
  '- *** Add File: <path> then +content lines.',
  '- *** Delete File: <path> with nothing after it.',
  '- *** Update File: <path>, optionally followed by *** Move to: <new path>.',
  'Update hunks open with @@ or @@ <enclosing class/function>; prefix every line with space (context), - (remove), or + (add); a hunk at end of file may close with *** End of File.',
  'Copy 3 context lines above and below verbatim from the newest tool output of the file (after your own patch, use post-patch content; never retype from memory). Do not duplicate overlapping context; if context is not unique, add enclosing @@ headers.',
  'Use project-relative paths. Every added file line needs +. Never submit a compacted-history marker; re-read and create a fresh patch.',
].join('\n');

export const PATCH_TOOL_DEFS = [
  {
    name: 'apply_patch',
    title: 'Mixdog Apply Patch',
    annotations: { title: 'Mixdog Apply Patch', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: APPLY_PATCH_JSON_DESCRIPTION,
    freeformDescription: APPLY_PATCH_FREEFORM_DESCRIPTION,
    freeform: {
      type: 'grammar',
      syntax: 'lark',
      definition: APPLY_PATCH_LARK_GRAMMAR,
    },
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'The V4A patch text to apply (format and context rules in the tool description).' },
        post_shell: { type: 'string', description: 'Verification command run when the patch applies; skipped on patch failure.' },
      },
      required: ['patch'],
      additionalProperties: false,
    },
  },
];
