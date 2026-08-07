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
// the patch string alone; runtime-only knobs stay off the model surface.
// Batching stays a rules-level policy: every new edit goes in one patch, with
// one file block per target.
const APPLY_PATCH_FREEFORM_DESCRIPTION =
  'Edit files with `apply_patch`. FREEFORM input; do not wrap the patch in JSON.';

// JSON-schema fallback providers (Anthropic and other non-grammar surfaces)
// get the full V4A instructions inline: without a grammar the model has
// no format signal beyond this description, and the dominant one-shot failure
// modes (missing section headers, retyped context, marker resubmission) are
// exactly what these rules preempt. The grammar is restated below for the
// JSON `patch` argument.
const APPLY_PATCH_JSON_DESCRIPTION = [
  'Edit files with this V4A envelope:',
  '*** Begin Patch',
  '[file sections]',
  '*** End Patch',
  'Every section starts with exactly one header: *** Add File: <path> (+content lines), *** Delete File: <path> (nothing after), *** Update File: <path> (optional *** Move to: <new path>).',
  'Hunks open with @@ or @@ <symbol>; prefix lines with space, -, or +; an end-of-file hunk may close with *** End of File.',
  'Copy 3 context lines above/below verbatim from the newest tool output — after your own patch use its post-patch body, never memory. No duplicate overlapping context; if still ambiguous, stack @@ headers: @@ class Foo then @@ def bar.',
  'Project-relative paths; every added line needs +. Never submit a compacted-history marker — re-read and send a fresh patch.',
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
        patch: { type: 'string', description: 'V4A patch text to apply; rules above.' },
        root: {
          type: 'string',
          description: 'Write root; required only for targets outside the session directory.',
        },
      },
      required: ['patch'],
      additionalProperties: false,
    },
  },
];
