export const PATCH_TOOL_DEFS = [
  {
    name: 'apply_patch',
    title: 'Mixdog Apply Patch',
    annotations: { title: 'Mixdog Apply Patch', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'FIRST-CLASS mutation tool. Short loops: code_graph -> apply_patch for symbols/structure; grep -> apply_patch for literal/config. Prefer V4A. Context must match current bytes; if rejected, re-read the exact target window and rebuild. Multi-file OK; set base_path to repo root.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Patch text. V4A preferred: `*** Begin Patch` envelope; file blocks `*** Update/Add/Delete File: <real path>`; do not repeat the same target file, combine its hunks. Body lines: space=context, -=delete, +=add. Copy exact current context (~3 lines around edit). If context is ambiguous, add `@@ <unique enclosing line above>`. Unified diffs need counted hunk headers.' },
        format: { type: 'string', enum: ['unified', 'v4a'], description: 'Auto-detected. Prefer v4a; unified needs counted @@ headers.' },
        base_path: { type: 'string', description: 'Repo root so a/... paths resolve.' },
        dry_run: { type: 'boolean', description: 'Default false. true = validate only, no write.' },
      },
      required: ['patch'],
    },
  },
];
