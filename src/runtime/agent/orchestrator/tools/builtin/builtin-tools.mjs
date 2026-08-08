// --- Tool definitions for external models ---
//
// CANONICAL SOURCE for built-in tool schemas and annotations (compressible,
// readOnlyHint, destructiveHint, etc.). Descriptions carry the tool CONTRACT
// only (behavior + argument shapes); usage policy lives in rules/shared/01-tool.md.
import {
    TOOL_ASYNC_EXECUTION_CONTRACT,
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

// PowerShell-only syntax cheat, kept next to the command argument when the host
// default shell is PowerShell (win32). process.platform is fixed for the
// process lifetime, so this is evaluated once at module load.
const _shellSyntaxCheat =
    process.platform === 'win32'
        ? ' PowerShell: use ; between commands, /c/→C:\\, and note that $PID is reserved.'
        : '';

export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Mixdog Read',
        annotations: { title: 'Mixdog Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
        description: 'Known-file contents or line ranges; not directories.',
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
                                    {
                                        type: 'object',
                                        properties: {
                                            path: { type: 'string' },
                                            offset: { type: 'number', minimum: 0 },
                                            limit: { type: 'number', minimum: 1 },
                                        },
                                        required: ['path'],
                                    },
                                ],
                            },
                            minItems: 1,
                        },
                    ],
                    description: 'File path, or {path,offset,limit}[] regions. Pass real arrays, not JSON strings.',
                },
                offset: { type: 'number', minimum: 0, description: 'Lines to skip.' },
                limit: { type: 'number', minimum: 1, description: 'Max lines after offset. Defaults to 2000.' },
            },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'shell',
        title: 'Mixdog Shell',
        annotations: { title: 'Mixdog Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: `Run a shell command. ${TOOL_ASYNC_EXECUTION_CONTRACT}`,
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: `Command.${_shellSyntaxCheat}` },
                cwd: { type: 'string', description: 'Working directory; persists across calls. Omit to reuse; absolute path changes it.' },
                timeout: {
                    type: 'number',
                    description: `Timeout ms; default ${_shellDefaultTimeoutMs()}. `
                        + 'Sync timeout may return task_id; explicit timeout becomes its deadline. '
                        + 'Sleeps are killed, not promoted.',
                },
                merge_stderr: { type: 'boolean', description: 'Merge stderr.' },
                mode: { type: 'string', enum: ['sync', 'async'], description: executionModeSchemaDescription('sync') },
                shell: { type: 'string', enum: ['bash', 'powershell'], description: 'Force shell. Windows defaults to PowerShell; bash = Git Bash/POSIX.' },
            },
            required: ['command'],
            additionalProperties: false,
        },
    },
    {
        name: 'task',
        title: 'Background Task Control',
        annotations: { title: 'Background Task Control', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description: 'Control a shell background task_id; not session or agent ids.',
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'shell async task_id.' },
                action: { type: 'string', enum: ['list', 'status', 'read', 'wait', 'cancel'], description: 'Default list; with task_id, default wait.' },
                timeout_ms: { type: 'number', description: 'Wait timeout ms.' },
            },
            required: [],
            additionalProperties: false,
        },
    },
    {
        name: 'grep',
        title: 'Mixdog Grep',
        annotations: { title: 'Mixdog Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Source-content literal/regex search over file/dir scopes; returns path:line blocks with context.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Text/regex; pattern[] batches exact query literals and identifier variants in one call.',
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
                output_mode: { type: 'string', enum: ['content_with_context', 'files_with_matches', 'count'], description: 'content_with_context (default); files_with_matches/count for existence.' },
                head_limit: { type: 'number', minimum: 0, description: 'Max results. Defaults to 250; 0 = unlimited.' },
                offset: { type: 'number', minimum: 0, description: 'Skip results for paging.' },
                context: { type: 'number', minimum: 0, description: 'Minimum surrounding lines; runtime expands within its call budget. Omit for automatic context; 0 for matches only.' },
            },
            anyOf: [
                { required: ['pattern'] },
                { required: ['glob'] },
            ],
            additionalProperties: false,
        },
    },
    {
        name: 'glob',
        title: 'Mixdog Glob',
        annotations: { title: 'Mixdog Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Match glob patterns under base directories.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Glob pattern(s); pattern[] batches.',
                },
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Base directory(ies); path[] batches.',
                },
                head_limit: { type: 'number', description: 'Max entries. Defaults to 100; 0 = unlimited.' },
                offset: { type: 'number', description: 'Skip entries.' },
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
                path: { type: 'string', description: 'Base directory.' },
                head_limit: { type: 'number', description: 'Max paths across the call. Defaults to 25.' },
            },
            required: ['query'],
            additionalProperties: false,
        },
    },
    {
        name: 'list',
        title: 'Mixdog List Directory',
        annotations: { title: 'Mixdog List Directory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'List directory entries (path + type).',
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
                head_limit: { type: 'number', description: 'Max entries. Defaults to 200; 0 = no cap.' },
                offset: { type: 'number', description: 'Skip N entries for paging.' },
            },
            required: [],
            additionalProperties: false,
        },
    },
];
