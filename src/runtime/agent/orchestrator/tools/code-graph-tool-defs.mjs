export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'FIRST for symbols/structure/location. Use before read/grep for functions/classes/consts/callers/imports. partial->search; exact->find_symbol; batch->symbols. For where/candidate, answer from file:line without read unless body is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'search', 'references', 'callers', 'callees', 'prewarm'] },
        file: { type: 'string', description: 'Target source file; directory scopes references/callers.' },
        symbol: { type: 'string', description: 'Identifier or search keyword.' },
        symbols: { type: 'array', items: { type: 'string' }, description: 'Batch identifiers for find/callers/callees/references/prewarm.' },
        body: { type: 'boolean', description: 'find_symbol body. Default true; false = locate only.' },
        language: { type: 'string', description: 'Optional language hint.' },
        limit: { type: 'number', description: 'Max results to return.' },
        depth: { type: 'number', description: 'callers only: 1 direct, 2-5 transitive.' },
        page: { type: 'number', description: 'callers depth>=2 page.' },
        cwd: { type: 'string', description: 'Project root override.' },
      },
      required: ['mode'],
    },
  },
];
