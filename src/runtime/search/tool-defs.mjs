import {
  TOOL_SYNC_EXECUTION_CONTRACT,
} from '../shared/tool-execution-contract.mjs';

export const TOOL_DEFS = [
  {
    name: 'search',
    title: 'Mixdog Web Search',
    description: `First-choice tool for web, documentation, external, or current-information questions. Uses the configured Mixdog search provider/model. Use search when the answer depends on internet sources, vendor docs, releases, issues, APIs, or facts outside the repo. Do not use for repo-local code location; use explore/code_graph/grep instead. ${TOOL_SYNC_EXECUTION_CONTRACT} Keeps Mixdog search caching, fan-out, and result formatting.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'Search query, or array for fan-out. Keep each query focused.' },
        site: { type: 'string', description: 'Optional site/domain filter.' },
        type: { type: 'string', enum: ['web', 'news', 'images'], description: 'Search type. Default web.' },
        maxResults: { type: 'number', minimum: 1, maximum: 20, description: 'Maximum results to return, 1-20.' },
        locale: {
          description: 'Optional locale hint as a string or structured location/language object.',
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                country: { type: 'string', description: 'Country code or name for result localization.' },
                language: { type: 'string', description: 'Preferred result language.' },
                region: { type: 'string', description: 'Region/state hint.' },
                city: { type: 'string', description: 'City hint.' },
                timezone: { type: 'string', description: 'IANA timezone hint.' },
              },
              additionalProperties: false,
            },
          ],
        },
        contextSize: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Search context size hint. Default low.' },
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
        url: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }], description: 'URL, or array of URLs, to fetch.' },
        startIndex: { type: 'number', minimum: 0, description: 'Character offset for paging large pages.' },
        maxLength: { type: 'number', minimum: 0, description: 'Maximum characters to return.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { title: 'Mixdog Web Fetch', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
]
