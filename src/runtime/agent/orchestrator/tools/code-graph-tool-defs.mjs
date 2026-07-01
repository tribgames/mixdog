export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Repo-local code structure lookup, not web: symbol_search/find_symbol/references/calls/deps before grep. Batch symbols[].',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees', 'prewarm'], description: 'Repo-local operation; structure before text search.' },
        file: { type: 'string', description: 'Known source file.' },
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
