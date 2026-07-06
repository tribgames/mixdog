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
    description: 'Core-memory mutation and status. Use recall for retrieval. Persist with action:"core" op:"add" when: user corrects/confirms your approach, states a durable preference, or says "remember". Only what code/git/docs cannot derive; include the why. Never transient task state. No prior recall dedup needed — the cycle dedups.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['core','status'], description: 'Operation.' },
        op: { type: 'string', enum: ['add','edit','delete','list','candidates','promote','dismiss'], description: 'Mutation op. candidates/promote/dismiss drive core-memory proposal approval.' },
        id: { type: 'number', description: 'Exact memory id.' },
        element: { type: 'string', description: 'Memory key/title.' },
        summary: { type: 'string', description: 'Memory content.' },
        category: { type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'], description: 'Category.' },
        status: { type: 'string', enum: ['pending','active','archived'], description: 'Lifecycle status.' },
        limit: { type: 'number', description: 'Max rows/items.' },
        confirm: { type: 'string', description: 'Exact confirmation phrase for destructive actions.' },
        project_id: { type: 'string', description: 'Core pool: common, slug, or *. Required for core add/edit; there is no default pool.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'recall',
    title: 'Recall',
    annotations: { title: 'Recall', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Retrieve stored memory/session history. Use only to check prior conversation or past events: resumes, prior work, earlier decisions or messages. Do not call as a reflexive pre-step, to verify a just-made decision, or before storing memory. Query is topic/semantic search, not regex. Patterns: period:"last" for previous conversation; sessionId without query for current session; period:"3h"/"30m"/"24h" for recent; YYYY-MM-DD, date ranges, or HH:MM~HH:MM for time windows; id for exact follow-up.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Search text, or array for independent fan-out queries.' },
        id: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' }, minItems: 1 }], description: 'Exact #id(s) from recall. Do not invent ids.' },
        period: { type: 'string', description: "last (all history newest-first), Nm/Nh/Nd (rolling), today/yesterday/this_week/last_week, all, YYYY-MM-DD, YYYY-MM-DD~YYYY-MM-DD, HH:MM~HH:MM (today), or 'YYYY-MM-DD HH:MM~HH:MM'." },
        limit: { type: 'number', description: 'Max entries.' },
        offset: { type: 'number', description: 'Skip entries.' },
        sort: { type: 'string', enum: ['importance', 'date'], description: 'importance or date.' },
        category: { anyOf: [{ type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] }, { type: 'array', items: { type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] }, minItems: 1 }], description: 'Category filter.' },
        includeArchived: { type: 'boolean', description: 'Include archived entries.' },
        sessionId: { type: 'string', description: 'Scoped session id.' },
        session_id: { type: 'string', description: 'Alias for sessionId.' },
        includeMembers: { type: 'boolean', description: 'Include chunk members in output; does not widen the search pool.' },
        includeRaw: { type: 'boolean', description: 'Include unchunked raw/episode rows.' },
        sessionOnly: { type: 'boolean', description: 'Search this session only.' },
        projectScope: { type: 'string', description: 'Project pool selector: inferred from cwd, common, all, or slug.' },
        cwd: { type: 'string', description: 'Infer projectScope.' },
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
        period: { type: 'string', description: "last, Nm/Nh/Nd, today/yesterday/this_week/last_week, all, YYYY-MM-DD, date range, HH:MM~HH:MM (today), or 'YYYY-MM-DD HH:MM~HH:MM'." },
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
