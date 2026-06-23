export const PATCH_TOOL_DEFS = [
  {
    name: 'apply_patch',
    title: 'Mixdog Apply Patch',
    annotations: { title: 'Mixdog Apply Patch', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'The default editor for existing files (prefer over write/edit for non-trivial changes). Hunk context lines must match the CURRENT file bytes EXACTLY (indentation included) — read the target region first, since stale/guessed context is the top cause of "context not found". Multi-hunk/multi-file; prefer V4A; set base_path to the repo root. See the patch field for hunk syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Patch text; match `format`. V4A (preferred): `*** Begin Patch`…`*** End Patch`; per file `*** Update/Add/Delete File: <real path>` (no `a/`·`b/`); body lines ` `=context, `-`=del, `+`=add. Include ~3 UNCHANGED context lines above AND below each change, copied verbatim from the current file (indentation included). If 3 lines do not uniquely locate the snippet, add `@@ <enclosing class/function>` above it; stack multiple `@@` if still ambiguous. A `@@ <ctx>` anchor must quote a UNIQUE line ABOVE the context block — not a line in the hunk body, never below the edit (→ "context not found"). For JSON/config (no classes/functions), prefer extra context lines or anchor on the enclosing key. No line counts. Unified: counted `@@ -A,B +C,D @@` headers required (bare `@@` rejected); `a/`·`b/` prefixes stripped on apply.' },
        format: { type: 'string', enum: ['unified', 'v4a'], description: 'Auto-detected if omitted. Prefer v4a (`*** Begin Patch` envelope, `@@ <ctx>` anchors, no line counts); unified needs counted `@@ -A,B +C,D @@` headers.' },
        base_path: { type: 'string', description: 'Repo root so a/... paths resolve.' },
        dry_run: { type: 'boolean', description: 'Default false. true = validate only, no write.' },
        reject_partial: { type: 'boolean', description: 'Default true (all-or-nothing). false = apply landed hunks, skip failures.' },
        fuzzy: { type: 'boolean', description: 'Default true: tolerate minor context drift; false = exact match.' },
      },
      required: ['patch'],
    },
  },
];
