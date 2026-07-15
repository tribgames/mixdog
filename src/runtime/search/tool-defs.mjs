import {
  TOOL_SYNC_EXECUTION_CONTRACT,
} from '../shared/tool-execution-contract.mjs';

const TOOL_DEFS_PLACEHOLDER = Symbol('web-fetch-schema')

export const TOOL_DEFS = [
  {
    name: 'search',
    title: 'Mixdog Web Search',
    description: `Web/docs/current-info search. Not repo-local; use explore/code_graph/grep. ${TOOL_SYNC_EXECUTION_CONTRACT} Cached; query supports array fan-out.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Query or array for fan-out.' },
        site: { type: 'string', description: 'Site/domain filter.' },
        type: { type: 'string', enum: ['web', 'news', 'images'], description: 'Default web.' },
        maxResults: { type: 'number', minimum: 1, maximum: 20, description: 'Result count, 1-20.' },
        locale: {
          description: 'Optional locale hint.',
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                country: { type: 'string', description: 'Country.' },
                language: { type: 'string', description: 'Language.' },
                region: { type: 'string', description: 'Region.' },
                city: { type: 'string', description: 'City.' },
                timezone: { type: 'string', description: 'Timezone.' },
              },
              additionalProperties: false,
            },
          ],
        },
        contextSize: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default low.' },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { title: 'Mixdog Web Search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'web_fetch',
    title: 'Mixdog Web Fetch',
    description: 'Use after search. Fetch page/docs body from URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'URL or array of URLs.' },
        startIndex: { type: 'number', minimum: 0, description: 'Character offset.' },
        maxLength: { type: 'number', minimum: 0, description: 'Maximum characters to return.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { title: 'Mixdog Web Fetch', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'local_fetch',
    title: 'Mixdog Loopback Fetch',
    public: false,
    description: 'Runtime-only loopback HTTP(S) fetch target.',
    inputSchema: TOOL_DEFS_PLACEHOLDER,
    annotations: { title: 'Mixdog Loopback Fetch', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'image_fetch',
    title: 'Mixdog Image Fetch',
    public: false,
    description: 'Runtime-only bounded public image fetch target.',
    inputSchema: TOOL_DEFS_PLACEHOLDER,
    annotations: { title: 'Mixdog Image Fetch', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
]

const webFetchSchema = TOOL_DEFS.find((tool) => tool.name === 'web_fetch').inputSchema
for (const tool of TOOL_DEFS) {
  if (tool.inputSchema === TOOL_DEFS_PLACEHOLDER) tool.inputSchema = webFetchSchema
}
