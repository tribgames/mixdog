export const PATCH_TOOL_DEFS = [
  {
    name: 'apply_patch',
    title: 'Mixdog Apply Patch',
    annotations: { title: 'Mixdog Apply Patch', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Apply file patches. Prefer V4A with one file block per target file and exact current context around each edit.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Patch text only. V4A preferred: `*** Begin Patch` envelope and `*** Update/Add/Delete File: <path>` blocks. Use one block per target file, combining all hunks for that file. Copy exact current context around edits.' },
        format: { type: 'string', enum: ['unified', 'v4a'], description: 'Auto-detected. Prefer v4a; unified needs counted @@ headers.' },
        base_path: { type: 'string', description: 'Repo root so a/... paths resolve.' },
        dry_run: { type: 'boolean', description: 'Default false. true = validate only, no write.' },
      },
      required: ['patch'],
    },
  },
];
