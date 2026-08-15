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

// GPT-family contract: apply_patch takes a raw freeform V4A patch
// (no JSON envelope) on providers that support custom
// grammar tools. No extra fetch once the target body is already obtained —
// send the patch as soon as the target and content are known. The JSON schema below is only the
// fallback for providers that cannot carry freeform/custom tools, so it exposes
// the patch string and an optional explicit base; runtime-only knobs stay off
// the model surface.
// Batching stays a rules-level policy: every new edit goes in one patch, with
// one file block per target.
const APPLY_PATCH_FREEFORM_DESCRIPTION =
  'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.';

// JSON-schema fallback providers get the Codex patch instructions inline:
// without a grammar the model has
// no format signal beyond this description, and the dominant one-shot failure
// modes (missing section headers, retyped context, marker resubmission) are
// exactly what these rules preempt. The grammar is restated below for the
// JSON `patch` argument.
const APPLY_PATCH_JSON_DESCRIPTION = [
  'The `apply_patch` tool can be used to edit files. Pass one complete Codex patch in `patch`; do not JSON-encode it again.',
  'Every patch uses this envelope:',
  '*** Begin Patch',
  '[one or more Add/Delete/Update File sections]',
  '*** End Patch',
  'Use exactly one file operation per target path: *** Add File: <path> (+ lines), *** Delete File: <path>, or *** Update File: <path> (optionally followed by *** Move to: <new path>).',
  'Update hunks start with @@ or @@ <class/function locator>. Every hunk line starts with space, -, or +. Use exact current lines, normally 3 unchanged lines around each change; use the @@ locator when more uniqueness is needed.',
  'Prefix every Add File content line with +. End with *** End Patch. Never send compacted-history markers.',
  'Use exact current lines already in context — never re-open the file to build context or verify a successful patch.',
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
        patch: { type: 'string', description: 'Complete Codex apply_patch text, from *** Begin Patch through *** End Patch.' },
      },
      required: ['patch'],
      additionalProperties: false,
    },
  },
];
