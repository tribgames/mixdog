export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Repo code structure/flow over source files. File modes take files[]; symbol modes take symbols[] — exact identifiers via find_symbol/references/callers/callees, keywords via symbol_search/search. Unsupported target arrays are omitted, never mixed.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'], description: 'File modes={overview,imports,dependents,related,impact}; symbols with files[]=file outline; the rest are symbol modes.' },
        files: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Source file path(s); supported targets only.' },
        symbols: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Exact identifiers or keywords; batch multiple in one symbols[].' },
        body: { type: 'boolean', description: 'Include body.' },
        limit: { type: 'number', minimum: 1, description: 'Max results.' },
        depth: { type: 'number', minimum: 1, maximum: 5, description: 'Caller depth.' },
        page: { type: 'number', minimum: 1, description: 'Caller page.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
];
