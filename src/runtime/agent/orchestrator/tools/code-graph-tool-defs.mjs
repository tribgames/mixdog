export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Source-file structure and relations from the parsed code graph, no text matching. Prefer it over read/grep whenever the question is about declarations or relations rather than literal text. A file’s API or shape (exported functions, classes, methods, signatures) → symbols: rows are `[export ]kind name (Lstart-end)  signature`, members indented under their container, so one call answers "what does this file export / what methods does X have" without reading the file. Who calls X / what X calls → callers/callees (exact call sites from the AST, never text false positives). Who imports a file / what its change touches → dependents/impact. Where X is declared and used → find_symbol/references. Exact identifiers: find_symbol/references/callers/callees; keywords: symbol_search/search; literal text and regex belong to grep. find_symbol returns declaration/body; references adds usages (body opt-in); callers/callees return locations.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'symbol_search', 'search', 'references', 'callers', 'callees'], description: 'File modes: overview, imports, dependents, related, impact. symbols with files[] gives a direct file outline (declarations/lines): one unified kind vocabulary for every language, signature and export marker per row, members indented under their container; other modes use symbols[].' },
        files: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Paths, project-relative or absolute; required for file modes, symbol queries span all files.' },
        symbols: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Exact identifiers/keywords; required for symbol modes, optional outline filter. Every symbol searches every file; distinct pairs need separate calls.' },
        body: { type: 'boolean', description: 'true for implementation, false for locations; find_symbol defaults true, references is opt-in.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max results; modes may cap lower.' },
        depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Overview hierarchy or caller traversal depth; default 1.' },
        cwd: { type: 'string', description: 'Explicit root outside the project; omit for project root.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
  },
];
