export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Source-file structure, symbol relations, and flow. File modes use files[]; symbol modes use symbols[]. Exact identifiers use find_symbol/references/callers/callees; keywords use symbol_search/search (symbol-index terms). Omit unsupported target arrays; never mix them.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'], description: 'File modes: overview/imports/dependents/related/impact. symbols with files[] gives a file outline; others are symbol modes.' },
        files: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Project-relative source file path(s).' },
        symbols: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Exact identifiers or keywords (symbol-index terms); batch multiple in one symbols[] call.' },
        body: { type: 'boolean', description: 'Include body.' },
        limit: { type: 'number', minimum: 1, description: 'Max results.' },
        depth: { type: 'number', minimum: 1, maximum: 5, description: 'Caller depth.' },
        cwd: { type: 'string', description: 'Explicit root outside the project; omit for project root.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
];
