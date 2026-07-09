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

// PowerShell-only syntax cheat, injected into the shell tool description when
// the host default shell is PowerShell (win32). process.platform is fixed for
// the process lifetime, so this is evaluated once at module load.
const _shellSyntaxCheat =
    process.platform === 'win32'
        ? ' PowerShell: grep→Select-String, tail→Get-Content -Tail, head→Get-Content -TotalCount, /c/→C:\\, && 미지원 시 ; 사용, $PID 예약.'
        : '';

export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Mixdog Read',
        annotations: { title: 'Mixdog Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
        description: 'Read verified file path(s). Unknown path → find first. Batch paths/regions as real arrays in one call. Not for directory listing.',
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
                    description: 'Verified file path. Batch spans via path[] or {path,offset,limit}[] regions. Pass arrays directly; JSON strings are legacy recovery only.',
                },
                offset: { type: 'number', minimum: 0, description: 'Numeric lines to skip before reading; 0 starts at line 1. Continue with offset:N.' },
                limit: { type: 'number', minimum: 1, description: 'Numeric max lines to return after offset.' },
            },
        },
    },
    {
        name: 'shell',
        title: 'Mixdog Shell',
        annotations: { title: 'Mixdog Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: `Run programs or change system state. Set shell: powershell or bash. Not for reading, listing, or searching files. Batch independent commands: ;/&& in one call, or parallel calls in the same turn.${_shellSyntaxCheat} ${TOOL_ASYNC_EXECUTION_CONTRACT}`,
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Command.' },
                cwd: { type: 'string', description: 'Working directory. Persists across shell calls in a session — omit to reuse the previous command\'s directory (e.g. after cd); pass an absolute path to change it.' },
                timeout: { type: 'number', description: `Timeout ms. Default ${_shellDefaultTimeoutMs()} (${_shellDefaultTimeoutMs() / 60000} min) when omitted; an explicit value is honored uncapped — long-running commands may set it higher. On timeout the command is MOVED TO BACKGROUND (a task_id you can wait/status/read/cancel) and keeps running instead of being killed; sleep-like commands and MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS opt out (killed with a [timeout] marker). async/background runs with timeout omitted have NO timeout (run until done/cancelled); an explicit timeout is still enforced.` },
                merge_stderr: { type: 'boolean', description: 'Merge stderr.' },
                mode: { type: 'string', enum: ['sync', 'async'], description: executionModeSchemaDescription('sync') },
                shell: { type: 'string', enum: ['bash', 'powershell'], description: 'Force shell. Windows defaults to PowerShell; bash = Git Bash/POSIX.' },
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
        description: 'Exact text/regex in a verified file/dir scope. Unknown scope → find/glob first. files_with_matches/count for broad anchors, content_with_context for narrow answers.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Text/regex. Array = variants in one call.',
                },
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Verified file or dir. Array = several scopes.',
                },
                glob: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Glob filter to narrow scope.',
                },
                output_mode: { type: 'string', enum: ['content_with_context', 'content', 'files_with_matches', 'count'], description: 'Broad: files_with_matches/count; narrow: content_with_context.' },
                head_limit: { type: 'number', minimum: 0, description: 'Max results.' },
                offset: { type: 'number', minimum: 0, description: 'Skip results for paging.' },
                '-A': { type: 'number', minimum: 0, description: 'Lines after each match.' },
                '-B': { type: 'number', minimum: 0, description: 'Lines before each match.' },
                '-C': { type: 'number', minimum: 0, description: 'Lines before/after each match.' },
            },
            required: [],
        },
    },
    {
        name: 'glob',
        title: 'Mixdog Glob',
        annotations: { title: 'Mixdog Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Find files by exact glob from verified roots. Batch patterns and roots as arrays in one call.',
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
        description: 'Find files by partial path/name, including dot-directories. Use for unverified path/name guesses; returns verified paths. Batch query[].',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Partial path/name words (not file contents), or query[] to batch lookups in one call.',
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
        description: 'List verified directories. Unknown dir → find first. Batch dirs as path[].',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Verified directory, or path[] to list several directories in one call.',
                },
                head_limit: { type: 'number', description: 'Max entries.' },
                offset: { type: 'number', description: 'Skip N entries for paging.' },
            },
            required: [],
        },
    },
];
