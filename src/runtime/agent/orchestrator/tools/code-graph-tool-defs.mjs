export const CODE_GRAPH_TOOL_DEFS = [
  {
    name: 'code_graph',
    title: 'Code Graph',
    annotations: { title: 'Code Graph', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false, compressibleLossless: true },
    description: 'Locate a SYMBOL or map a file via the code graph — one call replaces many grep+read turns; reach for it BEFORE grep (grep is for free-text / non-symbol content only). Modes: find_symbol/search (locate); overview/symbols/imports/dependents/related/impact (file-scoped, set file:); callers/callees/references (trace). callers depth:2-5 returns the full transitive caller tree in ONE call (each node carries its call-site file:line) — don\'t re-trace listed nodes; on "# NEXT", re-run with page:N+1.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['overview', 'imports', 'dependents', 'related', 'impact', 'symbols', 'find_symbol', 'search', 'references', 'callers', 'callees', 'prewarm'] },
        file: { type: 'string', description: 'Target file (overview/symbols/imports/dependents/related/impact), or a scope filter on a symbol query.' },
        symbol: { type: 'string', description: 'Target identifier. For mode search, a keyword/substring to match symbol names (file-less).' },
        symbols: { type: 'array', items: { type: 'string' }, description: 'Batch: find_symbol/callers/callees/references/prewarm run once per name in one call.' },
        body: { type: 'boolean', description: 'find_symbol: include the declaration body. DEFAULT true (location + callees + body); false = locate-only. Bodies over 120 lines arrive elided with a "read <path> symbol=<name>" hint.' },
        language: { type: 'string', description: 'Optional language hint (auto-detected from the file extension otherwise).' },
        limit: { type: 'number', description: 'Max results to return.' },
        depth: { type: 'number', description: 'callers only. 1 = direct (default); 2-5 = transitive caller tree in one call, each node tagged with its call-site file:line.' },
        page: { type: 'number', description: 'callers tree (depth>=2) only: 1-based page, 100 nodes/page.' },
        cwd: { type: 'string', description: 'Project root to scope the graph (defaults to the session cwd).' },
      },
      required: ['mode'],
    },
  },
];
