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
    description: 'Core-memory mutation and status; use recall for retrieval. Store durable rules/preferences/facts, one compact ENGLISH clause each — never transient task state. add requires project_id+category+summary; edit works by id alone.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['core','status'], description: 'Operation.' },
        op: { type: 'string', enum: ['add','edit','delete','list','candidates','promote','dismiss'], description: 'Mutation op. candidates/promote/dismiss drive core-memory proposal approval.' },
        id: { type: 'number', description: 'Exact memory id.' },
        element: { type: 'string', maxLength: 40, description: 'Memory key/title. Defaults to the first 40 chars of summary. Max 40 chars.' },
        summary: { type: 'string', maxLength: 100, description: 'Memory content: one short English clause, max 100 chars.' },
        category: { type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'], description: 'Category.' },
        status: { type: 'string', enum: ['pending','active','archived'], description: 'Lifecycle status.' },
        limit: { type: 'number', description: 'Max rows/items.' },
        confirm: { type: 'string', description: 'Exact confirmation phrase for destructive actions.' },
        project_id: { type: 'string', description: 'Core pool: explicit common or slug. Required for core add only (edit uses the id\'s stored pool); there is no default pool.' },
      },
      additionalProperties: false,
      required: ['action'],
    },
  },
  {
    name: 'recall',
    title: 'Recall',
    annotations: { title: 'Recall', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Retrieve stored memory/session history for prior-work context (resumes, earlier decisions); not a reflexive pre-step. Query is topic/semantic, not regex; period selects the time window; id for exact follow-up.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Search text, or array for independent fan-out queries.' },
        id: { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' }, minItems: 1 }], description: 'Exact #id(s) from recall. Do not invent ids.' },
        period: { type: 'string', description: "last (recent sessions; +query topic-filter; limit=session count [default 5], offset=session paging), Nm/Nh/Nd (rolling), today/yesterday/this_week/last_week, all, YYYY-MM-DD, YYYY-MM-DD~YYYY-MM-DD, HH:MM~HH:MM (today), or 'YYYY-MM-DD HH:MM~HH:MM'." },
        limit: { type: 'number', description: 'Max entries.' },
        offset: { type: 'number', description: 'Skip entries.' },
        sort: { type: 'string', enum: ['importance', 'date'], description: 'importance or date.' },
        category: { anyOf: [{ type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] }, { type: 'array', items: { type: 'string', enum: ['rule','constraint','decision','fact','goal','preference','task','issue'] }, minItems: 1 }], description: 'Category filter.' },
        includeArchived: { type: 'boolean', description: 'Include archived entries.' },
        sessionId: { type: 'string', description: 'Scoped session id.' },
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
        period: { type: 'string', description: "last (recent sessions; +query topic-filter), Nm/Nh/Nd, today/yesterday/this_week/last_week, all, YYYY-MM-DD, date range, HH:MM~HH:MM (today), or 'YYYY-MM-DD HH:MM~HH:MM'." },
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
