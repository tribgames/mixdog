export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Code structure: symbols, refs, calls, imports, impact.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'search', 'references', 'callers', 'callees', 'prewarm'], description: 'Operation.' },
        file: { type: 'string', description: 'Source file.' },
        symbol: { type: 'string', description: 'Identifier or symbol keyword.' },
        symbols: { type: 'array', items: { type: 'string' }, description: 'Batch identifiers.' },
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
