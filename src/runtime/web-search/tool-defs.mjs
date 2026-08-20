import {
  TOOL_SYNC_EXECUTION_CONTRACT,
} from '../shared/tool-execution-contract.mjs';

const TOOL_DEFS_PLACEHOLDER = Symbol('web-fetch-schema')

export const TOOL_DEFS = [
  {
    name: 'web_search',
    title: 'Mixdog Web Search',
    description: `Cached web/docs/current-info search. ${TOOL_SYNC_EXECUTION_CONTRACT}`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Required query or array for lossless fan-out.' },
        site: { type: 'string', description: 'Site/domain filter.' },
        type: { type: 'string', enum: ['web', 'news', 'images'], description: 'Default web.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 20, description: 'Result count; default 10; 1-20.' },
        locale: { type: 'string', description: 'Optional locale hint, e.g. ko-KR or a city/region name.' },
        contextSize: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default low.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { title: 'Mixdog Web Search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'web_fetch',
    title: 'Mixdog Web Fetch',
    description: 'Fetch page/docs body from URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 10 }], description: 'Public HTTP(S) URL or array of up to 10 URLs.' },
        startIndex: { type: 'integer', minimum: 0, description: 'Character offset; default 0.' },
        maxLength: { type: 'integer', minimum: 0, description: 'Maximum characters; default 50000; 0 unlimited.' },
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
