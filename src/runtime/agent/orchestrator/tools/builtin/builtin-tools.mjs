// --- Tool definitions for external models ---
//
// CANONICAL SOURCE for built-in tool schemas and annotations (compressible,
// readOnlyHint, destructiveHint, etc.). Descriptions carry the tool CONTRACT
// only (behavior + argument shapes); usage policy lives in rules/shared/01-tool.md.
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
        description: 'Read file contents; guessed path/name → find first. Batch paths/regions as real arrays: path[] or {path,offset,limit}[] regions in one call. Not for directories.',
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
                limit: { type: 'number', minimum: 1, description: 'Max lines after offset.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'shell',
        title: 'Mixdog Shell',
        annotations: { title: 'Mixdog Shell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true, compressible: true },
        description: `Run programs or change system state; not for reading, listing or searching. Shell/write calls are serial.${_shellSyntaxCheat} ${TOOL_ASYNC_EXECUTION_CONTRACT}`,
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Command.' },
                cwd: { type: 'string', description: 'Working directory; persists across calls. Omit to reuse; absolute path changes it.' },
                timeout: { type: 'number', description: `Timeout ms; default ${_shellDefaultTimeoutMs()}. On sync timeout the command moves to background as a task_id and keeps running; an explicit timeout then blocks at most BASH_MAX_TIMEOUT_MS, the remainder enforced as a background deadline. Sleep-like commands and MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS opt out of promotion: they block for the full explicit timeout, then are killed with a [timeout] marker. async with timeout omitted runs until done/cancelled; an explicit timeout is still enforced.` },
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
            },
            required: [],
        },
    },
    {
        name: 'grep',
        title: 'Mixdog Grep',
        annotations: { title: 'Mixdog Grep', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, compressible: true },
        description: 'Quoted/non-identifier literal or regex→grep, over verified scopes (project root counts as verified); guessed path fragment → find first. A nonzero content_with_context result resolves that search concept; only zero/error results may change tokens or scope. files_with_matches/count are existence modes. No path "." + guessed src/**.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Text/regex; pattern[] batches variants in one call. path[] batches verified scopes only; file/span reads use read path[] regions.',
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
                head_limit: { type: 'number', minimum: 0, description: 'Max results.' },
                offset: { type: 'number', minimum: 0, description: 'Skip results for paging.' },
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
        description: 'Match exact glob patterns from verified base directories (project root is verified); guessed root/name → find first. Batch pattern[]/path[].',
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
        description: 'Fuzzy lookup only for unknown partial paths/names (dot dirs included); not for the project root or already-verified roots. Output paths are verified downstream. Not for file contents.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    anyOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' }, minItems: 1 },
                    ],
                    description: 'Partial path/name words; query[] batches.',
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
        description: 'List directory entries; batch independent dirs as path[].',
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
                head_limit: { type: 'number', description: 'Max entries.' },
                offset: { type: 'number', description: 'Skip N entries for paging.' },
            },
            required: [],
        },
    },
];
