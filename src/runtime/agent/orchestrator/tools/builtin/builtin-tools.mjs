// --- Tool definitions for external models ---
//
// Ordered to match the previous hand-maintained tools.json entries so
// build-tools-manifest reproduces the legacy ordering.
// CANONICAL SOURCE for all tool annotations (compressible, readOnlyHint,
// destructiveHint, etc.). tools.json is GENERATED from this array by
// dev/scripts/build-tools-manifest.mjs — do not edit annotations in tools.json
// directly. To verify sync: node dev/scripts/check-tools-sync.mjs
import {
    TOOL_ASYNC_EXECUTION_CONTRACT,
    TOOL_MANUAL_CONTROL_CONTRACT,
    executionModeSchemaDescription,
} from '../../../../shared/background-tasks.mjs';

export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Mixdog Read',
        annotations: { title: 'Mixdog Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
        description: 'Read known file path(s). Use line+context for small windows. Batch paths.',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    anyOf: [
                        { type: 'string' },
                        {
                            type: 'array',
                            items: { type: 'string' },
                            minItems: 1,
                        },
                    ],
                    description: 'File path or array. Dirs use list.',
                },
                line: { type: 'number', minimum: 1, description: 'Anchor line.' },
                context: { type: 'number', minimum: 0, maximum: 200, description: 'Lines around line; max 200.' },
            },
        },
    },
    {
        name: 'diagnostics',
        title: 'Mixdog Diagnostics',
        annotations: { title: 'Mixdog Diagnostics', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, compressible: true },
        description: 'Run matching type/lint checker. Default cwd; no LSP.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File/dir. Default cwd.' },
            },
            required: [],
        },
    },
    {
        name: 'open_config',
        title: 'Open Config UI',
        annotations: { title: 'Open Config UI', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'Open settings UI; returns URL. No params.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'shell',
        title: 'Mixdog Shell',
        annotations: { title: 'Mixdog Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: `Run shell for git/build/test/run. Not for source browsing; use code_graph/grep/read/list/glob. Set shell: powershell or bash. ${TOOL_ASYNC_EXECUTION_CONTRACT}`,
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Command.' },
                cwd: { type: 'string', description: 'Working directory.' },
                workdir: { type: 'string', description: 'Alias for cwd; omit if empty.' },
                timeout: { type: 'number', description: 'Timeout ms.' },
                merge_stderr: { type: 'boolean', description: 'Merge stderr.' },
                mode: { type: 'string', enum: ['sync', 'async'], description: executionModeSchemaDescription('sync') },
                run_in_background: { type: 'boolean', description: `Legacy alias for mode=async. ${TOOL_ASYNC_EXECUTION_CONTRACT}` },
                persistent: { type: 'boolean', description: 'Persistent shell mode.' },
                session_id: { type: 'string', description: 'Persistent shell id.' },
                create: { type: 'boolean', description: 'Create session_id if missing.' },
                close: { type: 'boolean', description: 'Close persistent session.' },
                shell: { type: 'string', enum: ['bash', 'powershell'], description: 'Force shell. Windows default is PowerShell; bash means Git Bash/POSIX.' },
            },
            required: ['command'],
        },
    },
    {
        name: 'task',
        title: 'Background Task Control',
        annotations: { title: 'Background Task Control', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description: `Manual control for shell async task_id. actions: list/status/read/wait/cancel. ${TOOL_MANUAL_CONTROL_CONTRACT} Not sess_* or agent ids.`,
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'shell async task_id.' },
                action: { type: 'string', enum: ['list', 'status', 'read', 'wait', 'cancel'], description: 'Manual action. Avoid polling loops.' },
                timeout_ms: { type: 'number', description: 'Wait timeout ms.' },
                poll_ms: { type: 'number', description: 'Wait poll ms.' },
            },
            required: [],
        },
    },
    {
        name: 'grep',
        title: 'Mixdog Grep',
        annotations: { title: 'Mixdog Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Search text/logs/regex.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Text/regex. Array = OR.',
                },
                path: { type: 'string', description: 'File or directory.' },
                glob: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Optional narrowing glob(s).',
                },
                output_mode: { type: 'string', enum: ['files_with_matches', 'content', 'count'], description: 'Output mode.' },
                head_limit: { type: 'number', description: 'Max lines.' },
                offset: { type: 'number', description: 'Skip lines.' },
            },
            required: [],
        },
    },
    {
        name: 'glob',
        title: 'Mixdog Glob',
        annotations: { title: 'Mixdog Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Find files by glob.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Glob pattern(s).',
                },
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Base directory/directories.',
                },
                head_limit: { type: 'number', description: 'Max entries.' },
                offset: { type: 'number', description: 'Skip entries.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'find',
        title: 'Mixdog Find Files',
        annotations: { title: 'Mixdog Find Files', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Fuzzy-find files by partial path/name. Returns paths.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Partial path/name words.' },
                path: { type: 'string', description: 'Base directory.' },
                head_limit: { type: 'number', description: 'Max paths.' },
            },
            required: ['query'],
        },
    },
    {
        name: 'list',
        title: 'Mixdog List Directory',
        annotations: { title: 'Mixdog List Directory', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'List known directory entries. Use glob for broad discovery.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory.' },
                head_limit: { type: 'number', description: 'Max entries.' },
                offset: { type: 'number', description: 'Skip N entries for paging.' },
            },
            required: [],
        },
    },
];
