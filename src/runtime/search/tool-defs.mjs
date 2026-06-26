import {
  TOOL_ASYNC_EXECUTION_CONTRACT,
  TOOL_SYNC_EXECUTION_CONTRACT,
  executionModeSchemaDescription,
} from '../shared/background-tasks.mjs';

export const TOOL_DEFS = [
  {
    name: 'search',
    title: 'Mixdog Web Search',
    description: `Web search through the Web Researcher agent. Prefer mode=async for broad/current web research or multi-query searches; use sync only when the next step must block on this result. ${TOOL_SYNC_EXECUTION_CONTRACT} ${TOOL_ASYNC_EXECUTION_CONTRACT} Keeps Mixdog search caching, fan-out, and result formatting.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
        mode: { type: 'string', enum: ['async', 'sync'], description: `${executionModeSchemaDescription('sync')} Prefer async for non-trivial web research; choose sync only for an explicit blocking lookup.` },
        action: { type: 'string', enum: ['run', 'list', 'status', 'read', 'cancel'], description: 'Default run. list/status/read/cancel are manual recovery controls for async search tasks.' },
        task_id: { type: 'string', description: 'Shared background task id for status/read/cancel.' },
        firstResponseTimeoutMs: { type: 'number', minimum: 0, description: 'Abort only when the Web Researcher produces no first stream/tool activity within this many ms. Default 120s. 0 disables this watchdog.' },
        idleTimeoutMs: { type: 'number', minimum: 0, description: 'Stale watchdog after first Web Researcher stream/tool activity. Default 30m. 0 disables stale abort.' },
        site: { type: 'string' },
        type: { type: 'string', enum: ['web', 'news', 'images'] },
        maxResults: { type: 'number', minimum: 1, maximum: 20 },
        locale: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                country: { type: 'string' },
                language: { type: 'string' },
                region: { type: 'string' },
                city: { type: 'string' },
                timezone: { type: 'string' },
              },
              additionalProperties: false,
            },
          ],
        },
        contextSize: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { title: 'Mixdog Web Search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'web_fetch',
    title: 'Mixdog Web Fetch',
    description: 'Fetch full page body from a URL (web page, article, docs). Requires url. Use after search to read a result.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
        startIndex: { type: 'number', minimum: 0 },
        maxLength: { type: 'number', minimum: 0 },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { title: 'Mixdog Web Fetch', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
]
