export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Read-only; safe to batch in parallel. Source-file structure, symbol relations, and flow. mode:symbols with files[] is the cheap direct outline of known source files: declarations with line numbers, no file body. Exact identifiers route directly to find_symbol/references/callers/callees; symbol-name keywords use symbol_search/search. Text, literals, and regex belong to grep. File modes use files[]; symbol modes use symbols[]. find_symbol returns declaration/body; references returns declaration/usages plus optional body; callers/callees return locations.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'], description: 'File modes: overview, imports, dependents, related, and impact. symbols with files[] returns an optionally filtered file outline of those exact files. It needs no prior search; remaining modes use symbols[].' },
        files: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Source path(s), project-relative or absolute; required by file modes, optional to scope symbol modes.' },
        symbols: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Exact identifiers or symbol-name keywords; batch in one symbols[] call; required by symbol modes, optional filter for mode:symbols.' },
        body: { type: 'boolean', description: 'Include declaration body: find_symbol defaults true; references is opt-in.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum results; modes may enforce lower caps.' },
        depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Overview hierarchy or caller traversal depth; default 1.' },
        cwd: { type: 'string', description: 'Explicit root outside the project; omit for project root.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
];
