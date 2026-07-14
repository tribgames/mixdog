export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Repo code structure/flow over verified source files only. IDs→graph; literal/zero→grep. Exact identifiers: find_symbol/references/callers/callees; keywords: symbol_search/search. Unsupported target arrays are omitted, never silently mixed. Batch symbols[]/files[] by mode.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'], description: 'File modes={overview,imports,dependents,related,impact}; symbols with files→files[] file outline; symbol modes={find_symbol,symbol_search,search,references,callers,callees}; fileless symbols→symbol_search keywords.' },
        files: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Source file path(s); supported targets only.' },
        symbols: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Exact identifiers (find_symbol/references/callers/callees) or keywords (symbol_search/search); multiple exact symbols use one symbols[] call.' },
        body: { type: 'boolean', description: 'Include body.' },
        limit: { type: 'number', minimum: 1, description: 'Max results.' },
        depth: { type: 'number', minimum: 1, maximum: 5, description: 'Caller depth.' },
        page: { type: 'number', minimum: 1, description: 'Caller page.' },
      },
      required: ['mode'],
    },
  },
];
