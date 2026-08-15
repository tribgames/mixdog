export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Source-file structure, symbol relations, and flow. File modes use files[]; symbol modes use symbols[]; symbols may combine both to filter a file outline. Exact identifiers use find_symbol/references/callers/callees; keywords use symbol_search/search. find_symbol returns declaration/body; references returns declaration/usages plus optional body (no grep); callers/callees return locations.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'], description: 'File modes: overview/imports/dependents/related/impact. symbols with files[] gives an optionally keyword-filtered file outline; others are symbol modes.' },
        files: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Project-relative source path(s); non-empty arrays.' },
        symbols: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Exact identifiers or keywords; batch in one symbols[] call; may filter mode:symbols.' },
        body: { type: 'boolean', description: 'Include declaration body: find_symbol defaults true; references is opt-in.' },
        limit: { type: 'integer', minimum: 1, description: 'Max results.' },
        depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Caller/callee traversal depth.' },
        cwd: { type: 'string', description: 'Explicit root outside the project; omit for project root.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
];
