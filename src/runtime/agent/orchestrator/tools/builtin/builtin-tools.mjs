// --- Tool definitions for external models ---
//
// CANONICAL SOURCE for built-in tool schemas and annotations (compressible,
// readOnlyHint, destructiveHint, etc.). Descriptions carry the tool CONTRACT
// only (behavior + argument shapes); usage policy lives in rules/shared/01-tool.md.
import {
    executionModeSchemaDescription,
} from '../../../../shared/background-tasks.mjs';

// Shell timeout envelope surfaced in the tool schema. Reference-CLI parity:
// default 120 s when omitted; an explicit timeout is honored uncapped.
// BASH_DEFAULT_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS env overrides only bound the
// omitted default (max floored at default). Keep in sync with
// builtin/bash-tool.mjs.
function _shellDefaultTimeoutMs() {
    const parsed = parseInt(process.env.BASH_DEFAULT_TIMEOUT_MS ?? '', 10);
    return parsed > 0 ? parsed : 120_000;
}
function _shellMaxTimeoutMs() {
    const parsed = parseInt(process.env.BASH_MAX_TIMEOUT_MS ?? '', 10);
    return Math.max(parsed > 0 ? parsed : 600_000, _shellDefaultTimeoutMs());
}

// Platform-specific command syntax belongs next to the command argument.
const _shellSyntaxCheat =
    process.platform === 'win32'
        ? ' PowerShell: use ; between independent commands; use if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } between dependent commands; single-quote inline scripts, avoid nested double quotes; /c/→C:\\; $PID is reserved.'
        : ' Bash: use && between dependent commands.';

export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Mixdog Read',
        annotations: { title: 'Mixdog Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
        description: 'Known-file contents or line ranges absent from prior output; never pair with same-span search. Images render for viewing; not directories. Replaces cat/head/tail.',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    anyOf: [
                        { type: 'string' },
                        {
                            type: 'array',
                            items: {
                                anyOf: [
                                    { type: 'string' },
                                    { type: 'number' },
                                    {
                                        type: 'array',
                                        items: {
                                            anyOf: [
                                                { type: 'string' },
                                                { type: 'number' },
                                            ],
                                        },
                                        minItems: 2,
                                        maxItems: 3,
                                        description: '[path,offset,limit?].',
                                    },
                                ],
                            },
                            minItems: 1,
                        },
                    ],
                    description: 'File path, string[] files, [path,offset,limit?] range, or range[].',
                },
                offset: { type: 'number', minimum: 0, description: 'Lines to skip.' },
                limit: { type: 'number', minimum: 1, description: 'Max lines; default 800.' },
            },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'shell',
        title: 'Mixdog Shell',
        annotations: { title: 'Mixdog Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: 'Run executable/runtime/state operations or generate computed artifacts. Never explore files with shell (NOT ls/find/cat/head/tail/grep/rg/sed); use file tools.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: `Command.${_shellSyntaxCheat}` },
                cwd: { type: 'string', description: 'Omit to use the current Project root; use a project-relative subdir or explicit external path for this call only.' },
                timeout: {
                    type: 'number',
                    description: `Total deadline ms. Omit for sync default ${_shellDefaultTimeoutMs()}; omit for unlimited async. Explicit values kill at deadline; sync may return task_id.`,
                },
                mode: { type: 'string', enum: ['sync', 'async'], description: executionModeSchemaDescription('sync') },
                shell: { type: 'string', enum: ['bash', 'powershell'], description: 'Force shell.' },
            },
            required: ['command'],
            additionalProperties: false,
        },
    },
    {
        name: 'task',
        title: 'Background Task Control',
        annotations: { title: 'Background Task Control', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description: 'Schedule one progress check or manually inspect/cancel a shell background task_id; normal completion arrives by notification. Not for session or agent ids.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'Shell task_id.' },
                action: { type: 'string', enum: ['list', 'status', 'read', 'check_after', 'cancel'], description: 'Default list; task_id alone defaults to non-blocking status. check_after schedules one non-blocking progress notification.' },
                after_ms: { type: 'number', description: 'Required explicitly for check_after; one-shot delay before the progress snapshot, not the task deadline.' },
            },
            required: [],
            additionalProperties: false,
        },
    },
    {
        name: 'grep',
        title: 'Mixdog Grep',
        annotations: { title: 'Mixdog Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'File-content literal/regex search for unknown source locations; contextual path:line blocks are directly usable—read only omitted lines. Replaces grep/rg.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Text/regex; pattern[] batches exact query literals and identifier variants.',
                },
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'File/dir scope(s).',
                },
                glob: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Glob filter.',
                },
                mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'content default; files/count for existence.' },
                limit: { type: 'number', minimum: 0, description: 'Max results; default 250; 0 unlimited.' },
                offset: { type: 'number', minimum: 0, description: 'Result offset.' },
                context: { type: 'number', minimum: 0, description: 'Omit for automatic context; 0 for matches only.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'glob',
        title: 'Mixdog Glob',
        annotations: { title: 'Mixdog Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Known-base wildcard paths; returns paths only. Replaces find -name.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Glob(s); pattern[] batches.',
                },
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Base dir(s); path[] batches.',
                },
                limit: { type: 'number', description: 'Max entries; default 100; 0 unlimited.' },
                offset: { type: 'number', minimum: 0, description: 'Entry offset.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
    },
    {
        name: 'find',
        title: 'Mixdog Find Files',
        annotations: { title: 'Mixdog Find Files', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Fuzzy filename/directory path-string lookup; returns paths only. No source-content, symbol, value, or line search.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Filename or directory path fragments matched against path strings; query[] batches.',
                },
                path: { type: 'string', description: 'Base path.' },
                limit: { type: 'number', description: 'Max paths; default 25; 0 unlimited.' },
                include_noise: { type: 'boolean', description: 'Also search gitignored/dependency trees.' },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'list',
        title: 'Mixdog List Directory',
        annotations: { title: 'Mixdog List Directory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Known-directory immediate entries (path + type); no wildcard. Replaces ls; meta:true adds size/mtime/mode.',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Directory; path[] batches.',
                },
                hidden: { type: 'boolean', description: 'Include dotfiles.' },
                meta: { type: 'boolean', description: 'Per-entry size bytes, UTC mtime, octal mode.' },
                limit: { type: 'number', description: 'Max entries; default 200; 0 unlimited.' },
                offset: { type: 'number', description: 'Entry offset.' },
            },
            required: [],
            additionalProperties: false,
        },
    },
];
