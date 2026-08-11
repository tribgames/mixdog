const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch root_line? hunk+ end_patch
begin_patch: "*** Begin Patch" LF
root_line: "*** Root: " filename LF
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

// Public contract: apply_patch is the PRIMARY edit tool and takes
// a raw freeform V4A patch (no JSON envelope) on providers that support custom
// grammar tools. No prior `read` is required or implied — send the patch as
// soon as the target and content are known. The JSON schema below is only the
// fallback for providers that cannot carry freeform/custom tools, so it exposes
// the patch string and an optional explicit base; runtime-only knobs stay off
// the model surface.
// Batching stays a rules-level policy: every new edit goes in one patch, with
// one file block per target.
const APPLY_PATCH_FREEFORM_DESCRIPTION =
  'OAI V4A patch: *** Begin Patch, Add/Delete/Update File sections, *** End Patch. FREEFORM input; no JSON.';

// JSON-schema fallback providers (Anthropic and other non-grammar surfaces)
// get the full V4A instructions inline: without a grammar the model has
// no format signal beyond this description, and the dominant one-shot failure
// modes (missing section headers, retyped context, marker resubmission) are
// exactly what these rules preempt. The grammar is restated below for the
// JSON `patch` argument.
const APPLY_PATCH_JSON_DESCRIPTION = [
  'Edit files with this V4A patch:',
  '*** Begin Patch',
  '[optional *** Root: <path> for out-of-session writes]',
  '[file sections]',
  '*** End Patch',
  'Each section starts with exactly one: *** Add File: <path> (+ lines), *** Delete File: <path> (header only), or *** Update File: <path> (optional *** Move to: <new path>).',
  'Hunks start with @@ or @@ <symbol|1-based line>; lines start space, -, or +; every Update hunk needs >=1 +/- line; optional *** End of File.',
  'Use 3 verbatim context lines from newest output (post-patch body after edits); avoid overlap; stack @@ only if ambiguous.',
  '+ prefixes every added line. Never send compacted-history markers; re-read first.',
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
        patch: { type: 'string', description: 'OAI V4A patch.' },
        root: { type: 'string', description: 'Explicit patch base directory.' },
      },
      required: ['patch'],
      additionalProperties: false,
    },
  },
];
