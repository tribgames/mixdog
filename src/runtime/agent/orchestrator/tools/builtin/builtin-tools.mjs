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
        ? ' PowerShell: grep→Select-String, tail→Get-Content -Tail, head→Get-Content -TotalCount, /c/→C:\\, if && is unsupported use ;, $PID is reserved.'
        : '';

export const BUILTIN_TOOLS = [
    {
        name: 'read',
        title: 'Mixdog Read',
        annotations: { title: 'Mixdog Read', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: false },
        description: 'Read verified file path(s); guessed path/name → find first. Array-first: batch paths/regions as real arrays in one call; put targets in path[] or {path,offset,limit}[] and read the whole logical unit. Content_with_context is actionable; do not page or re-read returned spans. Not for directory listing.',
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
                    description: 'Verified file path; use {path,offset,limit}[] targets. Pass arrays directly; JSON strings are legacy recovery only.',
                },
                offset: { type: 'number', minimum: 0, description: 'Numeric lines to skip; 0 starts at line 1. Continue with offset:N.' },
                limit: { type: 'number', minimum: 1, description: 'Numeric max lines after offset.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'shell',
        title: 'Mixdog Shell',
        annotations: { title: 'Mixdog Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: `Run programs or change system state; set shell: powershell or bash. Not for reading, listing or searching. Shell/write calls are serial; use ;/&& only for intentional in-command sequencing.${_shellSyntaxCheat} ${TOOL_ASYNC_EXECUTION_CONTRACT}`,
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Command.' },
                cwd: { type: 'string', description: 'Working directory; persists across calls. Omit to reuse; absolute path changes it.' },
                timeout: { type: 'number', description: `Timeout ms. Default ${_shellDefaultTimeoutMs()} (${_shellDefaultTimeoutMs() / 60000} min) when omitted. On sync timeout the command is MOVED TO BACKGROUND (a task_id you can wait/status/read/cancel) and keeps running instead of being killed; an explicit timeout blocks for at most BASH_MAX_TIMEOUT_MS (default 10 min), and only its remainder beyond that cap is still enforced as a background deadline. Sleep-like commands and MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS opt out (killed with a [timeout] marker after blocking for the full explicit timeout). async/background runs with timeout omitted have NO timeout (run until done/cancelled); an explicit timeout is still enforced.` },
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
        description: `Control a shell async task_id: actions list/status/read/wait/cancel. ${TOOL_MANUAL_CONTROL_CONTRACT} Not sess_* or agent ids.`,
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string', description: 'shell async task_id.' },
                action: { type: 'string', enum: ['list', 'status', 'read', 'wait', 'cancel'], description: 'Action; avoid polling loops.' },
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
        description: 'Quoted/non-identifier literal or regex→grep. Search in verified scope (project root counts as verified); guessed path fragment → find first. Omitted output_mode and content_with_context are contextual; a nonzero content_with_context result resolves that search concept—act directly, without regex tweaks, narrowing or re-search. Choose files_with_matches/count for existence; Only zero/error results may change tokens or scope. No path "." + guessed src/**.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Text/regex. Array = variants in one call; pattern[] batches tokens. path[] batches verified scopes only; file/span reads use read path[] regions.',
                },
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Verified file/dir or project root; guessed → find first.',
                },
                glob: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Glob filter; no guessed src/** under path ".".',
                },
                output_mode: { type: 'string', enum: ['content_with_context', 'files_with_matches', 'count'], description: 'Omitted/contextual content; content_with_context; files_with_matches/count are existence modes. Legacy content is runtime-compatible, not public.' },
                head_limit: { type: 'number', minimum: 0, description: 'Max results.' },
                offset: { type: 'number', minimum: 0, description: 'Skip results for paging.' },
                '-A': { type: 'number', minimum: 0, description: 'Lines after each match.' },
                '-B': { type: 'number', minimum: 0, description: 'Lines before each match.' },
                '-C': { type: 'number', minimum: 0, description: 'Lines before/after each match.' },
            },
            anyOf: [
                { required: ['pattern'] },
                { required: ['glob'] },
            ],
        },
    },
    {
        name: 'glob',
        title: 'Mixdog Glob',
        annotations: { title: 'Mixdog Glob', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Exact glob from verified roots (project root is verified); guessed root/name → find first. Array-first: batch related pattern[]/path[]. No path "." + guessed src/**.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Exact glob pattern(s); batch related pattern[].',
                },
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Verified base dir(s)/project root; guessed → find first; batch path[].',
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
        description: 'Partial path/name lookup only for unknown partial paths/names (including dot dirs); verify roots before grep/glob. Not for the project root or already-verified roots. Output paths are verified downstream. Array-first: batch query[].',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Partial path/name words, not contents; query[] batches lookups.',
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
        description: 'List verified directories (project root included); Guessed dir → find first. Array-first: batch independent dirs as path[].',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Verified directory; path[] batches directories.',
                },
                head_limit: { type: 'number', description: 'Max entries.' },
                offset: { type: 'number', description: 'Skip N entries for paging.' },
            },
            required: [],
        },
    },
];
