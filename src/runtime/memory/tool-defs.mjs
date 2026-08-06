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
    title: 'Memory Cycle',
    annotations: { title: 'Memory Cycle', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: [
      'Core-memory mutation/status; recall retrieves.',
      'Mutations use action=core with op; status uses action=status.',
      'Store only durable compact ENGLISH facts/rules/preferences.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['core','status'],
          description: 'core for mutations; status otherwise. Mutation verbs belong in op.',
        },
        op: {
          type: 'string',
          enum: ['add','edit','delete','list','candidates','promote','dismiss'],
          description: 'Required for action=core.',
        },
        id: { type: 'number', description: 'Exact memory id.' },
        element: { type: 'string', description: 'Memory key/title. Defaults to the first 40 chars of summary.' },
        summary: { type: 'string', description: 'Durable memory content; the memory worker compacts it after storage.' },
        status: { type: 'string', enum: ['pending','active','archived'], description: 'Lifecycle status.' },
        limit: { type: 'number', description: 'Max rows/items.' },
        confirm: { type: 'string', description: 'Exact confirmation phrase for destructive actions.' },
        project_id: { type: 'string', description: 'Core pool: common or slug; inferred from cwd/session when omitted.' },
      },
      // `op` is required for action=core — stated in its own description and
      // enforced by the handler; the anyOf branches only restated that.
      additionalProperties: false,
      required: ['action'],
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
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Search text, or array for independent fan-out queries.' },
        id: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' }, minItems: 1 }], description: 'Exact #id(s) from recall. Do not invent ids.' },
        period: { type: 'string', description: PERIOD_DESCRIPTION },
        limit: { type: 'number', description: 'Max entries.' },
        offset: { type: 'number', description: 'Skip entries.' },
        sort: { type: 'string', enum: ['importance', 'date'], description: 'importance or date.' },
        // Categories are listed once here instead of twice as enums; the
        // handler validates against VALID_CATEGORY.
        category: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Category filter, string or array: rule|constraint|decision|fact|goal|preference|task|issue.' },
        includeArchived: { type: 'boolean', description: 'Include archived entries.' },
        includeMembers: { type: 'boolean', description: 'Include chunk members.' },
        includeRaw: { type: 'boolean', description: 'Include raw/episode rows.' },
        sessionOnly: { type: 'boolean', description: 'Search this session only.' },
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
        category: { anyOf: [{ type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] }, { type: 'array', items: { type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] }, minItems: 1 }], description: 'Category filter.' },
        limit: { type: 'number', default: 30, description: 'Max entries.' },
        offset: { type: 'number', default: 0, description: 'Skip entries.' },
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
