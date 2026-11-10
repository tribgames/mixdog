// Model-facing text is kept minimal: every constraint dropped from these schemas
// (minLength, pattern, minItems, maxItems, format) is enforced by the zod
// schemas in index.mjs, which trim blanks and reject empty or non-URL input.
// `trigger` shows only in the deferred listing, so `description` carries the
// when-to-use guidance itself.
const TOOL_DEFS_PLACEHOLDER = Symbol('web-fetch-schema');

export const TOOL_DEFS = [
  {
    name: 'web_search',
    title: 'Mixdog Web Search',
    trigger: 'Unfamiliar names, products, models, recent or external facts; search before answering from memory.',
    description:
      'Search the web for recent, external or unfamiliar facts (names, products, models) before answering from memory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'One query, or an array run as a batch.',
        },
        site: { type: 'string', description: 'Domain filter.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 10.' },
        locale: { type: 'string', description: 'e.g. ko-KR.' },
        contextSize: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default low.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Mixdog Web Search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'web_fetch',
    title: 'Mixdog Web Fetch',
    trigger: 'Page or docs body from a known URL; not discovery (web_search).',
    description: 'Fetch the page or docs body of known URLs; to find pages, use web_search.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'URL, or an array of up to 10; loopback and public URLs in separate calls.',
        },
        startIndex: { type: 'integer', minimum: 0, description: 'Character offset.' },
        maxLength: { type: 'integer', minimum: 0, description: 'Default 20000; 0 unlimited.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Mixdog Web Fetch',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'local_fetch',
    title: 'Mixdog Loopback Fetch',
    public: false,
    description: 'Runtime-only loopback HTTP(S) fetch target.',
    inputSchema: TOOL_DEFS_PLACEHOLDER,
    annotations: {
      title: 'Mixdog Loopback Fetch',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'image_fetch',
    title: 'Mixdog Image Fetch',
    public: false,
    description: 'Runtime-only bounded public image fetch target.',
    inputSchema: TOOL_DEFS_PLACEHOLDER,
    annotations: {
      title: 'Mixdog Image Fetch',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

const webFetchSchema = TOOL_DEFS.find((tool) => tool.name === 'web_fetch').inputSchema;
for (const tool of TOOL_DEFS) {
  if (tool.inputSchema === TOOL_DEFS_PLACEHOLDER) tool.inputSchema = webFetchSchema;
}
