export const PATCH_TOOL_DEFS = [
  {
    name: 'apply_patch',
    title: 'Mixdog Apply Patch',
    annotations: { title: 'Mixdog Apply Patch', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Apply patches. Prefer V4A: one file block per target file, exact current context.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Patch text. V4A preferred: `*** Begin Patch`; one file block per target file; exact current context.' },
        format: { type: 'string', enum: ['unified', 'v4a'], description: 'Auto-detected.' },
        base_path: { type: 'string', description: 'Repo root.' },
        dry_run: { type: 'boolean', description: 'Default false. true = validate only, no write.' },
      },
      required: ['patch'],
    },
  },
];
