export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Repo-local code structure/flow lookup, not web: symbols/references/calls/deps before text grep. Multiple targets = ONE call with symbols[]/files[], never parallel single-target calls.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees', 'prewarm'], description: 'Repo-local operation; code flow before text search.' },
        file: { type: 'string', description: 'Known source file. For 2+ files use files[] instead.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Preferred for 2+ files: one call fans out per file (imports/dependents/related/impact/symbols/overview). Do not issue parallel single-file calls.' },
        symbol: { type: 'string', description: 'Identifier/keyword; one anchor is enough.' },
        symbols: { type: 'array', items: { type: 'string' }, description: 'Batch identifiers in one call.' },
        body: { type: 'boolean', description: 'Include body.' },
        language: { type: 'string', description: 'Language hint.' },
        limit: { type: 'number', minimum: 1, description: 'Max results.' },
        depth: { type: 'number', minimum: 1, maximum: 5, description: 'Caller depth.' },
        page: { type: 'number', minimum: 1, description: 'Caller page.' },
        cwd: { type: 'string', description: 'Project root.' },
      },
      required: ['mode'],
    },
  },
];
