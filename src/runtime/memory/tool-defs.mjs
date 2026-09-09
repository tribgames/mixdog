// The canonical TOOL_DEFS for the memory module. `public: false` entries are
// reachable through the in-process dispatcher (Pool C executors, synthetic
// tool registrations) but are not advertised via ListTools / tools.json, so
// they never reach an external LLM. `aiWrapped: true` routes dispatches
// through ai-wrapped-dispatch.mjs instead of the module's handleToolCall.
// Shared period grammar for recall/search_memories.
const PERIOD_DESCRIPTION = "last (recent sessions; +query topic-filter), Nm/Nh/Nd, today/yesterday/this_week/last_week, all, YYYY-MM-DD, date~date, or HH:MM~HH:MM.";
export const TOOL_DEFS = [
  {
    name: 'memory',
    title: 'Memory',
    annotations: { title: 'Memory', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Manage standing user preferences and constraints. Before add/edit/promote, obtain approval for the exact content and scope unless already explicitly requested. Load memory-management for curation policy; stored history uses recall.',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['add','edit','delete','list','candidates','promote','dismiss','exclude'],
          description: 'list defaults to active, injection-enabled standing memories only. Set include_inactive:true explicitly to inspect archived, disabled, and generated summaries. exclude disables a generated summary without deleting recall history. Other writes manage curated memory or candidates.',
        },
        id: { type: 'integer', minimum: 1, description: 'edit/delete: per-project memory index from list, paired with project_id and index_revision; exclude: generated_id; promote/dismiss: candidate id. Never interchange these namespaces.' },
        index_revision: { type: 'string', description: 'Required for edit/delete: exact scope version returned by list. Indices compact after deletion or movement; stale versions are rejected. Read the list again, never guess.' },
        source: { type: 'string', enum: ['all', 'curated', 'generated'], description: 'list filter; default all. Generated summaries use exclude, never edit/delete.' },
        include_inactive: { type: 'boolean', description: 'list only: default false returns injection-enabled memories only. Set true explicitly for the full management list, including archived and generated records.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'list page size; default 50.' },
        offset: { type: 'integer', minimum: 0, description: 'list continuation offset; default 0.' },
        summary: { type: 'string', description: 'Durable content; required for add and edit. The internal title is derived from its first 40 characters.' },
        project_id: { type: 'string', description: 'Pool: omit for the current Project, "common" for common memory, or a Project slug; "*" is list/candidates only.' },
      },
      additionalProperties: false,
      required: ['op'],
    },
  },
  {
    name: 'recall',
    title: 'Recall',
    annotations: { title: 'Recall', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Retrieve stored memory/session history (prior work, resumes, decisions). Query is semantic, not regex; period=time window; id=exact follow-up.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 5 }], description: 'Search text, or array for independent fan-out queries.' },
        id: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'array', items: { type: 'integer', minimum: 1 } }], description: 'Exact #id(s) from recall. Do not invent ids.' },
        period: { type: 'string', description: PERIOD_DESCRIPTION },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max entries; default 10, or 5 sessions for period=last.' },
        offset: { type: 'integer', minimum: 0, maximum: 500, description: 'Legacy static skip; default 0. For period=last paging, use the returned cursor instead.' },
        cursor: { type: 'string', description: 'Opaque period=last continuation cursor returned by the previous page.' },
        sort: { type: 'string', enum: ['importance', 'date'], description: 'importance or date.' },
        // Categories are listed once here instead of twice as enums; the
        // handler validates against VALID_CATEGORY.
        category: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Category filter, string or array: rule|constraint|decision|fact|goal|preference|task|issue.' },
        includeArchived: { type: 'boolean', description: 'Include archived entries; default true.' },
        includeMembers: { type: 'boolean', default: false, description: 'Include chunk members; default false.' },
        includeRaw: { type: 'boolean', default: false, description: 'Include raw/episode rows; default false.' },
        projectScope: { type: 'string', description: 'Pool: inferred from cwd, common, all, or slug.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_memories',
    title: 'Search Memories',
    public: false,
    annotations: { title: 'Search Memories', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Search past context/memory. Returns root entries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text.' },
        period: { type: 'string', description: PERIOD_DESCRIPTION },
        sort: { type: 'string', enum: ['date', 'importance'], description: 'date or importance.' },
        category: { anyOf: [{ type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] }, { type: 'array', items: { type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] } }], description: 'Category filter.' },
        limit: { type: 'number', default: 30, description: 'Max entries.' },
        offset: { type: 'number', default: 0, description: 'Legacy static skip.' },
        cursor: { type: 'string', description: 'Opaque period=last continuation cursor.' },
        includeMembers: { type: 'boolean', description: 'Include chunk members in output; does not widen the search pool.' },
        includeRaw: { type: 'boolean', description: 'Include unchunked raw/episode rows.' },
        sessionOnly: { type: 'boolean', description: 'Search this session only.' },
        includeArchived: { type: 'boolean', description: 'Include archived.' },
        sessionId: { type: 'string', description: 'Scoped session id.' },
        session_id: { type: 'string', description: 'Alias for sessionId.' },
        projectScope: { type: 'string', description: 'Project pool selector.' },
        cwd: { type: 'string', description: 'Infer projectScope.' },
      },
      required: [],
    },
  },
]
