import { TOOL_SYNC_EXECUTION_CONTRACT } from '../shared/tool-execution-contract.mjs';

export const TIDY_ACTIONS = Object.freeze(['scan', 'check', 'fix', 'install', 'rules', 'results']);

export const TOOL_DEFS = [
  {
    name: 'tidy',
    title: 'Tidy',
    description:
      "Clean up code across the languages in this project: detect the languages, resolve each one's formatter/linter engine, run them together with the structural rule packs, and write fixes through the normal edit pipeline. " +
      'fix reports what would change and writes only with apply:true; missing managed engines download automatically unless tidy.downloads is ask, in which case the user approves them. ' +
      'results pages the last check/fix without re-running engines. Engine and rule work belongs here, not in shell. ' +
      TOOL_SYNC_EXECUTION_CONTRACT,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: TIDY_ACTIONS,
          description:
            'scan: languages, resolved/missing engines and download policy; check: run engines and rules read-only; fix: the change plan (dry run unless apply); install: download missing managed engines; rules: list structural rule packs; results: page last check/fix diagnostics (offset/limit, no re-run).',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'User-selected files or directories; required for scan/check/fix. Ask when the scope is missing; use "." only for an explicitly requested whole project. Includes tracked and non-ignored untracked files; never derives scope from a diff or commit.',
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
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Skip this many diagnostics/matches; default 0. results pages the last check/fix.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Page size for diagnostics/matches (max 100, default 20). results does not re-run engines.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];
