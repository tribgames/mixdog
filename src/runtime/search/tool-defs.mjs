import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

const crawlArgsSchema = z.object({
  url: z.string().url().describe('Starting URL to begin crawling from.'),
  maxPages: z.number().int().min(1).max(200).optional().describe('Maximum number of pages to visit (1-200).'),
  maxDepth: z.number().int().min(0).max(5).optional().describe('Maximum link depth to follow (0-5).'),
  sameDomainOnly: z.boolean().optional().describe('If true, only follow links on the same domain.'),
})

function buildInputSchema(zodSchema) {
  const jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' })
  delete jsonSchema.$schema
  return jsonSchema
}

export const TOOL_DEFS = [
  {
    name: 'search',
    title: 'Mixdog Web Search',
    description: 'Web search (SERP) for external/current info. Requires query (string|array). Snippets+URLs; web_fetch for bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
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
      required: ['query'],
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
  {
    name: 'crawl',
    title: 'Crawl',
    public: false,
    description: 'Crawl a website starting from a URL, following links up to a configured depth. Collects page summaries from each visited page.',
    inputSchema: buildInputSchema(crawlArgsSchema),
    annotations: { title: 'Crawl', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'setup',
    public: false,
    description: 'Open interactive setup form to configure search providers, API keys, and options.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Setup' },
  },
]
