// The canonical TOOL_DEFS for the memory module. `public: false` entries are
// reachable through the in-process dispatcher (Pool C executors, synthetic
// tool registrations) but are not advertised via ListTools / tools.json, so
// they never reach an external LLM. `aiWrapped: true` routes dispatches
// through ai-wrapped-dispatch.mjs instead of the module's handleToolCall.
export const TOOL_DEFS = [
  {
    name: 'memory',
    title: 'Memory Cycle',
    annotations: { title: 'Memory Cycle', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Persistent memory operations. Requires action (status|core|manage|prune|rebuild|...). For core: op (add/edit/delete/list) + category + summary + project_id. To retrieve, use the recall tool.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['core','manage','status','sleep','cycle1','cycle2','cycle3','flush','backfill','prune','rebuild','purge','retro_eval_active'] },
        op: { type: 'string', enum: ['add','edit','delete','list'] },
        id: { type: 'number' },
        element: { type: 'string' },
        summary: { type: 'string' },
        category: { type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] },
        status: { type: 'string', enum: ['pending','active','archived'] },
        maxDays: { type: 'number' },
        window: { type: 'string' },
        limit: { type: 'number' },
        concurrency: { type: 'number' },
        confirm: { type: 'string' },
        cycle3Mode: { type: 'string', enum: ['proposal','conservative'] },
        project_id: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'recall',
    title: 'Recall',
    annotations: { title: 'Recall', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Retrieve stored memory (past decisions, prior work, session history). Use when the user references earlier work, when resuming a paused task, or before re-proposing something possibly already decided. query (string|array fan-out) and/or id; category/period/projectScope filters. Read-only and cheap — when in doubt, recall first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
        id: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' }, minItems: 1 }], description: 'Only use exact #ids from a prior recall result. Do not invent ids, and do not combine id with query.' },
        period: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' },
        sort: { type: 'string', enum: ['importance', 'date'] },
        category: { anyOf: [{ type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] }, { type: 'array', items: { type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] }, minItems: 1 }] },
        includeArchived: { type: 'boolean' },
        projectScope: { type: 'string' },
        cwd: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_memories',
    title: 'Search Memories',
    public: false,
    annotations: { title: 'Search Memories', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Search past context and memory. Returns root entries by default. Use when user references prior work, decisions, or preferences. Storage is automatic — only retrieval is manual.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text. Triggers hybrid search (vector KNN + full-text BM25).' },
        period: { type: 'string', description: 'Time scope: "last" (before this session), "24h"/"3d"/"7d"/"30d" (relative), "all", "2026-04-05" (single day), "2026-04-01~2026-04-05" (range). Default: 30d when query set, latest entries otherwise.' },
        sort: { type: 'string', enum: ['date', 'importance'], description: 'date (newest first) or importance (score desc).' },
        category: { anyOf: [{ type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] }, { type: 'array', items: { type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] }, minItems: 1 }], description: 'Optional category filter for timeline/category recall.' },
        limit: { type: 'number', default: 30 },
        offset: { type: 'number', default: 0 },
        includeMembers: { type: 'boolean', description: 'Include chunk member entries inline.' },
        includeRaw: { type: 'boolean', description: 'When true, fetch unclassified raw rows in the requested period window and merge into results. Caller-driven only — no auto-trigger.' },
        includeArchived: { type: 'boolean', description: 'Default true for historical recall. Set false to restrict to live/pending roots.' },
        projectScope: { type: 'string', description: 'Project pool selector. Omitted = infer from cwd, or `common` if unknown. Use `all` only when intentionally searching every project.' },
        cwd: { type: 'string', description: 'Optional workspace path, used only when `projectScope` is not set.' },
      },
      required: [],
    },
  },
]
