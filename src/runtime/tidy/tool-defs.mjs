import { TOOL_SYNC_EXECUTION_CONTRACT } from '../shared/tool-execution-contract.mjs';

export const TIDY_ACTIONS = Object.freeze(['scan', 'check', 'fix', 'install', 'rules']);

export const TOOL_DEFS = [
  {
    name: 'tidy',
    title: 'Tidy',
    description:
      "Clean up code across the languages in this project: detect the languages, resolve each one's formatter/linter engine, run them together with the structural rule packs, and write fixes through the normal edit pipeline. " +
      'fix reports what would change and writes only with apply:true; missing managed engines download automatically unless tidy.downloads is ask, in which case the user approves them. ' +
      'Engine and rule work belongs here, not in shell. ' +
      TOOL_SYNC_EXECUTION_CONTRACT,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: TIDY_ACTIONS,
          description:
            'scan: languages, resolved/missing engines and download policy; check: run engines and rules read-only; fix: the change plan (dry run unless apply); install: download missing managed engines; rules: list structural rule packs.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Project-relative files or directories to limit the run to; omitted = every tracked file.',
        },
        languages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Language ids from scan; omitted = every detected language.',
        },
        engines: {
          type: 'array',
          items: { type: 'string' },
          description: 'Engine ids from scan; install requires them, the other actions filter by them.',
        },
        apply: {
          type: 'boolean',
          description: 'fix: write the changes (default false = report what would change).',
        },
        approveDownloads: {
          type: 'boolean',
          description:
            'When tidy.downloads is ask, the user approved the engines a previous needsApproval result listed; ignored under the default auto policy.',
        },
        structural: {
          type: 'boolean',
          description: 'Run the structural rule packs (default true for check and fix).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];
