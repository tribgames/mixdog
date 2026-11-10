import { TOOL_SYNC_EXECUTION_CONTRACT } from '../shared/tool-execution-contract.mjs';

export const EXPLORE_MAX_QUERIES = 8;

export const TOOL_DEFS = [
  {
    name: 'explore',
    title: 'Explore',
    annotations: {
      title: 'Explore',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      'Read-only code search in parallel explorers outside your context; returns one merged answer with path:line evidence. ' +
      'Use when locating needs 3+ searches, spans 2+ files or areas, or covers independent questions; a known file or one lookup: read/grep. ' +
      TOOL_SYNC_EXECUTION_CONTRACT,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          anyOf: [
            { type: 'string', minLength: 1 },
            { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: EXPLORE_MAX_QUERIES },
          ],
          description: 'One self-contained question, or an array of independent ones (one explorer each).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];
