export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
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

export const APPLY_PATCH_FREEFORM_DESCRIPTION = 'Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.';

export const PATCH_TOOL_DEFS = [
  {
    name: 'apply_patch',
    title: 'Mixdog Apply Patch',
    annotations: { title: 'Mixdog Apply Patch', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Apply known file edits in one atomic patch; sections run in listed order and all touched paths roll back if any section fails. Do not split a dependent edit across turns.',
    freeformDescription: APPLY_PATCH_FREEFORM_DESCRIPTION,
    freeform: {
      type: 'grammar',
      syntax: 'lark',
      definition: APPLY_PATCH_LARK_GRAMMAR,
    },
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Patch text. V4A preferred; use one file block per target file with exact current context; include all known edits in listed order. On failure, the tool rolls all earlier writes back.' },
        format: { type: 'string', enum: ['unified', 'v4a'], description: 'Auto-detected.' },
        base_path: { type: 'string', description: 'Repo root.' },
        dry_run: { type: 'boolean', description: 'Default false. true = validate only, no write.' },
        fuzzy: { type: 'boolean', description: 'Default true. Allows limited context fuzz.' },
        reject_partial: { type: 'boolean', description: 'Default true. false allows V4A hunk-level rejects.' },
      },
      required: ['patch'],
    },
  },
];
