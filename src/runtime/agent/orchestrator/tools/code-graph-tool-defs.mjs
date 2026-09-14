export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Source-file structure and symbol relations; query only what diff/grep/read did not settle. Exact identifiers: find_symbol/references/callers/callees; keywords: symbol_search/search; text and regex belong to grep. find_symbol returns declaration/body; references adds usages (body opt-in); callers/callees return locations.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'], description: 'File modes: overview, imports, dependents, related, impact. symbols with files[] gives a direct file outline (declarations/lines). Other modes use symbols[].' },
        files: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Source paths, project-relative or absolute. Required for file modes; optional symbol scope.' },
        symbols: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Exact identifiers or keywords. Required for symbol modes; optional symbols+files outline filter.' },
        body: { type: 'boolean', description: 'true for implementation, false for locations. find_symbol defaults true; references is opt-in.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum results; modes may enforce lower caps.' },
        depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Overview hierarchy or caller traversal depth; default 1.' },
        cwd: { type: 'string', description: 'Explicit root outside the project; omit for project root.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
];
