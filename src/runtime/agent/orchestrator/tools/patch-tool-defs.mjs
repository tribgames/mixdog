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
const APPLY_PATCH_CONTRACT =
  'Use exact, unique context; add a class/function locator if needed. New files and parents are created atomically; existing targets reject creation unchanged. Attempt it directly, without read/list/mkdir. Valid files commit; rejected files are reported separately.';
const APPLY_PATCH_FREEFORM_DESCRIPTION =
  `Send raw V4A here, not JSON or a shell command. One Add/Delete/Update File block per path; group its @@ hunks. Prefix each new-file content line once: literal "hello" becomes "+hello", not "++hello". ${APPLY_PATCH_CONTRACT}`;

const APPLY_PATCH_JSON_DESCRIPTION =
  `Edit files with one complete V4A patch in \`patch\`. Call this tool directly, not as a shell command. One file block per target, with all its hunks. ${APPLY_PATCH_CONTRACT}`;

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
