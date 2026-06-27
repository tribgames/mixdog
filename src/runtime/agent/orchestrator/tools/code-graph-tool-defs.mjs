export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Inspect code structure for known files/symbols: definitions, references, callers, callees, imports, impact. Use find/glob for file discovery and grep for exact text.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'search', 'references', 'callers', 'callees', 'prewarm'], description: 'Operation: overview, imports/dependents, symbol search, references, callers/callees, impact, or prewarm.' },
        file: { type: 'string', description: 'Target source file. Directory scope is only for references/callers; omit for repo-wide overview/search.' },
        symbol: { type: 'string', description: 'Identifier or search keyword for symbol/search/reference/call modes.' },
        symbols: { type: 'array', items: { type: 'string' }, description: 'Batch identifiers for find_symbol/callers/callees/references/prewarm.' },
        body: { type: 'boolean', description: 'Return full symbol body for find_symbol. Default true.' },
        language: { type: 'string', description: 'Optional language hint.' },
        limit: { type: 'number', minimum: 1, description: 'Max results to return; clamped per mode.' },
        depth: { type: 'number', minimum: 1, maximum: 5, description: 'callers only: 1 direct, 2-5 transitive.' },
        page: { type: 'number', minimum: 1, description: 'callers depth>=2 page.' },
        cwd: { type: 'string', description: 'Project root override; omit when runtime cwd is already the repo root.' },
      },
      required: ['mode'],
    },
  },
];
