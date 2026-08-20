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

// GPT-family contract: OpenAI Responses receives the raw V4A patch through the
// Lark custom tool. The tiny JSON schema remains only for function-only
// compatibility paths; runtime knobs stay off the model surface.
const APPLY_PATCH_FREEFORM_DESCRIPTION =
  'Edit files with one raw V4A patch; do not wrap it in JSON. Use one Add/Delete/Update File block per target path and multiple @@ hunks within one Update File block. Add File atomically creates the file and missing parent directories, failing without changes if the target already exists. Multi-file patches commit valid files and report rejected files separately.';

const APPLY_PATCH_JSON_DESCRIPTION = 'Edit files with one complete V4A patch in `patch`.';

export const PATCH_TOOL_DEFS = [
  {
    name: 'apply_patch',
    title: 'Apply Patch',
    annotations: { title: 'Apply Patch', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, compressible: false, compressibleLossless: true },
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
        patch: { type: 'string', minLength: 1, description: 'Complete V4A patch text.' },
      },
      required: ['patch'],
      additionalProperties: false,
    },
  },
];
