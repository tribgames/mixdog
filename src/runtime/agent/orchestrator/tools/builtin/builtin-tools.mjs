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
        description: 'Read known file path(s). Prefer grep content_with_context or code_graph anchors first. Window with numeric offset+limit only. Batch paths/regions as real arrays; adjacent spans in one file = one window, not repeated calls. Dirs use list.',
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
                                    },
                                ],
                            },
                            minItems: 1,
                        },
                    ],
                    description: 'File path, path[], or {path,offset,limit}[] region objects. Pass arrays directly; JSON strings are legacy recovery only.',
                },
                offset: { type: 'number', minimum: 0, description: 'Numeric lines to skip before reading; 0 starts at line 1. Continue with offset:N.' },
                limit: { type: 'number', minimum: 1, description: 'Numeric max lines to return after offset.' },
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
        // agentHidden: a worker/reviewer session has no business popping the
        // settings UI on the user's machine; it also wastes schema bytes on
        // every agent request. Lead keeps it.
        annotations: { title: 'Open Config UI', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, agentHidden: true },
        description: 'Open settings UI; returns URL. No params.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'shell',
        title: 'Mixdog Shell',
        annotations: { title: 'Mixdog Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: `Run shell to CHANGE state or RUN programs (git/build/test/run). Never to inspect the filesystem — reading, listing, searching, or checking existence go through the dedicated tools, never a shell command. Set shell: powershell or bash. ${TOOL_ASYNC_EXECUTION_CONTRACT}`,
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
        description: 'Search file contents by text/regex in a known scope. Use files_with_matches/count for broad anchors, content_with_context for narrow code answers. One concept → one grep; multiple scopes = ONE call with path[].',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Text/regex. Put synonyms in pattern[] as OR in ONE grep; no serial rewording or equivalent repeats.',
                },
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Known narrowest file/dir, or path[] to search several scopes in one call; broad scopes return paths first, then refine from returned paths.',
                },
                glob: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Narrow in same grep; no follow-up grep for equivalent scope changes.',
                },
                output_mode: { type: 'string', enum: ['content_with_context', 'content', 'files_with_matches', 'count'], description: 'Broad scope: files_with_matches/count. Narrow scope: content_with_context; answer from it, skip read unless span is not shown.' },
                context: { type: 'number', minimum: 0, description: 'Lines before/after each match; keep bounded.' },
                head_limit: { type: 'number', minimum: 0, description: 'Max output lines; keep small.' },
                offset: { type: 'number', minimum: 0, description: 'Skip output lines for paging.' },
            },
            required: [],
        },
    },
    {
        name: 'glob',
        title: 'Mixdog Glob',
        annotations: { title: 'Mixdog Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Find files by exact glob. Unknown path/name uses find. Multiple patterns/dirs = ONE call with pattern[]/path[], never parallel single-pattern calls.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Exact glob pattern(s). Batch related patterns as pattern[] in one call.',
                },
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Base directory/directories. Batch multiple roots as path[] in one call.',
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
        description: 'Find files by partial path/name. Exact structure uses glob. Returns verified paths. Multiple names = ONE call with query[].',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Partial path/name words (not file contents), or query[] to batch several lookups in one call.',
                },
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
        description: 'List known directory entries. Use glob for broad discovery. Multiple dirs = ONE call with path[].',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Directory, or path[] to list several directories in one call.',
                },
                head_limit: { type: 'number', description: 'Max entries.' },
                offset: { type: 'number', description: 'Skip N entries for paging.' },
            },
            required: [],
        },
    },
];
