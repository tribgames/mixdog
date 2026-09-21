import { TOOL_SYNC_EXECUTION_CONTRACT } from '../shared/tool-execution-contract.mjs';

export const TIDY_ACTIONS = Object.freeze(['scan', 'check', 'fix', 'install', 'rules', 'results']);

export const TOOL_DEFS = [
  {
    name: 'tidy',
    title: 'Tidy',
    description:
      'Clean up code across the languages in this project; engine/rule work belongs here, not shell. fix writes only with apply:true. Managed engines auto-download unless tidy.downloads is ask (user approves). ' +
      'results pages the last check/fix without re-running; rules/paths filter before paging. It omits languages/languageSource/engines/missing/policy. ' +
      'Compact rows: loc,rule,severity,message,fix. byRule (count,highest severity,fixable count) and byDir (first two directories) survive trimming. ' +
      'ok:true/status:partial means structural passes failed; structural.errors names languages. All structural writes stay blocked. ' +
      TOOL_SYNC_EXECUTION_CONTRACT,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: TIDY_ACTIONS,
          description:
            'scan: languages, resolved/missing engines and download policy; check: run engines and rules read-only; fix: the change plan (dry run unless apply); install: download missing managed engines; rules: list structural rule packs; results: filter cached diagnostics by rules/paths, then page each engine and structural list (offset/limit, no header or re-run). Filtered summaries/counts of rows reflect the selection; counts/filesChecked retain run totals.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'User-selected files or directories; required for scan/check/fix. Ask when the scope is missing; use "." only for an explicitly requested whole project. Includes tracked and non-ignored untracked files; never derives scope from a diff or commit. results: optional cached path-prefix filters (directory boundaries, no scope requirement).',
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
        rules: {
          type: 'array',
          items: { type: 'string' },
          description:
            'results only: exact rule ids from byRule; matches structural ruleId and engine code/ruleId. OR within rules/paths; AND between the two filters.',
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
          description:
            'Skip this many diagnostics/matches per list; default 0. results applies rules/paths filters first.',
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
