export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Repo-local code structure/flow lookup (not web): symbols/references/calls/deps. Known symbols or verified files only. Batch symbols[]/files[].',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers'], description: 'Repo-local graph operation.' },
        files: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Verified source file(s); array fans out per file. `file` alias too.' },
        symbols: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Identifier(s)/keyword(s); array batches in one call. `symbol` alias too. Required for callers/callees/references/find_symbol/symbol_search.' },
        symbol: { type: 'string', description: 'Singular alias for symbols.' },
        file: { type: 'string', description: 'Singular alias for files.' },
        body: { type: 'boolean', description: 'Include body.' },
        language: { type: 'string', description: 'Language hint.' },
        limit: { type: 'number', minimum: 1, description: 'Max results.' },
        depth: { type: 'number', minimum: 1, maximum: 5, description: 'Caller depth.' },
        page: { type: 'number', minimum: 1, description: 'Caller page.' },
      },
      required: ['mode'],
    },
  },
];
